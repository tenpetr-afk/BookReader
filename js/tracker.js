/**
 * tracker.js - Inteligentní měřič aktivity a rychlosti čtení (WPM).
 * Zjišťuje reálný aktivní čas (pauza při nečinnosti), počítá slova,
 * odhaduje zbývající čas a ukládá detailní čtecí relace s časovou osou WPM.
 */

import { storage } from "./storage.js?v=2.6.1";

export const MIN_VALID_WPM = 40;
export const MAX_VALID_WPM = 650;
export const MAX_SUSTAINED_PAGE_WPM = 450;
export const DEFAULT_NORMAL_WPM = 0;
export const MIN_SESSION_DURATION_SEC = 300; // Minimální délka relace pro uložení (5 minut)
export const DEFAULT_IDLE_TIMEOUT_MS = 90000; // 90 sekund bez interakce = pauza čtení (konfigurovatelné 30–60s)
const IDLE_GRACE_READING_SEC = 30; // Po kolika sekundách ticha před idle pauzou se odečte mrtvý ocas nečinnosti
const MIN_PAGE_DWELL_SEC = 3.0; // Minimální aktivní doba na stránce (ochrana proti rychlému přeskakování stran)

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

const IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
const SESSION_ABANDON_TIMEOUT_MS = 900000; // 15 minut nečinnosti = automatické uložení relace

export class ReadingTracker {
  constructor() {
    this.currentBookId = null;
    this.currentBookTitle = "";
    this.currentChapterIndex = 0;
    this.currentChapterWords = 0;
    
    // Stav aktivity čtečky a konfigurovatelný práh nečinnosti (30–60 s)
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.isActive = false;
    this.isIdle = false;
    this.activeTimeMs = 0;
    this.lastActivityTime = Date.now();
    this.lastReadingProgressTime = Date.now();
    this.lastDirectAttributionTime = 0;
    this.lastTickTime = Date.now();
    this.timerInterval = null;
    this.unverifiedSilenceSeconds = 0;
    this.unverifiedSilenceInterimWords = 0;
    this.currentPageActiveSeconds = 0;

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

    // Sledování čtení na úrovni bloků a deduplikace pravítka vs. otáčení stran vs. vertikální scroll
    this.creditedBlocks = new Set(); // Množina klíčů bloků již akreditovaných pro danou knihu
    this.creditedLines = new Set(); // Množina klíčů řádků již akreditovaných pro danou knihu
    this.creditedWords = new Set(); // Množina klíčů slov již akreditovaných pro danou knihu
    this.chapterHighWaterScroll = new Map(); // chapterIndex -> maxScrollRatio
    this.highWaterMark = null; // { chapterIndex, pageIndex, lineIndex, wordIndex, scrollRatio }

    // Paměť deduplikace a high-water marku per kniha
    this._bookCreditedBlocks = new Map();
    this._bookCreditedLines = new Map();
    this._bookCreditedWords = new Map();
    this._bookChapterScroll = new Map();
    this._bookHighWaterMarks = new Map();

    this.currentReadingBlockId = null; // e.g. `${bookId}_ch${chapterIndex}_p${pageIndex}`
    this.blockEnterTimestamp = null; // Čas příchodu na aktuální blok
    this.blockEnterActiveSec = 0; // Aktivní sekundy při vstupu na blok
    this.blockVisibleWords = 0; // Viditelná slova na aktuálním bloku (pouze viewport)
    this.wordsCreditedOnCurrentPage = 0; // Slova již započtená na aktuální stránce (pravítkem nebo průběžně)
    this.blockDirectWordsAttributed = 0; // Slova přímo započtená pravítkem na aktuální stránce
    this.blockInterimWordsAttributed = 0; // Průběžně odhadovaná slova na bloku
    this.unreconciledRulerWords = 0; // Slova započtená pravítkem čekající na deduplikaci při vertikálním scrollu
    this.isContinuousTrackingActive = false; // Příznak, zda pro blok probíhá kontinuální přičítání (pravítko / scroll)
    
    // Zpětná kompatibilita pro stávající reference
    this.committedPageKeys = this.creditedBlocks;
    this.currentPageKey = null;
    this.pageEnterTimestamp = null;
    this.currentPageVisibleWords = 0;
    
    // Režimy pravítka a sledování slov
    this.rulerEnabled = !!this.rulerEnabled;
    this.rulerMode = this.rulerMode || "line";
    this.noRulerTotalWords = 0;

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

  /**
   * Nastaví práh nečinnosti (v milisekundách, bezpečně oříznutý na 15–120 sekund).
   */
  setIdleTimeout(timeoutMs) {
    const num = Number(timeoutMs);
    if (Number.isFinite(num) && num >= 15000 && num <= 120000) {
      this.idleTimeoutMs = Math.round(num);
    }
  }

  _getOrCreateSet(map, key) {
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    return map.get(key);
  }

  _getOrCreateMap(map, key) {
    if (!map.has(key)) {
      map.set(key, new Map());
    }
    return map.get(key);
  }

  /**
   * Inicializuje nebo přepne perzistentní postup a množiny akreditovaných bloků/řádků pro konkrétní knihu.
   */
  initBookProgress(bookId, bookData = null) {
    if (!bookId) return;
    this.creditedBlocks = new Set();
    this.creditedLines = new Set();
    this.creditedWords = new Set();
    this.chapterHighWaterScroll = this._getOrCreateMap(this._bookChapterScroll, bookId);
    this.committedPageKeys = this.creditedBlocks;

    if (!this._bookHighWaterMarks.has(bookId)) {
      if (bookData?.highWaterMark) {
        this.highWaterMark = { ...bookData.highWaterMark };
      } else if (bookData && (bookData.currentChapterIndex > 0 || bookData.currentPageIndex > 0 || bookData.wordsRead > 0)) {
        this.highWaterMark = {
          chapterIndex: bookData.currentChapterIndex || 0,
          pageIndex: bookData.currentPageIndex || 0,
          lineIndex: -1,
          wordIndex: -1,
          scrollRatio: bookData.scrollPercent || 0
        };
      } else {
        this.highWaterMark = null;
      }
      this._bookHighWaterMarks.set(bookId, this.highWaterMark);
    } else {
      this.highWaterMark = this._bookHighWaterMarks.get(bookId);
    }
  }

  /**
   * Resetuje perzistentní postup pro konkrétní knihu (např. při resetu statistik).
   */
  resetBookProgress(bookId) {
    if (!bookId) return;
    this._bookCreditedBlocks.delete(bookId);
    this._bookCreditedLines.delete(bookId);
    this._bookCreditedWords.delete(bookId);
    this._bookChapterScroll.delete(bookId);
    this._bookHighWaterMarks.delete(bookId);
    if (this.currentBookId === bookId) {
      this.creditedBlocks = new Set();
      this.creditedLines = new Set();
      this.creditedWords = new Set();
      this.chapterHighWaterScroll = new Map();
      this.highWaterMark = null;
      this.committedPageKeys = this.creditedBlocks;
    }
  }

  /**
   * Porovná dvě čtecí pozice v dokumentu:
   * Vrací < 0 pokud posA < posB, 0 pokud posA == posB, > 0 pokud posA > posB.
   */
  comparePositions(posA, posB) {
    if (!posA && !posB) return 0;
    if (!posA) return -1;
    if (!posB) return 1;

    const chA = Number(posA.chapterIndex ?? 0);
    const chB = Number(posB.chapterIndex ?? 0);
    if (chA !== chB) {
      return chA - chB;
    }

    // Shodná kapitola: zkontrolujeme pageIndex
    const pgA = Number(posA.pageIndex ?? 0);
    const pgB = Number(posB.pageIndex ?? 0);
    if (pgA !== pgB) {
      return pgA - pgB;
    }

    // Shodná stránka: zkontrolujeme lineIndex
    const lnA = Number(posA.lineIndex ?? -1);
    const lnB = Number(posB.lineIndex ?? -1);
    if (lnA !== lnB) {
      return lnA - lnB;
    }

    // Shodný řádek: zkontrolujeme wordIndex
    const wdA = Number(posA.wordIndex ?? -1);
    const wdB = Number(posB.wordIndex ?? -1);
    if (wdA !== wdB) {
      return wdA - wdB;
    }

    // Vertikální mód nebo kontinuální posuvník: zkontrolujeme scrollRatio
    const hasRatioA = typeof posA.scrollRatio === "number" && !isNaN(posA.scrollRatio);
    const hasRatioB = typeof posB.scrollRatio === "number" && !isNaN(posB.scrollRatio);
    if (hasRatioA && hasRatioB) {
      const diff = posA.scrollRatio - posB.scrollRatio;
      if (Math.abs(diff) > 0.005) {
        return diff > 0 ? 1 : -1;
      }
    }

    return 0;
  }

  /**
   * Zjistí, zda se zadaná pozice nachází za high-water markem (již dříve přečtený text).
   */
  _isBehindHighWaterMark(pos) {
    if (!this.highWaterMark || !pos) return false;
    return this.comparePositions(pos, this.highWaterMark) <= 0;
  }

  /**
   * Zjistí, zda je celý zadaný blok/stránka za high-water markem.
   */
  _isBlockBehindHighWaterMark(blockId, chapterIndex, pageIndex) {
    if (!this.highWaterMark) return false;
    const ch = chapterIndex ?? this.currentChapterIndex ?? 0;
    const pg = pageIndex ?? 0;
    if (ch < this.highWaterMark.chapterIndex) return true;
    if (ch === this.highWaterMark.chapterIndex) {
      if (this.highWaterMark.pageIndex !== undefined && pg < this.highWaterMark.pageIndex) {
        return true;
      }
    }
    return false;
  }

  /**
   * Posune dopředný high-water mark na novou pozici, pokud je vyšší než stávající.
   */
  _advanceHighWaterMark(pos) {
    if (!pos) return;
    if (!this.highWaterMark || this.comparePositions(pos, this.highWaterMark) > 0) {
      this.highWaterMark = {
        chapterIndex: pos.chapterIndex ?? this.currentChapterIndex ?? 0,
        pageIndex: pos.pageIndex ?? 0,
        lineIndex: pos.lineIndex ?? -1,
        wordIndex: pos.wordIndex ?? -1,
        scrollRatio: pos.scrollRatio ?? this.currentScrollPercent ?? 0
      };
      if (this.currentBookId) {
        this._bookHighWaterMarks.set(this.currentBookId, this.highWaterMark);
      }
      if (typeof pos.scrollRatio === "number") {
        const ch = pos.chapterIndex ?? this.currentChapterIndex ?? 0;
        const curMax = this.chapterHighWaterScroll.get(ch) || 0;
        if (pos.scrollRatio > curMax) {
          this.chapterHighWaterScroll.set(ch, pos.scrollRatio);
        }
      }
    }
  }

  _isReaderActivelyVisible() {
    if (typeof document === "undefined") return true;
    if (document.visibilityState === "hidden") return false;
    const statsModal = document.getElementById("stats-modal");
    if (statsModal && statsModal.classList.contains("open")) return false;
    const viewReader = document.getElementById("view-reader");
    if (viewReader && viewReader.classList.contains("is-hidden")) return false;
    const settingsDrawer = document.getElementById("settings-drawer");
    if (settingsDrawer && settingsDrawer.classList.contains("open")) return false;
    const tocDrawer = document.getElementById("toc-drawer");
    if (tocDrawer && tocDrawer.classList.contains("open")) return false;
    const searchDrawer = document.getElementById("search-drawer");
    if (searchDrawer && searchDrawer.classList.contains("open")) return false;
    return true;
  }

  initActivityListeners() {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const onUserAction = (e) => {
      if (!this._isReaderActivelyVisible()) return;
      if (e && e.target && typeof e.target.closest === "function") {
        if (e.target.closest("#stats-modal, #settings-drawer, #toc-drawer, #search-drawer")) {
          return;
        }
      }
      this.recordActivity();
    };

    window.addEventListener("scroll", onUserAction, { passive: true, capture: true });
    window.addEventListener("mousemove", onUserAction, { passive: true });
    window.addEventListener("pointermove", onUserAction, { passive: true });
    window.addEventListener("pointerdown", onUserAction, { passive: true });
    window.addEventListener("keydown", onUserAction, { passive: true });
    window.addEventListener("touchstart", onUserAction, { passive: true });
    window.addEventListener("touchmove", onUserAction, { passive: true });
    window.addEventListener("click", onUserAction, { passive: true });
    window.addEventListener("wheel", onUserAction, { passive: true });

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
  recordActivity(isReadingProgress = false) {
    const now = Date.now();
    this.lastActivityTime = now;
    if (isReadingProgress) {
      this.lastReadingProgressTime = now;
    }
    this.unverifiedSilenceSeconds = 0;
    this.unverifiedSilenceInterimWords = 0;

    if (this.isIdle) {
      this.isIdle = false;
      this.lastTickTime = now;
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
   * Odečte neověřené mrtvé sekundy (např. při přechodu do idle nebo při přeskočení stránky < 3s),
   * aby nečinnost ani skimming nenaředily aktivní čtecí čas a nevytvářely 0 WPM propady.
   */
  _rewindActiveSeconds(secondsToRewind) {
    const sec = Math.max(0, Math.round(secondsToRewind || 0));
    if (sec <= 0) return;
    if (this.currentMinuteActiveSeconds >= sec) {
      this.currentMinuteActiveSeconds -= sec;
    } else {
      this.currentMinuteActiveSeconds = 0;
    }
    this.currentPageActiveSeconds = Math.max(0, this.currentPageActiveSeconds - sec);
    const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    this.activeTimeMs = totalActiveSeconds * 1000;
  }

  /**
   * Zruší měření aktuální stránky bez započtení dwell time a slov
   * (při TOC skoku, posuvníku, vyhledávání, změně velikosti písma, okrajů).
   */
  cancelCurrentPageDwell() {
    if (this.blockInterimWordsAttributed > 0) {
      const rollback = this.blockInterimWordsAttributed;
      this.sessionWordsRead = Math.max(0, this.sessionWordsRead - rollback);
      this.currentMinuteWords = Math.max(0, this.currentMinuteWords - rollback);
      this.wordsReadInCurrentMinute = this.currentMinuteWords;
    }
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentReadingBlockId = null;
    this.currentPageKey = null;
    this.blockVisibleWords = 0;
    this.currentPageVisibleWords = 0;
    this.blockEnterActiveSec = 0;
    this.currentPageActiveSeconds = 0;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockDirectWordsAttributed = 0;
    this.blockInterimWordsAttributed = 0;
    this.unverifiedSilenceInterimWords = 0;
    this.isContinuousTrackingActive = false;
  }

  /**
   * Nastaví stav pravítka (zapnuto/vypnuto) a jeho režim (line, word)
   */
  setRulerState(enabled, mode = "line") {
    const prevEnabled = this.rulerEnabled;
    this.rulerEnabled = !!enabled;
    if (["line", "word"].includes(mode)) {
      this.rulerMode = mode;
    }
    if (prevEnabled !== this.rulerEnabled) {
      const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
      const currentTotal = completedWords + Math.max(0, Math.round(this.currentMinuteWords));
      this.noRulerTotalWords = Math.max(this.noRulerTotalWords || 0, currentTotal);
      this.sessionWordsRead = Math.max(this.noRulerTotalWords, currentTotal);
    }
  }

  /**
   * Režim slovo za slovem (Word-by-word mode):
   * Započítává přesně tolik slov, přes kolik pravítko přejede.
   * Načtená slova se přičítají do aktuálního minutového bucketu (započítání 1x za minutu).
   * Automaticky deduplikuje slova v rámci probíhající čtecí relace.
   * @param {number} count Počet přejetých slov
   * @param {Object|null} context Kontext pozice: { bookId, chapterIndex, pageIndex, lineIndex, wordIndex, wordKey, blockKey }
   * @returns {number} Počet skutečně započtených nových slov
   */
  recordWordByWord(count, context = null) {
    if (!this.isActive || !count || count <= 0) return 0;
    // Vždy zaznamenáme aktivitu uživatele – čas čtení běží dál i při opětovném čtení
    this.recordActivity(true);

    if (context) {
      const bookId = context.bookId || this.currentBookId;
      const chIdx = context.chapterIndex ?? this.currentChapterIndex ?? 0;
      const pgIdx = context.pageIndex ?? 0;
      const lnIdx = context.lineIndex ?? -1;
      const wdIdx = context.wordIndex ?? -1;
      const wordKey = context.wordKey || `${bookId}_ch${chIdx}_p${pgIdx}_l${lnIdx}_w${wdIdx}`;
      const blockKey = context.blockKey || `${bookId}_ch${chIdx}_p${pgIdx}`;

      if (!this.creditedWords) this.creditedWords = new Set();
      if (!this.creditedBlocks) this.creditedBlocks = new Set();

      // Deduplikace v rámci aktuální relace
      if (this.creditedWords.has(wordKey)) {
        return 0; // Potlačeno: již přečteno v této relaci
      }

      this.creditedWords.add(wordKey);
      this.creditedBlocks.add(blockKey);

      const pos = { chapterIndex: chIdx, pageIndex: pgIdx, lineIndex: lnIdx, wordIndex: wdIdx };
      this._advanceHighWaterMark(pos);
    }

    const n = Math.max(0, Math.round(count));
    this.currentMinuteWords += n;
    this.wordsCreditedOnCurrentPage = (this.wordsCreditedOnCurrentPage || 0) + n;
    return n;
  }

  /**
   * Řádkový režim (Line mode):
   * Započítává slova řádek po řádku – při přepnutí na další řádek se započítá předchozí řádek.
   * Aktuálně čtený řádek se započte po dokončení čtení řádku.
   * Automaticky deduplikuje řádky v rámci probíhající čtecí relace.
   * @param {number} count Počet slov na dokončeném řádku
   * @param {Object|null} context Kontext pozice: { bookId, chapterIndex, pageIndex, lineIndex, lineKey, blockKey }
   * @returns {number} Počet skutečně započtených nových slov
   */
  recordLineCompleted(count, context = null) {
    if (!this.isActive || !count || count <= 0) return 0;
    // Vždy zaznamenáme aktivitu uživatele – čas čtení běží dál i při opětovném čtení
    this.recordActivity(true);

    if (context) {
      const bookId = context.bookId || this.currentBookId;
      const chIdx = context.chapterIndex ?? this.currentChapterIndex ?? 0;
      const pgIdx = context.pageIndex ?? 0;
      const lnIdx = context.lineIndex ?? -1;
      const lineKey = context.lineKey || `${bookId}_ch${chIdx}_p${pgIdx}_l${lnIdx}`;
      const blockKey = context.blockKey || `${bookId}_ch${chIdx}_p${pgIdx}`;

      if (!this.creditedLines) this.creditedLines = new Set();
      if (!this.creditedBlocks) this.creditedBlocks = new Set();

      // Deduplikace v rámci aktuální relace: byl tento řádek již v této relaci akreditován?
      if (this.creditedLines.has(lineKey)) {
        return 0; // Již započteno v této relaci
      }

      this.creditedLines.add(lineKey);
      this.creditedBlocks.add(blockKey);

      const pos = { chapterIndex: chIdx, pageIndex: pgIdx, lineIndex: lnIdx };
      this._advanceHighWaterMark(pos);
    }

    const n = Math.max(0, Math.round(count));
    this.currentMinuteWords += n;
    this.wordsCreditedOnCurrentPage = (this.wordsCreditedOnCurrentPage || 0) + n;
    return n;
  }

  /**
   * Generické započtení slov (kompatibilita)
   * @param {number} count Počet přečtených slov
   * @param {Object|null} context Kontext pozice
   * @returns {number}
   */
  attributeWords(count, context = null) {
    if (!this.isActive || !count || count <= 0) return 0;
    this.recordActivity(true);

    const n = Math.max(0, Math.round(count));
    this.currentMinuteWords += n;
    this.noRulerTotalWords += n;
    return n;
  }

  /**
   * Přičte slova posunutá při vertikálním skrolování (pouze když není aktivní pravítko).
   * Automaticky potlačuje přičítání při scrollování nahoru nebo přes již odscrollovaný rozsah.
   * @param {number} count Počet odskrolovaných slov
   * @param {Object|null} context { chapterIndex, scrollRatio, deltaRatio, bookId }
   * @returns {number}
   */
  attributeScrollWords(count, context = null) {
    if (!this.isActive || !count || count <= 0) return 0;
    this.recordActivity(true);

    // Pokud je aktivní pravítko, slova se měří výhradně pravítkem (ochrana proti double-countingu)
    if (this.rulerEnabled) {
      return 0;
    }

    if (context && typeof context.chapterIndex === "number" && typeof context.scrollRatio === "number") {
      const chIdx = context.chapterIndex;
      const scrollRatio = context.scrollRatio;
      const prevMax = this.chapterHighWaterScroll.get(chIdx) || 0;

      // Scrollování nahoru nebo v rámci již přečteného rozsahu v kapitole:
      if (scrollRatio <= prevMax) {
        return 0; // Potlačeno
      }

      // Celá předchozí kapitola za celkovým high-water markem:
      if (this.highWaterMark && chIdx < this.highWaterMark.chapterIndex) {
        return 0; // Potlačeno
      }

      this.chapterHighWaterScroll.set(chIdx, scrollRatio);
      this._advanceHighWaterMark({ chapterIndex: chIdx, scrollRatio });
    }

    const n = Math.max(0, Math.round(count));
    this.currentMinuteWords += n;
    this.noRulerTotalWords += n;
    return n;
  }

  /**
   * tickPageProgress zachován jako no-op pro zamezení umělého generování fiktivních slov
   */
  tickPageProgress(deltaSec) {
    // Fiktivní slova již negenerujeme – počítání probíhá striktně podle reálně přečtených slov/řádků
  }

  /**
   * Pomocná metoda pro bezpečné odečtení neověřených slov (např. při přeskočení stránky < 3s).
   * Odečítá pouze z aktuální stránky, nikdy nemaže dříve dokončené stránky.
   */
  _rollbackUnverifiedWords(wordsToRollback) {
    const amount = Math.max(0, wordsToRollback || 0);
    if (amount <= 0) return;

    this.sessionWordsRead = Math.max(0, this.sessionWordsRead - amount);
    this.noRulerTotalWords = Math.max(0, this.noRulerTotalWords - amount);
    if (this.currentMinuteWords >= amount) {
      this.currentMinuteWords -= amount;
    } else {
      let rem = amount - this.currentMinuteWords;
      this.currentMinuteWords = 0;
      for (let i = this.intra_session_samples.length - 1; i >= 0 && rem > 0; i--) {
        const s = this.intra_session_samples[i];
        const take = Math.min(rem, s.words || 0);
        s.words = Math.max(0, (s.words || 0) - take);
        s.wpm = s.words;
        rem -= take;
      }
    }
    this.wordsReadInCurrentMinute = this.currentMinuteWords;
  }

  /**
   * Při otočení stránky vpřed (nextPage) nebo ukončení bloku dopočítá zbývající nezapočtená slova:
   * remainingUncreditedWords = Math.max(0, maxCreditedForDwell - wordsCreditedOnCurrentPage),
   * pokud uživatel strávil na stránce realistickou minimální dobu (>= 3 sekundy).
   * Ignoruje rychlé přeskakování stránek (< 3s) a nikdy nemaže již přečtená slova po dlouhé pauze.
   */
  commitCurrentBlockDwell(direction = 1, visibleWordsOverride = null, isFlushing = false) {
    const blockId = this.currentReadingBlockId;
    const enterTime = this.blockEnterTimestamp || this.pageEnterTimestamp || this.currentPageStartTime;
    const now = Date.now();

    const rawWords = (visibleWordsOverride !== null && visibleWordsOverride !== undefined)
      ? visibleWordsOverride
      : (this.blockVisibleWords || 250);
    const wordsOnPage = Math.max(0, Math.min(MAX_VALID_WPM, Math.round(rawWords)));
    const creditedSoFarExact = Math.max(0, this.wordsCreditedOnCurrentPage || 0);
    const creditedSoFar = Math.max(0, Math.round(creditedSoFarExact));
    const interimAttributed = Math.max(0, this.blockInterimWordsAttributed || 0);
    const startActiveSec = (this.blockEnterActiveSec !== null && this.blockEnterActiveSec !== undefined)
      ? this.blockEnterActiveSec
      : 0;
    const pageActiveSec = this.currentPageActiveSeconds || 0;

    // Reset stavu stránky
    this.blockEnterTimestamp = null;
    this.pageEnterTimestamp = null;
    this.currentPageStartTime = null;
    this.currentReadingBlockId = null;
    this.currentPageActiveSeconds = 0;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockDirectWordsAttributed = 0;
    this.blockInterimWordsAttributed = 0;
    this.unverifiedSilenceInterimWords = 0;
    this.unreconciledRulerWords = 0;
    this.isContinuousTrackingActive = false;

    if (!blockId || !enterTime || wordsOnPage <= 0) return 0;

    // Pokud je aktivní pravítko, slova se počítají výhradně podle zvoleného režimu pravítka (slovní, řádkový)
    if (this.rulerEnabled) {
      return 0;
    }

    const wallDwellSeconds = Math.max(0, (now - enterTime) / 1000);
    const currentTotalActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    const activeDwellSeconds = Math.max(pageActiveSec, Math.max(0, currentTotalActiveSec - startActiveSec));
    const effectiveDwellSeconds = activeDwellSeconds > 0
      ? Math.max(activeDwellSeconds, Math.min(wallDwellSeconds, 12))
      : (wallDwellSeconds < 60 ? wallDwellSeconds : 0);

    // 1. Ochrana proti rychlému skimmingu (< 3s) a listování zpět:
    if (effectiveDwellSeconds < MIN_PAGE_DWELL_SEC || direction < 0 || isFlushing) {
      return 0;
    }

    // 2. Bez pravítka se načte celá stránka, pokud na ní uživatel strávil realistický čas (>= 3s):
    if (this.creditedBlocks && this.creditedBlocks.has(blockId)) {
      return 0; // Již v této relaci přečteno a započteno
    }

    // Dopředný postup do nepřečteného bloku (odečteme případná dílčí slova již započtená pravítkem na této straně)
    const wordsToAdd = Math.max(0, wordsOnPage - creditedSoFar);
    if (this.creditedBlocks) {
      this.creditedBlocks.add(blockId);
    }
    this._advanceHighWaterMark({ chapterIndex: this.currentChapterIndex, pageIndex: this.currentPageIndex, lineIndex: 9999 });

    if (wordsToAdd > 0) {
      this.currentMinuteWords += wordsToAdd;
      this.noRulerTotalWords += wordsToAdd;
    }
    return wordsToAdd;
  }

  // Alias pro zpětnou kompatibilitu
  commitCurrentPageDwell(direction = 1, visibleWordsOverride = null, isFlushing = false) {
    return this.commitCurrentBlockDwell(direction, visibleWordsOverride, isFlushing);
  }

  /**
   * Zaznamená přechod na novou stránku / sloupec.
   * Vyhodnotí dwell time na předchozí stránce a zahájí sledování nové stránky.
   * Nikdy nepřičítá slova při reflow (resize, font, okraje), navigaci ani při počátečním načtení dokumentu.
   * @param {Object} pageInfo { bookId, bookTitle, chapterIndex, pageIndex, visibleWords, isReflow, isInitialLoad, isNavigationJump, bookData }
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

    // Pokud uživatel změnil knihu, nejprve uložíme běžící relaci a inicializujeme postup nové knihy
    if (this.currentBookId !== bookId) {
      this.flushSession();
      this.currentBookId = bookId;
      this.currentBookTitle = title;
      this.initBookProgress(bookId, pageInfo.bookData || null);
      this.startNewContiguousSession(chapterIndex, visibleWords, 0);
    }

    const newBlockId = `${bookId}_ch${chapterIndex}_p${pageIndex}`;

    // Pokud jde o reflow (resize okna, font, okraje, sloupce, donačtení obrázku) nebo skok navigace:
    // Nikdy nepřičítáme slova a resetujeme sledovač nové stránky
    if (isReflow || isNavigationJump) {
      // Pokud jde o reflow na stejné stránce (např. donačtení obrázku nebo změna velikosti okna),
      // pouze zaktualizujeme počet viditelných slov, ale NEMAŽEME průběžný dwell a již započtená slova!
      if (isReflow && newBlockId === this.currentReadingBlockId) {
        if (visibleWords > 0) {
          this.blockVisibleWords = visibleWords;
          this.currentPageVisibleWords = visibleWords;
        }
        return;
      }
      this.cancelCurrentPageDwell();
      this.currentReadingBlockId = newBlockId;
      this.currentPageKey = newBlockId;
      const now = Date.now();
      this.blockEnterTimestamp = now;
      this.pageEnterTimestamp = now;
      this.blockEnterActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
      this.currentPageActiveSeconds = 0;
      const effectiveWords = visibleWords > 0 ? visibleWords : 250;
      this.blockVisibleWords = effectiveWords;
      this.currentPageVisibleWords = effectiveWords;
      this.wordsCreditedOnCurrentPage = 0;
      this.blockDirectWordsAttributed = 0;
      this.blockInterimWordsAttributed = 0;
      this.isContinuousTrackingActive = false;
      this.currentChapterIndex = chapterIndex;
      this.currentPageIndex = pageIndex;
      return;
    }

    // Pokud jde o prvotní načtení knihy / kapitoly (document load):
    // Okamžitě inicializujeme čtecí blok pro plynulou aktivitu od první sekundy
    if (isInitialLoad) {
      this.cancelCurrentPageDwell();
      this.currentReadingBlockId = newBlockId;
      this.currentPageKey = newBlockId;
      const now = Date.now();
      this.blockEnterTimestamp = now;
      this.pageEnterTimestamp = now;
      this.blockEnterActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
      this.currentPageActiveSeconds = 0;
      const effectiveWords = visibleWords > 0 ? visibleWords : 250;
      this.blockVisibleWords = effectiveWords;
      this.currentPageVisibleWords = effectiveWords;
      this.wordsCreditedOnCurrentPage = 0;
      this.blockDirectWordsAttributed = 0;
      this.blockInterimWordsAttributed = 0;
      this.isContinuousTrackingActive = false;
      this.currentChapterIndex = chapterIndex;
      this.currentPageIndex = pageIndex;
      this.recordActivity(true);
      return;
    }

    // Pokud jde o tutéž stránku (např. opakované hlášení bez posunu):
    if (newBlockId === this.currentReadingBlockId) {
      if (visibleWords > 0) {
        this.blockVisibleWords = visibleWords;
        this.currentPageVisibleWords = visibleWords;
      }
      return;
    }

    // Uživatel skutečně opouští předchozí stránku -> vyhodnotit zbývající slova
    if (this.currentReadingBlockId && !isVerticalScroll) {
      this.commitCurrentBlockDwell(direction);
    } else if (isVerticalScroll) {
      this.currentPageActiveSeconds = 0;
      this.wordsCreditedOnCurrentPage = 0;
      this.blockDirectWordsAttributed = 0;
      this.blockInterimWordsAttributed = 0;
    }

    // Vstup na nový čtecí blok
    this.currentReadingBlockId = newBlockId;
    this.currentPageKey = newBlockId;
    const now = Date.now();
    this.blockEnterTimestamp = now;
    this.pageEnterTimestamp = now;
    this.blockEnterActiveSec = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    this.currentPageActiveSeconds = 0;
    const effectiveVisibleWords = visibleWords > 0 ? visibleWords : 250;
    this.blockVisibleWords = effectiveVisibleWords;
    this.currentPageVisibleWords = effectiveVisibleWords;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockDirectWordsAttributed = 0;
    this.isContinuousTrackingActive = false;
    this.blockInterimWordsAttributed = 0;
    this.currentChapterIndex = chapterIndex;
    this.currentPageIndex = pageIndex;
    this.recordActivity(true);

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
      this.initBookProgress(bookId);
      this.startNewContiguousSession(resolvedIndex, resolvedWords, resolvedScroll);
    } else {
      // Stejná kniha (např. přechod mezi kapitolami v rámci jedné souvislé relace)
      if (this.currentSessionId) {
        this.currentChapterIndex = resolvedIndex;
        this.currentChapterWords = resolvedWords || 1;
        this.currentScrollPercent = resolvedScroll;
        this.recordActivity(true);
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
    this.currentPageIndex = 0;
    this.currentChapterWords = chapterWords || 1;
    this.chapterInitialScrollPercent = scrollPercent;
    this.currentScrollPercent = scrollPercent;
    this.isIdle = false;
    this.isActive = true;
    this.lastActivityTime = now;
    this.lastReadingProgressTime = now;
    this.lastDirectAttributionTime = 0;
    this.lastTickTime = now;
    this.unverifiedSilenceSeconds = 0;
    this.unverifiedSilenceInterimWords = 0;
    this.currentPageActiveSeconds = 0;

    // Reset vážených měřičů čtení
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;

    // Sledování stránek a dwell time: bezpečně inicializujeme počáteční blok, aby ticker mohl začít okamžitě
    const initialWords = (chapterWords >= 40 && chapterWords <= 650) ? chapterWords : 250;
    const initialBlockId = this.currentBookId ? `${this.currentBookId}_ch${chapterIndex}_p0` : null;
    this.currentReadingBlockId = initialBlockId;
    this.currentPageKey = initialBlockId;
    this.blockEnterTimestamp = now;
    this.pageEnterTimestamp = now;
    this.blockEnterActiveSec = 0;
    this.blockVisibleWords = initialWords;
    this.currentPageVisibleWords = initialWords;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockDirectWordsAttributed = 0;
    this.blockInterimWordsAttributed = 0;
    this.unreconciledRulerWords = 0;
    this.isContinuousTrackingActive = false;

    // Reset akreditací v rámci nové čtecí relace (každá relace měří aktivitu čistě od 0)
    this.creditedLines = new Set();
    this.creditedWords = new Set();
    this.creditedBlocks = new Set();
    this.committedPageKeys = this.creditedBlocks;

    // Reset mezipaměti přečtených řádků/slov v pravítku
    if (this.app?.ruler && typeof this.app.ruler.resetSessionTracking === "function") {
      this.app.ruler.resetSessionTracking();
    }

    // Režimy pravítka a sledování slov
    this.rulerEnabled = !!this.rulerEnabled;
    this.rulerMode = this.rulerMode || "line";
    this.noRulerTotalWords = 0;

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

      const idleLimitMs = this.idleTimeoutMs || IDLE_TIMEOUT_MS;

      // Pauza při nečinnosti uživatele > idleLimitMs (výchozí 30 sekund):
      // Při přechodu do nečinnosti odečteme mrtvé sekundy ticha, ve kterých již neproběhla žádná interakce,
      // aby pauzy nezpůsobovaly umělé propady k 0 WPM ani nenaředily aktivní dobu čtení.
      if (now - this.lastActivityTime > idleLimitMs) {
        if (!this.isIdle) {
          const rewindSec = Math.max(0, this.unverifiedSilenceSeconds - IDLE_GRACE_READING_SEC);
          if (rewindSec > 0) {
            this._rewindActiveSeconds(rewindSec);
          }
          if (this.unverifiedSilenceInterimWords > 0) {
            const rewindWords = this.unverifiedSilenceInterimWords;
            this.unverifiedSilenceInterimWords = 0;
            this.blockInterimWordsAttributed = Math.max(0, this.blockInterimWordsAttributed - rewindWords);
            this.wordsCreditedOnCurrentPage = Math.max(0, this.wordsCreditedOnCurrentPage - rewindWords);
            this._rollbackUnverifiedWords(rewindWords);
          }
          this.unverifiedSilenceSeconds = 0;
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
        // Ochrana proti nekonečnému načítání času na jediné statické stránce bez otočení/scrollu/posunu pravítka:
        // Pokud na aktuální stránce již uplynula maximální realistická doba čtení (při 40 WPM)
        // a uživatel za posledních 15s neposunul text ani pravítko, pozastavíme přičítání času do dalšího posunu.
        const pageWords = Math.max(40, Math.min(MAX_VALID_WPM, Math.round(this.blockVisibleWords > 0 ? this.blockVisibleWords : 250)));
        const maxPageActiveSec = Math.max(75, Math.round((pageWords / MIN_VALID_WPM) * 60));
        if (this.currentPageActiveSeconds >= maxPageActiveSec && (now - this.lastReadingProgressTime) > 15000) {
          return;
        }

        if (now - this.lastActivityTime >= 1000) {
          this.unverifiedSilenceSeconds += 1;
        } else {
          this.unverifiedSilenceSeconds = 0;
          this.unverifiedSilenceInterimWords = 0;
        }

        // 1. Inkrementace aktivní sekundy v aktuální minutě
        this.currentMinuteActiveSeconds += 1;
        this.currentPageActiveSeconds += 1;

        // 2. Pokaždé, když currentMinuteActiveSeconds dosáhne 60 (přesně 1 minuta aktivního čtení):
        if (this.currentMinuteActiveSeconds >= 60) {
          const minuteNumber = this.completedMinutesCount;
          const elapsedSecAtMinuteEnd = minuteNumber * 60;

          let wordsInThisMinute = Math.max(0, Math.round(this.currentMinuteWords));
          const clampedMinuteWpm = Math.min(MAX_VALID_WPM, Math.max(1, wordsInThisMinute));

          this.intra_session_samples.push({
            minute: minuteNumber,
            elapsedSeconds: elapsedSecAtMinuteEnd,
            t: elapsedSecAtMinuteEnd,
            words: wordsInThisMinute,
            rawWpm: wordsInThisMinute,
            wpm: clampedMinuteWpm,
            activeSeconds: 60
          });

          this.currentMinuteIndex = minuteNumber;
          this.currentMinuteActiveSeconds = 0;
          this.currentMinuteWords = 0;
          this.wordsReadInCurrentMinute = 0;
          this.completedMinutesCount += 1;

          const completedSoFar = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
          this.sessionWordsRead = Math.max(completedSoFar, Math.round(this.noRulerTotalWords || 0));
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

        const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
        const liveWords = completedWords + Math.max(0, Math.round(this.currentMinuteWords));
        const displayWords = Math.max(liveWords, Math.round(this.noRulerTotalWords || 0));
        this.sessionWordsRead = displayWords;

        this.notifyListeners({
          type: "tick",
          activeSeconds: totalActiveSeconds,
          wpm: this.getCurrentWpm(),
          wordsRead: displayWords
        });
      }
    }, 1000);
  }

  pause() {
    this.isActive = false;
    this._pausedAt = Date.now();
    this.notifyListeners({ type: "stateChange", isActive: false });
  }

  resume() {
    if (!this.currentBookId) return;
    const now = Date.now();
    if (this._pausedAt && this.blockEnterTimestamp) {
      const pausedDuration = Math.max(0, now - this._pausedAt);
      this.blockEnterTimestamp += pausedDuration;
      if (this.pageEnterTimestamp) this.pageEnterTimestamp += pausedDuration;
    }
    this._pausedAt = null;
    this.isActive = true;
    this.lastTickTime = now;
    this.lastActivityTime = now;
    this.unverifiedSilenceSeconds = 0;
    this.unverifiedSilenceInterimWords = 0;
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
    this.recordActivity(true);
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
   * Average WPM = Total Words Read / Active Minutes Read
   * Striktně: duration >= 10 ? Math.round((words_read / duration) * 60) : 0.
   */
  getCurrentWpm() {
    const totalActiveSeconds = ((this.completedMinutesCount - 1) * 60) + this.currentMinuteActiveSeconds;
    if (totalActiveSeconds < 10) return 0;

    const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
    const rulerWords = completedWords + Math.max(0, Math.round(this.currentMinuteWords));
    const effectiveWords = Math.max(rulerWords, Math.round(this.noRulerTotalWords || 0));

    if (effectiveWords > 0) {
      return Math.min(MAX_VALID_WPM, Math.round((effectiveWords / totalActiveSeconds) * 60));
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
   * Pomocná metoda pro normalizaci vzorků (zachovává přesné neměnné hodnoty každé minuty).
   */
  static smoothSamples(rawSamples, sessionAvgWpm = 0) {
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) return [];
    return rawSamples.map((s, idx) => {
      const minNum = Number(s.minute) || (idx + 1);
      const elapsedSec = Number(s.elapsedSeconds ?? s.t ?? minNum * 60);
      const words = s.words !== undefined ? Math.max(0, Math.round(Number(s.words))) : 0;
      const rate = Number(s.rawWpm ?? s.wpm ?? words);
      const wpm = Math.min(MAX_VALID_WPM, Math.max(1, Math.round(rate > 0 ? rate : (words > 0 ? words : (sessionAvgWpm > 0 ? sessionAvgWpm : 1)))));
      return {
        ...s,
        minute: minNum,
        elapsedSeconds: elapsedSec,
        t: elapsedSec,
        words,
        rawWpm: rate > 0 ? rate : wpm,
        wpm: s.wpm !== undefined ? Number(s.wpm) : wpm
      };
    });
  }

  /**
   * Sestaví finální pole vzorků (včetně případné neuzavřené poslední minuty >= 30s) a sjednocené metriky:
   * - Average WPM = Total Words Read / Active Minutes Read
   * - Peak WPM = maximální udržená rychlost čtení za validní interval (>= 30–60 aktivních sekund) po vyhlazení
   */
  _buildSessionMetrics(totalActiveSeconds) {
    const effectiveActiveSeconds = totalActiveSeconds > 0
      ? totalActiveSeconds
      : (this.intra_session_samples.length * 60 + this.currentMinuteActiveSeconds);

    let wordsRead = 0;
    let avgWpm = 0;
    let rawSamples = [];

    const completedWords = this.intra_session_samples.reduce((sum, s) => sum + Math.round(s.words || 0), 0);
    const partialWords = Math.max(0, Math.round(this.currentMinuteWords));
    const accumulatedWords = completedWords + partialWords;
    wordsRead = Math.max(accumulatedWords, Math.round(this.noRulerTotalWords || 0));

    avgWpm = (effectiveActiveSeconds >= 10 && wordsRead > 0)
      ? Math.min(MAX_VALID_WPM, Math.round((wordsRead / effectiveActiveSeconds) * 60))
      : 0;

    rawSamples = this.intra_session_samples.map(s => ({ ...s }));

    // Pokud neuzavřená poslední minuta trvá >= 30s (udržený interval) a obsahuje přečtená slova (> 0),
    // připojíme dílčí vzorek
    if (this.currentMinuteActiveSeconds >= 30 && partialWords > 0) {
      const rawPartialWpm = Math.round((partialWords / this.currentMinuteActiveSeconds) * 60);
      const clampedPartialWpm = Math.min(MAX_VALID_WPM, Math.max(1, rawPartialWpm));
      rawSamples.push({
        minute: this.completedMinutesCount,
        elapsedSeconds: effectiveActiveSeconds,
        t: effectiveActiveSeconds,
        words: partialWords,
        rawWpm: rawPartialWpm,
        wpm: clampedPartialWpm,
        activeSeconds: this.currentMinuteActiveSeconds,
        isPartial: true
      });
    } else if (rawSamples.length === 0 && effectiveActiveSeconds >= 15 && wordsRead > 0) {
      // Relace trvala méně než 1 celou minutu, ale splňuje podmínky pro dílčí vzorek
      const rawPartialWpm = Math.round((wordsRead / effectiveActiveSeconds) * 60);
      const clampedPartialWpm = Math.min(MAX_VALID_WPM, Math.max(1, rawPartialWpm));
      rawSamples.push({
        minute: 1,
        elapsedSeconds: effectiveActiveSeconds,
        t: effectiveActiveSeconds,
        words: wordsRead,
        rawWpm: rawPartialWpm,
        wpm: clampedPartialWpm,
        activeSeconds: effectiveActiveSeconds,
        isPartial: true
      });
    }

    // Každý minutový vzorek je pevný a neměnný (immutable snapshot),
    // nesmí být modifikován vyhlazováním, klouzavým průměrem ani škálováním!
    const samples = rawSamples;

    // Peak WPM se počítá výhradně z udržených intervalů (>= 30–60s aktivního čtení)
    const sustainedWpms = samples
      .filter(s => !s.isPartial || (s.activeSeconds ?? 60) >= 30)
      .map(s => Number(s.wpm) || 0)
      .filter(w => w >= 1 && w <= MAX_VALID_WPM);

    let peakWpm = sustainedWpms.length > 0
      ? Math.min(MAX_VALID_WPM, Math.max(...sustainedWpms))
      : avgWpm;
    if (peakWpm < avgWpm && avgWpm > 0) {
      peakWpm = avgWpm;
    }

    return {
      wordsRead,
      durationSeconds: effectiveActiveSeconds,
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
    // Před uložením zhodnotíme aktuální blok s příznakem isFlushing = true (nepřičítá unread remainder nedokončené stránky)
    this.commitCurrentBlockDwell(1, null, true);

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
        is_deleted: false,
        isDeleted: false,
        updatedAt: new Date(now).toISOString(),
        syncedToCloud: false
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

          const hwm = this.highWaterMark ? { ...this.highWaterMark } : null;
          const blocksArray = Array.from(this.creditedBlocks || []);

          await storage.updateBookProgress(bookId, {
            currentChapterIndex: this.currentChapterIndex,
            scrollPercent: this.currentScrollPercent,
            wordsRead: totalWordsRead,
            lastWpm: avgWpm,
            highWaterMark: hwm,
            creditedBlocks: blocksArray
          });
        }

        // PUSH DO SUPABASE: Odeslání platné relace (>= 5 min) a aktualizovaného souhrnu statistik
        storage.pushReadingSessionAndStatsToCloud(savedSession || sessionRecord).then((res) => {
          if (res?.success) {
            const sid = (savedSession || sessionRecord).sessionId || (savedSession || sessionRecord).id;
            if (sid) {
              const toMark = { ...(savedSession || sessionRecord), syncedToCloud: true };
              storage.saveReadingSession(toMark).catch(() => {});
            }
          }
        }).catch(err => {
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
          const hwm = this.highWaterMark ? { ...this.highWaterMark } : null;
          const blocksArray = Array.from(this.creditedBlocks || []);
          await storage.updateBookProgress(bookId, {
            currentChapterIndex: this.currentChapterIndex,
            scrollPercent: this.currentScrollPercent,
            highWaterMark: hwm,
            creditedBlocks: blocksArray
          });
        } catch (_) {}
      }
    }

    // Reset čítačů relace
    this.currentSessionId = null;
    this.sessionStartTime = null;
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.noRulerTotalWords = 0;
    this.sessionDailySecondsCommitted = 0;
    this.validReadingTimeMs = 0;
    this.validWordsRead = 0;
    this.currentReadingBlockId = null;
    this.blockEnterTimestamp = null;
    this.blockEnterActiveSec = 0;
    this.currentPageActiveSeconds = 0;
    this.blockVisibleWords = 0;
    this.wordsCreditedOnCurrentPage = 0;
    this.blockDirectWordsAttributed = 0;
    this.blockInterimWordsAttributed = 0;
    this.unverifiedSilenceSeconds = 0;
    this.unverifiedSilenceInterimWords = 0;
    this.unreconciledRulerWords = 0;
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
    const deletedSet = new Set((typeof storage !== "undefined" && typeof storage.getDeletedSessionIds === "function") ? storage.getDeletedSessionIds() : []);

    // Filtrujeme striktně pouze relace s aktivní dobou čtení >= 5 minut (300 sekund) a nesmazané relace
    const sessions = (rawSessions || []).filter(s => {
      if (!s) return false;
      if (s.is_deleted === true || s.is_deleted === "true") return false;
      const sid = String(s.sessionId ?? s.id ?? "").trim();
      if (sid && deletedSet.has(sid)) return false;
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

    // Sjednocení metrik každé relace bez opakovaného vyhlazování již uložených vzorků
    allSessions.forEach(s => {
      const samples = Array.isArray(s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
        ? (s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
        : [];
      const rawDur = Math.max(0, Math.round(s.duration ?? s.durationSeconds ?? s.activeSeconds ?? 0));
      const rawWords = Math.max(0, Math.round(s.words_read ?? s.wordsRead ?? 0));

      const effectiveDur = rawDur;
      const trueAvgWpm = effectiveDur >= 10 ? Math.min(MAX_VALID_WPM, Math.round((rawWords / effectiveDur) * 60)) : 0;
      const sampleWpms = samples
        .filter(pt => !pt.isPartial || (pt.activeSeconds ?? 60) >= 30)
        .map(pt => Number(pt.wpm ?? 0))
        .filter(w => w >= 1 && w <= MAX_VALID_WPM);
      const truePeakWpm = sampleWpms.length > 0 ? Math.min(MAX_VALID_WPM, Math.max(...sampleWpms, trueAvgWpm)) : trueAvgWpm;

      s.duration = effectiveDur;
      s.durationSeconds = effectiveDur;
      s.activeSeconds = effectiveDur;
      s.words_read = rawWords;
      s.wordsRead = rawWords;
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
        sessionId: s.sessionId || s.id,
        id: s.id || s.sessionId,
        wpm: Math.round(s.avg_wpm ?? s.avgWpm ?? s.wpm),
        avg_wpm: Math.round(s.avg_wpm ?? s.avgWpm ?? s.wpm),
        wordsRead: s.words_read ?? s.wordsRead ?? 0,
        duration: s.duration ?? s.durationSeconds ?? 0,
        durationSeconds: s.duration ?? s.durationSeconds ?? 0,
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
