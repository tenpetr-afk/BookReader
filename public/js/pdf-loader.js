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
    this.pageContainer = null;
    this.imageLayer = null;
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

      // Cílové rozměry striktně podle celého okna viewportu (Edge-to-Edge full screen)
      const targetWidth = window.innerWidth;
      const targetHeight = window.innerHeight;

      // Původní velikost strany při měřítku 1.0 (respektuje page.view i případnou rotaci dokumentu)
      const unscaledViewport = page.getViewport({ scale: 1 });
      const rawWidth = (page.rotate === 90 || page.rotate === 270)
        ? (page.view?.[3] || unscaledViewport.width)
        : (page.view?.[2] || unscaledViewport.width);
      const rawHeight = (page.rotate === 90 || page.rotate === 270)
        ? (page.view?.[2] || unscaledViewport.height)
        : (page.view?.[3] || unscaledViewport.height);
      const pageWidth = unscaledViewport.width || rawWidth || targetWidth;
      const pageHeight = unscaledViewport.height || rawHeight || targetHeight;

      // Dynamické měřítko pro 100% zobrazení bez okrajů a odsazení
      const scaleX = targetWidth / pageWidth;
      const scaleY = targetHeight / pageHeight;
      const scale = Math.min(scaleX, scaleY);

      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      // Připravíme kontejner a canvas bez simulovaného papíru, stínů či zaoblení
      container.innerHTML = "";

      const pageContainer = document.createElement("div");
      pageContainer.className = "pdf-page-container";
      this.pageContainer = pageContainer;

      pageContainer.style.position = "relative";
      pageContainer.style.width = `${Math.floor(viewport.width)}px`;
      pageContainer.style.height = `${Math.floor(viewport.height)}px`;
      pageContainer.style.maxWidth = "100vw";
      pageContainer.style.maxHeight = "100vh";
      pageContainer.style.margin = "auto";
      pageContainer.style.display = "flex";
      pageContainer.style.justifyContent = "center";
      pageContainer.style.alignItems = "center";
      pageContainer.style.boxShadow = "none";
      pageContainer.style.border = "none";
      pageContainer.style.borderRadius = "0";
      pageContainer.style.padding = "0";

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      this.canvas = canvas;

      canvas.style.boxShadow = "none";
      canvas.style.border = "none";
      canvas.style.borderRadius = "0";
      canvas.style.margin = "0";
      canvas.style.padding = "0";

      // Fyzické rozlišení canvasu pro ostrý text na Retina/HiDPI displejích iPadu
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      // CSS rozměry odpovídající logickým pixelům viewportu
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const imageLayer = document.createElement("div");
      imageLayer.className = "pdf-image-layer";
      this.imageLayer = imageLayer;

      const ctx = canvas.getContext("2d");
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

      pageContainer.appendChild(canvas);
      pageContainer.appendChild(imageLayer);
      container.appendChild(pageContainer);

      const renderContext = {
        canvasContext: ctx,
        transform: transform,
        viewport: viewport
      };

      this.currentRenderTask = page.render(renderContext);
      await this.currentRenderTask.promise;
      this.currentRenderTask = null;

      // Inteligentní extrakce a označení obrázků pro zachování přirozených barev ve smart dark mode
      try {
        await this._extractAndTagImages(page, viewport, canvas, dpr, imageLayer);
      } catch (imgErr) {
        console.warn("[PDFLoader] Chyba při extrakci obrázků pro smart dark mode:", imgErr);
      }
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
   * Extrahuje vložené obrázky a ilustrace z PDF pro inteligentní dark mode (Smart Dark Mode),
   * aby nedocházelo k inverzi barev u fotografií, grafů a ilustrací.
   */
  async _extractAndTagImages(page, viewport, sourceCanvas, dpr, imageLayer) {
    if (!page || !imageLayer || !sourceCanvas) return;

    const opList = await page.getOperatorList();
    if (!opList || !opList.fnArray || !opList.argsArray) return;

    const OPS = window.pdfjsLib?.OPS || {};
    const OP_SAVE = OPS.save ?? 1;
    const OP_RESTORE = OPS.restore ?? 2;
    const OP_TRANSFORM = OPS.transform ?? 3;
    const OP_PAINT_IMAGE = OPS.paintImageXObject ?? 85;
    const OP_PAINT_INLINE = OPS.paintInlineImageXObject ?? 82;
    const OP_PAINT_MASK = OPS.paintImageMaskXObject ?? 83;
    const OP_PAINT_REPEAT = OPS.paintImageXObjectRepeat ?? 86;

    let ctm = [1, 0, 0, 1, 0, 0];
    const ctmStack = [];
    const seenBoxes = new Set();

    const multiplyTransform = (m1, m2) => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];

    const fnArray = opList.fnArray;
    const argsArray = opList.argsArray;
    const len = fnArray.length;

    for (let i = 0; i < len; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];

      if (fn === OP_SAVE) {
        ctmStack.push([...ctm]);
      } else if (fn === OP_RESTORE) {
        ctm = ctmStack.length > 0 ? ctmStack.pop() : [1, 0, 0, 1, 0, 0];
      } else if (fn === OP_TRANSFORM) {
        if (args && args.length >= 6) {
          ctm = multiplyTransform(ctm, args);
        }
      } else if (
        fn === OP_PAINT_IMAGE ||
        fn === OP_PAINT_INLINE ||
        fn === OP_PAINT_MASK ||
        fn === OP_PAINT_REPEAT
      ) {
        // V PDF odpovídá plocha obrázku jednotkovému čtverci [0, 0] až [1, 1].
        // Převod 4 rohů jednotkového čtverce transformovaného CTM maticí na body viewportu:
        const p0 = viewport.convertToViewportPoint(ctm[4], ctm[5]);
        const p1 = viewport.convertToViewportPoint(ctm[0] + ctm[4], ctm[1] + ctm[5]);
        const p2 = viewport.convertToViewportPoint(ctm[2] + ctm[4], ctm[3] + ctm[5]);
        const p3 = viewport.convertToViewportPoint(ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]);

        const minVx = Math.min(p0[0], p1[0], p2[0], p3[0]);
        const maxVx = Math.max(p0[0], p1[0], p2[0], p3[0]);
        const minVy = Math.min(p0[1], p1[1], p2[1], p3[1]);
        const maxVy = Math.max(p0[1], p1[1], p2[1], p3[1]);

        const vWidth = maxVx - minVx;
        const vHeight = maxVy - minVy;

        // Ignorujeme neviditelné nebo miniaturní dekorativní body (pattern masky apod.)
        if (vWidth < 8 || vHeight < 8) continue;
        if (maxVx <= 0 || maxVy <= 0 || minVx >= viewport.width || minVy >= viewport.height) continue;

        // Klíč pro eliminaci duplicitních překryvů
        const boxKey = `${Math.round(minVx)},${Math.round(minVy)},${Math.round(vWidth)},${Math.round(vHeight)}`;
        if (seenBoxes.has(boxKey)) continue;
        seenBoxes.add(boxKey);

        // Fyzické souřadnice pro oříznutí z hlavního canvasu
        const sx = Math.max(0, Math.floor(minVx * dpr));
        const sy = Math.max(0, Math.floor(minVy * dpr));
        const maxSx = Math.min(sourceCanvas.width, Math.ceil(maxVx * dpr));
        const maxSy = Math.min(sourceCanvas.height, Math.ceil(maxVy * dpr));
        const sw = maxSx - sx;
        const sh = maxSy - sy;

        if (sw <= 0 || sh <= 0) continue;

        // Vytvoření offscreen canvasu a nakreslení výřezu obrázku
        const offCanvas = document.createElement("canvas");
        offCanvas.width = sw;
        offCanvas.height = sh;
        const offCtx = offCanvas.getContext("2d");
        if (!offCtx) continue;

        // Aplikujeme pre-inverzi na data obrázku.
        // Když CSS dark mode aplikuje pravidlo:
        // .theme-dark .pdf-image-layer img, .theme-dark .pdf-page-container .re-inverted-image { filter: invert(1) hue-rotate(180deg) !important; }
        // dojde k re-inverzi zpět na 100% původní přirozené barvy bez negativních artefaktů!
        let filterApplied = false;
        try {
          offCtx.filter = "invert(1) hue-rotate(180deg)";
          offCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
          if (offCtx.filter && offCtx.filter !== "none") {
            filterApplied = true;
          }
        } catch (e) {}

        if (!filterApplied) {
          // Fallback pro prohlížeče bez podpory context.filter
          try {
            offCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
            const imgData = offCtx.getImageData(0, 0, sw, sh);
            const d = imgData.data;
            for (let p = 0; p < d.length; p += 4) {
              d[p] = 255 - d[p];
              d[p + 1] = 255 - d[p + 1];
              d[p + 2] = 255 - d[p + 2];
            }
            offCtx.putImageData(imgData, 0, 0);
          } catch (e) {}
        }

        const imgEl = document.createElement("img");
        imgEl.className = "re-inverted-image natural-pdf-image";
        imgEl.alt = "";
        imgEl.src = offCanvas.toDataURL("image/png");
        imgEl.style.position = "absolute";
        imgEl.style.left = `${(sx / dpr)}px`;
        imgEl.style.top = `${(sy / dpr)}px`;
        imgEl.style.width = `${(sw / dpr)}px`;
        imgEl.style.height = `${(sh / dpr)}px`;
        imgEl.style.pointerEvents = "none";

        imageLayer.appendChild(imgEl);
      }
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
    this.pageContainer = null;
    this.imageLayer = null;
  }
}
