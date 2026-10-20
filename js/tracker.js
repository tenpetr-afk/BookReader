/**
 * tracker.js - Inteligentní měřič aktivity a rychlosti čtení (WPM).
 * Zjišťuje reálný aktivní čas (pauza při nečinnosti), počítá slova,
 * odhaduje zbývající čas a ukládá detailní čtecí relace s časovou osou WPM.
 */

import { storage } from "./storage.js";

export const MIN_VALID_WPM = 80;
export const MAX_VALID_WPM = 650;
export const DEFAULT_NORMAL_WPM = 220;

/**
 * Vrátí datum ve formátu YYYY-MM-DD v lokálním časovém pásmu
 */
export function getLocalDateKey(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const IDLE_TIMEOUT_MS = 45000; // 45 sekund bez interakce = uživatel nečte
const TIMELINE_SAMPLE_INTERVAL_SEC = 12; // Vzorkovat rychlost každých 12 sekund aktivního čtení

export class ReadingTracker {
  constructor() {
    this.currentBookId = null;
    this.currentBookTitle = "";
    this.currentChapterIndex = 0;
    this.currentChapterWords = 0;
    
    // Stav aktivity čtečky
    this.isActive = false;
    this.isIdle = false;
    this.activeTimeMs = 0;
    this.lastActivityTime = Date.now();
    this.lastTickTime = Date.now();
    this.timerInterval = null;

    // Metriky aktuální čtecí relace
    this.currentSessionId = null;
    this.sessionStartTimestamp = null;
    this.sessionStartTime = null;
    this.sessionWordsRead = 0;
    this.chapterAccumulatedWords = 0;
    this.chapterInitialScrollPercent = 0;
    this.currentScrollPercent = 0;

    // Vážené měření reálného čtení (v pásmu 80-650 WPM)
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;

    // Sledování čtení na úrovni bloků (Strict Single-Point Word Accreditation)
    this.creditedBlocks = new Set(); // Množina klíčů bloků již akreditovaných pro danou knihu
    this.currentReadingBlockId = null; // e.g. `${bookId}_ch${chapterIndex}_p${pageIndex}`
    this.blockEnterTimestamp = null; // Čas příchodu na aktuální blok
    this.blockVisibleWords = 0; // Viditelná slova na aktuálním bloku (pouze viewport)
    
    // Zpětná kompatibilita pro stávající reference
    this.committedPageKeys = this.creditedBlocks;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    
    // Časová osa vzorků rychlosti v rámci relace: [{ timestamp, elapsedSeconds, instantaneousWpm }]
    this.timelineSamples = [];
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;

    // Klouzavé okno nedávného postupu pro výpočet okamžitého WPM: [{ time, words, activeMs }]
    this.progressHistory = [];

    // Posluchači změn pro UI
    this.listeners = new Set();

    this.initActivityListeners();
  }

  initActivityListeners() {
    const onUserAction = () => {
      this.recordActivity();
    };

    window.addEventListener("scroll", onUserAction, { passive: true });
    window.addEventListener("mousemove", onUserAction, { passive: true });
    window.addEventListener("pointermove", onUserAction, { passive: true });
    window.addEventListener("pointerdown", onUserAction, { passive: true });
    window.addEventListener("keydown", onUserAction, { passive: true });
    window.addEventListener("touchstart", onUserAction, { passive: true });
    window.addEventListener("touchmove", onUserAction, { passive: true });
    window.addEventListener("click", onUserAction, { passive: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.pause();
      } else {
        if (this.currentBookId) {
          this.resume();
        }
      }
    });

    // Uložit relaci před zavřením okna nebo přechodem
    window.addEventListener("beforeunload", () => {
      this.flushSession();
    });
  }

  /**
   * Zaznamená aktivní interakci uživatele (listování, posun, pravítko, stisk klávesy)
   */
  recordActivity() {
    this.lastActivityTime = Date.now();

    if (this.isIdle) {
      this.isIdle = false;
      this.notifyListeners({ type: "idleChange", isIdle: false });
      // Pokud byla předchozí relace ukončena kvůli nečinnosti, začíná nová souvislá relace
      if (this.currentBookId && !this.currentSessionId) {
        this.startNewContiguousSession(this.currentChapterIndex, this.currentChapterWords, this.currentScrollPercent);
      }
    } else if (!this.currentSessionId && this.currentBookId && this.isActive) {
      this.startNewContiguousSession(this.currentChapterIndex, this.currentChapterWords, this.currentScrollPercent);
    }
  }

  /**
   * Zruší měření aktuální stránky bez započtení dwell time a slov
   * (při TOC skoku, posuvníku, vyhledávání, změně velikosti písma, okrajů).
   */
  cancelCurrentPageDwell() {
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentReadingBlockId = null;
    this.currentPageKey = null;
    this.blockVisibleWords = 0;
    this.currentPageVisibleWords = 0;
  }

  /**
   * Zhodnotí a případně započte čtení na aktuálním otevřeném bloku podle času setrvání (dwell time).
   * Validace:
   * - Minimální fyziologický čas na stránce: minSeconds = (wordsOnPage / 650) * 60, alespoň 3.0s.
   * - Pokud uživatel otočí stránku rychleji než za minSeconds (skimming/flipping),
   *   NEZAPOČÍTÁVÁME slova do totalWords a NEUKLÁDÁME tento přechod jako vzorek WPM.
   * - Opuštěná záložka (dwell >= 600s) se nezapočítává.
   * - Pokud rawWpm spadne mimo realistické pásmo [80, 650] WPM (outlier):
   *   do historie WPM ani časové osy se NEZAPISUJE (žádné ořezávání na stropy/dna).
   */
  commitCurrentBlockDwell() {
    const blockId = this.currentReadingBlockId;
    const enterTime = this.blockEnterTimestamp;

    // Reset timestampu, aby tentýž pobyt nebyl vyhodnocen vícekrát
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;

    if (!blockId || !enterTime) return;

    const dwellSeconds = (Date.now() - enterTime) / 1000;
    const wordsOnPage = Math.max(0, Math.min(650, Math.round(this.blockVisibleWords || 0)));

    if (wordsOnPage <= 0) return;

    // 1. Zahození opuštěné záložky (>= 600s dwell time)
    if (dwellSeconds >= 600) {
      return;
    }

    // 2. Přísná validace minimálního fyziologického času stráveného na stránce:
    // Max 650 WPM -> minSeconds = (wordsOnPage / 650) * 60, minimálně alespoň 3.0 sekundy
    const minSeconds = Math.max(3.0, (wordsOnPage / MAX_VALID_WPM) * 60);

    // Pokud uživatel otočil stránku rychleji než za minSeconds, jde o navigaci (skimming/flipping):
    // NEZAPOČÍTÁVÁME slova do totalWords a NEUKLÁDÁME tento přechod jako vzorek WPM!
    if (dwellSeconds < minSeconds) {
      return;
    }

    // 3. Výpočet rychlosti čtení na stránce
    const dwellMinutes = dwellSeconds / 60;
    const rawWpm = Math.round(wordsOnPage / dwellMinutes);

    // Pokud je rychlost nad fyziologickým stropem 650 WPM (skimming) -> zahodit
    if (rawWpm > MAX_VALID_WPM) {
      return;
    }

    // 4. Započtení slov: blok je akreditován POUZE JEDNOU za celou knihu
    if (!this.creditedBlocks.has(blockId)) {
      this.creditedBlocks.add(blockId);
      this.sessionWordsRead += wordsOnPage;
    }

    // 5. Filtrace vzorku WPM:
    // Pokud vypočtené rawWpm spadne mimo realistické pásmo [80, 650] WPM (např. < 80 WPM je pauza/zamyšlení),
    // považujeme vzorek za outlier a do historie WPM ani časové osy ho NEZAPISUJEME.
    // NIKDY neukládáme uměle oříznuté (clamped) extrémy!
    if (rawWpm >= MIN_VALID_WPM && rawWpm <= MAX_VALID_WPM) {
      this.validReadingTimeMs += (dwellSeconds * 1000);
      this.validWordsRead += wordsOnPage;
      const elapsedSec = Math.floor(this.activeTimeMs / 1000);
      this.recordTimelineSample(elapsedSec, rawWpm);
    }
  }

  // Alias pro zpětnou kompatibilitu
  commitCurrentPageDwell() {
    this.commitCurrentBlockDwell();
  }

  /**
   * Zaznamená přechod na novou stránku / sloupec.
   * Vyhodnotí dwell time na předchozí stránce a zahájí sledování nové stránky.
   * Nikdy nepřičítá slova při reflow (resize, font, okraje), navigaci ani při počátečním načtení dokumentu.
   * @param {Object} pageInfo { bookId, bookTitle, chapterIndex, pageIndex, visibleWords, isReflow, isInitialLoad, isNavigationJump }
   */
  onPageChange(pageInfo) {
    if (!pageInfo || !pageInfo.bookId) return;

    const bookId = pageInfo.bookId;
    const title = pageInfo.bookTitle || this.currentBookTitle || "Kniha";
    const chapterIndex = pageInfo.chapterIndex ?? 0;
    const pageIndex = pageInfo.pageIndex ?? 0;
    let visibleWords = 0;
    if (pageInfo.visibleWords !== undefined && pageInfo.visibleWords !== null) {
      visibleWords = Math.max(0, Math.min(650, Math.round(pageInfo.visibleWords)));
    } else {
      visibleWords = 250;
    }
    const isReflow = !!pageInfo.isReflow;
    const isInitialLoad = !!pageInfo.isInitialLoad;
    const isNavigationJump = !!pageInfo.isNavigationJump;

    // Pokud uživatel změnil knihu, nejprve uložíme běžící relaci a vyresetujeme akreditované bloky
    if (this.currentBookId !== bookId) {
      this.flushSession();
      this.currentBookId = bookId;
      this.currentBookTitle = title;
      this.creditedBlocks = new Set();
      this.committedPageKeys = this.creditedBlocks;
      this.startNewContiguousSession(chapterIndex, visibleWords, 0);
    }

    const newBlockId = `${bookId}_ch${chapterIndex}_p${pageIndex}`;

    // Pokud jde o reflow (resize okna, font, okraje, sloupce, donačtení obrázku) nebo skok navigace:
    // Nikdy nepřičítáme slova a resetujeme sledovač nové stránky
    if (isReflow || isNavigationJump) {
      this.cancelCurrentPageDwell();
      this.currentReadingBlockId = newBlockId;
      this.currentPageKey = newBlockId;
      const now = Date.now();
      this.blockEnterTimestamp = now;
      this.pageEnterTimestamp = now;
      this.blockVisibleWords = visibleWords;
      this.currentPageVisibleWords = visibleWords;
      this.currentChapterIndex = chapterIndex;
      return;
    }

    // Pokud jde o prvotní načtení knihy / kapitoly (document load):
    // Pouze nastavíme čtecí blok, ale nezapočítáváme žádná slova
    if (isInitialLoad) {
      this.cancelCurrentPageDwell();
      this.currentReadingBlockId = newBlockId;
      this.currentPageKey = newBlockId;
      const now = Date.now();
      this.blockEnterTimestamp = now;
      this.pageEnterTimestamp = now;
      this.blockVisibleWords = visibleWords;
      this.currentPageVisibleWords = visibleWords;
      this.currentChapterIndex = chapterIndex;
      return;
    }

    // Pokud jde o tutéž stránku (např. opakované hlášení bez posunu):
    if (newBlockId === this.currentReadingBlockId) {
      this.blockVisibleWords = visibleWords;
      this.currentPageVisibleWords = visibleWords;
      return;
    }

    // Uživatel skutečně opouští předchozí stránku -> vyhodnotit dwell time
    if (this.currentReadingBlockId) {
      this.commitCurrentBlockDwell();
    }

    // Vstup na nový čtecí blok
    this.currentReadingBlockId = newBlockId;
    this.currentPageKey = newBlockId;
    const now = Date.now();
    this.blockEnterTimestamp = now;
    this.pageEnterTimestamp = now;
    this.blockVisibleWords = visibleWords;
    this.currentPageVisibleWords = visibleWords;
    this.currentChapterIndex = chapterIndex;
    this.recordActivity();

    this.notifyListeners({
      type: "pageChange",
      pageIndex,
      chapterIndex,
      wordsRead: this.sessionWordsRead,
      wpm: this.getCurrentWpm()
    });
  }

  /**
   * Spustí nebo aktualizuje čtecí relaci pro zadanou knihu a kapitolu
   */
  startSession(bookId, bookTitle, chapterIndex = 0, chapterWords = 1, scrollPercent = 0) {
    let resolvedTitle = bookTitle;
    let resolvedIndex = chapterIndex;
    let resolvedWords = chapterWords;
    let resolvedScroll = scrollPercent;

    if (typeof bookTitle === "number") {
      resolvedWords = bookTitle;
      resolvedTitle = "Dokument";
    }

    const isNewBook = this.currentBookId !== bookId;

    if (isNewBook) {
      // Pokud běžela relace pro jinou knihu, nejprve ji uložíme
      if (this.currentBookId) {
        this.flushSession();
      }

      this.currentBookId = bookId;
      this.currentBookTitle = resolvedTitle || "Kniha";
      this.startNewContiguousSession(resolvedIndex, resolvedWords, resolvedScroll);
    } else {
      // Stejná kniha (např. přechod mezi kapitolami v rámci jedné souvislé relace)
      if (this.currentSessionId && !this.isIdle) {
        this.currentChapterIndex = resolvedIndex;
        this.currentChapterWords = resolvedWords || 1;
        this.currentScrollPercent = resolvedScroll;
        this.recordActivity();
      } else {
        // Relace ještě nebyla zahájena nebo skončila nečinností
        this.startNewContiguousSession(resolvedIndex, resolvedWords, resolvedScroll);
      }
    }
  }

  /**
   * Vytvoří a zahájí novou souvislou čtecí relaci
   */
  startNewContiguousSession(chapterIndex = 0, chapterWords = 1, scrollPercent = 0) {
    const now = Date.now();
    this.currentSessionId = `session_${now}_${Math.random().toString(36).substring(2, 9)}`;
    this.sessionStartTimestamp = now;
    this.sessionStartTime = new Date(now).toISOString();
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.chapterAccumulatedWords = 0;
    this.currentChapterIndex = chapterIndex;
    this.currentChapterWords = chapterWords || 1;
    this.chapterInitialScrollPercent = scrollPercent;
    this.currentScrollPercent = scrollPercent;
    this.isIdle = false;
    this.isActive = true;
    this.lastActivityTime = now;
    this.lastTickTime = now;

    // Reset vážených měřičů čtení
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;

    // Sledování stránek a dwell time (nečistíme creditedBlocks - ty platí pro celou knihu)
    this.currentReadingBlockId = null;
    this.blockEnterTimestamp = null;
    this.blockVisibleWords = 0;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;

    // Inicializace časové osy rychlosti
    this.timelineSamples = [];
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;
    this.progressHistory = [{ time: now, words: 0, activeMs: 0 }];

    // Výchozí počáteční vzorek relace (pouze pokud je v platném pásmu)
    const initialWpm = this.getCurrentWpm();
    if (initialWpm >= MIN_VALID_WPM && initialWpm <= MAX_VALID_WPM) {
      this.timelineSamples.push({
        timestamp: now,
        elapsedSeconds: 0,
        instantaneousWpm: initialWpm
      });
    }

    this.startTicker();
  }

  startTicker() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTickTime;
      this.lastTickTime = now;

      if (!this.isActive) return;

      // Zkontrolujeme, zda neuplynul idle timeout (>45s)
      if (now - this.lastActivityTime > IDLE_TIMEOUT_MS) {
        if (!this.isIdle) {
          this.isIdle = true;
          this.notifyListeners({ type: "idleChange", isIdle: true });
          // Souvislá relace skončila po nečinnosti uživatele, uložíme ji
          this.flushSession();
        }
        return; // Nepřičítáme čas, pokud uživatel odešel
      }

      if (this.isActive && !this.isIdle) {
        this.activeTimeMs += delta;
        const deltaSec = delta / 1000;
        const elapsedSec = Math.floor(this.activeTimeMs / 1000);

        // Synchronizace s denní statistikou v sekundách přesně ve stejný okamžik a ze stejného zdroje!
        const todayKey = getLocalDateKey();
        storage.addDailyReadingSeconds(todayKey, deltaSec);

        // Periodický odběr vzorku rychlosti pro intra-session timeline (pouze pokud je tempo validní)
        if (elapsedSec - this.lastSampleActiveSec >= TIMELINE_SAMPLE_INTERVAL_SEC) {
          this.recordTimelineSample(elapsedSec);
        }

        this.notifyListeners({
          type: "tick",
          activeSeconds: elapsedSec,
          wpm: this.getCurrentWpm(),
          wordsRead: this.sessionWordsRead
        });
      }
    }, 1000);
  }

  pause() {
    this.isActive = false;
    this.notifyListeners({ type: "stateChange", isActive: false });
  }

  resume() {
    if (!this.currentBookId) return;
    this.isActive = true;
    this.lastTickTime = Date.now();
    this.lastActivityTime = Date.now();
    this.isIdle = false;
    this.notifyListeners({ type: "stateChange", isActive: true });
  }

  /**
   * Zaznamená bod na časové ose rychlosti čtení (Intra-session WPM timeline).
   * Nikdy neukládá oříznuté (clamped) extrémy. Outliery mimo pásmo [80, 650] WPM zahazuje.
   * @param {number} elapsedSec Uplynulý aktivní čas v sekundách
   * @param {number|null} forceWpm Přímá rychlost WPM
   */
  recordTimelineSample(elapsedSec, forceWpm = null) {
    const elapsed = elapsedSec !== undefined ? elapsedSec : Math.floor(this.activeTimeMs / 1000);
    const now = Date.now();

    let instantaneousWpm = null;

    if (typeof forceWpm === "number" && !isNaN(forceWpm) && forceWpm > 0) {
      if (forceWpm >= MIN_VALID_WPM && forceWpm <= MAX_VALID_WPM) {
        instantaneousWpm = Math.round(forceWpm);
      } else {
        return; // Zahození outlieru mimo [80, 650] WPM
      }
    } else {
      // Vyčistíme starší události v historii postupu (starší než 45 sekund)
      this.progressHistory = this.progressHistory.filter(p => now - p.time <= 45000);
      this.progressHistory.push({
        time: now,
        words: this.sessionWordsRead,
        activeMs: this.activeTimeMs
      });

      if (this.progressHistory.length >= 2) {
        const oldest = this.progressHistory[0];
        const deltaWords = this.sessionWordsRead - oldest.words;
        const deltaActiveMin = (this.activeTimeMs - oldest.activeMs) / 1000 / 60;

        if (deltaActiveMin >= 0.15 && deltaWords > 0) {
          const rawWpm = Math.round(deltaWords / deltaActiveMin);
          if (rawWpm >= MIN_VALID_WPM && rawWpm <= MAX_VALID_WPM) {
            const currentAvg = this.getCurrentWpm();
            instantaneousWpm = Math.round(rawWpm * 0.7 + currentAvg * 0.3);
          }
        }
      }
    }

    if (instantaneousWpm === null || instantaneousWpm < MIN_VALID_WPM || instantaneousWpm > MAX_VALID_WPM) {
      return; // Neukládáme neplatný vzorek ani extrémy
    }

    const sample = {
      timestamp: now,
      elapsedSeconds: elapsed,
      instantaneousWpm
    };

    // Pokud už existuje vzorek ve stejnou sekundu, přepíšeme ho
    if (this.timelineSamples.length > 0 && this.timelineSamples[this.timelineSamples.length - 1].elapsedSeconds === elapsed) {
      this.timelineSamples[this.timelineSamples.length - 1] = sample;
    } else {
      this.timelineSamples.push(sample);
    }

    this.lastSampleActiveSec = elapsed;
    this.lastSampleWordsRead = this.sessionWordsRead;
  }

  /**
   * Aktualizuje pozici skrolování.
   * Nikdy nepřičítá ani nenastavuje slova – slova se akreditují striktně přes dwell time.
   * @param {number} scrollPercent 0.0 až 1.0
   */
  updateScrollProgress(scrollPercent) {
    this.recordActivity();
    const clamped = Math.max(0, Math.min(1, scrollPercent));
    this.currentScrollPercent = clamped;

    this.notifyListeners({
      type: "progress",
      scrollPercent: clamped,
      wordsRead: this.sessionWordsRead,
      wpm: this.getCurrentWpm()
    });
  }

  /**
   * Spočítá průměrnou rychlost čtení (Words Per Minute) aktuální relace:
   * Vážený průměr z validních čtecích úseků v realistickém pásmu [80, 650] WPM.
   */
  getCurrentWpm() {
    // 1. Priorita: vážený průměr ze skutečně odměřených validních úseků
    if (this.validReadingTimeMs >= 8000 && this.validWordsRead >= 20) {
      const validMin = this.validReadingTimeMs / 60000;
      const pace = Math.round(this.validWordsRead / validMin);
      if (pace >= MIN_VALID_WPM && pace <= MAX_VALID_WPM) {
        return pace;
      }
    }

    // 2. Sekundární výpočet: z validních vzorků časové osy
    const validSamples = this.timelineSamples
      .map(s => Number(s.instantaneousWpm))
      .filter(w => w >= MIN_VALID_WPM && w <= MAX_VALID_WPM);

    if (validSamples.length > 0) {
      const sum = validSamples.reduce((a, b) => a + b, 0);
      return Math.round(sum / validSamples.length);
    }

    // 3. Celková akreditovaná slova / celkový aktivní čas (pokud spadne do [80, 650])
    const activeMinutes = this.activeTimeMs / 60000;
    if (activeMinutes >= 0.2 && this.sessionWordsRead >= 25) {
      const rawWpm = Math.round(this.sessionWordsRead / activeMinutes);
      if (rawWpm >= MIN_VALID_WPM && rawWpm <= MAX_VALID_WPM) {
        return rawWpm;
      }
    }

    return DEFAULT_NORMAL_WPM; // Výchozí realistická rychlost (220 WPM)
  }

  /**
   * Odhadne zbývající čas v minutách
   * @param {number} remainingWords 
   * @returns {number} minuty
   */
  getEstimatedMinutesRemaining(remainingWords) {
    const wpm = this.getCurrentWpm() || DEFAULT_NORMAL_WPM;
    return Math.max(1, Math.ceil(remainingWords / wpm));
  }

  /**
   * Poskytne snímek právě probíhající živé relace pro okamžité zobrazení v UI modálu statistik
   */
  getCurrentSessionSnapshot() {
    const activeSeconds = Math.floor(this.activeTimeMs / 1000);
    if (!this.currentBookId || activeSeconds < 3) return null;

    const currentWpm = this.getCurrentWpm();
    const samples = [...this.timelineSamples];
    if (samples.length === 0 || activeSeconds - this.lastSampleActiveSec >= 4) {
      if (currentWpm >= MIN_VALID_WPM && currentWpm <= MAX_VALID_WPM) {
        samples.push({
          timestamp: Date.now(),
          elapsedSeconds: activeSeconds,
          instantaneousWpm: currentWpm
        });
      }
    }

    return {
      sessionId: this.currentSessionId || "session_current",
      bookId: this.currentBookId,
      bookTitle: this.currentBookTitle || "Aktuální kniha",
      chapterIndex: this.currentChapterIndex,
      startTime: this.sessionStartTime || new Date(Date.now() - activeSeconds * 1000).toISOString(),
      endTime: null,
      durationSeconds: activeSeconds,
      activeSeconds: activeSeconds,
      wordsRead: this.sessionWordsRead,
      avgWpm: currentWpm,
      wpm: currentWpm,
      timelineSamples: samples,
      isLive: true,
      date: getLocalDateKey(this.sessionStartTimestamp || Date.now())
    };
  }

  /**
   * Uloží aktuální souvislou relaci do IndexedDB (reading_sessions) a aktualizuje knihu
   */
  async flushSession() {
    // Před uložením zhodnotíme dwell time na aktuálně otevřeném bloku
    this.commitCurrentBlockDwell();

    const activeSeconds = Math.floor(this.activeTimeMs / 1000);
    const bookId = this.currentBookId;
    const bookTitle = this.currentBookTitle;
    const wordsRead = this.sessionWordsRead;

    // Ukládáme pouze relace delší než 4 sekundy s reálným čtením
    if (bookId && activeSeconds >= 4) {
      const avgWpm = wordsRead > 0 ? this.getCurrentWpm() : 0;
      const now = Date.now();
      const endTime = new Date(now).toISOString();
      const dateKey = getLocalDateKey(this.sessionStartTimestamp || now);

      // Závěrečný vzorek na konci relace (pouze v platném pásmu)
      if (wordsRead > 0 && avgWpm >= MIN_VALID_WPM && avgWpm <= MAX_VALID_WPM) {
        if (this.timelineSamples.length === 0 || activeSeconds - this.lastSampleActiveSec >= 3) {
          this.timelineSamples.push({
            timestamp: now,
            elapsedSeconds: activeSeconds,
            instantaneousWpm: avgWpm
          });
        }
      }

      const sessionRecord = {
        sessionId: this.currentSessionId || `session_${now}_${Math.random().toString(36).substring(2, 9)}`,
        bookId: bookId,
        bookTitle: bookTitle,
        chapterIndex: this.currentChapterIndex,
        startTime: this.sessionStartTime || new Date(now - activeSeconds * 1000).toISOString(),
        endTime: endTime,
        durationSeconds: activeSeconds,
        activeSeconds: activeSeconds,
        wordsRead: wordsRead,
        avgWpm: avgWpm,
        wpm: avgWpm,
        timelineSamples: [...this.timelineSamples],
        date: dateKey,
        timestamp: now
      };

      try {
        await storage.saveReadingSession(sessionRecord);

        // Aktualizujeme data v knize bez zbytečné kumulace
        const book = await storage.getBook(bookId);
        if (book) {
          let totalWordsRead = (book.wordsRead || 0) + wordsRead;
          if (book.totalWords > 0) {
            totalWordsRead = Math.min(book.totalWords, totalWordsRead);
          }

          await storage.updateBookProgress(bookId, {
            currentChapterIndex: this.currentChapterIndex,
            scrollPercent: this.currentScrollPercent,
            wordsRead: totalWordsRead,
            lastWpm: avgWpm
          });
        }
      } catch (err) {
        console.warn("Chyba při ukládání čtecí relace:", err);
      }
    }

    // Reset čítačů relace
    this.currentSessionId = null;
    this.sessionStartTime = null;
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;
    this.currentReadingBlockId = null;
    this.blockEnterTimestamp = null;
    this.blockVisibleWords = 0;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    this.chapterAccumulatedWords = 0;
    this.chapterInitialScrollPercent = this.currentScrollPercent;
    this.timelineSamples = [];
    this.progressHistory = [];
  }

  /**
   * Ukončí měření čtení (např. při návratu do knihovny)
   */
  stopSession() {
    this.flushSession();
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.creditedBlocks.clear();
    this.committedPageKeys.clear();
    this.currentBookId = null;
    this.currentBookTitle = "";
    this.isActive = false;
    this.isIdle = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyListeners(data) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (e) {
        console.error("Chyba v listeneru trackeru:", e);
      }
    }
  }

  // --- STATISTICKÉ VÝPOČTY (PRO DASHBOARD) ---

  /**
   * Jednotný výpočet globálních statistik přímo z denních relací (Unified Time & Metrics Pipeline).
   * totalActiveTime = sum(dailySessions.activeSeconds)
   * totalWords = sum(dailySessions.wordsRead)
   * avgWpm = vážený průměr z validních úseků v pásmu [80, 650] WPM (žádné umělé clampingy)
   */
  static async computeGlobalStats() {
    const sessions = await storage.getAllReadingSessions();
    const books = await storage.getAllBooks();
    const dailyStorageMap = storage.getDailyReadingTimeMap();

    // Seskupení relací do denních souhrnů (dailySessions) podle lokálního data
    const dailyMap = new Map();

    sessions.forEach(s => {
      const dateStr = getLocalDateKey(s.date || s.startTime || s.timestamp || new Date());
      const sec = Math.max(0, Math.round(s.activeSeconds ?? s.durationSeconds ?? 0));
      const words = Math.max(0, Math.round(s.wordsRead ?? 0));

      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, {
          date: dateStr,
          activeSeconds: 0,
          wordsRead: 0,
          sessions: []
        });
      }
      const entry = dailyMap.get(dateStr);
      entry.activeSeconds += sec;
      entry.wordsRead += words;
      entry.sessions.push(s);
    });

    // Synchronizace s denní statistikou z tickeru v localStorage
    for (const [dateStr, rawSec] of Object.entries(dailyStorageMap)) {
      const sec = Math.max(0, Math.round(Number(rawSec) || 0));
      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, {
          date: dateStr,
          activeSeconds: sec,
          wordsRead: 0,
          sessions: []
        });
      } else {
        const entry = dailyMap.get(dateStr);
        if (sec > entry.activeSeconds) {
          entry.activeSeconds = sec;
        }
      }
    }

    // Zahrnutí právě probíhající aktivní relace (live snapshot)
    const liveSnapshot = tracker.getCurrentSessionSnapshot();
    if (liveSnapshot && liveSnapshot.activeSeconds > 0) {
      const todayStr = getLocalDateKey();
      if (!dailyMap.has(todayStr)) {
        dailyMap.set(todayStr, {
          date: todayStr,
          activeSeconds: liveSnapshot.activeSeconds,
          wordsRead: liveSnapshot.wordsRead || 0,
          sessions: [liveSnapshot]
        });
      } else {
        const todayEntry = dailyMap.get(todayStr);
        if (!todayEntry.sessions.some(s => s.sessionId === liveSnapshot.sessionId)) {
          todayEntry.activeSeconds += liveSnapshot.activeSeconds;
          todayEntry.wordsRead += (liveSnapshot.wordsRead || 0);
          todayEntry.sessions.push(liveSnapshot);
        }
      }
    }

    const dailySessions = Array.from(dailyMap.values());

    // Základní pipeline: celkový čas i denní časy pochází z jednoho zdroje
    const totalActiveTime = dailySessions.reduce((sum, d) => sum + d.activeSeconds, 0);
    const totalWords = dailySessions.reduce((sum, d) => sum + d.wordsRead, 0);

    // Výpočet průměrného WPM: vážený průměr z validních relací v pásmu [80, 650] WPM
    let weightedWpmSum = 0;
    let totalValidDuration = 0;

    sessions.forEach(s => {
      const w = s.avgWpm ?? s.wpm ?? 0;
      const dur = s.durationSeconds ?? s.activeSeconds ?? 0;
      const words = s.wordsRead ?? 0;
      if (words > 0 && w >= MIN_VALID_WPM && w <= MAX_VALID_WPM && dur >= 10) {
        weightedWpmSum += w * dur;
        totalValidDuration += dur;
      }
    });

    let averageWpm = DEFAULT_NORMAL_WPM;
    if (totalValidDuration > 0) {
      averageWpm = Math.round(weightedWpmSum / totalValidDuration);
    } else if (totalActiveTime > 60 && totalWords > 0) {
      const rawPace = Math.round(totalWords / (totalActiveTime / 60));
      if (rawPace >= MIN_VALID_WPM && rawPace <= MAX_VALID_WPM) {
        averageWpm = rawPace;
      }
    }

    // Výpočet streak (počet po sobě jdoucích dní s čtením >= 10s)
    const activeDates = new Set(dailySessions.filter(d => d.activeSeconds >= 10).map(d => d.date));
    let streak = 0;
    let checkDate = new Date();
    
    // Zkontrolovat dnes nebo včera v lokálním čase
    const todayStr = getLocalDateKey(checkDate);
    let hasToday = activeDates.has(todayStr);

    const maxIterations = activeDates.size + 10;
    let iterations = 0;
    const visitedDates = new Set();

    while (iterations < maxIterations) {
      iterations++;
      const dateStr = getLocalDateKey(checkDate);
      if (visitedDates.has(dateStr)) break;
      visitedDates.add(dateStr);

      if (activeDates.has(dateStr)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        if (streak === 0 && !hasToday) {
          checkDate.setDate(checkDate.getDate() - 1);
          const yesterdayStr = getLocalDateKey(checkDate);
          if (activeDates.has(yesterdayStr) && !visitedDates.has(yesterdayStr)) {
            streak = 1;
            visitedDates.add(yesterdayStr);
            checkDate.setDate(checkDate.getDate() - 1);
            continue;
          }
        }
        break;
      }
    }

    // Statistiky za posledních 7 dní v lokálním čase (převod sekund na minuty až pro graf)
    const last7Days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dateStr = getLocalDateKey(d);
      const dayName = d.toLocaleDateString("cs-CZ", { weekday: "short" });

      const dEntry = dailyMap.get(dateStr);
      const daySeconds = dEntry ? dEntry.activeSeconds : 0;
      const dayWords = dEntry ? dEntry.wordsRead : 0;

      last7Days.push({
        date: dateStr,
        label: dayName,
        seconds: daySeconds,
        minutes: Math.round(daySeconds / 60), // převod sekund na minuty až při vykreslování
        words: dayWords
      });
    }

    // Historie WPM: pouze validní vzorky v realistickém pásmu [80, 650] WPM (žádné clamped extrémy)
    const wpmHistory = sessions
      .filter(s => {
        const rawSpeed = s.avgWpm ?? s.wpm ?? 0;
        const dur = s.durationSeconds ?? s.activeSeconds ?? 0;
        return rawSpeed >= MIN_VALID_WPM && rawSpeed <= MAX_VALID_WPM && dur >= 10;
      })
      .slice(-20)
      .map((s, idx) => ({
        index: idx + 1,
        wpm: Math.round(s.avgWpm ?? s.wpm),
        date: getLocalDateKey(s.date || s.startTime || s.timestamp),
        bookTitle: s.bookTitle || "Kniha"
      }));

    return {
      totalTimeFormatted: ReadingTracker.formatDuration(totalActiveTime),
      totalSeconds: totalActiveTime,
      totalActiveTime,
      totalWords,
      averageWpm,
      avgWpm: averageWpm,
      streak,
      totalBooks: books.length,
      finishedBooks: books.filter(b => (b.progressPercent || 0) >= 100).length,
      last7Days,
      wpmHistory,
      sessions,
      dailySessions
    };
  }

  static formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds < 60) return `${totalSeconds || 0} s`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours === 0) return `${minutes} min`;
    return `${hours} h ${minutes} min`;
  }

  static formatDurationDetailed(totalSeconds) {
    if (!totalSeconds || totalSeconds < 60) return `${totalSeconds || 0} s`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours === 0) {
      return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
    }
    return `${hours} h ${minutes} min ${seconds > 0 ? `${seconds} s` : ""}`.trim();
  }
}

export const tracker = new ReadingTracker();
