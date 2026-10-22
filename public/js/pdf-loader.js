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

    // Kontinuální vertikální scrollování a virtualizace
    this.readingMode = "horizontal";
    this.pageContainers = new Map();
    this.renderedPages = new Set();
    this.renderingPages = new Set();
    this.intersectionObserver = null;
    this._boundOnScroll = null;
    this._boundOnResize = null;

    // Režim zobrazení sloupců (Two-Page Spread pro PDF)
    this.columnsMode = this.app?.settings?.columnsMode || "auto";
    this.spreadContainer = null;
    this.pageSlots = [];
    this.canvases = [];
    this.currentRenderTasks = [];

    // TextLayer a přesné počítání slov pro pravítko a statistiky
    this.pageWordCounts = new Map();
    this.currentTextLayerTasks = [];
    this.currentTextLayerTask = null;
    this.textLayer = null;
    this.textLayers = [];
    this.isImageOnlyPdf = false;
  }

  setColumnsMode(mode) {
    this.columnsMode = mode || "auto";
  }

  setSpreadMode(mode) {
    this.setColumnsMode(mode);
  }

  isSpreadActive() {
    if (this.isVerticalMode()) return false;
    if (window.innerWidth < 768) return false;
    if (this.columnsMode === "2") return true;
    if (this.columnsMode === "1") return false;
    return window.innerWidth >= 920 && window.innerWidth > window.innerHeight;
  }

  isDoubleSpreadActive() {
    return this.isSpreadActive();
  }

  getSpreadPageLabel(pageNumber = this.currentPage) {
    const p = Math.max(1, Math.min(this.numPages || 1, pageNumber || 1));
    if (!this.isSpreadActive() || (this.numPages && this.numPages <= 1)) {
      return String(p);
    }
    let leftPage, rightPage;
    if (p % 2 === 0) {
      leftPage = p;
      rightPage = Math.min(this.numPages || 1, p + 1);
    } else {
      leftPage = Math.max(1, p - 1);
      rightPage = p;
    }
    if (rightPage > leftPage && rightPage <= (this.numPages || 1)) {
      return `${leftPage}–${rightPage}`;
    }
    return String(leftPage);
  }

  updatePageCounterBadge() {
    const pageStr = this.getSpreadPageLabel();
    const total = this.numPages || 1;
    const text = `${pageStr} z ${total}`;
    const elFooter = document.getElementById("footer-book-pages");
    if (elFooter) elFooter.textContent = text;
    const elCounter = document.getElementById("page-counter");
    if (elCounter) elCounter.textContent = text;
  }

  isVerticalMode() {
    return this.readingMode === "vertical" || this.app?.isVerticalReadingMode?.() || document.body.classList.contains("mode-vertical");
  }

  getScrollContainer() {
    return this.app?.dom?.pagedViewport || document.getElementById("paged-viewport") || this.container?.parentElement || window;
  }

  _destroyCanvas(canvas) {
    if (!canvas) return;
    try {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch (e) {}
    canvas.width = 0;
    canvas.height = 0;
    if (typeof canvas.remove === "function") {
      canvas.remove();
    }
  }

  _cleanupContainerCanvases(container) {
    if (!container) return;
    const canvases = container.querySelectorAll("canvas");
    for (const canvas of canvases) {
      this._destroyCanvas(canvas);
    }
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
  async load(arrayBuffer, initialPage = 1) {
    if (!window.pdfjsLib) {
      throw new Error("Knihovna PDF.js není načtena.");
    }

    // Nastavení cesty k web workeru
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    // Zrušení předchozího renderování, pokud běželo
    this._teardownVertical();
    if (this.currentRenderTask) {
      try {
        this.currentRenderTask.cancel();
      } catch (e) {
        // Ignorovat zrušení
      }
      this.currentRenderTask = null;
    }
    if (this.currentRenderTasks && this.currentRenderTasks.length > 0) {
      for (const task of this.currentRenderTasks) {
        try {
          task.cancel();
        } catch (e) {}
      }
      this.currentRenderTasks = [];
    }
    if (this.currentTextLayerTask) {
      try {
        this.currentTextLayerTask.cancel();
      } catch (e) {}
      this.currentTextLayerTask = null;
    }
    if (this.currentTextLayerTasks && this.currentTextLayerTasks.length > 0) {
      for (const task of this.currentTextLayerTasks) {
        try {
          task.cancel();
        } catch (e) {}
      }
      this.currentTextLayerTasks = [];
    }
    this.textLayers = [];
    this.textLayer = null;
    this.pageWordCounts.clear();
    if (this.canvases && this.canvases.length > 0) {
      for (const c of this.canvases) this._destroyCanvas(c);
      this.canvases = [];
    }
    if (this.canvas) {
      this._destroyCanvas(this.canvas);
      this.canvas = null;
    }
    if (this.container) {
      this._cleanupContainerCanvases(this.container);
      this.container.innerHTML = "";
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
    const targetPage = Math.max(1, Math.min(this.numPages, initialPage || 1));
    this.currentPage = targetPage;

    // Detekce obrazového / skenovaného PDF bez textové vrstvy
    this.isImageOnlyPdf = await this.detectImageOnlyPdf();
    if (this.app && typeof this.app.setImageOnlyPdf === "function") {
      this.app.setImageOnlyPdf(this.isImageOnlyPdf);
    }

    // Vykreslit obsah podle aktuálního režimu čtení (vodorovně vs svisle)
    if (this.isVerticalMode()) {
      await this.renderAllPagesVertical(targetPage);
    } else {
      await this.renderPage(targetPage);
    }

    return this;
  }

  /**
   * Vykreslí zadanou stranu PDF do elementu <canvas>
   * V horizontálním režimu při aktivním isSpreadActive() vykreslí dvoustranu (Two-Page Spread)
   */
  async renderPage(pageNumber) {
    if (!this.pdfDoc || pageNumber < 1 || pageNumber > this.numPages) return;

    if (this.isVerticalMode()) {
      await this.goToPage(pageNumber);
      return;
    }

    if (this.isRendering) {
      this._renderQueuePage = pageNumber;
      if (this.currentRenderTask) {
        try {
          this.currentRenderTask.cancel();
        } catch (e) {}
        this.currentRenderTask = null;
      }
      if (this.currentRenderTasks && this.currentRenderTasks.length > 0) {
        for (const task of this.currentRenderTasks) {
          try {
            task.cancel();
          } catch (e) {}
        }
        this.currentRenderTasks = [];
      }
      if (this.currentTextLayerTask) {
        try {
          this.currentTextLayerTask.cancel();
        } catch (e) {}
        this.currentTextLayerTask = null;
      }
      if (this.currentTextLayerTasks && this.currentTextLayerTasks.length > 0) {
        for (const task of this.currentTextLayerTasks) {
          try {
            task.cancel();
          } catch (e) {}
        }
        this.currentTextLayerTasks = [];
      }
      return;
    }

    this.isRendering = true;

    try {
      const container = this.container || document.getElementById("reader-content");
      if (!container) return;

      if (this.canvases && this.canvases.length > 0) {
        for (const c of this.canvases) this._destroyCanvas(c);
        this.canvases = [];
      }
      if (this.canvas) {
        this._destroyCanvas(this.canvas);
        this.canvas = null;
      }
      this._cleanupContainerCanvases(container);

      const dpr = window.devicePixelRatio || 1;

      if (this.isSpreadActive()) {
        // --- Režim dvoustrany (Two-Page Spread) ---
        let leftPage, rightPage;
        if (pageNumber % 2 === 0) {
          leftPage = pageNumber;
          rightPage = Math.min(this.numPages, pageNumber + 1);
        } else {
          leftPage = Math.max(1, pageNumber - 1);
          rightPage = pageNumber;
        }

        const hasRight = rightPage > leftPage && rightPage <= this.numPages;
        this.currentPage = leftPage;

        const pagesToLoad = hasRight ? [leftPage, rightPage] : [leftPage];
        let pages = [];
        try {
          pages = await Promise.all(pagesToLoad.map(num => this.pdfDoc.getPage(num)));

          const vpEl = document.getElementById("paged-viewport");
          const maxSlotW = hasRight ? Math.floor((window.innerWidth - 64) / 2) : Math.floor(window.innerWidth - 64);
          const availVpH = vpEl && vpEl.clientHeight > 100 ? (vpEl.clientHeight - 16) : (window.innerHeight - 32);
          const maxSlotH = Math.min(window.innerHeight - 32, availVpH);

          const unscaledViewports = pages.map(p => {
            const uv = p.getViewport({ scale: 1 });
            const rawW = (p.rotate === 90 || p.rotate === 270)
              ? (p.view?.[3] || uv.width)
              : (p.view?.[2] || uv.width);
            const rawH = (p.rotate === 90 || p.rotate === 270)
              ? (p.view?.[2] || uv.height)
              : (p.view?.[3] || uv.height);
            return {
              width: uv.width || rawW,
              height: uv.height || rawH,
              page: p
            };
          });

          const scales = unscaledViewports.map(uv => {
            const sX = maxSlotW / uv.width;
            const sY = maxSlotH / uv.height;
            return Math.min(sX, sY);
          });
          const uniformScale = Math.min(...scales);

          this._cleanupContainerCanvases(container);
          container.innerHTML = "";

          const spreadContainer = document.createElement("div");
          spreadContainer.className = "pdf-spread-container";
          this.spreadContainer = spreadContainer;

          const pageSlots = [];
          const canvases = [];
          const imageLayers = [];
          const renderTasks = [];

          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const pageNum = pagesToLoad[i];
            const viewport = p.getViewport({ scale: uniformScale });
            const floorW = Math.floor(viewport.width);
            const floorH = Math.floor(viewport.height);

            const slot = document.createElement("div");
            slot.className = "pdf-page-slot pdf-page-container";
            slot.dataset.pageNumber = String(pageNum);
            slot.style.width = `${floorW}px`;
            slot.style.height = `${floorH}px`;
            slot.style.position = "relative";
            slot.style.display = "flex";
            slot.style.justifyContent = "center";
            slot.style.alignItems = "center";

            const canvas = document.createElement("canvas");
            canvas.className = "pdf-page-canvas";
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = `${floorW}px`;
            canvas.style.height = `${floorH}px`;
            canvas.style.display = "block";

            const imageLayer = document.createElement("div");
            imageLayer.className = "pdf-image-layer";

            const ctx = canvas.getContext("2d");
            const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

            slot.appendChild(canvas);
            slot.appendChild(imageLayer);
            spreadContainer.appendChild(slot);

            pageSlots.push(slot);
            canvases.push(canvas);
            imageLayers.push(imageLayer);

            const rTask = p.render({
              canvasContext: ctx,
              transform: transform,
              viewport: viewport
            });
            const tTask = this._renderTextLayerForPage(p, viewport, slot, pageNum);
            renderTasks.push({ rTask, tTask, page: p, viewport, canvas, imageLayer });
          }

          container.appendChild(spreadContainer);

          this.currentRenderTasks = renderTasks.map(t => t.rTask);
          this.currentRenderTask = this.currentRenderTasks[0] || null;
          this.canvas = canvases[0] || null;
          this.pageContainer = pageSlots[0] || null;
          this.imageLayer = imageLayers[0] || null;
          this.pageSlots = pageSlots;
          this.canvases = canvases;

          await Promise.all([
            Promise.all(renderTasks.map(t => t.rTask.promise)),
            Promise.all(renderTasks.map(t => t.tTask))
          ]);
          this.currentRenderTasks = [];
          this.currentRenderTask = null;
          this.currentTextLayerTasks = [];
          this.currentTextLayerTask = null;

          await Promise.all(renderTasks.map(t =>
            this._extractAndTagImages(t.page, t.viewport, t.canvas, dpr, t.imageLayer).catch(imgErr => {
              console.warn("[PDFLoader] Chyba při extrakci obrázků pro smart dark mode:", imgErr);
            })
          ));
        } finally {
          for (const p of pages) {
            try {
              if (typeof p?.cleanup === "function") p.cleanup();
            } catch (e) {}
          }
        }
      } else {
        // --- Režim jedné strany (Single-Page Canvas Rendering) ---
        this.currentPage = pageNumber;
        let page = null;
        try {
          page = await this.pdfDoc.getPage(pageNumber);

          const targetWidth = window.innerWidth;
          const targetHeight = window.innerHeight;

          const unscaledViewport = page.getViewport({ scale: 1 });
          const rawWidth = (page.rotate === 90 || page.rotate === 270)
            ? (page.view?.[3] || unscaledViewport.width)
            : (page.view?.[2] || unscaledViewport.width);
          const rawHeight = (page.rotate === 90 || page.rotate === 270)
            ? (page.view?.[2] || unscaledViewport.height)
            : (page.view?.[3] || unscaledViewport.height);
          const pageWidth = unscaledViewport.width || rawWidth || targetWidth;
          const pageHeight = unscaledViewport.height || rawHeight || targetHeight;

          const vpEl = document.getElementById("paged-viewport");
          const availH = vpEl && vpEl.clientHeight > 100 ? (vpEl.clientHeight - 16) : targetHeight;

          const scaleX = (targetWidth - 32) / pageWidth;
          const scaleY = availH / pageHeight;
          const scale = Math.min(scaleX, scaleY);

          const viewport = page.getViewport({ scale });
          const floorW = Math.floor(viewport.width);
          const floorH = Math.floor(viewport.height);

          this._cleanupContainerCanvases(container);
          container.innerHTML = "";

          const pageContainer = document.createElement("div");
          pageContainer.className = "pdf-page-container";
          this.pageContainer = pageContainer;

          pageContainer.style.position = "relative";
          pageContainer.style.width = `${floorW}px`;
          pageContainer.style.height = `${floorH}px`;
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
          canvas.style.display = "block";

          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${floorW}px`;
          canvas.style.height = `${floorH}px`;

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
          const tTask = this._renderTextLayerForPage(page, viewport, pageContainer, pageNumber);
          await Promise.all([this.currentRenderTask.promise, tTask]);
          this.currentRenderTask = null;
          this.currentTextLayerTask = null;

          try {
            await this._extractAndTagImages(page, viewport, canvas, dpr, imageLayer);
          } catch (imgErr) {
            console.warn("[PDFLoader] Chyba při extrakci obrázků pro smart dark mode:", imgErr);
          }
        } finally {
          try {
            if (typeof page?.cleanup === "function") {
              page.cleanup();
            }
          } catch (e) {}
        }
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

    this.updatePageCounterBadge();

    // Provázání do globálního stavu aplikace LuminaReader
    if (this.app && typeof this.app.onPdfPageRendered === "function") {
      this.app.onPdfPageRendered(this.currentPage, this.numPages);
    }
    if (typeof this.onPageChanged === "function") {
      this.onPageChanged(this.currentPage, this.numPages);
    }
  }

  /**
   * Inicializuje kontinuální vertikální zobrazení všech stran dokumentu
   * s využitím IntersectionObserver pro líné vykreslování (virtualizaci)
   */
  async renderAllPagesVertical(initialPage = 1) {
    if (!this.pdfDoc || this.numPages < 1) return;

    this._teardownVertical();
    const container = this.container || document.getElementById("reader-content");
    if (!container) return;

    container.innerHTML = "";

    // 1. Zjištění výchozích rozměrů z první strany
    let defaultWidth = 600;
    let defaultHeight = 800;
    try {
      const p1 = await this.pdfDoc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1 });
      const rawWidth = (p1.rotate === 90 || p1.rotate === 270)
        ? (p1.view?.[3] || vp1.width)
        : (p1.view?.[2] || vp1.width);
      const rawHeight = (p1.rotate === 90 || p1.rotate === 270)
        ? (p1.view?.[2] || vp1.height)
        : (p1.view?.[3] || vp1.height);
      defaultWidth = vp1.width || rawWidth || 600;
      defaultHeight = vp1.height || rawHeight || 800;
    } catch (e) {}

    const sc = this.getScrollContainer();
    const clientW = sc?.clientWidth || window.innerWidth;
    const availW = clientW <= 820 ? clientW : Math.min(clientW - 48, 860);
    const scale = availW / defaultWidth;
    const estimatedW = Math.floor(defaultWidth * scale);
    const estimatedH = Math.floor(defaultHeight * scale);

    // 2. Vytvoření placeholderů pro všechny strany dokumentu
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.numPages; i++) {
      const pageEl = document.createElement("div");
      pageEl.className = "pdf-page-container";
      pageEl.dataset.pageNumber = String(i);
      pageEl.style.position = "relative";
      pageEl.style.width = `${estimatedW}px`;
      pageEl.style.height = `${estimatedH}px`;
      pageEl.style.minHeight = `${estimatedH}px`;
      pageEl.style.maxWidth = "100%";
      pageEl.style.margin = "0 auto 24px auto";
      pageEl.style.display = "flex";
      pageEl.style.justifyContent = "center";
      pageEl.style.alignItems = "center";
      pageEl.style.backgroundColor = "transparent";
      pageEl.style.boxShadow = "none";
      pageEl.style.border = "none";

      frag.appendChild(pageEl);
      this.pageContainers.set(i, pageEl);
    }
    container.appendChild(frag);

    // 3. Nastavení IntersectionObserver pro asynchronní viewport renderování
    const observerOptions = {
      root: sc === window ? null : sc,
      rootMargin: "800px 0px 800px 0px",
      threshold: 0
    };

    this.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNum = parseInt(entry.target.dataset.pageNumber, 10);
        if (entry.isIntersecting) {
          this._renderVerticalPage(pageNum, entry.target);
        } else {
          this._maybeUnloadVerticalPage(pageNum, entry.target);
        }
      }
    }, observerOptions);

    for (const [_, el] of this.pageContainers) {
      this.intersectionObserver.observe(el);
    }

    // 4. Detekce aktivní strany při scrollování
    let scrollRaf = null;
    this._boundOnScroll = () => {
      if (!this.isVerticalMode()) return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        this._updateCurrentPageFromScroll();
      });
    };
    if (sc) {
      sc.addEventListener("scroll", this._boundOnScroll, { passive: true });
    }

    // 5. Reakce na změnu velikosti okna
    let resizeTimer = null;
    this._boundOnResize = () => {
      if (!this.isVerticalMode()) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.renderAllPagesVertical(this.currentPage);
      }, 200);
    };
    window.addEventListener("resize", this._boundOnResize, { passive: true });

    // 6. Nastavení výchozí strany
    const targetPage = Math.max(1, Math.min(this.numPages, initialPage || this.currentPage || 1));
    this.currentPage = targetPage;

    if (targetPage > 1) {
      this.scrollToPage(targetPage, false);
    } else if (sc && sc.scrollTop > 0) {
      sc.scrollTop = 0;
    }

    // Ihned vykreslit cílovou stranu pro okamžitou odezvu
    const targetEl = this.pageContainers.get(targetPage);
    if (targetEl) {
      await this._renderVerticalPage(targetPage, targetEl);
    }

    if (this.app && typeof this.app.onPdfPageRendered === "function") {
      this.app.onPdfPageRendered(this.currentPage, this.numPages);
    }
    if (typeof this.onPageChanged === "function") {
      this.onPageChanged(this.currentPage, this.numPages);
    }
  }

  /**
   * Vykreslí jednotlivou stranu do svého placeholderu ve vertikálním režimu
   */
  async _renderVerticalPage(pageNumber, pageContainer) {
    if (!this.pdfDoc || pageNumber < 1 || pageNumber > this.numPages) return;
    if (this.renderedPages.has(pageNumber) || this.renderingPages.has(pageNumber)) return;

    this.renderingPages.add(pageNumber);
    let page = null;

    try {
      page = await this.pdfDoc.getPage(pageNumber);
      if (!this.renderingPages.has(pageNumber)) return;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const rawWidth = (page.rotate === 90 || page.rotate === 270)
        ? (page.view?.[3] || unscaledViewport.width)
        : (page.view?.[2] || unscaledViewport.width);
      const rawHeight = (page.rotate === 90 || page.rotate === 270)
        ? (page.view?.[2] || unscaledViewport.height)
        : (page.view?.[3] || unscaledViewport.height);
      const pageWidth = unscaledViewport.width || rawWidth || 600;
      const pageHeight = unscaledViewport.height || rawHeight || 800;

      const sc = this.getScrollContainer();
      const clientW = sc?.clientWidth || window.innerWidth;
      const availW = clientW <= 820 ? clientW : Math.min(clientW - 48, 860);
      const scale = availW / pageWidth;

      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      const floorW = Math.floor(viewport.width);
      const floorH = Math.floor(viewport.height);

      this._cleanupContainerCanvases(pageContainer);
      pageContainer.style.width = `${floorW}px`;
      pageContainer.style.height = `${floorH}px`;
      pageContainer.style.minHeight = `${floorH}px`;
      pageContainer.classList.remove("is-scanned-page");
      pageContainer.innerHTML = "";

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      canvas.style.boxShadow = "none";
      canvas.style.border = "none";
      canvas.style.borderRadius = "0";
      canvas.style.margin = "0";
      canvas.style.padding = "0";
      canvas.style.display = "block";

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${floorW}px`;
      canvas.style.height = `${floorH}px`;

      const imageLayer = document.createElement("div");
      imageLayer.className = "pdf-image-layer";

      const ctx = canvas.getContext("2d");
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

      pageContainer.appendChild(canvas);
      pageContainer.appendChild(imageLayer);

      const renderContext = {
        canvasContext: ctx,
        transform: transform,
        viewport: viewport
      };

      const renderTask = page.render(renderContext);
      const tTask = this._renderTextLayerForPage(page, viewport, pageContainer, pageNumber);
      await Promise.all([renderTask.promise, tTask]);

      // Smart dark mode zachování původních barev fotografií a ilustrací
      try {
        await this._extractAndTagImages(page, viewport, canvas, dpr, imageLayer);
      } catch (imgErr) {
        console.warn(`[PDFLoader] Chyba při extrakci obrázků pro stranu ${pageNumber}:`, imgErr);
      }

      this.renderedPages.add(pageNumber);

      if (pageNumber === this.currentPage) {
        this.canvas = canvas;
        this.pageContainer = pageContainer;
        this.imageLayer = imageLayer;
      }
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.error(`[PDFLoader] Chyba při renderování strany ${pageNumber}:`, err);
      }
    } finally {
      this.renderingPages.delete(pageNumber);
      try {
        if (typeof page?.cleanup === "function") {
          page.cleanup();
        }
      } catch (e) {}
    }
  }

  /**
   * Uvolní obsah canvasu u stran vzdálených daleko od viditelného zorného pole
   */
  _maybeUnloadVerticalPage(pageNumber, pageContainer) {
    if (!this.renderedPages.has(pageNumber)) return;
    const sc = this.getScrollContainer();
    if (!sc) return;

    const scRect = sc === window ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
    const cRect = pageContainer.getBoundingClientRect();

    // Pokud je strana dále než 1200px mimo zorné pole, uvolníme canvas pro úsporu paměti
    const dist = cRect.bottom < scRect.top ? (scRect.top - cRect.bottom) : (cRect.top > scRect.bottom ? (cRect.top - scRect.bottom) : 0);
    if (dist > 1200) {
      this._cleanupContainerCanvases(pageContainer);
      pageContainer.innerHTML = "";
      this.renderedPages.delete(pageNumber);
    }
  }

  /**
   * Plynule odscrollyje na požadovanou stranu
   */
  scrollToPage(pageNumber, smooth = true) {
    const targetEl = this.pageContainers?.get(pageNumber);
    if (!targetEl) return;

    const sc = this.getScrollContainer();
    if (!sc) return;

    if (sc === window) {
      const elRect = targetEl.getBoundingClientRect();
      window.scrollBy({ top: elRect.top, behavior: smooth ? "smooth" : "auto" });
    } else {
      const scRect = sc.getBoundingClientRect();
      const elRect = targetEl.getBoundingClientRect();
      const targetScrollTop = sc.scrollTop + (elRect.top - scRect.top);
      sc.scrollTo({ top: targetScrollTop, behavior: smooth ? "smooth" : "auto" });
    }
  }

  /**
   * Aktualizuje číslo aktuální strany podle její viditelnosti ve viewportu
   */
  _updateCurrentPageFromScroll() {
    if (!this.pageContainers || this.pageContainers.size === 0) return;

    const sc = this.getScrollContainer();
    if (!sc) return;

    const scRect = sc === window ? { top: 0, height: window.innerHeight } : sc.getBoundingClientRect();
    const midY = scRect.top + scRect.height / 2;

    let bestPage = this.currentPage;
    let minDistance = Infinity;

    for (const [pageNum, container] of this.pageContainers) {
      const rect = container.getBoundingClientRect();
      if (rect.top <= midY && rect.bottom >= midY) {
        bestPage = pageNum;
        break;
      }
      const dist = Math.abs((rect.top + rect.bottom) / 2 - midY);
      if (dist < minDistance) {
        minDistance = dist;
        bestPage = pageNum;
      }
    }

    if (bestPage !== this.currentPage) {
      this.currentPage = bestPage;
      const targetContainer = this.pageContainers.get(bestPage);
      if (targetContainer) {
        this.pageContainer = targetContainer;
        this.canvas = targetContainer.querySelector("canvas");
        this.imageLayer = targetContainer.querySelector(".pdf-image-layer");
      }

      if (this.app && typeof this.app.onPdfPageRendered === "function") {
        this.app.onPdfPageRendered(this.currentPage, this.numPages);
      }
      if (typeof this.onPageChanged === "function") {
        this.onPageChanged(this.currentPage, this.numPages);
      }
    }
  }

  /**
   * Přepne režim čtení mezi horizontálním a vertikálním se zachováním pozice
   */
  async switchReadingMode(mode) {
    if (this.readingMode === mode && ((mode === "vertical" && this.pageContainers.size > 0) || (mode !== "vertical" && !this.pageContainers.size))) {
      return;
    }
    this.readingMode = mode;
    const targetPage = this.currentPage || 1;
    this._teardownVertical();

    if (mode === "vertical") {
      await this.renderAllPagesVertical(targetPage);
    } else {
      await this.renderPage(targetPage);
    }
  }

  /**
   * Úklid vertikálních observerů a posluchačů
   */
  _teardownVertical() {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    const sc = this.getScrollContainer();
    if (sc && this._boundOnScroll) {
      sc.removeEventListener("scroll", this._boundOnScroll);
      this._boundOnScroll = null;
    }
    if (this._boundOnResize) {
      window.removeEventListener("resize", this._boundOnResize);
      this._boundOnResize = null;
    }
    for (const [_, el] of this.pageContainers) {
      this._cleanupContainerCanvases(el);
    }
    if (this.currentTextLayerTask) {
      try { this.currentTextLayerTask.cancel(); } catch (e) {}
      this.currentTextLayerTask = null;
    }
    if (this.currentTextLayerTasks && this.currentTextLayerTasks.length > 0) {
      for (const t of this.currentTextLayerTasks) {
        try { t.cancel(); } catch (e) {}
      }
      this.currentTextLayerTasks = [];
    }
    this.textLayers = [];
    this.textLayer = null;
    this.pageContainers.clear();
    this.renderedPages.clear();
    this.renderingPages.clear();
  }

  /**
   * Přechod na následující stranu (v režimu dvoustrany o +2 strany)
   */
  async nextPage() {
    if (!this.pdfDoc) return false;
    if (this.isSpreadActive()) {
      const step = (this.currentPage === 1) ? 1 : 2;
      const target = Math.min(this.numPages, this.currentPage + step);
      if (target > this.currentPage) {
        await this.goToPage(target, 1);
        return true;
      }
      return false;
    }
    if (this.currentPage < this.numPages) {
      await this.goToPage(this.currentPage + 1, 1);
      return true;
    }
    return false;
  }

  /**
   * Přechod na předchozí stranu (v režimu dvoustrany o -2 strany)
   */
  async prevPage() {
    if (!this.pdfDoc) return false;
    if (this.isSpreadActive()) {
      const step = (this.currentPage <= 3) ? (this.currentPage - 1) : 2;
      const target = Math.max(1, this.currentPage - step);
      if (target < this.currentPage) {
        await this.goToPage(target, -1);
        return true;
      }
      return false;
    }
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

    if (this.isVerticalMode()) {
      this.currentPage = target;
      this.scrollToPage(target, true);

      const targetEl = this.pageContainers?.get(target);
      if (targetEl && !this.renderedPages.has(target)) {
        await this._renderVerticalPage(target, targetEl);
      }

      if (this.app && typeof this.app.onPdfPageRendered === "function") {
        this.app.onPdfPageRendered(this.currentPage, this.numPages);
      }
      if (typeof this.onPageChanged === "function") {
        this.onPageChanged(this.currentPage, this.numPages);
      }
      if (this.app?.ruler && this.app.ruler.enabled) {
        this.app.ruler.onPageChange(dir, true, true);
      }
      return;
    }

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

        // Rozpoznání celostránkového skenu (skenovaný / rastrový dokument vs. vložená ilustrace):
        // Pokud detekovaný obrázek pokrývá téměř celou stranu, jde o naskenovanou stránku dokumentu.
        // V takovém případě obrázek neizolujeme do .pdf-image-layer (aby se neneutralizoval CSS dark mode filtr)
        // a označíme kontejner třídou 'is-scanned-page'.
        const isFullPageScan = (vWidth / viewport.width > 0.85) && (vHeight / viewport.height > 0.85);
        if (isFullPageScan) {
          const pageParent = imageLayer.parentElement || imageLayer.closest(".pdf-page-container");
          if (pageParent) {
            pageParent.classList.add("is-scanned-page");
          }
          if (sourceCanvas) {
            sourceCanvas.classList.add("is-scanned-page");
          }
          continue;
        }

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
        if (!offCtx) {
          this._destroyCanvas(offCanvas);
          continue;
        }

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
        this._destroyCanvas(offCanvas);
      }
    }
  }

  /**
   * Úklid alokovaných prostředků a zrušení renderovacích úloh
   */
  destroy() {
    this._teardownVertical();
    if (this.currentRenderTask) {
      try {
        this.currentRenderTask.cancel();
      } catch (e) {}
      this.currentRenderTask = null;
    }
    if (this.currentRenderTasks && this.currentRenderTasks.length > 0) {
      for (const task of this.currentRenderTasks) {
        try {
          task.cancel();
        } catch (e) {}
      }
      this.currentRenderTasks = [];
    }
    if (this.currentTextLayerTask) {
      try { this.currentTextLayerTask.cancel(); } catch (e) {}
      this.currentTextLayerTask = null;
    }
    if (this.currentTextLayerTasks && this.currentTextLayerTasks.length > 0) {
      for (const task of this.currentTextLayerTasks) {
        try { task.cancel(); } catch (e) {}
      }
      this.currentTextLayerTasks = [];
    }
    this.textLayers = [];
    this.textLayer = null;
    if (this.canvases && this.canvases.length > 0) {
      for (const c of this.canvases) this._destroyCanvas(c);
      this.canvases = [];
    }
    if (this.canvas) {
      this._destroyCanvas(this.canvas);
      this.canvas = null;
    }
    if (this.container) {
      this._cleanupContainerCanvases(this.container);
      this.container.innerHTML = "";
    }
    if (this.pdfDoc) {
      try {
        this.pdfDoc.destroy();
      } catch (e) {}
      this.pdfDoc = null;
    }
    this.pageContainer = null;
    this.pageSlots = [];
    this.spreadContainer = null;
    this.imageLayer = null;
  }

  /**
   * Vytvoří a vykreslí transparentní textovou vrstvu (.textLayer) přesně nad vykresleným canvasem
   * pomocí oficiální Mozilla PDF.js renderTextLayer API.
   * Zároveň zjišťuje a ukládá přesný počet slov dané strany.
   */
  async _renderTextLayerForPage(page, viewport, container, pageNum) {
    if (!page || !container) return null;
    try {
      const floorW = Math.floor(viewport.width);
      const floorH = Math.floor(viewport.height);

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "textLayer";
      textLayerDiv.style.position = "absolute";
      textLayerDiv.style.top = "0px";
      textLayerDiv.style.left = "0px";
      textLayerDiv.style.margin = "0";
      textLayerDiv.style.padding = "0";
      textLayerDiv.style.width = `${floorW}px`;
      textLayerDiv.style.height = `${floorH}px`;
      textLayerDiv.style.setProperty("--scale-factor", viewport.scale);

      const canvas = container.querySelector("canvas");
      if (canvas) {
        if (canvas.style.width) textLayerDiv.style.width = canvas.style.width;
        if (canvas.style.height) textLayerDiv.style.height = canvas.style.height;
        if (canvas.offsetTop !== undefined && canvas.offsetTop !== null) {
          textLayerDiv.style.top = `${canvas.offsetTop}px`;
        }
        if (canvas.offsetLeft !== undefined && canvas.offsetLeft !== null) {
          textLayerDiv.style.left = `${canvas.offsetLeft}px`;
        }
      }

      container.appendChild(textLayerDiv);
      if (pageNum === this.currentPage) {
        this.textLayer = textLayerDiv;
      }
      this.textLayers.push(textLayerDiv);

      const textContent = await page.getTextContent();
      let wordCount = 0;
      if (textContent && Array.isArray(textContent.items)) {
        for (const item of textContent.items) {
          if (item && item.str) {
            const matches = item.str.match(/[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/g);
            if (matches) wordCount += matches.length;
          }
        }
      }

      this.pageWordCounts.set(pageNum, wordCount);
      if (wordCount === 0) {
        container.classList.add("is-scanned-page");
      } else {
        container.classList.remove("is-scanned-page");
        if (this.isImageOnlyPdf) {
          this.isImageOnlyPdf = false;
          if (this.app && typeof this.app.setImageOnlyPdf === "function") {
            this.app.setImageOnlyPdf(false);
          }
        }
      }

      if (window.pdfjsLib && typeof window.pdfjsLib.renderTextLayer === "function") {
        const textTask = window.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport,
          textDivs: []
        });
        this.currentTextLayerTasks.push(textTask);
        this.currentTextLayerTask = textTask;
        await textTask.promise;
      }

      if (canvas) {
        const cRect = canvas.getBoundingClientRect();
        if (cRect && cRect.width > 0 && cRect.height > 0) {
          textLayerDiv.style.width = `${Math.round(cRect.width)}px`;
          textLayerDiv.style.height = `${Math.round(cRect.height)}px`;
          if (canvas.offsetTop !== undefined && canvas.offsetTop !== null) {
            textLayerDiv.style.top = `${canvas.offsetTop}px`;
          }
          if (canvas.offsetLeft !== undefined && canvas.offsetLeft !== null) {
            textLayerDiv.style.left = `${canvas.offsetLeft}px`;
          }
        }
      }

      return { textLayerDiv, wordCount };
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.warn(`[PDFLoader] Chyba při vytváření textové vrstvy pro stranu ${pageNum}:`, err);
      }
      return null;
    }
  }

  /**
   * Získá přesný počet slov pro danou stranu PDF
   */
  getWordsForPage(pageNumber) {
    return this.pageWordCounts.get(pageNumber) ?? 0;
  }

  /**
   * Získá přesný počet slov viditelných na aktuální obrazovce/sloupcích
   * V režimu dvoustrany sčítá slova obou otevřených stran.
   * U naskenovaného PDF bez textové vrstvy vrací 0.
   */
  getVisibleWords() {
    if (this.isSpreadActive()) {
      let p = this.currentPage;
      let leftPage, rightPage;
      if (p % 2 === 0) {
        leftPage = p;
        rightPage = Math.min(this.numPages, p + 1);
      } else {
        leftPage = Math.max(1, p - 1);
        rightPage = p;
      }
      const hasRight = rightPage > leftPage && rightPage <= this.numPages;
      const leftWords = this.getWordsForPage(leftPage);
      const rightWords = hasRight ? this.getWordsForPage(rightPage) : 0;
      return leftWords + rightWords;
    }

    if (this.isVerticalMode()) {
      return this.getWordsForPage(this.currentPage);
    }

    const words = this.pageWordCounts.get(this.currentPage);
    if (words !== undefined) return words;

    // Fallback: zjištění z DOM textové vrstvy
    const activeSlot = this.pageContainer || document.querySelector("#reader-content .pdf-page-container");
    const textLayer = activeSlot?.querySelector(".textLayer");
    if (textLayer) {
      const text = textLayer.textContent || "";
      const matches = text.match(/[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/g);
      return matches ? matches.length : 0;
    }
    return 0;
  }

  /**
   * Automatická detekce naskenovaného/obrazového PDF dokumentu bez textové vrstvy.
   * Prozkoumá výsledek page.getTextContent() na vzorku prvních stran (max 3–5 stran).
   * Pokud je textContent.items prázdný nebo neobsahuje žádné čitelné alfanumerické znaky,
   * označí dokument jako isImageOnlyPdf: true.
   */
  async detectImageOnlyPdf() {
    if (!this.pdfDoc || this.numPages <= 0) return false;
    try {
      const sampleCount = Math.min(this.numPages, 3);
      for (let pNum = 1; pNum <= sampleCount; pNum++) {
        const page = await this.pdfDoc.getPage(pNum);
        const textContent = await page.getTextContent();
        if (textContent && Array.isArray(textContent.items) && textContent.items.length > 0) {
          for (const item of textContent.items) {
            if (item && item.str && /[\p{L}\p{N}]/u.test(item.str)) {
              if (typeof page.cleanup === "function") page.cleanup();
              return false; // Nalezen čitelný text -> běžné textové PDF
            }
          }
        }
        if (typeof page.cleanup === "function") page.cleanup();
      }
      return true; // Všechny vzorkované strany jsou bez čitelného textu -> sken / image-only PDF
    } catch (err) {
      console.warn("[PDFLoader] Chyba při detekci image-only PDF:", err);
      return false;
    }
  }

  getIsImageOnlyPdf() {
    return !!this.isImageOnlyPdf;
  }

  /**
   * Asynchronní výpočet celkového počtu slov dokumentu na pozadí.
   * Nepřetěžuje hlavní vlákno (dávkování po 5 stranách).
   */
  async calculateTotalWordsInBackground(bookId) {
    if (!this.pdfDoc || this.numPages <= 0) return;
    try {
      let totalWords = 0;
      let hasAnyText = false;
      const num = this.numPages;

      for (let pNum = 1; pNum <= num; pNum++) {
        if (!this.pdfDoc) return;

        let words = this.pageWordCounts.get(pNum);
        if (words === undefined) {
          try {
            const page = await this.pdfDoc.getPage(pNum);
            const content = await page.getTextContent();
            words = 0;
            if (content && Array.isArray(content.items)) {
              for (const item of content.items) {
                if (item?.str) {
                  const m = item.str.match(/[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/g);
                  if (m) words += m.length;
                }
              }
            }
            this.pageWordCounts.set(pNum, words);
            if (typeof page.cleanup === "function") page.cleanup();
          } catch (e) {
            words = 0;
          }
        }

        if (words > 0) {
          hasAnyText = true;
          if (this.isImageOnlyPdf) {
            this.isImageOnlyPdf = false;
            if (this.app && typeof this.app.setImageOnlyPdf === "function") {
              this.app.setImageOnlyPdf(false);
            }
          }
        }
        totalWords += words;

        if (pNum % 5 === 0) {
          await new Promise(r => setTimeout(r, 10));
        }
      }

      if (!hasAnyText && !this.isImageOnlyPdf) {
        this.isImageOnlyPdf = true;
        if (this.app && typeof this.app.setImageOnlyPdf === "function") {
          this.app.setImageOnlyPdf(true);
        }
      }

      if (this.app?.currentBook && this.app.currentBook.id === bookId) {
        this.app.currentBook.totalWords = hasAnyText ? totalWords : 0;
        this.app.currentBook.isScanned = !hasAnyText;
        this.app.currentBook.isImageOnlyPdf = !hasAnyText;
        if (this.app.currentBook.isScanned) {
          document.body.classList.add("is-scanned-pdf");
        }
        try {
          const { storage } = await import("./storage.js");
          const storedBook = await storage.getBook(bookId);
          if (storedBook) {
            storedBook.totalWords = this.app.currentBook.totalWords;
            storedBook.isScanned = this.app.currentBook.isScanned;
            storedBook.isImageOnlyPdf = this.app.currentBook.isImageOnlyPdf;
            await storage.saveBook(storedBook);
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn("[PDFLoader] Chyba při výpočtu celkového počtu slov:", err);
    }
  }
}

