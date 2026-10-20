/**
 * supabase-sync.js - Synchronizační a zálohovací vrstva pro Supabase.
 * Zajišťuje asynchronní ukládání knih a postupu čtení do Supabase,
 * obousměrnou synchronizaci mezi zařízeními a offline-first fungování.
 */

import { supabase, STORAGE_BUCKET, SUPABASE_URL } from './supabase-client.js';
import { storage } from './storage.js';
import { EpubParser } from './epub-parser.js';

export class SupabaseSync {
  constructor() {
    this.status = "idle"; // "idle" | "syncing" | "synced" | "error" | "offline"
    this.statusListeners = new Set();
    this.pendingProgress = null;
    this.progressDebounceTimer = null;
    this.isSyncing = false;
    this._lastSyncTime = 0;

    // Sledování změn síťového připojení
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleOnline());
      window.addEventListener("offline", () => this.handleOffline());
      window.addEventListener("beforeunload", () => this.flushPendingProgress());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.flushPendingProgress();
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

  isOnline() {
    return typeof navigator !== "undefined" ? navigator.onLine : true;
  }

  /**
   * Nahraje knihu a její binární soubor do Supabase Storage a zapíše metadata do tabulky books
   */
  /**
   * Nahraje knihu a její binární soubor do Supabase Storage a zapíše metadata do tabulky books
   */
  async uploadBook(book) {
    if (!this.isOnline()) {
      console.warn("[Supabase Sync] Nelze nahrát knihu: zařízení je offline.");
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
      const ext = book.fileName.split('.').pop().toLowerCase();
      const fileType = ext === 'pdf' ? 'pdf' : 'epub'; // striktně malá písmena
      const mimeType = fileType === 'pdf' ? 'application/pdf' : 'application/epub+zip';

      // Surová binární data (ArrayBuffer, Uint8Array nebo Blob)
      const rawBinary = book.data || book.fileData;
      if (!rawBinary) {
        const missingDataErr = new Error("Kniha neobsahuje surová binární data (book.data / book.fileData)");
        console.error("[Supabase Sync] EPUB upload failed:", missingDataErr);
        throw missingDataErr;
      }

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

      const storagePath = `${book.id}/${book.fileName}`;

      console.log(`[Supabase Sync] Nahrávám ${fileType.toUpperCase()} "${book.title}" (${uploadBlob.size} B, mime: ${mimeType}) do ${storagePath}...`);

      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, uploadBlob, {
          contentType: mimeType,
          upsert: true
        });

      if (error) {
        console.error("[Supabase Sync] EPUB upload failed:", error);
        throw error;
      }

      // Zápis / aktualizace metadat v databázi (tabulka books)
      const scrollProg = Number(book.scrollPercent ?? book.pageRatio ?? 0) || 0;
      const chIdx = Number(book.currentChapterIndex) || 0;
      const pIdx = Math.max(1, (Number(book.currentPageIndex) || 0) + 1);
      const rulerH = Number(book.pdfRulerConfig?.height) || 32;

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
        updated_at: new Date(book.lastReadAt || Date.now()).toISOString()
      };

      const { error: dbError } = await supabase
        .from("books")
        .upsert(row, { onConflict: "id" });

      if (dbError) {
        console.error("[Supabase Sync] EPUB upload failed:", dbError);
        throw dbError;
      }

      console.log(`[Supabase Sync] Kniha "${book.title}" byla úspěšně nahrána do cloudu.`);
      return { success: true, filePath: storagePath };
    } catch (err) {
      console.error("[Supabase Sync] EPUB upload failed:", err);
      return null;
    }
  }

  /**
   * Smaže knihu z cloudu (tabulka books i binární soubor ve Storage)
   */
  async deleteBook(bookId) {
    if (!this.isOnline()) return;

    try {
      console.log(`[SupabaseSync] Mažu knihu ${bookId} z cloudu...`);
      // Zjistíme cestu k souboru
      const { data: bookRow } = await supabase
        .from("books")
        .select("file_path")
        .eq("id", bookId)
        .maybeSingle();

      if (bookRow?.file_path) {
        await supabase.storage.from(STORAGE_BUCKET).remove([bookRow.file_path]);
      }

      await supabase.from("books").delete().eq("id", bookId);
      console.log(`[SupabaseSync] Kniha ${bookId} byla odstraněna z cloudu.`);
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při mazání knihy z cloudu:", err);
    }
  }

  /**
   * Asynchronní aktualizace postupu čtení s debouncingem
   */
  syncProgress(bookId, progressData, { immediate = false } = {}) {
    if (!this.isOnline() || !bookId || !progressData) return;

    if (this.progressDebounceTimer) {
      clearTimeout(this.progressDebounceTimer);
      this.progressDebounceTimer = null;
    }

    this.pendingProgress = { bookId, progressData };

    if (immediate) {
      this.flushPendingProgress();
    } else {
      this.progressDebounceTimer = setTimeout(() => {
        this.flushPendingProgress();
      }, 1500);
    }
  }

  /**
   * Okamžité odeslání čekajícího postupu čtení
   */
  async flushPendingProgress() {
    if (!this.pendingProgress || !this.isOnline()) return;

    const { bookId, progressData } = this.pendingProgress;
    this.pendingProgress = null;

    try {
      const patch = {
        updated_at: new Date().toISOString()
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

      await supabase.from("books").update(patch).eq("id", bookId);
    } catch (err) {
      console.warn("[SupabaseSync] Chyba při odesílání postupu čtení:", err);
    }
  }

  /**
   * Kompletní obousměrná synchronizace mezi IndexedDB a Supabase
   */
  async syncAll(options = {}) {
    if (!this.isOnline()) {
      this.setStatus("offline");
      return { success: false, reason: "offline" };
    }

    if (this.isSyncing) {
      return { success: false, reason: "already_syncing" };
    }

    this.isSyncing = true;
    this.setStatus("syncing");

    const stats = {
      downloaded: 0,
      uploaded: 0,
      updatedFromCloud: 0,
      uploadedToCloud: 0,
      total: 0
    };

    try {
      // 1. Získat lokální knihy z IndexedDB
      const localBooks = await storage.getAllBooks();
      const localMap = new Map(localBooks.map(b => [b.id, b]));

      // 2. Získat záznamy knih ze Supabase
      const { data: cloudBooks, error: fetchErr } = await supabase
        .from("books")
        .select("*");

      if (fetchErr) {
        throw fetchErr;
      }

      const cloudList = cloudBooks || [];
      const cloudMap = new Map(cloudList.map(b => [b.id, b]));

      // 3. Projít cloudové knihy (stáhnout chybějící nebo aktualizovat postup)
      for (const cloudBook of cloudList) {
        const localBook = localMap.get(cloudBook.id);

        if (!localBook) {
          // Kniha existuje v cloudu, ale ne lokálně -> STÁHNOUT
          try {
            let storagePath = cloudBook.file_path || `${cloudBook.id}/${cloudBook.file_name}`;
            if (!storagePath) {
              const ext = cloudBook.file_type === "pdf" ? "pdf" : "epub";
              storagePath = `${cloudBook.id}/${cloudBook.id}.${ext}`;
            }

            console.log(`[Supabase Sync] Stahuji knihu z cloudu: "${cloudBook.title}" (${storagePath})...`);
            let { data: blob, error: dlErr } = await supabase.storage
              .from(STORAGE_BUCKET)
              .download(storagePath);

            // Fallback na alternativní prefixy v úložišti
            if (dlErr && storagePath.startsWith("books/")) {
              const altPath = storagePath.replace(/^books\//, "");
              const altRes = await supabase.storage.from(STORAGE_BUCKET).download(altPath);
              if (!altRes.error && altRes.data) {
                blob = altRes.data;
                dlErr = null;
                storagePath = altPath;
              }
            } else if (dlErr && !storagePath.startsWith("books/")) {
              const altPath = `books/${storagePath}`;
              const altRes = await supabase.storage.from(STORAGE_BUCKET).download(altPath);
              if (!altRes.error && altRes.data) {
                blob = altRes.data;
                dlErr = null;
                storagePath = altPath;
              }
            }

            if (dlErr || !blob) {
              console.error("[Supabase Sync] Nepodařilo se stáhnout soubor knihy z cloudu:", storagePath, dlErr);
              continue;
            }

            // Převod staženého Blobu na čistý ArrayBuffer
            const arrayBuffer = await blob.arrayBuffer();
            const isPdf = cloudBook.file_type === "pdf" || storagePath.toLowerCase().endsWith(".pdf");
            const finalFileName = cloudBook.file_name || `${cloudBook.id}.${isPdf ? "pdf" : "epub"}`;

            let newBookData = null;

            if (isPdf) {
              let coverDataUrl = null;
              let numPages = 1;
              try {
                if (window.pdfjsLib) {
                  const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
                  const pdfDoc = await loadingTask.promise;
                  numPages = pdfDoc.numPages || 1;
                  const page = await pdfDoc.getPage(1);
                  const viewport = page.getViewport({ scale: 0.5 });
                  const canvas = document.createElement("canvas");
                  canvas.width = viewport.width;
                  canvas.height = viewport.height;
                  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
                  coverDataUrl = canvas.toDataURL("image/jpeg", 0.75);
                }
              } catch (pe) {
                console.warn("[Supabase Sync] Varování při náhledu PDF z cloudu:", pe);
              }

              newBookData = {
                id: cloudBook.id,
                title: cloudBook.title || "PDF Dokument",
                author: "PDF Dokument",
                creator: "PDF Dokument",
                fileName: finalFileName,
                file_name: finalFileName,
                format: "pdf",
                isPdf: true,
                language: "cs",
                description: `PDF dokument (${numPages} stran)`,
                coverDataUrl,
                fileData: arrayBuffer,
                data: arrayBuffer,
                addedAt: cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now(),
                lastReadAt: cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now(),
                currentChapterIndex: Number(cloudBook.current_chapter) || 0,
                currentPageIndex: Math.max(0, (Number(cloudBook.current_page) || 1) - 1),
                totalChapters: 1,
                totalWords: numPages * 250,
                wordsRead: 0,
                progress: Math.round((Number(cloudBook.scroll_progress) || 0) * 100),
                progressPercent: Math.round((Number(cloudBook.scroll_progress) || 0) * 100),
                currentPage: Number(cloudBook.current_page) || 1,
                numPages: numPages,
                scrollPercent: Number(cloudBook.scroll_progress) || 0,
                pageRatio: Number(cloudBook.scroll_progress) || 0,
                pdfRulerConfig: {
                  height: Number(cloudBook.pdf_ruler_height) || 32,
                  stepSize: Number(cloudBook.pdf_ruler_height) || 32
                }
              };
            } else {
              // EPUB
              let coverDataUrl = null;
              let parsedTitle = "";
              let parsedAuthor = "";
              let totalChapters = 1;
              let totalWords = 0;

              try {
                const parser = await EpubParser.parse(arrayBuffer.slice(0));
                parsedTitle = parser.metadata?.title || "";
                parsedAuthor = parser.metadata?.creator || "";
                totalChapters = parser.spine?.length || 1;
                const wordStats = await parser.calculateTotalWords().catch(() => ({ totalWords: 0 }));
                totalWords = wordStats.totalWords || 0;

                if (parser.coverBlobUrl) {
                  try {
                    const res = await fetch(parser.coverBlobUrl);
                    const b = await res.blob();
                    coverDataUrl = await new Promise((res) => {
                      const r = new FileReader();
                      r.onloadend = () => res(r.result);
                      r.readAsDataURL(b);
                    });
                  } catch (e) {}
                }
              } catch (parseErr) {
                console.warn("[Supabase Sync] Varování při parsování staženého EPUB:", parseErr);
              }

              const author = cloudBook.author || cloudBook.creator || parsedAuthor || "Neznámý autor";
              const title = cloudBook.title || parsedTitle || "Kniha EPUB";

              newBookData = {
                id: cloudBook.id,
                title: title,
                author: author,
                creator: author,
                fileName: finalFileName,
                file_name: finalFileName,
                format: "epub",
                isPdf: false,
                language: "cs",
                description: "",
                coverDataUrl,
                fileData: arrayBuffer,
                data: arrayBuffer,
                addedAt: cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now(),
                lastReadAt: cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : Date.now(),
                currentChapterIndex: Number(cloudBook.current_chapter) || 0,
                currentPageIndex: Math.max(0, (Number(cloudBook.current_page) || 1) - 1),
                totalChapters: totalChapters,
                totalWords: totalWords,
                wordsRead: 0,
                progress: Math.round((Number(cloudBook.scroll_progress) || 0) * 100),
                progressPercent: Math.round((Number(cloudBook.scroll_progress) || 0) * 100),
                currentPage: Number(cloudBook.current_page) || 1,
                scrollPercent: Number(cloudBook.scroll_progress) || 0,
                pageRatio: Number(cloudBook.scroll_progress) || 0
              };
            }

            if (newBookData) {
              await storage.saveBook(newBookData);
              stats.downloaded++;
              console.log(`[Supabase Sync] Kniha "${newBookData.title}" stažena a uložena do IndexedDB.`);
            }
          } catch (dlErr) {
            console.error(`[Supabase Sync] Nepodařilo se stáhnout a zpracovat knihu ${cloudBook.id}:`, dlErr);
          }
        } else {
          // Kniha existuje v obou úložištích -> Synchronizace postupu čtení
          const cloudTime = cloudBook.updated_at ? new Date(cloudBook.updated_at).getTime() : 0;
          const localTime = localBook.lastReadAt || localBook.addedAt || 0;

          // Pokud je cloud o více než 2 sekundy novější než lokální stav:
          if (cloudTime > localTime + 2000) {
            const chIdx = cloudBook.current_chapter || 0;
            const pIdx = Math.max(0, (cloudBook.current_page || 1) - 1);
            const scroll = Number(cloudBook.scroll_progress) || 0;
            const currPage = pIdx + 1;
            const totalPages = localBook.numPages || cloudBook.total_pages || localBook.total_pages;
            const computedProgress = (totalPages && totalPages > 0)
              ? Math.max(0, Math.min(100, Math.round((currPage / totalPages) * 100)))
              : Math.max(0, Math.min(100, Math.round((scroll > 0 && scroll <= 1) ? scroll * 100 : scroll)));

            const updates = {
              currentChapterIndex: chIdx,
              currentPageIndex: pIdx,
              currentPage: currPage,
              numPages: totalPages,
              scrollPercent: scroll,
              scroll_progress: scroll,
              pageRatio: scroll,
              progress: computedProgress,
              progressPercent: computedProgress,
              lastReadAt: cloudTime
            };
            if (cloudBook.pdf_ruler_height && localBook.pdfRulerConfig) {
              updates.pdfRulerConfig = {
                height: cloudBook.pdf_ruler_height,
                stepSize: cloudBook.pdf_ruler_height
              };
            }

            await storage.updateBookProgress(localBook.id, updates);
            try {
              localStorage.setItem(`lumina_progress_${localBook.id}`, JSON.stringify(updates));
            } catch (e) {}

            stats.updatedFromCloud++;
            console.log(`[SupabaseSync] Postup knihy "${localBook.title}" aktualizován z cloudu (kap. ${chIdx}, str. ${pIdx + 1}).`);
          } else if (localTime > cloudTime + 2000) {
            // Lokální stav je novější -> odeslat do cloudu
            const patch = {
              current_chapter: localBook.currentChapterIndex || 0,
              current_page: Math.max(1, (localBook.currentPageIndex || 0) + 1),
              scroll_progress: Number(localBook.scrollPercent ?? localBook.pageRatio ?? 0) || 0,
              pdf_ruler_height: localBook.pdfRulerConfig?.height || 32,
              updated_at: new Date(localTime).toISOString()
            };
            await supabase.from("books").update(patch).eq("id", localBook.id);
            stats.uploadedToCloud++;
          }
        }
      }

      // 4. Lokální knihy, které ještě nejsou v cloudu -> ZÁLOHOVAT
      for (const localBook of localBooks) {
        if (!cloudMap.has(localBook.id)) {
          console.log(`[SupabaseSync] Zálohuji lokální knihu "${localBook.title}" do cloudu...`);
          const res = await this.uploadBook(localBook);
          if (res?.success) {
            stats.uploaded++;
          }
        }
      }

      this._lastSyncTime = Date.now();
      this.setStatus("synced");
      return { success: true, stats };
    } catch (err) {
      console.warn("[SupabaseSync] Synchronizace selhala:", err);
      this.setStatus("error");
      return { success: false, error: err };
    } finally {
      this.isSyncing = false;
    }
  }
}

export const supabaseSync = new SupabaseSync();
