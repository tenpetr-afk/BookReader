/**
 * storage.js - Správa trvalého úložiště IndexedDB a LocalStorage.
 * Ukládá knihy (včetně celých souborů a obálek), historii čtení,
 * statistiky a uživatelská nastavení zobrazení a pravítka.
 */

const DB_NAME = "LuminaReaderDB";
const DB_VERSION = 2;

export class StorageManager {
  constructor() {
    this.db = null;
    this.initPromise = this.initDB();
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Úložiště pro knihy
        if (!db.objectStoreNames.contains("books")) {
          const bookStore = db.createObjectStore("books", { keyPath: "id" });
          bookStore.createIndex("addedAt", "addedAt", { unique: false });
          bookStore.createIndex("lastReadAt", "lastReadAt", { unique: false });
        }

        // Úložiště pro čtecí relace (historie čtení a rychlosti - legacy)
        if (!db.objectStoreNames.contains("sessions")) {
          const sessionStore = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          sessionStore.createIndex("bookId", "bookId", { unique: false });
          sessionStore.createIndex("date", "date", { unique: false });
          sessionStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // Vyhrazené úložiště pro detailní čtecí relace (reading_sessions) s časovou osou
        if (!db.objectStoreNames.contains("reading_sessions")) {
          const readingSessionsStore = db.createObjectStore("reading_sessions", { keyPath: "sessionId" });
          readingSessionsStore.createIndex("bookId", "bookId", { unique: false });
          readingSessionsStore.createIndex("startTime", "startTime", { unique: false });
          readingSessionsStore.createIndex("timestamp", "timestamp", { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error("Chyba při otevírání IndexedDB:", event.target.error);
        reject(event.target.error);
      };
    });
  }

  async getDB() {
    if (this.db) return this.db;
    return await this.initPromise;
  }

  // --- KNIHY (BOOKS) ---

  async saveBook(bookData) {
    if (!bookData) return null;
    this.normalizeBookProgress(bookData);

    // Normalizace názvu a formátu souboru
    if (!bookData.fileName && bookData.file_name) {
      bookData.fileName = bookData.file_name;
    }
    const isPdf = !!(bookData.isPdf || bookData.format === "pdf" || bookData.fileName?.toLowerCase().endsWith(".pdf"));
    const format = isPdf ? "pdf" : "epub";
    bookData.format = format;
    bookData.isPdf = isPdf;

    if (!bookData.fileName) {
      const cleanTitle = (bookData.title || bookData.id || "book")
        .replace(/[^a-zA-Z0-9_\-\u00C0-\u017F]/g, "_")
        .slice(0, 40);
      bookData.fileName = `${cleanTitle}.${format}`;
    }
    bookData.file_name = bookData.fileName;

    // Zachování a normalizace surových binárních dat (ArrayBuffer, Uint8Array nebo Blob)
    const rawBinary = bookData.data || bookData.fileData;
    if (rawBinary) {
      bookData.data = rawBinary;
      bookData.fileData = rawBinary;
    }

    // Normalizace autora a tvůrce
    if (!bookData.author && bookData.creator) {
      bookData.author = bookData.creator;
    } else if (!bookData.creator && bookData.author) {
      bookData.creator = bookData.author;
    }

    if (isPdf) {
      if (!bookData.pdfRulerConfig) {
        bookData.pdfRulerConfig = { height: 32, stepSize: 32 };
      } else {
        bookData.pdfRulerConfig = {
          height: Math.max(16, Math.min(120, Math.round(Number(bookData.pdfRulerConfig.height) || 32))),
          stepSize: Math.max(10, Math.min(120, Math.round(Number(bookData.pdfRulerConfig.stepSize) || 32)))
        };
      }
    }
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      const request = store.put(bookData);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async uploadBook(book) {
    const { supabaseSync } = await import("./supabase-sync.js");
    return await supabaseSync.uploadBook(book);
  }

  async syncWithCloud(options) {
    const { supabaseSync } = await import("./supabase-sync.js");
    return await supabaseSync.syncAll(options);
  }

  normalizeBookProgress(book) {
    if (!book) return 0;
    let progressValue = 0;

    if (typeof book.progress === "number" && !isNaN(book.progress)) {
      progressValue = (book.progress > 0 && book.progress < 1) ? book.progress * 100 : book.progress;
    } else if (typeof book.scroll_progress === "number" && !isNaN(book.scroll_progress)) {
      progressValue = (book.scroll_progress > 0 && book.scroll_progress <= 1) ? book.scroll_progress * 100 : book.scroll_progress;
    } else if (typeof book.progressPercent === "number" && !isNaN(book.progressPercent)) {
      progressValue = (book.progressPercent > 0 && book.progressPercent < 1) ? book.progressPercent * 100 : book.progressPercent;
    } else if (typeof book.scrollPercent === "number" && !isNaN(book.scrollPercent)) {
      progressValue = (book.scrollPercent > 0 && book.scrollPercent <= 1) ? book.scrollPercent * 100 : book.scrollPercent;
    } else if (book.currentPage && book.numPages) {
      progressValue = Math.round((book.currentPage / book.numPages) * 100);
    } else if (book.current_page && book.total_pages) {
      progressValue = Math.round((book.current_page / book.total_pages) * 100);
    } else if (typeof book.currentPageIndex === "number" && book.numPages) {
      progressValue = Math.round(((book.currentPageIndex + 1) / book.numPages) * 100);
    } else if (book.wordsRead && book.totalWords) {
      progressValue = Math.round((book.wordsRead / book.totalWords) * 100);
    }

    progressValue = Math.max(0, Math.min(100, Math.round(progressValue)));
    book.progress = progressValue;
    book.progressPercent = progressValue;
    return progressValue;
  }

  async getBook(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readonly");
      const store = tx.objectStore("books");
      const request = store.get(id);

      request.onsuccess = () => {
        const book = request.result;
        if (book) {
          this.normalizeBookProgress(book);
        }
        resolve(book);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllBooks() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readonly");
      const store = tx.objectStore("books");
      const request = store.getAll();

      request.onsuccess = () => {
        const books = request.result || [];
        for (const book of books) {
          this.normalizeBookProgress(book);
        }
        // Seřadit podle naposledy čtených
        books.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
        resolve(books);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteBook(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const storeNames = ["books"];
      if (db.objectStoreNames.contains("sessions")) storeNames.push("sessions");
      if (db.objectStoreNames.contains("reading_sessions")) storeNames.push("reading_sessions");

      const tx = db.transaction(storeNames, "readwrite");
      const bookStore = tx.objectStore("books");
      bookStore.delete(id);

      // Smazat i přidružené relace ze sessions
      if (db.objectStoreNames.contains("sessions")) {
        const sessionStore = tx.objectStore("sessions");
        const index = sessionStore.index("bookId");
        const request = index.openCursor(IDBKeyRange.only(id));
        request.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      // Smazat i přidružené relace z reading_sessions
      if (db.objectStoreNames.contains("reading_sessions")) {
        const readingStore = tx.objectStore("reading_sessions");
        const index = readingStore.index("bookId");
        const request = index.openCursor(IDBKeyRange.only(id));
        request.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateBookProgress(bookId, updates) {
    const book = await this.getBook(bookId);
    if (!book) return;
    Object.assign(book, updates, { lastReadAt: Date.now() });

    const isPdf = !!(book.isPdf || book.format === "pdf" || updates.isPdf);
    const currentPage = updates.currentPage ?? (updates.currentPageIndex !== undefined ? updates.currentPageIndex + 1 : (book.currentPage ?? (book.currentPageIndex !== undefined ? book.currentPageIndex + 1 : (updates.current_page ?? book.current_page))));
    const numPages = updates.numPages ?? book.numPages ?? updates.total_pages ?? book.total_pages ?? updates.totalPages ?? book.totalPages ?? (book.description ? (book.description.match(/(\d+)\s*stran/)?.[1] ? parseInt(book.description.match(/(\d+)\s*stran/)[1], 10) : undefined) : undefined);

    if (isPdf && currentPage && numPages) {
      const progress = Math.max(0, Math.min(100, Math.round((currentPage / numPages) * 100)));
      book.progress = progress;
      book.progressPercent = progress;
      book.currentPage = currentPage;
      book.numPages = numPages;
    } else {
      this.normalizeBookProgress(book);
    }

    return await this.saveBook(book);
  }

  async updateBookPdfRulerConfig(bookId, config) {
    const book = await this.getBook(bookId);
    if (!book) return null;
    const height = Math.max(16, Math.min(120, Math.round(Number(config?.height) || 32)));
    const stepSize = Math.max(10, Math.min(120, Math.round(Number(config?.stepSize) || 32)));
    book.pdfRulerConfig = { height, stepSize };
    await this.saveBook(book);
    return book.pdfRulerConfig;
  }

  getLocalDateString(dateInput = new Date()) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  getDailyReadingTimeMap() {
    try {
      const raw = localStorage.getItem("luminareader_daily_reading_time");
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  addDailyReadingSeconds(dateKey, deltaSeconds) {
    if (!dateKey || typeof deltaSeconds !== "number" || deltaSeconds <= 0) return;
    try {
      const map = this.getDailyReadingTimeMap();
      map[dateKey] = (map[dateKey] || 0) + deltaSeconds;
      localStorage.setItem("luminareader_daily_reading_time", JSON.stringify(map));
    } catch (_) {}
  }

  setDailyReadingSeconds(dateKey, seconds) {
    if (!dateKey) return;
    try {
      const map = this.getDailyReadingTimeMap();
      map[dateKey] = Math.max(0, Math.round(seconds));
      localStorage.setItem("luminareader_daily_reading_time", JSON.stringify(map));
    } catch (_) {}
  }

  // --- ČTECÍ RELACE A STATISTIKY (SESSIONS & READING_SESSIONS) ---

  /**
   * Uloží detailní relaci čtení do reading_sessions a synchronizuje i do sessions (legacy)
   * @param {Object} sessionData
   */
  async saveReadingSession(sessionData) {
    if (!sessionData) return null;
    const db = await this.getDB();

    const timestamp = sessionData.timestamp || Date.now();
    const durationSeconds = Math.max(0, Math.round(sessionData.durationSeconds ?? sessionData.activeSeconds ?? 0));
    const startTime = sessionData.startTime || new Date(timestamp - (durationSeconds * 1000)).toISOString();
    const endTime = sessionData.endTime || new Date(timestamp).toISOString();
    let wordsRead = Math.max(0, Math.round(sessionData.wordsRead ?? 0));
    let avgWpm = Math.round(sessionData.avgWpm ?? sessionData.wpm ?? 220);

    const durationMinutes = durationSeconds / 60;
    if (durationMinutes > 0.05) {
      const calculatedPace = Math.round(wordsRead / durationMinutes);
      if (calculatedPace > 650) {
        wordsRead = Math.round(durationMinutes * 220);
        avgWpm = 220;
      }
    }
    if (avgWpm < 80 || avgWpm > 650) {
      avgWpm = (durationMinutes > 0.05 && (wordsRead / durationMinutes) >= 80 && (wordsRead / durationMinutes) <= 650)
        ? Math.round(wordsRead / durationMinutes)
        : 220;
    }

    const localDate = this.getLocalDateString(sessionData.date || startTime || timestamp);
    const sessionId = sessionData.sessionId || `session_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

    // Filtrace vzorků timelineSamples od umělých clampů
    const rawSamples = Array.isArray(sessionData.timelineSamples) ? sessionData.timelineSamples : [];
    const cleanedSamples = rawSamples.filter(s => {
      const sw = Number(s.instantaneousWpm || s.wpm || 0);
      return sw >= 80 && sw <= 650;
    }).map(s => ({
      timestamp: s.timestamp || timestamp,
      elapsedSeconds: Math.max(0, Math.round(s.elapsedSeconds || 0)),
      instantaneousWpm: Math.round(s.instantaneousWpm || s.wpm || avgWpm)
    }));

    const normalizedSession = {
      sessionId,
      id: sessionId,
      bookId: sessionData.bookId || "",
      bookTitle: sessionData.bookTitle || "",
      chapterIndex: sessionData.chapterIndex ?? 0,
      startTime,
      endTime,
      durationSeconds,
      activeSeconds: durationSeconds,
      wordsRead,
      avgWpm,
      wpm: avgWpm,
      timelineSamples: cleanedSamples,
      date: localDate,
      timestamp
    };

    return new Promise((resolve, reject) => {
      const stores = [];
      if (db.objectStoreNames.contains("reading_sessions")) stores.push("reading_sessions");
      if (db.objectStoreNames.contains("sessions")) stores.push("sessions");

      if (stores.length === 0) {
        this._cacheSessionToLocalStorage(normalizedSession);
        return resolve(normalizedSession);
      }

      const tx = db.transaction(stores, "readwrite");
      if (db.objectStoreNames.contains("reading_sessions")) {
        tx.objectStore("reading_sessions").put(normalizedSession);
      }
      if (db.objectStoreNames.contains("sessions")) {
        tx.objectStore("sessions").put({
          ...normalizedSession,
          id: undefined
        });
      }

      tx.oncomplete = () => {
        this._cacheSessionToLocalStorage(normalizedSession);
        resolve(normalizedSession);
      };
      tx.onerror = () => {
        this._cacheSessionToLocalStorage(normalizedSession);
        reject(tx.error);
      };
    });
  }

  _cacheSessionToLocalStorage(session) {
    try {
      const raw = localStorage.getItem("lumina_reading_sessions");
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter(s => s.sessionId !== session.sessionId);
      filtered.unshift(session);
      localStorage.setItem("lumina_reading_sessions", JSON.stringify(filtered.slice(0, 100)));
    } catch (_) {
      // Ignorovat chyby kvóty
    }
  }

  async logReadingSession(sessionData) {
    return await this.saveReadingSession(sessionData);
  }

  async getAllReadingSessions() {
    const db = await this.getDB();
    return new Promise((resolve) => {
      if (!db.objectStoreNames.contains("reading_sessions")) {
        return this.getAllSessions().then(resolve);
      }

      const tx = db.transaction("reading_sessions", "readonly");
      const store = tx.objectStore("reading_sessions");
      const request = store.getAll();

      request.onsuccess = async () => {
        let results = request.result || [];
        // Pokud je reading_sessions prázdné, ale staré sessions existují, migrujeme je
        if (results.length === 0 && db.objectStoreNames.contains("sessions")) {
          const oldSessions = await this._getOldSessions();
          if (oldSessions.length > 0) {
            for (const oldS of oldSessions) {
              await this.saveReadingSession(oldS);
            }
            results = await this.getAllReadingSessions();
            return resolve(results);
          }
        }
        // Seřadit sestupně (nejnovější nahoře)
        results.sort((a, b) => (b.timestamp || new Date(b.startTime).getTime() || 0) - (a.timestamp || new Date(a.startTime).getTime() || 0));
        resolve(results);
      };

      request.onerror = () => {
        try {
          const raw = localStorage.getItem("lumina_reading_sessions");
          if (raw) return resolve(JSON.parse(raw));
        } catch (_) {}
        resolve([]);
      };
    });
  }

  async _getOldSessions() {
    const db = await this.getDB();
    return new Promise((resolve) => {
      if (!db.objectStoreNames.contains("sessions")) return resolve([]);
      const tx = db.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async getAllSessions() {
    return await this.getAllReadingSessions();
  }

  async getReadingSessionsByBook(bookId) {
    const all = await this.getAllReadingSessions();
    return all.filter(s => s.bookId === bookId);
  }

  async getSessionsByBook(bookId) {
    return await this.getReadingSessionsByBook(bookId);
  }

  async getReadingSession(sessionId) {
    const all = await this.getAllReadingSessions();
    return all.find(s => s.sessionId === sessionId || s.id === sessionId) || null;
  }

  // --- NASTAVENÍ ČTEČKY (SETTINGS V LOCALSTORAGE) ---

  getSettings() {
    const showProgressBar = localStorage.getItem('showProgressBar') !== null
      ? localStorage.getItem('showProgressBar') === 'true'
      : true; // MUST default to true for new domains/first visits

    const defaults = {
      theme: "warm", // light, warm, sepia, dark, oled
      fontFamily: "georgia", // georgia, inter, merriweather, lora, atkinson, opendyslexic
      fontSize: 19, // px
      marginPercent: 20, // % velikost okrajů stránky
      columnsMode: "auto", // "auto" | "1" | "2" - rozvržení sloupců
      lineHeight: 1.6,
      letterSpacing: 0, // px
      wordSpacing: 0, // px
      contentWidth: 720, // px
      textAlign: "justify", // left, justify
      readingMode: "scroll", // scroll, paginated
      fastReading: false, // Bionic reading (zvýraznění prvních písmen slov)
      pencilDoubleTapNavigation: true, // listování dvojitým poklepáním Apple Pencil
      pencilFlickNavigation: true, // listování švihnutím stylusu (Apple Pencil flick gesture)
      showFooterBar: showProgressBar, // zobrazení spodní lišty čtečky (postup čtení, výchozí zapnuto)
      showProgressBar: showProgressBar,
      showRulerButton: true, // zobrazení tlačítka pravítka v dolní liště
      ruler: {
        enabled: false,
        mode: "highlight", // highlight, focus
        height: 48, // px
        autoHeight: true, // Automatická výška podle velikosti řádku
        snapToLines: true, // Magnetická přilnavost k jednotlivým řádkům
        wordTracking: false, // Sledování jednotlivých slov
        color: "amber", // amber, cyan, emerald, lavender, slate
        dimOpacity: 0.65,
        followMode: "mouse" // mouse, keyboard, auto
      }
    };

    try {
      const saved = localStorage.getItem("luminareader_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        const merged = {
          ...defaults,
          ...parsed,
          ruler: { ...defaults.ruler, ...(parsed.ruler || {}) }
        };
        merged.marginPercent = parsed.marginPercent ?? 20;
        merged.columnsMode = parsed.columnsMode ?? "auto";
        merged.lineHeight = parsed.lineHeight !== undefined ? Number(parsed.lineHeight) : 1.6;
        merged.letterSpacing = parsed.letterSpacing !== undefined ? Number(parsed.letterSpacing) : 0;
        merged.wordSpacing = parsed.wordSpacing !== undefined ? Number(parsed.wordSpacing) : 0;
        merged.fastReading = !!parsed.fastReading;
        merged.pencilDoubleTapNavigation = parsed.pencilDoubleTapNavigation !== false;
        merged.pencilFlickNavigation = parsed.pencilFlickNavigation !== false;
        merged.showRulerButton = parsed.showRulerButton !== false;
        if (localStorage.getItem('showProgressBar') !== null) {
          merged.showFooterBar = localStorage.getItem('showProgressBar') === 'true';
        } else if (parsed.showFooterBar !== undefined) {
          merged.showFooterBar = parsed.showFooterBar !== false;
        } else if (parsed.showProgressBar !== undefined) {
          merged.showFooterBar = parsed.showProgressBar !== false;
        } else {
          merged.showFooterBar = true;
        }
        merged.showProgressBar = merged.showFooterBar;
        if (merged.ruler.mode === "underline") {
          merged.ruler.mode = "highlight";
        }
        if (merged.ruler.followMode !== "keyboard") {
          merged.ruler.followMode = "mouse";
        }
        const savedSnap = localStorage.getItem("rulerSnapToLines");
        if (savedSnap !== null) {
          merged.ruler.snapToLines = savedSnap === "true";
        } else {
          merged.ruler.snapToLines = parsed.ruler?.snapToLines !== false;
        }
        merged.ruler.autoHeight = true;
        return merged;
      }
    } catch (e) {
      console.warn("Chyba při čtení nastavení z localStorage:", e);
    }
    return defaults;
  }

  getSetting(key, defaultValue = true) {
    if (key === "rulerSnapToLines") {
      const stored = localStorage.getItem("rulerSnapToLines");
      if (stored !== null) {
        return stored === "true";
      }
      const settings = this.getSettings();
      if (settings?.ruler?.snapToLines !== undefined) {
        return settings.ruler.snapToLines !== false;
      }
      return defaultValue !== undefined ? defaultValue : true;
    }
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      try {
        return JSON.parse(stored);
      } catch {
        return stored;
      }
    }
    const settings = this.getSettings();
    if (settings && key in settings) {
      return settings[key];
    }
    return defaultValue;
  }

  saveSetting(key, value) {
    try {
      localStorage.setItem(key, String(value));
      const settings = this.getSettings();
      if (key === "rulerSnapToLines") {
        if (!settings.ruler) settings.ruler = {};
        settings.ruler.snapToLines = value !== false;
        this.saveSettings(settings);
      } else if (settings && key in settings) {
        settings[key] = value;
        this.saveSettings(settings);
      }
    } catch (e) {
      console.warn("Chyba při ukládání nastavení:", e);
    }
  }

  saveSettings(settings) {
    try {
      if (settings?.ruler) {
        settings.ruler.snapToLines = settings.ruler.snapToLines !== false;
        settings.ruler.autoHeight = true;
        localStorage.setItem("rulerSnapToLines", String(settings.ruler.snapToLines));
      }
      const isVisible = (settings.showProgressBar !== undefined ? settings.showProgressBar : settings.showFooterBar) !== false;
      settings.showFooterBar = isVisible;
      settings.showProgressBar = isVisible;
      localStorage.setItem('showProgressBar', String(isVisible));
      localStorage.setItem("luminareader_settings", JSON.stringify(settings));
    } catch (e) {
      console.warn("Chyba při ukládání nastavení do localStorage:", e);
    }
  }

  getLastActiveBookId() {
    return localStorage.getItem("luminareader_last_book_id");
  }

  setLastActiveBookId(bookId) {
    if (bookId) {
      localStorage.setItem("luminareader_last_book_id", bookId);
    } else {
      localStorage.removeItem("luminareader_last_book_id");
    }
  }

  /**
   * Automatická kontrola integrity dat (sanity-check):
   * Pokud celkové tempo čtení překročí 650 WPM nebo jednotlivé relace vykazují poškozená data
   * (umělé stropy/dna <= 150 WPM nebo >= 650 WPM, nafouknutá slova ze skimování),
   * provede se automatická sanitizace a normalizace.
   */
  async sanitizeCorruptedStats() {
    try {
      const allSessions = await this.getAllReadingSessions();
      if (!allSessions || allSessions.length === 0) return { sanitized: false };

      let totalSec = 0;
      let totalWords = 0;
      let hasAnomaly = false;

      for (const s of allSessions) {
        const sec = Math.max(0, s.durationSeconds ?? s.activeSeconds ?? 0);
        const words = Math.max(0, s.wordsRead ?? 0);
        const wpm = s.avgWpm ?? s.wpm ?? 0;
        const min = sec / 60;
        const pace = min > 0.05 ? Math.round(words / min) : wpm;

        totalSec += sec;
        totalWords += words;

        // Detekce anomálií:
        // - wpm ležící na umělých stropech/dnech (<= 150 WPM nebo >= 650 WPM)
        // - tempo slov nad 650 WPM
        // - masivní počty slov při nízkém čase (např. > 5000 slov za < 15 minut)
        // - datum v surovém formátu ISO s časem (obsahující T)
        if (wpm <= 150 || wpm >= 650 || pace > 650 ||
            (words > 5000 && sec < 900) || (min < 0.5 && words > 200) ||
            (typeof s.date === "string" && s.date.includes("T"))) {
          hasAnomaly = true;
        }

        // Kontrola vzorků časové osy
        if (Array.isArray(s.timelineSamples)) {
          for (const sample of s.timelineSamples) {
            const sw = Number(sample.instantaneousWpm || sample.wpm || 0);
            if (sw <= 150 || sw >= 650) {
              hasAnomaly = true;
              break;
            }
          }
        }
      }

      const totalMin = totalSec / 60;
      const globalPace = totalMin > 0.1 ? Math.round(totalWords / totalMin) : 0;

      if (hasAnomaly || globalPace > 650 || (totalWords > 50000 && totalSec < 7200)) {
        console.warn(`[LuminaStorage] Zjištěna poškozená data čtení (${totalWords} slov za ${(totalSec / 60).toFixed(1)} min = ${globalPace} WPM). Spouštím auto-sanitizaci.`);
        const res = await this.recalculateAndNormalizeStats();
        return { sanitized: true, ...res };
      }

      return { sanitized: false };
    } catch (err) {
      console.warn("Chyba při auto-sanitizaci statistik:", err);
      return { sanitized: false, error: err };
    }
  }

  /**
   * Projde všechny čtecí relace a knihy a opraví poškozené / nafouknuté metriky:
   * 1. Odfiltruje historické vzorky v wpmHistory a timelineSamples ležící na umělých stropech/dnech (<= 150 WPM nebo >= 650 WPM).
   * 2. Přepočítá totalWords a avgWpm do realistických hodnot odpovídajících skutečnému odměřenému času čtení (standard 220 WPM).
   * 3. Synchronizuje celkový čas a denní statistiku v sekundách.
   */
  async recalculateAndNormalizeStats() {
    const allSessions = await this.getAllReadingSessions();
    const books = await this.getAllBooks();
    let normalizedCount = 0;

    const dailyReadingMap = {};
    let totalActiveSeconds = 0;
    let totalWords = 0;

    for (const session of allSessions) {
      const durationSec = Math.max(0, session.durationSeconds ?? session.activeSeconds ?? 0);
      const durationMin = durationSec / 60;
      let words = Math.max(0, session.wordsRead || 0);
      let avgWpm = session.avgWpm ?? session.wpm ?? 220;
      let changed = false;

      const calculatedPace = durationMin > 0.05 ? Math.round(words / durationMin) : avgWpm;

      // 1. Detekce a oprava extrémních / zkreslených relací:
      if (avgWpm >= 650 || calculatedPace > 650 || words > Math.round(durationMin * 650) ||
          (durationMin < 0.5 && words > 200) || (words > 5000 && durationSec < 900)) {
        avgWpm = 220;
        words = Math.round(durationMin * 220);
        changed = true;
      } else if (avgWpm <= 150) {
        // Pokud byla relace uměle oříznuta na spodní limit 150 WPM:
        if (calculatedPace >= 80 && calculatedPace <= 650) {
          avgWpm = calculatedPace;
        } else {
          avgWpm = 220;
          if (words > Math.round(durationMin * 250)) {
            words = Math.round(durationMin * 220);
          }
        }
        changed = true;
      } else if (calculatedPace < 80 && durationSec >= 15 && words > 0) {
        avgWpm = 220;
        changed = true;
      }

      // 2. Normalizace a filtrace vzorků v timelineSamples:
      // Odstranit vzorky na umělých stropech/dnech (<= 150 WPM nebo >= 650 WPM)
      const samples = Array.isArray(session.timelineSamples) ? session.timelineSamples : [];
      let samplesChanged = false;
      let cleanedSamples = samples.filter(s => {
        const sw = Number(s.instantaneousWpm || s.wpm || 0);
        if (sw <= 150 || sw >= 650) {
          samplesChanged = true;
          return false;
        }
        return true;
      }).map(s => ({
        timestamp: s.timestamp || session.timestamp || Date.now(),
        elapsedSeconds: Math.max(0, Math.round(s.elapsedSeconds || 0)),
        instantaneousWpm: Math.round(s.instantaneousWpm || s.wpm || avgWpm)
      }));

      // Pokud byly všechny vzorky odfiltrovány kvůli umělým limitům, doplníme validní referenci
      if (cleanedSamples.length === 0 && durationSec >= 15) {
        cleanedSamples = [
          { timestamp: session.timestamp || Date.now(), elapsedSeconds: 0, instantaneousWpm: avgWpm },
          { timestamp: session.timestamp || Date.now(), elapsedSeconds: durationSec, instantaneousWpm: avgWpm }
        ];
        samplesChanged = true;
      }

      // 3. Normalizace data relace do YYYY-MM-DD
      const normalizedDate = this.getLocalDateString(session.date || session.startTime || session.timestamp);
      if (session.date !== normalizedDate) {
        session.date = normalizedDate;
        changed = true;
      }

      if (changed || samplesChanged) {
        session.wordsRead = words;
        session.durationSeconds = durationSec;
        session.activeSeconds = durationSec;
        session.avgWpm = avgWpm;
        session.wpm = avgWpm;
        session.timelineSamples = cleanedSamples;
        await this.saveReadingSession(session);
        normalizedCount++;
      }

      // Akumulace do denní mapy v sekundách
      dailyReadingMap[normalizedDate] = (dailyReadingMap[normalizedDate] || 0) + durationSec;
      totalActiveSeconds += durationSec;
      totalWords += words;
    }

    // Uložit normalizovanou mapu denních časů do localStorage
    try {
      localStorage.setItem("luminareader_daily_reading_time", JSON.stringify(dailyReadingMap));
    } catch (_) {}

    // Celková kontrola: pokud celkový součet slov stále přesahuje 650 WPM, normalizujeme na standard 220 WPM
    const totalMinutes = totalActiveSeconds / 60;
    if (totalMinutes > 0.1 && (totalWords / totalMinutes > 650)) {
      for (const session of allSessions) {
        const sMin = (session.durationSeconds ?? session.activeSeconds ?? 0) / 60;
        session.wordsRead = Math.round(sMin * 220);
        session.avgWpm = 220;
        session.wpm = 220;
        await this.saveReadingSession(session);
      }
    }

    // Normalizovat knihy
    for (const book of books) {
      let bookChanged = false;
      if (book.totalWords > 0 && book.wordsRead > book.totalWords) {
        const prog = book.progressPercent || book.progress || 0;
        book.wordsRead = Math.round((prog / 100) * book.totalWords);
        bookChanged = true;
      }
      if (book.lastWpm && (book.lastWpm <= 150 || book.lastWpm >= 650)) {
        book.lastWpm = 220;
        bookChanged = true;
      }
      if (bookChanged) {
        await this.saveBook(book);
      }
    }

    return { normalizedCount, totalSessions: allSessions.length };
  }

  /**
   * Kompletní bezpečný reset historie čtecích relací a rychlostí
   * Zachovává všechny knihy v knihovně a veškerá uživatelská nastavení
   */
  async resetReadingStats() {
    const db = await this.getDB();
    const stores = [];
    if (db.objectStoreNames.contains("reading_sessions")) stores.push("reading_sessions");
    if (db.objectStoreNames.contains("sessions")) stores.push("sessions");

    if (stores.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        stores.forEach(s => tx.objectStore(s).clear());
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    try {
      localStorage.removeItem("lumina_reading_sessions");
    } catch (_) {}

    // Resetovat slova a rychlost u knih bez smazání samotných knih a jejich postupu
    const books = await this.getAllBooks();
    for (const book of books) {
      book.wordsRead = 0;
      delete book.lastWpm;
      await this.saveBook(book);
    }

    return true;
  }
}

export const storage = new StorageManager();

export async function uploadBook(book) {
  return await storage.uploadBook(book);
}

export async function syncWithCloud(options) {
  return await storage.syncWithCloud(options);
}

export function normalizeBookProgress(book) {
  return storage.normalizeBookProgress(book);
}
