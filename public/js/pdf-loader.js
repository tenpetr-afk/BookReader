/**
 * pdf-loader.js - Samostatný modul pro načítání a vykreslování PDF dokumentů pomocí PDF.js.
 * 
 * Zajišťuje:
 * - Asynchronní načtení PDF dokumentu z ArrayBufferu a extrakci počtu stran (numPages).
 * - Vykreslení požadované strany do elementu <canvas> přizpůsobeného rozměrům viewportu
 *   při zachování devicePixelRatio (HiDPI/Retina na iPadu).
 * - Navigaci po stranách (nextPage, prevPage, goToPage) s provázáním do globálního stavu čtečky.
 */

export class PDFLoader {
  constructor(app = null, containerElement = null) {
    this.app = app;
    this.container = containerElement || document.getElementById("reader-content");
    this.pdfDoc = null;
    this.numPages = 0;
    this.currentPage = 1;
    this.canvas = null;
    this.currentRenderTask = null;
    this.isRendering = false;
    this._renderQueuePage = null;
    this.onPageChanged = null;
  }

  /**
   * Statická tovární metoda pro přímé načtení a vykreslení PDF
   */
  static async load(arrayBuffer, app = null, container = null) {
    const loader = new PDFLoader(app, container);
    await loader.load(arrayBuffer);
    return loader;
  }

  /**
   * Načte PDF dokument z binárních dat (ArrayBuffer)
   */
  async load(arrayBuffer) {
    if (!window.pdfjsLib) {
      throw new Error("Knihovna PDF.js není načtena.");
    }

    // Nastavení cesty k web workeru
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    // Zrušení předchozího renderování, pokud běželo
    if (this.currentRenderTask) {
      try {
        this.currentRenderTask.cancel();
      } catch (e) {
        // Ignorovat zrušení
      }
      this.currentRenderTask = null;
    }

    if (this.pdfDoc) {
      try {
        this.pdfDoc.destroy();
      } catch (e) {}
      this.pdfDoc = null;
    }

    // Klonování dat před předáním do PDF.js, protože Web Worker přebírá
    // vlastnictví bufferu (transferable object) a odpojuje ArrayBuffer v hlavním vlákně
    let pdfData;
    if (arrayBuffer instanceof ArrayBuffer) {
      pdfData = arrayBuffer.slice(0);
    } else if (ArrayBuffer.isView(arrayBuffer)) {
      pdfData = arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
    } else {
      pdfData = arrayBuffer;
    }

    const loadingTask = window.pdfjsLib.getDocument({
      data: pdfData,
      cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/",
      cMapPacked: true
    });

    this.pdfDoc = await loadingTask.promise;
    this.numPages = this.pdfDoc.numPages;
    this.currentPage = 1;

    // Vykreslit první stranu
    await this.renderPage(1);

    return this;
  }

  /**
   * Vykreslí zadanou stranu PDF do elementu <canvas>
   * respektujícího rozměry kontejneru a Retina / HiDPI rozlišení obrazovky
   */
  async renderPage(pageNumber) {
    if (!this.pdfDoc || pageNumber < 1 || pageNumber > this.numPages) return;

    if (this.isRendering) {
      this._renderQueuePage = pageNumber;
      if (this.currentRenderTask) {
        try {
          this.currentRenderTask.cancel();
        } catch (e) {}
      }
      return;
    }

    this.isRendering = true;
    this.currentPage = pageNumber;

    try {
      const page = await this.pdfDoc.getPage(pageNumber);

      const container = this.container || document.getElementById("reader-content");
      const stage = document.getElementById("paged-stage") || container;
      const stageRect = stage.getBoundingClientRect();

      // Šířka a výška dostupného prostoru pro zobrazení
      const containerWidth = (stageRect.width > 50 ? stageRect.width : container.clientWidth) || (window.innerWidth * 0.85);
      const containerHeight = (stageRect.height > 50 ? stageRect.height : container.clientHeight) || (window.innerHeight - 120);

      // Původní velikost strany při měřítku 1.0
      const unscaledViewport = page.getViewport({ scale: 1 });

      // Odsazení od okrajů viewportu
      const padX = 16;
      const padY = 16;
      const availWidth = Math.max(100, containerWidth - padX);
      const availHeight = Math.max(100, containerHeight - padY);

      // Měřítko pro přesné vepsání do rozměrů okna (Fit to container)
      const scaleX = availWidth / unscaledViewport.width;
      const scaleY = availHeight / unscaledViewport.height;
      const scale = Math.min(scaleX, scaleY);

      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      // Připravíme canvas
      container.innerHTML = "";
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      this.canvas = canvas;

      // Fyzické rozlišení canvasu pro ostrý text na Retina/HiDPI displejích iPadu
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      // CSS rozměry odpovídající logickým pixelům viewportu
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext("2d");
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

      container.appendChild(canvas);

      const renderContext = {
        canvasContext: ctx,
        transform: transform,
        viewport: viewport
      };

      this.currentRenderTask = page.render(renderContext);
      await this.currentRenderTask.promise;
      this.currentRenderTask = null;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.error("[PDFLoader] Chyba při vykreslování strany PDF:", err);
      }
    } finally {
      this.isRendering = false;
      if (this._renderQueuePage !== null) {
        const next = this._renderQueuePage;
        this._renderQueuePage = null;
        await this.renderPage(next);
      }
    }

    // Provázání do globálního stavu aplikace LuminaReader
    if (this.app && typeof this.app.onPdfPageRendered === "function") {
      this.app.onPdfPageRendered(this.currentPage, this.numPages);
    }
    if (typeof this.onPageChanged === "function") {
      this.onPageChanged(this.currentPage, this.numPages);
    }
  }

  /**
   * Přechod na následující stranu
   */
  async nextPage() {
    if (this.currentPage < this.numPages) {
      await this.goToPage(this.currentPage + 1, 1);
      return true;
    }
    return false;
  }

  /**
   * Přechod na předchozí stranu
   */
  async prevPage() {
    if (this.currentPage > 1) {
      await this.goToPage(this.currentPage - 1, -1);
      return true;
    }
    return false;
  }

  /**
   * Skok na konkrétní stranu (1 až numPages)
   */
  async goToPage(pageNumber, direction = 0) {
    const target = Math.max(1, Math.min(this.numPages, pageNumber));
    const dir = direction !== 0 ? direction : (target > this.currentPage ? 1 : -1);

    await this.renderPage(target);

    // Resynchronizace pravítka na nové straně
    if (this.app?.ruler && this.app.ruler.enabled) {
      this.app.ruler.onPageChange(dir, true, true);
    }
  }

  /**
   * Úklid alokovaných prostředků a zrušení renderovacích úloh
   */
  destroy() {
    if (this.currentRenderTask) {
      try {
        this.currentRenderTask.cancel();
      } catch (e) {}
      this.currentRenderTask = null;
    }
    if (this.pdfDoc) {
      try {
        this.pdfDoc.destroy();
      } catch (e) {}
      this.pdfDoc = null;
    }
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.canvas = null;
  }
}
