/**
 * supabase-sync.js - Synchronizační a zálohovací vrstva pro Supabase.
 * Zajišťuje asynchronní ukládání knih a postupu čtení do Supabase,
 * obousměrnou synchronizaci mezi zařízeními a offline-first fungování.
 */

import { supabase, STORAGE_BUCKET, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { storage, computeFileHash } from './storage.js';
import { EpubParser } from './epub-parser.js';

export class SupabaseSync {
  constructor() {
    this.status = "idle"; // "idle" | "syncing" | "synced" | "error" | "offline"
    this.statusListeners = new Set();
    this.syncCompletedListeners = new Set();
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

      // Surová binární data (ArrayBuffer, Uint8Array nebo Blob)
      const rawBinary = book.data || book.fileData;
      if (!rawBinary) {
        const missingDataErr = new Error("Kniha neobsahuje surová binární data (book.data / book.fileData)");
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, missingDataErr);
        throw missingDataErr;
      }

      // Výpočet deterministického hashe a ID pro PDF
      if (isPdf) {
        if (!book.fileHash && !book.file_hash) {
          try {
            const h = await computeFileHash(rawBinary);
            if (h) {
              book.fileHash = h;
              book.file_hash = h;
            }
          } catch (_) {}
        }
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

      console.log(`[Supabase Sync] Nahrávám ${fileType.toUpperCase()} "${book.title}" (${uploadBlob.size} B, mime: ${mimeType}) do ${storagePath}...`);

      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, uploadBlob, {
          contentType: mimeType,
          upsert: true
        });

      if (error) {
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, error);
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
        console.error(`[Supabase Sync] ${fileType.toUpperCase()} upload failed:`, dbError);
        throw dbError;
      }

      console.log(`[Supabase Sync] Kniha "${book.title}" byla úspěšně nahrána do cloudu.`);
      return { success: true, filePath: storagePath };
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
      // Zjistíme cestu k souboru
      const { data: bookRow } = await supabase
        .from("books")
        .select("file_path")
        .eq("id", bookId)
        .maybeSingle();

      const pathsToRemove = [];
      if (bookRow?.file_path) {
        pathsToRemove.push(bookRow.file_path);
      }
      if (bookId && bookId.startsWith("pdf_")) {
        pathsToRemove.push(`books/${bookId}.pdf`);
      }

      if (pathsToRemove.length > 0) {
        await supabase.storage.from(STORAGE_BUCKET).remove(pathsToRemove);
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
    if (!this.pendingProgress || !this.isOnline() || !supabase) return;

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
   * Kompletní obousměrná synchronizace mezi IndexedDB a Supabase
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
      downloaded: 0,
      uploaded: 0,
      updatedFromCloud: 0,
      uploadedToCloud: 0,
      sessionsDownloaded: 0,
      sessionsUploaded: 0,
      sessionsMerged: 0,
      total: 0
    };

    try {
      // 1. Získat a deduplikovat lokální knihy z IndexedDB
      const localBooks = await storage.deduplicateBooks();
      const localMap = new Map(localBooks.map(b => [b.id, b]));

      // 2. Získat a deduplikovat záznamy knih ze Supabase
      const { data: rawCloudBooks, error: fetchErr } = await supabase
        .from("books")
        .select("*");

      if (fetchErr) {
        throw fetchErr;
      }

      const cloudList = await this.normalizeAndMergeCloudBooks(rawCloudBooks || []);
      const matchedLocalIds = new Set();

      // Pomocná funkce pro vyhledání odpovídající lokální knihy ke cloudové knize
      const findMatchingLocalBook = (cloudBook) => {
        // 1. Shoda podle id
        const byId = localBooks.find(b => b.id === cloudBook.id);
        if (byId) return byId;

        // 2. Shoda podle file_path / storage_path
        if (cloudBook.file_path) {
          const byPath = localBooks.find(b => b.file_path === cloudBook.file_path);
          if (byPath) return byPath;
        }

        const isPdf = cloudBook.file_type === "pdf" ||
                      cloudBook.file_name?.toLowerCase().endsWith(".pdf") ||
                      cloudBook.file_path?.toLowerCase().endsWith(".pdf");

        if (isPdf) {
          // 3. Shoda podle fileHash v ID nebo na objektu
          for (const b of localBooks) {
            if (!b.isPdf && b.format !== "pdf") continue;
            const bHash = b.fileHash || b.file_hash;
            if (bHash) {
              if (cloudBook.id && cloudBook.id.includes(bHash)) return b;
              if (cloudBook.file_path && cloudBook.file_path.includes(bHash)) return b;
            }
          }

          // 4. Shoda podle normalizovaného názvu souboru nebo titulku
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

      // 3. Projít cloudové knihy (stáhnout chybějící nebo aktualizovat postup)
      for (const cloudBook of cloudList) {
        const localBook = findMatchingLocalBook(cloudBook);

        if (!localBook) {
          // Kniha existuje v cloudu, ale ne lokálně -> STÁHNOUT
          try {
            let storagePath = cloudBook.file_path || (cloudBook.file_type === "pdf" ? `books/${cloudBook.id}.pdf` : `${cloudBook.id}/${cloudBook.file_name}`);
            if (!storagePath) {
              const ext = cloudBook.file_type === "pdf" ? "pdf" : "epub";
              storagePath = `books/${cloudBook.id}.${ext}`;
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
              console.warn("[Supabase Sync] Nepodařilo se stáhnout soubor knihy z cloudu (soubor neexistuje v úložišti):", storagePath, dlErr?.message || dlErr);
              continue;
            }

            // Převod staženého Blobu na čistý ArrayBuffer
            const arrayBuffer = await blob.arrayBuffer();
            const isPdf = cloudBook.file_type === "pdf" || storagePath.toLowerCase().endsWith(".pdf");
            const finalFileName = cloudBook.file_name || `${cloudBook.id}.${isPdf ? "pdf" : "epub"}`;

            let newBookData = null;

            if (isPdf) {
              const fileHash = await computeFileHash(arrayBuffer);
              const canonicalId = `pdf_${fileHash}`;
              const canonicalStoragePath = `books/${canonicalId}.pdf`;

              // Zkontrolujeme znovu, zda již kniha neexistuje lokálně pod tímto hashem
              const alreadyLocal = await storage.findBookByIdOrHash(canonicalId, fileHash);
              if (alreadyLocal) {
                matchedLocalIds.add(alreadyLocal.id);
                console.log(`[Supabase Sync] PDF kniha "${cloudBook.title}" již lokálně existuje jako ${alreadyLocal.id}, vynechávám vkládání duplikátu.`);
                continue;
              }

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
                id: canonicalId,
                fileHash,
                file_hash: fileHash,
                file_path: canonicalStoragePath,
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

              // Pokud cloud záznam měl staré nestabilní ID, migrujeme jej v Supabase na deterministické ID
              if (cloudBook.id !== canonicalId) {
                try {
                  const cloudPatch = {
                    id: canonicalId,
                    title: newBookData.title,
                    file_name: newBookData.fileName,
                    file_type: "pdf",
                    file_path: canonicalStoragePath,
                    current_chapter: Number(cloudBook.current_chapter) || 0,
                    current_page: Number(cloudBook.current_page) || 1,
                    scroll_progress: Number(cloudBook.scroll_progress) || 0,
                    pdf_ruler_height: Number(cloudBook.pdf_ruler_height) || 32,
                    updated_at: cloudBook.updated_at || new Date().toISOString()
                  };
                  await supabase.from("books").upsert(cloudPatch, { onConflict: "id" });
                  await supabase.from("books").delete().eq("id", cloudBook.id);
                  console.log(`[Supabase Sync] Migrován cloud záznam PDF: ${cloudBook.id} -> ${canonicalId}`);
                } catch (migErr) {
                  console.warn("[Supabase Sync] Varování při migraci cloud ID:", migErr);
                }
              }
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
              matchedLocalIds.add(newBookData.id);
              stats.downloaded++;
              console.log(`[Supabase Sync] Kniha "${newBookData.title}" stažena a uložena do IndexedDB.`);
            }
          } catch (dlErr) {
            console.error(`[Supabase Sync] Nepodařilo se stáhnout a zpracovat knihu ${cloudBook.id}:`, dlErr);
          }
        } else {
          // Kniha existuje v obou úložištích -> Synchronizace postupu čtení
          matchedLocalIds.add(localBook.id);
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
            await supabase.from("books").update(patch).eq("id", cloudBook.id);
            stats.uploadedToCloud++;
          }

          // Pokud má lokální kniha deterministické ID, ale cloudBook má ještě staré ID, sjednotíme záznam v cloudu
          if (localBook.id !== cloudBook.id && localBook.isPdf) {
            try {
              const cloudPatch = {
                id: localBook.id,
                title: localBook.title,
                file_name: localBook.fileName,
                file_type: "pdf",
                file_path: `books/${localBook.id}.pdf`,
                current_chapter: localBook.currentChapterIndex || 0,
                current_page: Math.max(1, (localBook.currentPageIndex || 0) + 1),
                scroll_progress: Number(localBook.scrollPercent ?? localBook.pageRatio ?? 0) || 0,
                pdf_ruler_height: localBook.pdfRulerConfig?.height || 32,
                updated_at: new Date(localTime || Date.now()).toISOString()
              };
              await supabase.from("books").upsert(cloudPatch, { onConflict: "id" });
              await supabase.from("books").delete().eq("id", cloudBook.id);
              console.log(`[SupabaseSync] Sjednoceno ID v cloudu s lokálním: ${cloudBook.id} -> ${localBook.id}`);
            } catch (syncMigErr) {
              console.warn("[SupabaseSync] Varování při sjednocování ID v cloudu:", syncMigErr);
            }
          }
        }
      }

      // 4. Lokální knihy, které ještě nejsou v cloudu -> ZÁLOHOVAT
      for (const localBook of localBooks) {
        if (!matchedLocalIds.has(localBook.id)) {
          console.log(`[SupabaseSync] Zálohuji lokální knihu "${localBook.title}" do cloudu...`);
          const res = await this.uploadBook(localBook);
          if (res?.success) {
            stats.uploaded++;
          }
        }
      }

      // 5. Synchronizace čtecích relací a agregovaných statistik (reading_sessions & reading_stats_summary)
      try {
        let lastSyncTime = localStorage.getItem('lumina_last_sessions_sync') || null;
        const localSessionsCheck = await storage.getAllReadingSessions();
        if (!localSessionsCheck || localSessionsCheck.length === 0) {
          lastSyncTime = null;
        }

        const pulledSessions = await this.pullReadingSessions(lastSyncTime);
        console.log(`[SupabaseSync] Successfully imported ${pulledSessions.length} reading sessions.`);

        stats.sessionsDownloaded = Array.isArray(pulledSessions) ? pulledSessions.length : 0;

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
   * id, book_id, start_time, duration, words_read, avg_wpm, peak_wpm, intra_session_samples, updated_at
   */
  async pushSingleSession(session) {
    if (!this.isOnline() || !supabase || !session) return null;
    const dur = Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
    if (dur < 300) return null; // Striktně zahodit relace < 5 minut

    const payload = {
      id: String(session.sessionId || session.id),
      book_id: String(session.bookId || session.book_id || "unknown"),
      start_time: session.startTime || session.start_time || new Date(session.timestamp || Date.now()).toISOString(),
      duration: Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0)),
      words_read: Math.round(Number(session.words_read ?? session.wordsRead ?? 0)),
      avg_wpm: Math.round(Number(session.avg_wpm ?? session.avgWpm ?? session.wpm ?? 0)),
      peak_wpm: Math.round(Number(session.peak_wpm ?? session.peakWpm ?? session.avg_wpm ?? 0)),
      intra_session_samples: Array.isArray(session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
        ? (session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
        : [],
      updated_at: session.updatedAt || session.updated_at || new Date().toISOString()
    };

    const { error } = await supabase.from("reading_sessions").upsert(payload, { onConflict: "id" });
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

    const cleanPayloads = [];
    for (const session of sessions) {
      if (!session) continue;
      const dur = Math.round(Number(session.duration ?? session.durationSeconds ?? session.activeSeconds ?? 0));
      if (dur < 300) continue; // Pouze relace >= 5 minut

      cleanPayloads.push({
        id: String(session.sessionId || session.id),
        book_id: String(session.bookId || session.book_id || "unknown"),
        start_time: session.startTime || session.start_time || new Date(session.timestamp || Date.now()).toISOString(),
        duration: dur,
        words_read: Math.round(Number(session.words_read ?? session.wordsRead ?? 0)),
        avg_wpm: Math.round(Number(session.avg_wpm ?? session.avgWpm ?? session.wpm ?? 0)),
        peak_wpm: Math.round(Number(session.peak_wpm ?? session.peakWpm ?? session.avg_wpm ?? 0)),
        intra_session_samples: Array.isArray(session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
          ? (session.intra_session_samples || session.intraSessionSamples || session.timelineSamples)
          : [],
        updated_at: session.updatedAt || session.updated_at || new Date().toISOString()
      });
    }

    if (cleanPayloads.length === 0) {
      return { success: true, count: 0 };
    }

    for (let i = 0; i < cleanPayloads.length; i += 50) {
      const chunk = cleanPayloads.slice(i, i + 50);
      const { error } = await supabase.from("reading_sessions").upsert(chunk, { onConflict: "id" });
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
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    if (!this.isOnline() || !supabase) {
      return { success: false, reason: "offline" };
    }

    const targetIdStr = String(sessionId).trim();

    try {
      const { error } = await supabase
        .from('reading_sessions')
        .delete()
        .eq('id', targetIdStr);

      if (error) {
        console.warn("[SupabaseSync] Chyba při mazání relace v cloudu:", error);
        return { success: false, error };
      }

      await this.syncStatsSummary();
      return { success: true };
    } catch (err) {
      console.warn("[SupabaseSync] Výjimka při mazání relace v cloudu:", err);
      return { success: false, error: err };
    }
  }

  /**
   * Synchronizuje souhrnné statistiky čtení (reading_stats_summary) mezi zařízeními
   * Striktně odesílá POUZE povolené sloupce databázového schématu reading_stats_summary:
   * id, total_words_read, total_reading_seconds, global_avg_wpm, streak_days, last_read_date, daily_minutes_map, updated_at
   */
  async syncStatsSummary() {
    if (!this.isOnline() || !supabase) return null;

    try {
      const { ReadingTracker } = await import("./tracker.js");
      const localStats = await ReadingTracker.computeGlobalStats();

      // 1. Zkusit stáhnout stávající summary z cloudu
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

      const cloudSummary = Array.isArray(cloudSummaryList) && cloudSummaryList.length > 0 ? cloudSummaryList[0] : null;

      // 2. Sestavit mapu denních minut
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

      // 3. Idempotentní sloučení s cloudovou mapou denních minut
      if (cloudSummary) {
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
        global_avg_wpm: Math.round(Number(localStats.averageWpm || 220)),
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
   * Stáhne a importuje všechny dostupné čtecí relace ze Supabase do IndexedDB v jedné dávce
   * @param {string|null} [lastSyncTimestamp=null]
   * @returns {Promise<Array>}
   */
  async pullReadingSessions(lastSyncTimestamp = null) {
    if (!this.isOnline() || !supabase) return [];

    let query = supabase
      .from('reading_sessions')
      .select('*')
      .order('updated_at', { ascending: true });

    if (lastSyncTimestamp) {
      query = query.gt('updated_at', lastSyncTimestamp);
    }

    // Fetch up to 1000 sessions in a single batch (no .limit(1) or .single())
    query = query.limit(1000);

    const { data, error } = await query;
    if (error) {
      console.error('[SupabaseSync] Error pulling reading sessions:', error);
      return [];
    }

    if (!data || data.length === 0) return [];

    // Pomocná mapa knih pro případné doplnění chybějícího bookTitle
    let booksMap = null;
    try {
      const localBooks = await storage.getAllBooks();
      booksMap = new Map((localBooks || []).map(b => [b.id, b]));
    } catch (_) {}

    // 2. Iterate and Save EVERY Session into IndexedDB
    let maxUpdatedAt = lastSyncTimestamp;
    for (const session of data) {
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
      await storage.saveReadingSession(session);
      if (session.updated_at && (!maxUpdatedAt || session.updated_at > maxUpdatedAt)) {
        maxUpdatedAt = session.updated_at;
      }
    }

    // 3. Update the sync watermark only after ALL sessions in the batch are processed
    if (maxUpdatedAt) {
      localStorage.setItem('lumina_last_sessions_sync', maxUpdatedAt);
    }

    return data;
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
      if (!localSessions || localSessions.length === 0) return { uploaded: 0 };

      const { data: cloudSessionsRaw, error: sessErr } = await supabase
        .from("reading_sessions")
        .select("id, updated_at");

      if (sessErr) {
        if (sessErr.code !== "PGRST205") {
          console.warn("[SupabaseSync] Tabulka reading_sessions není dostupná:", sessErr.message || sessErr);
        }
        return { uploaded: 0 };
      }

      const cloudMap = new Map((cloudSessionsRaw || []).map(cs => [String(cs.id), new Date(cs.updated_at || 0).getTime()]));
      const toUpload = [];

      for (const s of localSessions) {
        const sid = String(s.sessionId || s.id || "");
        if (!sid) continue;

        const dur = Math.max(0, Math.round(Number(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0)));
        if (dur < 300) continue; // Pouze relace >= 5 minut

        const localUpdatedAt = new Date(s.updatedAt || s.updated_at || s.timestamp || s.startTime || 0).getTime();
        const cloudUpdatedAt = cloudMap.get(sid);

        if (cloudUpdatedAt === undefined) {
          // Relace ještě není v cloudu -> nahrát
          toUpload.push(s);
        } else if (localUpdatedAt > cloudUpdatedAt + 1000) {
          // Lokální relace je novější -> aktualizovat v cloudu
          toUpload.push(s);
        }
      }

      if (toUpload.length > 0) {
        const upRes = await this.pushMultipleSessions(toUpload);
        if (upRes?.success) {
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
   */
  async clearCloudReadingStats() {
    if (!this.isOnline() || !supabase) return false;
    try {
      const { error: delErr } = await supabase.from("reading_sessions").delete().neq("id", "");
      if (delErr) {
        console.warn("[SupabaseSync] Chyba při mazání reading_sessions v cloudu:", delErr);
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
        updated_at: new Date().toISOString()
      };
      await supabase.from("reading_stats_summary").upsert(resetSummary, { onConflict: "id" });
      return true;
    } catch (err) {
      console.warn("[SupabaseSync] Chyba v clearCloudReadingStats:", err);
      return false;
    }
  }
}

export const supabaseSync = new SupabaseSync();
