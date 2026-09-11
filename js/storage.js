/**
 * storage.js - Správa trvalého úložiště IndexedDB a LocalStorage.
 * Ukládá knihy (včetně celých souborů a obálek), historii čtení,
 * statistiky a uživatelská nastavení zobrazení a pravítka.
 */

const DB_NAME = "LuminaReaderDB";
const DB_VERSION = 1;

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

        // Úložiště pro čtecí relace (historie čtení a rychlosti)
        if (!db.objectStoreNames.contains("sessions")) {
          const sessionStore = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          sessionStore.createIndex("bookId", "bookId", { unique: false });
          sessionStore.createIndex("date", "date", { unique: false });
          sessionStore.createIndex("timestamp", "timestamp", { unique: false });
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
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      const request = store.put(bookData);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getBook(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readonly");
      const store = tx.objectStore("books");
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
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
      const tx = db.transaction(["books", "sessions"], "readwrite");
      const bookStore = tx.objectStore("books");
      bookStore.delete(id);

      // Smazat i přidružené relace
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

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateBookProgress(bookId, updates) {
    const book = await this.getBook(bookId);
    if (!book) return;
    Object.assign(book, updates, { lastReadAt: Date.now() });
    return await this.saveBook(book);
  }

  // --- ČTECÍ RELACE A STATISTIKY (SESSIONS) ---

  async logReadingSession(sessionData) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      
      const record = {
        ...sessionData,
        timestamp: Date.now(),
        date: new Date().toISOString().split("T")[0] // YYYY-MM-DD
      };

      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllSessions() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getSessionsByBook(bookId) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const index = store.index("bookId");
      const request = index.getAll(bookId);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  // --- NASTAVENÍ ČTEČKY (SETTINGS V LOCALSTORAGE) ---

  getSettings() {
    const defaults = {
      theme: "warm", // light, warm, sepia, dark, oled
      fontFamily: "georgia", // georgia, inter, merriweather, opendyslexic
      fontSize: 19, // px
      lineHeight: 1.65,
      contentWidth: 720, // px
      textAlign: "justify", // left, justify
      readingMode: "scroll", // scroll, paginated
      showFooterBar: false, // skrytí spodní lišty čtečky
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
        if (merged.ruler.mode === "underline") {
          merged.ruler.mode = "highlight";
        }
        if (merged.ruler.followMode !== "keyboard") {
          merged.ruler.followMode = "mouse";
        }
        return merged;
      }
    } catch (e) {
      console.warn("Chyba při čtení nastavení z localStorage:", e);
    }
    return defaults;
  }

  saveSettings(settings) {
    try {
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
}

export const storage = new StorageManager();
