/**
 * app.js - Hlavní řídicí logika aplikace LuminaReader.
 * Spojuje knihovnu, EPUB parser, čtečku, měřič rychlosti (tracker),
 * pravítko (ruler) a statistické dashboardy do jednoho celku.
 */

import { storage } from "./storage.js";
import { EpubParser } from "./epub-parser.js";
import { tracker, ReadingTracker } from "./tracker.js";
import { ReadingRuler } from "./ruler.js";
import { StatsCharts } from "./charts.js";

class LuminaApp {
  constructor() {
    this.currentBook = null;
    this.currentParser = null;
    this.currentChapterIndex = 0;
    this.currentPageIndex = 0;
    this.totalPagesInChapter = 1;
    this.pageGap = 50;
    this.settings = storage.getSettings();
    this.ruler = null;

    // Ochrana proti přeskakování stránek při gestech (vždy jen 1 strana na jedno gesto)
    this.lastPageTurnTime = 0;
    this.PAGE_TURN_COOLDOWN = 60; // ms
    this.saveProgressTimer = null;

    // Ochrana proti syntetickým gestům po přechodu strany na iPadu
    this.isNavigatingPage = false;
    this.navigatingPageTimer = null;

    // DOM elementy
    this.dom = {};
  }

  async init() {
    document.body.classList.remove("in-reader-view");
    this.cacheDom();
    this.initRuler();
    this.applySettings();
    this.bindEvents();
    this.initScrubber();
    this.bindKeyboardShortcuts();

    // Načíst knihy z IndexedDB
    const books = await storage.getAllBooks();
    if (books.length === 0) {
      // Automaticky nabídnout nebo nahrát vzorovou knihu
      await this.loadBundledSampleBook();
    } else {
      this.renderLibrary();
    }

    // Zkontrolovat naposledy čtenou knihu
    const lastBookId = storage.getLastActiveBookId();
    if (lastBookId && books.some(b => b.id === lastBookId)) {
      // Zůstaneme v knihovně, ale zvýrazníme ji, nebo otevřeme
    }
  }

  cacheDom() {
    this.dom = {
      // Pohledy
      viewLibrary: document.getElementById("view-library"),
      viewReader: document.getElementById("view-reader"),

      // Knihovna
      bookGrid: document.getElementById("book-grid"),
      emptyLibrary: document.getElementById("empty-library"),
      fileInput: document.getElementById("file-input"),
      dropZone: document.getElementById("drop-zone"),
      btnUpload: document.getElementById("btn-upload"),
      btnLoadSample: document.getElementById("btn-load-sample"),
      btnToggleSettingsLib: document.getElementById("btn-toggle-settings-lib"),
      btnToggleStatsLib: document.getElementById("btn-toggle-stats-lib"),
      drawerBackdrop: document.getElementById("drawer-backdrop"),

      // Stránkovaná čtečka
      readerHeader: document.getElementById("reader-header"),
      readerContent: document.getElementById("reader-content"),
      pagedViewport: document.getElementById("paged-viewport"),
      pagedStage: document.getElementById("paged-stage"),
      pagedFooterBar: document.getElementById("paged-footer-bar"),
      btnPagePrev: document.getElementById("btn-page-prev"),
      btnPageNext: document.getElementById("btn-page-next"),
      pageCounterText: document.getElementById("chapter-page-counter") || document.getElementById("page-counter-text"),
      chapterPageCounter: document.getElementById("chapter-page-counter"),
      bookPageCounter: document.getElementById("book-page-counter"),
      pagedChapterName: document.getElementById("paged-chapter-name") || document.getElementById("header-chapter-title"),
      zoneTouchPrev: document.getElementById("zone-touch-prev"),
      zoneTouchNext: document.getElementById("zone-touch-next"),
      bookTitleEl: document.getElementById("header-book-title"),
      chapterTitleEl: document.getElementById("header-chapter-title"),
      wpmBadge: document.getElementById("wpm-badge"),
      etrBadge: document.getElementById("etr-badge"),
      progressBar: document.getElementById("reading-progress-bar"),
      progressText: document.getElementById("reading-progress-text"),

      // Spodní lišta a posuvník (Scrubber)
      readingScrubber: document.getElementById("reading-scrubber"),
      scrubberTrack: document.getElementById("scrubber-track"),
      scrubberProgressFill: document.getElementById("scrubber-progress-fill"),
      scrubberThumb: document.getElementById("scrubber-thumb"),
      scrubberTooltip: document.getElementById("scrubber-tooltip"),
      scrubberChapterTicks: document.getElementById("scrubber-chapter-ticks"),
      footerTitleText: document.getElementById("footer-title-text"),
      footerEtrText: document.getElementById("footer-etr-text"),
      footerEtrSeparator: document.getElementById("footer-etr-separator"),
      
      // Navigace ve čtečce
      btnBackToLibrary: document.getElementById("btn-back-library"),
      btnToggleToc: document.getElementById("btn-toggle-toc"),
      btnToggleSettings: document.getElementById("btn-toggle-settings"),
      btnToggleStats: document.getElementById("btn-toggle-stats"),
      btnToggleRuler: document.getElementById("btn-toggle-ruler"),

      // Postranní panely a modály
      tocDrawer: document.getElementById("toc-drawer"),
      tocList: document.getElementById("toc-list"),
      btnCloseToc: document.getElementById("btn-close-toc"),
      settingsDrawer: document.getElementById("settings-drawer"),
      btnCloseSettings: document.getElementById("btn-close-settings"),
      statsModal: document.getElementById("stats-modal"),
      btnCloseStats: document.getElementById("btn-close-stats"),

      // Statistiky elementy
      statTotalTime: document.getElementById("stat-total-time"),
      statAvgWpm: document.getElementById("stat-avg-wpm"),
      statTotalWords: document.getElementById("stat-total-words"),
      statStreak: document.getElementById("stat-streak"),
      dailyChartContainer: document.getElementById("daily-chart-container"),
      wpmChartContainer: document.getElementById("wpm-chart-container"),
      btnExportData: document.getElementById("btn-export-data"),

      // Nastavení elementy
      themeSelects: document.querySelectorAll("[data-theme]"),
      fontSelects: document.querySelectorAll("[data-font]"),
      sliderFontSize: document.getElementById("slider-font-size"),
      valFontSize: document.getElementById("val-font-size"),
      sliderLineHeight: document.getElementById("slider-line-height"),
      valLineHeight: document.getElementById("val-line-height"),
      sliderContentWidth: document.getElementById("slider-content-width"),
      valContentWidth: document.getElementById("val-content-width"),
      btnAlignLeft: document.getElementById("btn-align-left"),
      btnAlignJustify: document.getElementById("btn-align-justify"),

      // Pravítko nastavení
      rulerToggle: document.getElementById("ruler-toggle-setting"),
      rulerSnapSetting: document.getElementById("ruler-snap-setting"),
      rulerWordTrackingSetting: document.getElementById("ruler-word-tracking-setting"),
      rulerAutoHeightSetting: document.getElementById("ruler-auto-height-setting"),
      settingRulerHeightContainer: document.getElementById("setting-ruler-height-container"),
      rulerModeSelects: document.querySelectorAll("[data-ruler-mode]"),
      rulerColorSelects: document.querySelectorAll("[data-ruler-color]"),
      sliderRulerHeight: document.getElementById("slider-ruler-height"),
      valRulerHeight: document.getElementById("val-ruler-height"),
      sliderRulerOpacity: document.getElementById("slider-ruler-opacity"),
      valRulerOpacity: document.getElementById("val-ruler-opacity"),
      rulerFollowSelect: document.getElementById("ruler-follow-select"),

      // Rychlé nastavení pravítka v záhlaví (popover)
      rulerBtnGroup: document.getElementById("ruler-btn-group"),
      btnRulerQuickMenu: document.getElementById("btn-ruler-quick-menu"),
      rulerQuickPopover: document.getElementById("ruler-quick-popover"),
      popoverRulerToggle: document.getElementById("popover-ruler-toggle"),
      popoverModeLine: document.getElementById("popover-mode-line"),
      popoverModeWord: document.getElementById("popover-mode-word"),
      popoverStyleButtons: document.querySelectorAll("#ruler-quick-popover [data-ruler-style]"),
      popoverColorButtons: document.querySelectorAll("#ruler-quick-popover [data-ruler-color]"),
      popoverRulerSnapToggle: document.getElementById("popover-ruler-snap-toggle"),
      popoverRulerAutoHeightToggle: document.getElementById("popover-ruler-auto-height-toggle"),
      popoverSettingRulerHeightContainer: document.getElementById("popover-setting-ruler-height-container"),
      popoverSliderRulerHeight: document.getElementById("popover-slider-ruler-height"),
      popoverValRulerHeight: document.getElementById("popover-val-ruler-height"),
      popoverSliderRulerOpacity: document.getElementById("popover-slider-ruler-opacity"),
      popoverValRulerOpacity: document.getElementById("popover-val-ruler-opacity"),
      popoverRulerFollowSelect: document.getElementById("popover-ruler-follow-select"),

      settingShowFooter: document.getElementById("setting-show-footer"),

      // Vyhledávání v knize
      btnToggleSearch: document.getElementById("btn-toggle-search"),
      searchDrawer: document.getElementById("search-drawer"),
      btnCloseSearch: document.getElementById("btn-close-search"),
      inputBookSearch: document.getElementById("input-book-search"),
      btnClearSearch: document.getElementById("btn-clear-search"),
      searchResultsInfo: document.getElementById("search-results-info"),
      searchResultsList: document.getElementById("search-results-list"),

      // Notifikace / Toast
      toast: document.getElementById("toast-notification")
    };
  }

  isInteractiveOrUiElement(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      'header, nav, footer, .paged-footer-bar, .reading-scrubber, .modal, .modal-content, .settings-modal, .stats-modal, .dropdown, button, input, select, textarea, [role="button"], [role="dialog"], [role="slider"], .drawer-panel, .drawer-backdrop, .modal-overlay, .ruler-quick-popover, .ruler-btn-group, #btn-toggle-ruler, #btn-ruler-quick-menu'
    );
  }

  isAnyModalOrMenuOpen() {
    if (this.dom.settingsDrawer?.classList.contains("open")) return true;
    if (this.dom.tocDrawer?.classList.contains("open")) return true;
    if (this.dom.searchDrawer?.classList.contains("open")) return true;
    if (this.dom.statsModal?.classList.contains("open")) return true;
    if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) return true;
    return false;
  }

  isUiOrOverlayEvent(e) {
    if (this.isAnyModalOrMenuOpen()) return true;
    const target = e?.target || (e?.touches && e.touches[0]?.target) || (e?.changedTouches && e.changedTouches[0]?.target);
    return this.isInteractiveOrUiElement(target);
  }

  initRuler() {
    this.ruler = new ReadingRuler(this.dom.pagedStage);

    // Automatický přechod na další/předchozí stránku při překročení hranice textu pravítkem
    this.ruler.onBoundary = (dir) => {
      if (this.isAnyModalOrMenuOpen()) return;
      if (dir > 0) {
        this.nextPage();
      } else if (dir < 0) {
        this.prevPage();
      }
    };

    // Horizontální přejetí (swipe) zachycené pravítkem
    this.ruler.onSwipe = (dir) => {
      if (this.isAnyModalOrMenuOpen()) return;
      if (dir > 0) {
        this.nextPage();
      } else if (dir < 0) {
        this.prevPage();
      }
    };

    const isInReader = !this.dom.viewReader.classList.contains("is-hidden");
    this.ruler.setEnabled(isInReader && this.settings.ruler.enabled);
    this.ruler.setMode(this.settings.ruler.mode);
    this.ruler.setColor(this.settings.ruler.color);
    this.ruler.setHeight(this.settings.ruler.height);
    this.ruler.setAutoHeight(true);
    this.ruler.setSnapToLines(true);
    this.ruler.setWordTracking(this.settings.ruler.wordTracking ?? false);
    this.ruler.setDimOpacity(this.settings.ruler.dimOpacity);
    this.ruler.setFollowMode(this.settings.ruler.followMode);

    this.updateRulerToggleButtonUI();
    this.updateTouchZonesUI();
  }

  setSwitchState(el, checked) {
    if (!el) return;
    const isChecked = !!checked;
    el.checked = isChecked;
    el.setAttribute("aria-checked", String(isChecked));
    el.classList.toggle("is-checked", isChecked);
    el.classList.toggle("active", isChecked);
  }

  applySettings() {
    const s = this.settings;
    document.documentElement.setAttribute("data-theme", s.theme);
    ["theme-light", "theme-warm", "theme-sepia", "theme-dark", "theme-oled"].forEach(t => {
      document.documentElement.classList.remove(t);
      document.body.classList.remove(t);
    });
    document.documentElement.classList.add(`theme-${s.theme}`);
    document.body.classList.add(`theme-${s.theme}`);

    document.documentElement.setAttribute("data-font", s.fontFamily);

    document.documentElement.style.setProperty("--reader-font-size", `${s.fontSize}px`);
    document.documentElement.style.setProperty("--reader-line-height", s.lineHeight || 1.65);
    document.documentElement.style.setProperty("--reader-max-width", `${s.contentWidth || 720}px`);
    document.documentElement.style.setProperty("--reader-text-align", s.textAlign || "justify");

    // Synchronizace formulářů v nastavení
    if (this.dom.sliderFontSize) {
      this.dom.sliderFontSize.value = s.fontSize;
      if (this.dom.valFontSize) this.dom.valFontSize.textContent = `${s.fontSize}px`;
    }
    if (this.dom.sliderLineHeight) {
      this.dom.sliderLineHeight.value = s.lineHeight;
      if (this.dom.valLineHeight) this.dom.valLineHeight.textContent = s.lineHeight;
    }
    if (this.dom.sliderContentWidth) {
      this.dom.sliderContentWidth.value = s.contentWidth;
      if (this.dom.valContentWidth) this.dom.valContentWidth.textContent = `${s.contentWidth}px`;
    }
    this.setSwitchState(this.dom.rulerToggle, s.ruler.enabled);
    if (this.dom.rulerSnapSetting) this.setSwitchState(this.dom.rulerSnapSetting, true);
    this.setSwitchState(this.dom.rulerWordTrackingSetting, s.ruler.wordTracking ?? false);
    if (this.dom.rulerAutoHeightSetting) this.setSwitchState(this.dom.rulerAutoHeightSetting, true);
    this.updateRulerHeightUI();
    if (this.dom.sliderRulerOpacity) {
      this.dom.sliderRulerOpacity.value = Math.round(s.ruler.dimOpacity * 100);
      if (this.dom.valRulerOpacity) this.dom.valRulerOpacity.textContent = `${Math.round(s.ruler.dimOpacity * 100)}%`;
    }
    if (this.dom.rulerFollowSelect) {
      this.dom.rulerFollowSelect.value = s.ruler.followMode;
    }
    if (this.dom.popoverRulerFollowSelect) {
      this.dom.popoverRulerFollowSelect.value = s.ruler.followMode;
    }
    // Tlačítka témat
    this.dom.themeSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === s.theme);
    });
    // Písma
    this.dom.fontSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.font === s.fontFamily);
    });
    // Režimy pravítka
    this.dom.rulerModeSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.rulerMode === s.ruler.mode);
    });
    // Barvy pravítka
    this.dom.rulerColorSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.rulerColor === s.ruler.color);
    });

    // Zobrazení spodní lišty čtečky (postup čtení)
    const showFooter = this.settings.showFooterBar !== false;
    document.body.classList.toggle("show-footer-bar", showFooter);
    if (this.dom.settingShowFooter) {
      this.setSwitchState(this.dom.settingShowFooter, showFooter);
    }

    // Synchronizace rychlého popoveru pravítka
    if (this.dom.popoverRulerToggle) {
      this.setSwitchState(this.dom.popoverRulerToggle, s.ruler.enabled);
    }
    if (this.dom.popoverModeLine && this.dom.popoverModeWord) {
      this.dom.popoverModeLine.classList.toggle("active", !s.ruler.wordTracking);
      this.dom.popoverModeWord.classList.toggle("active", !!s.ruler.wordTracking);
    }
    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerStyle === s.ruler.mode);
      });
    }
    if (this.dom.popoverColorButtons) {
      this.dom.popoverColorButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerColor === s.ruler.color);
      });
    }
    if (this.dom.popoverRulerSnapToggle) this.setSwitchState(this.dom.popoverRulerSnapToggle, true);
    if (this.dom.popoverRulerAutoHeightToggle) this.setSwitchState(this.dom.popoverRulerAutoHeightToggle, true);
    if (this.dom.popoverSliderRulerOpacity) {
      this.dom.popoverSliderRulerOpacity.value = Math.round(s.ruler.dimOpacity * 100);
      if (this.dom.popoverValRulerOpacity) this.dom.popoverValRulerOpacity.textContent = `${Math.round(s.ruler.dimOpacity * 100)}%`;
    }
    if (this.dom.popoverRulerFollowSelect) {
      this.dom.popoverRulerFollowSelect.value = s.ruler.followMode;
    }

    // Pokud čteme knihu, přepočítat stránkování
    if (this.currentBook && this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden")) {
      requestAnimationFrame(() => {
        this.recalcPages();
        this.goToPage(this.currentPageIndex);
      });
    }

    this.updateTouchZonesUI();
  }

  bindEvents() {
    // 1. Nahrávání souborů
    this.dom.btnUpload.addEventListener("click", () => this.dom.fileInput.click());
    this.dom.fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        this.handleFileUpload(e.target.files[0]);
      }
    });

    // Drag & drop
    const dropZone = document.body;
    ["dragenter", "dragover"].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        document.body.classList.add("dragging-file");
      });
    });
    ["dragleave", "drop"].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        document.body.classList.remove("dragging-file");
      });
    });
    dropZone.addEventListener("drop", (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith(".epub")) {
          this.handleFileUpload(file);
        } else {
          this.showToast("Prosím nahrajte soubor ve formátu .epub", "error");
        }
      }
    });

    // Vzorová kniha tlačítko
    this.dom.btnLoadSample?.addEventListener("click", () => this.loadBundledSampleBook());

    // 2. Přepínání pohledů a stránkování
    if (this.dom.btnBackToLibrary) this.dom.btnBackToLibrary.addEventListener("click", () => this.showLibraryView());
    
    // Tlačítka stránkování v patičce
    if (this.dom.btnPagePrev) this.dom.btnPagePrev.addEventListener("click", () => this.prevPage());
    if (this.dom.btnPageNext) this.dom.btnPageNext.addEventListener("click", () => this.nextPage());

    // Dotykové zóny na okrajích obrazovky (listování nebo krokování pravítka)
    let lastSwipeTime = 0;
    let lastTapTime = 0;

    this.dom.zoneTouchPrev.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.isUiOrOverlayEvent(e)) return;
      if (this.isNavigatingPage || this.ruler?.isNavigatingPage) {
        e.preventDefault();
        return;
      }
      if (this.ruler?.enabled && this.ruler.followMode === "keyboard") {
        this.ruler.stepLine(-1, true);
        return;
      }
      // Pokud probíhá interakce/tažení pravítka nebo dobíhá cooldown, potlačit kliknutí
      if (this.ruler?.isInteracting() || this.ruler?.isHoldTriggered || this.ruler?.wasHoldAborted || Date.now() < this.ruler?.dragCooldownEndTime) {
        e.preventDefault();
        return;
      }
      // Pokud před chvilkou proběhl swipe prstem nebo tap, potlačíme syntetický click iPadu
      if (Date.now() - lastSwipeTime < 500 || Date.now() - lastTapTime < 500) {
        e.preventDefault();
        return;
      }
      // Při zapnutém pravítku slouží Apple Pencil výhradně k pozicování pravítka, nikoliv k přepínání stránek
      if (this.ruler?.enabled && this.ruler?.isPenEvent(e)) {
        return;
      }
      if (this.ruler && this.ruler.enabled) {
        if (this.ruler.followMode === "mouse") {
          return;
        }
        const dir = this.getRulerTapDirection(e.clientX, e.clientY);
        this.ruler.stepLine(dir, true);
      } else {
        this.prevPage();
      }
    });

    this.dom.zoneTouchNext.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.isUiOrOverlayEvent(e)) return;
      if (this.isNavigatingPage || this.ruler?.isNavigatingPage) {
        e.preventDefault();
        return;
      }
      if (this.ruler?.enabled && this.ruler.followMode === "keyboard") {
        this.ruler.stepLine(1, true);
        return;
      }
      // Pokud probíhá interakce/tažení pravítka nebo dobíhá cooldown, potlačit kliknutí
      if (this.ruler?.isInteracting() || this.ruler?.isHoldTriggered || this.ruler?.wasHoldAborted || Date.now() < this.ruler?.dragCooldownEndTime) {
        e.preventDefault();
        return;
      }
      // Pokud před chvilkou proběhl swipe prstem nebo tap, potlačíme syntetický click iPadu
      if (Date.now() - lastSwipeTime < 500 || Date.now() - lastTapTime < 500) {
        e.preventDefault();
        return;
      }
      // Při zapnutém pravítku slouží Apple Pencil výhradně k pozicování pravítka
      if (this.ruler?.enabled && this.ruler?.isPenEvent(e)) {
        return;
      }
      if (this.ruler && this.ruler.enabled) {
        if (this.ruler.followMode === "mouse") {
          return;
        }
        const dir = this.getRulerTapDirection(e.clientX, e.clientY);
        this.ruler.stepLine(dir, true);
      } else {
        this.nextPage();
      }
    });

    // Přejetí prstem po obrazovce na iPadu (Touch Swipe) & Klepnutí (Tap) pro posun pravítka
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isSwiping = false;

    this.dom.pagedViewport.addEventListener("touchstart", (e) => {
      if (this.isUiOrOverlayEvent(e)) {
        isSwiping = false;
        return;
      }
      if (this.isNavigatingPage || this.ruler?.isNavigatingPage) {
        isSwiping = false;
        return;
      }
      if (e.touches.length !== 1) {
        isSwiping = false;
        return;
      }
      // Apple Pencil v režimu sledování myši nesmí zahajovat swipe
      if (this.ruler?.enabled && this.ruler.followMode === "mouse" && this.ruler.isPenEvent(e)) {
        isSwiping = false;
        return;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isSwiping = true;
    }, { passive: true });

    this.dom.pagedViewport.addEventListener("touchend", (e) => {
      if (this.isUiOrOverlayEvent(e)) {
        isSwiping = false;
        return;
      }
      if (this.isNavigatingPage || this.ruler?.isNavigatingPage) {
        isSwiping = false;
        return;
      }
      if (!isSwiping || e.changedTouches.length !== 1) {
        isSwiping = false;
        return;
      }
      isSwiping = false;

      // Stylus v režimu sledování myši nesmí otáčet stránky ani krokovat
      if (this.ruler?.enabled && this.ruler.followMode === "mouse" && this.ruler.isPenEvent(e)) {
        return;
      }

      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);
      const dist = Math.hypot(deltaX, deltaY);

      // 1. Horizontální přejetí (swipe) pro otáčení stránek: |deltaX| > 30px a |deltaX| > |deltaY| * 1.5
      if (absDeltaX > 30 && absDeltaX > absDeltaY * 1.5) {
        lastSwipeTime = Date.now();
        if (this.ruler) {
          this.ruler.cancelHold(false);
          this.ruler.isHoldTriggered = false;
        }
        if (deltaX < 0) {
          this.nextPage();
        } else {
          this.prevPage();
        }
        return;
      }

      // 2. V režimu sledování myši ("mouse") prst nehýbe ani neukotvuje pravítko
      if (this.ruler && this.ruler.enabled && this.ruler.followMode === "mouse") {
        if (absDeltaX < 15 && absDeltaY < 15 && this.isCenterTap(touchEndX, touchEndY)) {
          lastTapTime = Date.now();
          this.toggleReaderChrome();
          e.preventDefault();
        }
        return;
      }

      // 3. Dotykové zóny pro krokování pravítka v klávesovém režimu (layout zóny)
      // Krokování se spustí pouze při čistém, stacionárním klepnutí (|deltaX| < 10px a |deltaY| < 10px)
      if (this.ruler && this.ruler.enabled && this.ruler.followMode === "keyboard") {
        if (e.target && (e.target.closest("button") || e.target.closest(".ruler-floating-controls") || e.target.closest(".paged-footer-bar") || e.target.closest(".ruler-btn-group") || e.target.closest("#ruler-quick-popover"))) {
          return;
        }
        if (absDeltaX >= 10 || absDeltaY >= 10 || dist >= 10) return;
        if (this.ruler.isHoldTriggered) {
          this.ruler.isHoldTriggered = false;
          return;
        }
        if (typeof this.ruler.handleTap === "function") {
          const handled = this.ruler.handleTap(touchEndX, touchEndY, "touch", dist);
          if (handled) {
            lastTapTime = Date.now();
            e.preventDefault();
          }
          return;
        }
        lastTapTime = Date.now();
        const dir = this.getRulerTapDirection(touchEndX, touchEndY);
        this.ruler.stepLine(dir, true);
        e.preventDefault();
        return;
      }

      // 4. Běžné klepnutí (Tap) když je pravítko vypnuté
      if (absDeltaX < 15 && absDeltaY < 15) {
        if (e.target && (e.target.closest("button") || e.target.closest(".ruler-floating-controls") || e.target.closest(".paged-footer-bar") || e.target.closest(".ruler-btn-group") || e.target.closest("#ruler-quick-popover"))) {
          return;
        }
        if (this.isCenterTap(touchEndX, touchEndY)) {
          lastTapTime = Date.now();
          this.toggleReaderChrome();
          e.preventDefault();
          return;
        }
      }
    }, { passive: false });

    // Kliknutí myší na plochu čtečky pro ovládání pravítka nebo přepnutí systémových lišt
    this.dom.pagedViewport.addEventListener("click", (e) => {
      if (this.isUiOrOverlayEvent(e)) return;
      if (this.isNavigatingPage || this.ruler?.isNavigatingPage) return;
      if (Date.now() - lastSwipeTime < 500 || Date.now() - lastTapTime < 350) {
        return;
      }
      if (e.target && (e.target.closest("button") || e.target.closest(".ruler-floating-controls") || e.target.closest(".paged-footer-bar") || e.target.closest(".ruler-btn-group") || e.target.closest("#ruler-quick-popover"))) {
        return;
      }

      // Klepnutí doprostřed obrazovky přepne zobrazení hlavičky a spodní lišty
      if (this.isCenterTap(e.clientX, e.clientY)) {
        if (!this.ruler || !this.ruler.enabled || this.ruler.followMode === "mouse") {
          lastTapTime = Date.now();
          this.toggleReaderChrome();
          return;
        }
      }

      if (!this.ruler || !this.ruler.enabled) return;
      if (this.ruler.followMode === "mouse") {
        return;
      }
      if (this.ruler.isHoldTriggered) {
        this.ruler.isHoldTriggered = false;
        return;
      }
      if (typeof this.ruler.handleTap === "function" && this.ruler.followMode === "keyboard") {
        const handled = this.ruler.handleTap(e.clientX, e.clientY, "mouse", 0);
        if (handled) {
          lastTapTime = Date.now();
          e.preventDefault();
        }
        return;
      }
      lastTapTime = Date.now();
      const dir = this.getRulerTapDirection(e.clientX, e.clientY);
      this.ruler.stepLine(dir, true);
    });

    // Přejetí dvěma prsty po touchpadu nebo kolečko myši (Mac Trackpad - vždy přesně 1 strana)
    let isWheelTurnLocked = false;
    let wheelMomentumTimer = null;

    this.dom.pagedViewport.addEventListener("wheel", (e) => {
      if (this.isAnyModalOrMenuOpen()) return;
      this.ruler?.cancelHold();
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      const isHorizontal = absX >= absY;
      const delta = isHorizontal ? e.deltaX : (absY > 35 ? e.deltaY : 0);

      // Pokud ještě trvá setrvačnost předchozího gesta, další stranu neotáčíme
      if (!isWheelTurnLocked && Math.abs(delta) > 22) {
        isWheelTurnLocked = true;
        if (delta > 0) {
          this.nextPage();
        } else {
          this.prevPage();
        }
      }

      // Resetujeme zámek teprve, až intenzita pohybu klesne (konec fyzického gesta prsty)
      clearTimeout(wheelMomentumTimer);
      wheelMomentumTimer = setTimeout(() => {
        isWheelTurnLocked = false;
      }, 160);

      // Pokud setrvačnost klesla na naprosté minimum, uvolníme dříve pro svižnost
      if (Math.abs(delta) < 3) {
        isWheelTurnLocked = false;
      }
    }, { passive: true });

    // Přizpůsobení stran při změně orientace iPadu (Portrait/Landscape)
    window.addEventListener("resize", () => {
      if (this.currentBook && !this.dom.viewReader.classList.contains("is-hidden")) {
        this.recalcPages();
        this.goToPage(this.currentPageIndex);
        this.ruler?.refreshLines();
      }
    });

    // Tracker události
    tracker.subscribe((event) => {
      if (event.type === "tick" || event.type === "progress") {
        if (this.dom.wpmBadge) this.dom.wpmBadge.textContent = `${event.wpm} WPM`;
        this.updateEtrBadge();
      } else if (event.type === "idleChange") {
        if (this.dom.wpmBadge) this.dom.wpmBadge.classList.toggle("is-idle", event.isIdle);
      }
    });

    // 3. Postranní panely a modály
    // Izolace událostí pro lišty, panely nastavení a modální okna proti nechtěnému otáčení stránek
    const uiContainers = [
      document.getElementById("reader-header"),
      document.getElementById("paged-footer-bar"),
      document.querySelector(".library-header"),
      document.querySelector(".top-navbar"),
      document.getElementById("settings-drawer"),
      document.getElementById("toc-drawer"),
      document.getElementById("search-drawer"),
      document.getElementById("drawer-backdrop"),
      document.getElementById("stats-modal"),
      document.querySelector(".modal-content"),
      document.getElementById("ruler-btn-group"),
      document.getElementById("ruler-quick-popover")
    ].filter(Boolean);

    uiContainers.forEach((container) => {
      ["pointerdown", "touchstart", "click"].forEach((eventType) => {
        container.addEventListener(eventType, (e) => {
          if (eventType === "click" && container.id === "reader-header") {
            if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
              if (!this.dom.rulerBtnGroup || !this.dom.rulerBtnGroup.contains(e.target)) {
                this.dom.rulerQuickPopover.classList.add("is-hidden");
                if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
              }
            }
          }
          e.stopPropagation();
        });
      });
    });

    if (this.dom.drawerBackdrop) {
      this.dom.drawerBackdrop.addEventListener("click", () => {
        this.closeDrawer("toc");
        this.closeDrawer("settings");
        this.closeDrawer("search");
      });
    }

    if (this.dom.btnToggleSettingsLib) {
      this.dom.btnToggleSettingsLib.addEventListener("click", () => this.toggleDrawer("settings"));
    }

    if (this.dom.btnToggleStatsLib) {
      this.dom.btnToggleStatsLib.addEventListener("click", () => this.openStatsModal());
    }

    this.dom.btnToggleToc.addEventListener("click", () => this.toggleDrawer("toc"));
    this.dom.btnCloseToc.addEventListener("click", () => this.closeDrawer("toc"));

    this.dom.btnToggleSettings.addEventListener("click", () => this.toggleDrawer("settings"));
    this.dom.btnCloseSettings.addEventListener("click", () => this.closeDrawer("settings"));

    if (this.dom.btnToggleSearch) {
      this.dom.btnToggleSearch.addEventListener("click", () => this.toggleDrawer("search"));
    }
    if (this.dom.btnCloseSearch) {
      this.dom.btnCloseSearch.addEventListener("click", () => this.closeDrawer("search"));
    }
    if (this.dom.btnClearSearch) {
      this.dom.btnClearSearch.addEventListener("click", () => this.clearSearch());
    }
    if (this.dom.inputBookSearch) {
      this.dom.inputBookSearch.addEventListener("input", () => this.handleSearchInput());
      this.dom.inputBookSearch.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.executeSearch();
        }
      });
    }
    if (this.dom.searchResultsList) {
      this.dom.searchResultsList.addEventListener("click", (e) => {
        const item = e.target.closest(".search-result-item");
        if (item) {
          const chIdx = parseInt(item.dataset.chapter, 10);
          const q = item.dataset.query || "";
          this.navigateToSearchResult(chIdx, q);
        }
      });
    }

    this.dom.btnToggleStats.addEventListener("click", () => this.openStatsModal());
    this.dom.btnCloseStats.addEventListener("click", () => this.closeStatsModal());
    this.dom.statsModal.addEventListener("click", (e) => {
      if (e.target === this.dom.statsModal) this.closeStatsModal();
    });

    // Pravítko toggle tlačítko v hlavičce
    if (this.dom.btnToggleRuler) {
      ["pointerdown", "touchstart"].forEach((evt) => {
        this.dom.btnToggleRuler.addEventListener(evt, (e) => {
          e.stopPropagation();
        }, { passive: true });
      });
      this.dom.btnToggleRuler.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleRuler();
      });
    }

    // Rychlé nastavení pravítka v hlavičce (Popover)
    if (this.dom.btnRulerQuickMenu && this.dom.rulerQuickPopover) {
      ["pointerdown", "touchstart"].forEach((evt) => {
        this.dom.btnRulerQuickMenu.addEventListener(evt, (e) => {
          e.stopPropagation();
        }, { passive: true });
        this.dom.rulerQuickPopover.addEventListener(evt, (e) => {
          e.stopPropagation();
        }, { passive: true });
      });

      this.dom.btnRulerQuickMenu.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isHidden = this.dom.rulerQuickPopover.classList.contains("is-hidden");
        if (isHidden) {
          this.dom.rulerQuickPopover.classList.remove("is-hidden");
          this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "true");
        } else {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        }
      });

      this.dom.rulerQuickPopover.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }

    document.addEventListener("click", (e) => {
      if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
        if (!this.dom.rulerBtnGroup || !this.dom.rulerBtnGroup.contains(e.target)) {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        }
      }
    });

    if (this.dom.popoverRulerToggle) {
      this.dom.popoverRulerToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const nextVal = !this.settings.ruler.enabled;
        this.settings.ruler.enabled = nextVal;
        const isInReader = !this.dom.viewReader.classList.contains("is-hidden");
        this.ruler.setEnabled(isInReader && nextVal);
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.popoverModeLine) {
      this.dom.popoverModeLine.addEventListener("click", (e) => {
        e.stopPropagation();
        this.settings.ruler.wordTracking = false;
        this.ruler.setWordTracking(false);
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.popoverModeWord) {
      this.dom.popoverModeWord.addEventListener("click", (e) => {
        e.stopPropagation();
        this.settings.ruler.wordTracking = true;
        this.ruler.setWordTracking(true);
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.settings.ruler.mode = btn.dataset.rulerStyle;
          this.ruler.setMode(this.settings.ruler.mode);
          this.updateRulerToggleButtonUI();
          storage.saveSettings(this.settings);
        });
      });
    }

    if (this.dom.popoverColorButtons) {
      this.dom.popoverColorButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.settings.ruler.color = btn.dataset.rulerColor;
          this.ruler.setColor(this.settings.ruler.color);
          this.updateRulerToggleButtonUI();
          storage.saveSettings(this.settings);
        });
      });
    }

    // Popover rozšířené nastavení: Výška / tloušťka pravítka
    if (this.dom.popoverSliderRulerHeight) {
      this.dom.popoverSliderRulerHeight.addEventListener("input", (e) => {
        e.stopPropagation();
        const val = parseInt(e.target.value, 10);
        this.settings.ruler.height = val;
        this.ruler.setHeight(val);
        this.updateRulerHeightUI();
        storage.saveSettings(this.settings);
      });
    }

    // Popover rozšířené nastavení: Intenzita ztmavení okolí
    if (this.dom.popoverSliderRulerOpacity) {
      this.dom.popoverSliderRulerOpacity.addEventListener("input", (e) => {
        e.stopPropagation();
        const val = parseInt(e.target.value, 10);
        this.settings.ruler.dimOpacity = val / 100;
        this.ruler.setDimOpacity(this.settings.ruler.dimOpacity);
        if (this.dom.sliderRulerOpacity) this.dom.sliderRulerOpacity.value = val;
        if (this.dom.valRulerOpacity) this.dom.valRulerOpacity.textContent = `${val}%`;
        if (this.dom.popoverValRulerOpacity) this.dom.popoverValRulerOpacity.textContent = `${val}%`;
        storage.saveSettings(this.settings);
      });
    }

    // Popover rozšířené nastavení: Způsob pohybu
    if (this.dom.popoverRulerFollowSelect) {
      this.dom.popoverRulerFollowSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        const val = e.target.value;
        this.settings.ruler.followMode = val;
        this.ruler.setFollowMode(val);
        if (this.dom.rulerFollowSelect) this.dom.rulerFollowSelect.value = val;
        this.updateTouchZonesUI();
        storage.saveSettings(this.settings);
      });
    }

    // 4. Události nastavení (Settings Events)
    this.dom.themeSelects.forEach(btn => {
      btn.addEventListener("click", () => {
        this.settings.theme = btn.dataset.theme;
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    });

    this.dom.fontSelects.forEach(btn => {
      btn.addEventListener("click", () => {
        this.settings.fontFamily = btn.dataset.font;
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    });

    this.dom.sliderFontSize.addEventListener("input", (e) => {
      this.settings.fontSize = parseInt(e.target.value, 10);
      this.applySettings();
      storage.saveSettings(this.settings);
    });

    if (this.dom.sliderLineHeight) {
      this.dom.sliderLineHeight.addEventListener("input", (e) => {
        this.settings.lineHeight = parseFloat(e.target.value);
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.sliderContentWidth) {
      this.dom.sliderContentWidth.addEventListener("input", (e) => {
        this.settings.contentWidth = parseInt(e.target.value, 10);
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.btnAlignLeft) {
      this.dom.btnAlignLeft.addEventListener("click", () => {
        this.settings.textAlign = "left";
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.btnAlignJustify) {
      this.dom.btnAlignJustify.addEventListener("click", () => {
        this.settings.textAlign = "justify";
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    // Pravítko nastavení události - tlačítkové přepínače (Switch buttons)
    if (this.dom.rulerToggle) {
      this.dom.rulerToggle.addEventListener("click", () => {
        const nextVal = !this.settings.ruler.enabled;
        this.settings.ruler.enabled = nextVal;
        this.setSwitchState(this.dom.rulerToggle, nextVal);
        const isInReader = !this.dom.viewReader.classList.contains("is-hidden");
        this.ruler.setEnabled(isInReader && nextVal);
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.rulerWordTrackingSetting) {
      this.dom.rulerWordTrackingSetting.addEventListener("click", () => {
        const nextVal = !(this.settings.ruler.wordTracking ?? false);
        this.settings.ruler.wordTracking = nextVal;
        this.setSwitchState(this.dom.rulerWordTrackingSetting, nextVal);
        this.ruler.setWordTracking(nextVal);
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    this.dom.rulerModeSelects.forEach(btn => {
      btn.addEventListener("click", () => {
        this.settings.ruler.mode = btn.dataset.rulerMode;
        this.ruler.setMode(this.settings.ruler.mode);
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    });

    this.dom.rulerColorSelects.forEach(btn => {
      btn.addEventListener("click", () => {
        this.settings.ruler.color = btn.dataset.rulerColor;
        this.ruler.setColor(this.settings.ruler.color);
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    });

    this.dom.sliderRulerHeight.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      this.settings.ruler.height = val;
      this.ruler.setHeight(val);
      this.updateRulerHeightUI();
      storage.saveSettings(this.settings);
    });

    this.dom.sliderRulerOpacity.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      this.settings.ruler.dimOpacity = val / 100;
      this.ruler.setDimOpacity(this.settings.ruler.dimOpacity);
      if (this.dom.popoverSliderRulerOpacity) this.dom.popoverSliderRulerOpacity.value = val;
      if (this.dom.popoverValRulerOpacity) this.dom.popoverValRulerOpacity.textContent = `${val}%`;
      this.applySettings();
      storage.saveSettings(this.settings);
    });

    this.dom.rulerFollowSelect.addEventListener("change", (e) => {
      const val = e.target.value;
      this.settings.ruler.followMode = val;
      this.ruler.setFollowMode(val);
      if (this.dom.popoverRulerFollowSelect) this.dom.popoverRulerFollowSelect.value = val;
      this.applySettings();
      storage.saveSettings(this.settings);
    });

    // Přepínač zobrazení spodní lišty s postupem čtení
    if (this.dom.settingShowFooter) {
      this.dom.settingShowFooter.addEventListener("click", () => {
        const val = !this.settings.showFooterBar;
        this.settings.showFooterBar = val;
        this.setSwitchState(this.dom.settingShowFooter, val);
        document.body.classList.toggle("show-footer-bar", val);
        storage.saveSettings(this.settings);
        if (this.currentBook && !this.dom.viewReader.classList.contains("is-hidden")) {
          requestAnimationFrame(() => {
            this.recalcPages();
            this.goToPage(this.currentPageIndex);
            this.updateScrubberUI();
          });
        }
      });
    }

    // Export statistik
    this.dom.btnExportData.addEventListener("click", async () => {
      const stats = await ReadingTracker.computeGlobalStats();
      const sessions = await storage.getAllSessions();
      const exportObj = {
        exportedAt: new Date().toISOString(),
        stats,
        sessions
      };
      const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `luminareader-stats-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  bindKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
      const isReader = this.currentBook && !this.dom.viewReader.classList.contains("is-hidden");

      if (e.key === "Escape") {
        if (this.dom.searchDrawer && this.dom.searchDrawer.classList.contains("open")) {
          e.preventDefault();
          this.closeDrawer("search");
          return;
        }
      }

      if (isReader && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        this.toggleDrawer("search");
        return;
      }

      // 1. Guard proti psaní do formulářových polí, textarey, vyhledávání apod.
      const activeEl = document.activeElement;
      const activeTag = activeEl?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        activeTag === "SELECT" ||
        activeEl?.isContentEditable ||
        (activeEl?.closest && activeEl.closest("input, textarea, select, [contenteditable='true'], .search-box"))
      ) {
        return;
      }
      if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT" ||
        e.target.isContentEditable ||
        (e.target.closest && e.target.closest("input, textarea, select, [contenteditable='true'], .search-box"))
      ) {
        return;
      }

      if (e.key === "Escape") {
        let closedPopover = false;
        if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
          closedPopover = true;
        }
        if (closedPopover) return;
        if (this.dom.tocDrawer.classList.contains("open")) {
          this.closeDrawer("toc");
        } else if (this.dom.settingsDrawer.classList.contains("open")) {
          this.closeDrawer("settings");
        } else if (this.dom.searchDrawer && this.dom.searchDrawer.classList.contains("open")) {
          this.closeDrawer("search");
        } else if (this.dom.statsModal.classList.contains("open")) {
          this.closeStatsModal();
        } else if (isReader) {
          // Klávesa Esc bez otevřeného modálu vrátí uživatele do knihovny
          this.showLibraryView();
        }
        return;
      }

      if (this.isAnyModalOrMenuOpen()) return;

      if (isReader) {
        this.ruler?.cancelHold();
        // Pokud má prohlížečový focus jakékoliv tlačítko, uvolníme focus (blur),
        // aby stisk Mezerníku neaktivoval toto tlačítko namísto posunu pravítka.
        if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
          if (activeEl && activeTag === "BUTTON") {
            activeEl.blur();
          }
        }

        // 1. OBRACENÍ STRAN (Page Turns): Šipka vpravo / Šipka vlevo / PageUp / PageDown
        if (e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          this.nextPage();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "PageUp") {
          e.preventDefault();
          this.prevPage();
          return;
        }

        // 2. KROKOVÁNÍ PRAVÍTKA: Mezerník a Šipka dolů (vpřed +1), Šipka nahoru (vzad -1)
        // Pokud pravítko není zapnuto, automaticky jej aktivujeme a ihned posuneme
        if (e.code === "Space" || e.key === " " || e.key === "Spacebar" || e.key === "ArrowDown") {
          e.preventDefault();
          if (this.ruler) {
            if (!this.ruler.enabled) {
              this.settings.ruler.enabled = true;
              this.ruler.setEnabled(true);
              this.updateRulerToggleButtonUI();
              this.applySettings();
              storage.saveSettings(this.settings);
            }
            this.ruler.stepLine(1, true);
          }
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (this.ruler) {
            if (!this.ruler.enabled) {
              this.settings.ruler.enabled = true;
              this.ruler.setEnabled(true);
              this.updateRulerToggleButtonUI();
              this.applySettings();
              storage.saveSettings(this.settings);
            }
            this.ruler.stepLine(-1, true);
          }
          return;
        }

        // 3. Ostatní klávesové zkratky čtečky
        if (e.key === "t" || e.key === "T") {
          this.toggleDrawer("toc");
        } else if (e.key === "s" || e.key === "S") {
          this.openStatsModal();
        } else if (e.key === "r" || e.key === "R") {
          this.toggleRuler();
        } else if (e.key === "f" || e.key === "F") {
          this.toggleDrawer("search");
        }
      }
    });
  }

  toggleRuler() {
    const isInReader = !this.dom.viewReader.classList.contains("is-hidden");
    if (!isInReader) return;

    this.settings.ruler.enabled = !this.settings.ruler.enabled;
    this.ruler.setEnabled(this.settings.ruler.enabled);
    this.updateRulerToggleButtonUI();
    storage.saveSettings(this.settings);
    this.showToast(this.settings.ruler.enabled ? "Pravítko zapnuto (klávesa R)" : "Pravítko vypnuto", "info");
  }

  /**
   * Určí směr posunu pravítka podle schématu dotykových zón (Zelená / Červená).
   * - Zelené zóny (vpřed +1): pravý okraj (x > 80 %) a dolní polovina čtecí plochy (y >= 46 %)
   * - Červené zóny (vzad -1): levý okraj (x < 20 %) a horní polovina čtecí plochy (y < 46 %)
   */
  getRulerTapDirection(clientX, clientY) {
    if (this.ruler?.enabled && typeof this.ruler.getTapDirection === "function") {
      return this.ruler.getTapDirection(clientX, clientY);
    }

    let relX = clientX;
    let relY = clientY;
    if (clientX > 1 || clientY > 1) {
      const width = window.innerWidth || document.documentElement.clientWidth || 1;
      const height = window.innerHeight || document.documentElement.clientHeight || 1;
      relX = clientX / width;
      relY = clientY / height;
    }

    if (relX <= 0.12) return -1;
    if (relX >= 0.80) return 1;
    return relY <= 0.50 ? -1 : 1;
  }

  updateTouchZonesUI() {
    const isKeyboardRuler = !!this.settings.ruler.enabled && this.settings.ruler.followMode === "keyboard";
    if (this.dom.zoneTouchPrev) {
      this.dom.zoneTouchPrev.style.display = isKeyboardRuler ? "none" : "";
      this.dom.zoneTouchPrev.style.pointerEvents = isKeyboardRuler ? "none" : "";
      this.dom.zoneTouchPrev.classList.toggle("is-hidden", isKeyboardRuler);
    }
    if (this.dom.zoneTouchNext) {
      this.dom.zoneTouchNext.style.display = isKeyboardRuler ? "none" : "";
      this.dom.zoneTouchNext.style.pointerEvents = isKeyboardRuler ? "none" : "";
      this.dom.zoneTouchNext.classList.toggle("is-hidden", isKeyboardRuler);
    }
  }

  updateRulerToggleButtonUI() {
    const isEnabled = !!this.settings.ruler.enabled;
    if (this.dom.btnToggleRuler) this.dom.btnToggleRuler.classList.toggle("active", isEnabled);
    if (this.dom.rulerBtnGroup) this.dom.rulerBtnGroup.classList.toggle("is-active", isEnabled);
    if (this.dom.popoverRulerToggle) this.setSwitchState(this.dom.popoverRulerToggle, isEnabled);
    if (this.dom.rulerToggle) this.setSwitchState(this.dom.rulerToggle, isEnabled);
    if (this.dom.rulerWordTrackingSetting) this.setSwitchState(this.dom.rulerWordTrackingSetting, !!this.settings.ruler.wordTracking);

    if (this.dom.popoverModeLine && this.dom.popoverModeWord) {
      this.dom.popoverModeLine.classList.toggle("active", !this.settings.ruler.wordTracking);
      this.dom.popoverModeWord.classList.toggle("active", !!this.settings.ruler.wordTracking);
    }
    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerStyle === this.settings.ruler.mode);
      });
    }
    if (this.dom.popoverColorButtons) {
      this.dom.popoverColorButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerColor === this.settings.ruler.color);
      });
    }
    if (this.dom.rulerModeSelects) {
      this.dom.rulerModeSelects.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerMode === this.settings.ruler.mode);
      });
    }
    if (this.dom.rulerColorSelects) {
      this.dom.rulerColorSelects.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerColor === this.settings.ruler.color);
      });
    }
    this.updateTouchZonesUI();
  }


  updateRulerHeightUI() {
    const isAuto = this.settings.ruler.autoHeight ?? true;
    const heightVal = `${this.settings.ruler.height}px`;

    // 1. Panel nastavení
    if (this.dom.sliderRulerHeight && this.dom.valRulerHeight) {
      this.dom.sliderRulerHeight.value = this.settings.ruler.height;
      if (isAuto) {
        this.dom.valRulerHeight.textContent = "Auto";
        this.dom.sliderRulerHeight.disabled = true;
        this.dom.sliderRulerHeight.style.opacity = "0.45";
        this.dom.sliderRulerHeight.style.pointerEvents = "none";
      } else {
        this.dom.valRulerHeight.textContent = heightVal;
        this.dom.sliderRulerHeight.disabled = false;
        this.dom.sliderRulerHeight.style.opacity = "1";
        this.dom.sliderRulerHeight.style.pointerEvents = "auto";
      }
    }

    // 2. Rychlý popover
    if (this.dom.popoverSliderRulerHeight && this.dom.popoverValRulerHeight) {
      this.dom.popoverSliderRulerHeight.value = this.settings.ruler.height;
      if (isAuto) {
        this.dom.popoverValRulerHeight.textContent = "Auto";
        this.dom.popoverSliderRulerHeight.disabled = true;
        this.dom.popoverSliderRulerHeight.style.opacity = "0.45";
        this.dom.popoverSliderRulerHeight.style.pointerEvents = "none";
      } else {
        this.dom.popoverValRulerHeight.textContent = heightVal;
        this.dom.popoverSliderRulerHeight.disabled = false;
        this.dom.popoverSliderRulerHeight.style.opacity = "1";
        this.dom.popoverSliderRulerHeight.style.pointerEvents = "auto";
      }
    }
  }

  // --- KNIHOVNA & NAHRÁVÁNÍ ---

  async handleFileUpload(file) {
    this.showToast("Zpracovávám EPUB soubor...", "info");
    try {
      const buffer = await file.arrayBuffer();
      const parser = await EpubParser.parse(buffer);

      // Spočítáme slova
      const wordStats = await parser.calculateTotalWords();

      const bookId = parser.metadata.identifier || `book_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      let coverDataUrl = null;
      if (parser.coverBlobUrl) {
        // Převedeme na trvalý data URL pro uložení
        try {
          const res = await fetch(parser.coverBlobUrl);
          const blob = await res.blob();
          coverDataUrl = await this.blobToDataUrl(blob);
        } catch (e) {
          console.warn("Nepodařilo se převést obálku na DataURL:", e);
        }
      }

      const bookData = {
        id: bookId,
        title: parser.metadata.title,
        creator: parser.metadata.creator,
        language: parser.metadata.language,
        description: parser.metadata.description,
        coverDataUrl,
        fileData: buffer,
        addedAt: Date.now(),
        lastReadAt: Date.now(),
        currentChapterIndex: 0,
        scrollPercent: 0,
        totalChapters: parser.spine.length,
        totalWords: wordStats.totalWords,
        wordsRead: 0,
        progressPercent: 0
      };

      await storage.saveBook(bookData);
      this.showToast(`Kniha „${bookData.title}“ byla úspěšně přidána!`, "success");
      await this.renderLibrary();

      // Rovnou otevřít nově přidanou knihu
      await this.openBook(bookId);
    } catch (err) {
      console.error("Chyba při nahrávání EPUB:", err);
      this.showToast(`Chyba při čtení EPUB: ${err.message}`, "error");
    }
  }

  async loadBundledSampleBook() {
    try {
      this.showToast("Načítám vzorovou knihu R.U.R...", "info");
      const resp = await fetch("sample-books/rur.epub");
      if (!resp.ok) throw new Error("Soubor rur.epub nebyl nalezen na serveru");
      const blob = await resp.blob();
      const file = new File([blob], "rur.epub", { type: "application/epub+zip" });
      await this.handleFileUpload(file);
    } catch (e) {
      console.warn("Chyba při načítání vzorové knihy:", e);
      this.showToast("Vzorovou knihu se nepodařilo načíst.", "error");
      this.renderLibrary();
    }
  }

  async renderLibrary() {
    const books = await storage.getAllBooks();
    this.dom.bookGrid.innerHTML = "";

    if (books.length === 0) {
      this.dom.emptyLibrary.classList.remove("is-hidden");
      this.dom.bookGrid.classList.add("is-hidden");
      return;
    }

    this.dom.emptyLibrary.classList.add("is-hidden");
    this.dom.bookGrid.classList.remove("is-hidden");

    books.forEach(book => {
      const card = document.createElement("div");
      card.className = "book-card";
      card.setAttribute("tabindex", "0");

      const coverHtml = book.coverDataUrl
        ? `<img src="${book.coverDataUrl}" alt="${book.title}" class="book-cover-img" />`
        : `<div class="book-cover-placeholder">
             <span class="cover-icon">📖</span>
             <span class="cover-title">${book.title}</span>
           </div>`;

      const progress = book.progressPercent || 0;
      const lastReadText = book.lastReadAt
        ? new Date(book.lastReadAt).toLocaleDateString("cs-CZ")
        : "Nová";

      card.innerHTML = `
        <div class="book-cover-wrapper">
          ${coverHtml}
          <div class="book-card-actions">
            <button class="btn-delete-book" title="Odebrat knihu" data-id="${book.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
        <div class="book-info">
          <h3 class="book-title" title="${book.title}">${book.title}</h3>
          <p class="book-author">${book.creator}</p>
          <div class="book-meta">
            <div class="book-progress-bar-small">
              <div class="fill" style="width: ${progress}%"></div>
            </div>
            <div class="book-meta-text">
              <span>${progress}%</span>
              <span>${lastReadText}</span>
            </div>
          </div>
        </div>
      `;

      // Otevření knihy
      card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-delete-book")) return;
        this.openBook(book.id);
      });

      // Smazání knihy
      const btnDelete = card.querySelector(".btn-delete-book");
      btnDelete.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Opravdu chcete odebrat knihu „${book.title}“ z knihovny?`)) {
          await storage.deleteBook(book.id);
          this.showToast(`Kniha byla odebrána`, "info");
          await this.renderLibrary();
        }
      });

      this.dom.bookGrid.appendChild(card);
    });
  }

  // --- ČTENÍ KNIHY ---

  async openBook(bookId) {
    this.showToast("Otevírám knihu...", "info");
    const book = await storage.getBook(bookId);
    if (!book) {
      this.showToast("Kniha nebyla v databázi nalezena.", "error");
      return;
    }

    if (this.currentParser) {
      this.currentParser.destroy();
    }

    try {
      this.currentBook = book;
      this.searchIndexCache = new Map();
      this.clearSearch();
      storage.setLastActiveBookId(book.id);
      this.currentParser = await EpubParser.parse(book.fileData);

      if (this.dom.bookTitleEl) this.dom.bookTitleEl.textContent = book.title;
      this.renderToc();

      // Rychle spočítáme celkový počet slov knihy na pozadí pro přesné počítadlo celkového počtu stran
      this.bookWordCounts = null;
      this.currentParser.calculateTotalWords().then(counts => {
        this.bookWordCounts = counts;
        this.updatePageUI();
      }).catch(e => console.warn("Nelze spočítat celková slova knihy:", e));

      // Obnovení kapitoly
      this.currentChapterIndex = book.currentChapterIndex || 0;
      await this.loadCurrentChapter(book.currentPageIndex || 0);

      this.showReaderView();
    } catch (err) {
      console.error("Chyba při otevírání knihy:", err);
      this.showToast(`Knihu se nepodařilo otevřít: ${err.message}`, "error");
    }
  }

  async loadCurrentChapter(targetPage = 0) {
    if (!this.currentParser) return;

    try {
      const chapter = await this.currentParser.loadChapter(this.currentChapterIndex);
      if (this.dom.chapterTitleEl) this.dom.chapterTitleEl.textContent = chapter.title;
      if (this.dom.pagedChapterName) this.dom.pagedChapterName.textContent = chapter.title;
      if (this.dom.readerContent) this.dom.readerContent.innerHTML = chapter.html;

      // Nastavíme tracker pro novou kapitolu
      tracker.startSession(
        this.currentBook.id,
        this.currentBook.title,
        this.currentChapterIndex,
        chapter.wordCount,
        0
      );

      // Zvýraznění aktivní kapitoly v obsahu
      this.highlightActiveTocItem();

      // Reset transformace před měřením a okamžité změření rozložení
      if (this.dom.readerContent) {
        this.dom.readerContent.style.transition = "none";
        this.dom.readerContent.style.transform = "translateX(0px)";
      }

      this.recalcPages();

      if (targetPage === "last") {
        this.goToPage(this.totalPagesInChapter - 1, -1);
      } else if (typeof targetPage === "number") {
        this.goToPage(Math.min(targetPage, this.totalPagesInChapter - 1), targetPage > 0 ? 1 : 0);
      } else {
        this.goToPage(0, 1);
      }
    } catch (e) {
      console.error("Chyba při načítání kapitoly:", e);
      this.showToast(`Chyba při načítání kapitoly: ${e.message}`, "error");

      // Záchranné zobrazení, aby obrazovka nezůstala černá
      this.dom.readerContent.innerHTML = `
        <div style="padding: 3rem 1.5rem; text-align: center; color: var(--text-main); max-width: 600px; margin: 0 auto;">
          <h3 style="margin-bottom: 1rem; color: #ef4444; font-size: 1.25rem;">Kapitolu se nepodařilo načíst</h3>
          <p style="color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.95rem; line-height: 1.5;">${e.message || "Chyba při čtení dat ze souboru knihy."}</p>
          <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap;">
            <button class="btn btn-secondary" onclick="window.luminaApp?.prevPage()">Předchozí strana</button>
            <button class="btn btn-primary" onclick="window.luminaApp?.nextPage()">Další strana</button>
          </div>
        </div>
      `;
      this.recalcPages();
    }
  }

  recalcPages() {
    if (!this.dom.pagedStage || !this.dom.readerContent) return;
    const stageWidth = this.dom.pagedStage.clientWidth || 700;
    const gap = this.pageGap || 50;
    const scrollWidth = this.dom.readerContent.scrollWidth;

    this.totalPagesInChapter = Math.max(1, Math.round((scrollWidth + gap) / (stageWidth + gap)));

    if (this.currentPageIndex >= this.totalPagesInChapter) {
      this.currentPageIndex = this.totalPagesInChapter - 1;
    }

    this.updatePageUI();
  }

  goToPage(pageIndex, explicitDirection = null) {
    const oldIndex = this.currentPageIndex;
    this.currentPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, pageIndex));
    const stageWidth = this.dom.pagedStage.clientWidth || 700;
    const offset = this.currentPageIndex * (stageWidth + this.pageGap);

    const isPageChanged = oldIndex !== this.currentPageIndex || explicitDirection !== null;
    const direction = explicitDirection !== null
      ? explicitDirection
      : (this.currentPageIndex > oldIndex ? 1 : (this.currentPageIndex < oldIndex ? -1 : 0));

    // Post-navigation zámek pro debouncing syntetických gest a eventů na iPadu (WebKit)
    this.isNavigatingPage = true;
    if (this.navigatingPageTimer) clearTimeout(this.navigatingPageTimer);
    this.navigatingPageTimer = setTimeout(() => {
      this.isNavigatingPage = false;
      this.navigatingPageTimer = null;
    }, 150);

    if (this.dom.readerContent) {
      this.dom.readerContent.style.transition = "none";
      this.dom.readerContent.style.transform = `translateX(-${offset}px)`;
      void this.dom.readerContent.offsetHeight; // Vynucení reflow pro synchronní a přesné měření textových uzlů pravítkem
    }

    // Měření postupu
    const pageProgress = (this.currentPageIndex + 1) / this.totalPagesInChapter;
    tracker.updateScrollProgress(pageProgress);

    this.updatePageUI();

    // Uložení pozice do storage (debounced, aby nezatěžovalo plynulé listování)
    if (this.currentBook) {
      if (this.saveProgressTimer) clearTimeout(this.saveProgressTimer);
      this.saveProgressTimer = setTimeout(() => {
        storage.updateBookProgress(this.currentBook.id, {
          currentChapterIndex: this.currentChapterIndex,
          currentPageIndex: this.currentPageIndex,
          scrollPercent: pageProgress
        });
      }, 250);
    }

    // Aktualizace řádků pro pravítko na nové stránce s přesným směrem a detekcí změny
    this.ruler?.onPageChange(direction, isPageChanged);
  }

  nextPage() {
    const now = Date.now();
    if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) return;
    this.lastPageTurnTime = now;

    if (this.currentPageIndex < this.totalPagesInChapter - 1) {
      this.goToPage(this.currentPageIndex + 1, 1);
    } else if (this.currentChapterIndex < this.currentParser.spine.length - 1) {
      // Plynulý přechod na další kapitolu!
      this.navigateChapter(1, 0);
    } else {
      this.showToast("Dočetli jste knihu až do konce! 🎉", "success");
    }
  }

  prevPage() {
    const now = Date.now();
    if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) return;
    this.lastPageTurnTime = now;

    if (this.currentPageIndex > 0) {
      this.goToPage(this.currentPageIndex - 1, -1);
    } else if (this.currentChapterIndex > 0) {
      // Plynulý přechod na konec předchozí kapitoly!
      this.navigateChapter(-1, "last");
    }
  }

  async navigateChapter(delta, targetPage = 0) {
    if (!this.currentParser) return;
    const newIdx = this.currentChapterIndex + delta;
    if (newIdx >= 0 && newIdx < this.currentParser.spine.length) {
      await tracker.flushSession();
      this.currentChapterIndex = newIdx;
      await this.loadCurrentChapter(targetPage);
    } else if (delta > 0) {
      this.showToast("Dočetli jste knihu až do konce! 🎉", "success");
    }
  }

  updatePageUI() {
    const currChapterPage = this.currentPageIndex + 1;
    const totalChapterPages = Math.max(1, this.totalPagesInChapter);

    // 1. Popisek a číslo stránky v aktuální kapitole ("strana X z Y")
    if (this.dom.chapterPageCounter) {
      this.dom.chapterPageCounter.textContent = `strana ${currChapterPage} z ${totalChapterPages}`;
    } else if (this.dom.pageCounterText) {
      this.dom.pageCounterText.textContent = `strana ${currChapterPage} z ${totalChapterPages}`;
    }

    // 2. Počítadlo stránek pro celou knihu ("strana A z B")
    let currBookPage = currChapterPage;
    let totalBookPages = totalChapterPages;

    if (this.bookWordCounts && this.bookWordCounts.chapterWords && this.bookWordCounts.chapterWords.length > 0) {
      const currentChapterWords = this.bookWordCounts.chapterWords[this.currentChapterIndex] || 250;
      const wordsPerPage = Math.max(1, Math.round(currentChapterWords / totalChapterPages));
      let beforePages = 0;
      let allPages = 0;

      for (let i = 0; i < this.bookWordCounts.chapterWords.length; i++) {
        const chWords = this.bookWordCounts.chapterWords[i];
        const chPages = (i === this.currentChapterIndex) ? totalChapterPages : Math.max(1, Math.round(chWords / wordsPerPage));
        if (i < this.currentChapterIndex) {
          beforePages += chPages;
        }
        allPages += chPages;
      }
      currBookPage = beforePages + currChapterPage;
      totalBookPages = allPages;
    }

    if (this.dom.bookPageCounter) {
      this.dom.bookPageCounter.textContent = `strana ${currBookPage} z ${totalBookPages}`;
    }

    // 3. Tlačítka aktivní/neaktivní
    const hasPrev = this.currentPageIndex > 0 || this.currentChapterIndex > 0;
    const hasNext = this.currentPageIndex < this.totalPagesInChapter - 1 || this.currentChapterIndex < (this.currentParser?.spine.length || 1) - 1;

    if (this.dom.btnPagePrev) this.dom.btnPagePrev.disabled = !hasPrev;
    if (this.dom.btnPageNext) this.dom.btnPageNext.disabled = !hasNext;

    // 4. Celkový postup v knize
    const overallProgress = totalBookPages > 0 ? Math.min(100, Math.round((currBookPage / totalBookPages) * 100)) : 0;
    if (this.dom.progressBar) this.dom.progressBar.style.width = `${overallProgress}%`;
    if (this.dom.progressText) this.dom.progressText.textContent = `${overallProgress}%`;

    this.updateEtrBadge();
    this.updateScrubberUI();
  }


  renderToc() {
    this.dom.tocList.innerHTML = "";
    if (!this.currentParser || this.currentParser.toc.length === 0) {
      this.dom.tocList.innerHTML = `<li class="toc-empty">Kniha neobsahuje obsah.</li>`;
      return;
    }

    this.currentParser.toc.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = "toc-item";
      li.textContent = item.title;
      li.dataset.index = i;

      li.addEventListener("click", async () => {
        // Najdeme odpovídající index ve spine
        const cleanHref = item.fullHref ? item.fullHref.split("#")[0].split("?")[0] : "";
        let decodedCleanHref = cleanHref;
        try { decodedCleanHref = decodeURIComponent(cleanHref); } catch (e) {}

        const spineIdx = this.currentParser.spine.findIndex(s => {
          if (!s || !s.fullPath) return false;
          const cleanSpine = s.fullPath.split("#")[0].split("?")[0];
          let decodedCleanSpine = cleanSpine;
          try { decodedCleanSpine = decodeURIComponent(cleanSpine); } catch (e) {}
          return cleanSpine === cleanHref ||
                 decodedCleanSpine === decodedCleanHref ||
                 cleanSpine.endsWith("/" + cleanHref) ||
                 decodedCleanSpine.endsWith("/" + decodedCleanHref);
        });

        if (spineIdx !== -1) {
          await tracker.flushSession();
          this.currentChapterIndex = spineIdx;
          await this.loadCurrentChapter(0);
          this.closeDrawer("toc");
        }
      });

      this.dom.tocList.appendChild(li);
    });
  }

  highlightActiveTocItem() {
    const currentSpine = this.currentParser?.spine[this.currentChapterIndex];
    if (!currentSpine || !currentSpine.fullPath) return;
    const cleanSpine = currentSpine.fullPath.split("#")[0].split("?")[0];
    let decodedCleanSpine = cleanSpine;
    try { decodedCleanSpine = decodeURIComponent(cleanSpine); } catch (e) {}

    const items = this.dom.tocList.querySelectorAll(".toc-item");
    items.forEach(li => {
      const tocItem = this.currentParser.toc[parseInt(li.dataset.index, 10)];
      if (tocItem && tocItem.fullHref) {
        const cleanToc = tocItem.fullHref.split("#")[0].split("?")[0];
        let decodedCleanToc = cleanToc;
        try { decodedCleanToc = decodeURIComponent(cleanToc); } catch (e) {}

        if (cleanToc === cleanSpine || decodedCleanToc === decodedCleanSpine) {
          li.classList.add("active");
          return;
        }
      }
      li.classList.remove("active");
    });
  }

  updateProgressBar(chapterScrollPercent) {
    if (!this.currentParser) return;
    const totalChapters = this.currentParser.spine.length;
    const overallProgress = Math.round(((this.currentChapterIndex + chapterScrollPercent) / totalChapters) * 100);

    if (this.dom.progressBar) this.dom.progressBar.style.width = `${overallProgress}%`;
    if (this.dom.progressText) this.dom.progressText.textContent = `${overallProgress}% (Kapitola ${this.currentChapterIndex + 1} z ${totalChapters})`;
  }

  updateEtrBadge() {
    if (!tracker.currentChapterWords || !this.dom.etrBadge) return;
    const remainingWordsInChapter = Math.round(tracker.currentChapterWords * (1 - tracker.currentScrollPercent));
    const minutesLeft = tracker.getEstimatedMinutesRemaining(remainingWordsInChapter);
    this.dom.etrBadge.textContent = `~${minutesLeft} min do konce`;
  }

  // --- ZOBRAZENÍ A MODÁLY ---

  showLibraryView() {
    tracker.stopSession();
    this.closeDrawer("toc");
    this.closeDrawer("settings");
    this.closeStatsModal();
    document.body.classList.remove("immersive-reading");
    document.body.classList.remove("in-reader-view");
    document.body.classList.remove("reader-chrome-hidden");
    this.dom.viewReader.classList.add("is-hidden");
    this.dom.viewLibrary.classList.remove("is-hidden");
    this.ruler.setEnabled(false);
    this.renderLibrary();
  }

  showReaderView() {
    this.closeDrawer("toc");
    this.closeDrawer("settings");
    this.dom.viewLibrary.classList.add("is-hidden");
    this.dom.viewReader.classList.remove("is-hidden");
    document.body.classList.add("in-reader-view");
    document.body.classList.toggle("show-footer-bar", this.settings.showFooterBar !== false);
    document.body.classList.remove("reader-chrome-hidden");
    if (this.settings.ruler.enabled) {
      this.ruler.setEnabled(true);
    }
    this.updateTouchZonesUI();
    this.renderScrubberTicks();
    this.updateScrubberUI();
  }

  toggleDrawer(name) {
    if (name === "toc") {
      const willOpen = !this.dom.tocDrawer?.classList.contains("open");
      this.dom.tocDrawer?.classList.toggle("open", willOpen);
      this.dom.settingsDrawer?.classList.remove("open");
      this.dom.searchDrawer?.classList.remove("open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.toggle("active", willOpen);
      }
    } else if (name === "settings") {
      const willOpen = !this.dom.settingsDrawer?.classList.contains("open");
      this.dom.settingsDrawer?.classList.toggle("open", willOpen);
      this.dom.tocDrawer?.classList.remove("open");
      this.dom.searchDrawer?.classList.remove("open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.toggle("active", willOpen);
      }
    } else if (name === "search") {
      const willOpen = !this.dom.searchDrawer?.classList.contains("open");
      this.dom.searchDrawer?.classList.toggle("open", willOpen);
      this.dom.tocDrawer?.classList.remove("open");
      this.dom.settingsDrawer?.classList.remove("open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.toggle("active", willOpen);
      }
      if (willOpen && this.dom.inputBookSearch) {
        setTimeout(() => {
          this.dom.inputBookSearch.focus();
          this.dom.inputBookSearch.select();
        }, 120);
      }
    }
  }

  closeDrawer(name) {
    if (name === "toc" && this.dom.tocDrawer) this.dom.tocDrawer.classList.remove("open");
    if (name === "settings" && this.dom.settingsDrawer) this.dom.settingsDrawer.classList.remove("open");
    if (name === "search" && this.dom.searchDrawer) this.dom.searchDrawer.classList.remove("open");
    const isAnyOpen = (this.dom.tocDrawer && this.dom.tocDrawer.classList.contains("open")) ||
                      (this.dom.settingsDrawer && this.dom.settingsDrawer.classList.contains("open")) ||
                      (this.dom.searchDrawer && this.dom.searchDrawer.classList.contains("open"));
    if (this.dom.drawerBackdrop) {
      this.dom.drawerBackdrop.classList.toggle("active", isAnyOpen);
    }
  }

  // --- VYHLEDÁVÁNÍ V KNIZE ---

  handleSearchInput() {
    const query = this.dom.inputBookSearch ? this.dom.inputBookSearch.value : "";
    if (this.dom.btnClearSearch) {
      this.dom.btnClearSearch.classList.toggle("is-hidden", !query.trim());
    }
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.executeSearch();
    }, 280);
  }

  clearSearch() {
    if (this.dom.inputBookSearch) {
      this.dom.inputBookSearch.value = "";
      this.dom.inputBookSearch.focus();
    }
    if (this.dom.btnClearSearch) {
      this.dom.btnClearSearch.classList.add("is-hidden");
    }
    if (this.dom.searchResultsInfo) {
      this.dom.searchResultsInfo.classList.add("is-hidden");
      this.dom.searchResultsInfo.textContent = "";
    }
    if (this.dom.searchResultsList) {
      this.dom.searchResultsList.innerHTML = `
        <div class="search-empty-state">
          <div class="search-empty-icon">🔍</div>
          <p>Zadejte hledaný výraz...</p>
        </div>
      `;
    }
  }

  async getChapterSearchData(index) {
    if (!this.searchIndexCache) this.searchIndexCache = new Map();
    if (this.searchIndexCache.has(index)) {
      return this.searchIndexCache.get(index);
    }
    if (!this.currentParser || !this.currentParser.spine || !this.currentParser.spine[index]) {
      return null;
    }
    const spineEntry = this.currentParser.spine[index];
    try {
      const rawHtml = await this.currentParser.archive.getFileAsText(spineEntry.fullPath);
      const doc = new DOMParser().parseFromString(rawHtml, "text/html");
      const body = doc.body || doc.documentElement;
      const text = (body ? body.textContent || "" : "").replace(/\s+/g, " ").trim();

      let title = `Kapitola ${index + 1}`;
      const h = body.querySelector("h1, h2, h3");
      if (h && h.textContent.trim()) {
        title = h.textContent.trim();
      } else if (this.currentParser.toc) {
        const cleanPath = spineEntry.fullPath.split("#")[0].split("?")[0];
        const matched = this.currentParser.toc.find(t => {
          if (!t || !t.fullHref) return false;
          return t.fullHref.split("#")[0].split("?")[0] === cleanPath;
        });
        if (matched) title = matched.title;
      }
      const data = { index, title, text };
      this.searchIndexCache.set(index, data);
      return data;
    } catch (e) {
      console.warn("Chyba při čtení textu kapitoly pro vyhledávání:", e);
      return null;
    }
  }

  async executeSearch() {
    if (!this.currentParser || !this.currentParser.spine) return;
    const query = this.dom.inputBookSearch ? this.dom.inputBookSearch.value.trim() : "";

    if (!query || query.length < 2) {
      if (this.dom.searchResultsInfo) this.dom.searchResultsInfo.classList.add("is-hidden");
      if (this.dom.searchResultsList) {
        this.dom.searchResultsList.innerHTML = `
          <div class="search-empty-state">
            <div class="search-empty-icon">🔍</div>
            <p>Zadejte alespoň 2 znaky pro vyhledávání...</p>
          </div>
        `;
      }
      return;
    }

    if (this.dom.searchResultsInfo) {
      this.dom.searchResultsInfo.classList.remove("is-hidden");
      this.dom.searchResultsInfo.textContent = "Hledám...";
    }
    if (this.dom.searchResultsList) {
      this.dom.searchResultsList.innerHTML = `
        <div class="search-empty-state">
          <p>Prohledávám knihu...</p>
        </div>
      `;
    }

    const lowerQuery = query.toLowerCase();
    const escapeHtml = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const matches = [];
    const MAX_MATCHES = 60;

    for (let i = 0; i < this.currentParser.spine.length; i++) {
      if (matches.length >= MAX_MATCHES) break;
      const chapterData = await this.getChapterSearchData(i);
      if (!chapterData || !chapterData.text) continue;

      const lowerText = chapterData.text.toLowerCase();
      let startIdx = 0;

      while (startIdx < lowerText.length && matches.length < MAX_MATCHES) {
        const foundPos = lowerText.indexOf(lowerQuery, startIdx);
        if (foundPos === -1) break;

        const snippetStart = Math.max(0, foundPos - 40);
        const snippetEnd = Math.min(chapterData.text.length, foundPos + query.length + 50);
        let before = chapterData.text.substring(snippetStart, foundPos);
        let match = chapterData.text.substring(foundPos, foundPos + query.length);
        let after = chapterData.text.substring(foundPos + query.length, snippetEnd);

        if (snippetStart > 0) before = "…" + before;
        if (snippetEnd < chapterData.text.length) after = after + "…";

        const snippetHtml = `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;

        matches.push({
          chapterIndex: i,
          chapterTitle: chapterData.title,
          snippetHtml,
          query
        });

        startIdx = foundPos + Math.max(1, query.length);
      }
    }

    this.renderSearchResults(matches, query);
  }

  renderSearchResults(matches, query) {
    const escapeHtml = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!this.dom.searchResultsList) return;

    if (!matches || matches.length === 0) {
      if (this.dom.searchResultsInfo) {
        this.dom.searchResultsInfo.classList.add("is-hidden");
      }
      this.dom.searchResultsList.innerHTML = `
        <div class="search-empty-state">
          <div class="search-empty-icon">❌</div>
          <p>Nebyly nalezeny žádné výsledky pro „${escapeHtml(query)}“</p>
        </div>
      `;
      return;
    }

    if (this.dom.searchResultsInfo) {
      this.dom.searchResultsInfo.classList.remove("is-hidden");
      const count = matches.length;
      const label = count === 1 ? "1 výskyt" : (count >= 2 && count <= 4 ? `${count} výskyty` : `${count} výskytů`);
      this.dom.searchResultsInfo.textContent = `Nalezeno: ${label}`;
    }

    let html = "";
    matches.forEach(m => {
      html += `
        <div class="search-result-item" data-chapter="${m.chapterIndex}" data-query="${escapeHtml(m.query)}">
          <div class="search-res-chapter">${escapeHtml(m.chapterTitle)}</div>
          <div class="search-res-snippet">${m.snippetHtml}</div>
        </div>
      `;
    });
    this.dom.searchResultsList.innerHTML = html;
  }

  async navigateToSearchResult(chapterIndex, matchQuery) {
    this.closeDrawer("search");
    if (this.currentChapterIndex !== chapterIndex) {
      await tracker.flushSession();
      this.currentChapterIndex = chapterIndex;
      await this.loadCurrentChapter(0);
    }
    if (matchQuery) {
      this.locateAndScrollToSearchQuery(matchQuery);
    }
  }

  locateAndScrollToSearchQuery(query) {
    if (!query || !this.dom.readerContent || !this.dom.pagedStage) return;
    const stageWidth = this.dom.pagedStage.clientWidth || 700;
    const stageRect = this.dom.pagedStage.getBoundingClientRect();
    const gap = this.pageGap || 50;
    const lowerQ = query.toLowerCase();

    // Vyhledání textového uzlu v načtené kapitole
    const walker = document.createTreeWalker(this.dom.readerContent, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let foundParent = null;

    while (node = walker.nextNode()) {
      if (node.textContent.toLowerCase().includes(lowerQ)) {
        foundParent = node.parentElement;
        break;
      }
    }

    if (!foundParent) {
      const candidates = this.dom.readerContent.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, span");
      for (const el of candidates) {
        if (el.textContent.toLowerCase().includes(lowerQ)) {
          foundParent = el;
          break;
        }
      }
    }

    if (foundParent) {
      const rect = foundParent.getBoundingClientRect();
      const currentOffset = this.currentPageIndex * (stageWidth + gap);
      const relativeX = (rect.left - stageRect.left) + currentOffset;
      const targetPage = Math.max(0, Math.min(this.totalPagesInChapter - 1, Math.floor(relativeX / (stageWidth + gap))));

      this.goToPage(targetPage);
      foundParent.classList.add("search-highlight-flash");
      setTimeout(() => foundParent.classList.remove("search-highlight-flash"), 2200);
    }
  }

  async openStatsModal() {
    if (this.dom.statsModal) this.dom.statsModal.classList.add("open");
    const stats = await ReadingTracker.computeGlobalStats();

    if (this.dom.statTotalTime) this.dom.statTotalTime.textContent = stats.totalTimeFormatted;
    if (this.dom.statAvgWpm) this.dom.statAvgWpm.textContent = `${stats.averageWpm} WPM`;
    if (this.dom.statTotalWords) this.dom.statTotalWords.textContent = stats.totalWords.toLocaleString("cs-CZ");
    if (this.dom.statStreak) this.dom.statStreak.textContent = `${stats.streak} ${stats.streak === 1 ? "den" : (stats.streak >= 2 && stats.streak <= 4 ? "dny" : "dní")}`;

    // Vykreslení grafů
    if (this.dom.dailyChartContainer) StatsCharts.renderDailyActivityChart(this.dom.dailyChartContainer, stats.last7Days);
    if (this.dom.wpmChartContainer) StatsCharts.renderWpmProgressChart(this.dom.wpmChartContainer, stats.wpmHistory, stats.averageWpm);
  }

  closeStatsModal() {
    if (this.dom.statsModal) this.dom.statsModal.classList.remove("open");
  }

  showToast(message, type = "info") {
    const toast = this.dom.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast toast-${type} is-visible`;
    setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 3200);
  }

  isCenterTap(clientX, clientY) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (clientY < 65 || clientY > h - 70) return false;
    return clientX >= w * 0.20 && clientX <= w * 0.80;
  }

  toggleReaderChrome(force) {
    const isHidden = document.body.classList.contains("reader-chrome-hidden");
    const willHide = (force !== undefined) ? !force : !isHidden;
    document.body.classList.toggle("reader-chrome-hidden", willHide);
  }

  getBookMetrics() {
    const totalChapters = this.currentParser?.spine?.length || 1;
    const currChapterPage = this.currentPageIndex + 1;
    const totalChapterPages = Math.max(1, this.totalPagesInChapter || 1);

    const chapterPageCounts = [];
    const chapterStarts = [];
    let beforePages = 0;
    let allPages = 0;

    const hasWordCounts = !!(this.bookWordCounts?.chapterWords?.length);
    const currentChapterWords = hasWordCounts ? (this.bookWordCounts.chapterWords[this.currentChapterIndex] || 250) : 250;
    const wordsPerPage = Math.max(1, Math.round(currentChapterWords / totalChapterPages));

    for (let i = 0; i < totalChapters; i++) {
      let chPages = totalChapterPages;
      if (hasWordCounts) {
        const chWords = this.bookWordCounts.chapterWords[i] || 250;
        chPages = (i === this.currentChapterIndex) ? totalChapterPages : Math.max(1, Math.round(chWords / wordsPerPage));
      }
      chapterPageCounts.push(chPages);
      chapterStarts.push(allPages + 1);
      if (i < this.currentChapterIndex) {
        beforePages += chPages;
      }
      allPages += chPages;
    }

    const currBookPage = Math.max(1, beforePages + currChapterPage);
    const totalBookPages = Math.max(1, allPages);

    return {
      currBookPage,
      totalBookPages,
      chapterStarts,
      chapterPageCounts,
      totalChapters
    };
  }

  resolveBookPage(targetBookPage) {
    const metrics = this.getBookMetrics();
    const clamped = Math.max(1, Math.min(metrics.totalBookPages, Math.round(targetBookPage)));
    let chapterIndex = 0;
    let pageInChapter = 0;

    for (let i = metrics.chapterStarts.length - 1; i >= 0; i--) {
      if (clamped >= metrics.chapterStarts[i]) {
        chapterIndex = i;
        pageInChapter = clamped - metrics.chapterStarts[i];
        break;
      }
    }

    let chapterTitle = "";
    if (this.currentParser?.spine && this.currentParser.spine[chapterIndex]) {
      const sp = this.currentParser.spine[chapterIndex];
      chapterTitle = sp.title || `Kapitola ${chapterIndex + 1}`;
    } else {
      chapterTitle = `Kapitola ${chapterIndex + 1}`;
    }

    return {
      targetBookPage: clamped,
      chapterIndex,
      pageInChapter,
      chapterTitle,
      totalBookPages: metrics.totalBookPages
    };
  }

  async goToBookPage(targetBookPage) {
    const resolved = this.resolveBookPage(targetBookPage);
    if (resolved.chapterIndex === this.currentChapterIndex) {
      this.goToPage(resolved.pageInChapter);
    } else {
      await tracker.flushSession();
      this.currentChapterIndex = resolved.chapterIndex;
      await this.loadCurrentChapter(resolved.pageInChapter);
    }
  }

  renderScrubberTicks() {
    if (!this.dom.scrubberChapterTicks) return;
    this.dom.scrubberChapterTicks.innerHTML = "";
    const metrics = this.getBookMetrics();
    if (metrics.totalChapters <= 1 || metrics.totalBookPages <= 1) return;

    const frag = document.createDocumentFragment();
    for (let i = 1; i < metrics.totalChapters; i++) {
      const startPage = metrics.chapterStarts[i];
      const percent = ((startPage - 1) / metrics.totalBookPages) * 100;
      if (percent > 0.5 && percent < 99.5) {
        const tick = document.createElement("div");
        tick.className = "scrubber-tick";
        tick.style.left = `${percent.toFixed(2)}%`;
        frag.appendChild(tick);
      }
    }
    this.dom.scrubberChapterTicks.appendChild(frag);
  }

  updateScrubberUI(customPercent = null, customTooltip = null) {
    const metrics = this.getBookMetrics();
    const percent = customPercent !== null ? customPercent : (metrics.totalBookPages > 0 ? (metrics.currBookPage / metrics.totalBookPages) * 100 : 0);
    const clampedPercent = Math.max(0, Math.min(100, percent));

    if (this.dom.scrubberProgressFill) {
      this.dom.scrubberProgressFill.style.width = `${clampedPercent}%`;
    }
    if (this.dom.scrubberThumb) {
      this.dom.scrubberThumb.style.left = `${clampedPercent}%`;
      this.dom.scrubberThumb.setAttribute("aria-valuemin", "1");
      this.dom.scrubberThumb.setAttribute("aria-valuemax", String(metrics.totalBookPages));
      this.dom.scrubberThumb.setAttribute("aria-valuenow", String(metrics.currBookPage));
    }
    if (this.dom.scrubberTooltip) {
      if (customTooltip) {
        this.dom.scrubberTooltip.textContent = customTooltip;
      }
      this.dom.scrubberTooltip.style.left = `${clampedPercent}%`;
    }
    if (this.dom.footerTitleText) {
      const currentChapterTitle = (this.currentParser?.spine && this.currentParser.spine[this.currentChapterIndex]?.title)
        || this.currentBook?.title
        || `Kapitola ${this.currentChapterIndex + 1}`;
      this.dom.footerTitleText.textContent = currentChapterTitle;
      if (this.dom.pagedFooterBar) {
        this.dom.pagedFooterBar.setAttribute("title", currentChapterTitle);
      }
    }
    if (this.dom.footerEtrText) {
      if (tracker.currentChapterWords) {
        const remainingWords = Math.round(tracker.currentChapterWords * (1 - tracker.currentScrollPercent));
        const minutesLeft = tracker.getEstimatedMinutesRemaining(remainingWords);
        this.dom.footerEtrText.textContent = `Zbývá ${minutesLeft} min`;
        this.dom.footerEtrText.style.display = "inline";
        if (this.dom.footerEtrSeparator) this.dom.footerEtrSeparator.style.display = "inline";
      } else {
        this.dom.footerEtrText.style.display = "none";
        if (this.dom.footerEtrSeparator) this.dom.footerEtrSeparator.style.display = "none";
      }
    }
  }

  initScrubber() {
    const scrubber = this.dom.readingScrubber;
    if (!scrubber) return;

    let isScrubbing = false;
    let pendingTargetPage = null;
    let throttleTimer = null;

    const getRatioFromEvent = (e) => {
      const track = this.dom.scrubberTrack || scrubber;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
      const x = clientX - rect.left;
      return Math.max(0, Math.min(1, x / rect.width));
    };

    const updateOnDrag = (e) => {
      const ratio = getRatioFromEvent(e);
      const metrics = this.getBookMetrics();
      const targetPage = Math.max(1, Math.min(metrics.totalBookPages, Math.round(ratio * metrics.totalBookPages)));
      pendingTargetPage = targetPage;

      const resolved = this.resolveBookPage(targetPage);
      const tooltipText = `Strana ${resolved.targetBookPage} / ${resolved.chapterTitle}`;
      const percent = ratio * 100;

      this.updateScrubberUI(percent, tooltipText);

      // Pokud se posouváme v rámci aktuální kapitoly, plynule aktualizujeme stránku
      if (resolved.chapterIndex === this.currentChapterIndex) {
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            if (isScrubbing && resolved.chapterIndex === this.currentChapterIndex) {
              this.goToPage(resolved.pageInChapter);
            }
          }, 60);
        }
      }
    };

    const onPointerDown = (e) => {
      e.stopPropagation();
      e.preventDefault();

      isScrubbing = true;
      scrubber.classList.add("is-dragging");

      try {
        scrubber.setPointerCapture(e.pointerId);
      } catch (err) {}

      updateOnDrag(e);
    };

    const onPointerMove = (e) => {
      if (!isScrubbing) return;
      e.stopPropagation();
      e.preventDefault();
      updateOnDrag(e);
    };

    const onPointerUp = async (e) => {
      if (!isScrubbing) return;
      isScrubbing = false;
      scrubber.classList.remove("is-dragging");

      try {
        scrubber.releasePointerCapture(e.pointerId);
      } catch (err) {}

      e.stopPropagation();
      e.preventDefault();

      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }

      if (pendingTargetPage !== null) {
        const pageToNav = pendingTargetPage;
        pendingTargetPage = null;
        await this.goToBookPage(pageToNav);
      }
    };

    scrubber.addEventListener("pointerdown", onPointerDown);
    scrubber.addEventListener("pointermove", onPointerMove);
    scrubber.addEventListener("pointerup", onPointerUp);
    scrubber.addEventListener("pointercancel", onPointerUp);

    // Klávesové ovládání při fokusu běžce
    if (this.dom.scrubberThumb) {
      this.dom.scrubberThumb.addEventListener("keydown", async (e) => {
        const metrics = this.getBookMetrics();
        if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          await this.goToBookPage(metrics.currBookPage + 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          await this.goToBookPage(metrics.currBookPage - 1);
        }
      });
    }

    // Klepnutí na název kapitoly vlevo otevře obsah knihy
    if (this.dom.footerTitleText) {
      this.dom.footerTitleText.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleDrawer("toc");
      });
    }
  }

  blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// Spuštění aplikace po načtení DOM
document.addEventListener("DOMContentLoaded", () => {
  const app = new LuminaApp();
  app.init();
  window.luminaApp = app;
});
