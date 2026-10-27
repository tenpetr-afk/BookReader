/**
 * app.js - Hlavní řídicí logika aplikace LuminaReader.
 * Spojuje knihovnu, EPUB parser, čtečku, měřič rychlosti (tracker),
 * pravítko (ruler) a statistické dashboardy do jednoho celku.
 */

import { storage, computeFileHash } from "./storage.js";
import { EpubParser } from "./epub-parser.js";
import { PDFLoader } from "./pdf-loader.js";
import { tracker, ReadingTracker } from "./tracker.js";
import { ReadingRuler } from "./ruler.js";
import { StatsCharts } from "./charts.js";
import { supabaseSync } from "./supabase-sync.js";
import { supabase } from "./supabase-client.js";

export const APP_VERSION = "v1.21.0";

const HTML_BIONIC_REGEX = /(<(?:script|style|code|pre|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|code|pre|svg)>|<b\b[^>]*class=["'][^"']*bionic-(?:fixation|bold)[^"']*["'][^>]*>[\s\S]*?<\/b>|<!--[\s\S]*?-->|<[^>]+>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)|([\p{L}\p{N}]+)/giu;
const BIONIC_BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt";

export class LuminaApp {
  constructor() {
    this.currentBook = null;
    this.currentParser = null;
    this.pdfLoader = null;
    this.isPdfMode = false;
    this.isImageOnlyPdf = false;
    this._savedRulerSettings = null;
    this.currentChapterIndex = 0;
    this.currentPageIndex = 0;
    this.totalPagesInChapter = 1;
    this.bookPagination = null;
    this.bookWordCounts = null;
    this.pageGap = 50;
    this.settings = storage.getSettings();
    this.ruler = null;
    this.isImporting = false;

    // Ochrana proti přeskakování stránek při gestech (vždy jen 1 strana na jedno gesto)
    this.lastPageTurnTime = 0;
    this.PAGE_TURN_COOLDOWN = 60; // ms
    this.saveProgressTimer = null;

    // Ochrana proti syntetickým gestům po přechodu strany na iPadu
    this.isNavigating = false;
    this.isNavigatingPage = false;
    this.isLineLocked = false;
    this.navigatingPageTimer = null;
    this._navSafetyTimer = null;

    // Směr čtení (horizontal paged vs continuous vertical scroll)
    this.readingMode = localStorage.getItem("lumina_reading_mode") || "horizontal";
    this._verticalScrollBound = false;

    // Kontinuální vertikální čtení kapitol & Viewport-only Bionic cache
    this._chapterDataCache = new Map();
    this._bionicHtmlCache = new Map();
    this._originalBlockHtml = new WeakMap();
    this._bionicBlockHtml = new WeakMap();
    this._bionicIdleCallbackId = null;
    this._isLoadingNextChapter = false;
    this._isLoadingPrevChapter = false;
    this._isModeTransitioning = false;

    // DOM elementy
    this.dom = {};
  }

  async init() {
    // 1. Spolehlivé a okamžité nastavení verze aplikace
    try {
      const versionEl = document.getElementById("app-version-badge");
      if (versionEl) {
        versionEl.textContent = APP_VERSION;
      }
    } catch (e) {
      console.warn("[LuminaApp] Chyba při nastavování version badge:", e);
    }

    try {
      this.cacheDom();
    } catch (e) {
      console.error("[LuminaApp] Chyba při cacheDom:", e);
    }

    if (this.dom.versionBadge) {
      this.dom.versionBadge.textContent = APP_VERSION;
    }

    try {
      const isInReader = this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden");
      if (isInReader) {
        document.body.classList.add("in-reader-view");
      } else {
        document.body.classList.remove("in-reader-view");
      }
    } catch (_) {}

    // 2. Nastavení a pravítko
    try {
      this.applySettings();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při aplikování nastavení:", e);
    }

    try {
      this.initRuler();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při inicializaci pravítka:", e);
    }

    // 3. Klíčové navázání událostí - MUSÍ proběhnout vždy, aby tlačítka nezůstala hluchá
    try {
      this.bindEvents();
    } catch (e) {
      console.error("[LuminaApp] Kritická chyba při bindEvents:", e);
    }

    try {
      this.initScrubber();
      this.initPillScrubber();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při inicializaci scrubberu:", e);
    }

    try {
      this.bindKeyboardShortcuts();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při bindování klávesových zkratek:", e);
    }

    try {
      this.initCloudSync();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při inicializaci cloud sync:", e);
    }

    // 4. Automatická kontrola a migrace statistik v IndexedDB
    try {
      await storage.sanitizeCorruptedStats();
    } catch (e) {
      console.warn("[LuminaApp] Chyba při startovní kontrole integrity statistik:", e);
    }

    // 5. Načíst knihy z IndexedDB s bezpečnou cloudovou hydratací
    let books = [];
    try {
      books = await storage.getAllBooks();
    } catch (dbErr) {
      console.error("[LuminaApp] Chyba při načítání knih z IndexedDB:", dbErr);
      books = [];
    }

    try {
      if (books.length === 0) {
        let cloudLoaded = false;
        if (supabaseSync && typeof supabaseSync.isOnline === "function" && supabaseSync.isOnline()) {
          try {
            await this.loadLibrary();
            books = await storage.getAllBooks();
            if (books && books.length > 0) cloudLoaded = true;
          } catch (e) {
            console.warn("[Supabase Sync] Nepodařilo se hydratovat knihy z cloudu:", e);
          }
        }
        if (!cloudLoaded && (!books || books.length === 0)) {
          // Automaticky nabídnout nebo nahrát vzorovou knihu
          try {
            await this.loadBundledSampleBook();
            books = await storage.getAllBooks();
          } catch (sampleErr) {
            console.warn("[LuminaApp] Nepodařilo se načíst vzorovou knihu:", sampleErr);
          }
        }
      }
    } catch (loadErr) {
      console.warn("[LuminaApp] Chyba při synchronizaci/načítání výchozí knihovny:", loadErr);
    }

    // 6. Vykreslit knihovnu (vždy zobrazit existující knihy nebo prázdný stav)
    try {
      await this.renderLibrary();
    } catch (renderErr) {
      console.error("[LuminaApp] Chyba při renderLibrary:", renderErr);
    }

    // 7. Spuštění asynchronní synchronizace s cloudem v pozadí (neblokující)
    try {
      setTimeout(() => {
        try {
          this.syncWithCloud(false).catch(err => {
            console.warn("[LuminaApp] Chyba při tiché synchronizaci na pozadí:", err);
          });
        } catch (_) {}
      }, 1000);
    } catch (_) {}

    // 8. Zkontrolovat naposledy čtenou knihu a obnovit stav čtení při znovunačtení
    try {
      const lastBookId = storage.getLastActiveBookId();
      const activeView = localStorage.getItem("lumina_active_view");
      if (lastBookId && books && books.some(b => b.id === lastBookId)) {
        if (activeView === "reader") {
          await this.openBook(lastBookId);
        }
      }
    } catch (restoreErr) {
      console.warn("[LuminaApp] Chyba při obnovení rozečtené knihy:", restoreErr);
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
      btnCloudSync: document.getElementById("btn-cloud-sync"),
      syncStatusText: document.getElementById("sync-status-text"),
      syncStatusDot: document.getElementById("sync-status-dot"),
      drawerBackdrop: document.getElementById("drawer-backdrop"),
      versionBadge: document.getElementById("app-version-badge"),

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
      
      // Navigace ve čtečce a spodní lišta (nové rozložení)
      footerRemainingChapter: document.getElementById("footer-remaining-chapter"),
      footerBookPages: document.getElementById("footer-book-pages"),
      footerActionsGroup: document.getElementById("footer-actions-group"),
      rulerToggleBtn: document.getElementById("ruler-toggle-btn") || document.getElementById("ruler-split-pill"),
      rulerSplitPill: document.getElementById("ruler-toggle-btn") || document.getElementById("ruler-split-pill"),
      btnReaderMenuFab: document.getElementById("btn-reader-menu-fab"),
      readerFloatingDock: document.getElementById("reader-floating-dock"),
      btnMenuSettings: document.getElementById("btn-menu-settings"),
      btnMenuStats: document.getElementById("btn-menu-stats"),
      btnMenuToc: document.getElementById("btn-menu-toc"),
      pillScrubberContainer: document.getElementById("pill-scrubber-container"),
      pillScrubberFill: document.getElementById("pill-scrubber-fill"),
      pillScrubberLabel: document.getElementById("pill-scrubber-label"),
      pillScrubberPrefix: document.getElementById("pill-scrubber-prefix"),
      pillScrubberSeparator: document.getElementById("pill-scrubber-separator"),
      pillScrubberPercent: document.getElementById("pill-scrubber-percent"),
      pillScrubberTooltip: document.getElementById("pill-scrubber-tooltip"),
      pillScrubberTooltipText: document.getElementById("pill-scrubber-tooltip-text"),
      btnMenuSearch: document.getElementById("btn-menu-search"),
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
      tabBtnFont: document.getElementById("tab-btn-font"),
      tabPaneFont: document.getElementById("tab-pane-font"),
      tabBtnAppearance: document.getElementById("tab-btn-appearance"),
      tabPaneAppearance: document.getElementById("tab-pane-appearance"),
      tabBtnReading: document.getElementById("tab-btn-reading"),
      tabPaneReading: document.getElementById("tab-pane-reading"),
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
      btnRecalcStats: document.getElementById("btn-recalc-stats"),
      btnResetStats: document.getElementById("btn-reset-stats"),

      // Intra-session analytics elementy
      sessionAnalyticsSection: document.getElementById("session-analytics-section"),
      sessionPickerSelect: document.getElementById("session-picker-select"),
      sessionBadgeDuration: document.getElementById("session-badge-duration"),
      sessionBadgePeakWpm: document.getElementById("session-badge-peak-wpm"),
      sessionBadgeAvgWpm: document.getElementById("session-badge-avg-wpm"),
      sessionBadgeWords: document.getElementById("session-badge-words"),
      sessionTimelineChartContainer: document.getElementById("session-timeline-chart-container"),
      sessionHistoryDetails: document.getElementById("session-history-details"),
      sessionHistoryList: document.getElementById("session-history-list"),
      sessionCountBadge: document.getElementById("session-count-badge"),

      // Nastavení elementy
      themeSelects: document.querySelectorAll("[data-theme]"),
      fontDropdownWrapper: document.getElementById("font-dropdown-wrapper"),
      fontDropdownTrigger: document.getElementById("font-dropdown-trigger"),
      fontDropdownCurrent: document.getElementById("font-dropdown-current"),
      fontDropdownMenu: document.getElementById("font-dropdown-menu"),
      fontSelects: document.querySelectorAll(".font-dropdown-item[data-font], [data-font]"),
      settingFastReading: document.getElementById("setting-fast-reading"),
      sliderFontSize: document.getElementById("slider-font-size"),
      valFontSize: document.getElementById("val-font-size"),
      sliderPageMargin: document.getElementById("slider-page-margin"),
      valPageMargin: document.getElementById("val-page-margin"),
      columnSelects: document.querySelectorAll("[data-columns]"),
      sliderLineHeight: document.getElementById("slider-line-height"),
      valLineHeight: document.getElementById("val-line-height"),
      sliderLetterSpacing: document.getElementById("slider-letter-spacing"),
      valLetterSpacing: document.getElementById("val-letter-spacing"),
      sliderWordSpacing: document.getElementById("slider-word-spacing"),
      valWordSpacing: document.getElementById("val-word-spacing"),
      sliderContentWidth: document.getElementById("slider-content-width"),
      valContentWidth: document.getElementById("val-content-width"),
      btnAlignLeft: document.getElementById("btn-align-left"),
      btnAlignJustify: document.getElementById("btn-align-justify"),

      // Pravítko nastavení
      rulerToggle: document.getElementById("ruler-toggle-setting"),
      rulerSnapSetting: document.getElementById("setting-ruler-snap") || document.getElementById("ruler-snap-setting"),
      rulerWordTrackingSetting: document.getElementById("ruler-word-tracking-setting"),
      settingPencilFlick: document.getElementById("setting-pencil-flick"),
      rulerAutoHeightSetting: document.getElementById("ruler-auto-height-setting"),
      settingRulerHeightContainer: document.getElementById("setting-ruler-height-container"),
      rulerModeSelects: document.querySelectorAll("[data-ruler-mode]"),
      rulerColorSelects: document.querySelectorAll("#settings-drawer [data-ruler-color]"),
      sliderRulerHeight: document.getElementById("slider-ruler-height"),
      valRulerHeight: document.getElementById("val-ruler-height"),
      sliderRulerOpacity: document.getElementById("slider-ruler-opacity"),
      valRulerOpacity: document.getElementById("val-ruler-opacity"),
      rulerFollowSelect: document.getElementById("ruler-follow-select"),
      rulerFollowButtons: document.querySelectorAll("[data-ruler-follow]"),

      // Rychlé nastavení pravítka v záhlaví (popover)
      rulerBtnGroup: document.getElementById("ruler-btn-group"),
      btnRulerQuickMenu: document.getElementById("btn-ruler-quick-menu"),
      rulerQuickPopover: document.getElementById("ruler-quick-popover"),
      popoverModeLine: document.getElementById("popover-mode-line"),
      popoverModeWord: document.getElementById("popover-mode-word"),
      popoverStyleButtons: document.querySelectorAll("#ruler-quick-popover [data-ruler-style]"),
      popoverColorButtons: document.querySelectorAll("#ruler-quick-popover [data-ruler-color]"),
      popoverRulerSnapToggle: document.getElementById("popover-ruler-snap") || document.getElementById("popover-ruler-snap-toggle"),
      popoverRulerAutoHeightToggle: document.getElementById("popover-ruler-auto-height-toggle"),
      popoverSettingRulerHeightContainer: document.getElementById("popover-setting-ruler-height-container"),
      popoverSliderRulerHeight: document.getElementById("popover-slider-ruler-height"),
      popoverValRulerHeight: document.getElementById("popover-val-ruler-height"),
      popoverSliderRulerOpacity: document.getElementById("popover-slider-ruler-opacity"),
      popoverValRulerOpacity: document.getElementById("popover-val-ruler-opacity"),
      popoverRulerFollowSelect: document.getElementById("popover-ruler-follow-select"),

      // Sekce pravítka pro kontextovou viditelnost
      popoverFollowSection: document.getElementById("popover-follow-section"),
      settingsFollowSection: document.getElementById("settings-follow-section"),
      popoverSnapLinesSection: document.getElementById("popover-snap-lines-section"),
      drawerSnapLinesSection: document.getElementById("drawer-snap-lines-section"),
      popoverRulerModeSection: document.getElementById("popover-ruler-mode-section"),
      drawerWordTrackingSection: document.getElementById("drawer-word-tracking-section"),
      popoverModeSegmented: document.getElementById("popover-mode-segmented"),
      popoverRulerColorSection: document.getElementById("popover-ruler-color-section"),
      popoverRulerOpacitySection: document.getElementById("popover-ruler-opacity-section"),
      drawerRulerColorSection: document.getElementById("drawer-ruler-color-section"),
      drawerRulerOpacitySection: document.getElementById("drawer-ruler-opacity-section"),

      // Kalibrace pravítka pro PDF (popover & drawer)
      popoverPdfRulerSection: document.getElementById("popover-pdf-ruler-section"),
      popoverPdfAutoHeight: document.getElementById("popover-pdf-auto-height"),
      popoverPdfAutoHeightRow: document.getElementById("popover-pdf-auto-height-row"),
      popoverPdfHeightContainer: document.getElementById("popover-pdf-height-container"),
      popoverSliderPdfHeight: document.getElementById("popover-slider-pdf-height"),
      popoverValPdfHeight: document.getElementById("popover-val-pdf-height"),
      drawerPdfRulerSection: document.getElementById("drawer-pdf-ruler-section"),
      settingPdfAutoHeight: document.getElementById("setting-pdf-auto-height"),
      drawerPdfAutoHeightRow: document.getElementById("drawer-pdf-auto-height-row"),
      drawerPdfHeightContainer: document.getElementById("drawer-pdf-height-container"),
      sliderPdfRulerHeight: document.getElementById("slider-pdf-ruler-height"),
      valPdfRulerHeight: document.getElementById("val-pdf-ruler-height"),

      settingShowFooter: document.getElementById("setting-show-footer"),
      readingModeControl: document.getElementById("reading-mode-control"),
      readingModeSelects: document.querySelectorAll("[data-reading-mode]"),

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
      'header, nav, footer, .paged-footer-bar, .reading-scrubber, .modal, .modal-content, .settings-modal, .stats-modal, .dropdown, button, input, select, textarea, [role="button"], [role="dialog"], [role="slider"], .drawer-panel, .drawer-backdrop, .modal-overlay, .ruler-quick-popover, .ruler-btn-group, #ruler-toggle-btn, #ruler-split-pill, .split-pill-btn, #btn-toggle-ruler, #btn-ruler-quick-menu, #btn-reader-menu-fab, #reader-floating-dock, .reader-floating-dock, .dock-action-row, .dock-action-btn, #footer-remaining-chapter, #footer-book-pages, .footer-actions-group'
    );
  }

  isAnyModalOrMenuOpen() {
    if (this.dom.settingsDrawer?.classList.contains("open")) return true;
    if (this.dom.tocDrawer?.classList.contains("open")) return true;
    if (this.dom.searchDrawer?.classList.contains("open")) return true;
    if (this.dom.statsModal?.classList.contains("open")) return true;
    if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) return true;
    if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) return true;
    return false;
  }

  isUiOrOverlayEvent(e) {
    if (this.isAnyModalOrMenuOpen()) return true;
    const target = e?.target || (e?.touches && e.touches[0]?.target) || (e?.changedTouches && e.changedTouches[0]?.target);
    return this.isInteractiveOrUiElement(target);
  }

  initRuler() {
    this.ruler = new ReadingRuler(this.dom.pagedStage);
    this.ruler.app = this;
    this.ruler.readingMode = this.readingMode;

    // Kontinuální akreditace slov při posunu pravítka po řádcích a slovech
    this.wordsCreditedOnCurrentPage = 0;
    this.ruler.onProgress = (type, count) => {
      if (count > 0) {
        this.wordsCreditedOnCurrentPage = (this.wordsCreditedOnCurrentPage || 0) + count;
        tracker.attributeWords(count);
      }
    };

    // Callback pro ruler.js: vrátí true pokud je otevřen jakýkoliv panel/zásuvka,
    // aby ruler neinterferoval s kliknutím na backdrop (zavření panelu).
    this.ruler.isAnyDrawerOpen = () => this.isAnyModalOrMenuOpen();

    // Automatický přechod na další/předchozí stránku při překročení hranice textu pravítkem
    this.ruler.onBoundary = (dir) => {
      if (this.isVerticalReadingMode()) return;
      if (this.isAnyModalOrMenuOpen()) return;
      if (dir > 0) {
        this.nextPage();
      } else if (dir < 0) {
        this.prevPage();
      }
    };

    // Horizontální přejetí (swipe) zachycené pravítkem
    this.ruler.onSwipe = (dir) => {
      if (this.isVerticalReadingMode()) return;
      if (this.isAnyModalOrMenuOpen()) return;
      if (dir > 0) {
        this.nextPage();
      } else if (dir < 0) {
        this.prevPage();
      }
    };

    // Rychlé švihnutí stylusu (Apple Pencil Flick Gesture) pro okamžité otočení strany
    this.ruler.onPenFlick = (dir) => {
      if (this.isVerticalReadingMode()) return;
      if (this.isAnyModalOrMenuOpen()) return;
      if (dir > 0) {
        this.nextPage();
      } else if (dir < 0) {
        this.prevPage();
      }
    };
    this.ruler.setPenFlickEnabled(this.settings.pencilFlickNavigation !== false);

    const isInReader = this.dom.viewReader ? !this.dom.viewReader.classList.contains("is-hidden") : true;
    const showRuler = this.settings.showRulerButton !== false;
    this.ruler.setEnabled(isInReader && showRuler && this.settings.ruler.enabled);
    this.ruler.setMode(this.settings.ruler.mode);
    this.ruler.setColor(this.settings.ruler.color);
    this.ruler.setHeight(this.settings.ruler.height);
    this.ruler.setAutoHeight(true);
    const pdfAutoEnabled = typeof storage.getSetting === "function"
      ? storage.getSetting("rulerPdfAutoHeight", true)
      : (this.settings.ruler.pdfAutoHeight !== false);
    this.settings.ruler.pdfAutoHeight = pdfAutoEnabled;
    this.ruler.setPdfAutoHeight(pdfAutoEnabled);
    const snapEnabled = typeof storage.getSetting === "function" ? storage.getSetting("rulerSnapToLines", true) : (this.settings.ruler.snapToLines !== false);
    this.settings.ruler.snapToLines = snapEnabled;
    this.ruler.setSnapToLines(snapEnabled);
    this.ruler.setWordTracking(this.settings.ruler.wordTracking ?? false);
    this.ruler.setDimOpacity(this.settings.ruler.dimOpacity);
    this.ruler.setFollowMode(this.settings.ruler.followMode);

    this.updateRulerToggleButtonUI();
    this.updateTouchZonesUI();
    this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
  }

  setSwitchState(el, checked) {
    if (!el) return;
    const isChecked = !!checked;
    el.checked = isChecked;
    el.setAttribute("aria-checked", String(isChecked));
    el.classList.toggle("is-checked", isChecked);
    el.classList.toggle("active", isChecked);
  }

  resolveEffectiveColumnCount() {
    const mode = this.settings.columnsMode || "auto";
    if (mode === "1") return 1;
    if (mode === "2") return 2;
    return window.innerWidth >= 1100 ? 2 : 1;
  }

  getExactColumnStep() {
    if (!this.dom.pagedStage || !this.dom.readerContent) {
      return { stageWidth: 700, gap: 50, exactStep: 750 };
    }
    const stageRect = this.dom.pagedStage.getBoundingClientRect();
    const stageWidth = stageRect.width;

    const comp = getComputedStyle(this.dom.readerContent);
    const colGap = parseFloat(comp.columnGap);
    const gap = (!isNaN(colGap) && colGap > 0) ? colGap : (this.pageGap || 50);

    const exactStep = stageWidth + gap;
    return {
      stageWidth,
      gap,
      exactStep
    };
  }

  getPageGap() {
    return this.getExactColumnStep().gap;
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

    if ((s.theme === "dark" || s.theme === "oled") && this.isPdfMode && this.pdfLoader) {
      this.pdfLoader.ensureDarkModeImagesExtracted?.();
    }

    document.documentElement.setAttribute("data-font", s.fontFamily);

    document.documentElement.style.setProperty("--reader-font-size", `${s.fontSize}px`);
    document.documentElement.style.setProperty("--reader-line-height", s.lineHeight || 1.6);
    document.documentElement.style.setProperty("--reader-letter-spacing", `${s.letterSpacing ?? 0}px`);
    document.documentElement.style.setProperty("--reader-word-spacing", `${s.wordSpacing ?? 0}px`);
    const margin = Number(this.settings.marginPercent ?? 20);
    const stageWidthVw = `${100 - (margin * 2)}vw`;
    document.documentElement.style.setProperty('--reader-stage-width', stageWidthVw);
    const colGapVw = `${(margin * 0.25).toFixed(2)}vw`;
    document.documentElement.style.setProperty("--col-gap", colGapVw);
    document.documentElement.style.setProperty("--reader-max-width", `${s.contentWidth || 720}px`);
    document.documentElement.style.setProperty("--reader-text-align", s.textAlign || "justify");

    // Rozvržení sloupců
    const effectiveCols = this.resolveEffectiveColumnCount();
    document.documentElement.style.setProperty("--reader-column-count", effectiveCols);
    document.documentElement.classList.toggle("columns-2", effectiveCols === 2);
    if (document.body) {
      document.body.classList.toggle("columns-2", effectiveCols === 2);
    }
    if (this.dom.readerContent) {
      this.dom.readerContent.classList.toggle("columns-2", effectiveCols === 2);
    }
    if (this.dom.columnSelects) {
      const curMode = this.settings.columnsMode || "auto";
      this.dom.columnSelects.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.columns === curMode);
      });
    }

    // Synchronizace formulářů v nastavení
    if (this.dom.sliderFontSize) {
      this.dom.sliderFontSize.value = s.fontSize;
      if (this.dom.valFontSize) this.dom.valFontSize.textContent = `${s.fontSize}px`;
    }
    if (this.dom.sliderLineHeight) {
      const lh = Number(s.lineHeight ?? 1.6);
      this.dom.sliderLineHeight.value = lh;
      if (this.dom.valLineHeight) this.dom.valLineHeight.textContent = lh.toFixed(1);
    }
    if (this.dom.sliderLetterSpacing) {
      const ls = Number(s.letterSpacing ?? 0);
      this.dom.sliderLetterSpacing.value = ls;
      if (this.dom.valLetterSpacing) this.dom.valLetterSpacing.textContent = `${ls}px`;
    }
    if (this.dom.sliderWordSpacing) {
      const ws = Number(s.wordSpacing ?? 0);
      this.dom.sliderWordSpacing.value = ws;
      if (this.dom.valWordSpacing) this.dom.valWordSpacing.textContent = `${ws}px`;
    }
    if (this.dom.sliderPageMargin) {
      const marginVal = this.settings.marginPercent ?? 20;
      this.dom.sliderPageMargin.value = marginVal;
      if (this.dom.valPageMargin) this.dom.valPageMargin.textContent = `${marginVal}%`;
    }
    if (this.dom.sliderContentWidth) {
      this.dom.sliderContentWidth.value = s.contentWidth;
      if (this.dom.valContentWidth) this.dom.valContentWidth.textContent = `${s.contentWidth}px`;
    }
    const showRuler = s.showRulerButton !== false;
    this.setSwitchState(this.dom.rulerToggle, showRuler);
    const rulerContainer = this.dom.rulerToggleBtn || this.dom.rulerSplitPill;
    if (rulerContainer) {
      rulerContainer.style.display = showRuler ? "flex" : "none";
      rulerContainer.classList.toggle("is-hidden", !showRuler);
    }
    if (!showRuler && this.ruler?.enabled) {
      this.ruler.setEnabled(false);
      this.settings.ruler.enabled = false;
    }
    const snapEnabled = s.ruler.snapToLines !== false;
    if (this.dom.rulerSnapSetting) this.setSwitchState(this.dom.rulerSnapSetting, snapEnabled);
    if (this.dom.popoverRulerSnapToggle) this.setSwitchState(this.dom.popoverRulerSnapToggle, snapEnabled);
    document.querySelectorAll("#setting-ruler-snap, #ruler-snap-setting, #popover-ruler-snap, #popover-ruler-snap-toggle, [data-ruler-snap='toggle']").forEach(el => this.setSwitchState(el, snapEnabled));
    this.setSwitchState(this.dom.rulerWordTrackingSetting, s.ruler.wordTracking ?? false);
    if (this.dom.settingPencilFlick) this.setSwitchState(this.dom.settingPencilFlick, this.settings.pencilFlickNavigation !== false);
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
    if (this.dom.rulerFollowButtons) {
      this.dom.rulerFollowButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerFollow === s.ruler.followMode);
      });
    }
    this.setPdfRulerUIVisibility(this.isPdfMode);
    if (this.isPdfMode && this.currentBook?.pdfRulerConfig) {
      this.syncPdfRulerUI(this.currentBook.pdfRulerConfig);
    }
    // Tlačítka témat
    this.dom.themeSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === s.theme);
    });
    // Písma
    const fontLabels = {
      georgia: "Georgia (Serif)",
      merriweather: "Merriweather",
      lora: "Lora",
      inter: "Inter (Sans)",
      atkinson: "Atkinson Hyperlegible",
      opendyslexic: "Pro dyslexii"
    };
    const activeFont = s.fontFamily || "georgia";
    if (this.dom.fontDropdownCurrent) {
      this.dom.fontDropdownCurrent.textContent = fontLabels[activeFont] || activeFont;
      this.dom.fontDropdownCurrent.style.fontFamily = "var(--font-book)";
    }
    this.dom.fontSelects.forEach(btn => {
      const isSelected = btn.dataset.font === activeFont;
      btn.classList.toggle("active", isSelected);
      btn.setAttribute("aria-selected", isSelected ? "true" : "false");
    });
    if (this.dom.settingFastReading) {
      this.setSwitchState(this.dom.settingFastReading, !!s.fastReading);
    }
    if (this.dom.readerContent && !this.isPdfMode) {
      this.dom.readerContent.classList.toggle("bionic-active", !!s.fastReading);
    }
    // Režimy pravítka
    this.dom.rulerModeSelects.forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.rulerMode || btn.dataset.rulerStyle) === s.ruler.mode);
    });
    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.classList.toggle("active", (btn.dataset.rulerStyle || btn.dataset.rulerMode) === s.ruler.mode);
      });
    }
    // Barvy pravítka
    this.dom.rulerColorSelects.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.rulerColor === s.ruler.color);
    });

    // Zobrazení spodní lišty čtečky (postup čtení)
    const showProgressBar = localStorage.getItem('showProgressBar') !== null
      ? localStorage.getItem('showProgressBar') === 'true'
      : true; // MUST default to true for new domains/first visits
    this.settings.showFooterBar = showProgressBar;
    this.settings.showProgressBar = showProgressBar;

    document.body.classList.toggle("show-footer-bar", showProgressBar);
    document.body.classList.toggle("hide-footer-bar", !showProgressBar);
    if (this.dom.settingShowFooter) {
      this.setSwitchState(this.dom.settingShowFooter, showProgressBar);
    }

    // Synchronizace rychlého popoveru pravítka
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
    if (this.dom.popoverRulerSnapToggle) this.setSwitchState(this.dom.popoverRulerSnapToggle, s.ruler.snapToLines !== false);
    if (this.dom.popoverRulerAutoHeightToggle) this.setSwitchState(this.dom.popoverRulerAutoHeightToggle, true);
    if (this.dom.popoverSliderRulerOpacity) {
      this.dom.popoverSliderRulerOpacity.value = Math.round(s.ruler.dimOpacity * 100);
      if (this.dom.popoverValRulerOpacity) this.dom.popoverValRulerOpacity.textContent = `${Math.round(s.ruler.dimOpacity * 100)}%`;
    }
    if (this.dom.popoverRulerFollowSelect) {
      this.dom.popoverRulerFollowSelect.value = s.ruler.followMode;
    }

    // Aplikace režimu čtení (vodorovně vs svisle)
    this.applyReadingMode(this.readingMode);

    // Pokud jsme v PDF režimu, vyhneme se reflow a přepočtu EPUB stránek
    if (this.isPdfMode) {
      if (this.pdfLoader) {
        this.totalPagesInChapter = this.pdfLoader.numPages || 1;
        this.currentPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, (this.pdfLoader.currentPage || 1) - 1));
      }
      if (this.ruler && this.ruler.enabled) {
        this.ruler.updateStyles();
        this.ruler.applyPosition();
      }
      this.updatePageUI();
      this.updateTouchZonesUI();
      return;
    }

    // Pokud čteme knihu, přepočítat stránkování (pouze v horizontálním režimu pro EPUB)
    if (!this.isVerticalReadingMode() && this.currentBook && this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden")) {
      requestAnimationFrame(() => {
        this.recomputeGlobalPagination();
        this.recalcPages();
        this.goToPage(this.currentPageIndex);
        this.renderScrubberTicks();
      });
    }

    this.updateTouchZonesUI();
  }

  applyReadingMode(mode = null) {
    if (!mode) {
      mode = localStorage.getItem("lumina_reading_mode") || "horizontal";
    }
    const prevMode = this.readingMode;
    const isModeChanged = prevMode !== mode;
    this.readingMode = mode;
    try {
      localStorage.setItem("lumina_reading_mode", mode);
    } catch (e) {}

    const isVertical = mode === "vertical";
    document.body.classList.toggle("mode-vertical", isVertical);
    if (this.dom.viewReader) {
      this.dom.viewReader.classList.toggle("mode-vertical", isVertical);
    }
    if (this.dom.pagedViewport) {
      this.dom.pagedViewport.classList.toggle("mode-vertical", isVertical);
    }
    if (this.ruler) {
      this.ruler.setReadingMode?.(mode);
    }

    if (this.dom.readingModeSelects) {
      this.dom.readingModeSelects.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.readingMode === mode);
      });
    }

    if (this.dom.readerContent) {
      if (isVertical) {
        this.dom.readerContent.style.transform = "none";
      } else if (isModeChanged) {
        if (this.dom.pagedViewport) {
          this.dom.pagedViewport.scrollTop = 0;
        }
      }
    }

    if (isVertical) {
      this.bindVerticalScrollListener();
    }

    const isInReader = this.dom.viewReader ? !this.dom.viewReader.classList.contains("is-hidden") : true;

    if (this.isPdfMode && this.pdfLoader && isInReader) {
      if (isModeChanged || (mode === "vertical" && this.pdfLoader.pageContainers.size === 0)) {
        requestAnimationFrame(async () => {
          await this.pdfLoader.switchReadingMode(mode);
          this.updatePageUI();
          if (this.ruler && this.ruler.enabled) {
            this.ruler.refreshLines();
            this.ruler.applyPosition();
          }
        });
      }
      return;
    }

    if (this.currentBook && !this.isPdfMode && this.currentParser && isInReader) {
      if (!isModeChanged) return;
      this._isModeTransitioning = true;
      requestAnimationFrame(async () => {
        try {
          if (isVertical) {
            // Přechod do vertikálního kontinuálního režimu
            const ratio = (this.totalPagesInChapter > 1 && this.currentPageIndex > 0)
              ? this.currentPageIndex / (this.totalPagesInChapter - 1)
              : 0;
            await this.loadVerticalCurrentChapter({ ratio });
          } else {
            // Přechod zpět do horizontálního paged režimu:
            // Čistě odpojit všechny připojené extra kapitoly a vykreslit pouze jedinou aktivní kapitolu
            const activeChapter = await this.getOrLoadChapter(this.currentChapterIndex);
            this.currentRawChapterHtml = activeChapter.html;
            this.renderChapterHtml();

            if (this.dom.pagedViewport) {
              this.dom.pagedViewport.scrollTop = 0;
            }
            if (this.dom.readerContent) {
              this.dom.readerContent.style.transform = "translateX(0px)";
            }

            await this.waitForContentReady();
            this.recomputeGlobalPagination();
            this.recalcPages();
            this.goToPage(this.currentPageIndex || 0);
            this.renderScrubberTicks();

            if (this.ruler && this.ruler.enabled) {
              this.ruler.refreshLines();
              if (this.ruler.wordTracking) this.ruler.refreshWords();
              this.ruler.applyPosition();
            }
          }
        } catch (err) {
          console.error("Chyba při přepnutí režimu čtení:", err);
        } finally {
          this._isModeTransitioning = false;
        }
      });
    }
  }

  isVerticalReadingMode() {
    return this.readingMode === "vertical" || document.body.classList.contains("mode-vertical");
  }

  bindVerticalScrollListener() {
    if (this._verticalScrollBound || !this.dom.pagedViewport) return;
    this._verticalScrollBound = true;

    let rafId = null;
    this.dom.pagedViewport.addEventListener("scroll", () => {
      if (!this.isVerticalReadingMode()) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        this.onVerticalScroll();
      });
    }, { passive: true });
  }

  onVerticalScroll() {
    if (!this.isVerticalReadingMode()) return;
    if (this.isPdfMode) {
      this.updatePageUI();
      this.saveProgress();
      return;
    }

    this.checkVerticalInfiniteScroll();
    if (this.settings.fastReading) {
      this.updateVisibleBionicNodes();
    }
    this.updatePageUI();
    this.saveProgress();
  }

  bindEvents() {
    // 1. Nahrávání souborů
    if (this.dom.btnUpload) {
      this.dom.btnUpload.addEventListener("click", () => {
        if (this.isImporting) return;
        if (this.dom.fileInput) this.dom.fileInput.click();
      });
    }
    if (this.dom.fileInput) {
      this.dom.fileInput.addEventListener("change", (e) => {
        if (this.isImporting) {
          e.target.value = "";
          return;
        }
        if (e.target.files && e.target.files.length > 0) {
          const file = e.target.files[0];
          e.target.value = ""; // Reset hodnoty okamžitě po přečtení
          this.handleFileUpload(file);
        }
      });
    }

    // Drag & drop
    const dropTargets = [document.body];
    if (this.dom.dropZone && this.dom.dropZone !== document.body) {
      dropTargets.push(this.dom.dropZone);
    }

    dropTargets.forEach(dropZone => {
      ["dragenter", "dragover"].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          if (!this.isImporting) {
            document.body.classList.add("dragging-file");
          }
        });
      });
      ["dragleave"].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          document.body.classList.remove("dragging-file");
        });
      });
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        document.body.classList.remove("dragging-file");
        if (this.isImporting) {
          console.warn("[LuminaApp] Import souboru již probíhá, drop ignorován.");
          return;
        }
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          const lowerName = file.name.toLowerCase();
          if (lowerName.endsWith(".epub") || lowerName.endsWith(".pdf") || file.type === "application/pdf") {
            this.handleFileUpload(file);
          } else {
            this.showToast("Prosím nahrajte soubor ve formátu .epub nebo .pdf", "error");
          }
        }
      });
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

    if (this.dom.zoneTouchPrev) {
      this.dom.zoneTouchPrev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
          this.closeFloatingDock();
          e.preventDefault();
          return;
        }
        if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
          e.preventDefault();
          return;
        }
        if (this.isUiOrOverlayEvent(e)) return;
        if (this.isNavigating || this.ruler?.isLineLocked) {
          e.preventDefault();
          return;
        }
        if (this.ruler?.enabled && this.ruler.followMode === "keyboard") {
          this.ruler.stepLine(-1, true);
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
    }

    if (this.dom.zoneTouchNext) {
      this.dom.zoneTouchNext.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
        this.closeFloatingDock();
        e.preventDefault();
        return;
      }
      if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
        this.dom.rulerQuickPopover.classList.add("is-hidden");
        if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        e.preventDefault();
        return;
      }
      if (this.isUiOrOverlayEvent(e)) return;
      if (this.isNavigating || this.ruler?.isLineLocked) {
        e.preventDefault();
        return;
      }
      if (this.ruler?.enabled && this.ruler.followMode === "keyboard") {
        this.ruler.stepLine(1, true);
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
    }

    // Přejetí prstem po obrazovce na iPadu (Touch Swipe) & Klepnutí (Tap) pro posun pravítka
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isSwiping = false;

    this.dom.pagedViewport.addEventListener("touchstart", (e) => {
      if (this.isVerticalReadingMode()) return;
      if (this.isUiOrOverlayEvent(e)) {
        isSwiping = false;
        return;
      }
      if (this.isNavigating) {
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
      if (this.isVerticalReadingMode()) return;
      if (this.isUiOrOverlayEvent(e)) {
        isSwiping = false;
        return;
      }
      if (this.isNavigating || this.ruler?.isLineLocked || (Date.now() - lastSwipeTime < 450) || (Date.now() - (this.ruler?.lastSwipeTime || 0) < 450)) {
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
      const duration = Date.now() - touchStartTime;
      const velocity = duration > 0 ? absDeltaX / duration : 0;

      // 1. Horizontální přejetí (relaxed finger swipe) pro okamžité, plynulé otáčení stránek:
      // Ergonomické prahy: |ΔX| >= 30 px, |ΔY| <= 65 px, trvání <= 450 ms, rychlost >= 0.3 px/ms
      if (absDeltaX >= 30 && absDeltaY <= 65 && duration <= 450 && velocity >= 0.3) {
        lastSwipeTime = Date.now();
        if (this.ruler) {
          this.ruler.lastSwipeTime = Date.now();
          this.ruler.cancelHold(false);
          this.ruler.isHoldTriggered = false;
          this.ruler.isDraggingRuler = false;
          this.ruler.flickResyncTopLine = true;
          this.ruler.isLineLocked = true;
          this.ruler.suppressLineAdvancement = true;
          this.ruler.lockAdvancement(400);
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
        if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
          this.closeFloatingDock();
          e.preventDefault();
          return;
        }
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
      if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
        this.closeFloatingDock();
        return;
      }
      if (this.isUiOrOverlayEvent(e)) return;
      if (this.isNavigating || this.ruler?.isLineLocked) return;
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
      if (this.isVerticalReadingMode()) return;
      if (this.isAnyModalOrMenuOpen()) return;
      if (this.isNavigating || this.ruler?.isLineLocked) return;
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

    // Přizpůsobení stran při změně orientace iPadu (Portrait/Landscape) a velikosti okna
    let lastEffectiveCols = this.resolveEffectiveColumnCount();
    window.addEventListener("resize", () => {
      if (this.settings.columnsMode === "auto") {
        const newCols = this.resolveEffectiveColumnCount();
        if (newCols !== lastEffectiveCols) {
          lastEffectiveCols = newCols;
          this.applySettings();
        }
      }
      if (this.isPdfMode && this.pdfLoader && !this.dom.viewReader.classList.contains("is-hidden")) {
        if (this.isVerticalReadingMode()) {
          this.pdfLoader.renderAllPagesVertical(this.pdfLoader.currentPage);
        } else {
          this.pdfLoader.renderPage(this.pdfLoader.currentPage);
        }
        this.updatePageUI();
        this.ruler?.applyPosition();
        return;
      }
      if (this.currentBook && !this.dom.viewReader.classList.contains("is-hidden")) {
        if (this.isVerticalReadingMode()) {
          this.updatePageUI();
        } else {
          this.recomputeGlobalPagination();
          this.recalcPages();
          this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
        }
        this.renderScrubberTicks();
        this.ruler?.refreshLines();
        this.ruler?.applyPosition();
      }
    });

    try {
      const mobileMedia = window.matchMedia("(max-width: 600px)");
      const handleMobileChange = () => {
        if (this.currentBook && this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden")) {
          this.updatePageUI();
        }
      };
      if (typeof mobileMedia.addEventListener === "function") {
        mobileMedia.addEventListener("change", handleMobileChange);
      } else if (typeof mobileMedia.addListener === "function") {
        mobileMedia.addListener(handleMobileChange);
      }
    } catch (_) {}

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
      document.getElementById("ruler-toggle-btn"),
      document.getElementById("ruler-split-pill"),
      document.getElementById("btn-reader-menu-fab"),
      document.getElementById("reader-floating-dock"),
      document.getElementById("footer-actions-group"),
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
      const _closeAllDrawers = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Suppress any leaked page-turn gesture that follows the closing tap/click
        this.isNavigating = true;
        setTimeout(() => { this.isNavigating = false; }, 300);
        this.closeDrawer("toc");
        this.closeDrawer("settings");
        this.closeDrawer("search");
      };
      // "click" covers mouse and synthesised iPad click events
      this.dom.drawerBackdrop.addEventListener("click", _closeAllDrawers);
      // "touchend" as fallback: iOS can suppress the synthesised click when
      // a prior touchstart on a different element called stopPropagation
      this.dom.drawerBackdrop.addEventListener("touchend", _closeAllDrawers, { passive: false });
    }

    if (this.dom.btnToggleSettingsLib) {
      this.dom.btnToggleSettingsLib.addEventListener("click", () => this.toggleDrawer("settings"));
    }

    if (this.dom.btnToggleStatsLib) {
      this.dom.btnToggleStatsLib.addEventListener("click", () => this.openStatsModal());
    }

    if (this.dom.btnCloudSync) {
      this.dom.btnCloudSync.addEventListener("click", () => this.handleManualCloudSync());
    }

    if (this.dom.btnToggleToc) {
      this.dom.btnToggleToc.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleDrawer("toc");
      });
    }
    if (this.dom.btnCloseToc) {
      this.dom.btnCloseToc.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeDrawer("toc");
      });
    }

    if (this.dom.btnToggleSettings) {
      this.dom.btnToggleSettings.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleDrawer("settings");
      });
    }
    if (this.dom.btnCloseSettings) {
      this.dom.btnCloseSettings.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeDrawer("settings");
      });
    }

    // Přepínání záložek v panelu nastavení (Bottom Sheet Tabs)
    const settingsTabs = this.dom.settingsDrawer?.querySelectorAll(".settings-tab-btn");
    if (settingsTabs) {
      settingsTabs.forEach(tabBtn => {
        tabBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const targetPaneId = tabBtn.dataset.tab;
          this.switchToSettingsTab(targetPaneId);
        });
      });
    }

    // Drag handle pro zavření spodního panelu
    const dragHandle = this.dom.settingsDrawer?.querySelector(".bottom-sheet-drag-handle");
    if (dragHandle) {
      dragHandle.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeDrawer("settings");
      });
      let touchStartY = 0;
      dragHandle.addEventListener("touchstart", (e) => {
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      dragHandle.addEventListener("touchend", (e) => {
        const touchEndY = e.changedTouches[0].clientY;
        if (touchEndY - touchStartY > 35) {
          this.closeDrawer("settings");
        }
      }, { passive: true });
    }

    if (this.dom.btnToggleSearch) {
      this.dom.btnToggleSearch.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleDrawer("search");
      });
    }
    if (this.dom.btnCloseSearch) {
      this.dom.btnCloseSearch.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeDrawer("search");
      });
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

    if (this.dom.btnToggleStats) {
      this.dom.btnToggleStats.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openStatsModal();
      });
    }
    if (this.dom.btnCloseStats) {
      this.dom.btnCloseStats.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeStatsModal();
      });
    }
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

    // Rychlé nastavení pravítka (Popover)
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
          // Zavřít menu dock pokud je otevřený
          if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
            this.dom.readerFloatingDock.classList.add("is-hidden");
            if (this.dom.btnReaderMenuFab) {
              this.dom.btnReaderMenuFab.classList.remove("active");
              this.dom.btnReaderMenuFab.setAttribute("aria-expanded", "false");
            }
          }
          this.dom.rulerQuickPopover.classList.remove("is-hidden");
          this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "true");
          this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
          this.setPdfRulerUIVisibility(this.isPdfMode);
          if (this.isPdfMode && this.currentBook?.pdfRulerConfig) {
            this.syncPdfRulerUI(this.currentBook.pdfRulerConfig);
          }
        } else {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        }
      });

      this.dom.rulerQuickPopover.addEventListener("click", (e) => {
        e.stopPropagation();
      });

      // Zavření popoveru kliknutím mimo (outside-click dismiss) — capture fáze, nejvyšší priorita.
      // Používáme pointerdown místo click, aby se zavření stalo před jakýmkoliv bubble handlerem.
      document.addEventListener("pointerdown", (e) => {
        if (!this.dom.rulerQuickPopover || this.dom.rulerQuickPopover.classList.contains("is-hidden")) return;
        // Pokud klik zasáhl samotný popover nebo tlačítko (►chevron), nic neděláme
        const insidePopover = this.dom.rulerQuickPopover.contains(e.target);
        const insideBtn = this.dom.btnRulerQuickMenu && this.dom.btnRulerQuickMenu.contains(e.target);
        if (insidePopover || insideBtn) return;
        // Klik je venku → okamžitě zavřít a potlačit veškerou navigaci
        e.preventDefault();
        e.stopPropagation();
        this.dom.rulerQuickPopover.classList.add("is-hidden");
        if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        // Krátký navigační zámek aby zavírací klik nespustil otočení stránky ani krokování pravítka
        this.isNavigating = true;
        setTimeout(() => { this.isNavigating = false; }, 300);
      }, { capture: true });

      // Stejný handler pro touchstart (iPad – pointerdown může být passive v některých kontextech)
      document.addEventListener("touchstart", (e) => {
        if (!this.dom.rulerQuickPopover || this.dom.rulerQuickPopover.classList.contains("is-hidden")) return;
        const touch = e.touches[0];
        if (!touch) return;
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        const insidePopover = this.dom.rulerQuickPopover.contains(target);
        const insideBtn = this.dom.btnRulerQuickMenu && this.dom.btnRulerQuickMenu.contains(target);
        if (insidePopover || insideBtn) return;
        e.preventDefault();
        e.stopPropagation();
        this.dom.rulerQuickPopover.classList.add("is-hidden");
        if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        this.isNavigating = true;
        setTimeout(() => { this.isNavigating = false; }, 300);
      }, { capture: true, passive: false });
    }

    // Plovoucí dock rychlých akcí (Menu FAB & Dock)
    if (this.dom.btnReaderMenuFab && this.dom.readerFloatingDock) {
      ["pointerdown", "touchstart"].forEach((evt) => {
        this.dom.btnReaderMenuFab.addEventListener(evt, (e) => {
          e.stopPropagation();
        }, { passive: true });
        this.dom.readerFloatingDock.addEventListener(evt, (e) => {
          e.stopPropagation();
        }, { passive: true });
      });

      this.dom.btnReaderMenuFab.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isHidden = this.dom.readerFloatingDock.classList.contains("is-hidden");
        if (isHidden) {
          // Zavřít popover pravítka pokud je otevřený
          if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
            this.dom.rulerQuickPopover.classList.add("is-hidden");
            if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
          }
          this.dom.readerFloatingDock.classList.remove("is-hidden");
          this.dom.btnReaderMenuFab.classList.add("active");
          this.dom.btnReaderMenuFab.setAttribute("aria-expanded", "true");
          this.updatePillScrubberUI();
        } else {
          this.closeFloatingDock();
        }
      });

      this.dom.readerFloatingDock.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }

    if (this.dom.btnMenuSettings) {
      this.dom.btnMenuSettings.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeFloatingDock();
        this.toggleDrawer("settings");
      });
    }

    if (this.dom.btnMenuStats) {
      this.dom.btnMenuStats.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeFloatingDock();
        this.openStatsModal();
      });
    }

    if (this.dom.btnMenuToc) {
      this.dom.btnMenuToc.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this.wasPillScrubbing) {
          return;
        }
        this.closeFloatingDock();
        this.toggleDrawer("toc");
      });
    }

    if (this.dom.btnMenuSearch) {
      this.dom.btnMenuSearch.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeFloatingDock();
        this.toggleDrawer("search");
      });
    }

    const _handleOutsideTap = (e) => {
      if (this.isPillScrubbing || this.wasPillScrubbing) return;
      const target = (e.touches && e.touches[0]?.target) || (e.changedTouches && e.changedTouches[0]?.target) || e.target;
      if (this.dom.rulerQuickPopover && !this.dom.rulerQuickPopover.classList.contains("is-hidden")) {
        const insideRuler = (this.dom.rulerSplitPill && this.dom.rulerSplitPill.contains(target)) ||
                            (this.dom.rulerBtnGroup && this.dom.rulerBtnGroup.contains(target));
        if (!insideRuler) {
          this.dom.rulerQuickPopover.classList.add("is-hidden");
          if (this.dom.btnRulerQuickMenu) this.dom.btnRulerQuickMenu.setAttribute("aria-expanded", "false");
        }
      }
      if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
        const insideDock = (this.dom.readerFloatingDock && this.dom.readerFloatingDock.contains(target)) ||
                           (this.dom.btnReaderMenuFab && this.dom.btnReaderMenuFab.contains(target));
        if (!insideDock) {
          this.closeFloatingDock();
        }
      }
    };
    document.addEventListener("click", _handleOutsideTap);
    document.addEventListener("touchend", _handleOutsideTap, { passive: true });

    const popoverSnapToggle = this.dom.popoverRulerSnapToggle || document.getElementById("popover-ruler-snap") || document.getElementById("popover-ruler-snap-toggle");
    if (popoverSnapToggle) {
      const handlePopoverSnap = (e) => {
        if (this.isPdfMode && this.isImageOnlyPdf) return;
        if (e) {
          e.stopPropagation();
          if (e.type === "click" && e.target && e.target.tagName !== "INPUT") {
            e.preventDefault();
          }
        }
        const nextVal = !(this.settings.ruler.snapToLines !== false);
        this.settings.ruler.snapToLines = nextVal;
        if (typeof storage.saveSetting === "function") {
          storage.saveSetting("rulerSnapToLines", nextVal);
        }
        if (this.ruler) {
          this.ruler.setSnapToLines(nextVal);
        }
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      };
      popoverSnapToggle.addEventListener("click", handlePopoverSnap);
      if (popoverSnapToggle.tagName === "INPUT") {
        popoverSnapToggle.addEventListener("change", handlePopoverSnap);
      }
    }

    if (this.dom.popoverModeLine) {
      this.dom.popoverModeLine.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setWordTracking(false);
      });
    }

    if (this.dom.popoverModeWord) {
      this.dom.popoverModeWord.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.isPdfMode && this.isImageOnlyPdf) return;
        this.setWordTracking(true);
      });
    }

    document.querySelectorAll("[data-ruler-mode-type]").forEach(btn => {
      if (btn !== this.dom.popoverModeLine && btn !== this.dom.popoverModeWord) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.isPdfMode && this.isImageOnlyPdf) return;
          const isWord = btn.dataset.rulerModeType === "word";
          this.setWordTracking(isWord);
        });
      }
    });

    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetBtn = e.target.closest('[data-ruler-style]') || btn;
          const newMode = targetBtn ? targetBtn.dataset.rulerStyle : null;
          if (!newMode) return;
          if (!this.settings.ruler) this.settings.ruler = {};
          this.settings.ruler.mode = newMode;
          this.ruler.setMode(this.settings.ruler.mode);
          this.updateRulerToggleButtonUI();
          this.updateRulerSettingsVisibility(newMode, this.isPdfMode);
          storage.saveSettings(this.settings);
        });
      });
    }

    if (this.dom.popoverColorButtons) {
      this.dom.popoverColorButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetBtn = e.target.closest('[data-ruler-color]') || btn;
          const newColor = targetBtn ? targetBtn.dataset.rulerColor : null;
          if (!newColor) return;
          if (!this.settings.ruler) this.settings.ruler = {};
          this.settings.ruler.color = newColor;
          if (this.ruler) {
            this.ruler.setColor(newColor);
          }
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

    // Popover rozšířené nastavení: Kalibrace pravítka pro PDF (výška a krok)
    if (this.dom.popoverPdfAutoHeight) {
      this.dom.popoverPdfAutoHeight.addEventListener("click", (e) => {
        if (e) {
          e.stopPropagation();
          if (e.target && e.target.tagName !== "INPUT") {
            e.preventDefault();
          }
        }
        this.togglePdfAutoHeight();
      });
    }

    if (this.dom.popoverSliderPdfHeight) {
      this.dom.popoverSliderPdfHeight.addEventListener("input", (e) => {
        e.stopPropagation();
        this.updatePdfRulerHeight(parseInt(e.target.value, 10));
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

    // Dropdown písma (Google Docs style)
    if (this.dom.fontDropdownTrigger && this.dom.fontDropdownWrapper) {
      const closeFontDropdown = () => {
        this.dom.fontDropdownWrapper.classList.remove("open");
        this.dom.fontDropdownTrigger.setAttribute("aria-expanded", "false");
      };

      const toggleFontDropdown = () => {
        const isOpen = this.dom.fontDropdownWrapper.classList.toggle("open");
        this.dom.fontDropdownTrigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      };

      this.dom.fontDropdownTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFontDropdown();
      });

      document.addEventListener("click", (e) => {
        if (!this.dom.fontDropdownWrapper.contains(e.target)) {
          closeFontDropdown();
        }
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.dom.fontDropdownWrapper.classList.contains("open")) {
          closeFontDropdown();
          this.dom.fontDropdownTrigger.focus();
        }
      });
    }

    this.dom.fontSelects.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.settings.fontFamily = btn.dataset.font;
        this.applySettings();
        storage.saveSettings(this.settings);
        if (this.dom.fontDropdownWrapper) {
          this.dom.fontDropdownWrapper.classList.remove("open");
        }
        if (this.dom.fontDropdownTrigger) {
          this.dom.fontDropdownTrigger.setAttribute("aria-expanded", "false");
          this.dom.fontDropdownTrigger.focus();
        }
      });
    });

    const triggerReflowSync = () => {
      if (this.isPdfMode) return;
      tracker.cancelCurrentPageDwell();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.recomputeGlobalPagination();
          this.recalcPages();
          this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
          this.renderScrubberTicks();
          this.ruler?.refreshLines();
          this.ruler?.applyPosition();
        });
      });
    };

    if (this.dom.sliderFontSize) {
      this.dom.sliderFontSize.addEventListener("input", (e) => {
        this.settings.fontSize = parseInt(e.target.value, 10);
        if (this.dom.valFontSize) this.dom.valFontSize.textContent = `${this.settings.fontSize}px`;
        document.documentElement.style.setProperty("--reader-font-size", `${this.settings.fontSize}px`);
        storage.saveSettings(this.settings);
        triggerReflowSync();
      });
    }

    if (this.dom.sliderLineHeight) {
      this.dom.sliderLineHeight.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        this.settings.lineHeight = val;
        if (this.dom.valLineHeight) this.dom.valLineHeight.textContent = val.toFixed(1);
        document.documentElement.style.setProperty("--reader-line-height", val);
        storage.saveSettings(this.settings);
        triggerReflowSync();
      });
    }

    if (this.dom.sliderLetterSpacing) {
      this.dom.sliderLetterSpacing.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        this.settings.letterSpacing = val;
        if (this.dom.valLetterSpacing) this.dom.valLetterSpacing.textContent = `${val}px`;
        document.documentElement.style.setProperty("--reader-letter-spacing", `${val}px`);
        storage.saveSettings(this.settings);
        triggerReflowSync();
      });
    }

    if (this.dom.sliderWordSpacing) {
      this.dom.sliderWordSpacing.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        this.settings.wordSpacing = val;
        if (this.dom.valWordSpacing) this.dom.valWordSpacing.textContent = `${val}px`;
        document.documentElement.style.setProperty("--reader-word-spacing", `${val}px`);
        storage.saveSettings(this.settings);
        triggerReflowSync();
      });
    }

    if (this.dom.sliderPageMargin) {
      this.dom.sliderPageMargin.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        this.settings.marginPercent = val;
        if (this.dom.valPageMargin) {
          this.dom.valPageMargin.textContent = `${val}%`;
        }
        const stageWidthVw = `${100 - (val * 2)}vw`;
        document.documentElement.style.setProperty("--reader-stage-width", stageWidthVw);
        const colGapVw = `${(val * 0.25).toFixed(2)}vw`;
        document.documentElement.style.setProperty("--col-gap", colGapVw);
        storage.saveSettings(this.settings);

        if (this.isPdfMode) {
          this.ruler?.refreshLines();
          this.ruler?.applyPosition();
          return;
        }

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.recomputeGlobalPagination();
            this.recalcPages();
            this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
            this.renderScrubberTicks();
            this.ruler?.refreshLines();
            this.ruler?.applyPosition();
          });
        });
      });
    }

    if (this.dom.columnSelects) {
      this.dom.columnSelects.forEach(btn => {
        btn.addEventListener("click", async () => {
          const mode = btn.dataset.columns || "auto";
          this.settings.columnsMode = mode;
          storage.saveSettings(this.settings);
          this.applySettings();

          if (this.isPdfMode && this.pdfLoader) {
            this.pdfLoader.setColumnsMode(mode);
            await this.pdfLoader.renderPage(this.pdfLoader.currentPage);
            this.updatePageUI();
            this.ruler?.refreshLines();
            this.ruler?.applyPosition();
            return;
          }

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.recomputeGlobalPagination();
              this.recalcPages();
              this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
              this.renderScrubberTicks();
              this.ruler?.refreshLines();
              this.ruler?.applyPosition();
            });
          });
        });
      });
    }

    if (this.dom.readingModeSelects) {
      this.dom.readingModeSelects.forEach(btn => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.readingMode || "horizontal";
          this.applyReadingMode(mode);
        });
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
        const nextVal = !(this.settings.showRulerButton !== false);
        this.settings.showRulerButton = nextVal;
        this.setSwitchState(this.dom.rulerToggle, nextVal);
        const rulerContainer = this.dom.rulerToggleBtn || this.dom.rulerSplitPill;
        if (rulerContainer) {
          rulerContainer.style.display = nextVal ? "flex" : "none";
          rulerContainer.classList.toggle("is-hidden", !nextVal);
        }
        if (!nextVal && this.ruler?.enabled) {
          this.ruler.setEnabled(false);
          this.settings.ruler.enabled = false;
        }
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      });
    }

    const drawerSnapToggle = this.dom.rulerSnapSetting || document.getElementById("setting-ruler-snap") || document.getElementById("ruler-snap-setting");
    if (drawerSnapToggle) {
      const handleDrawerSnap = (e) => {
        if (this.isPdfMode && this.isImageOnlyPdf) return;
        if (e) {
          e.stopPropagation();
          if (e.type === "click" && e.target && e.target.tagName !== "INPUT") {
            e.preventDefault();
          }
        }
        const nextVal = !(this.settings.ruler.snapToLines !== false);
        this.settings.ruler.snapToLines = nextVal;
        if (typeof storage.saveSetting === "function") {
          storage.saveSetting("rulerSnapToLines", nextVal);
        }
        if (this.ruler) {
          this.ruler.setSnapToLines(nextVal);
        }
        this.updateRulerToggleButtonUI();
        storage.saveSettings(this.settings);
      };
      drawerSnapToggle.addEventListener("click", handleDrawerSnap);
      if (drawerSnapToggle.tagName === "INPUT") {
        drawerSnapToggle.addEventListener("change", handleDrawerSnap);
      }
    }

    if (this.dom.rulerWordTrackingSetting) {
      this.dom.rulerWordTrackingSetting.addEventListener("click", () => {
        const nextVal = !(this.settings.ruler.wordTracking ?? false);
        this.setWordTracking(nextVal);
      });
    }

    if (this.dom.settingPencilFlick) {
      this.dom.settingPencilFlick.addEventListener("click", () => {
        const nextVal = !(this.settings.pencilFlickNavigation !== false);
        this.settings.pencilFlickNavigation = nextVal;
        this.setSwitchState(this.dom.settingPencilFlick, nextVal);
        if (this.ruler) {
          this.ruler.setPenFlickEnabled(nextVal);
        }
        storage.saveSettings(this.settings);
      });
    }

    this.dom.rulerModeSelects.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetBtn = e.target.closest('[data-ruler-mode], [data-ruler-style]') || btn;
        const newMode = targetBtn ? (targetBtn.dataset.rulerMode || targetBtn.dataset.rulerStyle) : null;
        if (!newMode) return;
        if (!this.settings.ruler) this.settings.ruler = {};
        this.settings.ruler.mode = newMode;
        this.ruler.setMode(this.settings.ruler.mode);
        this.updateRulerToggleButtonUI();
        this.updateRulerSettingsVisibility(newMode, this.isPdfMode);
        storage.saveSettings(this.settings);
      });
    });

    if (this.dom.rulerColorSelects) {
      this.dom.rulerColorSelects.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetBtn = e.target.closest('[data-ruler-color]') || btn;
          const newColor = targetBtn ? targetBtn.dataset.rulerColor : null;
          if (!newColor) return;
          if (!this.settings.ruler) this.settings.ruler = {};
          this.settings.ruler.color = newColor;
          if (this.ruler) {
            this.ruler.setColor(newColor);
          }
          this.updateRulerToggleButtonUI();
          storage.saveSettings(this.settings);
        });
      });
    }

    if (this.dom.sliderRulerHeight) {
      this.dom.sliderRulerHeight.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        this.settings.ruler.height = val;
        this.ruler.setHeight(val);
        this.updateRulerHeightUI();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.sliderRulerOpacity) {
      this.dom.sliderRulerOpacity.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        this.settings.ruler.dimOpacity = val / 100;
        this.ruler.setDimOpacity(this.settings.ruler.dimOpacity);
        if (this.dom.popoverSliderRulerOpacity) this.dom.popoverSliderRulerOpacity.value = val;
        if (this.dom.valRulerOpacity) this.dom.valRulerOpacity.textContent = `${val}%`;
        if (this.dom.popoverValRulerOpacity) this.dom.popoverValRulerOpacity.textContent = `${val}%`;
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.rulerFollowSelect) {
      this.dom.rulerFollowSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        this.settings.ruler.followMode = val;
        this.ruler.setFollowMode(val);
        if (this.dom.popoverRulerFollowSelect) this.dom.popoverRulerFollowSelect.value = val;
        this.applySettings();
        storage.saveSettings(this.settings);
      });
    }

    if (this.dom.rulerFollowButtons) {
      this.dom.rulerFollowButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.rulerFollow;
          if (!val) return;
          if (this.isPdfMode && this.isImageOnlyPdf && val === "keyboard") return;
          this.settings.ruler.followMode = val;
          this.ruler.setFollowMode(val);
          this.applySettings();
          this.updateTouchZonesUI();
          storage.saveSettings(this.settings);
        });
      });
    }

    if (this.dom.settingPdfAutoHeight) {
      this.dom.settingPdfAutoHeight.addEventListener("click", (e) => {
        if (e) {
          e.stopPropagation();
          if (e.target && e.target.tagName !== "INPUT") {
            e.preventDefault();
          }
        }
        this.togglePdfAutoHeight();
      });
    }

    if (this.dom.sliderPdfRulerHeight) {
      this.dom.sliderPdfRulerHeight.addEventListener("input", (e) => {
        this.updatePdfRulerHeight(parseInt(e.target.value, 10));
      });
    }

    // Přepínač zobrazení spodní lišty s postupem čtení
    if (this.dom.settingShowFooter) {
      this.dom.settingShowFooter.addEventListener("click", () => {
        const currentVal = localStorage.getItem('showProgressBar') !== null
          ? localStorage.getItem('showProgressBar') === 'true'
          : ((this.settings.showProgressBar !== undefined ? this.settings.showProgressBar : this.settings.showFooterBar) !== false);
        const val = !currentVal;
        this.settings.showFooterBar = val;
        this.settings.showProgressBar = val;
        localStorage.setItem('showProgressBar', String(val));
        this.setSwitchState(this.dom.settingShowFooter, val);
        document.body.classList.toggle("show-footer-bar", val);
        document.body.classList.toggle("hide-footer-bar", !val);
        storage.saveSettings(this.settings);
        if (this.currentBook && !this.dom.viewReader.classList.contains("is-hidden")) {
          if (this.isPdfMode) {
            this.updateScrubberUI();
            this.updatePageUI();
            this.ruler?.applyPosition();
            return;
          }
          requestAnimationFrame(() => {
            this.recalcPages();
            this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
            this.updateScrubberUI();
          });
        }
      });
    }

    // Přepínač rychlého čtení (Bionic reading)
    if (this.dom.settingFastReading) {
      this.dom.settingFastReading.addEventListener("click", () => {
        const val = !this.settings.fastReading;
        this.settings.fastReading = val;
        this.setSwitchState(this.dom.settingFastReading, val);
        storage.saveSettings(this.settings);
        this.applyFastReadingMode();
      });
    }

    // Export statistik
    this.dom.btnExportData.addEventListener("click", async () => {
      const stats = await ReadingTracker.computeGlobalStats();
      const sessions = await storage.getAllReadingSessions();
      const exportObj = {
        exportedAt: new Date().toISOString(),
        stats,
        readingSessions: sessions,
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

    // Přepočítání a normalizace statistik
    if (this.dom.btnRecalcStats) {
      this.dom.btnRecalcStats.addEventListener("click", async () => {
        try {
          this.dom.btnRecalcStats.disabled = true;
          this.dom.btnRecalcStats.textContent = "⏳ Přepočítávám...";
          const res = await storage.recalculateAndNormalizeStats();
          if (supabaseSync && supabaseSync.isOnline()) {
            try {
              const allSessions = await storage.getAllReadingSessions();
              await supabaseSync.pushMultipleSessions(allSessions);
              await supabaseSync.syncStatsSummary();
            } catch (syncErr) {
              console.warn("Varování při cloudové synchronizaci přepočtených statistik:", syncErr);
            }
          }
          this.showToast(`Statistiky byly přepočítány a normalizovány (${res.normalizedCount} relací upraveno).`, "success");
          await this.openStatsModal();
        } catch (err) {
          console.error("Chyba při normalizaci statistik:", err);
          this.showToast("Chyba při normalizaci statistik.", "error");
        } finally {
          this.dom.btnRecalcStats.disabled = false;
          this.dom.btnRecalcStats.textContent = "🔄 Přepočítat / Normalizovat data";
        }
      });
    }

    // Reset historie statistik čtení (bez smazání knih a nastavení)
    if (this.dom.btnResetStats) {
      this.dom.btnResetStats.addEventListener("click", async () => {
        const confirmed = window.confirm("Opravdu si přejete resetovat data čtení? Vaše uložené knihy a nastavení čtečky zůstanou plně zachovány.");
        if (!confirmed) return;
        try {
          this.dom.btnResetStats.disabled = true;
          await storage.resetReadingStats();
          tracker.stopSession();
          tracker.creditedBlocks.clear();
          if (supabaseSync && supabaseSync.isOnline()) {
            try {
              await supabaseSync.clearCloudReadingStats();
            } catch (cloudErr) {
              console.warn("Varování při resetování cloudových statistik:", cloudErr);
            }
          }
          this.showToast("Data čtení byla úspěšně resetována.", "success");
          await this.openStatsModal();
        } catch (err) {
          console.error("Chyba při resetování statistik:", err);
          this.showToast("Chyba při resetování statistik.", "error");
        } finally {
          this.dom.btnResetStats.disabled = false;
        }
      });
    }

    // Výběr čtecí relace v modálu statistik
    if (this.dom.sessionPickerSelect) {
      this.dom.sessionPickerSelect.addEventListener("change", (e) => {
        if (e.target.value) {
          this.selectSession(e.target.value);
        }
      });
    }

    // Přeškálování SVG grafů při změně velikosti okna
    window.addEventListener("resize", () => {
      if (this.dom.statsModal && this.dom.statsModal.classList.contains("open")) {
        if (this._selectedSessionId && this._availableSessions) {
          const session = this._availableSessions.find(s => s.sessionId === this._selectedSessionId);
          if (session && this.dom.sessionTimelineChartContainer) {
            StatsCharts.renderSessionTimelineChart(this.dom.sessionTimelineChartContainer, session);
          }
        }
      }
    });

    // Uložení stavu čtení při zavření okna nebo přepnutí záložky
    window.addEventListener("beforeunload", () => {
      if (this.currentBook && this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden")) {
        this.saveProgress(true);
      }
    });
    window.addEventListener("pagehide", () => {
      if (this.currentBook && this.dom.viewReader && !this.dom.viewReader.classList.contains("is-hidden")) {
        this.saveProgress(true);
      }
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
        if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
          this.dom.readerFloatingDock.classList.add("is-hidden");
          if (this.dom.btnReaderMenuFab) {
            this.dom.btnReaderMenuFab.classList.remove("active");
            this.dom.btnReaderMenuFab.setAttribute("aria-expanded", "false");
          }
          closedPopover = true;
        }
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
        if (this.isNavigating || this.ruler?.isLineLocked) {
          const navKeys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Spacebar"];
          if (navKeys.includes(e.key) || e.code === "Space") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
          }
        }

        this.ruler?.cancelHold();
        // Pokud má prohlížečový focus jakékoliv tlačítko, uvolníme focus (blur),
        // aby stisk Mezerníku neaktivoval toto tlačítko namísto posunu pravítka.
        if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
          if (activeEl && activeTag === "BUTTON") {
            activeEl.blur();
          }
        }

        const isLastLine = this.ruler?.isLastLine();

        // 1. OBRACENÍ STRAN (Page Turns): Šipka vpravo / Šipka vlevo / PageUp / PageDown
        if (e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (activeEl && activeEl !== document.body && activeEl.blur) activeEl.blur();
          if (this.ruler) {
            this.ruler.lockAdvancement(350);
          }
          this.nextPage();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "PageUp") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (activeEl && activeEl !== document.body && activeEl.blur) activeEl.blur();
          this.prevPage();
          return;
        }

        // 2. KROKOVÁNÍ PRAVÍTKA: Mezerník a Šipka dolů (vpřed +1), Šipka nahoru (vzad -1)
        // Pokud je aktivní image-only PDF, krokování řádků nefunguje (nejsou textové linky); použije se běžný posun/stránkování
        if (this.isPdfMode && this.isImageOnlyPdf) {
          if (e.code === "Space" || e.key === " " || e.key === "Spacebar" || e.key === "ArrowDown") {
            e.preventDefault();
            if (this.isVerticalReadingMode()) {
              const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
              if (vp) {
                const stride = (e.key === "ArrowDown") ? 80 : Math.round(vp.clientHeight * 0.85);
                vp.scrollBy({ top: stride, behavior: "smooth" });
              }
            } else {
              this.nextPage();
            }
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            if (this.isVerticalReadingMode()) {
              const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
              if (vp) {
                vp.scrollBy({ top: -80, behavior: "smooth" });
              }
            } else {
              this.prevPage();
            }
            return;
          }
        }

        // Pokud pravítko není zapnuto, automaticky jej aktivujeme a ihned posuneme
        if (e.code === "Space" || e.key === " " || e.key === "Spacebar" || e.key === "ArrowDown") {
          if (this.isVerticalReadingMode()) {
            e.preventDefault();
            if (this.ruler && this.ruler.enabled) {
              this.ruler.stepLine(1, true);
            } else {
              const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
              if (vp) {
                const stride = (e.key === "ArrowDown") ? 80 : Math.round(vp.clientHeight * 0.85);
                vp.scrollBy({ top: stride, behavior: "smooth" });
              }
            }
            return;
          }

          if (isLastLine) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (activeEl && activeEl !== document.body && activeEl.blur) activeEl.blur();
            if (this.ruler) {
              this.ruler.lockAdvancement(350);
            }
            this.nextPage();
            return;
          }

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
          if (this.isVerticalReadingMode()) {
            e.preventDefault();
            if (this.ruler && this.ruler.enabled) {
              this.ruler.stepLine(-1, true);
            } else {
              const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
              if (vp) {
                vp.scrollBy({ top: -80, behavior: "smooth" });
              }
            }
            return;
          }

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
    if (this.settings.showRulerButton === false) return;

    document.body.classList.add("in-reader-view");
    this.ruler.toggle();
    this.settings.ruler.enabled = this.ruler.enabled;
    this.updateRulerToggleButtonUI();
    this.showToast(this.ruler.enabled ? "Pravítko zapnuto" : "Pravítko vypnuto", "info");
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

  setWordTracking(isWordMode) {
    if (this.isPdfMode && this.isImageOnlyPdf) {
      isWordMode = false;
    }
    if (!this.settings.ruler) this.settings.ruler = {};
    const enabled = !!isWordMode;
    this.settings.ruler.wordTracking = enabled;

    if (this.dom.popoverModeLine) this.dom.popoverModeLine.classList.toggle("active", !enabled);
    if (this.dom.popoverModeWord) this.dom.popoverModeWord.classList.toggle("active", enabled);
    document.querySelectorAll("[data-ruler-mode-type]").forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.rulerModeType === "word") === enabled);
    });

    if (this.ruler) {
      this.ruler.setWordTracking(enabled);
      this.ruler.applyPosition();
    }

    this.updateRulerToggleButtonUI();
    storage.saveSettings(this.settings);
  }

  updateRulerToggleButtonUI() {
    const isEnabled = !!(this.ruler ? this.ruler.enabled : this.settings.ruler.enabled);
    if (this.dom.btnToggleRuler) this.dom.btnToggleRuler.classList.toggle("active", isEnabled);
    if (this.dom.rulerBtnGroup) this.dom.rulerBtnGroup.classList.toggle("is-active", isEnabled);
    if (this.dom.rulerSplitPill) this.dom.rulerSplitPill.classList.toggle("is-active", isEnabled);
    if (this.dom.rulerToggleBtn) this.dom.rulerToggleBtn.classList.toggle("is-active", isEnabled);
    if (this.dom.rulerToggle) this.setSwitchState(this.dom.rulerToggle, this.settings.showRulerButton !== false);
    const isSnap = this.settings.ruler.snapToLines !== false;
    if (this.dom.rulerSnapSetting) this.setSwitchState(this.dom.rulerSnapSetting, isSnap);
    if (this.dom.popoverRulerSnapToggle) this.setSwitchState(this.dom.popoverRulerSnapToggle, isSnap);
    document.querySelectorAll("#setting-ruler-snap, #ruler-snap-setting, #popover-ruler-snap, #popover-ruler-snap-toggle, [data-ruler-snap='toggle']").forEach(el => this.setSwitchState(el, isSnap));
    if (this.dom.rulerWordTrackingSetting) this.setSwitchState(this.dom.rulerWordTrackingSetting, !!this.settings.ruler.wordTracking);
    if (this.dom.settingPencilFlick) this.setSwitchState(this.dom.settingPencilFlick, this.settings.pencilFlickNavigation !== false);
    const isPdfAuto = this.ruler?.pdfAutoHeight !== undefined
      ? this.ruler.pdfAutoHeight
      : (this.settings.ruler.pdfAutoHeight !== false);
    if (this.dom.popoverPdfAutoHeight) this.setSwitchState(this.dom.popoverPdfAutoHeight, isPdfAuto);
    if (this.dom.settingPdfAutoHeight) this.setSwitchState(this.dom.settingPdfAutoHeight, isPdfAuto);

    const showRuler = this.settings.showRulerButton !== false;
    const rulerContainer = this.dom.rulerToggleBtn || this.dom.rulerSplitPill;
    if (rulerContainer) {
      rulerContainer.style.display = showRuler ? "flex" : "none";
      rulerContainer.classList.toggle("is-hidden", !showRuler);
    }

    const isWordTrackingActive = !!this.settings.ruler.wordTracking;
    if (this.dom.popoverModeLine) this.dom.popoverModeLine.classList.toggle("active", !isWordTrackingActive);
    if (this.dom.popoverModeWord) this.dom.popoverModeWord.classList.toggle("active", isWordTrackingActive);
    document.querySelectorAll("[data-ruler-mode-type]").forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.rulerModeType === "word") === isWordTrackingActive);
    });
    if (this.dom.popoverStyleButtons) {
      this.dom.popoverStyleButtons.forEach(btn => {
        btn.classList.toggle("active", (btn.dataset.rulerStyle || btn.dataset.rulerMode) === this.settings.ruler.mode);
      });
    }
    if (this.dom.popoverColorButtons) {
      this.dom.popoverColorButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerColor === this.settings.ruler.color);
      });
    }
    if (this.dom.rulerModeSelects) {
      this.dom.rulerModeSelects.forEach(btn => {
        btn.classList.toggle("active", (btn.dataset.rulerMode || btn.dataset.rulerStyle) === this.settings.ruler.mode);
      });
    }
    if (this.dom.rulerColorSelects) {
      this.dom.rulerColorSelects.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerColor === this.settings.ruler.color);
      });
    }
    this.updateTouchZonesUI();
    this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
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

  syncPdfRulerUI(config) {
    if (!config) config = {};
    const height = Math.max(16, Math.min(120, Math.round(Number(config.height) || 32)));
    const autoHeight = config.autoHeight !== undefined
      ? config.autoHeight !== false
      : (this.settings.ruler?.pdfAutoHeight !== false);

    this.updatePdfAutoHeightUI(autoHeight, height);
  }

  /**
   * Nastaví stav aplikace a pravítka pro obrazový/skenovaný PDF dokument (bez textové vrstvy).
   * @param {boolean} isImageOnly
   */
  setImageOnlyPdf(isImageOnly) {
    const flag = !!isImageOnly;
    this.isImageOnlyPdf = flag;

    if (this.currentBook && (this.currentBook.isPdf || this.currentBook.format === "pdf")) {
      this.currentBook.isImageOnlyPdf = flag;
      try {
        storage.saveBook(this.currentBook);
      } catch (e) {}
    }

    if (this.ruler) {
      this.ruler.setImageOnlyPdf(flag);
    }

    if (flag) {
      if (!this._savedRulerSettings) {
        this._savedRulerSettings = {
          snapToLines: this.settings.ruler.snapToLines !== false,
          pdfAutoHeight: this.settings.ruler.pdfAutoHeight !== false,
          followMode: this.settings.ruler.followMode || "mouse",
          wordTracking: !!this.settings.ruler.wordTracking
        };
      }

      this.settings.ruler.snapToLines = false;
      this.settings.ruler.pdfAutoHeight = false;
      this.settings.ruler.wordTracking = false;
      this.settings.ruler.followMode = "mouse";
    } else {
      if (this._savedRulerSettings) {
        this.settings.ruler.snapToLines = this._savedRulerSettings.snapToLines;
        this.settings.ruler.pdfAutoHeight = this._savedRulerSettings.pdfAutoHeight;
        this.settings.ruler.followMode = this._savedRulerSettings.followMode;
        this.settings.ruler.wordTracking = this._savedRulerSettings.wordTracking;
        this._savedRulerSettings = null;
      } else {
        if (this.settings.ruler.snapToLines === false) this.settings.ruler.snapToLines = true;
        if (this.settings.ruler.pdfAutoHeight === false) this.settings.ruler.pdfAutoHeight = true;
        this.settings.ruler.followMode = "mouse";
        this.settings.ruler.wordTracking = false;
      }
    }

    const snapVal = this.settings.ruler.snapToLines !== false;
    if (this.dom.rulerSnapSetting) this.setSwitchState(this.dom.rulerSnapSetting, snapVal);
    if (this.dom.popoverRulerSnapToggle) this.setSwitchState(this.dom.popoverRulerSnapToggle, snapVal);
    document.querySelectorAll("#setting-ruler-snap, #ruler-snap-setting, #popover-ruler-snap, #popover-ruler-snap-toggle, [data-ruler-snap='toggle']").forEach(el => this.setSwitchState(el, snapVal));
    if (this.dom.rulerWordTrackingSetting) this.setSwitchState(this.dom.rulerWordTrackingSetting, !!this.settings.ruler.wordTracking);

    if (this.dom.rulerFollowButtons) {
      this.dom.rulerFollowButtons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerFollow === this.settings.ruler.followMode);
      });
    }

    const currentHeight = this.currentBook?.pdfRulerConfig?.height || this.ruler?.getPdfRulerHeight?.() || 32;
    this.updatePdfAutoHeightUI(flag ? false : (this.settings.ruler.pdfAutoHeight !== false), currentHeight);
    this.updateRulerToggleButtonUI();
    this.updateTouchZonesUI();
    this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
  }

  updatePdfAutoHeightUI(autoHeight, height = null) {
    const isImageOnly = this.isPdfMode && !!this.isImageOnlyPdf;
    const isAuto = !isImageOnly && (autoHeight !== false);
    const currentHeight = height !== null
      ? Math.max(16, Math.min(120, Math.round(Number(height) || 32)))
      : (this.currentBook?.pdfRulerConfig?.height || this.ruler?.getPdfRulerHeight?.() || 32);

    if (this.dom.popoverPdfAutoHeight) {
      this.setSwitchState(this.dom.popoverPdfAutoHeight, isAuto);
    }
    if (this.dom.settingPdfAutoHeight) {
      this.setSwitchState(this.dom.settingPdfAutoHeight, isAuto);
    }

    // Quick popover slider container
    if (this.dom.popoverSliderPdfHeight) {
      this.dom.popoverSliderPdfHeight.value = currentHeight;
      this.dom.popoverSliderPdfHeight.disabled = isAuto;
    }
    if (this.dom.popoverPdfHeightContainer) {
      this.dom.popoverPdfHeightContainer.style.opacity = isAuto ? "0.45" : "1";
      this.dom.popoverPdfHeightContainer.style.pointerEvents = isAuto ? "none" : "auto";
    }
    if (this.dom.popoverValPdfHeight) {
      this.dom.popoverValPdfHeight.textContent = isAuto ? "Auto" : `${currentHeight} px`;
    }

    // Settings drawer slider container
    if (this.dom.sliderPdfRulerHeight) {
      this.dom.sliderPdfRulerHeight.value = currentHeight;
      this.dom.sliderPdfRulerHeight.disabled = isAuto;
    }
    if (this.dom.drawerPdfHeightContainer) {
      this.dom.drawerPdfHeightContainer.style.opacity = isAuto ? "0.45" : "1";
      this.dom.drawerPdfHeightContainer.style.pointerEvents = isAuto ? "none" : "auto";
    }
    if (this.dom.valPdfRulerHeight) {
      this.dom.valPdfRulerHeight.textContent = isAuto ? "Auto" : `${currentHeight} px`;
    }
  }

  async togglePdfAutoHeight(forcedValue = null) {
    if (this.isPdfMode && this.isImageOnlyPdf) return;

    const currentVal = this.ruler?.pdfAutoHeight !== undefined
      ? this.ruler.pdfAutoHeight
      : (this.settings.ruler.pdfAutoHeight !== false);
    const nextVal = forcedValue !== null ? !!forcedValue : !currentVal;

    this.settings.ruler.pdfAutoHeight = nextVal;
    if (typeof storage.saveSetting === "function") {
      storage.saveSetting("rulerPdfAutoHeight", nextVal);
    }
    storage.saveSettings(this.settings);

    if (this.currentBook && (this.currentBook.isPdf || this.currentBook.format === "pdf")) {
      if (!this.currentBook.pdfRulerConfig) {
        this.currentBook.pdfRulerConfig = { height: 32, autoHeight: nextVal };
      } else {
        this.currentBook.pdfRulerConfig.autoHeight = nextVal;
      }
      try {
        await storage.updateBookPdfRulerConfig(this.currentBook.id, this.currentBook.pdfRulerConfig);
      } catch (err) {
        console.warn("[LuminaApp] Nelze uložit pdfRulerConfig autoHeight:", err);
      }
    }

    if (this.ruler) {
      this.ruler.setPdfAutoHeight(nextVal);
    }

    this.updatePdfAutoHeightUI(nextVal);
  }

  setPdfRulerUIVisibility(isPdf) {
    this.updateSettingsTabsVisibility(isPdf);
    this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, isPdf);
  }

  /**
   * Kontextově adaptivní viditelnost ovládacích prvků pravítka v popoveru a draweru.
   * @param {string} [style] - highlight | focus | bottom-cover
   * @param {boolean} [isPdf] - zda je aktivní PDF dokument
   */
  updateRulerSettingsVisibility(style = null, isPdf = null) {
    const activeStyle = style || this.settings?.ruler?.mode || this.ruler?.mode || "highlight";
    const activePdf = isPdf !== null && isPdf !== undefined ? !!isPdf : !!this.isPdfMode;
    const isImageOnly = activePdf && !!this.isImageOnlyPdf;

    // 1. Color section: skryto pro režim focus (Zaostření)
    const hideColor = activeStyle === "focus";
    const popoverColor = this.dom.popoverRulerColorSection || document.getElementById("popover-ruler-color-section");
    if (popoverColor) popoverColor.classList.toggle("is-hidden", hideColor);

    const drawerColor = this.dom.drawerRulerColorSection || document.getElementById("drawer-ruler-color-section");
    if (drawerColor) drawerColor.classList.toggle("is-hidden", hideColor);

    // 2. Dimming opacity section: skryto pro režim highlight (Zvýrazňovač)
    const hideOpacity = activeStyle === "highlight";
    const popoverOpacity = this.dom.popoverRulerOpacitySection || document.getElementById("popover-ruler-opacity-section");
    if (popoverOpacity) popoverOpacity.classList.toggle("is-hidden", hideOpacity);

    const drawerOpacity = this.dom.drawerRulerOpacitySection || document.getElementById("drawer-ruler-opacity-section");
    if (drawerOpacity) drawerOpacity.classList.toggle("is-hidden", hideOpacity);

    // 3. PDF height & auto-height section: skryto pro režim bottom-cover nebo mimo PDF dokument
    const hidePdfHeight = !activePdf || activeStyle === "bottom-cover";
    const popoverPdf = this.dom.popoverPdfRulerSection || document.getElementById("popover-pdf-ruler-section");
    if (popoverPdf) popoverPdf.classList.toggle("is-hidden", hidePdfHeight);

    const drawerPdf = this.dom.drawerPdfRulerSection || document.getElementById("drawer-pdf-ruler-section");
    if (drawerPdf) drawerPdf.classList.toggle("is-hidden", hidePdfHeight);

    // 4. Automatická výška v PDF: při image-only PDF skrýt přepínač auto-výšky
    const popoverAutoHeightRow = this.dom.popoverPdfAutoHeightRow || document.getElementById("popover-pdf-auto-height-row");
    if (popoverAutoHeightRow) popoverAutoHeightRow.classList.toggle("is-hidden", isImageOnly);

    const drawerAutoHeightRow = this.dom.drawerPdfAutoHeightRow || document.getElementById("drawer-pdf-auto-height-row");
    if (drawerAutoHeightRow) drawerAutoHeightRow.classList.toggle("is-hidden", isImageOnly);

    // Manuální slider výšky: při image-only PDF je VŽDY zobrazen a aktivní (nezávisle na auto-height přepínači)
    if (isImageOnly) {
      if (this.dom.popoverPdfHeightContainer) {
        this.dom.popoverPdfHeightContainer.style.opacity = "1";
        this.dom.popoverPdfHeightContainer.style.pointerEvents = "auto";
      }
      if (this.dom.popoverSliderPdfHeight) {
        this.dom.popoverSliderPdfHeight.disabled = false;
      }
      if (this.dom.drawerPdfHeightContainer) {
        this.dom.drawerPdfHeightContainer.style.opacity = "1";
        this.dom.drawerPdfHeightContainer.style.pointerEvents = "auto";
      }
      if (this.dom.sliderPdfRulerHeight) {
        this.dom.sliderPdfRulerHeight.disabled = false;
      }
    }

    // 5. Magnetické přichytávání k řádkům: skrýt pro image-only PDF v popoveru i draweru
    const popoverSnap = this.dom.popoverSnapLinesSection || document.getElementById("popover-snap-lines-section");
    if (popoverSnap) popoverSnap.classList.toggle("is-hidden", isImageOnly);

    const drawerSnap = this.dom.drawerSnapLinesSection || document.getElementById("drawer-snap-lines-section");
    if (drawerSnap) drawerSnap.classList.toggle("is-hidden", isImageOnly);

    // 6. Režim zvýraznění: Slova (Word tracking): skrýt nebo zablokovat v popoveru i draweru
    const popoverModeSection = this.dom.popoverRulerModeSection || document.getElementById("popover-ruler-mode-section");
    if (popoverModeSection) popoverModeSection.classList.toggle("is-hidden", isImageOnly);

    const popoverModeWord = this.dom.popoverModeWord || document.getElementById("popover-mode-word");
    const popoverModeLine = this.dom.popoverModeLine || document.getElementById("popover-mode-line");
    const popoverModeSegmented = this.dom.popoverModeSegmented || document.getElementById("popover-mode-segmented");
    if (popoverModeWord) {
      popoverModeWord.classList.toggle("is-hidden", isImageOnly);
      popoverModeWord.disabled = isImageOnly;
      if (isImageOnly) {
        popoverModeWord.classList.remove("active");
        if (popoverModeLine) popoverModeLine.classList.add("active");
      } else {
        popoverModeWord.classList.toggle("active", !!this.settings.ruler?.wordTracking);
        if (popoverModeLine) popoverModeLine.classList.toggle("active", !this.settings.ruler?.wordTracking);
      }
    }
    if (popoverModeSegmented) {
      popoverModeSegmented.classList.toggle("is-single-segment", isImageOnly);
    }

    const drawerWordTracking = this.dom.drawerWordTrackingSection || document.getElementById("drawer-word-tracking-section");
    if (drawerWordTracking) {
      drawerWordTracking.classList.toggle("is-hidden", isImageOnly);
    }

    // 7. Způsob pohybu: Klávesové šipky: skrýt/zakázat pro image-only PDF, ponechat pouze kurzor myši
    const popoverFollowSection = this.dom.popoverFollowSection || document.getElementById("popover-follow-section");
    const settingsFollowSection = this.dom.settingsFollowSection || document.getElementById("settings-follow-section");
    if (popoverFollowSection) popoverFollowSection.classList.toggle("is-image-only", isImageOnly);
    if (settingsFollowSection) settingsFollowSection.classList.toggle("is-image-only", isImageOnly);

    document.querySelectorAll("[data-ruler-follow='keyboard']").forEach(btn => {
      btn.classList.toggle("is-hidden", isImageOnly);
      btn.disabled = isImageOnly;
      if (isImageOnly) {
        btn.classList.remove("active");
      }
    });

    if (isImageOnly) {
      document.querySelectorAll("[data-ruler-follow='mouse']").forEach(btn => {
        btn.classList.add("active");
      });
    } else {
      document.querySelectorAll("[data-ruler-follow]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.rulerFollow === this.settings.ruler.followMode);
      });
    }
  }

  async updatePdfRulerHeight(height) {
    const clamped = Math.max(16, Math.min(120, Math.round(Number(height) || 32)));
    if (this.ruler) {
      this.ruler.setPdfRulerHeight(clamped, true);
    }
    if (this.dom.popoverSliderPdfHeight) this.dom.popoverSliderPdfHeight.value = clamped;
    if (this.dom.popoverValPdfHeight) this.dom.popoverValPdfHeight.textContent = `${clamped} px`;
    if (this.dom.sliderPdfRulerHeight) this.dom.sliderPdfRulerHeight.value = clamped;
    if (this.dom.valPdfRulerHeight) this.dom.valPdfRulerHeight.textContent = `${clamped} px`;

    if (this.currentBook && (this.currentBook.isPdf || this.currentBook.format === "pdf")) {
      if (!this.currentBook.pdfRulerConfig) {
        this.currentBook.pdfRulerConfig = { height: 32, autoHeight: this.ruler?.pdfAutoHeight !== false };
      }
      this.currentBook.pdfRulerConfig.height = clamped;
      try {
        await storage.updateBookPdfRulerConfig(this.currentBook.id, this.currentBook.pdfRulerConfig);
      } catch (err) {
        console.warn("[LuminaApp] Nelze uložit pdfRulerConfig výšku:", err);
      }
    }
  }

  // --- KNIHOVNA & NAHRÁVÁNÍ ---

  async handleFileUpload(file) {
    if (this.isImporting) {
      console.warn("[LuminaApp] Import souboru již probíhá, požadavek ignorován.");
      return;
    }
    this.isImporting = true;
    try {
      const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
      if (isPdf) {
        this.showToast("Zpracovávám PDF dokument...", "info");
        try {
          const fileHash = await computeFileHash(file);
          const bookId = `pdf_${fileHash}`;

          // Kontrola, zda kniha se stejným ID nebo obsahem již neexistuje v IndexedDB
          const existingBook = await storage.findBookByIdOrHash(bookId, fileHash);
          if (existingBook) {
            this.showToast(`Dokument „${existingBook.title}“ již v knihovně existuje.`, "info");
            await this.renderLibrary();
            await this.openBook(existingBook.id);
            return;
          }

          const buffer = await file.arrayBuffer();
          // Nezávislá kopie pro IndexedDB úložiště, aby nedošlo k chybě detached ArrayBuffer
          const storageBuffer = buffer.slice(0);
          this.isPdfMode = true;
          document.body.classList.add("is-pdf-mode");
          if (this.dom.readerContent) this.dom.readerContent.classList.add("is-pdf-mode");
          if (this.ruler) this.ruler.setPdfMode(true);

          if (this.currentParser) {
            this.currentParser.destroy();
            this.currentParser = null;
          }
          if (this.pdfLoader) {
            this.pdfLoader.destroy();
            this.pdfLoader = null;
          }

          this.pdfLoader = new PDFLoader(this, this.dom.readerContent);
          await this.pdfLoader.load(buffer);

          const title = file.name.replace(/\.pdf$/i, "");

          let coverDataUrl = null;
          try {
            if (this.pdfLoader.canvas) {
              coverDataUrl = this.pdfLoader.canvas.toDataURL("image/jpeg", 0.75);
            }
          } catch (e) {
            console.warn("Nepodařilo se vytvořit náhled obálky PDF:", e);
          }

          const pdfRulerConfig = { height: 32, autoHeight: true };
          const isImageOnly = !!this.pdfLoader.isImageOnlyPdf;
          const bookData = {
            id: bookId,
            fileHash,
            file_hash: fileHash,
            title: title,
            author: "PDF Dokument",
            creator: "PDF Dokument",
            fileName: file.name,
            file_name: file.name,
            file_path: `books/${bookId}.pdf`,
            format: "pdf",
            isPdf: true,
            isImageOnlyPdf: isImageOnly,
            language: "cs",
            description: `PDF dokument (${this.pdfLoader.numPages} stran)`,
            coverDataUrl,
            fileData: storageBuffer,
            data: storageBuffer,
            addedAt: Date.now(),
            lastReadAt: Date.now(),
            currentChapterIndex: 0,
            currentPageIndex: 0,
            totalChapters: 1,
            totalWords: this.pdfLoader.numPages * 250,
            wordsRead: 0,
            progressPercent: 0,
            pdfRulerConfig
          };

          await storage.saveBook(bookData);
          supabaseSync.uploadBook(bookData).catch(err => {
            console.error("[Supabase Sync] PDF upload failed:", err);
          });
          this.currentBook = bookData;
          storage.setLastActiveBookId(bookId);

          this.setImageOnlyPdf(isImageOnly);
          if (this.ruler) this.ruler.setPdfMode(true, pdfRulerConfig);
          this.syncPdfRulerUI(pdfRulerConfig);
          this.setPdfRulerUIVisibility(true);

          this.showToast(`Dokument „${title}“ byl úspěšně přidán!`, "success");
          await this.renderLibrary();

          this.showReaderView();
          if (this.dom.bookTitleEl) this.dom.bookTitleEl.textContent = title;
          await this.renderPdfToc();
          this.updatePageUI();
          tracker.startSession(bookId, title, 0, (bookData.totalWords || 1), 0);
          this.pdfLoader.calculateTotalWordsInBackground(bookId);
        } catch (err) {
          console.error("Chyba při nahrávání PDF:", err);
          this.showToast(`Chyba při čtení PDF: ${err.message}`, "error");
        }
        return;
      }

      this.isPdfMode = false;
      document.body.classList.remove("is-pdf-mode");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-pdf-mode");
      this.setImageOnlyPdf(false);
      if (this.ruler) this.ruler.setPdfMode(false);
      this.setPdfRulerUIVisibility(false);
      if (this.pdfLoader) {
        this.pdfLoader.destroy();
        this.pdfLoader = null;
      }

      this.showToast("Zpracovávám EPUB soubor...", "info");
      try {
        const buffer = await file.arrayBuffer();
        // Nezávislá kopie pro IndexedDB a cloud synchronizaci, aby nedošlo k chybě detached ArrayBuffer
        const storageBuffer = buffer.slice(0);
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

        const author = parser.metadata.creator || "Neznámý autor";
        const bookData = {
          id: bookId,
          title: parser.metadata.title || file.name.replace(/\.epub$/i, ""),
          author: author,
          creator: author,
          fileName: file.name,
          file_name: file.name,
          format: "epub",
          isPdf: false,
          language: parser.metadata.language || "cs",
          description: parser.metadata.description || "",
          coverDataUrl,
          fileData: storageBuffer,
          data: storageBuffer,
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
        supabaseSync.uploadBook(bookData).catch(err => {
          console.error("[Supabase Sync] EPUB upload failed:", err);
        });
        this.showToast(`Kniha „${bookData.title}“ byla úspěšně přidána!`, "success");
        await this.renderLibrary();

        // Rovnou otevřít nově přidanou knihu
        await this.openBook(bookId);
      } catch (err) {
        console.error("Chyba při nahrávání EPUB:", err);
        this.showToast(`Chyba při čtení EPUB: ${err.message}`, "error");
      }
    } finally {
      this.isImporting = false;
      if (this.dom.fileInput) {
        this.dom.fileInput.value = "";
      }
    }
  }

  async loadBundledSampleBook() {
    if (this.isImporting) return;
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

  async loadLibrary() {
    try {
      await supabaseSync.syncAll({ silent: true });
    } catch (e) {
      console.warn("[Supabase Sync] Chyba při načítání knihovny z cloudu:", e);
    }
    await storage.deduplicateBooks();
    const books = await storage.getAllBooks();
    if (books && Array.isArray(books)) {
      books.forEach(b => storage.normalizeBookProgress(b));
    }
    return this.renderBookGrid(books);
  }

  async renderLibrary() {
    await storage.deduplicateBooks();
    const books = await storage.getAllBooks();
    return this.renderBookGrid(books);
  }

  renderBookGrid(books) {
    if (!this.dom.bookGrid) return;
    this.dom.bookGrid.innerHTML = "";

    if (!books || books.length === 0) {
      if (this.dom.emptyLibrary) this.dom.emptyLibrary.classList.remove("is-hidden");
      this.dom.bookGrid.classList.add("is-hidden");
      return;
    }

    if (this.dom.emptyLibrary) this.dom.emptyLibrary.classList.add("is-hidden");
    this.dom.bookGrid.classList.remove("is-hidden");

    books.forEach(book => {
      const card = this.createBookCard(book);
      this.dom.bookGrid.appendChild(card);
    });
  }

  createBookCard(book) {
    let progressValue = 0;
    if (typeof book.progress === 'number' && !isNaN(book.progress)) {
      progressValue = (book.progress > 0 && book.progress < 1) ? book.progress * 100 : book.progress;
    } else if (typeof book.scroll_progress === 'number' && !isNaN(book.scroll_progress)) {
      progressValue = (book.scroll_progress > 0 && book.scroll_progress <= 1) ? book.scroll_progress * 100 : book.scroll_progress;
    } else if (typeof book.progressPercent === 'number' && !isNaN(book.progressPercent)) {
      progressValue = (book.progressPercent > 0 && book.progressPercent < 1) ? book.progressPercent * 100 : book.progressPercent;
    } else if (typeof book.scrollPercent === 'number' && !isNaN(book.scrollPercent)) {
      progressValue = (book.scrollPercent > 0 && book.scrollPercent <= 1) ? book.scrollPercent * 100 : book.scrollPercent;
    } else if (book.currentPage && book.numPages) {
      progressValue = Math.round((book.currentPage / book.numPages) * 100);
    } else if (book.current_page && book.total_pages) {
      progressValue = Math.round((book.current_page / book.total_pages) * 100);
    } else if (typeof book.currentPageIndex === 'number' && book.numPages) {
      progressValue = Math.round(((book.currentPageIndex + 1) / book.numPages) * 100);
    }

    if (progressValue === 0 && book.id) {
      try {
        const cachedStr = localStorage.getItem(`lumina_progress_${book.id}`);
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached) {
            if (typeof cached.progress === 'number' && !isNaN(cached.progress)) {
              progressValue = (cached.progress > 0 && cached.progress < 1) ? cached.progress * 100 : cached.progress;
            } else if (typeof cached.scrollPercent === 'number' && !isNaN(cached.scrollPercent)) {
              progressValue = (cached.scrollPercent > 0 && cached.scrollPercent <= 1) ? cached.scrollPercent * 100 : cached.scrollPercent;
            } else if (typeof cached.scroll_progress === 'number' && !isNaN(cached.scroll_progress)) {
              progressValue = (cached.scroll_progress > 0 && cached.scroll_progress <= 1) ? cached.scroll_progress * 100 : cached.scroll_progress;
            } else if (cached.currentPage && cached.numPages) {
              progressValue = Math.round((cached.currentPage / cached.numPages) * 100);
            }
          }
        }
      } catch (e) {}
    }

    progressValue = Math.max(0, Math.min(100, Math.round(progressValue)));
    book.progress = progressValue;
    book.progressPercent = progressValue;

    const card = document.createElement("div");
    card.className = "book-card";
    card.setAttribute("tabindex", "0");

    const coverHtml = book.coverDataUrl
      ? `<img src="${book.coverDataUrl}" alt="${book.title}" class="book-cover-img" />`
      : `<div class="book-cover-placeholder">
           <span class="cover-icon">📖</span>
           <span class="cover-title">${book.title}</span>
         </div>`;

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
        <p class="book-author">${book.author || book.creator || ""}</p>
        <div class="book-meta">
          <div class="book-progress-bar-small book-card-progress-bar">
            <div class="fill book-progress-fill progress-fill" style="width: ${progressValue}%;"></div>
          </div>
          <div class="book-meta-text">
            <span class="book-progress-text">${progressValue}%</span>
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
        supabaseSync.deleteBook(book.id).catch(err => {
          console.warn("[SupabaseSync] Smazání knihy z cloudu selhalo:", err);
        });
        this.showToast(`Kniha byla odebrána`, "info");
        await this.renderLibrary();
      }
    });

    return card;
  }

  // --- CLOUD SYNC & ZÁLOHOVÁNÍ (SUPABASE) ---

  initCloudSync() {
    supabaseSync.onStatusChange((status) => {
      this.updateSyncUI(status);
    });

    supabaseSync.onSyncCompleted(async (stats) => {
      console.log("[LuminaApp] Cloud sync byl dokončen, obnovuji statistiky a knihovnu:", stats);
      await this.refreshStatsUI();
      await this.renderLibrary();
    });
  }

  updateSyncUI(status) {
    const btn = this.dom.btnCloudSync;
    if (!btn) return;

    btn.classList.remove("status-idle", "status-syncing", "status-synced", "status-error", "status-offline");
    btn.classList.add(`status-${status}`);

    const iconIdle = btn.querySelector(".icon-sync-idle");
    const iconSpin = btn.querySelector(".icon-sync-spin");
    const iconDone = btn.querySelector(".icon-sync-done");
    const iconOffline = btn.querySelector(".icon-sync-offline");

    if (iconIdle) iconIdle.classList.toggle("is-hidden", status !== "idle");
    if (iconSpin) iconSpin.classList.toggle("is-hidden", status !== "syncing");
    if (iconDone) iconDone.classList.toggle("is-hidden", status !== "synced");
    if (iconOffline) iconOffline.classList.toggle("is-hidden", status !== "offline" && status !== "error");

    const textEl = this.dom.syncStatusText;
    if (textEl) {
      if (status === "syncing") {
        textEl.textContent = "Synchronizuji...";
      } else if (status === "synced") {
        textEl.textContent = "Synchronizováno";
      } else if (status === "offline") {
        textEl.textContent = "Offline";
      } else if (status === "error") {
        textEl.textContent = "Chyba syncu";
      } else {
        textEl.textContent = "Cloud Sync";
      }
    }

    if (status === "synced") {
      btn.title = "Všechny knihy a postup čtení jsou synchronizovány se Supabase";
    } else if (status === "syncing") {
      btn.title = "Probíhá synchronizace se Supabase cloudem...";
    } else if (status === "offline") {
      btn.title = "Aplikace běží offline. Veškerá data jsou bezpečně v zařízení.";
    } else if (status === "error") {
      btn.title = "Při synchronizaci došlo k chybě. Klikněte pro opakování.";
    } else {
      btn.title = "Synchronizovat knihy a postup čtení s cloudem";
    }
  }

  async handleManualCloudSync() {
    this.showToast("Zahajuji synchronizaci s cloudem...", "info");
    const res = await supabaseSync.syncAll();
    if (res?.success) {
      const stats = res.stats || {};
      const parts = [];
      if (stats.downloaded > 0) parts.push(`staženo knih: ${stats.downloaded}`);
      if (stats.uploaded > 0) parts.push(`nahráno knih: ${stats.uploaded}`);
      if (stats.updatedFromCloud > 0) parts.push(`postup z cloudu`);
      if (stats.uploadedToCloud > 0) parts.push(`postup odeslán`);
      if (stats.sessionsDownloaded > 0) parts.push(`relace staženy: ${stats.sessionsDownloaded}`);
      if (stats.sessionsUploaded > 0) parts.push(`relace odeslány: ${stats.sessionsUploaded}`);
      if (stats.sessionsMerged > 0) parts.push(`statistiky sloučeny`);
      
      const msg = parts.length > 0
        ? `Cloudová synchronizace dokončena (${parts.join(", ")})`
        : "Všechny knihy a statistiky čtení jsou aktuální.";
      this.showToast(msg, "success");
      await this.refreshStatsUI();
      await this.renderLibrary();
    } else if (res?.reason === "offline") {
      this.showToast("Zařízení je offline. Knihovna funguje plně lokálně.", "warning");
    } else if (res?.reason === "already_syncing") {
      this.showToast("Synchronizace již probíhá...", "info");
    } else {
      this.showToast("Synchronizace se nezdařila. Zkontrolujte připojení k internetu.", "error");
    }
  }

  async syncWithCloud(interactive = false) {
    try {
      const res = await supabaseSync.syncAll({ silent: !interactive });
      if (res?.success && (res.stats?.downloaded > 0 || res.stats?.updatedFromCloud > 0)) {
        await this.renderLibrary();
        if (this.currentBook) {
          const refreshed = await storage.getBook(this.currentBook.id);
          if (refreshed && (refreshed.lastReadAt || 0) > (this.currentBook.lastReadAt || 0)) {
            this.currentBook = refreshed;
          }
        }
      }
      return res;
    } catch (err) {
      console.warn("[LuminaApp] syncWithCloud selhal:", err);
      return { success: false, reason: "error" };
    }
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
      this.currentParser = null;
    }
    if (this.pdfLoader) {
      this.pdfLoader.destroy();
      this.pdfLoader = null;
    }

    try {
      this.currentBook = book;
      this._chapterDataCache = new Map();
      this._bionicHtmlCache = new Map();
      this._originalBlockHtml = new WeakMap();
      this._bionicBlockHtml = new WeakMap();
      this._isLoadingNextChapter = false;
      this._isLoadingPrevChapter = false;
      this._isModeTransitioning = false;
      this.searchIndexCache = new Map();
      this.clearSearch();
      storage.setLastActiveBookId(book.id);

      // Zkontrolujeme localStorage pro nejčerstvější uloženou pozici (ochrana proti neuložené IDB relaci při reloadu)
      try {
        const cachedStr = localStorage.getItem(`lumina_progress_${book.id}`);
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && typeof cached.currentChapterIndex === "number") {
            if (!book.lastReadAt || (cached.lastReadAt && cached.lastReadAt >= book.lastReadAt)) {
              book.currentChapterIndex = cached.currentChapterIndex;
              if (typeof cached.currentPageIndex === "number") {
                book.currentPageIndex = cached.currentPageIndex;
              }
              if (typeof cached.pageRatio === "number") {
                book.pageRatio = cached.pageRatio;
              }
            }
          }
        }
      } catch (e) {
        console.warn("[LuminaApp] Nelze načíst mezipaměť postupu z localStorage:", e);
      }

      if (book.isPdf || book.format === "pdf") {
        this.isPdfMode = true;
        document.body.classList.add("is-pdf-mode");
        if (this.dom.readerContent) this.dom.readerContent.classList.add("is-pdf-mode");
        const isKnownImageOnly = book.isImageOnlyPdf === true;
        this.setImageOnlyPdf(isKnownImageOnly);
        const pdfConfig = book.pdfRulerConfig || {
          height: 32,
          autoHeight: this.settings.ruler.pdfAutoHeight !== false
        };
        if (pdfConfig.autoHeight === undefined) {
          pdfConfig.autoHeight = this.settings.ruler.pdfAutoHeight !== false;
        }
        if (this.ruler) this.ruler.setPdfMode(true, pdfConfig);
        this.syncPdfRulerUI(pdfConfig);
        this.setPdfRulerUIVisibility(true);

        if (!this.pdfLoader) {
          this.pdfLoader = new PDFLoader(this, this.dom.readerContent);
        }

        const targetPage = (typeof book.currentPageIndex === "number" && book.currentPageIndex >= 0)
          ? book.currentPageIndex + 1
          : 1;

        this.showReaderView();
        if (this.dom.bookTitleEl) this.dom.bookTitleEl.textContent = book.title;

        const rawPdf = book.fileData || book.data;
        if (!rawPdf) {
          throw new Error("PDF dokument neobsahuje žádná data souboru.");
        }
        let fileBuffer;
        if (rawPdf instanceof ArrayBuffer) {
          fileBuffer = rawPdf.slice(0);
        } else if (rawPdf instanceof Blob) {
          fileBuffer = await rawPdf.arrayBuffer();
        } else if (ArrayBuffer.isView(rawPdf)) {
          fileBuffer = rawPdf.buffer.slice(rawPdf.byteOffset, rawPdf.byteOffset + rawPdf.byteLength);
        } else {
          fileBuffer = rawPdf;
        }
        await this.pdfLoader.load(fileBuffer, targetPage);
        this.setImageOnlyPdf(this.pdfLoader.isImageOnlyPdf);
        if (targetPage > 1 && this.pdfLoader.currentPage !== targetPage) {
          await this.pdfLoader.goToPage(targetPage);
        }

        await this.renderPdfToc();
        this.updatePageUI();
        tracker.startSession(bookId, book.title, 0, (book.totalWords || (this.pdfLoader.numPages * 250) || 1), 0);
        this.pdfLoader.calculateTotalWordsInBackground(bookId);
        return;
      }

      this.isPdfMode = false;
      document.body.classList.remove("is-pdf-mode");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-pdf-mode");
      this.setImageOnlyPdf(false);
      if (this.ruler) this.ruler.setPdfMode(false);
      this.setPdfRulerUIVisibility(false);

      const rawBuffer = book.fileData || book.data;
      if (!rawBuffer) {
        throw new Error("Kniha neobsahuje žádná data souboru.");
      }
      let epubBuffer;
      if (rawBuffer instanceof ArrayBuffer) {
        epubBuffer = rawBuffer.slice(0);
      } else if (rawBuffer instanceof Blob) {
        epubBuffer = await rawBuffer.arrayBuffer();
      } else if (ArrayBuffer.isView(rawBuffer)) {
        epubBuffer = rawBuffer.buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength);
      } else {
        epubBuffer = rawBuffer;
      }

      this.currentParser = await EpubParser.parse(epubBuffer);

      if (this.dom.bookTitleEl) this.dom.bookTitleEl.textContent = book.title;
      this.renderToc();

      // Zobrazit reader view ještě PŘED měřením rozměrů, aby clientWidth a scrollWidth nebyly 0!
      this.showReaderView();

      // Rychle spočítáme celkový počet slov knihy na pozadí pro přesné počítadlo celkového počtu stran
      this.bookWordCounts = null;
      this.bookPagination = null;
      this.recomputeGlobalPagination();
      this.currentParser.calculateTotalWords().then(counts => {
        this.bookWordCounts = counts;
        this.recomputeGlobalPagination();
        this.renderScrubberTicks();
        this.updatePageUI();
      }).catch(e => console.warn("Nelze spočítat celková slova knihy:", e));

      // Obnovení kapitoly a přesné strany
      this.currentChapterIndex = book.currentChapterIndex || 0;
      const targetPage = typeof book.currentPageIndex === "number"
        ? book.currentPageIndex
        : (book.pageRatio !== undefined ? { ratio: book.pageRatio } : 0);
      await this.loadCurrentChapter(targetPage);
    } catch (err) {
      console.error("Chyba při otevírání knihy:", err);
      this.showToast(`Knihu se nepodařilo otevřít: ${err.message}`, "error");
    }
  }

  onPdfPageRendered(currentPage, numPages, isReflow = false, isInitial = false) {
    const prevPageIndex = this.currentPageIndex;
    this.currentPageIndex = currentPage - 1;
    this.totalPagesInChapter = numPages;
    const isPageChanged = !isReflow && !isInitial && this.currentPageIndex !== prevPageIndex;
    const direction = isPageChanged ? (this.currentPageIndex > prevPageIndex ? 1 : -1) : 0;
    if (isPageChanged || isInitial) {
      this.wordsCreditedOnCurrentPage = 0;
    }
    if (this.currentBook) {
      const visibleWords = this.getVisibleWordsOnCurrentPage();
      tracker.onPageChange({
        bookId: this.currentBook.id,
        bookTitle: this.currentBook.title,
        chapterIndex: 0,
        pageIndex: this.currentPageIndex,
        visibleWords: visibleWords,
        direction: direction,
        isReflow: !!isReflow,
        isInitialLoad: !!isInitial
      });
    }
    const progress = numPages > 0 ? currentPage / numPages : 0;
    tracker.updateScrollProgress(progress);
    this.updatePageUI();
    this.saveProgress();

    // Re-synchronize reading ruler with the freshly rendered text layer
    if (this.ruler && this.ruler.enabled) {
      this.ruler.onPageChange(direction, isPageChanged, true);
    }
  }

  async renderPdfToc() {
    if (!this.dom.tocList) return;
    this.dom.tocList.innerHTML = "";
    if (!this.pdfLoader || !this.pdfLoader.pdfDoc) {
      this.dom.tocList.innerHTML = `<li class="toc-empty">Dokument neobsahuje obsah.</li>`;
      return;
    }

    try {
      const outline = await this.pdfLoader.pdfDoc.getOutline();
      if (outline && outline.length > 0) {
        for (const item of outline) {
          const li = document.createElement("li");
          li.className = "toc-item";
          li.textContent = item.title;

          li.addEventListener("click", async () => {
            tracker.cancelCurrentPageDwell();
            let pageNum = 1;
            if (typeof item.dest === "string") {
              const dest = await this.pdfLoader.pdfDoc.getDestination(item.dest);
              if (dest) {
                const pageIndex = await this.pdfLoader.pdfDoc.getPageIndex(dest[0]);
                pageNum = pageIndex + 1;
              }
            } else if (Array.isArray(item.dest)) {
              const pageIndex = await this.pdfLoader.pdfDoc.getPageIndex(item.dest[0]);
              pageNum = pageIndex + 1;
            }
            await this.pdfLoader.goToPage(pageNum);
            this.closeDrawer("toc");
          });

          this.dom.tocList.appendChild(li);
        }
        return;
      }
    } catch (e) {
      console.warn("Chyba při čtení osnovy PDF:", e);
    }

    const numPages = this.pdfLoader.numPages || 0;
    if (numPages <= 0) {
      this.dom.tocList.innerHTML = `<li class="toc-empty">Dokument neobsahuje obsah.</li>`;
      return;
    }

    const step = numPages > 50 ? 10 : 1;
    for (let p = 1; p <= numPages; p += step) {
      const li = document.createElement("li");
      li.className = "toc-item";
      li.textContent = `Strana ${p}`;
      li.dataset.page = p;
      li.addEventListener("click", async () => {
        tracker.cancelCurrentPageDwell();
        await this.pdfLoader.goToPage(p);
        this.closeDrawer("toc");
      });
      this.dom.tocList.appendChild(li);
    }
  }

  async waitForContentReady() {
    // 1. Počkat na načtení webových fontů
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (e) {
        console.warn("[LuminaApp] document.fonts.ready varování:", e);
      }
    }

    // 2. Počkat na načtení a dekódování obrázků v kapitole
    if (this.dom.readerContent) {
      const mediaList = Array.from(this.dom.readerContent.querySelectorAll("img, image"));
      if (mediaList.length > 0) {
        const imagePromises = mediaList.map(el => {
          if (el.tagName.toLowerCase() === "img") {
            el.loading = "eager";
            el.decoding = "async";
            if (el.complete && el.naturalHeight !== 0) {
              return typeof el.decode === "function" ? el.decode().catch(() => {}) : Promise.resolve();
            }
            return new Promise(resolve => {
              const onFinish = () => {
                el.removeEventListener("load", onFinish);
                el.removeEventListener("error", onFinish);
                if (typeof el.decode === "function") {
                  el.decode().catch(() => {}).then(resolve);
                } else {
                  resolve();
                }
              };
              el.addEventListener("load", onFinish, { once: true });
              el.addEventListener("error", onFinish, { once: true });
            });
          }
          return Promise.resolve();
        });

        // Bezpečnostní timeout 1000ms pro případ offline/chybějících obrázků
        await Promise.race([
          Promise.all(imagePromises),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      }
    }

    // 3. Dvojitý requestAnimationFrame pro dokončení vykreslovacího a fragmentačního průchodu WebKitu
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  saveProgress(immediate = false) {
    if (!this.currentBook || (!this.currentParser && !this.isPdfMode)) return;

    const totalPages = this.isPdfMode
      ? (this.pdfLoader ? this.pdfLoader.numPages : 1)
      : Math.max(1, this.totalPagesInChapter || 1);
    const pageIndex = this.isPdfMode
      ? (this.pdfLoader ? Math.max(0, Math.min(totalPages - 1, this.pdfLoader.currentPage - 1)) : 0)
      : Math.max(0, Math.min(totalPages - 1, this.currentPageIndex || 0));
    const pageProgress = (pageIndex + 1) / totalPages;
    const pageRatio = totalPages > 1 ? pageIndex / (totalPages - 1) : 0;

    let computedProgress = 0;
    let currBookPageNum = 1;
    let totalBookPagesNum = 1;

    if (this.isPdfMode && this.pdfLoader) {
      currBookPageNum = this.pdfLoader.currentPage || (pageIndex + 1);
      totalBookPagesNum = this.pdfLoader.numPages || totalPages;
      computedProgress = totalBookPagesNum > 0 ? Math.round((currBookPageNum / totalBookPagesNum) * 100) : 0;
    } else {
      const metrics = this.getBookMetrics();
      currBookPageNum = metrics?.currBookPage || (pageIndex + 1);
      totalBookPagesNum = metrics?.totalBookPages || totalPages;
      computedProgress = (totalBookPagesNum > 0)
        ? Math.round((currBookPageNum / totalBookPagesNum) * 100)
        : 0;
    }
    computedProgress = Math.max(0, Math.min(100, Math.round(computedProgress)));

    const progressData = {
      currentChapterIndex: this.currentChapterIndex || 0,
      currentPageIndex: pageIndex,
      pageRatio: pageRatio,
      scrollPercent: pageProgress,
      progress: computedProgress,
      progressPercent: computedProgress,
      currentPage: currBookPageNum,
      numPages: totalBookPagesNum,
      lastReadAt: Date.now()
    };

    // Synchronizace parametrů v paměti aplikace
    this.currentBook.currentChapterIndex = this.currentChapterIndex;
    this.currentBook.currentPageIndex = pageIndex;
    this.currentBook.pageRatio = pageRatio;
    this.currentBook.scrollPercent = pageProgress;
    this.currentBook.progress = computedProgress;
    this.currentBook.progressPercent = computedProgress;
    this.currentBook.currentPage = currBookPageNum;
    this.currentBook.numPages = totalBookPagesNum;
    this.currentBook.lastReadAt = progressData.lastReadAt;

    if (this.isVerticalReadingMode() && this.dom.pagedViewport) {
      if (this.isPdfMode) {
        const vp = this.dom.pagedViewport;
        const maxScroll = Math.max(1, vp.scrollHeight - vp.clientHeight);
        const vRatio = Math.max(0, Math.min(1, vp.scrollTop / maxScroll));
        progressData.pageRatio = vRatio;
        progressData.scrollPercent = vRatio;
        this.currentBook.pageRatio = vRatio;
        this.currentBook.scrollPercent = vRatio;

        if (this.pdfLoader && this.pdfLoader.currentPage && this.pdfLoader.numPages) {
          const vProg = Math.max(0, Math.min(100, Math.round((this.pdfLoader.currentPage / this.pdfLoader.numPages) * 100)));
          progressData.progress = vProg;
          progressData.progressPercent = vProg;
          progressData.currentPage = this.pdfLoader.currentPage;
          progressData.numPages = this.pdfLoader.numPages;
          this.currentBook.progress = vProg;
          this.currentBook.progressPercent = vProg;
          this.currentBook.currentPage = this.pdfLoader.currentPage;
          this.currentBook.numPages = this.pdfLoader.numPages;
        } else {
          const vProg = Math.max(0, Math.min(100, Math.round(vRatio * 100)));
          progressData.progress = vProg;
          progressData.progressPercent = vProg;
          this.currentBook.progress = vProg;
          this.currentBook.progressPercent = vProg;
        }
      } else {
        const activeSection = this.getActiveVerticalChapterSection();
        if (activeSection) {
          const vp = this.dom.pagedViewport;
          const secHeight = Math.max(1, activeSection.offsetHeight);
          const maxSecScroll = Math.max(1, secHeight - vp.clientHeight);
          const scrollIntoSec = Math.max(0, Math.min(maxSecScroll, vp.scrollTop - activeSection.offsetTop));
          const chapterRatio = maxSecScroll > 0 ? scrollIntoSec / maxSecScroll : 0;

          const chIdx = parseInt(activeSection.dataset.chapterIndex, 10);
          progressData.currentChapterIndex = chIdx;
          progressData.pageRatio = chapterRatio;
          progressData.scrollPercent = chapterRatio;
          this.currentBook.currentChapterIndex = chIdx;
          this.currentBook.pageRatio = chapterRatio;
          this.currentBook.scrollPercent = chapterRatio;

          const metrics = this.getBookMetrics();
          const vProg = (metrics && metrics.totalBookPages > 0) ? Math.min(100, Math.round((metrics.currBookPage / metrics.totalBookPages) * 100)) : 0;
          progressData.progress = vProg;
          progressData.progressPercent = vProg;
          progressData.currentPage = metrics.currBookPage;
          progressData.numPages = metrics.totalBookPages;
          this.currentBook.progress = vProg;
          this.currentBook.progressPercent = vProg;
          this.currentBook.currentPage = metrics.currBookPage;
          this.currentBook.numPages = metrics.totalBookPages;
        }
      }
    }

    // 1. Okamžitý synchronní zápis do localStorage pro ochranu před reloadem/pádem záložky
    try {
      localStorage.setItem(`lumina_progress_${this.currentBook.id}`, JSON.stringify(progressData));
      localStorage.setItem("lumina_last_book_id", this.currentBook.id);
      localStorage.setItem("lumina_active_view", "reader");
    } catch (e) {
      console.warn("[LuminaApp] Chyba při zápisu postupu do localStorage:", e);
    }

    // 2. Trvalý asynchronní zápis do IndexedDB (debounced nebo okamžitý)
    if (this.saveProgressTimer) {
      clearTimeout(this.saveProgressTimer);
      this.saveProgressTimer = null;
    }

    const doSaveIDB = () => {
      storage.updateBookProgress(this.currentBook.id, progressData).catch(err => {
        console.warn("[LuminaApp] Chyba při ukládání postupu do IndexedDB:", err);
      });
      supabaseSync.syncProgress(this.currentBook.id, progressData, { immediate });
    };

    if (immediate) {
      doSaveIDB();
    } else {
      this.saveProgressTimer = setTimeout(doSaveIDB, 300);
    }
  }

  // --- KONTINUÁLNÍ ČTENÍ A SPRÁVA KAPITOL PRO EPUB (MODE-VERTICAL) ---

  async getOrLoadChapter(index) {
    if (!this.currentParser) throw new Error("Parser není k dispozici");
    if (!this._chapterDataCache) {
      this._chapterDataCache = new Map();
    }
    if (this._chapterDataCache.has(index)) {
      return this._chapterDataCache.get(index);
    }
    const chapterData = await this.currentParser.loadChapter(index);
    this._chapterDataCache.set(index, chapterData);
    return chapterData;
  }

  getChapterTitle(index) {
    if (this._chapterDataCache?.has(index)) {
      const data = this._chapterDataCache.get(index);
      if (data?.title) return data.title;
    }
    if (this.currentParser?.spine && this.currentParser.spine[index]) {
      const spineEntry = this.currentParser.spine[index];
      if (spineEntry.title) return spineEntry.title;
      if (this.currentParser.toc) {
        const cleanSpine = (spineEntry.fullPath || "").split("#")[0].split("?")[0];
        const found = this.currentParser.toc.find(t => {
          if (!t?.fullHref) return false;
          const cleanToc = t.fullHref.split("#")[0].split("?")[0];
          return cleanToc === cleanSpine;
        });
        if (found?.title) return found.title;
      }
    }
    return `Kapitola ${index + 1}`;
  }

  createChapterSectionElement(chapterIndex, rawHtml) {
    const section = document.createElement("section");
    section.className = "epub-chapter-section";
    section.dataset.chapterIndex = String(chapterIndex);

    section.innerHTML = rawHtml || "";

    const imgs = section.querySelectorAll("img");
    imgs.forEach(img => {
      img.loading = "eager";
      img.decoding = "async";
    });

    return section;
  }

  attachImageLoadHandlers(sectionEl, isPrepended = false) {
    if (!sectionEl) return;
    const vp = this.dom.pagedViewport;
    const imgs = sectionEl.querySelectorAll("img");
    imgs.forEach(img => {
      if (!img.complete) {
        let prevImgHeight = img.offsetHeight;
        img.addEventListener("load", () => {
          if (isPrepended && vp && vp.scrollTop > 0) {
            const hDiff = img.offsetHeight - prevImgHeight;
            if (hDiff !== 0) {
              vp.scrollTop += hDiff;
              if (this.ruler && this.ruler.enabled && Number.isFinite(this.ruler.currentY)) {
                this.ruler.currentY += hDiff;
              }
            }
          }
          if (this.ruler && this.ruler.enabled) {
            if (typeof this.ruler.refreshLinesDebounced === "function") {
              this.ruler.refreshLinesDebounced(100);
            } else {
              this.ruler.refreshLines();
            }
          }
        }, { once: true });
      }
    });
  }

  getActiveVerticalChapterSection() {
    if (!this.dom.readerContent || !this.dom.pagedViewport) return null;
    const sections = this.dom.readerContent.querySelectorAll(".epub-chapter-section");
    if (sections.length === 0) return null;
    if (sections.length === 1) return sections[0];

    const vpRect = this.dom.pagedViewport.getBoundingClientRect();
    const vpCenterY = vpRect.top + vpRect.height / 2;

    let activeSection = null;
    let minDistance = Infinity;

    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      if (rect.top <= vpCenterY && rect.bottom >= vpCenterY) {
        return sec;
      }
      const dist = Math.abs((rect.top + rect.bottom) / 2 - vpCenterY);
      if (dist < minDistance) {
        minDistance = dist;
        activeSection = sec;
      }
    }

    return activeSection || sections[0];
  }

  getLastLoadedChapterSection() {
    if (!this.dom.readerContent) return null;
    const sections = this.dom.readerContent.querySelectorAll(".epub-chapter-section");
    if (sections.length === 0) return null;
    let maxIdx = -1;
    let lastSection = null;
    sections.forEach(sec => {
      const idx = parseInt(sec.dataset.chapterIndex, 10);
      if (idx > maxIdx) {
        maxIdx = idx;
        lastSection = sec;
      }
    });
    return lastSection;
  }

  getFirstLoadedChapterSection() {
    if (!this.dom.readerContent) return null;
    const sections = this.dom.readerContent.querySelectorAll(".epub-chapter-section");
    if (sections.length === 0) return null;
    let minIdx = Infinity;
    let firstSection = null;
    sections.forEach(sec => {
      const idx = parseInt(sec.dataset.chapterIndex, 10);
      if (idx < minIdx) {
        minIdx = idx;
        firstSection = sec;
      }
    });
    return firstSection;
  }

  checkVerticalInfiniteScroll() {
    if (!this.isVerticalReadingMode() || this.isPdfMode || !this.currentParser || this._isModeTransitioning) return;
    const vp = this.dom.pagedViewport;
    if (!vp) return;

    const sections = this.dom.readerContent?.querySelectorAll(".epub-chapter-section");
    if (!sections || sections.length === 0) return;

    // 1. Spodní práh pro dynamické postupné připojování (Forward Appending - 600px)
    if (!this._isLoadingNextChapter) {
      const lastSection = this.getLastLoadedChapterSection();
      if (lastSection) {
        const maxIdx = parseInt(lastSection.dataset.chapterIndex, 10);
        if (maxIdx < this.currentParser.spine.length - 1) {
          const lastRect = lastSection.getBoundingClientRect();
          const vpRect = vp.getBoundingClientRect();
          const distToBottom = lastRect.bottom - vpRect.bottom;
          if (distToBottom <= 600) {
            this.appendNextChapter(maxIdx + 1);
          }
        }
      }
    }

    // 2. Horní práh pro dynamické zpětné předřazování (Backward Prepending - 600px)
    if (!this._isLoadingPrevChapter) {
      const firstSection = this.getFirstLoadedChapterSection();
      if (firstSection) {
        const minIdx = parseInt(firstSection.dataset.chapterIndex, 10);
        if (minIdx > 0) {
          const firstRect = firstSection.getBoundingClientRect();
          const vpRect = vp.getBoundingClientRect();
          const distToTop = vpRect.top - firstRect.top;
          if (vp.scrollTop <= 600 || distToTop <= 600) {
            this.prependPrevChapter(minIdx - 1);
          }
        }
      }
    }
  }

  async appendNextChapter(nextIdx) {
    if (this._isLoadingNextChapter || !this.isVerticalReadingMode() || this.isPdfMode || !this.currentParser || this._isModeTransitioning) return;
    if (nextIdx >= this.currentParser.spine.length) return;

    this._isLoadingNextChapter = true;
    try {
      const chapterData = await this.getOrLoadChapter(nextIdx);
      if (!this.isVerticalReadingMode() || !this.currentParser || this._isModeTransitioning) return;

      if (!this.dom.readerContent.querySelector(`.epub-chapter-section[data-chapter-index="${nextIdx}"]`)) {
        const sectionEl = this.createChapterSectionElement(nextIdx, chapterData.html);
        this.dom.readerContent.appendChild(sectionEl);
        if (this.settings.fastReading) {
          this.updateVisibleBionicNodes();
        }

        this.attachImageLoadHandlers(sectionEl, false);

        if (this.ruler && this.ruler.enabled) {
          if (typeof this.ruler.refreshLinesDebounced === "function") {
            this.ruler.refreshLinesDebounced(150);
          } else {
            this.ruler.refreshLines();
          }
        }

        requestAnimationFrame(() => {
          this.checkVerticalInfiniteScroll();
        });
      }
    } catch (err) {
      console.error(`Chyba při načítání následující kapitoly ${nextIdx}:`, err);
    } finally {
      this._isLoadingNextChapter = false;
    }
  }

  async prependPrevChapter(prevIdx) {
    if (this._isLoadingPrevChapter || !this.isVerticalReadingMode() || this.isPdfMode || !this.currentParser || this._isModeTransitioning) return;
    if (prevIdx < 0) return;

    this._isLoadingPrevChapter = true;
    const vp = this.dom.pagedViewport;
    try {
      const chapterData = await this.getOrLoadChapter(prevIdx);
      if (!this.isVerticalReadingMode() || !this.currentParser || this._isModeTransitioning) return;

      if (!this.dom.readerContent.querySelector(`.epub-chapter-section[data-chapter-index="${prevIdx}"]`)) {
        const sectionEl = this.createChapterSectionElement(prevIdx, chapterData.html);

        const prevScrollHeight = vp.scrollHeight;
        const prevScrollTop = vp.scrollTop;

        this.dom.readerContent.prepend(sectionEl);

        const addedHeight = vp.scrollHeight - prevScrollHeight;
        vp.scrollTop = prevScrollTop + addedHeight;
        if (this.settings.fastReading) {
          this.updateVisibleBionicNodes();
        }

        if (this.ruler && this.ruler.enabled && Number.isFinite(this.ruler.currentY)) {
          this.ruler.currentY += addedHeight;
        }

        this.attachImageLoadHandlers(sectionEl, true);

        if (this.ruler && this.ruler.enabled) {
          if (typeof this.ruler.refreshLinesDebounced === "function") {
            this.ruler.refreshLinesDebounced(150);
          } else {
            this.ruler.refreshLines();
          }
        }
      }
    } catch (err) {
      console.error(`Chyba při přednačítání předchozí kapitoly ${prevIdx}:`, err);
    } finally {
      this._isLoadingPrevChapter = false;
    }
  }

  async loadVerticalCurrentChapter(targetPage = 0) {
    const stage = this.dom.pagedStage;
    if (stage) {
      stage.classList.add("is-chapter-loading");
      stage.style.transition = "none";
      stage.style.opacity = "0";
    }
    if (this.dom.readerContent) {
      this.dom.readerContent.classList.add("is-chapter-loading");
      this.dom.readerContent.style.transition = "none";
      this.dom.readerContent.style.opacity = "0";
      this.dom.readerContent.style.transform = "none";
    }
    if (this.ruler && this.ruler.enabled) {
      this.ruler.hideForPageTransition();
    }

    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.isLineLocked = true;

    try {
      const chapterData = await this.getOrLoadChapter(this.currentChapterIndex);
      this.currentRawChapterHtml = chapterData.html;

      const title = chapterData.title || this.getChapterTitle(this.currentChapterIndex);
      if (this.dom.chapterTitleEl) this.dom.chapterTitleEl.textContent = title;
      if (this.dom.pagedChapterName) this.dom.pagedChapterName.textContent = title;
      if (this.dom.footerTitleText) this.dom.footerTitleText.textContent = title;
      if (this.dom.bookTitleEl && this.currentBook?.title) this.dom.bookTitleEl.textContent = this.currentBook.title;

      // Vyprázdníme #reader-content a vložíme pouze sekci cílové kapitoly
      this.dom.readerContent.classList.toggle("bionic-active", !!this.settings.fastReading);
      this.dom.readerContent.innerHTML = "";
      const sectionEl = this.createChapterSectionElement(this.currentChapterIndex, chapterData.html);
      this.dom.readerContent.appendChild(sectionEl);

      this.attachImageLoadHandlers(sectionEl, false);

      tracker.startSession(
        this.currentBook.id,
        this.currentBook.title,
        this.currentChapterIndex,
        chapterData.wordCount,
        0
      );

      this.highlightActiveTocItem();

      await this.waitForContentReady();

      const vp = this.dom.pagedViewport;
      if (vp) {
        if (targetPage === "last") {
          vp.scrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
        } else if (typeof targetPage === "object" && targetPage !== null && targetPage.ratio !== undefined) {
          vp.scrollTop = Math.round(targetPage.ratio * Math.max(0, vp.scrollHeight - vp.clientHeight));
        } else if (typeof targetPage === "number" && targetPage > 0) {
          vp.scrollTop = Math.round(targetPage * vp.clientHeight);
        } else {
          vp.scrollTop = 0;
        }
      }

      this.updateVisibleBionicNodes();
      this.updatePageUI();

      if (this.ruler && this.ruler.enabled) {
        this.ruler.refreshLines();
        if (this.ruler.wordTracking) this.ruler.refreshWords();
        if (this.ruler.followMode === "keyboard" && this.ruler.stationaryScreenY === null) {
          this.ruler.initDefaultStationaryAnchor();
        } else {
          this.ruler.applyPosition();
        }
      }
    } catch (e) {
      console.error("Chyba při načítání kapitoly ve vertikálním režimu:", e);
      this.showToast(`Chyba při načítání kapitoly: ${e.message}`, "error");
    } finally {
      if (stage) {
        stage.classList.remove("is-chapter-loading");
        stage.style.opacity = "1";
      }
      if (this.dom.readerContent) {
        this.dom.readerContent.classList.remove("is-chapter-loading");
        this.dom.readerContent.style.opacity = "1";
      }
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }
  }

  async loadCurrentChapter(targetPage = 0) {
    if (!this.currentParser) return;
    tracker.cancelCurrentPageDwell();

    // Pojistka: pokud je čtečka skrytá, zobrazíme ji před měřením
    if (this.dom.viewReader && this.dom.viewReader.classList.contains("is-hidden")) {
      this.showReaderView();
    }

    if (this.isVerticalReadingMode()) {
      return await this.loadVerticalCurrentChapter(targetPage);
    }

    // Phase 1 (Lock & Shield): Vizuální stínění během přechodu kapitoly
    const stage = this.dom.pagedStage;
    if (stage) {
      stage.classList.add("is-chapter-loading");
      stage.style.transition = "none";
      stage.style.opacity = "0";
    }
    if (this.dom.readerContent) {
      this.dom.readerContent.classList.add("is-chapter-loading");
      this.dom.readerContent.style.transition = "none";
      this.dom.readerContent.style.opacity = "0";
    }

    if (this.ruler && this.ruler.enabled) {
      this.ruler.hideForPageTransition();
    }

    // 1. Okamžitý reset indexu a transformace před načtením a vložením nového DOMu
    if (targetPage !== "last") {
      this.currentPageIndex = (typeof targetPage === "number") ? targetPage : (targetPage?.pageIndex ?? 0);
      if (this.dom.readerContent) {
        this.dom.readerContent.style.transform = "translate3d(0px, 0, 0)";
      }
    } else {
      this.currentPageIndex = 0;
    }

    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.isLineLocked = true;
    if (this.ruler) {
      this.ruler.isNavigating = true;
      this.ruler.isNavigatingPage = true;
      this.ruler.isLineLocked = true;
      if (targetPage !== "last") {
        this.ruler.activeLineIndex = 0;
        this.ruler.activeWordIndex = 0;
      }
    }

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked || this.ruler?.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        if (this.ruler) {
          this.ruler.forceReleaseNavigationLocks();
        }
      }
    }, 1000);

    const chapterTimeout = setTimeout(() => {
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }, 1000);

    try {
      const chapter = await this.currentParser.loadChapter(this.currentChapterIndex);
      this.currentRawChapterHtml = chapter.html;
      if (this.dom.chapterTitleEl) this.dom.chapterTitleEl.textContent = chapter.title;
      if (this.dom.pagedChapterName) this.dom.pagedChapterName.textContent = chapter.title;
      this.renderChapterHtml();

      // Dynamické sledování obrázků: pokud se nějaký obrázek donačte později, přepočítat layout
      if (this.dom.readerContent) {
        const imgs = this.dom.readerContent.querySelectorAll("img");
        imgs.forEach(img => {
          if (!img.complete) {
            img.addEventListener("load", () => {
              this.recalcPages();
              this.goToPage(this.currentPageIndex, null, true, { isReflow: true });
            }, { once: true });
          }
        });
      }

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

      // Počkáme na stabilizaci fontů a obrázků před výpočtem rozložení stran
      await this.waitForContentReady();

      this.recalcPages();

      let finalPageIndex = 0;
      let navDirection = 1;

      if (targetPage === "last") {
        finalPageIndex = Math.max(0, this.totalPagesInChapter - 1);
        navDirection = -1;
      } else if (typeof targetPage === "object" && targetPage !== null) {
        if (typeof targetPage.pageIndex === "number" && targetPage.pageIndex >= 0) {
          finalPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, targetPage.pageIndex));
        } else if (targetPage.ratio !== undefined) {
          finalPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, Math.round(targetPage.ratio * (this.totalPagesInChapter - 1))));
        } else if (typeof targetPage.fallbackPage === "number") {
          finalPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, targetPage.fallbackPage));
        }
        navDirection = finalPageIndex > 0 ? 1 : 0;
      } else if (typeof targetPage === "number") {
        finalPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, targetPage));
        navDirection = finalPageIndex > 0 ? 1 : 0;
      }

      // Phase 3 (Immediate Ruler Re-Indexing & Masking): Synchronní usazení a zamaskování
      this.goToPage(finalPageIndex, navDirection, true, { isInitialLoad: true });

      // Pojistka synchronního refreshnutí a zamaskování pravítka pro cílovou stránku
      if (this.ruler && this.ruler.enabled) {
        this.ruler.resetPositionForPage(navDirection, true);
      }

      // Phase 4 (Reveal): Obnovení viditelnosti po ukotvení a zamaskování cílové strany
      if (stage) {
        stage.classList.remove("is-chapter-loading");
        void stage.offsetWidth;
        stage.style.opacity = "1";
      }
      if (this.dom.readerContent) {
        this.dom.readerContent.classList.remove("is-chapter-loading");
        void this.dom.readerContent.offsetWidth; // Vynutíme uplatnění cílové transformace před odhalením
        this.dom.readerContent.style.opacity = "1";
      }
      requestAnimationFrame(() => {
        if (stage) {
          stage.style.transition = "";
        }
        if (this.dom.readerContent) {
          this.dom.readerContent.style.transition = "";
        }
      });
    } catch (e) {
      if (stage) {
        stage.classList.remove("is-chapter-loading");
        stage.style.transition = "";
        stage.style.opacity = "1";
      }
      if (this.dom.readerContent) {
        this.dom.readerContent.classList.remove("is-chapter-loading");
        this.dom.readerContent.style.transition = "";
        this.dom.readerContent.style.opacity = "1";
      }
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
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
    } finally {
      clearTimeout(chapterTimeout);
      clearTimeout(this._navSafetyTimer);
      if (stage) {
        stage.classList.remove("is-chapter-loading");
        if (stage.style.opacity === "0") {
          stage.style.transition = "";
          stage.style.opacity = "1";
        }
      }
      if (this.dom.readerContent) {
        this.dom.readerContent.classList.remove("is-chapter-loading");
        if (this.dom.readerContent.style.opacity === "0") {
          this.dom.readerContent.style.transition = "";
          this.dom.readerContent.style.opacity = "1";
        }
      }
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }
  }

  renderChapterHtml() {
    if (!this.dom.readerContent) return;
    this.dom.readerContent.classList.toggle("bionic-active", !!this.settings.fastReading);
    this.dom.readerContent.innerHTML = this.currentRawChapterHtml || "";
    const imgs = this.dom.readerContent.querySelectorAll("img");
    imgs.forEach(img => {
      img.loading = "eager";
      img.decoding = "async";
    });
  }

  updateVisibleBionicNodes() {
    if (!this.dom.readerContent || this.isPdfMode) return;
    if (!this._originalBlockHtml) {
      this._originalBlockHtml = new WeakMap();
    }
    if (!this._bionicBlockHtml) {
      this._bionicBlockHtml = new WeakMap();
    }

    const isFast = !!this.settings.fastReading;
    this.dom.readerContent.classList.toggle("bionic-active", isFast);

    if (!isFast) {
      const appliedEls = this.dom.readerContent.querySelectorAll('[data-bionic-applied="true"]');
      for (let i = 0; i < appliedEls.length; i++) {
        const el = appliedEls[i];
        const origHtml = this._originalBlockHtml.get(el);
        if (origHtml !== undefined) {
          el.innerHTML = origHtml;
        }
        el.removeAttribute("data-bionic-applied");
      }
      return;
    }

    const isVertical = this.isVerticalReadingMode();
    const stage = this.dom.pagedStage || document.getElementById("paged-stage");
    const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");

    let leftBound = 0;
    let rightBound = window.innerWidth;
    let topBound = 0;
    let bottomBound = window.innerHeight;

    if (isVertical) {
      const vpRect = vp ? vp.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, height: window.innerHeight };
      const pageH = vpRect.height || window.innerHeight;
      leftBound = vpRect.left - 20;
      rightBound = vpRect.right + 20;
      topBound = vpRect.top - pageH;
      bottomBound = vpRect.bottom + pageH;
    } else if (stage) {
      const stageRect = stage.getBoundingClientRect();
      if (stageRect.width > 20 && stageRect.height > 20) {
        leftBound = stageRect.left + 2;
        rightBound = stageRect.right - 2;
        topBound = stageRect.top - 10;
        bottomBound = stageRect.bottom + 10;
      }
    }

    const blocks = this.dom.readerContent.querySelectorAll(BIONIC_BLOCK_SELECTOR);
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const isApplied = el.dataset.bionicApplied === "true";

      if (!isApplied && el.querySelector(BIONIC_BLOCK_SELECTOR)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      const isVisible = (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > leftBound &&
        rect.left < rightBound &&
        rect.bottom > topBound &&
        rect.top < bottomBound
      );

      if (isVisible) {
        if (!isApplied) {
          if (!/[\p{L}\p{N}]/u.test(el.textContent || "")) continue;
          let origHtml = this._originalBlockHtml.get(el);
          if (origHtml === undefined) {
            origHtml = el.innerHTML;
            this._originalBlockHtml.set(el, origHtml);
          }
          let bionicHtml = this._bionicBlockHtml.get(el);
          if (bionicHtml === undefined) {
            bionicHtml = this.toBionicReadingHtml(origHtml);
            this._bionicBlockHtml.set(el, bionicHtml);
          }
          el.innerHTML = bionicHtml;
          el.dataset.bionicApplied = "true";
        }
      } else if (isApplied) {
        const origHtml = this._originalBlockHtml.get(el);
        if (origHtml !== undefined) {
          el.innerHTML = origHtml;
        }
        el.removeAttribute("data-bionic-applied");
      }
    }
  }

  applyFastReadingMode() {
    if (!this.currentBook || !this.dom.readerContent || this.isPdfMode) return;

    if (this._bionicIdleCallbackId) {
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(this._bionicIdleCallbackId);
      } else {
        clearTimeout(this._bionicIdleCallbackId);
      }
      this._bionicIdleCallbackId = null;
    }

    this.dom.readerContent.classList.toggle("bionic-active", !!this.settings.fastReading);
    this.updateVisibleBionicNodes();

    if (this.ruler && this.ruler.enabled) {
      this.ruler.refreshLines();
      if (this.ruler.wordTracking) {
        this.ruler.refreshWords();
      }
      this.ruler.applyPosition();
    }
  }

  toBionicReadingHtml(html, chapterIndex = null) {
    if (!html || typeof html !== "string") return html;
    if (!this._bionicHtmlCache) {
      this._bionicHtmlCache = new Map();
    }
    const cacheKey = (chapterIndex !== null && chapterIndex !== undefined && !Number.isNaN(chapterIndex))
      ? `${this.currentBook?.id || "book"}:${chapterIndex}:${html.length}`
      : `raw:${html.length}:${html.slice(0, 48)}:${html.slice(-48)}`;

    const cachedEntry = this._bionicHtmlCache.get(cacheKey);
    if (cachedEntry && cachedEntry.source === html) {
      this._bionicHtmlCache.delete(cacheKey);
      this._bionicHtmlCache.set(cacheKey, cachedEntry);
      return cachedEntry.result;
    }

    try {
      // Single-pass HTML-aware regex: skips script/style/code/pre/svg blocks, HTML comments, tags, and entities,
      // and wraps only the bold prefix of each Unicode word in <b class="bionic-fixation"> without wrapper spans.
      HTML_BIONIC_REGEX.lastIndex = 0;
      const result = html.replace(HTML_BIONIC_REGEX, (match, skippedToken, word) => {
        if (skippedToken) return skippedToken;
        const len = word.length;
        const boldLen = len <= 3 ? 1 : Math.ceil(len * 0.45);
        return `<b class="bionic-fixation">${word.slice(0, boldLen)}</b>${word.slice(boldLen)}`;
      });

      if (this._bionicHtmlCache.size >= 10) {
        const oldestKey = this._bionicHtmlCache.keys().next().value;
        if (oldestKey !== undefined) {
          this._bionicHtmlCache.delete(oldestKey);
        }
      }
      this._bionicHtmlCache.set(cacheKey, { source: html, result });
      return result;
    } catch (e) {
      console.warn("Chyba při formátování rychlého čtení (Bionic):", e);
      return html;
    }
  }

  recalcPages() {
    if (this.isPdfMode) {
      if (this.pdfLoader) {
        this.totalPagesInChapter = this.pdfLoader.numPages || 1;
        this.currentPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, (this.pdfLoader.currentPage || 1) - 1));
      }
      this.updatePageUI();
      return;
    }
    if (this.isVerticalReadingMode()) {
      const activeSection = this.getActiveVerticalChapterSection();
      const vp = this.dom.pagedViewport;
      const vpHeight = Math.max(1, vp?.clientHeight || 1);
      const secHeight = Math.max(1, activeSection ? activeSection.offsetHeight : (vp?.scrollHeight || 1));
      this.totalPagesInChapter = Math.max(1, Math.ceil(secHeight / vpHeight));
      this.updatePageUI();
      return;
    }
    if (!this.dom.pagedStage || !this.dom.readerContent) return;
    const { stageWidth, gap, exactStep } = this.getExactColumnStep();
    if (stageWidth <= 0 || exactStep <= 0) return;
    this.pageGap = gap;
    const scrollWidth = this.dom.readerContent.scrollWidth;

    // Bezpečnostní práh pro sub-pixelový přetisk a mezeru mezi sloupci
    const safetyThreshold = Math.max(5, Math.min(gap * 0.5, 15));
    if (scrollWidth <= stageWidth + safetyThreshold) {
      this.totalPagesInChapter = 1;
    } else {
      this.totalPagesInChapter = 1 + Math.ceil((scrollWidth - stageWidth - safetyThreshold) / exactStep);
    }

    this.currentPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, this.currentPageIndex));

    this.updatePageUI();
  }

  /**
   * Spočítá počet slov viditelných na aktuální obrazovce/sloupci.
   * Pro EPUB v paged módu prochází DOM elementy viditelné v bounding boxu #paged-stage,
   * s robustním fallbackem na rovnoměrné rozdělení slov kapitoly [40, 650] slov.
   */
  getVisibleWordsOnCurrentPage() {
    if (this.isPdfMode) {
      if (this.pdfLoader) {
        return this.pdfLoader.getVisibleWords();
      }
      return 0;
    }

    if (this.isVerticalReadingMode()) {
      const vp = this.dom.pagedViewport;
      const activeSec = this.getActiveVerticalChapterSection();
      if (vp && activeSec) {
        const secWords = parseInt(activeSec.dataset.wordCount, 10) || 1000;
        const secHeight = Math.max(1, activeSec.offsetHeight);
        const vpHeight = Math.min(secHeight, vp.clientHeight);
        const ratio = vpHeight / secHeight;
        return Math.max(40, Math.min(650, Math.round(secWords * ratio)));
      }
      return 250;
    }

    // Horizontální stránkovaný režim EPUB:
    if (this.ruler && this.ruler.enabled && this.ruler.wordTracking && this.ruler.cachedWords && this.ruler.cachedWords.length > 0) {
      return this.ruler.cachedWords.length;
    }

    const chapterWords = this.currentChapterWords || tracker.currentChapterWords || 1000;
    const pages = Math.max(1, this.totalPagesInChapter || 1);
    return Math.max(40, Math.min(650, Math.round(chapterWords / pages)));
  }

  goToPage(pageIndex, explicitDirection = null, immediateRuler = true, options = {}) {
    if (options.isNavigationJump || options.isReflow) {
      tracker.cancelCurrentPageDwell();
    }
    if (this.isPdfMode && this.pdfLoader) {
      const targetPage = Math.max(1, Math.min(this.pdfLoader.numPages, pageIndex + 1));
      if (options.isReflow && targetPage === this.pdfLoader.currentPage) {
        if (this.ruler && this.ruler.enabled) {
          this.ruler.applyPosition();
        }
        return;
      }
      this.pdfLoader.goToPage(targetPage, explicitDirection);
      return;
    }
    if (this.isVerticalReadingMode()) {
      if (this.dom.readerContent) {
        this.dom.readerContent.style.transform = "none";
      }
      this.updateVisibleBionicNodes();
      this.updatePageUI();
      this.saveProgress();
      if (this.ruler && this.ruler.enabled) {
        this.ruler.refreshLines();
        if (this.ruler.wordTracking) this.ruler.refreshWords();
        this.ruler.applyPosition();
      }
      return;
    }
    const oldIndex = this.currentPageIndex;
    this.currentPageIndex = Math.max(0, Math.min(this.totalPagesInChapter - 1, pageIndex));
    const { stageWidth, gap, exactStep } = this.getExactColumnStep();
    this.pageGap = gap;
    const offset = this.currentPageIndex * exactStep;

    const isPageChanged = oldIndex !== this.currentPageIndex || explicitDirection !== null;
    const direction = explicitDirection !== null
      ? explicitDirection
      : (this.currentPageIndex > oldIndex ? 1 : (this.currentPageIndex < oldIndex ? -1 : 0));

    const stage = this.dom.pagedStage;
    if (isPageChanged) {
      if (stage) stage.classList.add("is-turning-page");
      if (this.dom.readerContent) this.dom.readerContent.classList.add("is-turning-page");
      document.body.classList.add("is-turning-page");
    }

    // Post-navigation zámek pro debouncing syntetických gest a eventů na iPadu (WebKit)
    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.isLineLocked = true;
    if (this.ruler) {
      this.ruler.isLineLocked = true;
      this.ruler.isNavigating = true;
      this.ruler.isNavigatingPage = true;
      if (direction >= 0) {
        this.ruler.activeLineIndex = 0;
        this.ruler.activeWordIndex = 0;
      }
    }

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked || this.ruler?.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        if (stage) stage.classList.remove("is-turning-page");
        if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (this.ruler) {
          this.ruler.forceReleaseNavigationLocks();
        }
      }
    }, 300); // 300ms maximum lock lifetime

    // Failsafe timeout pro zaručené odemčení navigačního zámku
    if (this.navigatingPageTimer) clearTimeout(this.navigatingPageTimer);
    this.navigatingPageTimer = setTimeout(() => {
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (stage) stage.classList.remove("is-turning-page");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
      document.body.classList.remove("is-turning-page");
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
      this.navigatingPageTimer = null;
    }, 200);

    try {
      if (this.dom.readerContent) {
        this.dom.readerContent.style.transition = "none";
        this.dom.readerContent.style.transform = `translate3d(-${(this.currentPageIndex * exactStep).toFixed(2)}px, 0, 0)`;
      }
      this.updateVisibleBionicNodes();

      // Zaznamenání přechodu stránky do trackeru s přesným počtem viditelných slov a dwell time
      if (isPageChanged || options.isInitialLoad) {
        this.wordsCreditedOnCurrentPage = 0;
      }
      if (this.currentBook) {
        const visibleWords = this.getVisibleWordsOnCurrentPage();
        tracker.onPageChange({
          bookId: this.currentBook.id,
          bookTitle: this.currentBook.title,
          chapterIndex: this.currentChapterIndex,
          pageIndex: this.currentPageIndex,
          visibleWords: visibleWords,
          direction: direction,
          isReflow: !!options.isReflow,
          isInitialLoad: !!options.isInitialLoad,
          isNavigationJump: !!options.isNavigationJump
        });
      }

      // Měření postupu
      const pageProgress = (this.currentPageIndex + 1) / this.totalPagesInChapter;
      tracker.updateScrollProgress(pageProgress);

      this.updatePageUI();

      // Uložení pozice do storage (debounced v saveProgress, synchronně do localStorage)
      this.saveProgress();

      // Aktualizace řádků pro pravítko na nové stránce s přesným směrem a detekcí změny
      try {
        this.ruler?.onPageChange(direction, isPageChanged, immediateRuler);
      } catch (rulerErr) {
        console.error("[LuminaApp] Error updating ruler on page change:", rulerErr);
      }

      requestAnimationFrame(() => {
        if (stage) stage.classList.remove("is-turning-page");
        if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
      });
    } catch (err) {
      console.error('Page navigation error:', err);
    } finally {
      // Synchronní uvolnění navigačního zámku ihned po vykreslení DOMu a změření řádků
      clearTimeout(this._navSafetyTimer);
      if (this.navigatingPageTimer) {
        clearTimeout(this.navigatingPageTimer);
        this.navigatingPageTimer = null;
      }
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (stage) stage.classList.remove("is-turning-page");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
      document.body.classList.remove("is-turning-page");
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }
  }

  async nextPage() {
    if (this.isVerticalReadingMode()) {
      const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
      if (vp) {
        const stride = Math.round(vp.clientHeight * 0.85);
        const maxScroll = vp.scrollHeight - vp.clientHeight;
        if (vp.scrollTop + stride >= maxScroll - 20) {
          const lastSec = this.getLastLoadedChapterSection();
          const lastIdx = lastSec ? parseInt(lastSec.dataset.chapterIndex, 10) : this.currentChapterIndex;
          if (!this.isPdfMode && this.currentParser && lastIdx < this.currentParser.spine.length - 1) {
            await this.appendNextChapter(lastIdx + 1);
          } else if (vp.scrollTop >= maxScroll - 5) {
            this.showToast("Dočetli jste knihu až do konce! 🎉", "success");
            return;
          }
        }
        vp.scrollBy({ top: stride, behavior: "smooth" });
      }
      return;
    }
    if (this.isPdfMode && this.pdfLoader) {
      const now = Date.now();
      if (this.isNavigating) return;
      if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) return;
      this.lastPageTurnTime = now;
      await this.pdfLoader.nextPage();
      return;
    }
    console.log(`[LuminaReader] nextPage() called, currentPageIndex: ${this.currentPageIndex}, totalPagesInChapter: ${this.totalPagesInChapter}`);
    const now = Date.now();
    if (this.isNavigating) {
      console.log("[LuminaReader] nextPage() blocked: navigation already in progress");
      return;
    }
    if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) {
      console.log("[LuminaReader] nextPage() blocked: cooldown active");
      return;
    }
    this.lastPageTurnTime = now;

    const stage = this.dom.pagedStage;
    if (stage) stage.classList.add("is-turning-page");
    if (this.dom.readerContent) this.dom.readerContent.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");

    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.isLineLocked = true;
    if (this.ruler) {
      this.ruler.isLineLocked = true;
      this.ruler.lockAdvancement(350);
      this.ruler.activeLineIndex = 0;
      this.ruler.activeWordIndex = 0;
    }

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked || this.ruler?.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        if (stage) stage.classList.remove("is-turning-page");
        if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (this.ruler) {
          this.ruler.forceReleaseNavigationLocks();
        }
      }
    }, 300); // 300ms maximum lock lifetime

    try {
      // 1. Pokud jsme ještě před koncem známých stran kapitoly, otočíme stranu v rámci kapitoly
      if (this.currentPageIndex < this.totalPagesInChapter - 1) {
        this.goToPage(this.currentPageIndex + 1, 1);
        console.log(`[LuminaReader] nextPage() resolved cleanly: page -> ${this.currentPageIndex + 1}`);
        return;
      }

      // 2. Zdánlivě jsme na konci kapitoly. Přepočítáme živý DOM rozměr,
      // abychom zabránili přeskočení nepřečteného textu kvůli donačteným obrázkům
      this.recalcPages();
      if (this.currentPageIndex < this.totalPagesInChapter - 1) {
        this.goToPage(this.currentPageIndex + 1, 1);
        console.log(`[LuminaReader] nextPage() advanced after recalc: page -> ${this.currentPageIndex + 1}`);
        return;
      }

      // 3. Fyzická kontrola scrollWidth proti offsetu jako pojistka
      const { stageWidth, gap, exactStep } = this.getExactColumnStep();
      const safetyThreshold = Math.max(5, Math.min(gap * 0.5, 15));
      const currentOffset = this.currentPageIndex * exactStep;
      const scrollWidth = this.dom.readerContent?.scrollWidth || 0;
      const remainingWidth = scrollWidth - (currentOffset + stageWidth);
      if (remainingWidth > safetyThreshold) {
        this.totalPagesInChapter = Math.max(
          this.currentPageIndex + 2,
          1 + Math.ceil((scrollWidth - stageWidth - safetyThreshold) / exactStep)
        );
        this.goToPage(this.currentPageIndex + 1, 1);
        console.log(`[LuminaReader] nextPage() advanced via scrollWidth check: page -> ${this.currentPageIndex + 1}`);
        return;
      }

      // 4. Kapitola je skutečně dočtena: přechod na další kapitolu
      if (this.currentChapterIndex < this.currentParser.spine.length - 1) {
        console.log(`[LuminaReader] nextPage() advancing to next chapter -> ${this.currentChapterIndex + 1}`);
        tracker.commitCurrentBlockDwell(1, this.getVisibleWordsOnCurrentPage());
        this.wordsCreditedOnCurrentPage = 0;
        await this.navigateChapter(1, 0);
      } else {
        tracker.commitCurrentBlockDwell(1, this.getVisibleWordsOnCurrentPage());
        this.wordsCreditedOnCurrentPage = 0;
        this.showToast("Dočetli jste knihu až do konce! 🎉", "success");
        console.log("[LuminaReader] nextPage() reached end of book");
      }
    } catch (err) {
      console.error('Page navigation error:', err);
    } finally {
      clearTimeout(this._navSafetyTimer);
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (stage) stage.classList.remove("is-turning-page");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
      document.body.classList.remove("is-turning-page");
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }
  }

  async prevPage() {
    if (this.isVerticalReadingMode()) {
      const vp = this.dom.pagedViewport || document.getElementById("paged-viewport");
      if (vp) {
        const stride = Math.round(vp.clientHeight * 0.85);
        if (vp.scrollTop <= 20) {
          const firstSec = this.getFirstLoadedChapterSection();
          const firstIdx = firstSec ? parseInt(firstSec.dataset.chapterIndex, 10) : this.currentChapterIndex;
          if (!this.isPdfMode && this.currentParser && firstIdx > 0) {
            await this.prependPrevChapter(firstIdx - 1);
          }
        }
        vp.scrollBy({ top: -stride, behavior: "smooth" });
      }
      return;
    }
    if (this.isPdfMode && this.pdfLoader) {
      const now = Date.now();
      if (this.isNavigating) return;
      if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) return;
      this.lastPageTurnTime = now;
      await this.pdfLoader.prevPage();
      return;
    }
    console.log(`[LuminaReader] prevPage() called, currentPageIndex: ${this.currentPageIndex}`);
    const now = Date.now();
    if (this.isNavigating) {
      console.log("[LuminaReader] prevPage() blocked: navigation already in progress");
      return;
    }
    if (now - this.lastPageTurnTime < this.PAGE_TURN_COOLDOWN) return;
    this.lastPageTurnTime = now;

    const stage = this.dom.pagedStage;
    if (stage) stage.classList.add("is-turning-page");
    if (this.dom.readerContent) this.dom.readerContent.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");

    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.isLineLocked = true;
    if (this.ruler) {
      this.ruler.isLineLocked = true;
      this.ruler.lockAdvancement(350);
    }

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked || this.ruler?.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        if (stage) stage.classList.remove("is-turning-page");
        if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (this.ruler) {
          this.ruler.forceReleaseNavigationLocks();
        }
      }
    }, 300); // 300ms maximum lock lifetime

    try {
      if (this.currentPageIndex > 0) {
        this.goToPage(this.currentPageIndex - 1, -1);
        console.log(`[LuminaReader] prevPage() resolved cleanly: page -> ${this.currentPageIndex + 1}`);
      } else if (this.currentChapterIndex > 0) {
        console.log(`[LuminaReader] prevPage() moving to prev chapter -> ${this.currentChapterIndex - 1}`);
        await this.navigateChapter(-1, "last");
      }
    } catch (err) {
      console.error('Page navigation error:', err);
    } finally {
      clearTimeout(this._navSafetyTimer);
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      if (stage) stage.classList.remove("is-turning-page");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-turning-page");
      document.body.classList.remove("is-turning-page");
      if (this.ruler) {
        this.ruler.forceReleaseNavigationLocks();
      }
    }
  }

  async navigateChapter(delta, targetPage = 0) {
    if (!this.currentParser) return;
    const newIdx = this.currentChapterIndex + delta;
    if (newIdx >= 0 && newIdx < this.currentParser.spine.length) {
      if (this.isVerticalReadingMode() && !this.isPdfMode) {
        const targetSec = this.dom.readerContent?.querySelector(`.epub-chapter-section[data-chapter-index="${newIdx}"]`);
        if (targetSec && Math.abs(delta) === 1) {
          this.currentChapterIndex = newIdx;
          const vp = this.dom.pagedViewport;
          if (vp) {
            let targetScrollTop = targetSec.offsetTop;
            if (targetPage === "last") {
              targetScrollTop = Math.max(0, targetSec.offsetTop + targetSec.offsetHeight - vp.clientHeight);
            }
            vp.scrollTo({ top: targetScrollTop, behavior: "smooth" });
          }
          this.updatePageUI();
          return;
        }
      }

      // Okamžité vizuální stínění a reset pozice při zahájení přechodu na jinou kapitolu
      const stage = this.dom.pagedStage;
      if (stage) {
        stage.classList.add("is-chapter-loading");
        stage.style.transition = "none";
        stage.style.opacity = "0";
      }
      if (this.dom.readerContent) {
        this.dom.readerContent.classList.add("is-chapter-loading");
        this.dom.readerContent.style.transition = "none";
        this.dom.readerContent.style.opacity = "0";
        if (targetPage !== "last") {
          this.dom.readerContent.style.transform = "translate3d(0px, 0, 0)";
        }
      }
      if (this.ruler && this.ruler.enabled) {
        this.ruler.hideForPageTransition();
      }
      if (targetPage !== "last") {
        this.currentPageIndex = (typeof targetPage === "number") ? targetPage : (targetPage?.pageIndex ?? 0);
      } else {
        this.currentPageIndex = 0;
      }

      this.currentChapterIndex = newIdx;
      await this.loadCurrentChapter(targetPage);
    } else if (delta > 0) {
      this.showToast("Dočetli jste knihu až do konce! 🎉", "success");
    }
  }

  formatChapterRemaining(remainingPages, isPdf = false) {
    const isMobile = typeof window !== "undefined" && (
      window.innerWidth <= 600 ||
      (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches)
    );

    let unit = "stran";
    if (remainingPages === 1) {
      unit = "stranu";
    } else if (remainingPages >= 2 && remainingPages <= 4) {
      unit = "strany";
    }

    if (isPdf) {
      return isMobile ? `zbývá: ${remainingPages} st.` : `zbývá: ${remainingPages} ${unit}`;
    }

    if (isMobile) {
      return `konec kap.: ${remainingPages} st.`;
    }
    return `konec kapitoly za: ${remainingPages} ${unit}`;
  }

  updatePageUI() {
    if (this.isPdfMode && this.pdfLoader) {
      const currBookPage = Math.max(1, Math.min(this.pdfLoader.numPages, this.pdfLoader.currentPage || 1));
      const totalBookPages = Math.max(1, this.pdfLoader.numPages || 1);
      const remainingPages = Math.max(0, totalBookPages - currBookPage);

      const pageLabel = (typeof this.pdfLoader.getSpreadPageLabel === "function")
        ? this.pdfLoader.getSpreadPageLabel(currBookPage)
        : String(currBookPage);

      if (this.dom.footerRemainingChapter) {
        this.dom.footerRemainingChapter.textContent = this.formatChapterRemaining(remainingPages, true);
      }
      if (this.dom.chapterPageCounter) {
        this.dom.chapterPageCounter.textContent = `strana ${pageLabel} z ${totalBookPages}`;
      } else if (this.dom.pageCounterText) {
        this.dom.pageCounterText.textContent = `strana ${pageLabel} z ${totalBookPages}`;
      }
      if (this.dom.footerBookPages) {
        this.dom.footerBookPages.textContent = `${pageLabel} z ${totalBookPages}`;
      }
      if (this.dom.bookPageCounter) {
        this.dom.bookPageCounter.textContent = `strana ${pageLabel} z ${totalBookPages}`;
      }
      const elCounter = document.getElementById("page-counter");
      if (elCounter) {
        elCounter.textContent = `${pageLabel} z ${totalBookPages}`;
      }

      if (this.isVerticalReadingMode()) {
        const vp = this.dom.pagedViewport;
        const scrollTop = vp ? vp.scrollTop : 0;
        const maxScroll = vp ? Math.max(1, vp.scrollHeight - vp.clientHeight) : 1;
        const hasPrev = scrollTop > 20 || currBookPage > 1;
        const hasNext = (scrollTop < maxScroll - 20) || currBookPage < totalBookPages;
        if (this.dom.btnPagePrev) this.dom.btnPagePrev.disabled = !hasPrev;
        if (this.dom.btnPageNext) this.dom.btnPageNext.disabled = !hasNext;

        const progressRatio = totalBookPages > 1 ? (currBookPage - 1) / (totalBookPages - 1) : 0;
        const overallProgress = Math.min(100, Math.round(progressRatio * 100));
        if (this.dom.progressBar) this.dom.progressBar.style.width = `${overallProgress}%`;
        if (this.dom.progressText) this.dom.progressText.textContent = `${overallProgress}%`;
      } else {
        let hasPrev, hasNext;
        if (this.pdfLoader.isSpreadActive?.()) {
          hasPrev = currBookPage > 1;
          const step = (currBookPage === 1) ? 1 : 2;
          hasNext = currBookPage + step <= totalBookPages;
        } else {
          hasPrev = currBookPage > 1;
          hasNext = currBookPage < totalBookPages;
        }
        if (this.dom.btnPagePrev) this.dom.btnPagePrev.disabled = !hasPrev;
        if (this.dom.btnPageNext) this.dom.btnPageNext.disabled = !hasNext;

        const overallProgress = totalBookPages > 0 ? Math.min(100, Math.round((currBookPage / totalBookPages) * 100)) : 0;
        if (this.dom.progressBar) this.dom.progressBar.style.width = `${overallProgress}%`;
        if (this.dom.progressText) this.dom.progressText.textContent = `${overallProgress}%`;
      }

      this.updateEtrBadge();
      this.updateScrubberUI();
      this.updatePillScrubberUI();
      return;
    }

    if (this.isVerticalReadingMode()) {
      const vp = this.dom.pagedViewport;
      if (vp) {
        const scrollTop = vp.scrollTop;
        const maxScroll = Math.max(1, vp.scrollHeight - vp.clientHeight);

        const activeSection = this.getActiveVerticalChapterSection();
        let activeIdx = this.currentChapterIndex;
        let totalPagesInCh = 1;
        let currPageInCh = 1;
        let remainingPagesInCh = 0;

        if (activeSection) {
          activeIdx = parseInt(activeSection.dataset.chapterIndex, 10);
          if (this.currentChapterIndex !== activeIdx) {
            this.currentChapterIndex = activeIdx;
            if (this.currentBook) this.currentBook.currentChapterIndex = activeIdx;
            this.highlightActiveTocItem();
            const chData = this._chapterDataCache?.get(activeIdx);
            if (chData && this.currentBook) {
              tracker.startSession(this.currentBook.id, this.currentBook.title, activeIdx, chData.wordCount, 0);
            }
          }

          const chTitle = this.getChapterTitle(activeIdx);
          if (this.dom.chapterTitleEl) this.dom.chapterTitleEl.textContent = chTitle;
          if (this.dom.pagedChapterName) this.dom.pagedChapterName.textContent = chTitle;
          if (this.dom.footerTitleText) this.dom.footerTitleText.textContent = chTitle;
          if (this.dom.bookTitleEl && this.currentBook?.title) this.dom.bookTitleEl.textContent = this.currentBook.title;

          const secHeight = Math.max(1, activeSection.offsetHeight);
          const vpHeight = Math.max(1, vp.clientHeight);
          totalPagesInCh = Math.max(1, Math.ceil(secHeight / vpHeight));
          const scrollIntoSec = Math.max(0, scrollTop - activeSection.offsetTop);
          const maxSecScroll = Math.max(1, secHeight - vpHeight);
          const chapterScrollRatio = Math.max(0, Math.min(1, scrollIntoSec / maxSecScroll));

          // Kontinuální akreditace slov při vertikálním skrolování (pokud není aktivní pravítko, které počítá přesně po řádcích/slovech)
          this._maxVScrollByChapter = this._maxVScrollByChapter || new Map();
          const prevRatio = this._maxVScrollByChapter.get(activeIdx) || 0;
          if (chapterScrollRatio > prevRatio) {
            const deltaRatio = chapterScrollRatio - prevRatio;
            this._maxVScrollByChapter.set(activeIdx, chapterScrollRatio);
            if (!(this.ruler && this.ruler.enabled)) {
              const secWords = parseInt(activeSection.dataset.wordCount, 10) || 1000;
              const wordsScrolled = Math.round(deltaRatio * secWords);
              if (wordsScrolled > 0 && wordsScrolled <= 500) {
                tracker.attributeWords(wordsScrolled);
              }
            }
          }

          currPageInCh = Math.max(1, Math.min(totalPagesInCh, Math.round(chapterScrollRatio * (totalPagesInCh - 1)) + 1));
          remainingPagesInCh = Math.max(0, totalPagesInCh - currPageInCh);

          this.currentPageIndex = currPageInCh - 1;
          this.totalPagesInChapter = totalPagesInCh;

          const vPageIdx = currPageInCh - 1;
          if (this._lastVPageIdx !== vPageIdx || this._lastVChapterIdx !== activeIdx) {
            this._lastVPageIdx = vPageIdx;
            this._lastVChapterIdx = activeIdx;
            if (this.currentBook) {
              const visibleWords = this.getVisibleWordsOnCurrentPage();
              tracker.onPageChange({
                bookId: this.currentBook.id,
                bookTitle: this.currentBook.title,
                chapterIndex: activeIdx,
                pageIndex: vPageIdx,
                visibleWords: visibleWords,
                isVerticalScroll: true
              });
            }
          }
        }

        if (this.dom.footerRemainingChapter) {
          this.dom.footerRemainingChapter.textContent = this.formatChapterRemaining(remainingPagesInCh);
        }
        if (this.dom.chapterPageCounter) {
          this.dom.chapterPageCounter.textContent = `strana ${currPageInCh} z ${totalPagesInCh}`;
        } else if (this.dom.pageCounterText) {
          this.dom.pageCounterText.textContent = `strana ${currPageInCh} z ${totalPagesInCh}`;
        }

        const metrics = this.getBookMetrics();
        const currBookPage = metrics.currBookPage;
        const totalBookPages = metrics.totalBookPages;

        if (this.dom.footerBookPages) {
          this.dom.footerBookPages.textContent = `${currBookPage} z ${totalBookPages}`;
        }
        if (this.dom.bookPageCounter) {
          this.dom.bookPageCounter.textContent = `strana ${currBookPage} z ${totalBookPages}`;
        }

        const hasPrev = scrollTop > 20 || (activeIdx > 0);
        const hasNext = (scrollTop < maxScroll - 20) || (this.currentParser && activeIdx < this.currentParser.spine.length - 1);
        if (this.dom.btnPagePrev) this.dom.btnPagePrev.disabled = !hasPrev;
        if (this.dom.btnPageNext) this.dom.btnPageNext.disabled = !hasNext;

        const overallProgress = totalBookPages > 0 ? Math.min(100, Math.round((currBookPage / totalBookPages) * 100)) : 0;
        if (this.dom.progressBar) this.dom.progressBar.style.width = `${overallProgress}%`;
        if (this.dom.progressText) this.dom.progressText.textContent = `${overallProgress}%`;

        this.updateEtrBadge();
        this.updateScrubberUI();
        this.updatePillScrubberUI();
        return;
      }
    }

    const currChapterPage = this.currentPageIndex + 1;
    const totalChapterPages = Math.max(1, this.totalPagesInChapter);
    const remainingChapterPages = Math.max(0, this.totalPagesInChapter - currChapterPage);

    // 1. Informace o zbývajících stránkách v kapitole ("konec kapitoly za: X stran" / "konec kap.: X st.")
    if (this.dom.footerRemainingChapter) {
      this.dom.footerRemainingChapter.textContent = this.formatChapterRemaining(remainingChapterPages);
    }

    // Zpětná kompatibilita pro původní čítače
    if (this.dom.chapterPageCounter) {
      this.dom.chapterPageCounter.textContent = `strana ${currChapterPage} z ${totalChapterPages}`;
    } else if (this.dom.pageCounterText) {
      this.dom.pageCounterText.textContent = `strana ${currChapterPage} z ${totalChapterPages}`;
    }

    // 2. Počítadlo stránek pro celou knihu ("A z B" / "strana A z B")
    const metrics = this.getBookMetrics();
    const currBookPage = metrics.currBookPage;
    const totalBookPages = metrics.totalBookPages;

    if (this.dom.footerBookPages) {
      this.dom.footerBookPages.textContent = `${currBookPage} z ${totalBookPages}`;
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
    this.updatePillScrubberUI();
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
        tracker.cancelCurrentPageDwell();
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
          this.currentChapterIndex = spineIdx;
          if (this.isVerticalReadingMode() && !this.isPdfMode) {
            const existingSec = this.dom.readerContent?.querySelector(`.epub-chapter-section[data-chapter-index="${spineIdx}"]`);
            if (existingSec) {
              existingSec.scrollIntoView({ behavior: "smooth", block: "start" });
              this.closeDrawer("toc");
              return;
            }
          }
          await this.loadCurrentChapter(0);
          this.closeDrawer("toc");
        }
      });

      this.dom.tocList.appendChild(li);
    });
  }

  highlightActiveTocItem() {
    if (!this.dom.tocList) return;
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
    this.saveProgress(true);
    localStorage.setItem("lumina_active_view", "library");
    tracker.stopSession();
    this.closeDrawer("toc");
    this.closeDrawer("settings");
    this.closeStatsModal();
    this.closeFloatingDock();
    document.body.classList.remove("immersive-reading");
    document.body.classList.remove("in-reader-view");
    document.body.classList.remove("reader-chrome-hidden");
    document.body.classList.remove("is-pdf-mode");
    if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-pdf-mode");
    this.dom.viewReader.classList.add("is-hidden");
    this.dom.viewLibrary.classList.remove("is-hidden");
    this.ruler.setEnabled(false);
    if (this.ruler) this.ruler.setPdfMode(false);
    this.setImageOnlyPdf(false);
    this.setPdfRulerUIVisibility(false);
    if (this.pdfLoader) {
      this.pdfLoader.destroy();
      this.pdfLoader = null;
    }
    this.isPdfMode = false;
    this.renderLibrary();
  }

  showReaderView() {
    this.closeDrawer("toc");
    this.closeDrawer("settings");
    this.closeFloatingDock();
    this.dom.viewLibrary.classList.add("is-hidden");
    this.dom.viewReader.classList.remove("is-hidden");
    document.body.classList.add("in-reader-view");
    if (this.isPdfMode) {
      document.body.classList.add("is-pdf-mode");
      if (this.dom.readerContent) this.dom.readerContent.classList.add("is-pdf-mode");
    } else {
      document.body.classList.remove("is-pdf-mode");
      if (this.dom.readerContent) this.dom.readerContent.classList.remove("is-pdf-mode");
    }
    localStorage.setItem("lumina_active_view", "reader");
    if (this.currentBook) {
      localStorage.setItem("lumina_last_book_id", this.currentBook.id);
    }
    const showProgressBar = localStorage.getItem('showProgressBar') !== null
      ? localStorage.getItem('showProgressBar') === 'true'
      : (this.settings.showProgressBar !== undefined ? this.settings.showProgressBar : (this.settings.showFooterBar !== false));
    this.settings.showFooterBar = showProgressBar;
    this.settings.showProgressBar = showProgressBar;
    document.body.classList.toggle("show-footer-bar", showProgressBar);
    document.body.classList.toggle("hide-footer-bar", !showProgressBar);
    document.body.classList.remove("reader-chrome-hidden");
    if (this.ruler) {
      const pdfConfig = (this.isPdfMode && this.currentBook)
        ? (this.currentBook.pdfRulerConfig || {
            height: 32,
            autoHeight: this.settings.ruler.pdfAutoHeight !== false
          })
        : null;
      if (pdfConfig && pdfConfig.autoHeight === undefined) {
        pdfConfig.autoHeight = this.settings.ruler.pdfAutoHeight !== false;
      }
      this.ruler.setPdfMode(this.isPdfMode, pdfConfig);
    }
    this.setPdfRulerUIVisibility(this.isPdfMode);
    if (this.isPdfMode && this.currentBook?.pdfRulerConfig) {
      this.syncPdfRulerUI(this.currentBook.pdfRulerConfig);
    }
    const showRuler = this.settings.showRulerButton !== false;
    const rulerContainer = this.dom.rulerToggleBtn || this.dom.rulerSplitPill;
    if (rulerContainer) {
      rulerContainer.style.display = showRuler ? "flex" : "none";
      rulerContainer.classList.toggle("is-hidden", !showRuler);
    }
    if (showRuler && this.settings.ruler.enabled) {
      this.ruler.setEnabled(true);
    } else {
      this.ruler.setEnabled(false);
    }
    this.updateTouchZonesUI();
    this.renderScrubberTicks();
    this.updateScrubberUI();
  }

  closeFloatingDock() {
    if (this.dom.readerFloatingDock && !this.dom.readerFloatingDock.classList.contains("is-hidden")) {
      this.dom.readerFloatingDock.classList.add("is-hidden");
      if (this.dom.btnReaderMenuFab) {
        this.dom.btnReaderMenuFab.classList.remove("active");
        this.dom.btnReaderMenuFab.setAttribute("aria-expanded", "false");
      }
      if (this.dom.pillScrubberTooltip) {
        this.dom.pillScrubberTooltip.classList.add("is-hidden");
      }
    }
  }

  toggleDrawer(name) {
    this.closeFloatingDock();
    if (name === "toc") {
      const willOpen = !this.dom.tocDrawer?.classList.contains("open");
      this.dom.tocDrawer?.classList.toggle("open", willOpen);
      this.dom.settingsDrawer?.classList.remove("open");
      this.dom.searchDrawer?.classList.remove("open");
      document.body.classList.remove("settings-sheet-open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.remove("backdrop-transparent");
        this.dom.drawerBackdrop.classList.toggle("active", willOpen);
      }
    } else if (name === "settings") {
      const willOpen = !this.dom.settingsDrawer?.classList.contains("open");
      this.dom.settingsDrawer?.classList.toggle("open", willOpen);
      this.dom.tocDrawer?.classList.remove("open");
      this.dom.searchDrawer?.classList.remove("open");
      document.body.classList.toggle("settings-sheet-open", willOpen);
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.toggle("backdrop-transparent", willOpen);
        this.dom.drawerBackdrop.classList.toggle("active", willOpen);
      }
      if (willOpen) {
        this.updateSettingsTabsVisibility(this.isPdfMode);
        this.setPdfRulerUIVisibility(this.isPdfMode);
        this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
        if (this.isPdfMode) {
          const cfg = this.currentBook?.pdfRulerConfig || {
            height: this.ruler?.getPdfRulerHeight?.() || 32,
            autoHeight: this.ruler?.pdfAutoHeight !== false
          };
          this.syncPdfRulerUI(cfg);
        }
      }
    } else if (name === "search") {
      const willOpen = !this.dom.searchDrawer?.classList.contains("open");
      this.dom.searchDrawer?.classList.toggle("open", willOpen);
      this.dom.tocDrawer?.classList.remove("open");
      this.dom.settingsDrawer?.classList.remove("open");
      document.body.classList.remove("settings-sheet-open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.remove("backdrop-transparent");
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
    this.closeFloatingDock();
    if (name === "toc" && this.dom.tocDrawer) this.dom.tocDrawer.classList.remove("open");
    if (name === "settings" && this.dom.settingsDrawer) this.dom.settingsDrawer.classList.remove("open");
    if (name === "search" && this.dom.searchDrawer) this.dom.searchDrawer.classList.remove("open");
    const isTocOpen = this.dom.tocDrawer && this.dom.tocDrawer.classList.contains("open");
    const isSettingsOpen = this.dom.settingsDrawer && this.dom.settingsDrawer.classList.contains("open");
    const isSearchOpen = this.dom.searchDrawer && this.dom.searchDrawer.classList.contains("open");
    const isAnyOpen = !!(isTocOpen || isSettingsOpen || isSearchOpen);

    document.body.classList.toggle("settings-sheet-open", !!isSettingsOpen);
    if (this.dom.drawerBackdrop) {
      this.dom.drawerBackdrop.classList.toggle("active", isAnyOpen);
      this.dom.drawerBackdrop.classList.toggle("backdrop-transparent", !!isSettingsOpen);
    }
  }

  openSettings(targetTab = null) {
    this.closeFloatingDock();
    if (this.dom.tocDrawer) this.dom.tocDrawer.classList.remove("open");
    if (this.dom.searchDrawer) this.dom.searchDrawer.classList.remove("open");
    if (this.dom.settingsDrawer) {
      this.dom.settingsDrawer.classList.add("open");
      document.body.classList.add("settings-sheet-open");
      if (this.dom.drawerBackdrop) {
        this.dom.drawerBackdrop.classList.add("backdrop-transparent", "active");
      }
      this.updateSettingsTabsVisibility(this.isPdfMode);
      if (targetTab) {
        this.switchToSettingsTab(targetTab);
      }
      this.setPdfRulerUIVisibility(this.isPdfMode);
      this.updateRulerSettingsVisibility(this.settings?.ruler?.mode, this.isPdfMode);
      if (this.isPdfMode) {
        const cfg = this.currentBook?.pdfRulerConfig || {
          height: this.ruler?.getPdfRulerHeight?.() || 32,
          autoHeight: this.ruler?.pdfAutoHeight !== false
        };
        this.syncPdfRulerUI(cfg);
      }
    }
  }

  switchToSettingsTab(targetPaneId) {
    if (!this.dom.settingsDrawer) return;

    // V PDF režimu záložka Písmo není dostupná - přesměrovat na Vzhled
    if (this.isPdfMode && targetPaneId === "tab-pane-font") {
      targetPaneId = "tab-pane-appearance";
    }

    const settingsTabs = this.dom.settingsDrawer.querySelectorAll(".settings-tab-btn");
    const settingsPanes = this.dom.settingsDrawer.querySelectorAll(".settings-tab-pane");

    let targetBtn = this.dom.settingsDrawer.querySelector(`.settings-tab-btn[data-tab="${targetPaneId}"]`);
    let targetPane = document.getElementById(targetPaneId);

    // Fallback pokud cílový tab neexistuje nebo je skrytý
    if (!targetBtn || targetBtn.style.display === "none") {
      targetBtn = this.isPdfMode
        ? (this.dom.tabBtnAppearance || this.dom.settingsDrawer.querySelector('.settings-tab-btn[data-tab="tab-pane-appearance"]'))
        : (this.dom.tabBtnFont || settingsTabs[0]);
      if (targetBtn) {
        targetPaneId = targetBtn.dataset.tab;
        targetPane = document.getElementById(targetPaneId);
      }
    }

    settingsTabs.forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    settingsPanes.forEach(pane => {
      pane.classList.remove("active");
    });

    if (targetBtn) {
      targetBtn.classList.add("active");
      targetBtn.setAttribute("aria-selected", "true");
    }
    if (targetPane) {
      targetPane.classList.add("active");
    }
  }

  updateSettingsTabsVisibility(isPdf = this.isPdfMode) {
    const tabBtnFont = this.dom?.tabBtnFont || document.getElementById("tab-btn-font");
    const tabPaneFont = this.dom?.tabPaneFont || document.getElementById("tab-pane-font");

    if (isPdf) {
      if (tabBtnFont) {
        tabBtnFont.style.display = "none";
      }
      // Pokud je záložka Písmo aktivní, automaticky přepneme na Vzhled
      const isFontActive = (tabBtnFont && tabBtnFont.classList.contains("active")) ||
                           (tabPaneFont && tabPaneFont.classList.contains("active"));
      if (isFontActive) {
        if (tabPaneFont) {
          tabPaneFont.classList.remove("active");
        }
        if (tabBtnFont) {
          tabBtnFont.classList.remove("active");
          tabBtnFont.setAttribute("aria-selected", "false");
        }
        this.switchToSettingsTab("tab-pane-appearance");
      }
    } else {
      if (tabBtnFont) {
        tabBtnFont.style.display = "";
      }
      // Kontrola, zda je nějaký tab aktivní, případně nastavit výchozí Písmo
      const activeBtn = this.dom?.settingsDrawer?.querySelector(".settings-tab-btn.active:not([style*='display: none'])");
      if (!activeBtn) {
        this.switchToSettingsTab("tab-pane-font");
      }
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
    if (this.isVerticalReadingMode() && !this.isPdfMode) {
      const existingSec = this.dom.readerContent?.querySelector(`.epub-chapter-section[data-chapter-index="${chapterIndex}"]`);
      if (existingSec) {
        if (matchQuery) {
          this.locateAndScrollToSearchQuery(matchQuery);
        } else {
          existingSec.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
    }
    if (this.currentChapterIndex !== chapterIndex) {
      this.currentChapterIndex = chapterIndex;
      await this.loadCurrentChapter(0);
    }
    if (matchQuery) {
      this.locateAndScrollToSearchQuery(matchQuery);
    }
  }

  locateAndScrollToSearchQuery(query) {
    if (!query || !this.dom.readerContent || !this.dom.pagedStage) return;
    const { stageWidth, gap, exactStep } = this.getExactColumnStep();
    const stageRect = this.dom.pagedStage.getBoundingClientRect();
    const lowerQ = query.toLowerCase();

    // Vyhledání textového uzlu v načtené kapitole
    const walker = document.createTreeWalker(this.dom.readerContent, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let foundParent = null;

    while (node = walker.nextNode()) {
      if (node.textContent.toLowerCase().includes(lowerQ)) {
        foundParent = node.parentElement?.closest(BIONIC_BLOCK_SELECTOR) || node.parentElement;
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
      tracker.cancelCurrentPageDwell();
      if (this.isVerticalReadingMode()) {
        foundParent.scrollIntoView({ behavior: "smooth", block: "center" });
        foundParent.classList.add("search-highlight-flash");
        setTimeout(() => foundParent.classList.remove("search-highlight-flash"), 2200);
        return;
      }

      const rect = foundParent.getBoundingClientRect();
      const currentOffset = this.currentPageIndex * exactStep;
      const relativeX = (rect.left - stageRect.left) + currentOffset;
      const targetPage = Math.max(0, Math.min(this.totalPagesInChapter - 1, Math.floor(relativeX / exactStep)));

      this.goToPage(targetPage, null, true, { isNavigationJump: true });
      foundParent.classList.add("search-highlight-flash");
      setTimeout(() => foundParent.classList.remove("search-highlight-flash"), 2200);
    }
  }

  async refreshStatsUI() {
    try {
      const stats = await ReadingTracker.computeGlobalStats();

      if (this.dom.statTotalTime) this.dom.statTotalTime.textContent = stats.totalTimeFormatted;
      if (this.dom.statAvgWpm) {
        const isStatsEmpty = !stats || !stats.totalSeconds || !stats.totalWords || !stats.averageWpm;
        this.dom.statAvgWpm.textContent = isStatsEmpty ? "0 WPM" : `${Math.round(stats.averageWpm)} WPM`;
      }
      if (this.dom.statTotalWords) this.dom.statTotalWords.textContent = stats.totalWords.toLocaleString("cs-CZ");
      if (this.dom.statStreak) this.dom.statStreak.textContent = `${stats.streak} ${stats.streak === 1 ? "den" : (stats.streak >= 2 && stats.streak <= 4 ? "dny" : "dní")}`;

      // Vykreslení globálních grafů
      if (this.dom.dailyChartContainer) StatsCharts.renderDailyActivityChart(this.dom.dailyChartContainer, stats.last7Days);
      if (this.dom.wpmChartContainer) StatsCharts.renderWpmProgressChart(this.dom.wpmChartContainer, stats.wpmHistory, stats.averageWpm);

      // Načtení detailních čtecích relací a vykreslení intra-session časové osy
      await this.initSessionAnalytics();
    } catch (err) {
      console.warn("[LuminaApp] Varování při obnově statistik UI:", err);
    }
  }

  async openStatsModal() {
    this.closeFloatingDock();
    if (this.dom.statsModal) this.dom.statsModal.classList.add("open");

    // Pojistka integrity dat: detekce a automatická oprava poškozených nebo nafouknutých hodnot
    try {
      await storage.sanitizeCorruptedStats();
    } catch (e) {
      console.warn("Chyba při auto-normalizaci statistik:", e);
    }

    await this.refreshStatsUI();
  }

  async initSessionAnalytics() {
    const rawSessions = await storage.getAllReadingSessions();
    // Filtrujeme striktně pouze relace s délkou alespoň 5 minut (>= 300 sekund)
    const savedSessions = (rawSessions || []).filter(s => {
      const dur = Math.max(0, Math.round(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0));
      return dur >= 300;
    });

    const liveSnapshot = tracker.getCurrentSessionSnapshot();

    const allSessions = [];
    if (liveSnapshot && (liveSnapshot.durationSeconds ?? liveSnapshot.activeSeconds ?? liveSnapshot.duration ?? 0) >= 15) {
      allSessions.push(liveSnapshot);
    }

    for (const s of savedSessions) {
      const sid = s.sessionId || s.id;
      if (!allSessions.some(existing => (existing.sessionId === sid || existing.id === sid))) {
        allSessions.push(s);
      }
    }

    this._availableSessions = allSessions;

    if (this.dom.sessionCountBadge) {
      this.dom.sessionCountBadge.textContent = allSessions.length;
    }

    this.renderSessionPickerOptions();
    this.renderSessionHistoryList();

    if (allSessions.length > 0) {
      const targetId = (this._selectedSessionId && allSessions.some(s => (s.sessionId === this._selectedSessionId || s.id === this._selectedSessionId)))
        ? this._selectedSessionId
        : (allSessions[0].sessionId || allSessions[0].id);
      this.selectSession(targetId);
    } else {
      this.renderEmptySessionTimeline();
    }
  }

  renderSessionPickerOptions() {
    if (!this.dom.sessionPickerSelect) return;
    this.dom.sessionPickerSelect.innerHTML = "";

    if (!this._availableSessions || this._availableSessions.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Žádné zaznamenané relace";
      this.dom.sessionPickerSelect.appendChild(opt);
      return;
    }

    this._availableSessions.forEach((s) => {
      const opt = document.createElement("option");
      const sid = s.sessionId || s.id;
      opt.value = sid;

      const dur = Math.max(0, Math.round(Number(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0)));
      const words = Math.max(0, Math.round(Number(s.wordsRead ?? s.words_read ?? 0)));
      const calcAvg = dur >= 10 ? Math.round((words / dur) * 60) : 0;
      const avg = Math.round(Number(s.avgWpm ?? s.avg_wpm ?? s.wpm ?? calcAvg));

      const durationStr = ReadingTracker.formatDurationDetailed(dur);
      const wordsStr = words.toLocaleString("cs-CZ");
      const speedStr = `${avg} WPM`;

      if (s.isLive) {
        opt.textContent = `🔴 [Aktivní relace] ${durationStr} • ${wordsStr} slov • ${speedStr}`;
      } else {
        const d = new Date(s.startTime || s.start_time || s.timestamp || Date.now());
        const dateStr = d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
        const timeStr = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
        const rawTitle = s.bookTitle || s.book_title || "";
        const title = rawTitle ? (rawTitle.length > 18 ? rawTitle.slice(0, 18) + "…" : rawTitle) : "";
        opt.textContent = `${dateStr} ${timeStr} • ${durationStr} • ${wordsStr} slov • ${speedStr}${title ? ` (${title})` : ""}`;
      }

      this.dom.sessionPickerSelect.appendChild(opt);
    });
  }

  renderSessionHistoryList() {
    if (!this.dom.sessionHistoryList) return;
    this.dom.sessionHistoryList.innerHTML = "";

    if (!this._availableSessions || this._availableSessions.length === 0) {
      this.dom.sessionHistoryList.innerHTML = `<div class="chart-empty-state"><p>Historie relací je prázdná.</p></div>`;
      return;
    }

    this._availableSessions.forEach((s) => {
      const item = document.createElement("div");
      item.className = "session-item";
      const sid = s.sessionId || s.id;
      item.dataset.sessionId = sid;
      if (sid === this._selectedSessionId) {
        item.classList.add("active");
      }

      const dur = Math.max(0, Math.round(Number(s.durationSeconds ?? s.activeSeconds ?? s.duration ?? 0)));
      const words = Math.max(0, Math.round(Number(s.wordsRead ?? s.words_read ?? 0)));
      const calcAvg = dur >= 10 ? Math.round((words / dur) * 60) : 0;
      const avg = Math.round(Number(s.avgWpm ?? s.avg_wpm ?? s.wpm ?? calcAvg));

      const durationStr = ReadingTracker.formatDurationDetailed(dur);
      const wordsStr = `${words.toLocaleString("cs-CZ")} slov`;
      const speedStr = `${avg} WPM`;

      let dateFormatted = "";
      if (s.isLive) {
        dateFormatted = "Právě probíhající relace";
      } else {
        const d = new Date(s.startTime || s.start_time || s.timestamp || Date.now());
        dateFormatted = `${d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" })} v ${d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`;
      }

      const bookTitle = s.bookTitle || s.book_title || "Elektronická kniha";

      item.innerHTML = `
        <div class="session-item-left">
          <div class="session-item-date">${dateFormatted}</div>
          <div class="session-item-meta">${bookTitle}</div>
        </div>
        <div class="session-item-right">
          <span class="session-badge-tag ${s.isLive ? "tag-live" : ""}">${durationStr}</span>
          <span class="session-badge-tag">${wordsStr}</span>
          <span class="session-badge-tag" style="color: var(--color-primary);">${speedStr}</span>
        </div>
      `;

      item.addEventListener("click", () => {
        this.selectSession(sid);
      });

      this.dom.sessionHistoryList.appendChild(item);
    });
  }

  selectSession(sessionId) {
    if (!this._availableSessions) return;
    const session = this._availableSessions.find(s => s.sessionId === sessionId || s.id === sessionId);
    if (!session) return;

    const sid = session.sessionId || session.id;
    this._selectedSessionId = sid;

    if (this.dom.sessionPickerSelect && this.dom.sessionPickerSelect.value !== sid) {
      this.dom.sessionPickerSelect.value = sid;
    }

    if (this.dom.sessionHistoryList) {
      const items = this.dom.sessionHistoryList.querySelectorAll(".session-item");
      items.forEach(el => {
        el.classList.toggle("active", el.dataset.sessionId === sid);
      });
    }

    const durationSec = Math.max(0, Number(session.durationSeconds ?? session.activeSeconds ?? session.duration ?? 0));
    const wordsRead = Math.max(0, Number(session.wordsRead ?? session.words_read ?? 0));
    const calcAvg = durationSec >= 10 ? Math.round((wordsRead / durationSec) * 60) : 0;
    const avgWpm = (session.avgWpm !== undefined && session.avgWpm !== null)
      ? Math.round(session.avgWpm)
      : ((session.avg_wpm !== undefined && session.avg_wpm !== null) ? Math.round(session.avg_wpm) : calcAvg);
    const samples = Array.isArray(session.intra_session_samples || session.intraSessionSamples || session.timelineSamples) 
      ? (session.intra_session_samples || session.intraSessionSamples || session.timelineSamples) 
      : [];
    const speeds = samples.map(s => Number(s.wpm ?? s.instantaneousWpm) || 0).filter(w => w > 0);
    const rawPeak = session.peakWpm ?? session.peak_wpm;
    const peakWpm = rawPeak 
      ? Math.max(Math.round(rawPeak), avgWpm) 
      : (speeds.length > 0 ? Math.max(...speeds, avgWpm) : avgWpm);

    if (this.dom.sessionBadgeDuration) {
      this.dom.sessionBadgeDuration.textContent = ReadingTracker.formatDurationDetailed(durationSec);
    }
    if (this.dom.sessionBadgePeakWpm) {
      this.dom.sessionBadgePeakWpm.textContent = `${peakWpm} WPM`;
    }
    if (this.dom.sessionBadgeAvgWpm) {
      this.dom.sessionBadgeAvgWpm.textContent = `${avgWpm} WPM`;
    }
    if (this.dom.sessionBadgeWords) {
      this.dom.sessionBadgeWords.textContent = wordsRead.toLocaleString("cs-CZ");
    }

    if (this.dom.sessionTimelineChartContainer) {
      StatsCharts.renderSessionTimelineChart(this.dom.sessionTimelineChartContainer, session);
    }
  }

  renderEmptySessionTimeline() {
    if (this.dom.sessionBadgeDuration) this.dom.sessionBadgeDuration.textContent = "0 s";
    if (this.dom.sessionBadgePeakWpm) this.dom.sessionBadgePeakWpm.textContent = "0 WPM";
    if (this.dom.sessionBadgeAvgWpm) this.dom.sessionBadgeAvgWpm.textContent = "0 WPM";
    if (this.dom.sessionBadgeWords) this.dom.sessionBadgeWords.textContent = "0";

    if (this.dom.sessionTimelineChartContainer) {
      this.dom.sessionTimelineChartContainer.innerHTML = `
        <div class="chart-empty-state">
          <p>Zatím nebyly zaznamenány žádné čtecí relace.</p>
          <span>Přečtěte alespoň pár stran knihy a graf se automaticky naplní.</span>
        </div>
      `;
    }
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

  recomputeGlobalPagination() {
    if (this.isPdfMode) {
      const num = this.pdfLoader?.numPages || this.currentBook?.numPages || 1;
      this.bookPagination = {
        wordsPerPage: 260,
        chapterPageCounts: [num],
        chapterStarts: [1],
        totalBookPages: num
      };
      return;
    }

    if (!this.currentParser) {
      this.bookPagination = {
        wordsPerPage: 260,
        chapterPageCounts: [1],
        chapterStarts: [1],
        totalBookPages: 1
      };
      return;
    }

    const totalChapters = this.currentParser?.spine?.length || 1;
    const baseWordsPerPage = 260;
    const fontSize = this.settings.fontSize || 19;
    const lineHeight = this.settings.lineHeight || 1.6;
    const isTwoCol = document.documentElement.classList.contains("columns-2") ||
                     document.body.classList.contains("columns-2") ||
                     (typeof this.resolveEffectiveColumnCount === "function" && this.resolveEffectiveColumnCount() === 2);
    const colMultiplier = isTwoCol ? 2 : 1;

    // Škálování hustoty slov podle velikosti písma (plošné), výšky řádku a počtu sloupců
    const fontFactor = Math.pow(19 / fontSize, 1.7);
    const lineFactor = 1.6 / lineHeight;
    let wordsPerPage = Math.round(baseWordsPerPage * fontFactor * lineFactor * colMultiplier);
    // Bezpečnostní mantinely, aby nedošlo k dělení 0 nebo extrémním hodnotám
    wordsPerPage = Math.max(80, Math.min(1200, wordsPerPage));

    const hasWordCounts = !!(this.bookWordCounts && Array.isArray(this.bookWordCounts.chapterWords) && this.bookWordCounts.chapterWords.length > 0);
    const chapterPageCounts = [];
    const chapterStarts = [];
    let runningTotal = 0;

    for (let i = 0; i < totalChapters; i++) {
      let chPages = 1;
      if (hasWordCounts) {
        const words = this.bookWordCounts.chapterWords[i] != null ? this.bookWordCounts.chapterWords[i] : 0;
        // Titulní strany, obálky, celostránkové ilustrace či kapitoly s minimem slov mají vždy min. 1 stranu
        if (words < 50) {
          chPages = 1;
        } else {
          chPages = Math.max(1, Math.round(words / wordsPerPage));
        }
      } else {
        chPages = (i === this.currentChapterIndex && this.totalPagesInChapter) ? this.totalPagesInChapter : 1;
      }

      chapterPageCounts.push(chPages);
      chapterStarts.push(runningTotal + 1);
      runningTotal += chPages;
    }

    const totalBookPages = Math.max(1, runningTotal);

    this.bookPagination = {
      wordsPerPage,
      chapterPageCounts,
      chapterStarts,
      totalBookPages
    };
  }

  getBookMetrics() {
    if (this.isPdfMode && this.pdfLoader) {
      const numPages = Math.max(1, this.pdfLoader.numPages || 1);
      const currPage = Math.max(1, Math.min(numPages, this.pdfLoader.currentPage || 1));
      return {
        currBookPage: currPage,
        totalBookPages: numPages,
        chapterStarts: [1],
        chapterPageCounts: [numPages],
        totalChapters: 1
      };
    }

    if (!this.bookPagination) {
      this.recomputeGlobalPagination();
    }
    const p = this.bookPagination;
    const totalChapters = this.currentParser?.spine?.length || 1;
    const chAllocated = p.chapterPageCounts[this.currentChapterIndex] || 1;
    const startPage = p.chapterStarts[this.currentChapterIndex] || 1;
    const totalPagesInCh = Math.max(1, this.totalPagesInChapter || 1);

    let currBookPage = startPage;
    if (totalPagesInCh > 1 && chAllocated > 1) {
      const fraction = this.currentPageIndex / (totalPagesInCh - 1);
      currBookPage = startPage + Math.round(fraction * (chAllocated - 1));
    } else {
      currBookPage = startPage + Math.min(this.currentPageIndex, chAllocated - 1);
    }
    currBookPage = Math.max(1, Math.min(p.totalBookPages, currBookPage));

    return {
      currBookPage,
      totalBookPages: p.totalBookPages,
      chapterStarts: p.chapterStarts,
      chapterPageCounts: p.chapterPageCounts,
      totalChapters
    };
  }

  resolveBookPage(targetBookPage) {
    if (this.isPdfMode && this.pdfLoader) {
      const numPages = Math.max(1, this.pdfLoader.numPages || 1);
      const clamped = Math.max(1, Math.min(numPages, Math.round(targetBookPage)));
      return {
        targetBookPage: clamped,
        chapterIndex: 0,
        pageInChapter: clamped - 1,
        pageRatio: numPages > 1 ? (clamped - 1) / (numPages - 1) : 0,
        chapterTitle: this.currentBook?.title || `Strana ${clamped}`,
        totalBookPages: numPages
      };
    }

    const metrics = this.getBookMetrics();
    const clamped = Math.max(1, Math.min(metrics.totalBookPages, Math.round(targetBookPage)));
    let chapterIndex = 0;
    let pageInChapter = 0;
    let pageRatio = 0;

    for (let i = metrics.chapterStarts.length - 1; i >= 0; i--) {
      if (clamped >= metrics.chapterStarts[i]) {
        chapterIndex = i;
        const startPage = metrics.chapterStarts[i];
        const chAllocated = metrics.chapterPageCounts[i] || 1;
        const offsetInAlloc = clamped - startPage;
        pageRatio = chAllocated > 1 ? (offsetInAlloc / (chAllocated - 1)) : 0;

        if (chapterIndex === this.currentChapterIndex && this.totalPagesInChapter > 1 && chAllocated > 1) {
          pageInChapter = Math.round(pageRatio * (this.totalPagesInChapter - 1));
        } else {
          pageInChapter = offsetInAlloc;
        }
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
      pageRatio,
      chapterTitle,
      totalBookPages: metrics.totalBookPages
    };
  }

  async goToBookPage(targetBookPage) {
    tracker.cancelCurrentPageDwell();
    if (this.isPdfMode && this.pdfLoader) {
      const resolved = this.resolveBookPage(targetBookPage);
      await this.pdfLoader.goToPage(resolved.targetBookPage);
      return;
    }

    const resolved = this.resolveBookPage(targetBookPage);
    if (this.isVerticalReadingMode()) {
      const vp = this.dom.pagedViewport;
      const targetSec = this.dom.readerContent?.querySelector(`.epub-chapter-section[data-chapter-index="${resolved.chapterIndex}"]`);
      if (targetSec && vp) {
        this.currentChapterIndex = resolved.chapterIndex;
        const maxSecScroll = Math.max(0, targetSec.offsetHeight - vp.clientHeight);
        vp.scrollTop = targetSec.offsetTop + Math.round(resolved.pageRatio * maxSecScroll);
        this.updatePageUI();
        return;
      }
      this.currentChapterIndex = resolved.chapterIndex;
      await this.loadCurrentChapter({ ratio: resolved.pageRatio, fallbackPage: resolved.pageInChapter });
      return;
    }

    if (resolved.chapterIndex === this.currentChapterIndex) {
      this.goToPage(resolved.pageInChapter, null, false, { isNavigationJump: true });
    } else {
      this.currentChapterIndex = resolved.chapterIndex;
      await this.loadCurrentChapter({ ratio: resolved.pageRatio, fallbackPage: resolved.pageInChapter });
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
      const currentChapterTitle = this.isPdfMode
        ? (this.currentBook?.title || "PDF Dokument")
        : ((this.currentParser?.spine && this.currentParser.spine[this.currentChapterIndex]?.title)
          || this.currentBook?.title
          || `Kapitola ${this.currentChapterIndex + 1}`);
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
              tracker.cancelCurrentPageDwell();
              this.goToPage(resolved.pageInChapter, null, false, { isNavigationJump: true });
            }
          }, 60);
        }
      }
    };

    const onPointerDown = (e) => {
      e.stopPropagation();
      e.preventDefault();

      tracker.cancelCurrentPageDwell();
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

  updatePillScrubberUI(customRatio = null, customTooltip = null, customPrefix = null) {
    const metrics = this.getBookMetrics();
    const totalPages = Math.max(1, metrics.totalBookPages);

    let ratio = 0;
    if (customRatio !== null) {
      const norm = customRatio > 1 ? customRatio / 100 : customRatio;
      ratio = Math.max(0, Math.min(1, norm));
    } else if (totalPages > 1) {
      ratio = Math.max(0, Math.min(1, (metrics.currBookPage - 1) / (totalPages - 1)));
    }

    const percent = Math.round(ratio * 100);

    if (this.dom.pillScrubberFill) {
      this.dom.pillScrubberFill.style.width = percent + "%";
    }

    if (this.dom.pillScrubberPercent) {
      this.dom.pillScrubberPercent.textContent = `${percent}\u00a0%`;
    }

    if (this.dom.pillScrubberPrefix) {
      if (customPrefix !== null) {
        this.dom.pillScrubberPrefix.textContent = customPrefix;
      } else if (!this.dom.pillScrubberPrefix.textContent.trim()) {
        this.dom.pillScrubberPrefix.textContent = "Obsah";
      }
    }

    // Zpětná kompatibilita pro případ nepřítomnosti vnitřních elementů
    if (this.dom.pillScrubberLabel && !this.dom.pillScrubberPercent) {
      this.dom.pillScrubberLabel.textContent = `${customPrefix || "Obsah"} \u2022 ${percent}\u00a0%`;
    }

    const capsule = this.dom.pillScrubberContainer;
    if (capsule) {
      capsule.setAttribute("aria-valuemin", "1");
      capsule.setAttribute("aria-valuemax", String(totalPages));
      const curPage = customRatio !== null
        ? (totalPages > 1 ? Math.max(1, Math.min(totalPages, Math.round(1 + ratio * (totalPages - 1)))) : 1)
        : metrics.currBookPage;
      capsule.setAttribute("aria-valuenow", String(curPage));
    }

    if (this.dom.pillScrubberTooltipText) {
      if (customTooltip) {
        this.dom.pillScrubberTooltipText.textContent = customTooltip;
      } else {
        const resolved = this.resolveBookPage(metrics.currBookPage);
        let tooltipText = `Strana ${resolved.targetBookPage} z ${totalPages}`;
        if (!this.isPdfMode && resolved.chapterTitle && resolved.chapterTitle !== `Strana ${resolved.targetBookPage}` && resolved.chapterTitle !== this.currentBook?.title) {
          tooltipText = `Strana ${resolved.targetBookPage} z ${totalPages} \u2022 ${resolved.chapterTitle}`;
        }
        this.dom.pillScrubberTooltipText.textContent = tooltipText;
      }
    }
  }


  initPillScrubber() {
    const capsule = this.dom.pillScrubberContainer;
    if (!capsule) return;

    let isPointerDown = false;
    let pendingTargetPage = null;

    const getMetricsAndRatio = (e) => {
      const rect = capsule.getBoundingClientRect();
      const w = rect.width > 0 ? rect.width : 156;
      const clientX = e.clientX !== undefined
        ? e.clientX
        : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const rawX = clientX - rect.left;
      const clampedX = Math.max(0, Math.min(w, rawX));
      const ratio = clampedX / w;

      const bookMetrics = this.getBookMetrics();
      const totalPages = Math.max(1, bookMetrics.totalBookPages);
      const targetPage = totalPages > 1
        ? Math.max(1, Math.min(totalPages, Math.round(1 + ratio * (totalPages - 1))))
        : 1;

      return { ratio, clampedX, clientX, rect, width: w, targetPage, totalPages };
    };

    const updateTooltipPosition = (clientX, capsuleRect) => {
      const tooltip = this.dom.pillScrubberTooltip;
      if (!tooltip) return;

      const tooltipWidth = tooltip.offsetWidth || 180;
      const hw = tooltipWidth / 2;
      const screenW = window.innerWidth || document.documentElement.clientWidth || 360;
      const minMargin = 10;

      // Tooltip ideálně zarovnán na střed vůči horizontální pozici ukazatele/prstu
      const idealCenterX = Math.max(capsuleRect.left, Math.min(capsuleRect.right, clientX));
      // Omezení, aby bublina nepřetekla okraje obrazovky
      const clampedCenterX = Math.max(minMargin + hw, Math.min(screenW - minMargin - hw, idealCenterX));

      // Relativní souřadnice středu tooltipu vůči levému okraji kapsle
      const leftInCapsule = clampedCenterX - capsuleRect.left;
      tooltip.style.left = `${leftInCapsule}px`;

      // Posun šipky vůči středu tooltipu tak, aby mířila přesně na idealCenterX
      const arrowOffset = Math.max(-hw + 14, Math.min(hw - 14, idealCenterX - clampedCenterX));
      tooltip.style.setProperty("--arrow-offset-x", `${Math.round(arrowOffset)}px`);
    };

    const updateScrubFeedback = (e) => {
      const { ratio, clientX, rect, targetPage, totalPages } = getMetricsAndRatio(e);
      pendingTargetPage = targetPage;

      const resolved = this.resolveBookPage(targetPage);
      let tooltipText = `Strana ${resolved.targetBookPage} z ${totalPages}`;
      if (!this.isPdfMode && resolved.chapterTitle && resolved.chapterTitle !== `Strana ${resolved.targetBookPage}` && resolved.chapterTitle !== this.currentBook?.title) {
        tooltipText = `Strana ${resolved.targetBookPage} z ${totalPages} \u2022 ${resolved.chapterTitle}`;
      }

      this.updatePillScrubberUI(ratio, tooltipText);
      updateTooltipPosition(clientX, rect);
    };

    capsule.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      // Nekolidovat s tlačítkem obsahu vpravo
      if (e.target && e.target.closest("#btn-menu-toc")) return;

      tracker.cancelCurrentPageDwell();
      isPointerDown = true;
      this.isPillScrubbing = true;
      pendingTargetPage = null;

      capsule.classList.add("is-scrubbing");
      if (this.dom.readerFloatingDock) {
        this.dom.readerFloatingDock.classList.add("is-scrubbing");
      }
      if (this.dom.pillScrubberTooltip) {
        this.dom.pillScrubberTooltip.classList.remove("is-hidden");
      }

      updateScrubFeedback(e);

      try {
        capsule.setPointerCapture(e.pointerId);
      } catch (err) {}
    });

    capsule.addEventListener("pointermove", (e) => {
      if (!isPointerDown) return;
      e.preventDefault();
      e.stopPropagation();
      updateScrubFeedback(e);
    });

    const onPointerEnd = async (e) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      this.isPillScrubbing = false;

      try {
        capsule.releasePointerCapture(e.pointerId);
      } catch (err) {}

      capsule.classList.remove("is-scrubbing");
      if (this.dom.readerFloatingDock) {
        this.dom.readerFloatingDock.classList.remove("is-scrubbing");
      }
      if (this.dom.pillScrubberTooltip) {
        this.dom.pillScrubberTooltip.classList.add("is-hidden");
      }

      this.wasPillScrubbing = true;
      setTimeout(() => {
        this.wasPillScrubbing = false;
      }, 200);

      if (pendingTargetPage !== null) {
        const pageToNav = pendingTargetPage;
        pendingTargetPage = null;
        tracker.cancelCurrentPageDwell();
        await this.goToBookPage(pageToNav);
      }

      this.updatePillScrubberUI();
    };

    capsule.addEventListener("pointerup", onPointerEnd);
    capsule.addEventListener("pointercancel", onPointerEnd);

    // Klávesové ovládání při fokusu posuvníku
    capsule.addEventListener("keydown", async (e) => {
      const metrics = this.getBookMetrics();
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        await this.goToBookPage(metrics.currBookPage + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        await this.goToBookPage(metrics.currBookPage - 1);
      } else if (e.key === "Home") {
        e.preventDefault(); e.stopPropagation();
        await this.goToBookPage(1);
      } else if (e.key === "End") {
        e.preventDefault(); e.stopPropagation();
        await this.goToBookPage(metrics.totalBookPages);
      }
    });
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
function bootstrapLumina() {
  if (typeof window !== "undefined" && window.__luminaAppInitialized) return;

  // 1. Spolehlivě nastavit verzi v badge okamžitě
  try {
    const badge = document.getElementById("app-version-badge");
    if (badge) badge.textContent = APP_VERSION;
  } catch (_) {}

  // 2. Inicializovat aplikaci
  if (typeof document !== "undefined" && (document.getElementById("view-library") || document.body)) {
    if (typeof window !== "undefined") window.__luminaAppInitialized = true;
    try {
      const app = new LuminaApp();
      if (typeof window !== "undefined") window.luminaApp = app;
      app.init().catch(err => {
        console.error("[LuminaApp] Kritická neošetřená chyba v app.init():", err);
      });
    } catch (err) {
      console.error("[LuminaApp] Kritická chyba při vytváření LuminaApp instance:", err);
    }
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapLumina);
  } else {
    bootstrapLumina();
  }
}
