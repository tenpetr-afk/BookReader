/**
 * tracker.js - Inteligentní měřič aktivity a rychlosti čtení (WPM).
 * Zjišťuje reálný aktivní čas (pauza při nečinnosti), počítá slova,
 * odhaduje zbývající čas a ukládá detailní čtecí relace s časovou osou WPM.
 */

import { storage } from "./storage.js";

export const MIN_VALID_WPM = 40;
export const MAX_VALID_WPM = 650;
export const DEFAULT_NORMAL_WPM = 220;
export const MIN_SESSION_DURATION_SEC = 300; // Minimální délka relace pro uložení (5 minut)

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

const IDLE_TIMEOUT_MS = 75000; // 75 sekund bez interakce = uživatel nečte

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
    this.sessionDailySecondsCommitted = 0; // Kolik sekund bylo odesláno do denní statistiky (pouze po dosažení 5 min)
    this.chapterAccumulatedWords = 0;
    this.chapterInitialScrollPercent = 0;
    this.currentScrollPercent = 0;

    // Vážené měření reálného čtení
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;

    // Sledování čtení na úrovni bloků (Strict Single-Point Word Accreditation)
    this.creditedBlocks = new Set(); // Množina klíčů bloků již akreditovaných pro danou knihu
    this.currentReadingBlockId = null; // e.g. `${bookId}_ch${chapterIndex}_p${pageIndex}`
    this.blockEnterTimestamp = null; // Čas příchodu na aktuální blok
    this.blockEnterActiveSec = 0; // Aktivní sekundy při vstupu na blok
    this.blockVisibleWords = 0; // Viditelná slova na aktuálním bloku (pouze viewport)
    this.blockInterimWordsAttributed = 0; // Průběžně odhadovaná slova na bloku před rekonciliací
    this.isContinuousTrackingActive = false; // Příznak, zda pro blok probíhá kontinuální přičítání (pravítko / scroll)
    
    // Zpětná kompatibilita pro stávající reference
    this.committedPageKeys = this.creditedBlocks;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    
    // Striktní 1-minutový bucket akumulátor: [{ minute, elapsedSeconds, words, wpm }]
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
    this.timelineSamples = [];
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;
    this.smoothedWpm = null;

    // Klouzavé okno aktivního čtení pro výpočet okamžitého WPM: [{ activeMs, words }]
    this.activeProgressHistory = [];

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
    if (this.blockInterimWordsAttributed > 0) {
      this.sessionWordsRead = Math.max(0, this.sessionWordsRead - this.blockInterimWordsAttributed);
      this.wordsReadInCurrentMinute = Math.max(0, this.wordsReadInCurrentMinute - this.blockInterimWordsAttributed);
    }
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentReadingBlockId = null;
    this.currentPageKey = null;
    this.blockVisibleWords = 0;
    this.currentPageVisibleWords = 0;
    this.blockEnterActiveSec = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
  }

  /**
   * Kontinuálně přičte přečtená slova (Reading Ruler, Word Tracking nebo vertikální posun).
   * @param {number} count Počet přečtených slov
   */
  attributeWords(count) {
    if (!this.isActive || this.isIdle || !count || count <= 0) return;
    const clampedWords = Math.min(650, Math.round(count));
    this.isContinuousTrackingActive = true;
    this.sessionWordsRead += clampedWords;
    this.wordsReadInCurrentMinute += clampedWords;
    this.recordActivity();
  }

  /**
   * Plynulý odhad čtení slov na aktuální stránce v paged režimu bez pravítka.
   * Zabraňuje tomu, aby před otočením stránky byla minuta s 0 slovy a po otočení špička.
   * @param {number} deltaSec Uplynulý aktivní čas v sekundách
   */
  tickPageProgress(deltaSec) {
    if (this.isContinuousTrackingActive || !this.currentReadingBlockId) return;

    const pageWords = Math.max(0, Math.min(650, Math.round(this.blockVisibleWords || 0)));
    if (pageWords <= 0) return;

    const elapsedSec = Math.floor(this.activeTimeMs / 1000);
    let expectedPace = 200;
    if (this.sessionWordsRead > 0 && elapsedSec >= 30) {
      expectedPace = Math.max(50, Math.min(500, Math.round(this.sessionWordsRead / (elapsedSec / 60))));
    } else if (this.timelineSamples.length > 0) {
      const recentWpms = this.timelineSamples.map(s => Number(s.wpm || s.words || 0)).filter(w => w > 0);
      if (recentWpms.length > 0) {
        expectedPace = Math.round(recentWpms.reduce((a, b) => a + b, 0) / recentWpms.length);
      }
    }

    const wordsThisTick = (expectedPace / 60) * deltaSec;
    if (this.blockInterimWordsAttributed + wordsThisTick <= pageWords) {
      this.blockInterimWordsAttributed += wordsThisTick;
      this.wordsReadInCurrentMinute += wordsThisTick;
      this.sessionWordsRead += wordsThisTick;
    }
  }

  /**
   * Zhodnotí a případně započte čtení na aktuálním otevřeném bloku podle času setrvání (dwell time).
   * Pro paged režim bez pravítka provede přesnou rekonciliaci slov stránky napříč 1-minutovými buckety.
   */
  commitCurrentBlockDwell() {
    const blockId = this.currentReadingBlockId;
    const enterTime = this.blockEnterTimestamp;
    const startSec = this.blockEnterActiveSec;
    const now = Date.now();
    const endSec = Math.floor(this.activeTimeMs / 1000);

    // Reset timestampu
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentReadingBlockId = null;

    if (!blockId || !enterTime) return;

    const dwellSeconds = (now - enterTime) / 1000;
    const activeDwellSec = Math.max(1, endSec - startSec);
    const wordsOnPage = Math.max(0, Math.min(650, Math.round(this.blockVisibleWords || 0)));

    if (wordsOnPage <= 0) return;

    // Pokud už byl blok akreditován kontinuálně (pravítko / scroll), nezapočítáváme znovu
    if (this.isContinuousTrackingActive) {
      this.isContinuousTrackingActive = false;
      this.blockInterimWordsAttributed = 0;
      return;
    }

    // 1. Zahození opuštěné záložky (>= 600s dwell time)
    if (dwellSeconds >= 600) {
      if (this.blockInterimWordsAttributed > 0) {
        this.sessionWordsRead = Math.max(0, this.sessionWordsRead - this.blockInterimWordsAttributed);
        this.wordsReadInCurrentMinute = Math.max(0, this.wordsReadInCurrentMinute - this.blockInterimWordsAttributed);
      }
      this.blockInterimWordsAttributed = 0;
      return;
    }

    // 2. Přísná validace minimálního fyziologického času stráveného na stránce:
    const minSeconds = Math.max(3.0, (wordsOnPage / MAX_VALID_WPM) * 60);

    // Pokud uživatel otočil stránku rychleji než za minSeconds, jde o navigaci (skimming/flipping):
    if (dwellSeconds < minSeconds) {
      if (this.blockInterimWordsAttributed > 0) {
        this.sessionWordsRead = Math.max(0, this.sessionWordsRead - this.blockInterimWordsAttributed);
        this.wordsReadInCurrentMinute = Math.max(0, this.wordsReadInCurrentMinute - this.blockInterimWordsAttributed);
      }
      this.blockInterimWordsAttributed = 0;
      return;
    }

    // 3. Rychlost čtení na stránce
    const rawWpm = Math.round(wordsOnPage / (activeDwellSec / 60));
    if (rawWpm > MAX_VALID_WPM) {
      if (this.blockInterimWordsAttributed > 0) {
        this.sessionWordsRead = Math.max(0, this.sessionWordsRead - this.blockInterimWordsAttributed);
        this.wordsReadInCurrentMinute = Math.max(0, this.wordsReadInCurrentMinute - this.blockInterimWordsAttributed);
      }
      this.blockInterimWordsAttributed = 0;
      return;
    }

    // 4. Rekonciliace slov stránky napříč 1-minutovými buckety:
    // Odečteme prozatímní odhadovaná slova přidaná pro tuto stránku
    const interimToReconcile = this.blockInterimWordsAttributed || 0;
    this.sessionWordsRead = Math.max(0, this.sessionWordsRead - interimToReconcile);
    this.wordsReadInCurrentMinute = Math.max(0, this.wordsReadInCurrentMinute - interimToReconcile);
    this.blockInterimWordsAttributed = 0;

    // Blok je akreditován POUZE JEDNOU za celou knihu (Strict Single-Point Accreditation)
    if (!this.creditedBlocks.has(blockId)) {
      this.creditedBlocks.add(blockId);
      this.sessionWordsRead += wordsOnPage;

      // Rozdělení wordsOnPage proporcionálně mezi jednotlivé minuty podle překryvu aktivních sekund
      const totalT = Math.max(1, endSec - startSec);
      const minStartMinute = Math.floor(startSec / 60) + 1;
      const maxEndMinute = Math.floor(endSec / 60) + 1;

      let remainingWordsToDistribute = wordsOnPage;

      for (let m = minStartMinute; m <= maxEndMinute; m++) {
        const mStartSec = (m - 1) * 60;
        const mEndSec = m * 60;
        const overlap = Math.max(0, Math.min(endSec, mEndSec) - Math.max(startSec, mStartSec));
        if (overlap <= 0) continue;

        let wordsForMinute = Math.round(wordsOnPage * (overlap / totalT));
        if (m === maxEndMinute) {
          wordsForMinute = remainingWordsToDistribute;
        } else {
          remainingWordsToDistribute = Math.max(0, remainingWordsToDistribute - wordsForMinute);
        }

        if (m <= this.currentMinuteIndex) {
          const sample = this.timelineSamples.find(s => s.minute === m);
          if (sample) {
            sample.words = Math.max(0, (sample.words || 0) + wordsForMinute);
            sample.wpm = sample.words;
          }
        } else {
          this.wordsReadInCurrentMinute += wordsForMinute;
        }
      }
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
    this.blockEnterActiveSec = Math.floor(this.activeTimeMs / 1000);
    this.blockVisibleWords = visibleWords;
    this.currentPageVisibleWords = visibleWords;
    this.isContinuousTrackingActive = false;
    this.blockInterimWordsAttributed = 0;
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
    this.sessionDailySecondsCommitted = 0;
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
    this.blockEnterActiveSec = 0;
    this.blockVisibleWords = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;

    // Striktní 1-minutový bucket akumulátor
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
    this.timelineSamples = [];
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;
    this.smoothedWpm = null;
    this.activeProgressHistory = [{ activeMs: 0, words: 0 }];

    this.startTicker();
  }

  startTicker() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTickTime;
      this.lastTickTime = now;

      if (!this.isActive) return;

      // Zkontrolujeme, zda neuplynul idle timeout (>75s)
      if (now - this.lastActivityTime > IDLE_TIMEOUT_MS) {
        if (!this.isIdle) {
          this.isIdle = true;
          // Odečíst mrtvý čas nečinnosti před uložením relace (žádné ředění průměrného WPM)
          const idleDelta = Math.min(this.activeTimeMs, now - this.lastActivityTime);
          this.activeTimeMs = Math.max(0, this.activeTimeMs - idleDelta);
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

        // Plynulý odhad slov v paged režimu bez pravítka
        this.tickPageProgress(deltaSec);

        // Striktní 1-minutový bucket akumulátor: každých 60s aktivního čtení pushnout přesně 1 bod
        const targetMinute = Math.floor(elapsedSec / 60);
        while (this.currentMinuteIndex < targetMinute) {
          this.currentMinuteIndex += 1;
          const minuteWords = Math.max(0, Math.round(this.wordsReadInCurrentMinute));
          this.timelineSamples.push({
            minute: this.currentMinuteIndex,
            elapsedSeconds: this.currentMinuteIndex * 60,
            words: minuteWords,
            wpm: minuteWords, // Vzhledem k přesně 1 minutě: slova === WPM
            timestamp: now
          });
          this.wordsReadInCurrentMinute = 0;
        }

        // Zaznamenáme postup aktivního čtení do klouzavého okna
        this.recordActiveProgress();

        // Synchronizace s denní statistikou v sekundách:
        // Do denní statistiky započítáváme relaci až po dosažení prahu 5 minut (>= 300 sekund)
        if (elapsedSec >= MIN_SESSION_DURATION_SEC) {
          const todayKey = getLocalDateKey();
          if (this.sessionDailySecondsCommitted === 0) {
            storage.addDailyReadingSeconds(todayKey, elapsedSec);
            this.sessionDailySecondsCommitted = elapsedSec;
          } else {
            const deltaCommitted = elapsedSec - this.sessionDailySecondsCommitted;
            if (deltaCommitted > 0) {
              storage.addDailyReadingSeconds(todayKey, deltaCommitted);
              this.sessionDailySecondsCommitted = elapsedSec;
            }
          }
        }

        this.notifyListeners({
          type: "tick",
          activeSeconds: elapsedSec,
          wpm: this.getCurrentWpm(),
          wordsRead: Math.round(this.sessionWordsRead)
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
   * Zaznamená postup do klouzavého okna aktivního čtení (Rolling Window)
   */
  recordActiveProgress() {
    const currentActiveMs = this.activeTimeMs;
    const currentWords = this.sessionWordsRead;
    // Uchováváme historii v okně posledních 60 sekund aktivního čtení
    this.activeProgressHistory = (this.activeProgressHistory || []).filter(p => currentActiveMs - p.activeMs <= 60000);
    this.activeProgressHistory.push({ activeMs: currentActiveMs, words: currentWords });
  }

  /**
   * Spočítá klouzavé tempo čtení z okna 30-45 sekund reálného aktivního času (vyjma pauz/nečinnosti)
   */
  getRollingActivePace() {
    const currentActiveMs = this.activeTimeMs;
    const currentWords = this.sessionWordsRead;

    if (!this.activeProgressHistory || this.activeProgressHistory.length === 0) {
      return this.getCurrentWpm();
    }

    // Hledáme záznam v plovoucím okně 30 až 50 sekund aktivního čtení
    let reference = null;
    for (let i = 0; i < this.activeProgressHistory.length; i++) {
      const entry = this.activeProgressHistory[i];
      const deltaMs = currentActiveMs - entry.activeMs;
      if (deltaMs >= 30000 && deltaMs <= 50000) {
        reference = entry;
        break;
      }
    }

    // Pokud nemáme vzorek starý alespoň 30s, ale relace trvá 12-30s a bylo přečteno dost slov:
    if (!reference) {
      if (currentActiveMs >= 12000 && currentWords >= 15) {
        const pace = Math.round(currentWords / (currentActiveMs / 60000));
        return pace;
      }
      return this.getCurrentWpm();
    }

    const deltaMs = currentActiveMs - reference.activeMs;
    const deltaWords = currentWords - reference.words;
    if (deltaMs < 10000 || deltaWords <= 0) {
      return this.getCurrentWpm();
    }

    const deltaMin = deltaMs / 60000;
    const pace = Math.round(deltaWords / deltaMin);
    return pace;
  }

  /**
   * Zaznamená bod na časové ose rychlosti čtení (Intra-session WPM timeline).
   * Zaručuje striktně monotónní čas aktivního čtení (Monotonic Elapsed Active Time),
   * klouzavý výpočet v okně 30-45s s EMA vyhlazením a clamping nereálných špiček (Outlier Clamping).
   * @param {number} elapsedSec Uplynulý aktivní čas v sekundách
   * @param {number|null} forceWpm Kandidátní rychlost WPM (např. z dwell time)
   */
  recordTimelineSample(elapsedSec = null, forceWpm = null) {
    const elapsed = elapsedSec !== null ? Math.max(0, Math.round(elapsedSec)) : Math.floor(this.activeTimeMs / 1000);
    const now = Date.now();

    // 1. Získání klouzavého tempa z 30-45s okna aktivního čtení
    const rollingPace = this.getRollingActivePace();
    let rawPace = rollingPace;

    if (typeof forceWpm === "number" && !isNaN(forceWpm) && forceWpm >= MIN_VALID_WPM) {
      // Vážený kompromis: 35 % dwell time z aktuální stránky, 65 % stabilní 30-45s rolling okno
      rawPace = Math.round(forceWpm * 0.35 + rollingPace * 0.65);
    }

    // 2. Outlier Clamping: Cap unrealistic transient velocity spikes
    const currentAvg = this.getCurrentWpm();
    const maxAllowedPace = Math.min(MAX_VALID_WPM, Math.max(300, Math.round(currentAvg * 1.65)));
    const clampedPace = Math.max(MIN_VALID_WPM, Math.min(maxAllowedPace, rawPace));

    // 3. EMA Smoothing (Exponential Moving Average)
    const alpha = 0.28;
    if (this.smoothedWpm === null) {
      this.smoothedWpm = clampedPace;
    } else {
      this.smoothedWpm = Math.round(this.smoothedWpm * (1 - alpha) + clampedPace * alpha);
    }

    const instantaneousWpm = Math.max(MIN_VALID_WPM, Math.min(maxAllowedPace, this.smoothedWpm));

    // 4. Striktně monotónní čas aktivního čtení (Monotonic Elapsed Active Time)
    if (this.timelineSamples.length > 0) {
      const last = this.timelineSamples[this.timelineSamples.length - 1];
      const lastSec = last.elapsedActiveSeconds ?? last.elapsedSeconds ?? 0;

      if (elapsed < lastSec) {
        // Retrográdní skok v čase (např. raw wall-clock při pauze) -> ignorovat
        return;
      }
      if (elapsed === lastSec) {
        // Stejná sekunda -> aktualizovat stávající vzorek bez vytváření duplicitního bodu
        last.instantaneousWpm = instantaneousWpm;
        last.timestamp = now;
        return;
      }
      if (elapsed - lastSec < 3) {
        // Příliš blízko u sebe (<3s) -> vyhladit do předchozího bodu, zabrání shlukům
        last.instantaneousWpm = Math.round((last.instantaneousWpm + instantaneousWpm) / 2);
        return;
      }
    }

    const sample = {
      timestamp: now,
      elapsedSeconds: elapsed,
      elapsedActiveSeconds: elapsed,
      instantaneousWpm
    };

    this.timelineSamples.push(sample);
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
   * Skutečný poměr přečtených slov k aktivnímu času v minutách v pásmu [40, 650] WPM.
   */
  getCurrentWpm() {
    const activeMinutes = this.activeTimeMs / 60000;
    if (activeMinutes >= 0.2 && this.sessionWordsRead >= 10) {
      const pace = Math.round(this.sessionWordsRead / activeMinutes);
      if (pace >= MIN_VALID_WPM && pace <= MAX_VALID_WPM) {
        return pace;
      }
    }

    if (this.timelineSamples.length > 0) {
      const validSamples = this.timelineSamples
        .map(s => Number(s.wpm ?? s.words ?? 0))
        .filter(w => w >= MIN_VALID_WPM && w <= MAX_VALID_WPM);
      if (validSamples.length > 0) {
        return Math.round(validSamples.reduce((a, b) => a + b, 0) / validSamples.length);
      }
    }

    return DEFAULT_NORMAL_WPM; // Výchozí referenční rychlost (220 WPM) při nedostatku dat
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
    // Živý snímek poskytujeme pouze pro relace splňující minimální práh 5 minut (300 sekund)
    if (!this.currentBookId || activeSeconds < MIN_SESSION_DURATION_SEC) return null;

    const wordsRead = Math.round(this.sessionWordsRead);
    const durationMinutes = activeSeconds / 60;
    const avgWpm = durationMinutes > 0 ? Math.round(wordsRead / durationMinutes) : this.getCurrentWpm();

    const samples = [...this.timelineSamples];
    // Pokud máme neuzavřenou dílčí minutu na konci, doplníme koncový bod v čase activeSeconds
    if (activeSeconds > (this.currentMinuteIndex * 60)) {
      const partialSec = activeSeconds - (this.currentMinuteIndex * 60);
      const partialWords = Math.round(this.wordsReadInCurrentMinute);
      const partialPace = partialSec > 0 ? Math.round(partialWords / (partialSec / 60)) : avgWpm;
      samples.push({
        minute: this.currentMinuteIndex + 1,
        elapsedSeconds: activeSeconds,
        words: partialWords,
        wpm: (partialPace >= MIN_VALID_WPM && partialPace <= MAX_VALID_WPM) ? partialPace : avgWpm,
        isPartial: true
      });
    }

    // Výpočet špičkové rychlosti (peakWpm): maximum z 1-minutových bucketů
    const validSpeeds = samples.map(s => Number(s.wpm || s.words || 0)).filter(w => w > 0);
    const peakWpm = validSpeeds.length > 0 ? Math.max(...validSpeeds, avgWpm) : avgWpm;

    return {
      sessionId: this.currentSessionId || "session_current",
      id: this.currentSessionId || "session_current",
      bookId: this.currentBookId,
      bookTitle: this.currentBookTitle || "Aktuální kniha",
      chapterIndex: this.currentChapterIndex,
      startTime: this.sessionStartTime || new Date(Date.now() - activeSeconds * 1000).toISOString(),
      endTime: null,
      durationSeconds: activeSeconds,
      activeSeconds: activeSeconds,
      duration: activeSeconds,
      wordsRead: wordsRead,
      avgWpm: avgWpm,
      peakWpm: peakWpm,
      wpm: avgWpm,
      timelineSamples: samples,
      intraSessionSamples: samples,
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
    const wordsRead = Math.round(this.sessionWordsRead);

    // Ukládáme POUZE relace s aktivní dobou čtení alespoň 5 minut (>= 300 sekund)
    if (bookId && activeSeconds >= MIN_SESSION_DURATION_SEC) {
      const durationMinutes = activeSeconds / 60;
      const avgWpm = (durationMinutes > 0 && wordsRead > 0) ? Math.round(wordsRead / durationMinutes) : 0;
      const now = Date.now();
      const endTime = new Date(now).toISOString();
      const dateKey = getLocalDateKey(this.sessionStartTimestamp || now);

      const samples = [...this.timelineSamples];
      // Pokud relace skončila uprostřed minuty, přidáme koncový bod v čase activeSeconds
      if (activeSeconds > (this.currentMinuteIndex * 60)) {
        const partialSec = activeSeconds - (this.currentMinuteIndex * 60);
        const partialWords = Math.round(this.wordsReadInCurrentMinute);
        const partialPace = partialSec > 0 ? Math.round(partialWords / (partialSec / 60)) : avgWpm;
        samples.push({
          minute: this.currentMinuteIndex + 1,
          elapsedSeconds: activeSeconds,
          words: partialWords,
          wpm: (partialPace >= MIN_VALID_WPM && partialPace <= MAX_VALID_WPM) ? partialPace : avgWpm,
          isPartial: true
        });
      }

      // Výpočet špičkové rychlosti (peakWpm): maximum z 1-minutových bucketů
      const validSpeeds = samples.map(s => Number(s.wpm || s.words || 0)).filter(w => w > 0);
      const peakWpm = validSpeeds.length > 0 ? Math.max(...validSpeeds, avgWpm) : avgWpm;

      const sessionId = this.currentSessionId || `session_${now}_${Math.random().toString(36).substring(2, 9)}`;

      const sessionRecord = {
        sessionId: sessionId,
        id: sessionId,
        bookId: bookId,
        bookTitle: bookTitle,
        chapterIndex: this.currentChapterIndex,
        startTime: this.sessionStartTime || new Date(now - activeSeconds * 1000).toISOString(),
        endTime: endTime,
        durationSeconds: activeSeconds,
        activeSeconds: activeSeconds,
        duration: activeSeconds,
        wordsRead: wordsRead,
        avgWpm: avgWpm,
        peakWpm: peakWpm,
        wpm: avgWpm,
        timelineSamples: samples,
        intraSessionSamples: samples,
        date: dateKey,
        timestamp: now,
        updatedAt: new Date(now).toISOString()
      };

      try {
        const savedSession = await storage.saveReadingSession(sessionRecord);

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

        // PUSH DO SUPABASE: Odeslání platné relace (>= 5 min) a aktualizovaného souhrnu statistik
        storage.pushReadingSessionAndStatsToCloud(savedSession || sessionRecord).catch(err => {
          console.warn("[LuminaSync] Varování při pushi čtecí relace do Supabase:", err);
        });

      } catch (err) {
        console.warn("Chyba při ukládání čtecí relace:", err);
      }
    } else {
      // Relace trvala méně než 5 minut (< 300s): kompletně zahodit záznam relace!
      if (activeSeconds > 0) {
        console.log(`[LuminaTracker] Relace čtení byla zahozena (trvala ${activeSeconds}s < 300s minimálního prahu).`);
      }
      // Pouze uložit aktuální pozici rozečtení (kapitola a scroll) do knihy bez přičtení slov či historie
      if (bookId) {
        try {
          await storage.updateBookProgress(bookId, {
            currentChapterIndex: this.currentChapterIndex,
            scrollPercent: this.currentScrollPercent
          });
        } catch (_) {}
      }
    }

    // Reset čítačů relace
    this.currentSessionId = null;
    this.sessionStartTime = null;
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.sessionDailySecondsCommitted = 0;
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;
    this.currentReadingBlockId = null;
    this.blockEnterTimestamp = null;
    this.blockEnterActiveSec = 0;
    this.blockVisibleWords = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    this.chapterAccumulatedWords = 0;
    this.chapterInitialScrollPercent = this.currentScrollPercent;
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
    this.timelineSamples = [];
    this.progressHistory = [];
    this.activeProgressHistory = [];
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
   * Jednotný výpočet globálních statistik striktně ze součtu jednotlivých záznamů relací.
   * totalActiveTime = sum(sessions.activeSeconds)
   * totalWords = sum(sessions.wordsRead)
   * avgWpm = round(totalWords / (totalActiveTime / 60))
   * streak = počet po sobě jdoucích dní s platným čtením (>= 5 minut)
   */
  static async computeGlobalStats(customSessions = null, customBooks = null) {
    const rawSessions = customSessions !== null ? customSessions : ((typeof storage !== "undefined" && storage.getAllReadingSessions) ? await storage.getAllReadingSessions() : []);
    const books = customBooks !== null ? customBooks : ((typeof storage !== "undefined" && storage.getAllBooks) ? await storage.getAllBooks() : []);

    // Filtrujeme striktně pouze relace s aktivní dobou čtení >= 5 minut (300 sekund)
    const sessions = (rawSessions || []).filter(s => {
      const sec = Math.max(0, Math.round(s.activeSeconds ?? s.durationSeconds ?? s.duration ?? 0));
      return sec >= MIN_SESSION_DURATION_SEC;
    });

    // Zahrnutí právě probíhající aktivní relace (live snapshot pouze pokud >= 5 minut)
    const liveSnapshot = (typeof tracker !== "undefined" && tracker) ? tracker.getCurrentSessionSnapshot() : null;
    const allSessions = [...sessions];
    if (liveSnapshot && liveSnapshot.activeSeconds >= MIN_SESSION_DURATION_SEC) {
      if (!allSessions.some(s => s.sessionId === liveSnapshot.sessionId || s.id === liveSnapshot.sessionId)) {
        allSessions.push(liveSnapshot);
      }
    }

    // Seskupení relací do denních souhrnů (dailyMap) podle lokálního data
    const dailyMap = new Map();
    allSessions.forEach(s => {
      const dateStr = getLocalDateKey(s.date || s.startTime || s.timestamp || new Date());
      const sec = Math.max(0, Math.round(s.activeSeconds ?? s.durationSeconds ?? s.duration ?? 0));
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

    const dailySessions = Array.from(dailyMap.values());

    // Základní pipeline: celkový čas i slova pochází STRICTLY ze součtu platných relací
    const totalActiveTime = allSessions.reduce((sum, s) => sum + Math.max(0, Math.round(s.activeSeconds ?? s.durationSeconds ?? s.duration ?? 0)), 0);
    const totalWords = allSessions.reduce((sum, s) => sum + Math.max(0, Math.round(s.wordsRead ?? 0)), 0);

    // Výpočet průměrného WPM: celková slova / celkový čas v minutách
    let averageWpm = 0;
    if (totalActiveTime > 0 && totalWords > 0) {
      averageWpm = Math.round(totalWords / (totalActiveTime / 60));
    }

    // Synchronizace denní mapy do localStorage pro konzistenci
    const dailyStorageObj = {};
    dailySessions.forEach(d => {
      dailyStorageObj[d.date] = d.activeSeconds;
    });
    try {
      localStorage.setItem("luminareader_daily_reading_time", JSON.stringify(dailyStorageObj));
    } catch (_) {}

    // Výpočet streak (počet po sobě jdoucích dní s validním čtením >= 5 minut)
    const activeDates = new Set(dailySessions.filter(d => d.activeSeconds >= MIN_SESSION_DURATION_SEC).map(d => d.date));
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

    // Statistiky za posledních 7 dní v lokálním čase
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
        minutes: Math.round(daySeconds / 60),
        words: dayWords
      });
    }

    // Historie WPM: validní relace v pásmu [40, 650] WPM (žádné umělé clampingy na 80+)
    const wpmHistory = allSessions
      .filter(s => {
        const rawSpeed = s.avgWpm ?? s.wpm ?? 0;
        const dur = s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0;
        return rawSpeed >= MIN_VALID_WPM && rawSpeed <= MAX_VALID_WPM && dur >= MIN_SESSION_DURATION_SEC;
      })
      .slice(-20)
      .map((s, idx) => ({
        index: idx + 1,
        wpm: Math.round(s.avgWpm ?? s.wpm),
        date: getLocalDateKey(s.date || s.startTime || s.timestamp),
        timestamp: s.timestamp || (s.startTime ? new Date(s.startTime).getTime() : null),
        startTime: s.startTime,
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
      sessions: allSessions,
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
