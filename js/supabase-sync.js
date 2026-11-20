/**
 * supabase-sync.js - Synchronizační a zálohovací vrstva pro Supabase.
 * Zajišťuje asynchronní ukládání knih a postupu čtení do Supabase,
 * obousměrnou synchronizaci mezi zařízeními a offline-first fungování.
 */

import { supabase, STORAGE_BUCKET, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js?v=2.9.9';
import { storage, computeFileHash, getBookProgressTimestamp } from './storage.js?v=2.9.9';
import { EpubParser } from './epub-parser.js?v=2.9.9';

export class SupabaseSync {
  constructor() {
    this.status = "idle"; // "idle" | "syncing" | "synced" | "error" | "offline"
    this.statusListeners = new Set();
    this.syncCompletedListeners = new Set();
    this.pendingProgress = new Map();
    this.progressDebounceTimer = null;
    this._inFlightProgress = new Set();
    this._booksSchemaHasAnchorCols = true;
    this._booksSchemaHasExtendedCols = true;
    this._inFlightDownloads = new Map();
    this._inFlightCoverDownloads = new Map();
    this._failedCoverPaths = new Set();
    this.isSyncing = false;
    this._lastSyncTime = 0;

    // Sledování změn síťového připojení a životního cyklu stránky (okamžitý flush při uspání/zavření)
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleOnline());
      window.addEventListener("offline", () => this.handleOffline());
      window.addEventListener("beforeunload", () => this.flushPendingProgress({ keepalive: true }));
      window.addEventListener("pagehide", () => this.flushPendingProgress({ keepalive: true }));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.flushPendingProgress({ keepalive: true });
        }
      });

      if (!navigator.onLine) {
        this.status = "offline";
      }
    }
  }

  // Registrace posluchače stavu synchronizace
  onStatusChange(callback) {
    this.statusListeners.add(callback);
    callback(this.status);
    return () => this.statusListeners.delete(callback);
  }

  // Registrace posluchače dokončení synchronizace
  onSyncCompleted(callback) {
    this.syncCompletedListeners.add(callback);
    return () => this.syncCompletedListeners.delete(callback);
  }

  notifySyncCompleted(stats) {
    for (const listener of this.syncCompletedListeners) {
      try {
        listener(stats);
      } catch (e) {
        console.warn("[SupabaseSync] Chyba v posluchači syncCompleted:", e);
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("lumina-sync-completed", { detail: { stats } }));
    }
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(this.status);
      } catch (e) {
        console.warn("[SupabaseSync] Chyba v posluchači stavu:", e);
      }
    }
  }

  handleOnline() {
    console.log("[SupabaseSync] Zařízení je opět online, spouštím synchronizaci...");
    this.setStatus("idle");
    this.syncAll({ silent: true });
  }

  handleOffline() {
    console.log("[SupabaseSync] Zařízení přešlo do režimu offline.");
    this.setStatus("offline");
  }

  isConfigured() {
    return Boolean(supabase && SUPABASE_URL && SUPABASE_ANON_KEY);
  }

  isOnline() {
    const navOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
    return navOnline && this.isConfigured();
  }

  /**
   * Nahraje knihu a její binární soubor do Supabase Storage a zapíše metadata do tabulky books
   */
  async uploadBook(book) {
    if (!this.isOnline() || !supabase) {
      console.warn("[Supabase Sync] Nelze nahrát knihu: zařízení je offline nebo chybí Supabase klient.");
      return null;
    }

    if (!book) {
      console.warn("[Supabase Sync] Kniha nebyla zadána.");
      return null;
    }

    try {
      // Normalizace fileName
      if (!book.fileName && book.file_name) {
        book.fileName = book.file_name;
      }
      if (!book.fileName) {
        const isPdf = !!(book.isPdf || book.format === 'pdf');
        const fallbackExt = isPdf ? 'pdf' : 'epub';
        const cleanTitle = (book.title || book.id || 'book')
          .replace(/[^a-zA-Z0-9_\-\u00C0-\u017F]/g, '_')
          .slice(0, 40);
        book.fileName = `${cleanTitle}.${fallbackExt}`;
      }
      book.file_name = book.fileName;

      // Normalizace typu souboru dle požadavků
      const isPdf = !!(book.isPdf || book.format === 'pdf' || book.fileName?.toLowerCase().endsWith('.pdf'));
      const ext = book.fileName.split('.').pop().toLowerCase();
      const fileType = isPdf ? 'pdf' : (ext === 'pdf' ? 'pdf' : 'epub'); // striktně malá písmena
      const mimeType = fileType === 'pdf' ? 'application/pdf' : 'application/epub+zip';

      // Surová binární data (ArrayBuffer, Uint8Array, Blob nebo ze store "book_files")
      const rawBinary = book.data || book.fileData || (book.id ? await storage.getBookFile(book.id) : null);
      if (!rawBinary) {
        const missingDataErr = new Error("Kniha neobsahuje surová binární data (book.data / book.fileData)");
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, missingDataErr);
        throw missingDataErr;
      }

      // Výpočet deterministického hashe souboru (pro PDF i EPUB) a ID pro PDF
      if (!book.fileHash && !book.file_hash) {
        try {
          const h = await computeFileHash(rawBinary);
          if (h) {
            book.fileHash = h;
            book.file_hash = h;
          }
        } catch (_) {}
      }
      if (isPdf) {
        const h = book.fileHash || book.file_hash;
        if (h) {
          const canonicalId = `pdf_${h}`;
          if (!book.id || (book.id.startsWith("pdf_") && book.id !== canonicalId)) {
            book.id = canonicalId;
          }
        }
      }

      // Deterministická cesta v Supabase Storage (e.g. books/${book.id}.pdf pro PDF)
      const storagePath = isPdf ? `books/${book.id}.pdf` : (book.file_path || `${book.id}/${book.fileName}`);
      book.file_path = storagePath;

      // Vytvoření správně otypovaného Blobu
      let uploadBlob;
      if (rawBinary instanceof Blob) {
        uploadBlob = rawBinary.type === mimeType ? rawBinary : new Blob([rawBinary], { type: mimeType });
      } else if (rawBinary instanceof ArrayBuffer) {
        uploadBlob = new Blob([rawBinary.slice(0)], { type: mimeType });
      } else if (ArrayBuffer.isView(rawBinary)) {
        uploadBlob = new Blob([rawBinary.buffer.slice(rawBinary.byteOffset, rawBinary.byteOffset + rawBinary.byteLength)], { type: mimeType });
      } else {
        uploadBlob = new Blob([rawBinary], { type: mimeType });
      }
      book.fileSize = uploadBlob.size;
      book.file_size = uploadBlob.size;

      console.log(`[Supabase Sync] Nahrávám ${fileType.toUpperCase()} "${book.title}" (${uploadBlob.size} B, mime: ${mimeType}) do ${storagePath}...`);

      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, uploadBlob, {
          contentType: mimeType,
          cacheControl: "31536000",
          upsert: true
        });

      if (error) {
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, error);
        throw error;
      }

      // Nahrání náhledu obálky samostatně do Storage (pokud existuje) pro lehkou knihovnu bez stahování celé knihy
      let coverPath = book.cover_path || null;
      let coverHash = book.coverHash || book.cover_hash || null;
      const localCoverUrl = book.coverDataUrl || (await storage.getBookCover(book.id))?.dataUrl || null;
      if (localCoverUrl && this._booksSchemaHasExtendedCols && (!coverPath || !coverHash)) {
        try {
          const uploadedCover = await this.uploadBookCover(book.id, localCoverUrl);
          if (uploadedCover) {
            coverPath = uploadedCover.coverPath;
            coverHash = uploadedCover.coverHash;
            book.cover_path = coverPath;
            book.coverHash = coverHash;
            book.cover_hash = coverHash;
          }
        } catch (coverErr) {
          console.warn("[Supabase Sync] Varování při nahrávání obálky:", coverErr);
        }
      }

      // Zápis / aktualizace metadat v databázi (tabulka books)
      const scrollProg = isPdf
        ? (Number(book.scrollPercent ?? book.pageRatio ?? 0) || 0)
        : (book.readingAnchor && typeof book.readingAnchor.bookProgress === "number"
          ? Math.max(0, Math.min(1, book.readingAnchor.bookProgress / 100))
          : (Number(book.scrollPercent ?? book.pageRatio ?? 0) || 0));
      const chIdx = Number(book.currentChapterIndex) || 0;
      const pIdx = Math.max(1, (Number(book.currentPageIndex) || 0) + 1);
      const rulerH = Number(book.pdfRulerConfig?.height) || 32;
      const progTs = getBookProgressTimestamp(book);

      const row = {
        id: book.id,
        title: book.title || "Bez názvu",
        file_name: book.fileName,
        file_type: fileType, // striktně malá písmena 'epub' nebo 'pdf' (pro check constraint books_file_type_check)
        file_path: storagePath,
        current_chapter: chIdx,
        current_page: pIdx,
        scroll_progress: scrollProg,
        pdf_ruler_height: rulerH,
        updated_at: new Date(progTs || book.lastReadAt || Date.now()).toISOString()
      };

      if (this._booksSchemaHasAnchorCols) {
        row.reading_anchor = book.readingAnchor || null;
        row.progress_updated_at = progTs > 0 ? new Date(progTs).toISOString() : null;
      }

      if (this._booksSchemaHasExtendedCols) {
        row.author = book.author || book.creator || null;
        row.file_size = uploadBlob.size;
        row.file_hash = book.fileHash || book.file_hash || null;
        row.cover_path = coverPath;
        row.cover_hash = coverHash;
        row.total_pages = Number(book.numPages || book.total_pages) || null;
        row.total_chapters = Number(book.totalChapters || book.total_chapters) || null;
        row.total_words = Number(book.totalWords || book.total_words) || null;
      }

      const dbError = await this._upsertBooksRow(row);
      if (dbError) {
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, dbError);
        throw dbError;
      }

      console.log(`[Supabase Sync] Kniha "${book.title}" byla úspěšně nahrána do cloudu.`);
      return { success: true, filePath: storagePath, coverPath, coverHash };
    } catch (err) {
      console.error("[Supabase Sync] Upload failed:", err);
      return null;
    }
  }

  /**
   * Smaže knihu z cloudu (tabulka books i binární soubor ve Storage)
   */
  async deleteBook(bookId) {
    if (!this.isOnline() || !supabase) return;

    try {
      console.log(`[SupabaseSync] Mažu knihu ${bookId} z cloudu...`);
      // Zjistíme cestu k souboru a obálce
      let bookRow = null;
      const selectCols = this._booksSchemaHasExtendedCols ? "file_path, cover_path" : "file_path";
      const res = await supabase
        .from("books")
        .select(selectCols)
        .eq("id", bookId)
        .maybeSingle();
      if (res.error && this._isMissingExtendedColumnError(res.error)) {
        this._booksSchemaHasExtendedCols = false;
        const retry = await supabase.from("books").select("file_path").eq("id", bookId).maybeSingle();
        bookRow = retry.data;
      } else {
        bookRow = res.data;
      }

      const pathsToRemove = [];
      if (bookRow?.file_path) {
        pathsToRemove.push(bookRow.file_path);
      }
      if (bookRow?.cover_path) {
        pathsToRemove.push(bookRow.cover_path);
      }
      if (bookId && bookId.startsWith("pdf_")) {
        pathsToRemove.push(`books/${bookId}.pdf`);
      }

      if (pathsToRemove.length > 0) {
        await supabase.storage.from(STORAGE_BUCKET).remove(Array.from(new Set(pathsToRemove)));
      }

      // Soft-delete relací přiřazených k mazané knize
      try {
        const nowIso = new Date().toISOString();
        let { error: sessDelErr } = await supabase
          .from("reading_sessions")
          .update({
            is_deleted: true,
            updated_at: nowIso
          })
          .eq("book_id", bookId);

        if (sessDelErr && (sessDelErr.code === "PGRST204" || sessDelErr.code === "42703" || sessDelErr.message?.includes("is_deleted"))) {
          await supabase.from("reading_sessions").delete().eq("book_id", bookId);
        }
      } catch (sessErr) {
        console.warn("[SupabaseSync] Varování při soft-delete relací smazané knihy:", sessErr);
      }

      await supabase.from("books").delete().eq("id", bookId);
      console.log(`[SupabaseSync] Kniha ${bookId} byla odstraněna z cloudu.`);
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při mazání knihy z cloudu:", err);
    }
  }

  _isMissingAnchorColumnError(error) {
    if (!error) return false;
    const msg = String(error.message || "");
    return msg.includes("reading_anchor") ||
      msg.includes("progress_updated_at");
  }

  _isMissingExtendedColumnError(error) {
    if (!error) return false;
    const msg = String(error.message || "");
    return (
      msg.includes("author") ||
      msg.includes("file_size") ||
      msg.includes("file_hash") ||
      msg.includes("cover_path") ||
      msg.includes("cover_hash") ||
      msg.includes("total_pages") ||
      msg.includes("total_chapters") ||
      msg.includes("total_words") ||
      ((error.code === "PGRST204" || error.code === "42703") && !this._isMissingAnchorColumnError(error))
    );
  }

  _stripAnchorCols(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const copy = { ...payload };
    delete copy.reading_anchor;
    delete copy.progress_updated_at;
    return copy;
  }

  _stripExtendedCols(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const copy = { ...payload };
    delete copy.author;
    delete copy.file_size;
    delete copy.file_hash;
    delete copy.cover_path;
    delete copy.cover_hash;
    delete copy.total_pages;
    delete copy.total_chapters;
    delete copy.total_words;
    return copy;
  }

  async _upsertBooksRow(row) {
    let payload = { ...row };
    if (!this._booksSchemaHasAnchorCols) payload = this._stripAnchorCols(payload);
    if (!this._booksSchemaHasExtendedCols) payload = this._stripExtendedCols(payload);

    let { error } = await supabase.from("books").upsert(payload, { onConflict: "id" });
    for (let attempt = 0; attempt < 2 && error; attempt++) {
      let changed = false;
      if (this._isMissingAnchorColumnError(error) && this._booksSchemaHasAnchorCols) {
        this._booksSchemaHasAnchorCols = false;
        payload = this._stripAnchorCols(payload);
        changed = true;
      }
      if (this._isMissingExtendedColumnError(error) && this._booksSchemaHasExtendedCols) {
        this._booksSchemaHasExtendedCols = false;
        payload = this._stripExtendedCols(payload);
        changed = true;
      }
      if (!changed) break;
      const retry = await supabase.from("books").upsert(payload, { onConflict: "id" });
      error = retry.error;
    }
    return error || null;
  }

  async _updateBooksRow(bookId, patch) {
    let payload = { ...patch };
    if (!this._booksSchemaHasAnchorCols) payload = this._stripAnchorCols(payload);
    if (!this._booksSchemaHasExtendedCols) payload = this._stripExtendedCols(payload);

    let { error } = await supabase.from("books").update(payload).eq("id", bookId);
    for (let attempt = 0; attempt < 2 && error; attempt++) {
      let changed = false;
      if (this._isMissingAnchorColumnError(error) && this._booksSchemaHasAnchorCols) {
        this._booksSchemaHasAnchorCols = false;
        payload = this._stripAnchorCols(payload);
        changed = true;
      }
      if (this._isMissingExtendedColumnError(error) && this._booksSchemaHasExtendedCols) {
        this._booksSchemaHasExtendedCols = false;
        payload = this._stripExtendedCols(payload);
        changed = true;
      }
      if (!changed) break;
      const retry = await supabase.from("books").update(payload).eq("id", bookId);
      error = retry.error;
    }
    return error || null;
  }

  _extractPdfHashFromCloudBook(cloudBook) {
    if (!cloudBook) return null;
    if (cloudBook.file_hash) return cloudBook.file_hash;
    if (cloudBook.id?.startsWith("pdf_")) {
      const m = cloudBook.id.match(/^pdf_([a-f0-9]{64}_\d+)$/);
      if (m) return m[1];
    }
    if (cloudBook.file_path) {
      const m = cloudBook.file_path.match(/pdf_([a-f0-9]{64}_\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  async _dataUrlToBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return null;
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  async _blobToDataUrl(blob) {
    if (!blob) return null;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async _createCoverThumbnailBlob(dataUrlOrBlob) {
    const origBlob = (typeof dataUrlOrBlob === "string")
      ? await this._dataUrlToBlob(dataUrlOrBlob)
      : dataUrlOrBlob;
    if (!origBlob) return null;

    const origMime = origBlob.type || "image/jpeg";
    const origExt = origMime.includes("png") ? "png" : (origMime.includes("webp") ? "webp" : "jpg");

    if (origBlob.size <= 65 * 1024 || typeof document === "undefined" || typeof createImageBitmap !== "function") {
      return { blob: origBlob, mimeType: origMime, ext: origExt };
    }

    try {
      const bitmap = await createImageBitmap(origBlob);
      const maxWidth = 400;
      const scale = bitmap.width > maxWidth ? (maxWidth / bitmap.width) : 1;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return { blob: origBlob, mimeType: origMime, ext: origExt };
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const thumbBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
      if (thumbBlob && thumbBlob.size < origBlob.size) {
        return { blob: thumbBlob, mimeType: "image/jpeg", ext: "jpg" };
      }
    } catch (_) {}

    return { blob: origBlob, mimeType: origMime, ext: origExt };
  }

  async uploadBookCover(bookId, coverDataUrl) {
    if (!this.isOnline() || !supabase || !bookId || !coverDataUrl) return null;
    const prepared = await this._createCoverThumbnailBlob(coverDataUrl);
    if (!prepared?.blob) return null;

    const coverHash = await computeFileHash(prepared.blob);
    const coverPath = `covers/${bookId}.${prepared.ext}`;

    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(coverPath, prepared.blob, {
        contentType: prepared.mimeType,
        cacheControl: "31536000",
        upsert: true
      });

    if (error) {
      throw error;
    }

    await storage.saveBookCover(bookId, {
      dataUrl: coverDataUrl,
      coverHash,
      coverPath
    });

    return { coverPath, coverHash };
  }

  /**
   * Stáhne obálku knihy ze Supabase Storage nanejvýš jednou pro dané zařízení / cover_hash
   * a uloží ji trvale do IndexedDB store "covers".
   */
  async ensureBookCoverCached(bookId, cloudBook) {
    if (!bookId || !cloudBook) return false;
    const coverPath = cloudBook.cover_path || cloudBook.coverPath || null;
    if (!coverPath || this._failedCoverPaths.has(coverPath)) return false;

    const remoteHash = cloudBook.cover_hash || cloudBook.coverHash || null;
    const existing = await storage.getBookCover(bookId);
    if (existing?.dataUrl) {
      if (!remoteHash || existing.coverHash === remoteHash || (!existing.coverHash && existing.coverPath === coverPath)) {
        return false;
      }
    }

    if (remoteHash) {
      const cachedByHash = await storage.getBookCoverByHash(remoteHash);
      if (cachedByHash?.dataUrl) {
        await storage.saveBookCover(bookId, {
          dataUrl: cachedByHash.dataUrl,
          coverHash: remoteHash,
          coverPath
        });
        return true;
      }
    }

    if (!this.isOnline() || !supabase) return false;

    const flightKey = `${bookId}::${coverPath}`;
    if (this._inFlightCoverDownloads.has(flightKey)) {
      return await this._inFlightCoverDownloads.get(flightKey);
    }

    const task = (async () => {
      try {
        const { data: blob, error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .download(coverPath);

        if (error || !blob) {
          this._failedCoverPaths.add(coverPath);
          return false;
        }

        const dataUrl = await this._blobToDataUrl(blob);
        if (!dataUrl) return false;
        const coverHash = remoteHash || await computeFileHash(blob);

        await storage.saveBookCover(bookId, {
          dataUrl,
          coverHash,
          coverPath
        });
        return true;
      } catch (err) {
        console.warn(`[SupabaseSync] Nepodařilo se stáhnout obálku (${coverPath}):`, err);
        return false;
      } finally {
        this._inFlightCoverDownloads.delete(flightKey);
      }
    })();

    this._inFlightCoverDownloads.set(flightKey, task);
    return await task;
  }

  _parseReadingAnchor(rawAnchor) {
    if (!rawAnchor) return null;
    let obj = rawAnchor;
    if (typeof rawAnchor === "string") {
      try {
        obj = JSON.parse(rawAnchor);
      } catch (_) {
        return null;
      }
    }
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.chapterIndex !== "number" && typeof obj.charOffset !== "number" && typeof obj.bookProgress !== "number") {
      return null;
    }
    return obj;
  }

  getCloudBookTimestamp(cloudBook) {
    return getBookProgressTimestamp(cloudBook);
  }

  normalizeCloudBookProgress(cloudBook, localBook = null) {
    if (!cloudBook) return null;
    const cloudTime = this.getCloudBookTimestamp(cloudBook);
    const isPdf = cloudBook.file_type === "pdf" ||
      cloudBook.file_name?.toLowerCase().endsWith(".pdf") ||
      cloudBook.file_path?.toLowerCase().endsWith(".pdf") ||
      !!(localBook?.isPdf || localBook?.format === "pdf");

    const readingAnchor = !isPdf ? this._parseReadingAnchor(cloudBook.reading_anchor || cloudBook.readingAnchor) : null;
    const chIdx = readingAnchor && typeof readingAnchor.chapterIndex === "number"
      ? readingAnchor.chapterIndex
      : (Number(cloudBook.current_chapter) || 0);
    const pIdx = Math.max(0, (Number(cloudBook.current_page) || 1) - 1);
    const currPage = pIdx + 1;
    const rawScroll = Number(cloudBook.scroll_progress) || 0;

    let computedProgress = 0;
    let pageRatio = rawScroll;
    let scrollPercent = rawScroll;
    const totalPages = isPdf ? (localBook?.numPages || cloudBook.total_pages || localBook?.total_pages) : undefined;

    if (isPdf) {
      if (totalPages && totalPages > 0) {
        computedProgress = Math.max(0, Math.min(100, Math.round((currPage / totalPages) * 100)));
      } else {
        computedProgress = Math.max(0, Math.min(100, Math.round((rawScroll > 0 && rawScroll <= 1) ? rawScroll * 100 : rawScroll)));
      }
    } else if (readingAnchor) {
      if (typeof readingAnchor.bookProgress === "number" && !isNaN(readingAnchor.bookProgress)) {
        computedProgress = Math.max(0, Math.min(100, Math.round(readingAnchor.bookProgress)));
      } else {
        computedProgress = Math.max(0, Math.min(100, Math.round((rawScroll > 0 && rawScroll <= 1) ? rawScroll * 100 : rawScroll)));
      }
      if (typeof readingAnchor.chapterRatio === "number" && !isNaN(readingAnchor.chapterRatio)) {
        pageRatio = Math.max(0, Math.min(1, readingAnchor.chapterRatio));
      }
      scrollPercent = computedProgress / 100;
      if (!readingAnchor.updatedAt && cloudTime > 0) {
        readingAnchor.updatedAt = cloudTime;
      }
    } else {
      computedProgress = Math.max(0, Math.min(100, Math.round((rawScroll > 0 && rawScroll <= 1) ? rawScroll * 100 : rawScroll)));
    }

    const updates = {
      currentChapterIndex: chIdx,
      currentPageIndex: pIdx,
      currentPage: currPage,
      scrollPercent,
      scroll_progress: rawScroll,
      pageRatio,
      progress: computedProgress,
      progressPercent: computedProgress,
      progressUpdatedAt: cloudTime,
      lastReadAt: cloudTime || Date.now()
    };
    if (totalPages) {
      updates.numPages = totalPages;
    }
    if (readingAnchor) {
      updates.readingAnchor = readingAnchor;
    }
    if (cloudBook.pdf_ruler_height && localBook?.pdfRulerConfig) {
      updates.pdfRulerConfig = {
        ...localBook.pdfRulerConfig,
        height: cloudBook.pdf_ruler_height,
        stepSize: cloudBook.pdf_ruler_height
      };
    }

    return updates;
  }

  /**
   * Stáhne nejnovější pozici čtení pro konkrétní knihu ze Supabase (pro kontrolu před otevřením)
   */
  async fetchBookProgress(bookId, bookMeta = null) {
    if (!this.isOnline() || !supabase || !bookId) return null;

    try {
      let { data, error } = await supabase
        .from("books")
        .select("*")
        .eq("id", bookId)
        .maybeSingle();

      if (!data && !error && bookMeta?.file_path) {
        const alt = await supabase
          .from("books")
          .select("*")
          .eq("file_path", bookMeta.file_path)
          .maybeSingle();
        data = alt.data;
        error = alt.error;
      }

      if (error || !data) return null;

      const timestamp = this.getCloudBookTimestamp(data);
      const progressUpdates = this.normalizeCloudBookProgress(data, bookMeta);
      return { cloudRow: data, progressUpdates, timestamp };
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při stahování postupu knihy z cloudu:", err);
      return null;
    }
  }

  _buildBookProgressPatch(progressData) {
    const ts = getBookProgressTimestamp(progressData) || Date.now();
    const isoTs = new Date(ts).toISOString();
    const patch = {
      updated_at: isoTs
    };

    if (typeof progressData.currentChapterIndex === "number") {
      patch.current_chapter = progressData.currentChapterIndex;
    }
    if (typeof progressData.currentPageIndex === "number") {
      patch.current_page = progressData.currentPageIndex + 1;
    }
    if (typeof progressData.scrollPercent === "number") {
      patch.scroll_progress = progressData.scrollPercent;
    } else if (typeof progressData.pageRatio === "number") {
      patch.scroll_progress = progressData.pageRatio;
    }
    if (typeof progressData.pdfRulerHeight === "number") {
      patch.pdf_ruler_height = progressData.pdfRulerHeight;
    }

    if (this._booksSchemaHasAnchorCols) {
      if (progressData.readingAnchor !== undefined) {
        patch.reading_anchor = progressData.readingAnchor;
      }
      patch.progress_updated_at = isoTs;
    }

    return patch;
  }

  /**
   * Asynchronní aktualizace postupu čtení s koalescencí nebo okamžitým odesláním
   */
  syncProgress(bookId, progressData, { immediate = false, keepalive = false } = {}) {
    if (!this.isOnline() || !bookId || !progressData) return;

    if (this.progressDebounceTimer) {
      clearTimeout(this.progressDebounceTimer);
      this.progressDebounceTimer = null;
    }

    this.pendingProgress.set(bookId, progressData);

    if (immediate || keepalive) {
      this.flushPendingProgress({ bookId, keepalive });
    } else {
      this.progressDebounceTimer = setTimeout(() => {
        this.progressDebounceTimer = null;
        this.flushPendingProgress();
      }, 250);
    }
  }

  /**
   * Okamžité odeslání čekajícího postupu čtení (s podporou keepalive pro zavření / background)
   */
  async flushPendingProgress({ bookId = null, keepalive = false } = {}) {
    if (!this.isOnline() || !supabase) return;
    if (!this.pendingProgress || this.pendingProgress.size === 0) return;

    const targetIds = bookId
      ? (this.pendingProgress.has(bookId) ? [bookId] : [])
      : Array.from(this.pendingProgress.keys());

    for (const targetBookId of targetIds) {
      if (!keepalive && this._inFlightProgress.has(targetBookId)) {
        continue;
      }
      await this._flushBookProgressQueue(targetBookId, { keepalive });
    }
  }

  async _flushBookProgressQueue(targetBookId, { keepalive = false } = {}) {
    if (!targetBookId || !this.pendingProgress.has(targetBookId)) return;

    if (keepalive) {
      const progressData = this.pendingProgress.get(targetBookId);
      this.pendingProgress.delete(targetBookId);
      await this._sendProgressPatch(targetBookId, progressData, { keepalive: true });
      return;
    }

    if (this._inFlightProgress.has(targetBookId)) return;
    this._inFlightProgress.add(targetBookId);

    try {
      while (this.pendingProgress.has(targetBookId)) {
        const progressData = this.pendingProgress.get(targetBookId);
        this.pendingProgress.delete(targetBookId);
        await this._sendProgressPatch(targetBookId, progressData, { keepalive: false });
      }
    } finally {
      this._inFlightProgress.delete(targetBookId);
    }
  }

  async _sendProgressPatch(bookId, progressData, { keepalive = false } = {}) {
    try {
      const patch = this._buildBookProgressPatch(progressData);

      if (keepalive && typeof fetch === "function" && SUPABASE_URL && SUPABASE_ANON_KEY) {
        const endpoint = `${SUPABASE_URL}/rest/v1/books?id=eq.${encodeURIComponent(bookId)}`;
        const headers = {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        };
        const res = await fetch(endpoint, {
          method: "PATCH",
          keepalive: true,
          headers,
          body: JSON.stringify(patch)
        });
        if (!res.ok && res.status === 400 && this._booksSchemaHasAnchorCols) {
          this._booksSchemaHasAnchorCols = false;
          await fetch(endpoint, {
            method: "PATCH",
            keepalive: true,
            headers,
            body: JSON.stringify(this._stripAnchorCols(patch))
          }).catch(() => {});
        }
        return;
      }

      let { error } = await supabase.from("books").update(patch).eq("id", bookId);
      if (error && this._isMissingAnchorColumnError(error)) {
        this._booksSchemaHasAnchorCols = false;
        const retryRes = await supabase.from("books").update(this._stripAnchorCols(patch)).eq("id", bookId);
        error = retryRes.error;
      }
      if (error) {
        console.warn("[SupabaseSync] Chyba při odesílání postupu čtení:", error);
      }
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při odesílání postupu čtení:", err);
    }
  }

  /**
   * Normalizuje a sloučí duplicitní řádky v cloudu.
   * Odstraní duplikáty z tabulky books a storage Supabase, ponechá záznam s nejaktuálnějším postupem.
   */
  async normalizeAndMergeCloudBooks(cloudBooks) {
    if (!cloudBooks || !Array.isArray(cloudBooks) || cloudBooks.length === 0) return [];

    const pdfGroups = new Map();
    const resultList = [];

    for (const cb of cloudBooks) {
      const isPdf = cb.file_type === "pdf" ||
                    cb.file_name?.toLowerCase().endsWith(".pdf") ||
                    cb.file_path?.toLowerCase().endsWith(".pdf");

      if (!isPdf) {
        resultList.push(cb);
        continue;
      }

      // Seskupení duplikátů PDF:
      // 1. Podle deterministického ID (pdf_hash)
      // 2. Podle storage_path (např. books/pdf_hash.pdf)
      // 3. Podle normalizovaného názvu souboru nebo titulku
      let groupKey = null;
      if (cb.id?.startsWith("pdf_")) {
        const parts = cb.id.split("_");
        if (parts.length >= 3 && parts[1].length === 64) {
          groupKey = `hash_${parts[1]}_${parts[2]}`;
        }
      }

      if (!groupKey && cb.file_path && cb.file_path.includes("pdf_")) {
        const match = cb.file_path.match(/pdf_([a-f0-9]{64}_\d+)/);
        if (match) {
          groupKey = `hash_${match[1]}`;
        }
      }

      if (!groupKey) {
        const cleanName = (cb.file_name || cb.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        groupKey = `pdf_${cleanName}`;
      }

      if (!pdfGroups.has(groupKey)) {
        pdfGroups.set(groupKey, []);
      }
      pdfGroups.get(groupKey).push(cb);
    }

    for (const [groupKey, group] of pdfGroups.entries()) {
      if (group.length === 1) {
        resultList.push(group[0]);
        continue;
      }

      console.log(`[SupabaseSync] Nalezeno ${group.length} duplicitních záznamů v cloudu pro skupinu ${groupKey}, slučuji...`);

      // Seřadit podle nejnovějšího postupu čtení
      group.sort((a, b) => {
        const timeA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const timeB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        if (timeB !== timeA) return timeB - timeA;
        const progA = Number(a.scroll_progress || 0);
        const progB = Number(b.scroll_progress || 0);
        if (progB !== progA) return progB - progA;
        return (Number(b.current_page || 0)) - (Number(a.current_page || 0));
      });

      const winner = group[0];
      const losers = group.slice(1);

      const loserIds = losers.map(l => l.id).filter(Boolean);
      const loserPaths = losers.map(l => l.file_path).filter(Boolean);

      try {
        if (loserIds.length > 0) {
          console.log(`[SupabaseSync] Mažu duplicitní řádky z tabulky books:`, loserIds);
          await supabase.from("books").delete().in("id", loserIds);
        }
        if (loserPaths.length > 0) {
          console.log(`[SupabaseSync] Mažu duplicitní soubory ze Storage:`, loserPaths);
          await supabase.storage.from(STORAGE_BUCKET).remove(loserPaths);
        }
      } catch (err) {
        console.warn("[SupabaseSync] Varování při mazání duplikátů v cloudu:", err);
      }

      resultList.push(winner);
    }

    return resultList;
  }

  /**
   * Stáhne binární soubor knihy (EPUB/PDF) ze Supabase Storage striktně na vyžádání
   * při prvním otevření knihy uživatelem a okamžitě jej uloží do IndexedDB.
   * @param {Object} book
   * @returns {Promise<{ arrayBuffer: ArrayBuffer, book: Object } | null>}
   */
  async downloadBookFile(book) {
    if (!book || !book.id) return null;

    // Nejprve ověřit, zda již soubor mezitím není v IndexedDB
    const alreadyCached = await storage.getBookFile(book.id);
    if (alreadyCached) {
      return { arrayBuffer: alreadyCached, book };
    }

    if (this._inFlightDownloads.has(book.id)) {
      return await this._inFlightDownloads.get(book.id);
    }

    if (!this.isOnline() || !supabase) {
      throw new Error("Zařízení je offline – knihu nelze stáhnout z cloudu.");
    }

    const downloadTask = (async () => {
      const isPdf = !!(book.isPdf || book.format === "pdf" || book.fileName?.toLowerCase().endsWith(".pdf") || book.file_path?.toLowerCase().endsWith(".pdf"));
      const finalFileName = book.fileName || book.file_name || `${book.id}.${isPdf ? "pdf" : "epub"}`;
      let storagePath = book.file_path || (isPdf ? `books/${book.id}.pdf` : `${book.id}/${finalFileName}`);
      if (!storagePath) {
        storagePath = `books/${book.id}.${isPdf ? "pdf" : "epub"}`;
      }

      console.log(`[Supabase Sync] Lazy download souboru knihy "${book.title}" (${storagePath})...`);
      let { data: blob, error: dlErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

      if ((dlErr || !blob) && storagePath.startsWith("books/")) {
        const altPath = storagePath.replace(/^books\//, "");
        const altRes = await supabase.storage.from(STORAGE_BUCKET).download(altPath);
        if (!altRes.error && altRes.data) {
          blob = altRes.data;
          dlErr = null;
          storagePath = altPath;
        }
      } else if ((dlErr || !blob) && !storagePath.startsWith("books/")) {
        const altPath = `books/${storagePath}`;
        const altRes = await supabase.storage.from(STORAGE_BUCKET).download(altPath);
        if (!altRes.error && altRes.data) {
          blob = altRes.data;
          dlErr = null;
          storagePath = altPath;
        }
      }

      if (dlErr || !blob) {
        throw new Error(dlErr?.message || `Soubor knihy (${storagePath}) nebyl v cloudovém úložišti nalezen.`);
      }

      const arrayBuffer = await blob.arrayBuffer();
      const fileHash = await computeFileHash(arrayBuffer);
      const fileSize = arrayBuffer.byteLength;

      const existingCover = await storage.getBookCover(book.id);
      let coverDataUrl = existingCover?.dataUrl || book.coverDataUrl || null;
      let targetBookId = book.id;
      let canonicalStoragePath = storagePath;

      const updatedBook = {
        ...book,
        fileHash: fileHash || book.fileHash || book.file_hash || null,
        file_hash: fileHash || book.file_hash || book.fileHash || null,
        fileSize,
        file_size: fileSize,
        file_path: storagePath,
        hasLocalFile: true
      };

      if (isPdf) {
        if (fileHash) {
          const canonicalId = `pdf_${fileHash}`;
          if (book.id !== canonicalId) {
            const existingCanonical = await storage.getBook(canonicalId);
            if (existingCanonical) {
              targetBookId = canonicalId;
              updatedBook.id = canonicalId;
            } else {
              // Migrovat staré nestabilní ID na deterministické ID lokálně i v cloudu
              const oldId = book.id;
              await storage.deleteBookRaw(oldId);
              await storage.migrateSessionsBookId(oldId, canonicalId);
              storage.migrateLocalStorageProgress(oldId, canonicalId);
              if (storage.getLastActiveBookId() === oldId) {
                storage.setLastActiveBookId(canonicalId);
              }
              targetBookId = canonicalId;
              updatedBook.id = canonicalId;
              canonicalStoragePath = `books/${canonicalId}.pdf`;
              updatedBook.file_path = storagePath;
              this._upsertBooksRow({
                id: canonicalId,
                title: updatedBook.title || "PDF Dokument",
                author: updatedBook.author || "PDF Dokument",
                file_name: finalFileName,
                file_type: "pdf",
                file_path: storagePath,
                file_size: fileSize,
                file_hash: fileHash,
                current_chapter: Number(updatedBook.currentChapterIndex) || 0,
                current_page: Math.max(1, (Number(updatedBook.currentPageIndex) || 0) + 1),
                scroll_progress: Number(updatedBook.scrollPercent ?? updatedBook.pageRatio ?? 0) || 0,
                pdf_ruler_height: Number(updatedBook.pdfRulerConfig?.height) || 32,
                updated_at: new Date(getBookProgressTimestamp(updatedBook) || Date.now()).toISOString()
              }).then(async (upErr) => {
                if (!upErr) {
                  await supabase.from("books").delete().eq("id", oldId).catch(() => {});
                }
              }).catch(() => {});
            }
          }
        }

        try {
          if (typeof window !== "undefined" && window.pdfjsLib && (!updatedBook.numPages || !coverDataUrl)) {
            const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
            const pdfDoc = await loadingTask.promise;
            const numPages = pdfDoc.numPages || 1;
            updatedBook.numPages = numPages;
            updatedBook.totalPages = numPages;
            updatedBook.total_pages = numPages;
            updatedBook.description = `PDF dokument (${numPages} stran)`;
            if (!updatedBook.totalWords) {
              updatedBook.totalWords = numPages * 250;
            }
            if (!coverDataUrl) {
              const page = await pdfDoc.getPage(1);
              const viewport = page.getViewport({ scale: 0.5 });
              const canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
              coverDataUrl = canvas.toDataURL("image/jpeg", 0.75);
            }
          }
        } catch (pe) {
          console.warn("[Supabase Sync] Varování při extrakci náhledu staženého PDF:", pe);
        }
      } else {
        // EPUB – extrakce metadat a obálky pokud chybí
        try {
          if (!coverDataUrl || !updatedBook.totalWords || !updatedBook.author || updatedBook.author === "Neznámý autor") {
            const parser = await EpubParser.parse(arrayBuffer.slice(0));
            const parsedTitle = parser.metadata?.title || "";
            const parsedAuthor = parser.metadata?.creator || "";
            if (!updatedBook.title && parsedTitle) updatedBook.title = parsedTitle;
            if ((!updatedBook.author || updatedBook.author === "Neznámý autor") && parsedAuthor) {
              updatedBook.author = parsedAuthor;
              updatedBook.creator = parsedAuthor;
            }
            updatedBook.totalChapters = parser.spine?.length || updatedBook.totalChapters || 1;
            if (!updatedBook.totalWords) {
              const wordStats = await parser.calculateTotalWords().catch(() => ({ totalWords: 0 }));
              updatedBook.totalWords = wordStats.totalWords || 0;
            }
            if (!coverDataUrl && parser.coverBlobUrl) {
              try {
                const res = await fetch(parser.coverBlobUrl);
                const b = await res.blob();
                coverDataUrl = await this._blobToDataUrl(b);
              } catch (_) {}
            }
            parser.destroy?.();
          }
        } catch (parseErr) {
          console.warn("[Supabase Sync] Varování při extrakci metadat staženého EPUB:", parseErr);
        }
      }

      if (coverDataUrl) {
        updatedBook.coverDataUrl = coverDataUrl;
      }

      // Okamžitě uložit binární soubor do "book_files", obálku do "covers" a metadata do "books"
      await storage.saveBookFile(targetBookId, arrayBuffer, { fileHash, fileSize });
      if (coverDataUrl) {
        await storage.saveBookCover(targetBookId, {
          dataUrl: coverDataUrl,
          coverHash: updatedBook.coverHash || updatedBook.cover_hash || null,
          coverPath: updatedBook.cover_path || null
        });
      }
      await storage.saveBook(updatedBook);

      // Na pozadí doplnit chybějící obálku a lehká metadata do DB (bez opětovného nahrávání binárky!)
      if (this._booksSchemaHasExtendedCols && (!updatedBook.cover_path || !book.file_hash || !book.file_size)) {
        this._backfillCloudMetadataAndCover(updatedBook, coverDataUrl).catch(() => {});
      }

      console.log(`[Supabase Sync] Kniha "${updatedBook.title}" stažena na vyžádání a uložena do IndexedDB (${fileSize} B).`);
      return { arrayBuffer, book: updatedBook };
    })();

    this._inFlightDownloads.set(book.id, downloadTask);
    try {
      return await downloadTask;
    } finally {
      this._inFlightDownloads.delete(book.id);
    }
  }

  async _backfillCloudMetadataAndCover(book, coverDataUrl = null) {
    if (!this.isOnline() || !supabase || !book?.id || !this._booksSchemaHasExtendedCols) return;
    const patch = {};
    if (book.author && book.author !== "Neznámý autor" && book.author !== "PDF Dokument") {
      patch.author = book.author;
    }
    if (book.fileSize) patch.file_size = book.fileSize;
    if (book.fileHash) patch.file_hash = book.fileHash;
    if (book.numPages) patch.total_pages = book.numPages;
    if (book.totalChapters) patch.total_chapters = book.totalChapters;
    if (book.totalWords) patch.total_words = book.totalWords;

    if (coverDataUrl && !book.cover_path) {
      try {
        const up = await this.uploadBookCover(book.id, coverDataUrl);
        if (up) {
          patch.cover_path = up.coverPath;
          patch.cover_hash = up.coverHash;
          book.cover_path = up.coverPath;
          book.coverHash = up.coverHash;
          book.cover_hash = up.coverHash;
          await storage.saveBook(book);
        }
      } catch (_) {}
    }

    if (Object.keys(patch).length > 0) {
      await this._updateBooksRow(book.id, patch);
    }
  }

  /**
   * Kompletní obousměrná synchronizace METADAT mezi IndexedDB a Supabase.
   * Při spuštění ani při synchronizaci NIKDY nestahuje binární soubory EPUB/PDF ze Storage –
   * stahuje pouze lehká textová metadata z DB a chybějící náhledy obálek (max 1x na zařízení).
   */
  async syncAll({ silent = false } = {}) {
    if (!this.isOnline() || !supabase) {
      this.setStatus("offline");
      return { success: false, reason: "offline" };
    }

    if (this.isSyncing) {
      return { success: false, reason: "already_syncing" };
    }

    this.isSyncing = true;
    this.setStatus("syncing");

    const stats = {
      metadataSynced: 0,
      coversDownloaded: 0,
      downloaded: 0,
      uploaded: 0,
      updatedFromCloud: 0,
      uploadedToCloud: 0,
      sessionsDownloaded: 0,
      sessionsUploaded: 0,
      sessionsMerged: 0,
      sessionsPurged: 0,
      total: 0
    };

    try {
      // 1. Získat a deduplikovat lokální knihy z IndexedDB (bez načítání binárek)
      const localBooks = await storage.deduplicateBooks();

      // 2. Získat a deduplikovat lehká metadata knih ze Supabase DB
      const { data: rawCloudBooks, error: fetchErr } = await supabase
        .from("books")
        .select("*");

      if (fetchErr) {
        throw fetchErr;
      }

      if (Array.isArray(rawCloudBooks) && rawCloudBooks.length > 0) {
        this._booksSchemaHasExtendedCols = Object.prototype.hasOwnProperty.call(rawCloudBooks[0], "cover_path");
        this._booksSchemaHasAnchorCols = Object.prototype.hasOwnProperty.call(rawCloudBooks[0], "reading_anchor");
      }

      const cloudList = await this.normalizeAndMergeCloudBooks(rawCloudBooks || []);
      const matchedLocalIds = new Set();

      // Pomocná funkce pro vyhledání odpovídající lokální knihy ke cloudové knize
      const findMatchingLocalBook = (cloudBook) => {
        const byId = localBooks.find(b => b.id === cloudBook.id);
        if (byId) return byId;

        if (cloudBook.file_path) {
          const byPath = localBooks.find(b => b.file_path === cloudBook.file_path);
          if (byPath) return byPath;
        }

        const cloudHash = this._extractPdfHashFromCloudBook(cloudBook);
        if (cloudHash) {
          const byHash = localBooks.find(b =>
            (b.fileHash && b.fileHash === cloudHash) ||
            (b.file_hash && b.file_hash === cloudHash) ||
            (b.id && b.id.includes(cloudHash)) ||
            (b.file_path && b.file_path.includes(cloudHash))
          );
          if (byHash) return byHash;
        }

        const isPdf = cloudBook.file_type === "pdf" ||
                      cloudBook.file_name?.toLowerCase().endsWith(".pdf") ||
                      cloudBook.file_path?.toLowerCase().endsWith(".pdf");

        if (isPdf) {
          for (const b of localBooks) {
            if (!b.isPdf && b.format !== "pdf") continue;
            const bHash = b.fileHash || b.file_hash;
            if (bHash) {
              if (cloudBook.id && cloudBook.id.includes(bHash)) return b;
              if (cloudBook.file_path && cloudBook.file_path.includes(bHash)) return b;
            }
          }

          const cloudName = (cloudBook.file_name || "").toLowerCase().trim();
          const cloudTitle = (cloudBook.title || "").toLowerCase().trim();
          for (const b of localBooks) {
            if (!b.isPdf && b.format !== "pdf") continue;
            const bName = (b.fileName || b.file_name || "").toLowerCase().trim();
            const bTitle = (b.title || "").toLowerCase().trim();
            if (cloudName && bName && cloudName === bName) return b;
            if (cloudTitle && bTitle && cloudTitle === bTitle) return b;
          }
        }

        return null;
      };

      // 3. Projít cloudové knihy – synchronizovat POUZE metadata, obálky (max 1x) a postup čtení
      for (const cloudBook of cloudList) {
        const localBook = findMatchingLocalBook(cloudBook);

        if (!localBook) {
          // Kniha je v cloudu, ale ještě ne lokálně -> uložit POUZE lehká metadata (lazy download při kliknutí)
          const isPdf = cloudBook.file_type === "pdf" ||
            cloudBook.file_name?.toLowerCase().endsWith(".pdf") ||
            cloudBook.file_path?.toLowerCase().endsWith(".pdf");
          const finalFileName = cloudBook.file_name || `${cloudBook.id}.${isPdf ? "pdf" : "epub"}`;
          const storagePath = cloudBook.file_path || (isPdf ? `books/${cloudBook.id}.pdf` : `${cloudBook.id}/${finalFileName}`);
          const cloudProg = this.normalizeCloudBookProgress(cloudBook);
          const extractedHash = this._extractPdfHashFromCloudBook(cloudBook);
          const author = cloudBook.author || cloudBook.creator || (isPdf ? "PDF Dokument" : "Neznámý autor");
          const numPages = Number(cloudBook.total_pages) || undefined;

          const metaBook = {
            id: cloudBook.id,
            title: cloudBook.title || (isPdf ? "PDF Dokument" : "Kniha EPUB"),
            author,
            creator: author,
            fileName: finalFileName,
            file_name: finalFileName,
            file_path: storagePath,
            file_type: isPdf ? "pdf" : "epub",
            format: isPdf ? "pdf" : "epub",
            isPdf,
            fileSize: Number(cloudBook.file_size) || null,
            file_size: Number(cloudBook.file_size) || null,
            fileHash: extractedHash || null,
            file_hash: extractedHash || null,
            cover_path: cloudBook.cover_path || null,
            cover_hash: cloudBook.cover_hash || null,
            coverHash: cloudBook.cover_hash || null,
            language: "cs",
            description: isPdf && numPages ? `PDF dokument (${numPages} stran)` : "",
            coverDataUrl: null,
            hasLocalFile: false,
            syncedFromCloud: true,
            addedAt: cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now(),
            lastReadAt: cloudProg?.lastReadAt || (cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now()),
            progressUpdatedAt: cloudProg?.progressUpdatedAt || 0,
            currentChapterIndex: cloudProg?.currentChapterIndex ?? (Number(cloudBook.current_chapter) || 0),
            currentPageIndex: cloudProg?.currentPageIndex ?? Math.max(0, (Number(cloudBook.current_page) || 1) - 1),
            currentPage: cloudProg?.currentPage ?? (Number(cloudBook.current_page) || 1),
            numPages,
            totalChapters: Number(cloudBook.total_chapters) || (isPdf ? 1 : undefined),
            totalWords: Number(cloudBook.total_words) || 0,
            wordsRead: 0,
            progress: cloudProg?.progress ?? 0,
            progressPercent: cloudProg?.progressPercent ?? 0,
            scrollPercent: cloudProg?.scrollPercent ?? (Number(cloudBook.scroll_progress) || 0),
            pageRatio: cloudProg?.pageRatio ?? (Number(cloudBook.scroll_progress) || 0),
            readingAnchor: cloudProg?.readingAnchor || null,
            ...(isPdf ? {
              pdfRulerConfig: {
                height: Number(cloudBook.pdf_ruler_height) || 32,
                stepSize: Number(cloudBook.pdf_ruler_height) || 32
              }
            } : {})
          };

          await storage.saveBook(metaBook);
          if (cloudBook.cover_path) {
            const coverFetched = await this.ensureBookCoverCached(metaBook.id, cloudBook);
            if (coverFetched) stats.coversDownloaded++;
          }
          matchedLocalIds.add(metaBook.id);
          stats.metadataSynced++;
          console.log(`[Supabase Sync] Synchronizována metadata knihy "${metaBook.title}" (bez stahování souboru).`);
        } else {
          // Kniha existuje v obou úložištích -> Synchronizace postupu čtení a doplnění chybějících metadat/obálky
          matchedLocalIds.add(localBook.id);

          const freshLocalBook = (await storage.getBook(localBook.id)) || localBook;
          const cachedLocal = storage.getCachedBookProgress(localBook.id);

          const idbTime = getBookProgressTimestamp(freshLocalBook);
          const lsTime = getBookProgressTimestamp(cachedLocal);
          const localTime = Math.max(idbTime, lsTime);
          const effectiveLocal = (lsTime > idbTime && cachedLocal)
            ? { ...freshLocalBook, ...cachedLocal, progressUpdatedAt: lsTime }
            : freshLocalBook;

          const cloudTime = this.getCloudBookTimestamp(cloudBook);

          if (cloudTime > localTime + 50) {
            const updates = this.normalizeCloudBookProgress(cloudBook, freshLocalBook);
            if (updates) {
              await storage.updateBookProgress(localBook.id, updates);
              try {
                localStorage.setItem(`lumina_progress_${localBook.id}`, JSON.stringify(updates));
              } catch (e) {}

              stats.updatedFromCloud++;
              console.log(`[SupabaseSync] Postup knihy "${freshLocalBook.title}" aktualizován z cloudu (ts: ${cloudTime} > ${localTime}).`);
            }
          } else if (localTime > cloudTime + 50) {
            // Lokální stav je novější -> odeslat pouze lehkou aktualizaci postupu do DB
            const isPdfLocal = !!(effectiveLocal.isPdf || effectiveLocal.format === "pdf");
            const localAnchor = !isPdfLocal ? (effectiveLocal.readingAnchor || null) : null;
            const localScrollProg = isPdfLocal
              ? (Number(effectiveLocal.scrollPercent ?? effectiveLocal.pageRatio ?? 0) || 0)
              : (localAnchor && typeof localAnchor.bookProgress === "number"
                ? Math.max(0, Math.min(1, localAnchor.bookProgress / 100))
                : (Number(effectiveLocal.scrollPercent ?? effectiveLocal.pageRatio ?? 0) || 0));

            const isoLocal = new Date(localTime).toISOString();
            const patch = {
              current_chapter: effectiveLocal.currentChapterIndex || 0,
              current_page: Math.max(1, (effectiveLocal.currentPageIndex || 0) + 1),
              scroll_progress: localScrollProg,
              pdf_ruler_height: effectiveLocal.pdfRulerConfig?.height || 32,
              updated_at: isoLocal
            };
            if (this._booksSchemaHasAnchorCols) {
              patch.reading_anchor = localAnchor;
              patch.progress_updated_at = isoLocal;
            }
            await this._updateBooksRow(cloudBook.id, patch);
            stats.uploadedToCloud++;
          }

          // Doplnit lehká metadata z cloudu pokud lokálně chybí
          let metaChanged = false;
          if (cloudBook.file_path && !freshLocalBook.file_path) {
            freshLocalBook.file_path = cloudBook.file_path;
            metaChanged = true;
          }
          if (cloudBook.author && (!freshLocalBook.author || freshLocalBook.author === "Neznámý autor" || freshLocalBook.author === "PDF Dokument")) {
            freshLocalBook.author = cloudBook.author;
            freshLocalBook.creator = cloudBook.author;
            metaChanged = true;
          }
          if (cloudBook.file_size && !freshLocalBook.fileSize) {
            freshLocalBook.fileSize = Number(cloudBook.file_size);
            freshLocalBook.file_size = Number(cloudBook.file_size);
            metaChanged = true;
          }
          if (cloudBook.file_hash && !freshLocalBook.fileHash) {
            freshLocalBook.fileHash = cloudBook.file_hash;
            freshLocalBook.file_hash = cloudBook.file_hash;
            metaChanged = true;
          }
          if (cloudBook.cover_path && freshLocalBook.cover_path !== cloudBook.cover_path) {
            freshLocalBook.cover_path = cloudBook.cover_path;
            metaChanged = true;
          }
          if (cloudBook.cover_hash && freshLocalBook.cover_hash !== cloudBook.cover_hash) {
            freshLocalBook.cover_hash = cloudBook.cover_hash;
            freshLocalBook.coverHash = cloudBook.cover_hash;
            metaChanged = true;
          }
          if (cloudBook.total_pages && !freshLocalBook.numPages) {
            freshLocalBook.numPages = Number(cloudBook.total_pages);
            metaChanged = true;
          }
          if (cloudBook.total_chapters && !freshLocalBook.totalChapters) {
            freshLocalBook.totalChapters = Number(cloudBook.total_chapters);
            metaChanged = true;
          }
          if (cloudBook.total_words && !freshLocalBook.totalWords) {
            freshLocalBook.totalWords = Number(cloudBook.total_words);
            metaChanged = true;
          }
          if (metaChanged) {
            await storage.saveBook(freshLocalBook);
          }

          // Cachování obálky z cloudu (stáhne se max 1x na zařízení) nebo doplnění lokální obálky do cloudu
          if (cloudBook.cover_path) {
            const coverFetched = await this.ensureBookCoverCached(localBook.id, cloudBook);
            if (coverFetched) stats.coversDownloaded++;
          } else if (this._booksSchemaHasExtendedCols && freshLocalBook.coverDataUrl) {
            this._backfillCloudMetadataAndCover(freshLocalBook, freshLocalBook.coverDataUrl).catch(() => {});
          }

          // Pokud má lokální kniha deterministické ID, ale cloudBook má ještě staré ID, sjednotíme záznam v cloudu
          if (localBook.id !== cloudBook.id && localBook.isPdf) {
            try {
              const cloudPatch = {
                id: localBook.id,
                title: freshLocalBook.title,
                author: freshLocalBook.author || null,
                file_name: freshLocalBook.fileName,
                file_type: "pdf",
                file_path: `books/${localBook.id}.pdf`,
                file_size: freshLocalBook.fileSize || null,
                file_hash: freshLocalBook.fileHash || null,
                cover_path: freshLocalBook.cover_path || null,
                cover_hash: freshLocalBook.cover_hash || null,
                total_pages: freshLocalBook.numPages || null,
                current_chapter: effectiveLocal.currentChapterIndex || 0,
                current_page: Math.max(1, (effectiveLocal.currentPageIndex || 0) + 1),
                scroll_progress: Number(effectiveLocal.scrollPercent ?? effectiveLocal.pageRatio ?? 0) || 0,
                pdf_ruler_height: effectiveLocal.pdfRulerConfig?.height || 32,
                updated_at: new Date(localTime || Date.now()).toISOString()
              };
              const upErr = await this._upsertBooksRow(cloudPatch);
              if (!upErr) {
                await supabase.from("books").delete().eq("id", cloudBook.id);
              }
              console.log(`[SupabaseSync] Sjednoceno ID v cloudu s lokálním: ${cloudBook.id} -> ${localBook.id}`);
            } catch (syncMigErr) {
              console.warn("[SupabaseSync] Varování při sjednocování ID v cloudu:", syncMigErr);
            }
          }
        }
      }

      // 4. Lokální knihy, které ještě nejsou v cloudu -> ZÁLOHOVAT (pouze pokud mají lokální binární soubor)
      for (const localBook of localBooks) {
        if (!matchedLocalIds.has(localBook.id)) {
          const hasLocalFile = localBook.hasLocalFile || await storage.hasBookFile(localBook.id);
          if (hasLocalFile) {
            console.log(`[SupabaseSync] Zálohuji lokální knihu "${localBook.title}" do cloudu...`);
            const res = await this.uploadBook(localBook);
            if (res?.success) {
              stats.uploaded++;
            }
          } else if (localBook.syncedFromCloud) {
            // Metadata-only záznam smazaný na jiném zařízení z cloudu
            await storage.deleteBook(localBook.id);
          }
        }
      }

      // 5. Synchronizace čtecích relací a agregovaných statistik (reading_sessions & reading_stats_summary)
      try {
        const deletedIds = typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : [];
        if (deletedIds.length > 0) {
          const nowIso = new Date().toISOString();
          let { error: softDelErr } = await supabase
            .from("reading_sessions")
            .update({
              is_deleted: true,
              updated_at: nowIso
            })
            .in("id", deletedIds);
          if (softDelErr && (softDelErr.code === "PGRST204" || softDelErr.code === "42703" || softDelErr.message?.includes("is_deleted"))) {
            await supabase.from("reading_sessions").delete().in("id", deletedIds);
          }
        }

        let lastSyncTime = localStorage.getItem('lumina_last_sessions_sync') || null;
        const localSessionsCheck = await storage.getAllReadingSessions();
        if (!localSessionsCheck || localSessionsCheck.length === 0) {
          lastSyncTime = null;
        }

        const pulledSessions = await this.pullReadingSessions(lastSyncTime);
        console.log(`[SupabaseSync] Rekonsiliace čtecích relací dokončena.`);

        stats.sessionsDownloaded = Array.isArray(pulledSessions) ? pulledSessions.length : 0;
        stats.sessionsPurged = pulledSessions?.purgedCount || 0;

        // Jednorázový přepočet globálních statistik po uložení všech stažených relací do IndexedDB
        if (typeof storage.recalculateAndNormalizeStats === "function") {
          await storage.recalculateAndNormalizeStats();
        }

        const uploadRes = await this.syncLocalSessionsToCloud();
        if (uploadRes) {
          stats.sessionsUploaded = uploadRes.uploaded || 0;
          stats.sessionsMerged = (stats.sessionsDownloaded || 0) + (uploadRes.uploaded || 0);
        }

        await this.syncStatsSummary();
      } catch (statsErr) {
        console.warn("[SupabaseSync] Varování při synchronizaci čtecích statistik:", statsErr);
      }

      this._lastSyncTime = Date.now();
      this.setStatus("synced");
      this.notifySyncCompleted(stats);
      return { success: true, stats };
    } catch (err) {
      console.warn("[SupabaseSync] Synchronizace selhala:", err);
      this.setStatus("error");
      return { success: false, error: err };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Pomocná metoda pro bezpečný zápis do tabulky Supabase s automatickým fallbackem camelCase -> snake_case
   */
  async _upsertRow(table, payload, conflictCol = "id") {
    if (!this.isOnline() || !supabase) {
      return { success: false, reason: "offline" };
    }
    let { error } = await supabase.from(table).upsert(payload, { onConflict: conflictCol });
    if (error) {
      if (error.code === "PGRST204" || error.code === "42703" || error.message?.includes("column")) {
        const snakePayload = {};
        for (const [k, v] of Object.entries(payload)) {
          const snakeK = k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
          snakePayload[snakeK] = v;
        }
        const retry = await supabase.from(table).upsert(snakePayload, { onConflict: conflictCol });
        if (retry.error) {
          return { success: false, error: retry.error };
        }
        return { success: true };
      }
      return { success: false, error };
    }
    return { success: true };
  }

  /**
   * Odešle jednu validní relaci (>= 5 min) do Supabase (reading_sessions)
   * Striktně odesílá POUZE povolené sloupce databázového schématu reading_sessions:
   * id, book_id, start_time, duration, words_read, avg_wpm, peak_wpm, intra_session_samples, is_deleted, updated_at
   */
  async pushSingleSession(session) {
    if (!this.isOnline() || !supabase || !session) return null;
    if (session.is_deleted === true || session.is_deleted === "true") return null;

    const deletedSet = new Set(typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : []);
    const sid = String(session.sessionId ?? "").trim();
    const id = String(session.id ?? "").trim();
    if ((sid && deletedSet.has(sid)) || (id && deletedSet.has(id))) {
      return null;
    }

    const dur = Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
    if (dur < 300) return null; // Striktně zahodit relace < 5 minut

    const avg = Math.round(Number(session.avg_wpm ?? session.avgWpm ?? session.wpm ?? 0));
    const peak = Math.max(Math.round(Number(session.peak_wpm ?? session.peakWpm ?? avg)), avg);
    let samples = session.intra_session_samples || session.intraSessionSamples || session.timelineSamples;
    if (typeof samples === "string") {
      try { samples = JSON.parse(samples); } catch (_) { samples = []; }
    }
    const cleanSamples = Array.isArray(samples) ? samples : [];

    const payload = {
      id: String(session.sessionId || session.id),
      book_id: String(session.bookId || session.book_id || "unknown"),
      start_time: session.startTime || session.start_time || new Date(session.timestamp || Date.now()).toISOString(),
      duration: Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0)),
      words_read: Math.round(Number(session.words_read ?? session.wordsRead ?? 0)),
      avg_wpm: avg,
      peak_wpm: peak,
      intra_session_samples: cleanSamples,
      is_deleted: false,
      updated_at: session.updatedAt || session.updated_at || new Date().toISOString()
    };

    let { error } = await supabase.from("reading_sessions").upsert(payload, { onConflict: "id" });
    if (error && (error.code === "PGRST204" || error.code === "42703" || error.message?.includes("is_deleted"))) {
      const retryPayload = { ...payload };
      delete retryPayload.is_deleted;
      const retryRes = await supabase.from("reading_sessions").upsert(retryPayload, { onConflict: "id" });
      error = retryRes.error;
    }
    if (error) {
      console.warn("[SupabaseSync] Chyba při odesílání relace do reading_sessions:", error);
      return { success: false, error };
    }
    return { success: true };
  }

  /**
   * Hromadné odeslání (batch upsert) validních relací (>= 5 min) do Supabase (reading_sessions)
   * Zabraňuje blokování UI a nadbytečným síťovým požadavkům
   */
  async pushMultipleSessions(sessions) {
    if (!this.isOnline() || !supabase || !Array.isArray(sessions) || sessions.length === 0) {
      return { success: false, reason: "invalid_input" };
    }

    const deletedSet = new Set(typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : []);
    const cleanPayloads = [];
    for (const session of sessions) {
      if (!session) continue;
      if (session.is_deleted === true || session.is_deleted === "true") continue;
      const sid = String(session.sessionId ?? "").trim();
      const id = String(session.id ?? "").trim();
      if ((sid && deletedSet.has(sid)) || (id && deletedSet.has(id))) continue;

      const dur = Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
      if (dur < 300) continue; // Pouze relace >= 5 minut

      const avg = Math.round(Number(session.avg_wpm ?? session.avgWpm ?? session.wpm ?? 0));
      const peak = Math.max(Math.round(Number(session.peak_wpm ?? session.peakWpm ?? avg)), avg);
      let samples = session.intra_session_samples || session.intraSessionSamples || session.timelineSamples;
      if (typeof samples === "string") {
        try { samples = JSON.parse(samples); } catch (_) { samples = []; }
      }
      const cleanSamples = Array.isArray(samples) ? samples : [];

      cleanPayloads.push({
        id: String(session.sessionId || session.id),
        book_id: String(session.bookId || session.book_id || "unknown"),
        start_time: session.startTime || session.start_time || new Date(session.timestamp || Date.now()).toISOString(),
        duration: dur,
        words_read: Math.round(Number(session.words_read ?? session.wordsRead ?? 0)),
        avg_wpm: avg,
        peak_wpm: peak,
        intra_session_samples: cleanSamples,
        is_deleted: false,
        updated_at: session.updatedAt || session.updated_at || new Date().toISOString()
      });
    }

    if (cleanPayloads.length === 0) {
      return { success: true, count: 0 };
    }

    for (let i = 0; i < cleanPayloads.length; i += 50) {
      const chunk = cleanPayloads.slice(i, i + 50);
      let { error } = await supabase.from("reading_sessions").upsert(chunk, { onConflict: "id" });
      if (error && (error.code === "PGRST204" || error.code === "42703" || error.message?.includes("is_deleted"))) {
        const retryChunk = chunk.map(item => {
          const copy = { ...item };
          delete copy.is_deleted;
          return copy;
        });
        const retryRes = await supabase.from("reading_sessions").upsert(retryChunk, { onConflict: "id" });
        error = retryRes.error;
      }
      if (error) {
        console.warn("[SupabaseSync] Chyba při hromadném odesílání reading_sessions:", error);
        return { success: false, error };
      }
    }

    return { success: true, count: cleanPayloads.length };
  }

  /**
   * Synchronizuje nově dokončenou relaci a přepočítané souhrnné statistiky do Supabase
   */
  async pushSessionAndStats(session) {
    if (!this.isOnline() || !supabase || !session) return;
    if (session.is_deleted === true || session.is_deleted === "true") return;
    const deletedSet = new Set(typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : []);
    const sid = String(session.sessionId ?? "").trim();
    const id = String(session.id ?? "").trim();
    if ((sid && deletedSet.has(sid)) || (id && deletedSet.has(id))) return;

    const dur = Math.max(0, Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0)));
    if (dur < 300) return; // Pouze relace >= 5 minut

    try {
      await this.pushSingleSession(session);
      await this.syncStatsSummary();
    } catch (err) {
      console.warn("[SupabaseSync] Varování při odesílání relace a statistik:", err);
    }
  }

  /**
   * Smaže čtecí relaci ze Supabase (tabulka reading_sessions) a aktualizuje cloudové souhrnné statistiky
   * @param {string|number} sessionId
   * @returns {Promise<{ success: boolean, error?: any, reason?: string }>}
   */
  async deleteReadingSession(sessionId) {
    const targetId = String(sessionId ?? "").trim();
    if (!targetId) return { success: false, error: "Missing sessionId" };

    // Zaznamenat tombstone PŘED síťovým voláním, aby se smazání neztratilo ani v režimu offline
    if (typeof storage.addDeletedSessionId === "function") {
      storage.addDeletedSessionId(targetId);
    } else {
      try {
        const raw = localStorage.getItem("lumina_deleted_session_ids");
        const list = raw ? JSON.parse(raw) : [];
        if (!list.includes(targetId)) {
          list.push(targetId);
          localStorage.setItem("lumina_deleted_session_ids", JSON.stringify(list));
        }
      } catch (_) {}
    }

    // Odstranit lokálně z IndexedDB/localStorage pro okamžitou konzistenci
    if (typeof storage.deleteReadingSession === "function") {
      try {
        await storage.deleteReadingSession(targetId, true);
      } catch (_) {}
    }

    if (!this.isOnline() || !supabase) {
      return { success: false, reason: "offline" };
    }

    try {
      const nowIso = new Date().toISOString();
      let { error } = await supabase
        .from("reading_sessions")
        .update({
          is_deleted: true,
          updated_at: nowIso
        })
        .eq("id", targetId);

      // Fallback na hard delete pokud sloupec is_deleted v DB ještě neexistuje
      if (error && (error.code === "PGRST204" || error.code === "42703" || error.message?.includes("is_deleted"))) {
        console.warn("[SupabaseSync] Sloupec is_deleted neexistuje, fallback na hard delete:", error.message);
        const delRes = await supabase
          .from("reading_sessions")
          .delete()
          .eq("id", targetId);
        error = delRes.error;
      }

      if (error) {
        console.error("[SupabaseSync] Chyba při mazání relace v cloudu:", error);
        return { success: false, error };
      }

      if (typeof storage.recalculateAndNormalizeStats === "function") {
        await storage.recalculateAndNormalizeStats();
      }
      await this.syncStatsSummary({ overwriteCloud: true });
      return { success: true };
    } catch (err) {
      console.error("[SupabaseSync] Výjimka při mazání relace v cloudu:", err);
      return { success: false, error: err };
    }
  }

  /**
   * Synchronizuje souhrnné statistiky čtení (reading_stats_summary) mezi zařízeními
   * Striktně odesílá POUZE povolené sloupce databázového schématu reading_stats_summary:
   * id, total_words_read, total_reading_seconds, global_avg_wpm, streak_days, last_read_date, daily_minutes_map, updated_at
   */
  async syncStatsSummary({ overwriteCloud = false } = {}) {
    if (!this.isOnline() || !supabase) return null;

    try {
      const { ReadingTracker } = await import("./tracker.js?v=2.9.9");
      const localStats = await ReadingTracker.computeGlobalStats();
      const hasDeletedTombstones = (typeof storage.getDeletedSessionIds === "function" && storage.getDeletedSessionIds().length > 0);

      let cloudSummary = null;
      if (!overwriteCloud && !hasDeletedTombstones) {
        const { data: cloudSummaryList, error: sumErr } = await supabase
          .from("reading_stats_summary")
          .select("*")
          .limit(1);

        if (sumErr) {
          if (sumErr.code !== "PGRST205") {
            console.warn("[SupabaseSync] Tabulka reading_stats_summary není dostupná:", sumErr.message || sumErr);
          }
          return null;
        }
        cloudSummary = Array.isArray(cloudSummaryList) && cloudSummaryList.length > 0 ? cloudSummaryList[0] : null;
      }

      // 2. Sestavit mapu denních minut z reálných čtecích relací
      const dailyMinutesMap = {};
      const localDailyStorage = storage.getDailyReadingTimeMap();
      for (const [dStr, sec] of Object.entries(localDailyStorage)) {
        if (sec >= 300) {
          dailyMinutesMap[dStr] = Math.round(sec / 60);
        }
      }

      for (const ds of (localStats.dailySessions || [])) {
        if (ds.activeSeconds >= 300) {
          const m = Math.round(ds.activeSeconds / 60);
          dailyMinutesMap[ds.date] = Math.max(dailyMinutesMap[ds.date] || 0, m);
          if (m > Math.round((localDailyStorage[ds.date] || 0) / 60)) {
            storage.setDailyReadingSeconds(ds.date, ds.activeSeconds);
          }
        }
      }

      // 3. Idempotentní sloučení s cloudovou mapou denních minut (pouze pokud nepřepisujeme po smazání relace)
      if (cloudSummary && !overwriteCloud && !hasDeletedTombstones) {
        const cloudMap = cloudSummary.daily_minutes_map || cloudSummary.dailyMinutesMap || {};
        for (const [dateStr, minutes] of Object.entries(cloudMap)) {
          const m = Number(minutes) || 0;
          if (m >= 5) {
            const currentM = dailyMinutesMap[dateStr] || 0;
            if (m > currentM) {
              dailyMinutesMap[dateStr] = m;
              storage.setDailyReadingSeconds(dateStr, m * 60);
            }
          }
        }
      }

      // 4. Poslední datum čtení
      const allDates = Object.keys(dailyMinutesMap).sort();
      const lastReadDate = allDates.length > 0 ? allDates[allDates.length - 1] : storage.getLocalDateString();

      const summaryPayload = {
        id: "global",
        total_words_read: Math.round(Number(localStats.totalWords || 0)),
        total_reading_seconds: Math.round(Number(localStats.totalActiveTime || 0)),
        global_avg_wpm: Math.round(Number(localStats.averageWpm || 0)),
        streak_days: Math.round(Number(localStats.streak || 0)),
        last_read_date: lastReadDate,
        daily_minutes_map: dailyMinutesMap,
        updated_at: new Date().toISOString()
      };

      const { error: upErr } = await supabase.from("reading_stats_summary").upsert(summaryPayload, { onConflict: "id" });
      if (upErr) {
        console.warn("[SupabaseSync] Chyba při ukládání reading_stats_summary do cloudu:", upErr);
        return null;
      }

      try {
        localStorage.setItem("reading_stats_summary", JSON.stringify(summaryPayload));
      } catch (_) {}

      return summaryPayload;
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při synchronizaci souhrnných statistik:", err);
      return null;
    }
  }

  /**
   * Stáhne autoritativní sadu všech čtecích relací ze Supabase (včetně soft-deleted záznamů)
   * @returns {Promise<Array<Object>|null>}
   */
  async fetchCloudReadingSessions() {
    if (!this.isOnline() || !supabase) return null;
    try {
      const { data, error } = await supabase
        .from('reading_sessions')
        .select('*')
        .order('updated_at', { ascending: true })
        .limit(10000);

      if (error) {
        console.error('[SupabaseSync] Chyba při stahování relací ze Supabase:', error);
        return null;
      }
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[SupabaseSync] Výjimka při stahování relací ze Supabase:', err);
      return null;
    }
  }

  /**
   * Stáhne a importuje všechny dostupné čtecí relace ze Supabase do IndexedDB v jedné dávce
   * Provádí autoritativní rekonsiliaci a promazání sirotčích (orphan/zombie) relací.
   * @param {string|null} [lastSyncTimestamp=null]
   * @returns {Promise<Array>}
   */
  async pullReadingSessions(lastSyncTimestamp = null) {
    if (!this.isOnline() || !supabase) return [];

    // 0. Před stažením relací synchronizovat lokální tombstones (smazané relace) do Supabase jako is_deleted = true
    const deletedIds = typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : [];
    if (deletedIds.length > 0) {
      try {
        const nowIso = new Date().toISOString();
        let { error: softDelErr } = await supabase
          .from("reading_sessions")
          .update({
            is_deleted: true,
            updated_at: nowIso
          })
          .in("id", deletedIds);
        if (softDelErr && (softDelErr.code === "PGRST204" || softDelErr.code === "42703" || softDelErr.message?.includes("is_deleted"))) {
          await supabase.from("reading_sessions").delete().in("id", deletedIds);
        }
      } catch (purgeErr) {
        console.warn("[SupabaseSync] Chyba při synchronizaci deletedIds do Supabase:", purgeErr);
      }
    }

    // 1. Získat celkový aktuální stav relací ze Supabase pro autoritativní rekonsiliaci (včetně is_deleted = true)
    const remoteRows = await this.fetchCloudReadingSessions();
    if (!remoteRows) {
      return [];
    }

    // 2. Autoritativní rekonsiliace lokálního úložiště:
    // Porovná staženou vzdálenou sadu s lokálním IndexedDB, smaže sirotky a uloží validní relace
    let reconcileResult = { saved: 0, purged: 0, purgedIds: [] };
    if (typeof storage.reconcileReadingSessions === "function") {
      reconcileResult = await storage.reconcileReadingSessions(remoteRows);
    }

    let maxUpdatedAt = null;
    for (const session of remoteRows) {
      if (session?.updated_at && (!maxUpdatedAt || session.updated_at > maxUpdatedAt)) {
        maxUpdatedAt = session.updated_at;
      }
    }

    // 3. Aktualizovat watermark synchronizace
    if (maxUpdatedAt) {
      localStorage.setItem('lumina_last_sessions_sync', maxUpdatedAt);
    }

    const validSaved = remoteRows.filter(s => s && s.is_deleted !== true && s.is_deleted !== "true");
    validSaved.purgedCount = reconcileResult.purged || 0;
    return validSaved;
  }

  /**
   * Alias pro stažení čtecích relací
   */
  async downloadSessions(lastSyncTimestamp = null) {
    return await this.pullReadingSessions(lastSyncTimestamp);
  }

  /**
   * Hromadné nahrání lokálních relací, které ještě nejsou v cloudu, do tabulky reading_sessions
   */
  async syncLocalSessionsToCloud() {
    if (!this.isOnline() || !supabase) return { uploaded: 0 };

    try {
      const localSessions = await storage.getAllReadingSessions();
      const deletedSet = new Set(typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : []);

      const { data: cloudSessionsRaw, error: sessErr } = await supabase
        .from("reading_sessions")
        .select("id, updated_at, is_deleted");

      if (sessErr) {
        if (sessErr.code !== "PGRST205") {
          console.warn("[SupabaseSync] Tabulka reading_sessions není dostupná:", sessErr.message || sessErr);
        }
        return { uploaded: 0 };
      }

      // Mapa stavu v cloudu: id -> { updatedAtMs, isDeleted }
      const cloudMap = new Map();
      for (const cs of (cloudSessionsRaw || [])) {
        const csId = String(cs.id);
        const csIsDeleted = Boolean(cs.is_deleted === true || cs.is_deleted === "true");
        cloudMap.set(csId, {
          updatedAtMs: new Date(cs.updated_at || 0).getTime(),
          isDeleted: csIsDeleted
        });

        // Pokud cloud indikuje soft-delete, odstranit lokálně
        if (csIsDeleted) {
          if (typeof storage.addDeletedSessionId === "function") {
            storage.addDeletedSessionId(csId);
          }
          deletedSet.add(csId);
          try {
            await storage.deleteReadingSession(csId, true);
          } catch (_) {}
        }
      }

      if (!localSessions || localSessions.length === 0) return { uploaded: 0 };

      const toUpload = [];

      for (const s of localSessions) {
        const sid = String(s.sessionId || s.id || "").trim();
        if (!sid || deletedSet.has(sid) || s.is_deleted === true || s.is_deleted === "true") continue;

        const dur = Math.max(0, Math.round(Number(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0)));
        if (dur < 300) continue; // Pouze relace >= 5 minut

        const localUpdatedAt = new Date(s.updatedAt || s.updated_at || s.timestamp || s.startTime || 0).getTime();
        const cloudInfo = cloudMap.get(sid);

        if (!cloudInfo) {
          // Relace v cloudu neexistuje:
          // Supabase je autoritou pro smazání relací.
          // Pokud relace nebyla lokálně vytvořena v offline režimu (syncedToCloud === false nebo isPendingSync === true),
          // jedná se o sirotčí relaci smazanou v cloudu na jiném zařízení -> NESMÍ být nahrána!
          if (s.syncedToCloud === false || s.isPendingSync === true) {
            toUpload.push(s);
          } else {
            console.log(`[SupabaseSync] Lokální relace ${sid} neexistuje v cloudu -> označuji jako smazanou v IndexedDB.`);
            deletedSet.add(sid);
            if (typeof storage.addDeletedSessionId === "function") {
              storage.addDeletedSessionId(sid);
            }
            try {
              await storage.deleteReadingSession(sid, true);
            } catch (_) {}
          }
        } else if (!cloudInfo.isDeleted && localUpdatedAt > cloudInfo.updatedAtMs + 1000) {
          // Lokální relace je novější a v cloudu není smazaná -> aktualizovat v cloudu
          toUpload.push(s);
        }
      }

      if (toUpload.length > 0) {
        const upRes = await this.pushMultipleSessions(toUpload);
        if (upRes?.success) {
          for (const s of toUpload) {
            s.syncedToCloud = true;
            try {
              await storage.saveReadingSession(s);
            } catch (_) {}
          }
          return { uploaded: toUpload.length };
        }
      }

      return { uploaded: 0 };
    } catch (e) {
      console.warn("[SupabaseSync] Chyba v syncLocalSessionsToCloud:", e);
      return { uploaded: 0 };
    }
  }

  /**
   * Kompletní obousměrná synchronizace čtecích relací a statistik (reading_sessions & reading_stats_summary)
   */
  async syncReadingStatsAndSessions(lastSyncTimestamp = null) {
    if (!this.isOnline() || !supabase) return { downloaded: 0, uploaded: 0, merged: 0 };

    const result = { downloaded: 0, uploaded: 0, merged: 0 };

    try {
      const deletedIds = typeof storage.getDeletedSessionIds === "function" ? storage.getDeletedSessionIds() : [];
      if (deletedIds.length > 0) {
        const nowIso = new Date().toISOString();
        let { error: softDelErr } = await supabase
          .from("reading_sessions")
          .update({
            is_deleted: true,
            updated_at: nowIso
          })
          .in("id", deletedIds);
        if (softDelErr && (softDelErr.code === "PGRST204" || softDelErr.code === "42703" || softDelErr.message?.includes("is_deleted"))) {
          await supabase.from("reading_sessions").delete().in("id", deletedIds);
        }
      }

      let lastSyncTime = lastSyncTimestamp ?? localStorage.getItem('lumina_last_sessions_sync') ?? null;
      const localSessionsCheck = await storage.getAllReadingSessions();
      if (!localSessionsCheck || localSessionsCheck.length === 0) {
        lastSyncTime = null;
      }

      const pulledSessions = await this.pullReadingSessions(lastSyncTime);
      result.downloaded = Array.isArray(pulledSessions) ? pulledSessions.length : 0;

      // Jednorázový přepočet globálních statistik po uložení všech stažených relací do IndexedDB
      if (typeof storage.recalculateAndNormalizeStats === "function") {
        await storage.recalculateAndNormalizeStats();
      }

      const uploadRes = await this.syncLocalSessionsToCloud();
      if (uploadRes) {
        result.uploaded = uploadRes.uploaded || 0;
      }
      result.merged = result.downloaded + result.uploaded;

      await this.syncStatsSummary();
      return result;
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při synchronizaci statistik a relací:", err);
      return result;
    }
  }

  /**
   * Kompletní bezpečný reset historie čtecích relací a statistik v Supabase cloudu
   * Označí všechny relace v cloudu jako is_deleted = true a vynuluje reading_stats_summary
   */
  async clearCloudReadingStats(sessionIds = null) {
    if (!this.isOnline() || !supabase) return false;
    try {
      const nowIso = new Date().toISOString();

      // Soft delete všech relací v tabulce reading_sessions
      let { error: updateErr } = await supabase
        .from("reading_sessions")
        .update({
          is_deleted: true,
          updated_at: nowIso
        })
        .neq("is_deleted", true);

      // Fallback na hard delete, pokud sloupec is_deleted ještě neexistuje
      if (updateErr && (updateErr.code === "PGRST204" || updateErr.code === "42703" || updateErr.message?.includes("is_deleted"))) {
        const { error: delErr } = await supabase.from("reading_sessions").delete().neq("id", "");
        if (delErr) {
          console.warn("[SupabaseSync] Chyba při mazání reading_sessions v cloudu:", delErr);
        }
      } else if (updateErr) {
        console.warn("[SupabaseSync] Chyba při označování reading_sessions jako smazané v cloudu:", updateErr);
      }

      try {
        localStorage.removeItem("lumina_last_sessions_sync");
      } catch (_) {}

      const resetSummary = {
        id: "global",
        total_words_read: 0,
        total_reading_seconds: 0,
        global_avg_wpm: 220,
        streak_days: 0,
        last_read_date: storage.getLocalDateString(),
        daily_minutes_map: {},
        updated_at: nowIso
      };
      await supabase.from("reading_stats_summary").upsert(resetSummary, { onConflict: "id" });
      try {
        localStorage.setItem("reading_stats_summary", JSON.stringify(resetSummary));
      } catch (_) {}
      return true;
    } catch (err) {
      console.warn("[SupabaseSync] Chyba v clearCloudReadingStats:", err);
      return false;
    }
  }
}

export const supabaseSync = new SupabaseSync();
