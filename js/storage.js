/**
 * storage.js - Správa trvalého úložiště IndexedDB a LocalStorage.
 * Ukládá knihy (včetně celých souborů a obálek), historii čtení,
 * statistiky a uživatelská nastavení zobrazení a pravítka.
 */

const DB_NAME = "LuminaReaderDB";
const DB_VERSION = 3;

/**
 * Zjistí, zda zařízení podporuje dotykový vstup (iPad, tablet, mobilní telefon).
 * @returns {boolean}
 */
export function isTouchCapableDevice() {
  if (typeof window === "undefined") return false;
  try {
    const hasTouchPoints = typeof navigator !== "undefined" && (
      (navigator.maxTouchPoints || 0) > 0 ||
      (navigator.msMaxTouchPoints || 0) > 0
    );
    const hasTouchEvent = "ontouchstart" in window || (typeof DocumentTouch !== "undefined" && document instanceof DocumentTouch);
    const hasCoarsePointer = typeof window.matchMedia === "function" && (
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(any-pointer: coarse)").matches
    );
    return !!(hasTouchPoints || hasTouchEvent || hasCoarsePointer);
  } catch (_) {
    return false;
  }
}

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

        // Úložiště pro metadata knih (zachováno napříč aktualizacemi verze)
        if (!db.objectStoreNames.contains("books")) {
          const bookStore = db.createObjectStore("books", { keyPath: "id" });
          bookStore.createIndex("addedAt", "addedAt", { unique: false });
          bookStore.createIndex("lastReadAt", "lastReadAt", { unique: false });
        }

        // Vyhrazené úložiště pro binární soubory knih (EPUB/PDF) – zachováno napříč aktualizacemi
        if (!db.objectStoreNames.contains("book_files")) {
          db.createObjectStore("book_files", { keyPath: "bookId" });
        }

        // Vyhrazené úložiště pro lokálně cachované obálky knih (podle bookId a coverHash)
        if (!db.objectStoreNames.contains("covers")) {
          const coverStore = db.createObjectStore("covers", { keyPath: "bookId" });
          coverStore.createIndex("coverHash", "coverHash", { unique: false });
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
        this.db.onversionchange = () => {
          try {
            this.db.close();
          } catch (_) {}
          this.db = null;
        };
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
    try {
      this.db = await this.initPromise;
      return this.db;
    } catch (err) {
      console.warn("[storage] IndexedDB nedostupná nebo selhala:", err);
      return null;
    }
  }

  // --- KNIHY (BOOKS), BINÁRNÍ SOUBORY (BOOK_FILES) A OBÁLKY (COVERS) ---

  async normalizeBinaryToArrayBuffer(rawBinary) {
    if (!rawBinary) return null;
    if (rawBinary instanceof ArrayBuffer) {
      return rawBinary;
    }
    if (typeof Blob !== "undefined" && rawBinary instanceof Blob) {
      return await rawBinary.arrayBuffer();
    }
    if (ArrayBuffer.isView(rawBinary)) {
      return rawBinary.buffer.slice(rawBinary.byteOffset, rawBinary.byteOffset + rawBinary.byteLength);
    }
    return null;
  }

  async _getBookRecordRaw(id) {
    if (!id) return null;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("books")) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("books", "readonly");
        const req = tx.objectStore("books").get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async _saveBookFileRaw(bookId, rawBinary, meta = {}) {
    if (!bookId || !rawBinary) return false;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("book_files")) return false;
    const buffer = await this.normalizeBinaryToArrayBuffer(rawBinary);
    if (!buffer) return false;

    const record = {
      bookId,
      data: buffer,
      fileSize: Number(meta.fileSize ?? buffer.byteLength) || buffer.byteLength,
      fileHash: meta.fileHash || meta.file_hash || null,
      updatedAt: Date.now()
    };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction("book_files", "readwrite");
        tx.objectStore("book_files").put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async saveBookFile(bookId, rawBinary, meta = {}) {
    if (!bookId || !rawBinary) return null;
    const buffer = await this.normalizeBinaryToArrayBuffer(rawBinary);
    if (!buffer) return null;

    let fileHash = meta.fileHash || meta.file_hash || null;
    if (!fileHash) {
      try {
        fileHash = await computeFileHash(buffer);
      } catch (_) {}
    }
    const fileSize = buffer.byteLength;
    const saved = await this._saveBookFileRaw(bookId, buffer, { fileHash, fileSize });
    if (!saved) return null;

    const existing = await this._getBookRecordRaw(bookId);
    if (existing) {
      const updated = {
        ...existing,
        hasLocalFile: true,
        fileSize,
        file_size: fileSize,
        fileHash: fileHash || existing.fileHash || existing.file_hash || null,
        file_hash: fileHash || existing.file_hash || existing.fileHash || null
      };
      delete updated.data;
      delete updated.fileData;
      await this.saveBookRaw(updated);
    }

    return { bookId, fileSize, fileHash };
  }

  async getCachedBookFileIds() {
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("book_files")) {
      return new Set();
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("book_files", "readonly");
        const store = tx.objectStore("book_files");
        const req = typeof store.getAllKeys === "function" ? store.getAllKeys() : null;
        if (req) {
          req.onsuccess = () => resolve(new Set(req.result || []));
          req.onerror = () => resolve(new Set());
        } else {
          const keys = [];
          const cursorReq = store.openKeyCursor();
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              keys.push(cursor.key);
              cursor.continue();
            } else {
              resolve(new Set(keys));
            }
          };
          cursorReq.onerror = () => resolve(new Set());
        }
      } catch (_) {
        resolve(new Set());
      }
    });
  }

  async hasBookFile(bookId) {
    if (!bookId) return false;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames) return false;

    if (db.objectStoreNames.contains("book_files")) {
      const inFilesStore = await new Promise((resolve) => {
        try {
          const tx = db.transaction("book_files", "readonly");
          const req = tx.objectStore("book_files").count(bookId);
          req.onsuccess = () => resolve((req.result || 0) > 0);
          req.onerror = () => resolve(false);
        } catch (_) {
          resolve(false);
        }
      });
      if (inFilesStore) return true;
    }

    const legacy = await this._getBookRecordRaw(bookId);
    return Boolean(legacy && (legacy.fileData || legacy.data));
  }

  async getBookFile(bookId) {
    if (!bookId) return null;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames) return null;

    if (db.objectStoreNames.contains("book_files")) {
      const fileRecord = await new Promise((resolve) => {
        try {
          const tx = db.transaction("book_files", "readonly");
          const req = tx.objectStore("book_files").get(bookId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
      if (fileRecord?.data) {
        return await this.normalizeBinaryToArrayBuffer(fileRecord.data);
      }
    }

    // Zpětná kompatibilita pro starší knihy uložené přímo ve store "books" (DB v2)
    const legacyBook = await this._getBookRecordRaw(bookId);
    const legacyBinary = legacyBook && (legacyBook.fileData || legacyBook.data);
    if (legacyBinary) {
      const buffer = await this.normalizeBinaryToArrayBuffer(legacyBinary);
      if (buffer) {
        // Líná migrace do vyhrazeného store "book_files" bez blokování otevření knihy
        this._saveBookFileRaw(bookId, buffer, {
          fileSize: buffer.byteLength,
          fileHash: legacyBook.fileHash || legacyBook.file_hash || null
        }).then(async (migrated) => {
          if (migrated) {
            const cleanMeta = {
              ...legacyBook,
              hasLocalFile: true,
              fileSize: legacyBook.fileSize || buffer.byteLength,
              file_size: legacyBook.file_size || buffer.byteLength
            };
            delete cleanMeta.data;
            delete cleanMeta.fileData;
            await this.saveBookRaw(cleanMeta);
          }
        }).catch(() => {});
        return buffer;
      }
    }

    return null;
  }

  async saveBookCover(bookId, coverInfo) {
    if (!bookId || !coverInfo) return false;
    const dataUrl = typeof coverInfo === "string" ? coverInfo : coverInfo.dataUrl;
    if (!dataUrl) return false;

    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("covers")) return false;

    const record = {
      bookId,
      dataUrl,
      coverHash: (typeof coverInfo === "object" ? (coverInfo.coverHash || coverInfo.cover_hash || null) : null),
      coverPath: (typeof coverInfo === "object" ? (coverInfo.coverPath || coverInfo.cover_path || null) : null),
      updatedAt: Date.now()
    };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction("covers", "readwrite");
        tx.objectStore("covers").put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async getBookCover(bookId) {
    if (!bookId) return null;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames) return null;

    if (db.objectStoreNames.contains("covers")) {
      const cover = await new Promise((resolve) => {
        try {
          const tx = db.transaction("covers", "readonly");
          const req = tx.objectStore("covers").get(bookId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
      if (cover?.dataUrl) return cover;
    }

    const legacyBook = await this._getBookRecordRaw(bookId);
    if (legacyBook?.coverDataUrl) {
      return {
        bookId,
        dataUrl: legacyBook.coverDataUrl,
        coverHash: legacyBook.coverHash || legacyBook.cover_hash || null,
        coverPath: legacyBook.cover_path || null
      };
    }
    return null;
  }

  async getBookCoverByHash(coverHash) {
    if (!coverHash) return null;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("covers")) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("covers", "readonly");
        const store = tx.objectStore("covers");
        if (!store.indexNames.contains("coverHash")) return resolve(null);
        const req = store.index("coverHash").get(coverHash);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async getAllBookCoversMap() {
    const map = new Map();
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("covers")) return map;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("covers", "readonly");
        const req = tx.objectStore("covers").getAll();
        req.onsuccess = () => {
          for (const rec of (req.result || [])) {
            if (rec?.bookId && rec?.dataUrl) {
              map.set(rec.bookId, rec);
            }
          }
          resolve(map);
        };
        req.onerror = () => resolve(map);
      } catch (_) {
        resolve(map);
      }
    });
  }

  async _migrateBookAssets(oldBookId, newBookId) {
    if (!oldBookId || !newBookId || oldBookId === newBookId) return;
    try {
      const db = await this.getDB();
      if (!db || !db.objectStoreNames) return;

      if (db.objectStoreNames.contains("book_files")) {
        const hasNewFile = await new Promise((resolve) => {
          try {
            const tx = db.transaction("book_files", "readonly");
            const req = tx.objectStore("book_files").count(newBookId);
            req.onsuccess = () => resolve((req.result || 0) > 0);
            req.onerror = () => resolve(false);
          } catch (_) { resolve(false); }
        });
        if (!hasNewFile) {
          const oldFile = await this.getBookFile(oldBookId);
          if (oldFile) {
            await this._saveBookFileRaw(newBookId, oldFile);
          }
        }
      }

      if (db.objectStoreNames.contains("covers")) {
        const newCover = await this.getBookCover(newBookId);
        if (!newCover?.dataUrl) {
          const oldCover = await this.getBookCover(oldBookId);
          if (oldCover?.dataUrl) {
            await this.saveBookCover(newBookId, oldCover);
          }
        }
      }
    } catch (_) {}
  }

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
      const byteSize = rawBinary.byteLength ?? rawBinary.size ?? null;
      if (byteSize && !bookData.fileSize) {
        bookData.fileSize = byteSize;
        bookData.file_size = byteSize;
      }
      if (!bookData.fileHash && !bookData.file_hash) {
        try {
          const h = await computeFileHash(rawBinary);
          if (h) {
            bookData.fileHash = h;
            bookData.file_hash = h;
          }
        } catch (_) {}
      }
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

      if (bookData.fileHash && !bookData.file_hash) {
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
        await this._migrateBookAssets(existing.id, bookData.id);
        await this.deleteBookRaw(existing.id);
        await this.migrateSessionsBookId(existing.id, bookData.id);
        this.migrateLocalStorageProgress(existing.id, bookData.id);
      }
    }

    // Oddělené uložení binárního souboru do "book_files" a obálky do "covers"
    let savedToFileStore = false;
    if (rawBinary) {
      savedToFileStore = await this._saveBookFileRaw(bookData.id, rawBinary, {
        fileSize: bookData.fileSize || bookData.file_size,
        fileHash: bookData.fileHash || bookData.file_hash
      });
      bookData.hasLocalFile = true;
    } else {
      // Pokud jde o starší DB v2 knihu s daty v "books", migrujeme je do "book_files" před přepisem metadat
      const existingRaw = await this._getBookRecordRaw(bookData.id);
      const legacyBinary = existingRaw && (existingRaw.fileData || existingRaw.data);
      if (legacyBinary) {
        const migrated = await this._saveBookFileRaw(bookData.id, legacyBinary, {
          fileSize: existingRaw.fileSize || existingRaw.file_size,
          fileHash: existingRaw.fileHash || existingRaw.file_hash || bookData.fileHash
        });
        if (migrated) {
          savedToFileStore = true;
          bookData.hasLocalFile = true;
        }
      } else {
        const alreadyInFileStore = await this.hasBookFile(bookData.id);
        bookData.hasLocalFile = alreadyInFileStore;
        savedToFileStore = alreadyInFileStore;
      }
    }

    let savedCoverToStore = false;
    if (bookData.coverDataUrl) {
      savedCoverToStore = await this.saveBookCover(bookData.id, {
        dataUrl: bookData.coverDataUrl,
        coverHash: bookData.coverHash || bookData.cover_hash || null,
        coverPath: bookData.cover_path || null
      });
    }

    // Store "books" ukládá pouze lehká metadata (pokud jsou binárky a obálky bezpečně uloženy ve vyhrazených stores)
    const recordToStore = { ...bookData };
    if (savedToFileStore) {
      delete recordToStore.data;
      delete recordToStore.fileData;
    }
    if (savedCoverToStore) {
      delete recordToStore.coverDataUrl;
    }

    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("books")) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("books", "readwrite");
        const store = tx.objectStore("books");
        const request = store.put(recordToStore);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
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
        if (b.isPdf && b.hasLocalFile && !b.fileHash) {
          try {
            const bin = b.data || b.fileData || await this.getBookFile(b.id);
            if (!bin) continue;
            const h = await computeFileHash(bin);
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
    const { supabaseSync } = await import("./supabase-sync.js?v=2.9.11");
    return await supabaseSync.uploadBook(book);
  }

  async syncWithCloud(options) {
    try {
      const { supabaseSync } = await import("./supabase-sync.js?v=2.9.11");
      return await supabaseSync.syncAll(options);
    } catch (err) {
      console.warn("[StorageManager] syncWithCloud selhal:", err);
      return { success: false, reason: "sync_failed" };
    }
  }

  async pushReadingSessionAndStatsToCloud(session) {
    try {
      const { supabaseSync } = await import("./supabase-sync.js?v=2.9.11");
      return await supabaseSync.pushSessionAndStats(session);
    } catch (err) {
      console.warn("[StorageManager] pushReadingSessionAndStatsToCloud selhal:", err);
      return null;
    }
  }

  async pushReadingSessionsToCloud(sessions) {
    try {
      const { supabaseSync } = await import("./supabase-sync.js?v=2.9.11");
      return await supabaseSync.pushMultipleSessions(sessions);
    } catch (err) {
      console.warn("[StorageManager] pushReadingSessionsToCloud selhal:", err);
      return null;
    }
  }

  getBookProgressTimestamp(record) {
    if (!record || typeof record !== "object") return 0;

    const toMs = (val) => {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
      if (typeof val === "string" && val.trim()) {
        const parsed = Date.parse(val);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return 0;
    };

    const anchorObj = record.readingAnchor || record.reading_anchor || null;
    const anchorTs = anchorObj ? toMs(anchorObj.updatedAt ?? anchorObj.updated_at) : 0;
    const explicitTs = toMs(record.progressUpdatedAt ?? record.progress_updated_at);

    if (anchorTs > 0 || explicitTs > 0) {
      return Math.max(anchorTs, explicitTs);
    }

    // Pokud bylo progressUpdatedAt explicitně vynulováno (čerstvě nahraná nepřečtená kniha), nepřepíše cizí postup
    if (record.progressUpdatedAt === 0) {
      return 0;
    }

    const hasProgress = Boolean(
      (Number(record.currentChapterIndex ?? record.current_chapter ?? 0) > 0) ||
      (Number(record.currentPageIndex ?? 0) > 0) ||
      (Number(record.currentPage ?? record.current_page ?? 1) > 1) ||
      (Number(record.scrollPercent ?? record.scroll_progress ?? record.pageRatio ?? 0) > 0) ||
      (Number(record.progress ?? record.progressPercent ?? 0) > 0)
    );

    if (!hasProgress) {
      return 0;
    }

    return Math.max(
      toMs(record.lastReadAt),
      toMs(record.updated_at)
    );
  }

  getCachedBookProgress(bookId) {
    if (!bookId || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(`lumina_progress_${bookId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  normalizeBookProgress(book) {
    if (!book) return 0;
    let progressValue = 0;

    const anchor = book.readingAnchor || book.reading_anchor;
    if (anchor && typeof anchor.bookProgress === "number" && !isNaN(anchor.bookProgress)) {
      progressValue = anchor.bookProgress;
    } else if (typeof book.progress === "number" && !isNaN(book.progress)) {
      progressValue = (book.progress > 0 && book.progress < 1 && !anchor) ? book.progress * 100 : book.progress;
    } else if (typeof book.scroll_progress === "number" && !isNaN(book.scroll_progress)) {
      progressValue = (book.scroll_progress > 0 && book.scroll_progress <= 1) ? book.scroll_progress * 100 : book.scroll_progress;
    } else if (typeof book.progressPercent === "number" && !isNaN(book.progressPercent)) {
      progressValue = (book.progressPercent > 0 && book.progressPercent < 1 && !anchor) ? book.progressPercent * 100 : book.progressPercent;
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
    if (!id) return null;
    try {
      const book = await this._getBookRecordRaw(id);
      if (!book) return null;

      this.normalizeBookProgress(book);
      book.hasLocalFile = await this.hasBookFile(id);

      if (!book.coverDataUrl) {
        const cover = await this.getBookCover(id);
        if (cover?.dataUrl) {
          book.coverDataUrl = cover.dataUrl;
          if (cover.coverHash && !book.coverHash) {
            book.coverHash = cover.coverHash;
            book.cover_hash = cover.coverHash;
          }
          if (cover.coverPath && !book.cover_path) {
            book.cover_path = cover.coverPath;
          }
        }
      }

      return book;
    } catch (_) {
      return null;
    }
  }

  async getAllBooks() {
    try {
      const db = await this.getDB();
      if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("books")) return [];

      const [books, cachedFileIds, coversMap] = await Promise.all([
        new Promise((resolve) => {
          try {
            const tx = db.transaction("books", "readonly");
            const store = tx.objectStore("books");
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
          } catch (txErr) {
            console.warn("[storage] getAllBooks tx error:", txErr);
            resolve([]);
          }
        }),
        this.getCachedBookFileIds(),
        this.getAllBookCoversMap()
      ]);

      for (const book of books) {
        if (!book) continue;
        this.normalizeBookProgress(book);
        book.hasLocalFile = cachedFileIds.has(book.id) || Boolean(book.fileData || book.data);
        const coverRec = coversMap.get(book.id);
        if (coverRec?.dataUrl && !book.coverDataUrl) {
          book.coverDataUrl = coverRec.dataUrl;
        }
        if (coverRec?.coverHash && !book.coverHash) {
          book.coverHash = coverRec.coverHash;
          book.cover_hash = coverRec.coverHash;
        }
        if (coverRec?.coverPath && !book.cover_path) {
          book.cover_path = coverRec.coverPath;
        }
      }

      // Seřadit podle naposledy čtených
      books.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
      return books;
    } catch (err) {
      console.warn("[storage] getAllBooks error:", err);
      return [];
    }
  }

  async deleteBook(id) {
    const db = await this.getDB();
    if (!db || !db.objectStoreNames) return false;
    return new Promise((resolve) => {
      try {
        const storeNames = ["books"];
        if (db.objectStoreNames.contains("book_files")) storeNames.push("book_files");
        if (db.objectStoreNames.contains("covers")) storeNames.push("covers");
        if (db.objectStoreNames.contains("sessions")) storeNames.push("sessions");
        if (db.objectStoreNames.contains("reading_sessions")) storeNames.push("reading_sessions");

        const tx = db.transaction(storeNames, "readwrite");
        try { tx.objectStore("books").delete(id); } catch (_) {}
        if (db.objectStoreNames.contains("book_files")) {
          try { tx.objectStore("book_files").delete(id); } catch (_) {}
        }
        if (db.objectStoreNames.contains("covers")) {
          try { tx.objectStore("covers").delete(id); } catch (_) {}
        }

        // Smazat i přidružené relace ze sessions
        if (db.objectStoreNames.contains("sessions")) {
          try {
            const sessionStore = tx.objectStore("sessions");
            const index = sessionStore.index("bookId");
            const request = index.openCursor(IDBKeyRange.only(id));
            request.onsuccess = (e) => {
              try {
                const cursor = e.target.result;
                if (cursor) {
                  try { cursor.delete(); } catch (_) {}
                  cursor.continue();
                }
              } catch (_) {}
            };
          } catch (_) {}
        }

        // Smazat i přidružené relace z reading_sessions
        if (db.objectStoreNames.contains("reading_sessions")) {
          try {
            const readingStore = tx.objectStore("reading_sessions");
            const index = readingStore.index("bookId");
            const request = index.openCursor(IDBKeyRange.only(id));
            request.onsuccess = (e) => {
              try {
                const cursor = e.target.result;
                if (cursor) {
                  const sid = cursor.value?.sessionId || cursor.value?.id;
                  if (sid) {
                    this.addDeletedSessionId(sid);
                    this._removeSessionFromLocalStorage(sid);
                  }
                  try { cursor.delete(); } catch (_) {}
                  cursor.continue();
                }
              } catch (_) {}
            };
          } catch (_) {}
        }

        tx.oncomplete = () => {
          try {
            localStorage.removeItem(`lumina_progress_${id}`);
            localStorage.removeItem(`lumina_bookmarks_${id}`);
            localStorage.removeItem(`lumina_bookmarks_deleted_${id}`);
            if (this.getLastActiveBookId() === id) {
              localStorage.removeItem("luminareader_last_book_id");
            }
          } catch (_) {}
          resolve(true);
        };
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (txErr) {
        console.warn("[storage] deleteBook error:", txErr);
        resolve(false);
      }
    });
  }

  /**
   * Vrátí mapu smazaných knih (tombstones) z localStorage pro synchronizaci smazání mezi zařízeními
   * @returns {Record<string, Object>}
   */
  getDeletedBooksMap() {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem("lumina_deleted_books");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const cleaned = {};
      for (const [id, entry] of Object.entries(parsed)) {
        if (!id || !entry || typeof entry !== "object") continue;
        const deletedAt = Number(entry.deletedAt) || 0;
        if (entry.syncedDeletion === true && deletedAt > 0 && deletedAt < cutoff) {
          continue;
        }
        cleaned[id] = {
          id: String(entry.id || id).trim(),
          deletedAt: deletedAt || Date.now(),
          filePath: entry.filePath || null,
          coverPath: entry.coverPath || null,
          fileHash: entry.fileHash || null,
          fileName: entry.fileName || null,
          title: entry.title || null,
          isPdf: Boolean(entry.isPdf),
          syncedDeletion: Boolean(entry.syncedDeletion)
        };
      }
      return cleaned;
    } catch (_) {
      return {};
    }
  }

  _saveDeletedBooksMap(map) {
    if (typeof localStorage === "undefined") return;
    try {
      const entries = Object.entries(map || {});
      if (entries.length > 0) {
        localStorage.setItem("lumina_deleted_books", JSON.stringify(map));
      } else {
        localStorage.removeItem("lumina_deleted_books");
      }
    } catch (_) {}
  }

  recordDeletedBook(bookOrId, meta = {}) {
    const isObj = bookOrId && typeof bookOrId === "object";
    const id = String(isObj ? (bookOrId.id ?? "") : (bookOrId ?? "")).trim();
    if (!id) return null;

    const map = this.getDeletedBooksMap();
    const existing = map[id] || {};
    const bookObj = isObj ? bookOrId : {};
    const deletedAt = Math.max(Number(meta.deletedAt) || Date.now(), Number(existing.deletedAt) || 0);
    const syncedDeletion = meta.syncedDeletion === true
      ? true
      : (meta.syncedDeletion === false ? false : Boolean(existing.syncedDeletion));

    map[id] = {
      id,
      deletedAt,
      filePath: meta.filePath ?? meta.file_path ?? bookObj.file_path ?? existing.filePath ?? null,
      coverPath: meta.coverPath ?? meta.cover_path ?? bookObj.cover_path ?? existing.coverPath ?? null,
      fileHash: meta.fileHash ?? meta.file_hash ?? bookObj.fileHash ?? bookObj.file_hash ?? existing.fileHash ?? null,
      fileName: meta.fileName ?? meta.file_name ?? bookObj.fileName ?? bookObj.file_name ?? existing.fileName ?? null,
      title: meta.title ?? bookObj.title ?? existing.title ?? null,
      isPdf: Boolean(meta.isPdf ?? bookObj.isPdf ?? (bookObj.format === "pdf" || bookObj.file_type === "pdf") ?? existing.isPdf),
      syncedDeletion
    };
    this._saveDeletedBooksMap(map);
    return map[id];
  }

  getUnsyncedDeletedBooks() {
    return Object.values(this.getDeletedBooksMap()).filter(
      entry => entry && entry.id && entry.syncedDeletion !== true
    );
  }

  markBookDeletionSynced(bookId) {
    const cleanId = String(bookId ?? "").trim();
    if (!cleanId) return;
    const map = this.getDeletedBooksMap();
    if (map[cleanId]) {
      map[cleanId].syncedDeletion = true;
      this._saveDeletedBooksMap(map);
    }
  }

  findDeletedBookEntry(bookOrId) {
    const map = this.getDeletedBooksMap();
    const isObj = bookOrId && typeof bookOrId === "object";
    const id = String(isObj ? (bookOrId.id ?? "") : (bookOrId ?? "")).trim();
    if (id && map[id]) return map[id];
    if (!isObj) return null;

    const filePath = bookOrId.file_path || bookOrId.filePath || null;
    const fileHash = bookOrId.fileHash || bookOrId.file_hash || null;
    for (const entry of Object.values(map)) {
      if (!entry) continue;
      if (filePath && entry.filePath && entry.filePath === filePath) return entry;
      if (fileHash && entry.fileHash && entry.fileHash === fileHash) return entry;
    }
    return null;
  }

  removeDeletedBookRecord(bookOrId, meta = {}) {
    const map = this.getDeletedBooksMap();
    const isObj = bookOrId && typeof bookOrId === "object";
    const id = String(isObj ? (bookOrId.id ?? "") : (bookOrId ?? "")).trim();
    const filePath = meta.filePath ?? meta.file_path ?? (isObj ? (bookOrId.file_path || bookOrId.filePath) : null);
    const fileHash = meta.fileHash ?? meta.file_hash ?? (isObj ? (bookOrId.fileHash || bookOrId.file_hash) : null);

    let changed = false;
    if (id && map[id]) {
      delete map[id];
      changed = true;
    }
    for (const [k, entry] of Object.entries(map)) {
      if (!entry) continue;
      if ((filePath && entry.filePath === filePath) || (fileHash && entry.fileHash === fileHash)) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) {
      this._saveDeletedBooksMap(map);
    }
  }

  async markBookSyncState(bookId, updates = {}) {
    if (!bookId || !updates || typeof updates !== "object") return false;
    const existing = await this._getBookRecordRaw(bookId);
    if (!existing) return false;
    const updated = { ...existing };
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        updated[key] = val;
      }
    }
    delete updated.data;
    delete updated.fileData;
    await this.saveBookRaw(updated);
    return true;
  }

  async updateBookProgress(bookId, updates) {
    const book = await this._getBookRecordRaw(bookId);
    if (!book || !updates) return;

    const anchorTs = updates.readingAnchor?.updatedAt ?? updates.reading_anchor?.updatedAt;
    const effectiveProgressUpdatedAt =
      (typeof updates.progressUpdatedAt === "number" && updates.progressUpdatedAt > 0)
        ? updates.progressUpdatedAt
        : ((typeof anchorTs === "number" && anchorTs > 0)
          ? anchorTs
          : ((typeof updates.lastReadAt === "number" && updates.lastReadAt > 0) ? updates.lastReadAt : Date.now()));
    const effectiveLastReadAt =
      (typeof updates.lastReadAt === "number" && updates.lastReadAt > 0)
        ? updates.lastReadAt
        : effectiveProgressUpdatedAt;

    Object.assign(book, updates, {
      lastReadAt: effectiveLastReadAt,
      progressUpdatedAt: effectiveProgressUpdatedAt
    });

    if (book.readingAnchor && typeof book.readingAnchor === "object" && !book.readingAnchor.updatedAt) {
      book.readingAnchor.updatedAt = effectiveProgressUpdatedAt;
    }

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

    // Lehká aktualizace metadat postupu bez zbytečného přepisování binárních dat nebo obálek
    if (!book.data && !book.fileData && !book.coverDataUrl) {
      return await this.saveBookRaw(book);
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
   * Vrátí seznam ID smazaných čtecích relací (tombstones) z localStorage
   * @returns {string[]}
   */
  getDeletedSessionIds() {
    try {
      const raw = localStorage.getItem("lumina_deleted_session_ids");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map(id => String(id ?? "").trim()).filter(Boolean)
        : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Přidá ID relace do seznamu smazaných relací v localStorage
   * @param {string|number} sessionId
   */
  addDeletedSessionId(sessionId) {
    const cleanId = String(sessionId ?? "").trim();
    if (!cleanId) return;
    try {
      const current = new Set(this.getDeletedSessionIds());
      current.add(cleanId);
      localStorage.setItem("lumina_deleted_session_ids", JSON.stringify(Array.from(current)));
    } catch (_) {}
  }

  /**
   * Odstraní ID relace ze seznamu smazaných relací v localStorage
   * @param {string|number} sessionId
   */
  removeDeletedSessionId(sessionId) {
    const cleanId = String(sessionId ?? "").trim();
    if (!cleanId) return;
    try {
      const filtered = this.getDeletedSessionIds().filter(id => id !== cleanId);
      localStorage.setItem("lumina_deleted_session_ids", JSON.stringify(filtered));
    } catch (_) {}
  }

  /**
   * Pročistí sirotčí / zombie relace čtení z lokální IndexedDB i localStorage během cloudové synchronizace.
   * Supabase slouží jako autorita pro smazání relací:
   * Jakákoliv lokální relace v IndexedDB, která v Supabase neexistuje (nebo má is_deleted === true),
   * je trvale smazána z IndexedDB přes store.delete(sessionId).
   *
   * @param {Iterable<string|number>} remoteValidSessionIds - Množina / pole platných ID relací v cloudu
   * @param {Iterable<string|number>} [remoteDeletedSessionIds=[]] - Množina / pole smazaných ID relací v cloudu
   * @returns {Promise<{ purgedCount: number, purgedIds: string[] }>}
   */
  async purgeOrphanReadingSessions(remoteValidSessionIds, remoteDeletedSessionIds = []) {
    if (!remoteValidSessionIds && !remoteDeletedSessionIds) {
      return { purgedCount: 0, purgedIds: [] };
    }

    const validRemoteSet = new Set(
      Array.from(remoteValidSessionIds || [])
        .map(id => String(id ?? "").trim())
        .filter(Boolean)
    );
    const remoteDeletedSet = new Set(
      Array.from(remoteDeletedSessionIds || [])
        .map(id => String(id ?? "").trim())
        .filter(Boolean)
    );

    const purgedIds = new Set();

    try {
      const db = await this.getDB();
      if (db && db.objectStoreNames) {
        const storeNames = [];
        if (db.objectStoreNames.contains("reading_sessions")) storeNames.push("reading_sessions");
        if (db.objectStoreNames.contains("sessions")) storeNames.push("sessions");

        if (storeNames.length > 0) {
          await new Promise((resolve) => {
            try {
              const tx = db.transaction(storeNames, "readwrite");

              // Kompletní kurzorový průchod a odstranění sirotčích i smazaných relací
              for (const sName of storeNames) {
                const store = tx.objectStore(sName);
                const req = store.openCursor();

                req.onsuccess = (e) => {
                  try {
                    const cursor = e.target.result;
                    if (cursor) {
                      const val = cursor.value || {};
                      const sid = String(val.sessionId || val.id || cursor.key || "").trim();
                      const isLocalPending = Boolean(val.syncedToCloud === false || val.isPendingSync === true);

                      // Relace je sirotek (orphan), pokud:
                      // 1. Je v Supabase označena jako is_deleted === true
                      // 2. V Supabase vůbec neexistuje a není to nově vytvořená nesynchronizovaná lokální relace
                      const isRemoteDeleted = Boolean(sid && remoteDeletedSet.has(sid));
                      const isMissingFromRemote = Boolean(sid && !validRemoteSet.has(sid) && !isLocalPending);

                      if (isRemoteDeleted || isMissingFromRemote) {
                        try { cursor.delete(); } catch (_) {}
                        try { store.delete(cursor.key); } catch (_) {}
                        if (sid) {
                          try { store.delete(sid); } catch (_) {}
                          purgedIds.add(sid);
                          this.addDeletedSessionId(sid);
                        }
                      }
                      cursor.continue();
                    }
                  } catch (_) {}
                };

                req.onerror = () => resolve();
              }

              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
              tx.onabort = () => resolve();
            } catch (txErr) {
              console.warn("[storage] purgeOrphanReadingSessions tx error:", txErr);
              resolve();
            }
          });
        }
      }
    } catch (err) {
      console.warn("[storage] purgeOrphanReadingSessions error:", err);
    }

    // Dodatečné explicitní volání store.delete pro identifikované sirotky
    if (purgedIds.size > 0) {
      try {
        const db = await this.getDB();
        if (db && db.objectStoreNames && db.objectStoreNames.contains("reading_sessions")) {
          await new Promise((resolve) => {
            try {
              const tx = db.transaction("reading_sessions", "readwrite");
              const rsStore = tx.objectStore("reading_sessions");
              for (const pId of purgedIds) {
                try { rsStore.delete(pId); } catch (_) {}
              }
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
              tx.onabort = () => resolve();
            } catch (_) { resolve(); }
          });
        }
      } catch (_) {}
    }

    // Vyčištění lokální paměti / cache v localStorage
    try {
      const raw = localStorage.getItem("lumina_reading_sessions");
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const filtered = list.filter(s => {
            if (!s || typeof s !== "object") return false;
            const sid = String(s.sessionId || s.id || "").trim();
            if (!sid) return false;
            if (purgedIds.has(sid) || remoteDeletedSet.has(sid)) return false;
            if (!validRemoteSet.has(sid) && s.syncedToCloud !== false && s.isPendingSync !== true) {
              purgedIds.add(sid);
              this.addDeletedSessionId(sid);
              return false;
            }
            return true;
          });
          localStorage.setItem("lumina_reading_sessions", JSON.stringify(filtered));
        }
      }
    } catch (_) {}

    // Přepočet a normalizace odvozených statistik ihned po promazání
    if (purgedIds.size > 0) {
      try {
        await this.recalculateAndNormalizeStats();
      } catch (recalcErr) {
        console.warn("[storage] Chyba při přepočtu statistik po promazání sirotčích relací:", recalcErr);
      }
    }

    return { purgedCount: purgedIds.size, purgedIds: Array.from(purgedIds) };
  }

  /**
   * Kompletní rekonsiliace relací čtení ze Supabase do IndexedDB:
   * 1. Rozdělí vzdálené relace na platné vs is_deleted
   * 2. Promaže všechny lokální sirotčí relace z IndexedDB (purge orphans)
   * 3. Uloží/aktualizuje všechny platné vzdálené relace do IndexedDB (s příznakem syncedToCloud = true)
   * 4. Přepočítá agregované metriky a statistiky
   *
   * @param {Array<Object>} remoteSessions
   * @returns {Promise<{ saved: number, purged: number, purgedIds: string[] }>}
   */
  async reconcileReadingSessions(remoteSessions) {
    if (!Array.isArray(remoteSessions)) {
      return { saved: 0, purged: 0, purgedIds: [] };
    }

    const validRemoteMap = new Map();
    const remoteDeletedIds = new Set();

    for (const session of remoteSessions) {
      if (!session) continue;
      const rowId = String(session.id ?? session.sessionId ?? "").trim();
      if (!rowId) continue;

      const isDeleted = Boolean(session.is_deleted === true || session.is_deleted === "true");
      if (isDeleted) {
        remoteDeletedIds.add(rowId);
      } else {
        validRemoteMap.set(rowId, session);
      }
    }

    // 1. Krok: Promazání sirotčích relací z lokálního úložiště
    const purgeResult = await this.purgeOrphanReadingSessions(
      Array.from(validRemoteMap.keys()),
      Array.from(remoteDeletedIds)
    );

    // 2. Krok: Uložení/aktualizace platných vzdálených relací
    const deletedTombstones = new Set(this.getDeletedSessionIds());
    let savedCount = 0;

    let booksMap = null;
    let localSessionsMap = new Map();
    try {
      const [localBooks, localSessions] = await Promise.all([
        this.getAllBooks(),
        this.getAllReadingSessions()
      ]);
      booksMap = new Map((localBooks || []).map(b => [b.id, b]));
      for (const ls of (localSessions || [])) {
        if (!ls) continue;
        const sid = String(ls.sessionId || ls.id || "").trim();
        if (sid) localSessionsMap.set(sid, ls);
      }
    } catch (_) {}

    for (const [rowId, session] of validRemoteMap.entries()) {
      if (deletedTombstones.has(rowId)) continue;

      const existingLocal = localSessionsMap.get(rowId);
      if (existingLocal) {
        if (!session.bookTitle && !session.book_title && existingLocal.bookTitle) {
          session.bookTitle = existingLocal.bookTitle;
        }

        // Zachovat bohaté lokální vzorky intra_session_samples, pokud cloud vrátil prázdné pole nebo null
        let remoteSamples = session.intra_session_samples || session.intraSessionSamples || session.timelineSamples;
        if (typeof remoteSamples === "string") {
          try { remoteSamples = JSON.parse(remoteSamples); } catch (_) { remoteSamples = []; }
          session.intra_session_samples = remoteSamples;
        }
        const localSamples = Array.isArray(existingLocal.intra_session_samples) && existingLocal.intra_session_samples.length > 0
          ? existingLocal.intra_session_samples
          : (Array.isArray(existingLocal.intraSessionSamples) && existingLocal.intraSessionSamples.length > 0
            ? existingLocal.intraSessionSamples
            : (Array.isArray(existingLocal.timelineSamples) ? existingLocal.timelineSamples : []));

        if ((!Array.isArray(remoteSamples) || remoteSamples.length === 0) && localSamples.length > 0) {
          session.intra_session_samples = localSamples;
          session.intraSessionSamples = localSamples;
          session.timelineSamples = localSamples;
        }
      }

      if (!session.bookTitle && !session.book_title && session.book_id && booksMap) {
        const b = booksMap.get(session.book_id);
        if (b?.title) session.bookTitle = b.title;
      }
      if (!session.startTime && session.start_time) {
        session.startTime = session.start_time;
      }
      if (!session.timestamp && session.startTime) {
        session.timestamp = new Date(session.startTime).getTime();
      }
      if (!session.bookId && session.book_id) {
        session.bookId = session.book_id;
      }
      session.syncedToCloud = true;

      try {
        await this.saveReadingSession(session);
        savedCount++;
      } catch (saveErr) {
        console.warn("[storage] Chyba při ukládání rekonsiliované relace:", saveErr);
      }
    }

    // 3. Krok: Přepočet a normalizace odvozených statistik
    await this.recalculateAndNormalizeStats();

    return {
      saved: savedCount,
      purged: purgeResult.purgedCount,
      purgedIds: purgeResult.purgedIds
    };
  }

  /**
   * Rekonsiliuje čtecí relace přímo se Supabase cloudem
   */
  async reconcileSessionsWithCloud() {
    try {
      const { supabaseSync } = await import("./supabase-sync.js?v=2.9.11");
      if (!supabaseSync || !supabaseSync.isOnline()) {
        return { success: false, reason: "offline", purged: 0, saved: 0 };
      }
      const remoteSessions = await supabaseSync.fetchCloudReadingSessions();
      if (!Array.isArray(remoteSessions)) {
        return { success: false, reason: "fetch_failed", purged: 0, saved: 0 };
      }
      const res = await this.reconcileReadingSessions(remoteSessions);
      return { success: true, ...res };
    } catch (err) {
      console.warn("[StorageManager] reconcileSessionsWithCloud selhal:", err);
      return { success: false, error: err, purged: 0, saved: 0 };
    }
  }

  /**
   * Uloží detailní relaci čtení do reading_sessions a synchronizuje i do sessions (legacy)
   * Ukládá POUZE validní relace s délkou alespoň 5 minut (>= 300 sekund).
   * @param {Object} sessionData
   */
  async saveReadingSession(sessionData) {
    if (!sessionData) return null;

    // Ignorovat relace označené jako smazané (tombstones a is_deleted flag)
    if (sessionData.is_deleted === true || sessionData.is_deleted === "true") {
      return null;
    }
    const deletedSet = new Set(this.getDeletedSessionIds());
    const rawSid = String(sessionData.sessionId ?? "").trim();
    const rawId = String(sessionData.id ?? "").trim();
    if ((rawSid && deletedSet.has(rawSid)) || (rawId && deletedSet.has(rawId))) {
      return null;
    }

    const durationSeconds = Math.max(0, Math.round(sessionData.durationSeconds ?? sessionData.activeSeconds ?? sessionData.duration ?? 0));
    // Striktní vynucení minimálního prahu 5 minut pro uložení do historie relací
    if (durationSeconds < 300) {
      return null;
    }

    const db = await this.getDB();
    const startIso = sessionData.startTime || sessionData.start_time || null;
    const timestamp = sessionData.timestamp || (startIso ? new Date(startIso).getTime() : Date.now());
    const startTime = startIso || new Date(timestamp - (durationSeconds * 1000)).toISOString();
    const endTime = sessionData.endTime || new Date(timestamp).toISOString();
    let wordsRead = Math.max(0, Math.round(sessionData.words_read ?? sessionData.wordsRead ?? 0));

    // Striktní výpočet průměrného WPM podle vzorce: duration >= 10 ? Math.round((words_read / duration) * 60) : 0
    const avgWpm = durationSeconds >= 10 ? Math.round((wordsRead / durationSeconds) * 60) : 0;

    const localDate = this.getLocalDateString(sessionData.date || startTime || timestamp);
    const sessionId = String(sessionData.sessionId || sessionData.id || `session_${timestamp}_${Math.random().toString(36).substring(2, 9)}`).trim();

    if (deletedSet.has(sessionId)) {
      return null;
    }

    // Filtrace a normalizace 1-minutových vzorků intra_session_samples (bez umělých 220 WPM seed bodů na 0s a bez 0 WPM idle propadů)
    let rawSamples = sessionData.intra_session_samples || sessionData.intraSessionSamples || sessionData.timelineSamples;
    if (typeof rawSamples === "string") {
      try {
        rawSamples = JSON.parse(rawSamples);
      } catch (_) {
        rawSamples = [];
      }
    }
    rawSamples = Array.isArray(rawSamples) ? rawSamples : [];
    const cleanedSamples = this._cleanIntraSessionSamples(rawSamples, durationSeconds, wordsRead, avgWpm, timestamp);

    // Výpočet udržené špičkové rychlosti: max z validních vzorků (>= 30–60s)
    const validSpeeds = cleanedSamples
      .filter(s => !s.isPartial || (s.activeSeconds ?? 60) >= 30)
      .map(s => s.wpm)
      .filter(w => w > 0 && w <= 650);
    let peakWpm = validSpeeds.length > 0 ? Math.min(650, Math.max(...validSpeeds)) : avgWpm;
    if (peakWpm < avgWpm && avgWpm > 0) {
      peakWpm = avgWpm;
    }

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
      is_deleted: false,
      isDeleted: false,
      updatedAt,
      syncedToCloud: sessionData.syncedToCloud !== undefined ? Boolean(sessionData.syncedToCloud) : (sessionData.synced_to_cloud !== undefined ? Boolean(sessionData.synced_to_cloud) : true)
    };

    if (!db || !db.objectStoreNames) {
      this._cacheSessionToLocalStorage(normalizedSession);
      return normalizedSession;
    }

    return new Promise((resolve) => {
      try {
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
          try {
            const legacyCopy = { ...normalizedSession };
            delete legacyCopy.id;
            tx.objectStore("sessions").put(legacyCopy);
          } catch (legacyErr) {
            console.warn("[storage] Zápis do legacy úložiště sessions přeskočen:", legacyErr);
          }
        }

        tx.oncomplete = () => {
          this._cacheSessionToLocalStorage(normalizedSession);
          resolve(normalizedSession);
        };
        tx.onerror = () => {
          this._cacheSessionToLocalStorage(normalizedSession);
          resolve(normalizedSession);
        };
        tx.onabort = () => {
          this._cacheSessionToLocalStorage(normalizedSession);
          resolve(normalizedSession);
        };
      } catch (err) {
        console.warn("[storage] saveReadingSession IndexedDB error:", err);
        this._cacheSessionToLocalStorage(normalizedSession);
        resolve(normalizedSession);
      }
    });
  }

  /**
   * Smaže čtecí relaci z IndexedDB i localStorage a přepočítá kumulativní statistiky
   * @param {string|number} sessionId
   * @param {boolean} [skipRecalculate=false]
   * @returns {Promise<{ success: boolean, error?: any }>}
   */
  async deleteReadingSession(sessionId, skipRecalculate = false) {
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const targetIdStr = String(sessionId).trim();
    if (!targetIdStr) return { success: false, error: "Missing sessionId" };

    // 0. Trvale zaznamenat ID smazané relace (tombstone)
    try {
      this.addDeletedSessionId(targetIdStr);
    } catch (_) {}
    try {
      localStorage.setItem("lumina_sessions_migrated", "true");
    } catch (_) {}

    try {
      const db = await this.getDB();
      if (db && db.objectStoreNames) {
        const storeNames = [];
        if (db.objectStoreNames.contains("reading_sessions")) storeNames.push("reading_sessions");
        if (db.objectStoreNames.contains("sessions")) storeNames.push("sessions");

        if (storeNames.length > 0) {
          await new Promise((resolve) => {
            try {
              const tx = db.transaction(storeNames, "readwrite");

              for (const sName of storeNames) {
                const store = tx.objectStore(sName);

                // 1. Direct key delete attempts
                try { store.delete(sessionId); } catch (_) {}
                try { store.delete(targetIdStr); } catch (_) {}
                if (!isNaN(Number(sessionId))) {
                  try { store.delete(Number(sessionId)); } catch (_) {}
                }

                // 2. Comprehensive cursor scan matching id, sessionId, or cursor keys
                try {
                  const cursorReq = store.openCursor();
                  cursorReq.onsuccess = (e) => {
                    try {
                      const cursor = e.target.result;
                      if (cursor) {
                        const val = cursor.value || {};
                        const matches = (
                          val.id === sessionId ||
                          val.sessionId === sessionId ||
                          String(val.id ?? "").trim() === targetIdStr ||
                          String(val.sessionId ?? "").trim() === targetIdStr ||
                          String(cursor.key ?? "").trim() === targetIdStr ||
                          String(cursor.primaryKey ?? "").trim() === targetIdStr
                        );
                        if (matches) {
                          try { cursor.delete(); } catch (_) {}
                        }
                        cursor.continue();
                      }
                    } catch (_) {}
                  };
                  cursorReq.onerror = () => resolve();
                } catch (_) {}
              }

              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
              tx.onabort = () => resolve();
            } catch (txErr) {
              console.warn("[storage] deleteReadingSession tx error:", txErr);
              resolve();
            }
          });
        }
      }
    } catch (dbErr) {
      console.warn("[storage] deleteReadingSession error:", dbErr);
    }

    try {
      this._removeSessionFromLocalStorage(targetIdStr);
    } catch (_) {}

    // 3. Recalculate global cumulative stats, words, time, and streak
    if (!skipRecalculate && typeof this.recalculateAndNormalizeStats === "function") {
      try {
        await this.recalculateAndNormalizeStats();
      } catch (recalcErr) {
        console.warn("[storage] Error during stats recalculation:", recalcErr);
      }
    }

    return { success: true };
  }

  _removeSessionFromLocalStorage(sessionId) {
    try {
      const targetIdStr = String(sessionId ?? "").trim();
      if (!targetIdStr) return;
      const raw = localStorage.getItem("lumina_reading_sessions");
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const filtered = list.filter(s => {
            if (!s || typeof s !== "object") return false;
            const sId = String(s.sessionId ?? "").trim();
            const id = String(s.id ?? "").trim();
            return s.sessionId !== sessionId &&
                   s.id !== sessionId &&
                   sId !== targetIdStr &&
                   id !== targetIdStr;
          });
          localStorage.setItem("lumina_reading_sessions", JSON.stringify(filtered));
        }
      }
    } catch (_) {}
  }

  _cacheSessionToLocalStorage(session) {
    try {
      if (!session || typeof session !== "object") return;
      if (session.is_deleted === true || session.is_deleted === "true") return;
      const deletedSet = new Set(this.getDeletedSessionIds());
      const sid = String(session.sessionId ?? session.id ?? "").trim();
      if (sid && deletedSet.has(sid)) return;

      const raw = localStorage.getItem("lumina_reading_sessions");
      const list = raw ? JSON.parse(raw) : [];
      const safeList = Array.isArray(list) ? list : [];
      const filtered = safeList.filter(s => {
        if (!s || typeof s !== "object") return false;
        if (s.is_deleted === true || s.is_deleted === "true") return false;
        const existingId = String(s.sessionId ?? s.id ?? "").trim();
        return existingId !== sid && !deletedSet.has(existingId);
      });
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
    const deletedSet = new Set(this.getDeletedSessionIds());
    const isNotDeleted = (s) => {
      if (!s || typeof s !== "object") return false;
      if (s.is_deleted === true || s.is_deleted === "true") return false;
      const sid = String(s.sessionId ?? "").trim();
      const id = String(s.id ?? "").trim();
      return !(sid && deletedSet.has(sid)) && !(id && deletedSet.has(id));
    };

    const getLocalStorageFallback = () => {
      try {
        const raw = localStorage.getItem("lumina_reading_sessions");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed.filter(s => isNotDeleted(s) && Math.max(0, Math.round(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0)) >= 300);
          }
        }
      } catch (_) {}
      return [];
    };

    try {
      const db = await this.getDB();
      if (!db || !db.objectStoreNames) {
        return getLocalStorageFallback();
      }

      return await new Promise((resolve) => {
        try {
          if (!db.objectStoreNames.contains("reading_sessions")) {
            return this._getOldSessions().then(oldList => {
              const filtered = (oldList || []).filter(s => {
                if (!isNotDeleted(s)) return false;
                const dur = Math.max(0, Math.round(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0));
                return dur >= 300;
              });
              filtered.sort((a, b) => (b.timestamp || new Date(b.startTime || 0).getTime() || 0) - (a.timestamp || new Date(a.startTime || 0).getTime() || 0));
              resolve(filtered);
            }).catch(() => resolve(getLocalStorageFallback()));
          }

          const tx = db.transaction("reading_sessions", "readonly");
          const store = tx.objectStore("reading_sessions");
          const request = store.getAll();

          request.onsuccess = async () => {
            let results = (request.result || []).filter(isNotDeleted);

            // Odfiltrujeme relace kratší než 5 minut (>= 300 sekund)
            results = results.filter(s => {
              const dur = Math.max(0, Math.round(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0));
              return dur >= 300;
            });

            // Seřadit sestupně (nejnovější nahoře)
            results.sort((a, b) => (b.timestamp || new Date(b.startTime || 0).getTime() || 0) - (a.timestamp || new Date(a.startTime || 0).getTime() || 0));
            resolve(results);
          };

          request.onerror = () => resolve(getLocalStorageFallback());
        } catch (txErr) {
          console.warn("[storage] getAllReadingSessions tx error:", txErr);
          resolve(getLocalStorageFallback());
        }
      });
    } catch (err) {
      console.warn("[storage] getAllReadingSessions error:", err);
      return getLocalStorageFallback();
    }
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
      liquidGlassUi: false, // Liquid Glass theme toggle
      parchmentTexture: false, // Parchment paper texture toggle
      fontFamily: "georgia", // georgia, merriweather, lora, inter, atkinson, opendyslexic, verdana, arial, literata, comic-sans
      fontSize: 19, // px
      marginPercent: 8, // % velikost okrajů stránky
      columnsMode: "auto", // "auto" | "1" | "2" - rozvržení sloupců
      lineHeight: 1.6,
      letterSpacing: 0.75, // px
      wordSpacing: 2, // px
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
        mode: "highlight", // backward compat: highlight, bottom-cover, off
        style: "highlight", // off, highlight, bottom-cover
        focusMode: "off", // off, up, down, both
        lastActiveStyle: "highlight",
        lastActiveCombination: { style: "highlight", focusMode: "off" },
        height: 48, // px
        autoHeight: true, // Automatická výška podle velikosti řádku
        pdfAutoHeight: true, // Automatická výška pravítka pro PDF (výchozí zapnuto)
        snapToLines: true, // Magnetická přilnavost k jednotlivým řádkům
        rulerModeType: "line", // line, word
        wordTracking: false, // Sledování jednotlivých slov
        color: "amber", // amber, cyan, emerald, lavender, slate
        dimOpacity: 0.65,
        followMode: "mouse" // mouse, keyboard, trackpad
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
        const rawMargin = parsed.marginPercent ?? 8;
        merged.marginPercent = Number.isFinite(Number(rawMargin)) ? Math.max(2, Number(rawMargin)) : 8;
        merged.columnsMode = parsed.columnsMode ?? "auto";
        merged.lineHeight = parsed.lineHeight !== undefined ? Number(parsed.lineHeight) : 1.6;
        merged.letterSpacing = parsed.letterSpacing !== undefined ? Number(parsed.letterSpacing) : 0.75;
        merged.wordSpacing = parsed.wordSpacing !== undefined ? Number(parsed.wordSpacing) : 2;
        merged.fastReading = !!parsed.fastReading;
        merged.liquidGlassUi = localStorage.getItem("liquidGlassUi") !== null
          ? localStorage.getItem("liquidGlassUi") === "true"
          : (parsed.liquidGlassUi !== undefined ? !!parsed.liquidGlassUi : false);
        merged.parchmentTexture = localStorage.getItem("parchmentTexture") !== null
          ? localStorage.getItem("parchmentTexture") === "true"
          : (parsed.parchmentTexture !== undefined ? !!parsed.parchmentTexture : false);
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
        if (merged.ruler.mode === "focus") {
          merged.ruler.style = "off";
          merged.ruler.focusMode = "both";
          merged.ruler.mode = "off";
        } else {
          if (parsed.ruler && parsed.ruler.style !== undefined) {
            merged.ruler.style = parsed.ruler.style;
          } else if (parsed.ruler && parsed.ruler.mode !== undefined) {
            merged.ruler.style = parsed.ruler.mode;
          }
          if (parsed.ruler && parsed.ruler.focusMode !== undefined) {
            merged.ruler.focusMode = parsed.ruler.focusMode;
          }
        }
        if (!["off", "highlight", "bottom-cover"].includes(merged.ruler.style)) {
          merged.ruler.style = "highlight";
        }
        if (!["off", "up", "down", "both"].includes(merged.ruler.focusMode)) {
          merged.ruler.focusMode = "off";
        }
        merged.ruler.mode = merged.ruler.style;
        if (merged.ruler.style === "off" && merged.ruler.focusMode === "off") {
          merged.ruler.enabled = false;
        }
        if (parsed.ruler?.lastActiveCombination && typeof parsed.ruler.lastActiveCombination === "object") {
          merged.ruler.lastActiveCombination = parsed.ruler.lastActiveCombination;
        } else if (merged.ruler.style !== "off" || merged.ruler.focusMode !== "off") {
          merged.ruler.lastActiveCombination = {
            style: merged.ruler.style,
            focusMode: merged.ruler.focusMode
          };
        }
        if (parsed.ruler?.lastActiveStyle) {
          merged.ruler.lastActiveStyle = parsed.ruler.lastActiveStyle;
        } else if (merged.ruler.style !== "off") {
          merged.ruler.lastActiveStyle = merged.ruler.style;
        }
        if (!["mouse", "keyboard", "trackpad"].includes(merged.ruler.followMode)) {
          merged.ruler.followMode = "mouse";
        }
        if (merged.ruler.followMode === "trackpad" && !isTouchCapableDevice()) {
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
        if (parsed.ruler?.rulerModeType && ["line", "word"].includes(parsed.ruler.rulerModeType)) {
          merged.ruler.rulerModeType = parsed.ruler.rulerModeType;
        } else if (parsed.ruler?.wordTracking) {
          merged.ruler.rulerModeType = "word";
        } else {
          merged.ruler.rulerModeType = "line";
        }
        merged.ruler.wordTracking = (merged.ruler.rulerModeType === "word");
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
        if (!["mouse", "keyboard", "trackpad"].includes(settings.ruler.followMode)) {
          settings.ruler.followMode = "mouse";
        }
        if (settings.ruler.followMode === "trackpad" && !isTouchCapableDevice()) {
          settings.ruler.followMode = "mouse";
        }
        localStorage.setItem("rulerSnapToLines", String(settings.ruler.snapToLines));
        if (settings.ruler.pdfAutoHeight !== undefined) {
          localStorage.setItem("rulerPdfAutoHeight", String(settings.ruler.pdfAutoHeight !== false));
        }
      }
      const isVisible = (settings.showProgressBar !== undefined ? settings.showProgressBar : settings.showFooterBar) !== false;
      settings.showFooterBar = isVisible;
      settings.showProgressBar = isVisible;
      localStorage.setItem('showProgressBar', String(isVisible));
      if (settings.liquidGlassUi !== undefined) {
        localStorage.setItem("liquidGlassUi", String(!!settings.liquidGlassUi));
      }
      if (settings.parchmentTexture !== undefined) {
        localStorage.setItem("parchmentTexture", String(!!settings.parchmentTexture));
      }
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
   * Pomocná metoda pro vyčištění a vyhlazení intra_session_samples:
   * - Odstraní umělé počáteční 220 WPM seed body (body v čase 0s nebo počáteční plochou sérii 220 WPM).
   * - Odfiltruje nulové (0 WPM) propady vzniklé při pauzách / nečinnosti.
   * - Potlačí izolované špičky (outlier despiking) a aplikuje klouzavý průměr (Moving Average 3–5 vzorků).
   * - Normalizuje vzorky na čisté 1-minutové intervaly { minute, elapsedSeconds, t, words, wpm }.
   */
  _cleanIntraSessionSamples(rawSamples, durationSec, wordsRead, avgWpm, fallbackTimestamp = Date.now()) {
    if (typeof rawSamples === "string") {
      try {
        rawSamples = JSON.parse(rawSamples);
      } catch (_) {
        rawSamples = [];
      }
    }
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      return [];
    }

    // 1. Odstranit body s elapsedSeconds <= 0 (počáteční 0s seed), nulové (0 WPM) idle propady a neplatné hodnoty
    let list = rawSamples.map((s, idx) => {
      const sec = Math.round(Number(s.elapsedSeconds ?? s.t ?? (s.minute ? s.minute * 60 : (idx + 1) * 60)));
      const rawRate = Math.round(Number(s.rawWpm ?? s.wpm ?? s.instantaneousWpm ?? 0));
      const wpm = Math.round(Number(s.wpm ?? s.instantaneousWpm ?? 0));
      const words = s.words !== undefined ? Math.round(Number(s.words)) : wpm;
      const effectiveWpm = wpm > 0 ? wpm : words;
      const minute = Number(s.minute) > 0 ? Number(s.minute) : Math.max(1, Math.ceil(sec / 60));
      return {
        minute,
        elapsedSeconds: sec,
        t: sec,
        words: Math.max(0, words > 0 ? words : effectiveWpm),
        rawWpm: Math.max(0, rawRate > 0 ? rawRate : effectiveWpm),
        wpm: Math.max(0, effectiveWpm),
        instantaneousWpm: Math.max(0, effectiveWpm),
        timestamp: s.timestamp || fallbackTimestamp,
        activeSeconds: s.activeSeconds || 60,
        isPartial: !!s.isPartial
      };
    }).filter(s => s.elapsedSeconds > 0 && s.wpm > 0 && s.wpm <= 650);

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

    // 4. Zachování neměnných 1-minutových snímků tempa bez klouzavého průměru a škálování
    return deduped.map((s, i) => {
      const minuteNum = Number(s.minute) > 0 ? Number(s.minute) : (i + 1);
      const isLastPartial = s.isPartial && i === deduped.length - 1 && durationSec > (minuteNum - 1) * 60 && durationSec < minuteNum * 60;
      const elapsedSec = isLastPartial ? durationSec : (s.elapsedSeconds || minuteNum * 60);
      const safeWpm = Math.min(650, Math.max(1, Math.round(Number(s.wpm ?? s.instantaneousWpm ?? s.rawWpm ?? 0))));
      const safeWords = s.words !== undefined ? Math.round(Number(s.words)) : safeWpm;
      const finalWpm = safeWpm > 0 ? safeWpm : safeWords;
      return {
        ...s,
        minute: minuteNum,
        elapsedSeconds: elapsedSec,
        t: elapsedSec,
        words: safeWords,
        wpm: finalWpm,
        rawWpm: Math.round(Number(s.rawWpm ?? finalWpm)),
        instantaneousWpm: finalWpm,
        isPartial: !!s.isPartial
      };
    });
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

        let samples = s.intra_session_samples || s.intraSessionSamples || s.timelineSamples;
        if (typeof samples === "string") {
          try { samples = JSON.parse(samples); } catch (_) { samples = []; }
        }
        samples = Array.isArray(samples) ? samples : [];
        const samplesWords = samples.reduce((sum, pt) => sum + Math.max(0, Math.round(pt.words || 0)), 0);
        if (words === 0 && samplesWords > 0) {
          hasAnomaly = true;
          break;
        }
        if (samples.some(pt => (Number(pt.elapsedSeconds ?? pt.t ?? 60) <= 0) || (Number(pt.wpm) === 220 && Math.abs(expectedAvg - 220) > 10))) {
          hasAnomaly = true;
          break;
        }

        const speeds = samples.map(pt => Number(pt.wpm) || 0).filter(w => w > 0);
        const expectedPeak = Math.max(speeds.length > 0 ? Math.max(...speeds) : expectedAvg, expectedAvg);
        const storedPeak = s.peak_wpm ?? s.peakWpm ?? 0;
        if (storedPeak !== expectedPeak || (storedPeak < expectedAvg && expectedAvg > 0)) {
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
    let allSessions = [];
    let books = [];
    try {
      allSessions = await this.getAllReadingSessions();
      books = await this.getAllBooks();
    } catch (_) {}
    let normalizedCount = 0;

    const dailyReadingMap = {};
    let totalActiveSeconds = 0;
    let totalWords = 0;

    for (const session of allSessions) {
      if (!session || typeof session !== "object") continue;
      const targetSid = session.sessionId || session.id;

      if (session.is_deleted === true || session.is_deleted === "true") {
        if (targetSid) {
          try {
            await this.deleteReadingSession(targetSid, true);
          } catch (_) {}
        }
        normalizedCount++;
        continue;
      }
      const durationSec = Math.max(0, Math.round(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
      // Úplné odstranění relací nesplňujících minimální práh 5 minut (300 sekund)
      if (durationSec < 300) {
        if (targetSid) {
          try {
            await this.deleteReadingSession(targetSid, true);
          } catch (_) {}
        }
        normalizedCount++;
        continue;
      }

      let rawSamples = session.intra_session_samples || session.intraSessionSamples || session.timelineSamples;
      if (typeof rawSamples === "string") {
        try {
          rawSamples = JSON.parse(rawSamples);
        } catch (_) {
          rawSamples = [];
        }
      }
      rawSamples = Array.isArray(rawSamples) ? rawSamples : [];
      const samplesWords = rawSamples.reduce((sum, pt) => sum + Math.max(0, Math.round(pt.words || 0)), 0);
      let words = Math.max(0, Math.round(session.words_read ?? session.wordsRead ?? 0));
      if (words === 0 && samplesWords > 0) {
        words = samplesWords;
      }
      const avgWpm = durationSec >= 10 ? Math.round((words / durationSec) * 60) : 0;
      const fallbackTs = session.timestamp || ((session.startTime || session.start_time) ? new Date(session.startTime || session.start_time).getTime() : Date.now());
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
            rawWpm: avgWpm,
            wpm: avgWpm,
            instantaneousWpm: avgWpm,
            timestamp: fallbackTs,
            isPartial: false
          });
        }
        const remSec = durationSec - fullMins * 60;
        if (remSec >= 15) {
          cleanedSamples.push({
            minute: fullMins + 1,
            elapsedSeconds: durationSec,
            t: durationSec,
            words: Math.round((avgWpm * remSec) / 60),
            rawWpm: avgWpm,
            wpm: avgWpm,
            instantaneousWpm: avgWpm,
            timestamp: fallbackTs,
            isPartial: true
          });
        }
      }

      const sampleSpeeds = cleanedSamples.map(s => s.wpm).filter(w => w > 0);
      let peakWpm = sampleSpeeds.length > 0 ? Math.max(...sampleSpeeds) : avgWpm;
      if (peakWpm < avgWpm && avgWpm > 0) {
        peakWpm = avgWpm;
      }

      const normalizedDate = this.getLocalDateString(session.date || session.startTime || session.start_time || session.timestamp);
      const prevAvg = session.avg_wpm ?? session.avgWpm ?? session.wpm;
      const prevPeak = session.peak_wpm ?? session.peakWpm;

      const changed = (
        prevAvg !== avgWpm ||
        prevPeak !== peakWpm ||
        session.date !== normalizedDate ||
        cleanedSamples.length !== rawSamples.length ||
        session.words_read !== words ||
        session.duration !== durationSec ||
        cleanedSamples.some((cs, i) => !rawSamples[i] || rawSamples[i].wpm !== cs.wpm || rawSamples[i].rawWpm !== cs.rawWpm)
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
      if (changed || !session.updatedAt) {
        session.updatedAt = new Date().toISOString();
      }

      try {
        await this.saveReadingSession(session);
        if (changed) {
          normalizedCount++;
        }
      } catch (saveErr) {
        console.warn("[storage] Chyba při ukládání normalizované relace:", saveErr);
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
    // 0. Zaznamenat všechny stávající ID relací do tombstones před vymazáním
    try {
      const existing = await this.getAllReadingSessions();
      if (Array.isArray(existing)) {
        for (const s of existing) {
          const sid = String(s.sessionId || s.id || "").trim();
          if (sid) {
            this.addDeletedSessionId(sid);
          }
        }
      }
    } catch (_) {}

    try {
      const db = await this.getDB();
      if (db && db.objectStoreNames) {
        const stores = [];
        if (db.objectStoreNames.contains("reading_sessions")) stores.push("reading_sessions");
        if (db.objectStoreNames.contains("sessions")) stores.push("sessions");

        if (stores.length > 0) {
          await new Promise((resolve) => {
            try {
              const tx = db.transaction(stores, "readwrite");
              stores.forEach(s => {
                try { tx.objectStore(s).clear(); } catch (_) {}
              });
              tx.oncomplete = () => resolve(true);
              tx.onerror = () => resolve(true);
              tx.onabort = () => resolve(true);
            } catch (_) {
              resolve(true);
            }
          });
        }
      }
    } catch (_) {}

    try {
      localStorage.removeItem("lumina_reading_sessions");
      localStorage.removeItem("luminareader_daily_reading_time");
      localStorage.removeItem("reading_stats_summary");
    } catch (_) {}

    // Resetovat slova a rychlost u knih bez smazání samotných knih a jejich postupu
    const books = await this.getAllBooks();
    for (const book of books) {
      book.wordsRead = 0;
      delete book.lastWpm;
      book.highWaterMark = null;
      book.creditedBlocks = [];
      await this.saveBook(book);
    }

    return true;
  }

  async deleteBookRaw(id) {
    if (!id) return false;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("books")) return false;
    return new Promise((resolve) => {
      try {
        const storeNames = ["books"];
        if (db.objectStoreNames.contains("book_files")) storeNames.push("book_files");
        if (db.objectStoreNames.contains("covers")) storeNames.push("covers");
        const tx = db.transaction(storeNames, "readwrite");
        tx.objectStore("books").delete(id);
        if (db.objectStoreNames.contains("book_files")) {
          try { tx.objectStore("book_files").delete(id); } catch (_) {}
        }
        if (db.objectStoreNames.contains("covers")) {
          try { tx.objectStore("covers").delete(id); } catch (_) {}
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async saveBookRaw(bookData) {
    if (!bookData) return null;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames || !db.objectStoreNames.contains("books")) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("books", "readwrite");
        const store = tx.objectStore("books");
        store.put(bookData);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async migrateSessionsBookId(oldBookId, newBookId) {
    if (!oldBookId || !newBookId || oldBookId === newBookId) return;
    const db = await this.getDB();
    if (!db || !db.objectStoreNames) return;
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
      if (!hash && b.id?.startsWith("pdf_")) {
        const m = b.id.match(/^pdf_([a-f0-9]{64}_\d+)$/);
        if (m) {
          hash = m[1];
          b.fileHash = hash;
          b.file_hash = hash;
        }
      }
      if (!hash && (b.data || b.fileData || b.hasLocalFile)) {
        try {
          const bin = b.data || b.fileData || await this.getBookFile(b.id);
          if (bin) {
            hash = await computeFileHash(bin);
            if (hash) {
              b.fileHash = hash;
              b.file_hash = hash;
            }
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
          await this._migrateBookAssets(oldId, canonicalId);
          await this.deleteBookRaw(oldId);
          book.id = canonicalId;
          book.file_path = `books/${canonicalId}.pdf`;
          await this.saveBook(book);
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
        await this._migrateBookAssets(loser.id, canonicalId);
        await this.deleteBookRaw(loser.id);
        await this.migrateSessionsBookId(loser.id, canonicalId);
        this.migrateLocalStorageProgress(loser.id, canonicalId);
      }

      if (winner.id !== canonicalId) {
        const oldWinnerId = winner.id;
        await this._migrateBookAssets(oldWinnerId, canonicalId);
        await this.deleteBookRaw(oldWinnerId);
        winner.id = canonicalId;
        await this.migrateSessionsBookId(oldWinnerId, canonicalId);
        this.migrateLocalStorageProgress(oldWinnerId, canonicalId);
      }

      winner.file_path = `books/${canonicalId}.pdf`;
      await this.saveBook(winner);

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

export async function pushReadingSessionsToCloud(sessions) {
  return await storage.pushReadingSessionsToCloud(sessions);
}

export function normalizeBookProgress(book) {
  return storage.normalizeBookProgress(book);
}

export function getBookProgressTimestamp(record) {
  return storage.getBookProgressTimestamp(record);
}

export async function deduplicateBooks() {
  return await storage.deduplicateBooks();
}

export async function purgeOrphanReadingSessions(remoteValidIds, remoteDeletedIds) {
  return await storage.purgeOrphanReadingSessions(remoteValidIds, remoteDeletedIds);
}

export async function reconcileReadingSessions(remoteSessions) {
  return await storage.reconcileReadingSessions(remoteSessions);
}

export async function reconcileSessionsWithCloud() {
  return await storage.reconcileSessionsWithCloud();
}
