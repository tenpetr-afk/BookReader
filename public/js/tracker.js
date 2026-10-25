/**
 * tracker.js - Inteligentní měřič aktivity a rychlosti čtení (WPM).
 * Zjišťuje reálný aktivní čas (pauza při nečinnosti), počítá slova,
 * odhaduje zbývající čas a ukládá detailní čtecí relace s časovou osou WPM.
 */

import { storage } from "./storage.js";

export const MIN_VALID_WPM = 40;
export const MAX_VALID_WPM = 650;
export const DEFAULT_NORMAL_WPM = 0;
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

const IDLE_TIMEOUT_MS = 45000; // 45 sekund bez interakce = pauza čtení
const SESSION_ABANDON_TIMEOUT_MS = 900000; // 15 minut nečinnosti = automatické uložení relace

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

    // Sledování čtení na úrovni bloků a deduplikace pravítka vs. otáčení stran
    this.creditedBlocks = new Set(); // Množina klíčů bloků již akreditovaných pro danou knihu
    this.currentReadingBlockId = null; // e.g. `${bookId}_ch${chapterIndex}_p${pageIndex}`
    this.blockEnterTimestamp = null; // Čas příchodu na aktuální blok
    this.blockEnterActiveSec = 0; // Aktivní sekundy při vstupu na blok
    this.blockVisibleWords = 0; // Viditelná slova na aktuálním bloku (pouze viewport)
    this.wordsCreditedOnCurrentPage = 0; // Slova již započtená na aktuální stránce (pravítkem nebo průběžně)
    this.blockInterimWordsAttributed = 0; // Průběžně odhadovaná slova na bloku při vypnutém pravítku
    this.isContinuousTrackingActive = false; // Příznak, zda pro blok probíhá kontinuální přičítání (pravítko / scroll)
    
    // Zpětná kompatibilita pro stávající reference
    this.committedPageKeys = this.creditedBlocks;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    
    // Striktní 1-minutový (60 aktivních sekund) bucket akumulátor
    this.currentMinuteActiveSeconds = 0;
    this.currentMinuteWords = 0;
    this.completedMinutesCount = 1;
    this.intra_session_samples = [];
    this.timelineSamples = this.intra_session_samples;
    this.intraSessionSamples = this.intra_session_samples;
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;
    this.smoothedWpm = null;

    // Klouzavé okno aktivního čtení: [{ activeMs, words }]
    this.activeProgressHistory = [];

    // Posluchači změn pro UI
    this.listeners = new Set();

    this.initActivityListeners();
  }

  _isReaderActivelyVisible() {
    if (typeof document === "undefined") return true;
    const statsModal = document.getElementById("stats-modal");
    if (statsModal && statsModal.classList.contains("open")) return false;
    const viewReader = document.getElementById("view-reader");
    if (viewReader && viewReader.classList.contains("is-hidden")) return false;
    return true;
  }

  initActivityListeners() {
    const onUserAction = () => {
      if (!this._isReaderActivelyVisible()) return;
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
        if (this.currentBookId && this._isReaderActivelyVisible()) {
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
      this.lastTickTime = Date.now();
      this.notifyListeners({ type: "idleChange", isIdle: false });
      // Pokud byla předchozí relace ukončena, začíná nová souvislá relace
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
      this.currentMinuteWords = Math.max(0, this.currentMinuteWords - this.blockInterimWordsAttributed);
      this.wordsReadInCurrentMinute = this.currentMinuteWords;
    }
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentReadingBlockId = null;
    this.currentPageKey = null;
    this.blockVisibleWords = 0;
    this.currentPageVisibleWords = 0;
    this.blockEnterActiveSec = 0;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
  }

  /**
   * Kontinuálně přičte přečtená slova (Reading Ruler, Word Tracking nebo vertikální posun).
   * @param {number} count Počet přečtených slov
   */
  attributeWords(count) {
    if (!this.isActive || !count || count <= 0) return;
    if (this.isIdle) {
      this.recordActivity();
    }
    const clampedWords = Math.min(650, Math.round(count));
    if (clampedWords <= 0) return;

    // Pokud před zapnutím pravítka běžela průběžná atribuce na téže stránce, nejprve ji nahradíme reálným posunem pravítka
    if (this.blockInterimWordsAttributed > 0) {
      this.sessionWordsRead = Math.max(0, this.sessionWordsRead - this.blockInterimWordsAttributed);
      this.currentMinuteWords = Math.max(0, this.currentMinuteWords - this.blockInterimWordsAttributed);
      this.wordsCreditedOnCurrentPage = Math.max(0, this.wordsCreditedOnCurrentPage - this.blockInterimWordsAttributed);
      this.blockInterimWordsAttributed = 0;
    }

    this.isContinuousTrackingActive = true;
    this.wordsCreditedOnCurrentPage += clampedWords;
    this.currentMinuteWords += clampedWords;
    this.wordsReadInCurrentMinute = this.currentMinuteWords;
    this.sessionWordsRead += clampedWords;
    this.recordActivity();
  }

  /**
   * Plynulý odhad čtení slov na aktuální stránce v paged režimu, když je čtecí pravítko VYPNUTÉ.
   * Připisuje slova plynule do aktuálního 1-minutového bucketu až do výše viditelných slov na stránce.
   * @param {number} deltaSec Uplynulý aktivní čas v sekundách
   */
  tickPageProgress(deltaSec) {
    if (this.isContinuousTrackingActive || !this.currentReadingBlockId) return;
    if (this.creditedBlocks.has(this.currentReadingBlockId)) return;

    // Pokud je čtecí pravítko zapnuté, slova se započítávají přes ruler.onProgress a zbylá slova při otočení stránky
    const rulerEnabled = typeof window !== "undefined" && window.luminaApp?.ruler?.enabled;
    if (rulerEnabled) return;

    const pageWords = Math.max(0, Math.min(650, Math.round(this.blockVisibleWords || 0)));
    if (pageWords <= 0) return;

    const totalActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    let expectedPace = 180;
    if (this.sessionWordsRead >= 15 && totalActiveSec >= 20) {
      expectedPace = Math.max(60, Math.min(450, Math.round((this.sessionWordsRead / totalActiveSec) * 60)));
    } else if (this.intra_session_samples.length > 0) {
      const recentWpms = this.intra_session_samples.map(s => Number(s.wpm || s.words || 0)).filter(w => w > 0);
      if (recentWpms.length > 0) {
        expectedPace = Math.max(60, Math.min(450, Math.round(recentWpms.reduce((a, b) => a + b, 0) / recentWpms.length)));
      }
    }

    const wordsThisTick = (expectedPace / 60) * deltaSec;
    if (this.wordsCreditedOnCurrentPage < pageWords) {
      const deltaWords = Math.min(wordsThisTick, pageWords - this.wordsCreditedOnCurrentPage);
      if (deltaWords > 0) {
        this.wordsCreditedOnCurrentPage += deltaWords;
        this.blockInterimWordsAttributed += deltaWords;
        this.currentMinuteWords += deltaWords;
        this.wordsReadInCurrentMinute = this.currentMinuteWords;
        this.sessionWordsRead += deltaWords;
      }
    }
  }

  /**
   * Při otočení stránky vpřed (nextPage) nebo ukončení bloku dopočítá zbývající nezapočtená slova:
   * remainingUncreditedWords = Math.max(0, visibleWordsOnPage - wordsCreditedOnCurrentPage),
   * pokud uživatel strávil na stránce realistickou minimální dobu (>= 3 sekundy).
   * Poté vyresetuje wordsCreditedOnCurrentPage = 0 pro novou stránku.
   */
  commitCurrentBlockDwell(direction = 1, visibleWordsOverride = null) {
    const blockId = this.currentReadingBlockId;
    const enterTime = this.blockEnterTimestamp || this.pageEnterTimestamp || this.currentPageStartTime;
    const now = Date.now();

    const wordsOnPage = Math.max(
      0,
      Math.min(
        650,
        Math.round(visibleWordsOverride !== null && visibleWordsOverride !== undefined ? visibleWordsOverride : (this.blockVisibleWords || 0))
      )
    );
    const creditedSoFar = Math.max(0, Math.round(this.wordsCreditedOnCurrentPage || 0));
    const interimAttributed = this.blockInterimWordsAttributed || 0;

    // Reset stavu stránky
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentPageStartTime = null;
    this.currentReadingBlockId = null;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;

    if (!blockId || !enterTime || wordsOnPage <= 0) return 0;

    const dwellSeconds = (now - enterTime) / 1000;

    // 1. Ochrana proti rychlému překlikávání stránek (< 3 sekundy) nebo opuštěné záložce (>= 600 sekund)
    if (dwellSeconds < 3.0 || dwellSeconds >= 600) {
      if (interimAttributed > 0) {
        this.sessionWordsRead = Math.max(0, this.sessionWordsRead - interimAttributed);
        this.currentMinuteWords = Math.max(0, this.currentMinuteWords - interimAttributed);
        this.wordsReadInCurrentMinute = this.currentMinuteWords;
      }
      return 0;
    }

    // Při zpětném listování (prevPage) nedopočítáváme nepřečtený zbytek stránky
    if (direction < 0) {
      return 0;
    }

    // 2. Výpočet zbývajících nezapočtených slov na stránce
    const remainingUncreditedWords = Math.max(0, wordsOnPage - creditedSoFar);

    if (!this.creditedBlocks.has(blockId)) {
      this.creditedBlocks.add(blockId);
      if (remainingUncreditedWords > 0) {
        this.currentMinuteWords += remainingUncreditedWords;
        this.wordsReadInCurrentMinute = this.currentMinuteWords;
        this.sessionWordsRead += remainingUncreditedWords;
        return remainingUncreditedWords;
      }
    }

    return 0;
  }

  // Alias pro zpětnou kompatibilitu
  commitCurrentPageDwell(direction = 1, visibleWordsOverride = null) {
    return this.commitCurrentBlockDwell(direction, visibleWordsOverride);
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
    const direction = pageInfo.direction !== undefined && pageInfo.direction !== null ? pageInfo.direction : 1;
    let visibleWords = 0;
    if (pageInfo.visibleWords !== undefined && pageInfo.visibleWords !== null) {
      visibleWords = Math.max(0, Math.min(650, Math.round(pageInfo.visibleWords)));
    } else {
      visibleWords = 250;
    }
    const isReflow = !!pageInfo.isReflow;
    const isInitialLoad = !!pageInfo.isInitialLoad;
    const isNavigationJump = !!pageInfo.isNavigationJump;
    const isVerticalScroll = !!pageInfo.isVerticalScroll;

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
      this.wordsCreditedOnCurrentPage = 0;
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
      this.wordsCreditedOnCurrentPage = 0;
      this.currentChapterIndex = chapterIndex;
      return;
    }

    // Pokud jde o tutéž stránku (např. opakované hlášení bez posunu):
    if (newBlockId === this.currentReadingBlockId) {
      this.blockVisibleWords = visibleWords;
      this.currentPageVisibleWords = visibleWords;
      return;
    }

    // Uživatel skutečně opouští předchozí stránku -> vyhodnotit zbývající slova
    if (this.currentReadingBlockId && !isVerticalScroll) {
      this.commitCurrentBlockDwell(direction);
    } else if (isVerticalScroll) {
      this.wordsCreditedOnCurrentPage = 0;
      this.blockInterimWordsAttributed = 0;
    }

    // Vstup na nový čtecí blok
    this.currentReadingBlockId = newBlockId;
    this.currentPageKey = newBlockId;
    const now = Date.now();
    this.blockEnterTimestamp = now;
    this.pageEnterTimestamp = now;
    this.blockEnterActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    this.blockVisibleWords = visibleWords;
    this.currentPageVisibleWords = visibleWords;
    this.wordsCreditedOnCurrentPage = 0;
    this.isContinuousTrackingActive = false;
    this.blockInterimWordsAttributed = 0;
    this.currentChapterIndex = chapterIndex;
    this.recordActivity();

    this.notifyListeners({
      type: "pageChange",
      pageIndex,
      chapterIndex,
      wordsRead: Math.round(this.sessionWordsRead),
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
      if (this.currentSessionId) {
        this.currentChapterIndex = resolvedIndex;
        this.currentChapterWords = resolvedWords || 1;
        this.currentScrollPercent = resolvedScroll;
        this.recordActivity();
      } else {
        // Relace ještě nebyla zahájena
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
    this.wordsCreditedOnCurrentPage = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;

    // Striktní 1-minutový (60 aktivních sekund) bucket akumulátor (bez jakýchkoliv 220 WPM seedů)
    this.currentMinuteActiveSeconds = 0;
    this.currentMinuteWords = 0;
    this.completedMinutesCount = 1;
    this.intra_session_samples = [];
    this.timelineSamples = this.intra_session_samples;
    this.intraSessionSamples = this.intra_session_samples;
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
    this.lastSampleActiveSec = 0;
    this.lastSampleWordsRead = 0;
    this.smoothedWpm = null;
    this.activeProgressHistory = [];

    this.startTicker();
  }

  startTicker() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      const now = Date.now();
      this.lastTickTime = now;

      if (!this.isActive || !this._isReaderActivelyVisible()) return;

      // Pauza při nečinnosti uživatele > 45 sekund
      if (now - this.lastActivityTime > IDLE_TIMEOUT_MS) {
        if (!this.isIdle) {
          this.isIdle = true;
          this.notifyListeners({ type: "idleChange", isIdle: true });
        }
        // Pokud je uživatel neaktivní přes 15 minut, uložíme dokončenou relaci
        if (this.currentSessionId && (now - this.lastActivityTime > SESSION_ABANDON_TIMEOUT_MS)) {
          this.flushSession();
        }
        return; // Nepřičítáme aktivní sekundy, pokud je uživatel nečinný
      }

      if (this.isActive && !this.isIdle) {
        // 1. Inkrementace aktivní sekundy v aktuální minutě
        this.currentMinuteActiveSeconds += 1;

        // 2. Plynulý odhad slov v paged režimu, pokud je čtecí pravítko vypnuté
        this.tickPageProgress(1);

        // 3. Pokaždé, když currentMinuteActiveSeconds dosáhne 60 (přesně 1 minuta aktivního čtení):
        if (this.currentMinuteActiveSeconds >= 60) {
          const wordsInThisMinute = Math.max(0, Math.round(this.currentMinuteWords));
          const minuteNumber = this.completedMinutesCount;
          const elapsedSecAtMinuteEnd = minuteNumber * 60;

          this.intra_session_samples.push({
            minute: minuteNumber,
            elapsedSeconds: elapsedSecAtMinuteEnd,
            t: elapsedSecAtMinuteEnd,
            words: wordsInThisMinute,
            wpm: wordsInThisMinute // 1-minutový interval: přečtená slova v této minutě === WPM pro tuto minutu
          });

          this.currentMinuteIndex = minuteNumber;
          this.currentMinuteActiveSeconds = 0;
          this.currentMinuteWords = 0;
          this.wordsReadInCurrentMinute = 0;
          this.completedMinutesCount += 1;

          // Udržujeme sessionWordsRead přesně rovné součtu uzavřených minutových bucketů
          this.sessionWordsRead = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
        }

        const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
        this.activeTimeMs = totalActiveSeconds * 1000;
        this.wordsReadInCurrentMinute = this.currentMinuteWords;

        // Zaznamenáme postup aktivního čtení do klouzavého okna
        this.recordActiveProgress();

        // Synchronizace s denní statistikou v sekundách (po dosažení prahu 5 minut >= 300 sekund)
        if (totalActiveSeconds >= MIN_SESSION_DURATION_SEC) {
          const todayKey = getLocalDateKey();
          if (this.sessionDailySecondsCommitted === 0) {
            storage.addDailyReadingSeconds(todayKey, totalActiveSeconds);
            this.sessionDailySecondsCommitted = totalActiveSeconds;
          } else {
            const deltaCommitted = totalActiveSeconds - this.sessionDailySecondsCommitted;
            if (deltaCommitted > 0) {
              storage.addDailyReadingSeconds(todayKey, deltaCommitted);
              this.sessionDailySecondsCommitted = totalActiveSeconds;
            }
          }
        }

        const totalWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0)
          + Math.max(0, Math.round(this.currentMinuteWords));
        this.sessionWordsRead = totalWords;

        this.notifyListeners({
          type: "tick",
          activeSeconds: totalActiveSeconds,
          wpm: this.getCurrentWpm(),
          wordsRead: totalWords
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
    this.activeProgressHistory = (this.activeProgressHistory || []).filter(p => currentActiveMs - p.activeMs <= 60000);
    this.activeProgressHistory.push({ activeMs: currentActiveMs, words: currentWords });
  }

  /**
   * Spočítá klouzavé tempo čtení z okna reálného aktivního času
   */
  getRollingActivePace() {
    return this.getCurrentWpm();
  }

  /**
   * Aktualizuje pozici skrolování.
   * @param {number} scrollPercent 0.0 až 1.0
   */
  updateScrollProgress(scrollPercent) {
    this.recordActivity();
    const clamped = Math.max(0, Math.min(1, scrollPercent));
    this.currentScrollPercent = clamped;

    this.notifyListeners({
      type: "progress",
      scrollPercent: clamped,
      wordsRead: Math.round(this.sessionWordsRead),
      wpm: this.getCurrentWpm()
    });
  }

  /**
   * Spočítá průměrnou rychlost čtení (Words Per Minute) aktuální relace:
   * Striktně: duration >= 10 ? Math.round((words_read / duration) * 60) : 0.
   * Nikdy nepoužívá výchozí 220 WPM.
   */
  getCurrentWpm() {
    const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
    const totalWords = completedWords + Math.max(0, Math.round(this.currentMinuteWords));

    if (totalActiveSeconds >= 10 && totalWords > 0) {
      return Math.round((totalWords / totalActiveSeconds) * 60);
    }
    return 0;
  }

  /**
   * Odhadne zbývající čas v minutách pro UI odznak v patičce čtečky
   * @param {number} remainingWords 
   * @returns {number} minuty
   */
  getEstimatedMinutesRemaining(remainingWords) {
    const measuredWpm = this.getCurrentWpm();
    const paceForEstimate = measuredWpm >= MIN_VALID_WPM ? measuredWpm : 180;
    return Math.max(1, Math.ceil(remainingWords / paceForEstimate));
  }

  /**
   * Sestaví finální pole vzorků (včetně případné neuzavřené poslední minuty >= 20s bez extrapolace) a sjednocené metriky
   */
  _buildSessionMetrics(totalActiveSeconds) {
    const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
    const partialWords = Math.max(0, Math.round(this.currentMinuteWords));
    const wordsRead = completedWords + partialWords;

    const samples = this.intra_session_samples.map(s => ({ ...s }));

    // Trailing neúplná minuta (aktivní sekundy v aktuální minutě < 60):
    // Pokud active seconds < 20, NEPŘIPOJUJEME samostatný bod grafu.
    // Slova a sekundy jsou plně započteny v wordsRead (totalWords) a totalActiveSeconds (durationSeconds).
    // Pokud active seconds >= 20:
    // Bod zaznamenáme BEZ extrapolace (* 60 / partialSeconds).
    if (this.currentMinuteActiveSeconds >= 20) {
      const partialMinuteWords = Math.round(this.currentMinuteWords);
      const completedMinutesCount = this.intra_session_samples.filter(s => !s.isPartial).length;
      samples.push({
        minute: completedMinutesCount + 1,
        elapsedSeconds: totalActiveSeconds,
        t: totalActiveSeconds,
        words: partialMinuteWords,
        wpm: partialMinuteWords, // Skutečná slova připsaná v tomto koncovém minutovém bucketu bez násobitele
        isPartial: true
      });
    }

    const avgWpm = totalActiveSeconds >= 10 ? Math.round((wordsRead / totalActiveSeconds) * 60) : 0;
    const fullMinuteSamples = samples.filter(s => !s.isPartial);
    const peakWpm = fullMinuteSamples.length > 0
      ? Math.max(...fullMinuteSamples.map(s => Number(s.wpm) || 0))
      : avgWpm;

    return {
      wordsRead,
      durationSeconds: totalActiveSeconds,
      avgWpm,
      peakWpm,
      samples
    };
  }

  /**
   * Poskytne snímek právě probíhající živé relace pro okamžité zobrazení v UI modálu statistik
   */
  getCurrentSessionSnapshot() {
    const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    if (!this.currentBookId || (totalActiveSeconds < 15 && this.intra_session_samples.length === 0)) return null;

    const { wordsRead, avgWpm, peakWpm, samples } = this._buildSessionMetrics(totalActiveSeconds);

    return {
      sessionId: this.currentSessionId || "session_current",
      id: this.currentSessionId || "session_current",
      bookId: this.currentBookId,
      bookTitle: this.currentBookTitle || "Aktuální kniha",
      chapterIndex: this.currentChapterIndex,
      startTime: this.sessionStartTime || new Date(Date.now() - totalActiveSeconds * 1000).toISOString(),
      endTime: null,
      durationSeconds: totalActiveSeconds,
      activeSeconds: totalActiveSeconds,
      duration: totalActiveSeconds,
      wordsRead: wordsRead,
      words_read: wordsRead,
      totalWords: wordsRead,
      avgWpm: avgWpm,
      avg_wpm: avgWpm,
      peakWpm: peakWpm,
      peak_wpm: peakWpm,
      wpm: avgWpm,
      intra_session_samples: samples,
      intraSessionSamples: samples,
      timelineSamples: samples,
      isLive: true,
      date: getLocalDateKey(this.sessionStartTimestamp || Date.now())
    };
  }

  /**
   * Uloží aktuální souvislou relaci do IndexedDB (reading_sessions) a aktualizuje knihu
   */
  async flushSession() {
    // Před uložením zhodnotíme zbývající slova na aktuálně otevřeném bloku
    this.commitCurrentBlockDwell(1);

    const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    const bookId = this.currentBookId;
    const bookTitle = this.currentBookTitle;
    const { wordsRead, avgWpm, peakWpm, samples } = this._buildSessionMetrics(totalActiveSeconds);

    // Ukládáme POUZE relace s aktivní dobou čtení alespoň 5 minut (>= 300 sekund)
    if (bookId && totalActiveSeconds >= MIN_SESSION_DURATION_SEC) {
      const now = Date.now();
      const endTime = new Date(now).toISOString();
      const dateKey = getLocalDateKey(this.sessionStartTimestamp || now);
      const sessionId = this.currentSessionId || `session_${now}_${Math.random().toString(36).substring(2, 9)}`;

      const sessionRecord = {
        sessionId: sessionId,
        id: sessionId,
        bookId: bookId,
        bookTitle: bookTitle,
        chapterIndex: this.currentChapterIndex,
        startTime: this.sessionStartTime || new Date(now - totalActiveSeconds * 1000).toISOString(),
        endTime: endTime,
        durationSeconds: totalActiveSeconds,
        activeSeconds: totalActiveSeconds,
        duration: totalActiveSeconds,
        wordsRead: wordsRead,
        words_read: wordsRead,
        totalWords: wordsRead,
        avgWpm: avgWpm,
        avg_wpm: avgWpm,
        peakWpm: peakWpm,
        peak_wpm: peakWpm,
        wpm: avgWpm,
        intra_session_samples: samples,
        intraSessionSamples: samples,
        timelineSamples: samples,
        date: dateKey,
        timestamp: now,
        updatedAt: new Date(now).toISOString()
      };

      try {
        const savedSession = await storage.saveReadingSession(sessionRecord);

        // Aktualizujeme data v knize
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
      // Relace trvala méně než 5 minut (< 300s): kompletně zahodit záznam relace
      if (totalActiveSeconds > 0) {
        console.log(`[LuminaTracker] Relace čtení byla zahozena (trvala ${totalActiveSeconds}s < 300s minimálního prahu).`);
      }
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
    this.wordsCreditedOnCurrentPage = 0;
    this.blockInterimWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    this.chapterAccumulatedWords = 0;
    this.chapterInitialScrollPercent = this.currentScrollPercent;
    this.currentMinuteActiveSeconds = 0;
    this.currentMinuteWords = 0;
    this.completedMinutesCount = 1;
    this.intra_session_samples = [];
    this.timelineSamples = this.intra_session_samples;
    this.intraSessionSamples = this.intra_session_samples;
    this.currentMinuteIndex = 0;
    this.wordsReadInCurrentMinute = 0;
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
   * Jednotný výpočet globálních statistik striktně ze součtu jednotlivých záznamů relací:
   * total_words_read = sum of words_read across all sessions
   * total_reading_seconds = sum of duration across all sessions
   * global_avg_wpm = total_reading_seconds > 0 ? Math.round((total_words_read / total_reading_seconds) * 60) : 0
   */
  static async computeGlobalStats(customSessions = null, customBooks = null) {
    const rawSessions = customSessions !== null ? customSessions : ((typeof storage !== "undefined" && storage.getAllReadingSessions) ? await storage.getAllReadingSessions() : []);
    const books = customBooks !== null ? customBooks : ((typeof storage !== "undefined" && storage.getAllBooks) ? await storage.getAllBooks() : []);

    // Filtrujeme striktně pouze relace s aktivní dobou čtení >= 5 minut (300 sekund)
    const sessions = (rawSessions || []).filter(s => {
      const sec = Math.max(0, Math.round(s.duration ?? s.durationSeconds ?? s.activeSeconds ?? 0));
      return sec >= MIN_SESSION_DURATION_SEC;
    });

    // Zahrnutí právě probíhající aktivní relace
    const liveSnapshot = (typeof tracker !== "undefined" && tracker) ? tracker.getCurrentSessionSnapshot() : null;
    const allSessions = [...sessions];
    if (liveSnapshot && liveSnapshot.duration > 0) {
      if (!allSessions.some(s => s.sessionId === liveSnapshot.sessionId || s.id === liveSnapshot.sessionId)) {
        allSessions.push(liveSnapshot);
      }
    }

    // Sjednocení metrik každé relace, aby nedocházelo k žádnému driftu
    allSessions.forEach(s => {
      const dur = Math.max(0, Math.round(s.duration ?? s.durationSeconds ?? s.activeSeconds ?? 0));
      const words = Math.max(0, Math.round(s.words_read ?? s.wordsRead ?? 0));
      const trueAvgWpm = dur >= 10 ? Math.round((words / dur) * 60) : 0;
      const samples = Array.isArray(s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
        ? (s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
        : [];
      const fullMinuteSamples = samples.filter(pt => !pt.isPartial);
      const sampleWpms = fullMinuteSamples.map(pt => Number(pt.wpm ?? pt.instantaneousWpm ?? 0)).filter(w => w > 0);
      const truePeakWpm = sampleWpms.length > 0 ? Math.max(...sampleWpms) : trueAvgWpm;

      s.duration = dur;
      s.durationSeconds = dur;
      s.activeSeconds = dur;
      s.words_read = words;
      s.wordsRead = words;
      s.avg_wpm = trueAvgWpm;
      s.avgWpm = trueAvgWpm;
      s.wpm = trueAvgWpm;
      s.peak_wpm = truePeakWpm;
      s.peakWpm = truePeakWpm;
    });

    // Seskupení relací do denních souhrnů (dailyMap) podle lokálního data
    const dailyMap = new Map();
    allSessions.forEach(s => {
      const dateStr = getLocalDateKey(s.date || s.startTime || s.timestamp || new Date());
      const sec = s.duration;
      const words = s.words_read;

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

    // Globální součty striktně ze součtu všech relací (uložených + aktuální aktivní)
    const total_reading_seconds = allSessions.reduce((sum, s) => sum + s.duration, 0);
    const total_words_read = allSessions.reduce((sum, s) => sum + s.words_read, 0);
    const global_avg_wpm = total_reading_seconds > 0 ? Math.round((total_words_read / total_reading_seconds) * 60) : 0;

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

    // Historie WPM: jeden bod pro každou platnou čtecí relaci v chronologickém pořadí s jejím skutečným přepočteným avg_wpm
    const chronologicalSessions = [...allSessions].sort((a, b) => {
      const ta = a.timestamp || (a.startTime ? new Date(a.startTime).getTime() : 0);
      const tb = b.timestamp || (b.startTime ? new Date(b.startTime).getTime() : 0);
      return ta - tb;
    });

    const wpmHistory = chronologicalSessions
      .filter(s => {
        const rawSpeed = s.avg_wpm ?? s.avgWpm ?? s.wpm ?? 0;
        const dur = s.duration ?? s.durationSeconds ?? s.activeSeconds ?? 0;
        return rawSpeed > 0 && rawSpeed <= MAX_VALID_WPM && dur >= MIN_SESSION_DURATION_SEC;
      })
      .slice(-20)
      .map((s, idx) => ({
        index: idx + 1,
        wpm: Math.round(s.avg_wpm ?? s.avgWpm ?? s.wpm),
        avg_wpm: Math.round(s.avg_wpm ?? s.avgWpm ?? s.wpm),
        wordsRead: s.words_read ?? s.wordsRead ?? 0,
        duration: s.duration ?? s.durationSeconds ?? 0,
        date: getLocalDateKey(s.date || s.startTime || s.timestamp),
        timestamp: s.timestamp || (s.startTime ? new Date(s.startTime).getTime() : null),
        startTime: s.startTime,
        bookTitle: s.bookTitle || "Kniha"
      }));

    return {
      totalTimeFormatted: ReadingTracker.formatDuration(total_reading_seconds),
      totalSeconds: total_reading_seconds,
      totalActiveTime: total_reading_seconds,
      total_reading_seconds,
      totalWords: total_words_read,
      total_words_read,
      averageWpm: global_avg_wpm,
      avgWpm: global_avg_wpm,
      global_avg_wpm,
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
