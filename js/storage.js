/**
 * storage.js - Správa trvalého úložiště IndexedDB a LocalStorage.
 * Ukládá knihy (včetně celých souborů a obálek), historii čtení,
 * statistiky a uživatelská nastavení zobrazení a pravítka.
 */

const DB_NAME = "LuminaReaderDB";
const DB_VERSION = 2;

/**
 * Vypočítá deterministický SHA-256 hash z prvních 64 KB souboru a jeho celkové velikosti.
 * @param {File|Blob|ArrayBuffer|Uint8Array} file
 * @returns {Promise<string>}
 */
export async function computeFileHash(file) {
  if (!file) return null;
  let sliceBlob;
  let size = 0;

  if (typeof Blob !== "undefined" && file instanceof Blob) {
    size = file.size;
    sliceBlob = file.slice(0, 65536);
  } else if (file instanceof ArrayBuffer) {
    size = file.byteLength;
    sliceBlob = new Blob([file.slice(0, Math.min(65536, file.byteLength))]);
  } else if (ArrayBuffer.isView(file)) {
    size = file.byteLength;
    sliceBlob = new Blob([file.buffer.slice(file.byteOffset, file.byteOffset + Math.min(65536, file.byteLength))]);
  } else {
    return null;
  }

  const buffer = await sliceBlob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("") + `_${size}`;
}

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
        bookData.pdfRulerConfig = { height: 32, stepSize: 32, autoHeight: true };
      } else {
        bookData.pdfRulerConfig = {
          height: Math.max(16, Math.min(120, Math.round(Number(bookData.pdfRulerConfig.height) || 32))),
          stepSize: Math.max(10, Math.min(120, Math.round(Number(bookData.pdfRulerConfig.stepSize) || 32))),
          autoHeight: bookData.pdfRulerConfig.autoHeight !== undefined ? bookData.pdfRulerConfig.autoHeight !== false : true
        };
      }

      // Výpočet a normalizace hashe pro PDF
      if (!bookData.fileHash && !bookData.file_hash && rawBinary) {
        try {
          const h = await computeFileHash(rawBinary);
          if (h) {
            bookData.fileHash = h;
            bookData.file_hash = h;
          }
        } catch (_) {}
      } else if (bookData.fileHash && !bookData.file_hash) {
        bookData.file_hash = bookData.fileHash;
      } else if (bookData.file_hash && !bookData.fileHash) {
        bookData.fileHash = bookData.file_hash;
      }

      const h = bookData.fileHash || bookData.file_hash;
      if (h) {
        const canonicalId = `pdf_${h}`;
        if (!bookData.id || (bookData.id.startsWith("pdf_") && bookData.id !== canonicalId)) {
          bookData.id = canonicalId;
        }
        if (!bookData.file_path) {
          bookData.file_path = `books/${canonicalId}.pdf`;
        }
      }

      // Kontrola duplicit v IndexedDB: pokud již existuje záznam se stejným ID nebo obsahem
      const existing = await this.findBookByIdOrHash(bookData.id, h);
      if (existing && existing.id !== bookData.id) {
        console.log(`[StorageManager] Nalezen existující záznam PDF (${existing.id}) pro ukládanou knihu (${bookData.id}), slučuji...`);
        const existingTime = existing.lastReadAt || existing.addedAt || 0;
        const newTime = bookData.lastReadAt || bookData.addedAt || 0;
        if (existingTime > newTime) {
          bookData.currentChapterIndex = existing.currentChapterIndex;
          bookData.currentPageIndex = existing.currentPageIndex;
          bookData.currentPage = existing.currentPage;
          bookData.scrollPercent = existing.scrollPercent;
          bookData.progress = existing.progress;
          bookData.progressPercent = existing.progressPercent;
          bookData.lastReadAt = existing.lastReadAt;
        }
        bookData.addedAt = Math.min(existing.addedAt || Date.now(), bookData.addedAt || Date.now());
        await this.deleteBookRaw(existing.id);
        await this.migrateSessionsBookId(existing.id, bookData.id);
        this.migrateLocalStorageProgress(existing.id, bookData.id);
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

  async findBookByIdOrHash(id, fileHash) {
    const books = await this.getAllBooks();
    if (!books || books.length === 0) return null;

    if (id) {
      const byId = books.find(b => b.id === id);
      if (byId) return byId;
    }

    if (fileHash) {
      const byHash = books.find(b =>
        b.fileHash === fileHash ||
        b.file_hash === fileHash ||
        b.id === `pdf_${fileHash}` ||
        (b.id && b.id.includes(fileHash))
      );
      if (byHash) return byHash;

      for (const b of books) {
        if (b.isPdf && (b.data || b.fileData) && !b.fileHash) {
          try {
            const h = await computeFileHash(b.data || b.fileData);
            if (h) {
              b.fileHash = h;
              b.file_hash = h;
              if (h === fileHash) {
                this.saveBookRaw(b).catch(() => {});
                return b;
              }
            }
          } catch (_) {}
        }
      }
    }

    return null;
  }

  async uploadBook(book) {
    const { supabaseSync } = await import("./supabase-sync.js");
    return await supabaseSync.uploadBook(book);
  }

  async syncWithCloud(options) {
    try {
      const { supabaseSync } = await import("./supabase-sync.js");
      return await supabaseSync.syncAll(options);
    } catch (err) {
      console.warn("[StorageManager] syncWithCloud selhal:", err);
      return { success: false, reason: "sync_failed" };
    }
  }

  async pushReadingSessionAndStatsToCloud(session) {
    try {
      const { supabaseSync } = await import("./supabase-sync.js");
      return await supabaseSync.pushSessionAndStats(session);
    } catch (err) {
      console.warn("[StorageManager] pushReadingSessionAndStatsToCloud selhal:", err);
      return null;
    }
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
    const autoHeight = config?.autoHeight !== undefined
      ? config.autoHeight !== false
      : (book.pdfRulerConfig?.autoHeight !== undefined ? book.pdfRulerConfig.autoHeight !== false : true);
    book.pdfRulerConfig = { height, stepSize, autoHeight };
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
   * Ukládá POUZE validní relace s délkou alespoň 5 minut (>= 300 sekund).
   * @param {Object} sessionData
   */
  async saveReadingSession(sessionData) {
    if (!sessionData) return null;

    const durationSeconds = Math.max(0, Math.round(sessionData.durationSeconds ?? sessionData.activeSeconds ?? sessionData.duration ?? 0));
    // Striktní vynucení minimálního prahu 5 minut pro uložení do historie relací
    if (durationSeconds < 300) {
      return null;
    }

    const db = await this.getDB();
    const timestamp = sessionData.timestamp || (sessionData.startTime ? new Date(sessionData.startTime).getTime() : Date.now());
    const startTime = sessionData.startTime || new Date(timestamp - (durationSeconds * 1000)).toISOString();
    const endTime = sessionData.endTime || new Date(timestamp).toISOString();
    let wordsRead = Math.max(0, Math.round(sessionData.words_read ?? sessionData.wordsRead ?? 0));

    // Striktní výpočet průměrného WPM podle vzorce: duration >= 10 ? Math.round((words_read / duration) * 60) : 0
    const avgWpm = durationSeconds >= 10 ? Math.round((wordsRead / durationSeconds) * 60) : 0;

    const localDate = this.getLocalDateString(sessionData.date || startTime || timestamp);
    const sessionId = sessionData.sessionId || sessionData.id || `session_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

    // Filtrace a normalizace 1-minutových vzorků intra_session_samples (bez umělých 220 WPM seed bodů na 0s)
    const rawSamples = Array.isArray(sessionData.intra_session_samples || sessionData.intraSessionSamples || sessionData.timelineSamples) 
      ? (sessionData.intra_session_samples || sessionData.intraSessionSamples || sessionData.timelineSamples) 
      : [];
    const cleanedSamples = this._cleanIntraSessionSamples(rawSamples, durationSeconds, wordsRead, avgWpm, timestamp);

    // Výpočet špičkové rychlosti: striktně z dokončených 60s minut (bez isPartial)
    const fullMinuteSamples = cleanedSamples.filter(s => !s.isPartial);
    const validSpeeds = fullMinuteSamples.map(s => s.wpm).filter(w => w > 0);
    const peakWpm = validSpeeds.length > 0 
      ? Math.max(...validSpeeds) 
      : (sessionData.peak_wpm ?? sessionData.peakWpm ?? avgWpm);

    const updatedAt = sessionData.updatedAt || sessionData.updated_at || new Date().toISOString();

    const normalizedSession = {
      sessionId,
      id: sessionId,
      bookId: sessionData.bookId || sessionData.book_id || "",
      bookTitle: sessionData.bookTitle || sessionData.book_title || "",
      chapterIndex: sessionData.chapterIndex ?? sessionData.chapter_index ?? 0,
      startTime,
      endTime,
      durationSeconds,
      activeSeconds: durationSeconds,
      duration: durationSeconds,
      wordsRead,
      words_read: wordsRead,
      avgWpm,
      avg_wpm: avgWpm,
      peakWpm,
      peak_wpm: peakWpm,
      wpm: avgWpm,
      timelineSamples: cleanedSamples,
      intraSessionSamples: cleanedSamples,
      intra_session_samples: cleanedSamples,
      date: localDate,
      timestamp,
      updatedAt
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

  /**
   * Smaže čtecí relaci z IndexedDB i localStorage
   */
  async deleteReadingSession(sessionId) {
    if (!sessionId) return;
    const db = await this.getDB();
    return new Promise((resolve) => {
      const stores = [];
      if (db.objectStoreNames.contains("reading_sessions")) stores.push("reading_sessions");
      if (db.objectStoreNames.contains("sessions")) stores.push("sessions");

      if (stores.length === 0) {
        this._removeSessionFromLocalStorage(sessionId);
        return resolve();
      }

      const tx = db.transaction(stores, "readwrite");
      if (db.objectStoreNames.contains("reading_sessions")) {
        tx.objectStore("reading_sessions").delete(sessionId);
      }
      if (db.objectStoreNames.contains("sessions")) {
        const sStore = tx.objectStore("sessions");
        const req = sStore.getAll();
        req.onsuccess = () => {
          for (const row of (req.result || [])) {
            if (row.sessionId === sessionId || row.id === sessionId) {
              sStore.delete(row.id);
            }
          }
        };
      }

      tx.oncomplete = () => {
        this._removeSessionFromLocalStorage(sessionId);
        resolve();
      };
      tx.onerror = () => {
        this._removeSessionFromLocalStorage(sessionId);
        resolve();
      };
    });
  }

  _removeSessionFromLocalStorage(sessionId) {
    try {
      const raw = localStorage.getItem("lumina_reading_sessions");
      if (raw) {
        const list = JSON.parse(raw);
        const filtered = list.filter(s => s.sessionId !== sessionId && s.id !== sessionId);
        localStorage.setItem("lumina_reading_sessions", JSON.stringify(filtered));
      }
    } catch (_) {}
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
        // Filtrovat pouze relace s aktivní dobou alespoň 5 minut (>= 300 sekund)
        results = results.filter(s => {
          const dur = Math.max(0, Math.round(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0));
          return dur >= 300;
        });
        // Seřadit sestupně (nejnovější nahoře)
        results.sort((a, b) => (b.timestamp || new Date(b.startTime).getTime() || 0) - (a.timestamp || new Date(a.startTime).getTime() || 0));
        resolve(results);
      };

      request.onerror = () => {
        try {
          const raw = localStorage.getItem("lumina_reading_sessions");
          if (raw) {
            const parsed = JSON.parse(raw);
            return resolve(parsed.filter(s => (s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0) >= 300));
          }
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
        pdfAutoHeight: true, // Automatická výška pravítka pro PDF (výchozí zapnuto)
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
        const savedPdfAuto = localStorage.getItem("rulerPdfAutoHeight");
        if (savedPdfAuto !== null) {
          merged.ruler.pdfAutoHeight = savedPdfAuto === "true";
        } else if (parsed.ruler?.pdfAutoHeight !== undefined) {
          merged.ruler.pdfAutoHeight = parsed.ruler.pdfAutoHeight !== false;
        } else {
          merged.ruler.pdfAutoHeight = true;
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
    if (key === "rulerPdfAutoHeight") {
      const stored = localStorage.getItem("rulerPdfAutoHeight");
      if (stored !== null) {
        return stored === "true";
      }
      const settings = this.getSettings();
      if (settings?.ruler?.pdfAutoHeight !== undefined) {
        return settings.ruler.pdfAutoHeight !== false;
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
      } else if (key === "rulerPdfAutoHeight") {
        if (!settings.ruler) settings.ruler = {};
        settings.ruler.pdfAutoHeight = value !== false;
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
        if (settings.ruler.pdfAutoHeight !== undefined) {
          localStorage.setItem("rulerPdfAutoHeight", String(settings.ruler.pdfAutoHeight !== false));
        }
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
   * Pomocná metoda pro vyčištění intra_session_samples:
   * - Odstraní umělé počáteční 220 WPM seed body (body v čase 0s nebo počáteční plochou sérii 220 WPM).
   * - Normalizuje vzorky na čisté 1-minutové intervaly { minute, elapsedSeconds, t, words, wpm }.
   */
  _cleanIntraSessionSamples(rawSamples, durationSec, wordsRead, avgWpm, fallbackTimestamp = Date.now()) {
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      return [];
    }

    // 1. Odstranit body s elapsedSeconds <= 0 (počáteční 0s seed) a neplatné hodnoty
    let list = rawSamples.map((s, idx) => {
      const sec = Math.round(Number(s.elapsedSeconds ?? s.t ?? (s.minute ? s.minute * 60 : (idx + 1) * 60)));
      const wpm = Math.round(Number(s.wpm ?? s.instantaneousWpm ?? 0));
      const words = s.words !== undefined ? Math.round(Number(s.words)) : wpm;
      const minute = Number(s.minute) > 0 ? Number(s.minute) : Math.max(1, Math.ceil(sec / 60));
      return {
        minute,
        elapsedSeconds: sec,
        t: sec,
        words: Math.max(0, words),
        wpm: Math.max(0, wpm),
        instantaneousWpm: Math.max(0, wpm),
        timestamp: s.timestamp || fallbackTimestamp,
        isPartial: !!s.isPartial
      };
    }).filter(s => s.elapsedSeconds > 0 && s.wpm >= 0 && s.wpm <= 1000);

    // 2. Odstranit počáteční umělé ploché 220 WPM seed body
    // (pokud na začátku relace leží sekvence bodů s přesně 220 WPM a průměr relace je odlišný nebo následují reálné body)
    let leading220Count = 0;
    while (leading220Count < list.length && list[leading220Count].wpm === 220) {
      leading220Count++;
    }
    if (leading220Count > 0) {
      const hasNon220After = leading220Count < list.length;
      const avgDiffersFrom220 = Math.abs(avgWpm - 220) > 5;
      if (leading220Count >= 2 || (leading220Count === 1 && (hasNon220After || avgDiffersFrom220))) {
        list = list.slice(leading220Count);
      }
    }

    // 3. Seřadit vzestupně podle času a deduplikovat
    list.sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
    const deduped = [];
    for (const item of list) {
      if (deduped.length === 0 || deduped[deduped.length - 1].elapsedSeconds !== item.elapsedSeconds) {
        deduped.push(item);
      } else {
        deduped[deduped.length - 1] = item;
      }
    }

    // 4. Detekce a normalizace koncové neúplné minuty (trailing partial minute)
    if (deduped.length >= 2) {
      const lastIndex = deduped.length - 1;
      const last = deduped[lastIndex];
      const prev = deduped[lastIndex - 1];

      let partialSec = 0;
      if (durationSec > 0 && (durationSec % 60 !== 0) && Math.abs(last.elapsedSeconds - durationSec) <= 5) {
        partialSec = durationSec % 60;
      } else if (last.elapsedSeconds > prev.elapsedSeconds && (last.elapsedSeconds - prev.elapsedSeconds) < 60) {
        partialSec = last.elapsedSeconds - prev.elapsedSeconds;
      } else if (last.isPartial && durationSec > 0 && (durationSec % 60 !== 0)) {
        partialSec = durationSec % 60;
      }

      const isTrailingPartial = last.isPartial || (partialSec > 0 && partialSec < 60) || (last.elapsedSeconds % 60 !== 0);

      if (isTrailingPartial) {
        if (partialSec > 0 && partialSec < 20) {
          // Aktivní sekundy < 20: nepřipojovat samostatný bod grafu
          deduped.pop();
        } else {
          last.isPartial = true;
          // Pokud byl bod extrapolován a překračuje předchozí minutu o více než 1.5x
          if (prev.wpm > 0 && last.wpm > prev.wpm * 1.5) {
            let actualWords = last.words;
            if (actualWords >= last.wpm && partialSec >= 20 && partialSec < 60) {
              actualWords = Math.round((last.wpm * partialSec) / 60);
            }
            last.words = Math.max(0, Math.round(actualWords));
            last.wpm = Math.min(last.words, Math.round(prev.wpm * 1.5));
            last.instantaneousWpm = last.wpm;
          }
        }
      }
    }

    return deduped;
  }

  /**
   * Automatická kontrola integrity dat (sanity-check):
   * Detekuje relace s nekonzistentním avg_wpm / peak_wpm nebo s umělými 220 WPM seed body
   * a automaticky je opraví.
   */
  async sanitizeCorruptedStats() {
    try {
      const allSessions = await this.getAllReadingSessions();
      if (!allSessions || allSessions.length === 0) return { sanitized: false };

      let hasAnomaly = false;

      for (const s of allSessions) {
        const sec = Math.max(0, Math.round(s.duration ?? s.durationSeconds ?? s.activeSeconds ?? 0));
        const words = Math.max(0, Math.round(s.words_read ?? s.wordsRead ?? 0));
        const storedAvg = s.avg_wpm ?? s.avgWpm ?? s.wpm ?? 0;
        const expectedAvg = sec >= 10 ? Math.round((words / sec) * 60) : 0;

        if (sec < 300 || storedAvg !== expectedAvg || (typeof s.date === "string" && s.date.includes("T"))) {
          hasAnomaly = true;
          break;
        }

        const samples = Array.isArray(s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
          ? (s.intra_session_samples || s.intraSessionSamples || s.timelineSamples)
          : [];
        if (samples.some(pt => (Number(pt.elapsedSeconds ?? pt.t ?? 60) <= 0) || (Number(pt.wpm) === 220 && Math.abs(expectedAvg - 220) > 10))) {
          hasAnomaly = true;
          break;
        }

        // Kontrola neúplné koncové minuty s přestřeleným WPM
        if (samples.length >= 2) {
          const last = samples[samples.length - 1];
          const prev = samples[samples.length - 2];
          if ((last.isPartial || (sec % 60 !== 0)) && prev.wpm > 0 && last.wpm > prev.wpm * 1.5) {
            hasAnomaly = true;
            break;
          }
        }

        const fullMinuteSamples = samples.filter(pt => !pt.isPartial);
        const speeds = fullMinuteSamples.map(pt => Number(pt.wpm) || 0).filter(w => w > 0);
        const expectedPeak = speeds.length > 0 ? Math.max(...speeds) : expectedAvg;
        const storedPeak = s.peak_wpm ?? s.peakWpm ?? 0;
        if (storedPeak !== expectedPeak) {
          hasAnomaly = true;
          break;
        }
      }

      if (hasAnomaly) {
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
   * Projde všechny čtecí relace v localStorage i IndexedDB a sjednotí jejich metriky:
   * 1. Odstraní umělé počáteční 220 WPM ploché seed body z intra_session_samples.
   * 2. Přepočítá avg_wpm = Math.round((session.words_read / session.duration) * 60) a peak_wpm z vyčištěných vzorků.
   * 3. Přepočítá celkový souhrn (reading_stats_summary a denní časy) z opravených relací.
   */
  async recalculateAndNormalizeStats() {
    const allSessions = await this.getAllReadingSessions();
    const books = await this.getAllBooks();
    let normalizedCount = 0;

    const dailyReadingMap = {};
    let totalActiveSeconds = 0;
    let totalWords = 0;

    for (const session of allSessions) {
      const durationSec = Math.max(0, Math.round(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
      // Úplné odstranění relací nesplňujících minimální práh 5 minut (300 sekund)
      if (durationSec < 300) {
        await this.deleteReadingSession(session.sessionId || session.id);
        normalizedCount++;
        continue;
      }

      const words = Math.max(0, Math.round(session.words_read ?? session.wordsRead ?? 0));
      const avgWpm = durationSec >= 10 ? Math.round((words / durationSec) * 60) : 0;

      const rawSamples = Array.isArray(session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
        ? (session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
        : [];
      const fallbackTs = session.timestamp || (session.startTime ? new Date(session.startTime).getTime() : Date.now());
      let cleanedSamples = this._cleanIntraSessionSamples(rawSamples, durationSec, words, avgWpm, fallbackTs);

      // Pokud po odstranění falešných 220 WPM bodů nezůstaly žádné vzorky, vygenerujeme čisté 1-minutové body odpovídající relaci
      if (cleanedSamples.length === 0 && durationSec >= 60 && words > 0) {
        const fullMins = Math.floor(durationSec / 60);
        for (let m = 1; m <= fullMins; m++) {
          cleanedSamples.push({
            minute: m,
            elapsedSeconds: m * 60,
            t: m * 60,
            words: avgWpm,
            wpm: avgWpm,
            instantaneousWpm: avgWpm,
            timestamp: fallbackTs,
            isPartial: false
          });
        }
        const remSec = durationSec - fullMins * 60;
        if (remSec >= 20) {
          const partialWords = Math.round((avgWpm * remSec) / 60);
          cleanedSamples.push({
            minute: fullMins + 1,
            elapsedSeconds: durationSec,
            t: durationSec,
            words: partialWords,
            wpm: partialWords, // Bez extrapolace
            instantaneousWpm: partialWords,
            timestamp: fallbackTs,
            isPartial: true
          });
        }
      }

      // Explicitní normalizace koncových neúplných minut v historických relacích:
      // Pokud byl poslední vzorek extrapolovaný dílčí minutový bod překračující předchozí minutu o více než 1.5x,
      // zastropovat / přepočítat jej a aktualizovat peak_wpm na nejvyšší vzorek z PLNÝCH minut.
      if (cleanedSamples.length >= 2) {
        const lastIdx = cleanedSamples.length - 1;
        const last = cleanedSamples[lastIdx];
        const prev = cleanedSamples[lastIdx - 1];
        let partialSec = 0;
        if (durationSec > 0 && (durationSec % 60 !== 0) && Math.abs(last.elapsedSeconds - durationSec) <= 5) {
          partialSec = durationSec % 60;
        } else if (last.elapsedSeconds > prev.elapsedSeconds && (last.elapsedSeconds - prev.elapsedSeconds) < 60) {
          partialSec = last.elapsedSeconds - prev.elapsedSeconds;
        } else if (last.isPartial && durationSec > 0 && (durationSec % 60 !== 0)) {
          partialSec = durationSec % 60;
        }

        const isTrailingPartial = last.isPartial || (partialSec > 0 && partialSec < 60) || (last.elapsedSeconds % 60 !== 0);

        if (isTrailingPartial) {
          if (partialSec > 0 && partialSec < 20) {
            cleanedSamples.pop();
          } else {
            last.isPartial = true;
            if (prev.wpm > 0 && last.wpm > prev.wpm * 1.5) {
              let actualWords = last.words;
              if (actualWords >= last.wpm && partialSec >= 20 && partialSec < 60) {
                actualWords = Math.round((last.wpm * partialSec) / 60);
              }
              last.words = Math.max(0, Math.round(actualWords));
              last.wpm = Math.min(last.words, Math.round(prev.wpm * 1.5));
              last.instantaneousWpm = last.wpm;
            }
          }
        }
      }

      // Výpočet špičkové rychlosti (peak_wpm) striktně z dokončených celých 60s minut:
      const fullMinuteSamples = cleanedSamples.filter(s => !s.isPartial);
      const fullMinuteSpeeds = fullMinuteSamples.map(s => s.wpm).filter(w => w > 0);
      const peakWpm = fullMinuteSpeeds.length > 0
        ? Math.max(...fullMinuteSpeeds)
        : avgWpm;

      const normalizedDate = this.getLocalDateString(session.date || session.startTime || session.timestamp);
      const prevAvg = session.avg_wpm ?? session.avgWpm ?? session.wpm;
      const prevPeak = session.peak_wpm ?? session.peakWpm;

      const changed = (
        prevAvg !== avgWpm ||
        prevPeak !== peakWpm ||
        session.date !== normalizedDate ||
        cleanedSamples.length !== rawSamples.length ||
        session.words_read !== words ||
        session.duration !== durationSec
      );

      session.wordsRead = words;
      session.words_read = words;
      session.durationSeconds = durationSec;
      session.activeSeconds = durationSec;
      session.duration = durationSec;
      session.avgWpm = avgWpm;
      session.avg_wpm = avgWpm;
      session.wpm = avgWpm;
      session.peakWpm = peakWpm;
      session.peak_wpm = peakWpm;
      session.timelineSamples = cleanedSamples;
      session.intraSessionSamples = cleanedSamples;
      session.intra_session_samples = cleanedSamples;
      session.date = normalizedDate;
      session.updatedAt = new Date().toISOString();

      await this.saveReadingSession(session);
      if (changed) {
        normalizedCount++;
      }

      // Akumulace do denní mapy v sekundách
      dailyReadingMap[normalizedDate] = (dailyReadingMap[normalizedDate] || 0) + durationSec;
      totalActiveSeconds += durationSec;
      totalWords += words;
    }

    // Uložit normalizovanou mapu denních časů a reading_stats_summary do localStorage
    try {
      localStorage.setItem("luminareader_daily_reading_time", JSON.stringify(dailyReadingMap));
      const globalAvgWpm = totalActiveSeconds > 0 ? Math.round((totalWords / totalActiveSeconds) * 60) : 0;
      const summaryObj = {
        id: "global",
        total_words_read: totalWords,
        totalWordsRead: totalWords,
        total_reading_seconds: totalActiveSeconds,
        totalReadingSeconds: totalActiveSeconds,
        global_avg_wpm: globalAvgWpm,
        globalAvgWpm: globalAvgWpm,
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem("reading_stats_summary", JSON.stringify(summaryObj));
    } catch (_) {}

    // Opravit případný přestřelený počet slov u knih (bez přepisování lastWpm na 220)
    for (const book of books) {
      let bookChanged = false;
      if (book.totalWords > 0 && book.wordsRead > book.totalWords) {
        const prog = book.progressPercent || book.progress || 0;
        book.wordsRead = Math.round((prog / 100) * book.totalWords);
        bookChanged = true;
      }
      if (book.lastWpm === 220) {
        delete book.lastWpm;
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

  async deleteBookRaw(id) {
    if (!id) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      store.delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveBookRaw(bookData) {
    if (!bookData) return null;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      store.put(bookData);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async migrateSessionsBookId(oldBookId, newBookId) {
    if (!oldBookId || !newBookId || oldBookId === newBookId) return;
    const db = await this.getDB();
    const storeNames = [];
    if (db.objectStoreNames.contains("sessions")) storeNames.push("sessions");
    if (db.objectStoreNames.contains("reading_sessions")) storeNames.push("reading_sessions");
    if (storeNames.length === 0) return;

    return new Promise((resolve) => {
      const tx = db.transaction(storeNames, "readwrite");
      storeNames.forEach(storeName => {
        const store = tx.objectStore(storeName);
        if (store.indexNames.contains("bookId")) {
          const index = store.index("bookId");
          const req = index.openCursor(IDBKeyRange.only(oldBookId));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const val = { ...cursor.value, bookId: newBookId };
              cursor.update(val);
              cursor.continue();
            }
          };
        }
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  migrateLocalStorageProgress(oldBookId, newBookId) {
    if (!oldBookId || !newBookId || oldBookId === newBookId) return;
    try {
      const oldProgress = localStorage.getItem(`lumina_progress_${oldBookId}`);
      if (oldProgress && !localStorage.getItem(`lumina_progress_${newBookId}`)) {
        localStorage.setItem(`lumina_progress_${newBookId}`, oldProgress);
      }
      localStorage.removeItem(`lumina_progress_${oldBookId}`);
    } catch (_) {}
  }

  /**
   * Prohledá IndexedDB a sloučí/odstraní duplicitní záznamy PDF dokumentů.
   * Ponechá záznam s nejaktuálnějším postupem čtení a statistikami.
   * EPUB knihy zůstávají 100% nedotčeny.
   */
  async deduplicateBooks() {
    const books = await this.getAllBooks();
    if (!books || books.length === 0) return [];

    const pdfGroups = new Map();

    for (const b of books) {
      if (!b.isPdf && b.format !== "pdf") continue;

      let hash = b.fileHash || b.file_hash;
      if (!hash && (b.data || b.fileData)) {
        try {
          hash = await computeFileHash(b.data || b.fileData);
          if (hash) {
            b.fileHash = hash;
            b.file_hash = hash;
          }
        } catch (_) {}
      }

      const groupKey = hash
        ? `hash_${hash}`
        : `name_${(b.fileName || b.file_name || b.title || "").toLowerCase().trim()}`;

      if (!pdfGroups.has(groupKey)) {
        pdfGroups.set(groupKey, []);
      }
      pdfGroups.get(groupKey).push(b);
    }

    let hasChanges = false;

    for (const [key, group] of pdfGroups.entries()) {
      if (group.length === 1) {
        const book = group[0];
        const hash = book.fileHash || book.file_hash;
        if (hash && book.id !== `pdf_${hash}`) {
          const oldId = book.id;
          const canonicalId = `pdf_${hash}`;
          console.log(`[StorageManager] Normalizuji ID PDF knihy "${book.title}": ${oldId} -> ${canonicalId}`);
          await this.deleteBookRaw(oldId);
          book.id = canonicalId;
          book.file_path = `books/${canonicalId}.pdf`;
          await this.saveBookRaw(book);
          await this.migrateSessionsBookId(oldId, canonicalId);
          this.migrateLocalStorageProgress(oldId, canonicalId);
          if (this.getLastActiveBookId() === oldId) {
            this.setLastActiveBookId(canonicalId);
          }
          hasChanges = true;
        }
        continue;
      }

      // Duplikáty nalezeny! Seřadit podle nejnovějšího postupu čtení
      console.log(`[StorageManager] Slučuji ${group.length} duplicitních záznamů PDF pro ${key}`);
      group.sort((a, b) => {
        const timeA = a.lastReadAt || a.addedAt || 0;
        const timeB = b.lastReadAt || b.addedAt || 0;
        if (timeB !== timeA) return timeB - timeA;
        const progA = a.progressPercent || a.progress || 0;
        const progB = b.progressPercent || b.progress || 0;
        if (progB !== progA) return progB - progA;
        return (b.currentPage || 0) - (a.currentPage || 0);
      });

      const winner = group[0];
      const losers = group.slice(1);
      const hash = winner.fileHash || winner.file_hash;
      const canonicalId = hash ? `pdf_${hash}` : winner.id;

      for (const loser of losers) {
        console.log(`[StorageManager] Mazání duplikátu PDF: ${loser.id} (strana ${loser.currentPage || 1})`);
        await this.deleteBookRaw(loser.id);
        await this.migrateSessionsBookId(loser.id, canonicalId);
        this.migrateLocalStorageProgress(loser.id, canonicalId);
      }

      if (winner.id !== canonicalId) {
        const oldWinnerId = winner.id;
        await this.deleteBookRaw(oldWinnerId);
        winner.id = canonicalId;
        await this.migrateSessionsBookId(oldWinnerId, canonicalId);
        this.migrateLocalStorageProgress(oldWinnerId, canonicalId);
      }

      winner.file_path = `books/${canonicalId}.pdf`;
      await this.saveBookRaw(winner);

      const lastActive = this.getLastActiveBookId();
      if (losers.some(l => l.id === lastActive) || lastActive === winner.id) {
        this.setLastActiveBookId(canonicalId);
      }

      hasChanges = true;
    }

    return hasChanges ? await this.getAllBooks() : books;
  }
}

export const storage = new StorageManager();

export async function uploadBook(book) {
  return await storage.uploadBook(book);
}

export async function syncWithCloud(options) {
  return await storage.syncWithCloud(options);
}

export async function pushReadingSessionAndStatsToCloud(session) {
  return await storage.pushReadingSessionAndStatsToCloud(session);
}

export function normalizeBookProgress(book) {
  return storage.normalizeBookProgress(book);
}

export async function deduplicateBooks() {
  return await storage.deduplicateBooks();
}
