/**
 * tracker.js - Inteligentní měřič aktivity a rychlosti čtení (WPM).
 * Zjišťuje reálný aktivní čas (pauza při nečinnosti), počítá slova,
 * odhaduje zbývající čas a ukládá čtecí relace.
 */

import { storage } from "./storage.js";

const IDLE_TIMEOUT_MS = 45000; // 45 sekund bez interakce = uživatel nečte

export class ReadingTracker {
  constructor() {
    this.currentBookId = null;
    this.currentBookTitle = "";
    this.currentChapterIndex = 0;
    this.currentChapterWords = 0;
    
    // Časovače relace
    this.isActive = false;
    this.isIdle = false;
    this.activeTimeMs = 0;
    this.lastActivityTime = Date.now();
    this.lastTickTime = Date.now();
    this.timerInterval = null;

    // Metriky aktuální relace
    this.sessionStartTimestamp = null;
    this.sessionWordsRead = 0;
    this.sessionInitialScrollPercent = 0;
    this.currentScrollPercent = 0;
    
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
    window.addEventListener("keydown", onUserAction, { passive: true });
    window.addEventListener("touchstart", onUserAction, { passive: true });
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

    // Uložit relaci před zavřením okna
    window.addEventListener("beforeunload", () => {
      this.flushSession();
    });
  }

  recordActivity() {
    this.lastActivityTime = Date.now();
    if (this.isIdle && this.isActive) {
      this.isIdle = false;
      this.notifyListeners({ type: "idleChange", isIdle: false });
    }
  }

  startSession(bookId, bookTitle, chapterIndex, chapterWords, scrollPercent = 0) {
    // Pokud běžela předchozí relace, nejprve ji uložíme
    if (this.currentBookId) {
      this.flushSession();
    }

    this.currentBookId = bookId;
    this.currentBookTitle = bookTitle;
    this.currentChapterIndex = chapterIndex;
    this.currentChapterWords = chapterWords || 1;
    this.sessionStartTimestamp = Date.now();
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.sessionInitialScrollPercent = scrollPercent;
    this.currentScrollPercent = scrollPercent;
    this.isIdle = false;
    this.isActive = true;
    this.lastActivityTime = Date.now();
    this.lastTickTime = Date.now();

    this.startTicker();
  }

  startTicker() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTickTime;
      this.lastTickTime = now;

      // Zkontrolujeme, zda neuplynul idle timeout
      if (now - this.lastActivityTime > IDLE_TIMEOUT_MS) {
        if (!this.isIdle) {
          this.isIdle = true;
          this.notifyListeners({ type: "idleChange", isIdle: true });
        }
        return; // Nepřičítáme čas, pokud uživatel spí nebo odešel
      }

      if (this.isActive && !this.isIdle) {
        this.activeTimeMs += delta;
        this.notifyListeners({
          type: "tick",
          activeSeconds: Math.floor(this.activeTimeMs / 1000),
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
   * Aktualizuje pozici skrolování a odhaduje počet přečtených slov v kapitole
   * @param {number} scrollPercent 0.0 až 1.0
   */
  updateScrollProgress(scrollPercent) {
    this.recordActivity();
    const clamped = Math.max(0, Math.min(1, scrollPercent));
    this.currentScrollPercent = clamped;

    // Pokud uživatel postupuje vpřed v kapitole:
    const diff = Math.max(0, clamped - this.sessionInitialScrollPercent);
    const estimatedWords = Math.round(diff * this.currentChapterWords);
    this.sessionWordsRead = Math.max(this.sessionWordsRead, estimatedWords);

    this.notifyListeners({
      type: "progress",
      scrollPercent: clamped,
      wordsRead: this.sessionWordsRead,
      wpm: this.getCurrentWpm()
    });
  }

  /**
   * Spočítá aktuální rychlost čtení (Words Per Minute)
   */
  getCurrentWpm() {
    const activeMinutes = this.activeTimeMs / 1000 / 60;
    if (activeMinutes < 0.1 || this.sessionWordsRead < 10) {
      // V prvních sekundách nemáme dostatek dat, vrátíme výchozí odhad 220 WPM
      return 220;
    }
    const wpm = Math.round(this.sessionWordsRead / activeMinutes);
    // Omezíme na realistické rozmezí rychločtení
    return Math.max(60, Math.min(1200, wpm));
  }

  /**
   * Odhadne zbývající čas v minutách
   * @param {number} remainingWords 
   * @returns {number} minuty
   */
  getEstimatedMinutesRemaining(remainingWords) {
    const wpm = this.getCurrentWpm() || 220;
    return Math.max(1, Math.ceil(remainingWords / wpm));
  }

  /**
   * Uloží aktuální relaci do IndexedDB a aktualizuje knihu
   */
  async flushSession() {
    const activeSeconds = Math.floor(this.activeTimeMs / 1000);
    
    // Ukládáme pouze relace delší než 5 sekund s aktivním čtením
    if (this.currentBookId && activeSeconds >= 5) {
      const wpm = this.getCurrentWpm();
      try {
        await storage.logReadingSession({
          bookId: this.currentBookId,
          bookTitle: this.currentBookTitle,
          chapterIndex: this.currentChapterIndex,
          activeSeconds: activeSeconds,
          wordsRead: this.sessionWordsRead,
          wpm: wpm
        });

        // Aktualizujeme data v knize
        const book = await storage.getBook(this.currentBookId);
        if (book) {
          const totalWordsRead = (book.wordsRead || 0) + this.sessionWordsRead;
          const progressPercent = book.totalWords > 0 
            ? Math.min(100, Math.round((totalWordsRead / book.totalWords) * 100))
            : Math.round(((this.currentChapterIndex + this.currentScrollPercent) / Math.max(1, book.totalChapters || 1)) * 100);

          await storage.updateBookProgress(this.currentBookId, {
            currentChapterIndex: this.currentChapterIndex,
            scrollPercent: this.currentScrollPercent,
            wordsRead: totalWordsRead,
            progressPercent: progressPercent,
            lastWpm: wpm
          });
        }
      } catch (err) {
        console.warn("Chyba při ukládání čtecí relace:", err);
      }
    }

    // Reset čítačů pro novou podrelaci
    this.activeTimeMs = 0;
    this.sessionWordsRead = 0;
    this.sessionInitialScrollPercent = this.currentScrollPercent;
  }

  stopSession() {
    this.flushSession();
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.currentBookId = null;
    this.isActive = false;
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

  static async computeGlobalStats() {
    const sessions = await storage.getAllSessions();
    const books = await storage.getAllBooks();

    let totalSeconds = 0;
    let totalWords = 0;
    let weightedWpmSum = 0;

    sessions.forEach(s => {
      totalSeconds += (s.activeSeconds || 0);
      totalWords += (s.wordsRead || 0);
      if (s.wpm && s.activeSeconds) {
        weightedWpmSum += s.wpm * s.activeSeconds;
      }
    });

    const averageWpm = totalSeconds > 0 ? Math.round(weightedWpmSum / totalSeconds) : 220;

    // Výpočet streak (počet po sobě jdoucích dní s čtením)
    const activeDates = new Set(sessions.map(s => s.date));
    let streak = 0;
    let checkDate = new Date();
    
    // Zkontrolovat dnes nebo včera
    const todayStr = checkDate.toISOString().split("T")[0];
    let hasToday = activeDates.has(todayStr);

    while (true) {
      const dateStr = checkDate.toISOString().split("T")[0];
      if (activeDates.has(dateStr)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        // Pokud dnes ještě nečetl, ale včera ano, streak zůstává zachován
        if (streak === 0 && !hasToday) {
          checkDate.setDate(checkDate.getDate() - 1);
          const yesterdayStr = checkDate.toISOString().split("T")[0];
          if (activeDates.has(yesterdayStr)) {
            streak = 1;
            checkDate.setDate(checkDate.getDate() - 1);
            continue;
          }
        }
        break;
      }
    }

    // Statistiky za posledních 7 a 30 dní
    const last7Days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const dayName = d.toLocaleDateString("cs-CZ", { weekday: "short" });

      const daySessions = sessions.filter(s => s.date === dateStr);
      const daySeconds = daySessions.reduce((sum, s) => sum + (s.activeSeconds || 0), 0);
      const dayWords = daySessions.reduce((sum, s) => sum + (s.wordsRead || 0), 0);

      last7Days.push({
        date: dateStr,
        label: dayName,
        minutes: Math.round(daySeconds / 60),
        words: dayWords
      });
    }

    // Historie WPM (posledních až 20 relací pro graf vývoje rychlosti)
    const wpmHistory = sessions
      .filter(s => s.wpm && s.activeSeconds >= 10)
      .slice(-20)
      .map((s, idx) => ({
        index: idx + 1,
        wpm: s.wpm,
        date: s.date,
        bookTitle: s.bookTitle
      }));

    return {
      totalTimeFormatted: ReadingTracker.formatDuration(totalSeconds),
      totalSeconds,
      totalWords,
      averageWpm,
      streak,
      totalBooks: books.length,
      finishedBooks: books.filter(b => (b.progressPercent || 0) >= 100).length,
      last7Days,
      wpmHistory
    };
  }

  static formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds < 60) return `${totalSeconds || 0} s`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours === 0) return `${minutes} min`;
    return `${hours} h ${minutes} min`;
  }
}

export const tracker = new ReadingTracker();
