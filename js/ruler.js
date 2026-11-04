/**
 * ruler.js - Interaktivní čtecí pravítko (Reading Ruler) pro podporu soustředění.
 * Optimalizováno pro iPad a dotyková zařízení:
 * - Automatické přizpůsobení výšky pravítka podle výšky řádku textu (Auto-Height)
 * - Magnetická přilnavost (Magnetic Snap) k jednotlivým řádkům textu v knize
 * - Sledování jednotlivých slov (Word-level Tracking): zvýraznění / zaostření na konkrétní slovo
 * - 3 vizuální režimy (zvýrazňovací pás, zaostřovací maska, vodicí linka)
 * - Sledování kurzoru myši i přetahování prstem (touch drag na iPadu)
 * - Plovoucí ovládací panel pro krokování po řádcích/slovech a automatické tempo
 */

export const RULER_PADDING = 6; // px - jednotný offset pro vertikální i horizontální odsazení v řádkovém režimu
export const RULER_WAVE_WIDTH = 80; // px - fixní šířka vlnky indikátoru čteného slova pro režim Spodní clona (Bottom Cover)
export const RULER_WAVE_HEIGHT = 12; // px - fixní hloubka vlnky indikátoru
export const COVER_LINE_OFFSET = 2; // px - fixní vertikální vzdálenost vodicí linky pod spodním okrajem řádku v režimu Spodní clona (Bottom Cover)

export class ReadingRuler {
  constructor(containerElement, app = null) {
    this.container = containerElement;
    this.app = app;
    this.overlayContainer = null;
    this.rulerEl = null;
    this.wordWaveEl = null;
    this.maskTopEl = null;
    this.maskBottomEl = null;
    this.maskLeftEl = null;
    this.maskRightEl = null;
    this.maskInactiveSpreadEl = null; // Auxiliární celostránková maska pro neaktivní stranu v režimu dvoustrany (Two-Page Spread)
    this.onBoundary = null; // Callback vyvolaný při překročení hranice strany (direction: 1 | -1)

    // PDF Mode
    this.isPdfMode = false;
    this.isImageOnlyPdf = false;
    this._savedNonImageOnlyState = null;
    this.pdfRulerHeight = 32; // px - výchozí manuální výška pravítka pro PDF (16–120)
    this.pdfStandardLineHeight = 24; // px - standardní kompaktní výška řádku pro PDF
    this.pdfBaseLineHeight = null;
    this.pdfIntraParagraphPitch = null;
    this.pdfAutoHeight = true; // Automatická výška pravítka pro PDF podle metrik řádku
    this.isPdfHeightFromSlider = false;

    // Nastavení
    this.enabled = false;
    this.style = "highlight"; // "off" | "highlight" | "bottom-cover"
    this.mode = "highlight"; // mirrors style for backward compatibility
    this.focusMode = "off"; // "off" | "up" | "down" | "both"
    this.lastActiveStyle = "highlight";
    this.lastActiveFocus = "off";
    this.lastActiveCombination = { style: "highlight", focusMode: "off" };
    this.rulerPadding = RULER_PADDING;
    this.manualHeight = 48; // px (při vypnutém autoHeight)
    this.height = 36; // aktuální efektivní výška
    this.uniformLineHeight = null; // Jednotná výška pravítka podle intra-paragraph pitch
    this.lineHeightByFontSize = new Map(); // Mapa výšek pravítka podle velikosti písma
    this.glyphHeightByFontSize = new Map(); // Mapa mediánových výšek glyfů podle velikosti písma
    this.pitchByFontSize = new Map(); // Mapa intra-odstavcových roztečí (pitch) podle velikosti písma
    this._canonicalColTopOffsets = new Map(); // Mapa kanonických vertikálních odsazení prvního řádku sloupce pro zamezení posunu pravítka mezi stranami
    this.autoHeight = true; // Automatická výška podle velikosti řádku
    this.snapToLines = true; // Magnetická přilnavost k řádkům
    this.wordTracking = false; // Sledování jednotlivých slov
    this.wordTrackingExplicitlyEnabledInPdf = false; // Explicitní aktivace sledování slov uživatelem v PDF
    this.color = "amber"; // amber | cyan | emerald | lavender | slate
    this.dimOpacity = 0.65;
    this.followMode = "mouse"; // "mouse" | "keyboard" | "auto"

    // Geometrické ohraničení aktivní čtecí zóny pro řízení viditelnosti kurzoru myši
    this.readingLeft = null;
    this.readingRight = null;
    this.readingTop = null;
    this.readingBottom = null;
    this._isCursorHidden = false;

    // Stav pozice, řádků a slov
    this.currentY = 180; // px relativně k viewportu
    this.targetY = 180;
    this.lastPointerX = 300; // Poslední známá X souřadnice kurzoru
    this.lastPointerY = 200; // Poslední známá Y souřadnice kurzoru
    this.wordLeft = 0;
    this.wordWidth = 100;
    this.activeWordWidth = 100;
    this.totalWidth = 100;
    this.previewLeft = 0;
    this.previewWidth = 0;
    this.cachedLines = []; // Seznam řádků na aktuální stránce [{ top, bottom, height, centerY }]
    this.cachedWords = []; // Seznam slov na aktuální stránce [{ text, left, right, top, bottom, width, height, centerX, centerY }]
    this.activeLineIndex = -1;
    this.previousActiveLineIndex = -1;
    this.activeWordIndex = -1;
    this._rulerMode = "line"; // "line" | "word"
    this._activeReadingLineIndex = -1;
    this._activeLineStartTime = 0;
    this._completedLineIndices = new Set();
    this._lastWordLineIndex = -1;
    this._lastWordIndex = -1;
    this._wordsReadOnPage = new Set();
    this._lastActiveLineIndex = -1;
    this._lastActiveColumn = null;
    this._focusMaskDirty = false;
    this._lastEmptyWordsDetectTime = 0;
    this._forceRefreshWords = false;
    this._lastAppliedWordWidth = null;
    this._lastWordSolidRatio = null;
    this.onProgress = null; // Callback: (type: "line" | "word", count: number)
    this.onStateChange = null; // Callback: (enabled: boolean, mode: string)
    this._maxLineIndexOnPage = -1;
    this._maxWordLineIndexOnPage = -1;
    this._maxWordIndexOnPage = -1;
    this._lastLineProgressTime = 0;
    this._lastWordProgressTime = 0;
    this.animFrameId = null;
    this.isDragging = false;
    this.isPageTransitioning = false;
    this.isNavigating = false;
    this.isNavigatingPage = false;
    this.navigatingPageTimer = null;
    this.navigatingPageLockoutEndTime = 0;
    this.pageChangeTimer = null;
    this._onTransitionEnd = null;
    this._calibrationTimer = null;

    // Apple Pencil (Stylus) & Pointer sledování & Mutex stav
    this.isDraggingRuler = false; // Mutex zámek během aktivního tažení
    this.isPenTouching = false;
    this.activePointerId = null; // Primární Pointer ID (pro palm rejection)
    this.activePointerType = null;
    this.lastPenTime = 0;
    this.lastPenDetails = null;
    this.dragCooldownEndTime = 0; // Časové okno blokující nežádoucí tap/click události
    this.lastValidPointerX = null;
    this.lastValidPointerY = null;
    this.rafPointerPending = false;
    this.pointerRafId = null;
    this.pendingPointerX = 300;
    this.pendingPointerY = 200;

    // 500ms podržení pro přemístění pravítka (prst, Apple Pencil, kurzor)
    this.holdTimer = null;
    this.holdStartX = 0;
    this.holdStartY = 0;
    this.holdStartTime = 0;
    this.holdPointerType = null;
    this.isHoldActive = false;
    this.isHoldTriggered = false;
    this.wasHoldAborted = false;
    this.lastTapStepTime = 0;
    this.lastTouchTapTime = 0;
    this.lastSwipeTime = 0;
    this.onBoundary = null;
    this.onSwipe = null;
    // Apple Pencil Flick Gestures (Listování švihnutím stylusu bez opuštění toku textu)
    this.penFlickEnabled = true;
    this.penHistory = []; // Posuvné okno vzorků: [{ x, y, time }]
    this.penStrokeStartTime = 0;
    this.penStrokeStartX = 0;
    this.penStrokeStartY = 0;
    this.flickHandledInStroke = false;
    this.lastFlickNavigationTime = 0;
    this.flickNavigationCooldown = 450; // ms (approx. 400–500 ms)
    this.flickResyncTopLine = false;
    this.onPenFlick = null;
    // Touch Swipe (Relaxované listování tahem prstu)
    this.touchHistory = [];
    this.touchStrokeStartTime = 0;
    this.touchStrokeStartX = 0;
    this.touchStrokeStartY = 0;
    this.horizontalWordTransition = false;
    this.isWordTransitioning = false;
    this.wordTransitionTimer = null;
    this.suppressLineAdvancement = false;
    this.pageTurnTimestamp = 0;
    this.suppressTimer = null;
    this.pageChangeRafId = null;
    this.isLineLocked = false;
    this.lineLockTimer = null;
    this._navSafetyTimer = null;
    this._trackingSuspendedByOverlay = false;
    this._lineWordsCache = new Map();
    // Callback wired by app.js: () => bool — returns true when any drawer/panel is open.
    // When true, ruler click/tap handlers must yield to backdrop close logic.
    this.isAnyDrawerOpen = null;

    // Vertikální teleprompter ukotvení a režim čtení
    this.readingMode = null;
    this.stationaryScreenY = null;
    this._isProgrammaticScroll = false;
    this._programmaticScrollTimer = null;

    // Vertikální ukotvení a relativní tracking po scrollu (followMode === 'mouse')
    this._verticalScrollAnchorPending = false;
    this._relativeTrackingActive = false;
    this._scrollAnchorPhysicalY = null;
    this._scrollAnchorVirtualY = null;

    // Vertikální optimalizace plynulého scrollování a GPU akcelerace
    this._scrollRafPending = false;
    this._scrollRafId = null;
    this._scrollEndTimer = null;
    this._isVerticalScrolling = false;
    this._cachedScrollTop = 0;
    this._cachedViewportHeight = 0;
    this._rulerLeft = 0;
    this._rulerWidth = 0;
    this._slitLeft = 0;
    this._slitRight = 0;
    this._onScroll = null;

    this.createDomElements();
    this.attachEvents();
  }

  isVerticalMode() {
    return (document.body?.classList?.contains("mode-vertical")) ||
      (document.documentElement?.classList?.contains("mode-vertical")) ||
      (document.body?.dataset?.readingMode === "vertical") ||
      (this.readingMode === "vertical");
  }

  /**
   * Zjistí, zda je aktivní režim dvoustrany pro PDF (Two-Page Spread)
   */
  isSpreadActive() {
    if (this.app?.pdfLoader?.isSpreadActive) {
      if (this.app.pdfLoader.isSpreadActive()) return true;
    }
    if (window.luminaApp?.pdfLoader?.isSpreadActive) {
      if (window.luminaApp.pdfLoader.isSpreadActive()) return true;
    }
    const spread = document.querySelector("#reader-content .pdf-spread-container");
    if (spread) {
      const slots = spread.querySelectorAll(".pdf-page-slot");
      return slots.length >= 2;
    }
    const slots = document.querySelectorAll("#reader-content .pdf-page-slot");
    return slots.length >= 2;
  }

  /**
   * Získá přesné informace o aktivní stránce v režimu dvoustrany (Two-Page Spread).
   * Detekuje levý a pravý slot, odpovídající plátna (canvas) a určí,
   * zda je aktivní levá či pravá strana podle pozice aktuálního řádku / ukazatele.
   */
  getActiveSpreadInfo(currentLine = null) {
    if (!this.isSpreadActive()) return null;
    const spreadSlots = Array.from(document.querySelectorAll("#reader-content .pdf-page-slot"));
    if (spreadSlots.length < 2) return null;

    // Vizuální seřazení zleva doprava
    spreadSlots.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    let leftSlot = spreadSlots[0];
    let rightSlot = spreadSlots[1];
    let leftCanvas = leftSlot.querySelector("canvas") || leftSlot;
    let rightCanvas = rightSlot.querySelector("canvas") || rightSlot;

    let leftRect = leftCanvas.getBoundingClientRect();
    let rightRect = rightCanvas.getBoundingClientRect();
    if (leftRect.width < 50) leftRect = leftSlot.getBoundingClientRect();
    if (rightRect.width < 50) rightRect = rightSlot.getBoundingClientRect();

    if (leftRect.left > rightRect.left) {
      const tSlot = leftSlot;
      leftSlot = rightSlot;
      rightSlot = tSlot;
      const tCanvas = leftCanvas;
      leftCanvas = rightCanvas;
      rightCanvas = tCanvas;
      const tRect = leftRect;
      leftRect = rightRect;
      rightRect = tRect;
    }

    const line = currentLine || (this.activeLineIndex >= 0 && this.cachedLines ? this.cachedLines[this.activeLineIndex] : null);
    const lineEl = line ? (line.element || line.el) : null;

    let isLeftActive = true;
    if (lineEl && rightSlot.contains(lineEl)) {
      isLeftActive = false;
    } else if (lineEl && leftSlot.contains(lineEl)) {
      isLeftActive = true;
    } else if (line && line.columnIndex === 1) {
      isLeftActive = false;
    } else if (line && line.columnIndex === 0) {
      isLeftActive = true;
    } else {
      const midGap = (leftRect.right + rightRect.left) / 2;
      const refX = Number.isFinite(line?.textLeft)
        ? line.textLeft
        : (Number.isFinite(line?.left)
          ? line.left
          : (this.lastPointerX ?? (leftRect.left + leftRect.width / 2)));
      isLeftActive = refX < midGap;
    }

    const activeSlot = isLeftActive ? leftSlot : rightSlot;
    const inactiveSlot = isLeftActive ? rightSlot : leftSlot;
    const activeCanvas = isLeftActive ? leftCanvas : rightCanvas;
    const inactiveCanvas = isLeftActive ? rightCanvas : leftCanvas;
    const activeRect = isLeftActive ? leftRect : rightRect;
    const inactiveRect = isLeftActive ? rightRect : leftRect;

    return {
      isLeftActive,
      leftSlot,
      rightSlot,
      leftCanvas,
      rightCanvas,
      leftRect,
      rightRect,
      activeSlot,
      inactiveSlot,
      activeCanvas,
      inactiveCanvas,
      activeRect,
      inactiveRect,
      midGap: (leftRect.right + rightRect.left) / 2
    };
  }

  setReadingMode(mode) {
    this.readingMode = mode;
    if (this._canonicalColTopOffsets) {
      this._canonicalColTopOffsets.clear();
    }
    if (mode !== "vertical") {
      this.stationaryScreenY = null;
      this._verticalScrollAnchorPending = false;
      this._relativeTrackingActive = false;
      this._scrollAnchorPhysicalY = null;
      this._scrollAnchorVirtualY = null;
      if (this._scrollEndTimer) {
        clearTimeout(this._scrollEndTimer);
        this._scrollEndTimer = null;
      }
      if (this._scrollRafId) {
        cancelAnimationFrame(this._scrollRafId);
        this._scrollRafId = null;
      }
      this._scrollRafPending = false;
      this._isVerticalScrolling = false;
    } else {
      this.ensureVerticalScrollListener();
    }
    this.refreshLines();
    if (this.enabled && (!this.isPdfMode || (this.cachedLines && this.cachedLines.length > 0)) && this.isVerticalMode() && this.followMode === "keyboard" && this.stationaryScreenY === null) {
      this.initDefaultStationaryAnchor();
    } else {
      this.applyPosition();
    }
  }

  /**
   * Příprava a synchronní pre-kalkulace pravítka pro přechod mezi stranami.
   * V režimu Zaostření (Focus Mode) udržuje masky kontinuálně aktivní a okamžitě
   * je synchronně usadí na cílový výchozí řádek (line 0) před zobrazením nové strany.
   */
  prepareForPageTransition(direction = 1) {
    if (direction > 0) {
      this.finalizeCurrentPageProgress();
    } else {
      this._activeReadingLineIndex = -1;
      this._activeLineStartTime = 0;
      this._completedLineIndices = new Set();
      this._lastWordLineIndex = -1;
      this._lastWordIndex = -1;
      this._wordsReadOnPage = new Set();
    }
    this.isPageTransitioning = true;
    this.setCursorHidden(false);
    this.disableWordTransition();
    this.cancelHold(false);

    if (this.rulerEl) {
      this.rulerEl.classList.add("is-page-transitioning");
      this.rulerEl.style.transition = "none";
      this.rulerEl.style.setProperty("transition", "none", "important");
    }

    const isFocusActive = this.enabled && this.focusMode && this.focusMode !== "off";
    if (!isFocusActive) {
      if (this.rulerEl) {
        this.rulerEl.style.opacity = "0";
        this.rulerEl.style.visibility = "hidden";
      }
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      if (this.maskTopEl) this.maskTopEl.style.display = "none";
      if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
      if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
      if (this.maskRightEl) this.maskRightEl.style.display = "none";
      if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
      this.clearFocusTextMask();
      return;
    }

    // FOCUS MODE IS ACTIVE: Keep masks persistently visible and default to target line immediately
    const targetLineIdx = direction >= 0 ? 0 : Math.max(0, (this.cachedLines ? this.cachedLines.length - 1 : 0));
    this.activeLineIndex = targetLineIdx;
    this.activeWordIndex = direction >= 0 ? 0 : Math.max(0, (this.cachedWords ? this.cachedWords.length - 1 : 0));

    // Disable all mask transitions so position update is instantaneous and flicker-free
    if (this.maskTopEl) this.maskTopEl.style.setProperty("transition", "none", "important");
    if (this.maskBottomEl) this.maskBottomEl.style.setProperty("transition", "none", "important");
    if (this.maskLeftEl) this.maskLeftEl.style.setProperty("transition", "none", "important");
    if (this.maskRightEl) this.maskRightEl.style.setProperty("transition", "none", "important");
    if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.setProperty("transition", "none", "important");

    // Apply the target starting position synchronously before the page becomes visible
    this.prepareFocusMasksForTransition(direction);
  }

  /**
   * Skryje pravítko během přechodu na jinou stránku a výpočtu řádků.
   * V režimu Zaostření (Focus Mode) však masku neskrývá, ale okamžitě ji
   * nastaví na cílovou výchozí pozici pro zamezení probliknutí čistého textu.
   */
  hideForPageTransition(direction = 1) {
    this.prepareForPageTransition(direction);
  }

  clearPageTransitionTimersAndRAFs() {
    if (this._navSafetyTimer) {
      clearTimeout(this._navSafetyTimer);
      this._navSafetyTimer = null;
    }
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
    if (this.lineLockTimer) {
      clearTimeout(this.lineLockTimer);
      this.lineLockTimer = null;
    }
    if (this.pageChangeTimer) {
      clearTimeout(this.pageChangeTimer);
      this.pageChangeTimer = null;
    }
    if (this.navigatingPageTimer) {
      clearTimeout(this.navigatingPageTimer);
      this.navigatingPageTimer = null;
    }
    if (this.wordTransitionTimer) {
      clearTimeout(this.wordTransitionTimer);
      this.wordTransitionTimer = null;
    }
    if (this._refreshLinesDebounceTimer) {
      clearTimeout(this._refreshLinesDebounceTimer);
      this._refreshLinesDebounceTimer = null;
    }
    if (this.pageChangeRafId) {
      cancelAnimationFrame(this.pageChangeRafId);
      this.pageChangeRafId = null;
    }
    if (this.pointerRafId) {
      cancelAnimationFrame(this.pointerRafId);
      this.pointerRafId = null;
    }
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }
    const content = document.getElementById("reader-content");
    if (content && this._onTransitionEnd) {
      content.removeEventListener("transitionend", this._onTransitionEnd);
      this._onTransitionEnd = null;
    }
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this._scrollEndTimer) {
      clearTimeout(this._scrollEndTimer);
      this._scrollEndTimer = null;
    }
    if (this._scrollRafId) {
      cancelAnimationFrame(this._scrollRafId);
      this._scrollRafId = null;
    }
    this._scrollRafPending = false;
    this._isVerticalScrolling = false;
    this.rafPointerPending = false;
  }

  forceReleaseNavigationLocks() {
    this.isNavigating = false;
    this.isNavigatingPage = false;
    this.isLineLocked = false;
    this.suppressLineAdvancement = false;
    this.isPageTransitioning = false;
    this.navigatingPageLockoutEndTime = 0;
    this.dragCooldownEndTime = 0;

    if (this.rulerEl) {
      this.rulerEl.classList.remove("is-page-transitioning");
      if (this.enabled) {
        this.rulerEl.style.opacity = "1";
        this.rulerEl.style.visibility = "visible";
      }
    }

    const stage = this.getStageElement();
    if (stage) stage.classList.remove("is-turning-page");
    document.body.classList.remove("is-turning-page");
    const content = document.getElementById("reader-content");
    if (content) content.classList.remove("is-turning-page");
  }

  lockAdvancement(duration = 350, direction = 1) {
    const stage = this.getStageElement();
    if (stage) stage.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");
    const content = document.getElementById("reader-content");
    if (content) content.classList.add("is-turning-page");

    this.hideForPageTransition(direction);
    this.pageTurnTimestamp = performance.now();
    this.suppressLineAdvancement = true;
    this.isLineLocked = true;
    if (this.suppressTimer) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressLineAdvancement = false;
      this.isLineLocked = false;
      this.suppressTimer = null;
      this.forceReleaseNavigationLocks();
      if (this.enabled) {
        this.applyPosition();
      }
    }, duration);

    if (this._navSafetyTimer) clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked || this.suppressLineAdvancement || this.isPageTransitioning) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.clearPageTransitionTimersAndRAFs();
        this.forceReleaseNavigationLocks();
      }
    }, Math.max(300, duration + 50)); // lock lifetime slightly longer than duration
  }

  /**
   * Nastaví stav pravítka pro skenovaný/obrazový PDF dokument (bez textové vrstvy).
   * Automaticky deaktivuje magnetické přichytávání k řádkům, auto-height,
   * sledování slov a přepne na plynulé sledování kurzoru (followMode = "mouse").
   * Při přepnutí zpět obnoví původní nastavení.
   */
  setImageOnlyPdf(isImageOnly) {
    const flag = !!isImageOnly;
    if (this.isImageOnlyPdf === flag) return;
    this.isImageOnlyPdf = flag;

    if (this.isImageOnlyPdf) {
      if (!this._savedNonImageOnlyState) {
        this._savedNonImageOnlyState = {
          snapToLines: this.snapToLines,
          pdfAutoHeight: this.pdfAutoHeight,
          wordTracking: this.wordTracking,
          followMode: this.followMode
        };
      }

      this.snapToLines = false;
      this.pdfAutoHeight = false;
      this.isPdfHeightFromSlider = true;
      this.height = this.pdfRulerHeight || 32;
      this.uniformLineHeight = this.height;
      this.wordTracking = false;
      this.wordTrackingExplicitlyEnabledInPdf = false;
      this.followMode = "mouse";
      this.stationaryScreenY = null;
      this.cachedLines = [];
      this.cachedWords = [];

      if (this.rulerEl) {
        this.rulerEl.classList.remove("word-tracking-mode", "is-snapped");
        this.rulerEl.style.height = this.mode === "bottom-cover" ? "2px" : `${this.height}px`;
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.style.display = "none";
      }
      if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
      if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
      if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
    } else {
      if (this._savedNonImageOnlyState) {
        this.snapToLines = this._savedNonImageOnlyState.snapToLines;
        this.pdfAutoHeight = this._savedNonImageOnlyState.pdfAutoHeight;
        this.wordTracking = this._savedNonImageOnlyState.wordTracking;
        this.followMode = this._savedNonImageOnlyState.followMode;
        this._savedNonImageOnlyState = null;
      } else {
        this.snapToLines = true;
        this.pdfAutoHeight = true;
        this.followMode = "mouse";
        this.wordTracking = false;
      }
      if (this.isPdfMode) {
        if (!this.pdfAutoHeight) {
          this.height = this.pdfRulerHeight || 32;
          this.uniformLineHeight = this.height;
        } else {
          this.uniformLineHeight = null;
          this.detectLines();
          if (this.cachedLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
            const geom = this.computeLineGeometry(this.activeLineIndex);
            if (geom) {
              this.height = geom.height;
              this.targetY = geom.targetY;
            }
          }
        }
      }
    }

    this.updateBodyClasses();
    if (this.enabled) {
      this.applyPosition();
    }
    this.updateRulerSettingsVisibility(this.mode, this.isPdfMode);
  }

  setPdfMode(enabled, height = null) {
    const wasPdfMode = this.isPdfMode;
    this.isPdfMode = !!enabled;
    this.isPdfHeightFromSlider = false;
    if (this.isPdfMode) {
      if (this.isImageOnlyPdf) {
        this.snapToLines = false;
        this.pdfAutoHeight = false;
        this.isPdfHeightFromSlider = true;
        this.height = this.pdfRulerHeight || 32;
        this.uniformLineHeight = this.height;
        this.wordTracking = false;
        this.wordTrackingExplicitlyEnabledInPdf = false;
        this.followMode = "mouse";
      } else {
        // 1. V PDF režimu vynutit výchozí plnošířkový řádkový režim (wordTracking = false),
        // pokud uživatel explicitně nezapnul sledování slov v PDF.
        const isSettingWord = this.app?.settings?.ruler?.rulerModeType === "word" || this.app?.settings?.ruler?.wordTracking === true;
        if (isSettingWord || this.wordTrackingExplicitlyEnabledInPdf) {
          this.wordTracking = true;
          this.wordTrackingExplicitlyEnabledInPdf = true;
        } else if (!wasPdfMode) {
          this.wordTracking = false;
          this.wordTrackingExplicitlyEnabledInPdf = false;
        }
      }

      if (!this.wordTracking) {
        this.disableWordTransition?.();
        if (this.rulerEl) {
          this.rulerEl.classList.remove("word-tracking-mode");
        }
        if (this.wordWaveEl) {
          this.wordWaveEl.style.display = "none";
        }
        this.previewWidth = 0;
        this.totalWidth = 0;
      }

      if (height !== null) {
        if (typeof height === "object" && height !== null) {
          if (height.autoHeight !== undefined && !this.isImageOnlyPdf) {
            this.pdfAutoHeight = !!height.autoHeight;
          }
          if (height.height !== undefined) {
            this.setPdfRulerHeight(height.height, !this.pdfAutoHeight);
          }
        } else {
          this.setPdfRulerHeight(height);
        }
      }
      this.detectLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
      if (this.cachedLines && this.cachedLines.length > 0) {
        if (this.rulerEl) {
          this.rulerEl.classList.remove("pdf-ruler-overlay");
          if (!this.wordTracking) {
            this.rulerEl.classList.remove("word-tracking-mode");
          }
        }
        if (!this.pdfAutoHeight) {
          this.height = this.pdfRulerHeight || this.manualHeight || 32;
          this.uniformLineHeight = this.height;
        } else if (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
          const geom = this.computeLineGeometry(this.activeLineIndex);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
          }
        }
      } else {
        this.height = (!this.pdfAutoHeight ? this.pdfRulerHeight : this.pdfStandardLineHeight) || 24;
        this.uniformLineHeight = !this.pdfAutoHeight ? this.height : null;
        if (this.rulerEl) {
          this.rulerEl.classList.remove("pdf-ruler-overlay");
          this.rulerEl.classList.remove("word-tracking-mode");
        }
      }
      this.updateBodyClasses();
      if (this.enabled) {
        this.applyPosition();
      }
    } else {
      this.setImageOnlyPdf(false);
      this.wordTrackingExplicitlyEnabledInPdf = false;
      if (this.rulerEl) {
        this.rulerEl.classList.remove("pdf-ruler-overlay");
      }
      if (this.maskTopEl) this.maskTopEl.classList.remove("pdf-overlay-mask");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("pdf-overlay-mask");
      if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
      if (this.enabled) {
        this.refreshLines();
        this.applyPosition();
      }
    }
    this.updateRulerSettingsVisibility(this.mode, this.isPdfMode);
  }

  setPdfAutoHeight(enabled) {
    this._lastComputedLineGeom = null;
    if (this.isImageOnlyPdf) {
      this.pdfAutoHeight = false;
      this.isPdfHeightFromSlider = true;
      this.height = this.pdfRulerHeight || 32;
      this.uniformLineHeight = this.height;
      this.refreshVisualState();
      return;
    }
    this.pdfAutoHeight = !!enabled;
    this.isPdfHeightFromSlider = !this.pdfAutoHeight;
    if (this.pdfAutoHeight) {
      this.uniformLineHeight = null;
      this.detectLines();
      if (this.cachedLines && this.cachedLines.length > 0) {
        if (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
          const geom = this.computeLineGeometry(this.activeLineIndex);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
          }
        } else {
          this.height = this.pdfStandardLineHeight || 24;
        }
      } else {
        this.height = this.pdfStandardLineHeight || 24;
      }
    } else {
      this.height = this.pdfRulerHeight || this.manualHeight || 32;
      this.uniformLineHeight = this.height;
      if (this.cachedLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
        }
      }
    }
    this.refreshVisualState();
  }

  getPdfAutoHeight() {
    if (this.isImageOnlyPdf) return false;
    return this.pdfAutoHeight !== false;
  }

  setPdfRulerHeight(height, isUserSlider = false) {
    this._lastComputedLineGeom = null;
    const h = Math.max(16, Math.min(120, Math.round(Number(height) || 32)));
    this.pdfRulerHeight = h;
    if (isUserSlider) {
      this.isPdfHeightFromSlider = true;
    }
    if (this.isPdfMode) {
      if (this.isImageOnlyPdf || !this.cachedLines || this.cachedLines.length === 0 || !this.pdfAutoHeight || this.isPdfHeightFromSlider) {
        this.height = h;
        this.uniformLineHeight = h;
      }
      if (this.cachedLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0 && (!this.pdfAutoHeight || this.isPdfHeightFromSlider)) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
        }
      }
    }
    this.refreshVisualState();
  }

  getPdfRulerHeight() {
    return this.pdfRulerHeight || 32;
  }

  isLastLine() {
    if (!this.enabled) return false;
    if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) return false;
    if (this.wordTracking) {
      if (!this.cachedLines || this.cachedLines.length === 0) return false;
      const isLastLine = this.activeLineIndex >= this.cachedLines.length - 1;
      if (!isLastLine) return false;
      if (!this.cachedWords || this.cachedWords.length === 0) return true;
      return this.activeWordIndex >= this.cachedWords.length - 1;
    }
    if (this.cachedLines.length === 0) return false;
    return this.activeLineIndex >= this.cachedLines.length - 1;
  }

  stepRuler(delta, force = false) {
    return this.stepLine(delta, force);
  }

  get rulerActive() {
    return this.enabled;
  }

  set rulerActive(val) {
    this.setEnabled(val);
  }

  get rulerMode() {
    return this._rulerMode || (this.wordTracking ? "word" : "line");
  }

  set rulerMode(val) {
    this.setRulerMode(val);
  }

  setRulerMode(mode) {
    const valid = ["line", "word"].includes(mode) ? mode : "line";
    if (this._rulerMode !== valid) {
      this.finalizeCurrentPageProgress();
    }
    this._rulerMode = valid;
    this.wordTracking = (valid === "word");
    if (this.isPdfMode) {
      this.wordTrackingExplicitlyEnabledInPdf = this.wordTracking;
    }

    if (this.rulerEl) {
      this.rulerEl.classList.toggle("word-tracking-mode", valid === "word");
      this.rulerEl.classList.toggle("line-mode", valid === "line");
    }

    this._lastEmptyWordsDetectTime = 0;
    this._lastActiveLineIndex = -1;
    this._lastAppliedWordWidth = null;
    this._lastWordSolidRatio = null;

    if (valid === "word") {
      if (!this.cachedLines || this.cachedLines.length === 0) {
        this.refreshLines();
      }
      const targetLine = (this.activeLineIndex >= 0 && this.activeLineIndex < (this.cachedLines?.length || 0))
        ? this.activeLineIndex
        : 0;
      this.activeLineIndex = targetLine;
      const words = this.ensureActiveWords(targetLine);
      if (words && words.length > 0) {
        this.activeWordIndex = 0;
        this.setWordWindow(0);
      } else {
        this.activeWordIndex = -1;
      }
      if (this.rulerEl) this.rulerEl.classList.add("word-tracking-mode");
    } else {
      this.activeWordIndex = -1;
      this._clearWordCache();
      if (this.rulerEl) {
        this.rulerEl.classList.remove("word-tracking-mode", "no-preview");
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.style.display = "none";
      }
      if (this.cachedLines && this.cachedLines.length > 0) {
        const lineIdx = Math.max(0, Math.min(this.cachedLines.length - 1, this.activeLineIndex >= 0 ? this.activeLineIndex : 0));
        this.activeLineIndex = lineIdx;
        const geom = this.computeLineGeometry(lineIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = geom.targetY;
        }
      }
    }

    this.updateBodyClasses();
    this.updateStyles();
    if (typeof this.onStateChange === "function") {
      this.onStateChange(this.enabled, this.rulerMode);
    }
    this.applyPosition();
  }

  enableWordTransition() {
    this.disableWordTransition();
  }

  disableWordTransition() {
    const wasTransitioning = this.isWordTransitioning || this.horizontalWordTransition;
    this.horizontalWordTransition = false;
    if (this.wordTransitionTimer) {
      clearTimeout(this.wordTransitionTimer);
      this.wordTransitionTimer = null;
    }
    this.isWordTransitioning = false;
    if (!wasTransitioning) return;
    if (this.rulerEl) {
      this.rulerEl.classList.remove("word-transition-active");
      this.rulerEl.classList.add("word-transition-snap");
      this.rulerEl.style.setProperty("transition", "none", "important");
    }
    if (this.maskLeftEl) {
      this.maskLeftEl.classList.remove("word-transition-active");
      this.maskLeftEl.classList.add("word-transition-snap");
      this.maskLeftEl.style.setProperty("transition", "none", "important");
    }
    if (this.maskRightEl) {
      this.maskRightEl.classList.remove("word-transition-active");
      this.maskRightEl.classList.add("word-transition-snap");
      this.maskRightEl.style.setProperty("transition", "none", "important");
    }
    if (this.maskTopEl) this.maskTopEl.style.setProperty("transition", "none", "important");
    if (this.maskBottomEl) this.maskBottomEl.style.setProperty("transition", "none", "important");
  }

  createDomElements() {
    this.rulerEl = document.createElement("div");
    this.rulerEl.className = `reading-ruler mode-${this.mode} color-${this.color} is-hidden`;
    this.rulerEl.id = "reading-ruler";
    this.rulerEl.setAttribute("aria-hidden", "true");
    this.rulerEl.style.willChange = "transform";
    this.rulerEl.style.contain = this.mode === "bottom-cover" ? "none" : "paint";

    this.wordWaveEl = document.createElement("div");
    this.wordWaveEl.className = "ruler-word-wave";
    this.wordWaveEl.setAttribute("aria-hidden", "true");
    this.wordWaveEl.innerHTML = `<svg viewBox="0 0 80 12" width="80" height="12" preserveAspectRatio="none"><path d="M 0,0 C 20,0 24,12 40,12 C 56,12 60,0 80,0 Z" fill="currentColor" /></svg>`;
    this.rulerEl.appendChild(this.wordWaveEl);

    this.maskTopEl = document.createElement("div");
    this.maskTopEl.className = "ruler-mask ruler-mask-top is-hidden";
    this.maskTopEl.style.willChange = "transform";
    this.maskTopEl.style.contain = "paint";
    this.maskTopEl.style.pointerEvents = "none";

    this.maskBottomEl = document.createElement("div");
    this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-hidden";
    this.maskBottomEl.style.willChange = "transform";
    this.maskBottomEl.style.contain = "paint";
    this.maskBottomEl.style.pointerEvents = "none";

    this.maskLeftEl = document.createElement("div");
    this.maskLeftEl.className = "ruler-mask ruler-mask-left is-hidden";
    this.maskLeftEl.style.willChange = "transform";
    this.maskLeftEl.style.contain = "paint";
    this.maskLeftEl.style.pointerEvents = "none";

    this.maskRightEl = document.createElement("div");
    this.maskRightEl.className = "ruler-mask ruler-mask-right is-hidden";
    this.maskRightEl.style.willChange = "transform";
    this.maskRightEl.style.contain = "paint";
    this.maskRightEl.style.pointerEvents = "none";

    this.maskInactiveSpreadEl = document.createElement("div");
    this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom mode-bottom-cover ruler-mask-inactive-spread is-hidden";
    this.maskInactiveSpreadEl.style.willChange = "transform";
    this.maskInactiveSpreadEl.style.contain = "paint";
    this.maskInactiveSpreadEl.style.pointerEvents = "none";

    this.ensureOverlayContainer();

    this.updateStyles();
    this.applyPosition();
  }

  /**
   * Zajišťuje existenci dedikovaného persistentního kontejneru pro překryvnou masku a pravítko.
   * Kontejner je umístěn přímo v document.body a je oddělen od přerenderovávaného DOMu knihy.
   */
  ensureOverlayContainer() {
    if (!this.overlayContainer || !document.body.contains(this.overlayContainer)) {
      let el = document.getElementById("ruler-overlay-container");
      if (!el) {
        el = document.createElement("div");
        el.id = "ruler-overlay-container";
        el.className = "ruler-overlay-container";
        el.setAttribute("aria-hidden", "true");
        document.body.appendChild(el);
      }
      this.overlayContainer = el;
    }
    if (this.maskTopEl && !this.overlayContainer.contains(this.maskTopEl)) this.overlayContainer.appendChild(this.maskTopEl);
    if (this.maskBottomEl && !this.overlayContainer.contains(this.maskBottomEl)) this.overlayContainer.appendChild(this.maskBottomEl);
    if (this.maskLeftEl && !this.overlayContainer.contains(this.maskLeftEl)) this.overlayContainer.appendChild(this.maskLeftEl);
    if (this.maskRightEl && !this.overlayContainer.contains(this.maskRightEl)) this.overlayContainer.appendChild(this.maskRightEl);
    if (this.maskInactiveSpreadEl && !this.overlayContainer.contains(this.maskInactiveSpreadEl)) this.overlayContainer.appendChild(this.maskInactiveSpreadEl);
    if (this.rulerEl && !this.overlayContainer.contains(this.rulerEl)) this.overlayContainer.appendChild(this.rulerEl);
    return this.overlayContainer;
  }

  /**
   * Vrátí kanonickou geometrii horního řádku těla textu ve sloupci (line 0)
   * pro bezchybnou synchronizaci pravítka a clon zaostření před přechodem strany.
   */
  getCanonicalTopLineGeometry(colIdx = 0) {
    if (this.isPdfMode || this.isVerticalMode()) return null;
    const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    if (!stageRect || stageRect.width <= 50 || stageRect.height <= 50) return null;

    const stageTop = Math.round(stageRect.top);
    const isTwoCol = !this.isVerticalMode() && this.isTwoCol;
    const isBottomCover = this.style === "bottom-cover" || this.mode === "bottom-cover";

    if (this._canonicalColTopOffsets && this._canonicalColTopOffsets.size > 0) {
      for (const [key, data] of this._canonicalColTopOffsets.entries()) {
        const parts = key.split("_");
        if (parts.length >= 4) {
          const keyDomFs = parseInt(parts[0], 10) || 16;
          const keyStageTop = parseInt(parts[1], 10);
          const keyColIdx = parseInt(parts[2], 10);
          const keyTwoCol = parseInt(parts[3], 10);
          if (Math.abs(keyStageTop - stageTop) <= 2 && keyColIdx === colIdx && keyTwoCol === (isTwoCol ? 2 : 1)) {
            const relCenterY = typeof data === "object" ? data.relCenterY : data;
            const domGlyphH = (typeof data === "object" && data.glyphH) ? data.glyphH : (this.glyphHeightByFontSize?.get(keyDomFs) || (keyDomFs * 1.15));
            const visualCenterY = (stageTop + relCenterY) - 1;
            const lineTop = Math.round(visualCenterY - domGlyphH / 2);
            const curBottom = (stageTop + relCenterY) + domGlyphH / 2;
            const coverTargetY = Math.round(curBottom + 1);
            const lineBottom = coverTargetY;
            const left = colIdx === 1 ? (this.column1Left ?? Math.round(stageRect.left + stageRect.width / 2)) : (this.column0Left ?? Math.round(stageRect.left));
            const width = colIdx === 1 ? (this.column1Width ?? Math.round(stageRect.width / 2)) : (this.column0Width ?? Math.round(stageRect.width));
            return {
              lineTop,
              lineBottom,
              height: isBottomCover ? 2 : Math.max(1, lineBottom - lineTop),
              targetY: isBottomCover ? coverTargetY : lineTop,
              left: Math.round(left),
              width: Math.round(width)
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Spočítá výchozí geometrii pro cílový řádek při přechodu na novou stranu před tím,
   * než je nová strana vykreslena (synchronní neutralizace probliknutí čistého textu).
   */
  getDefaultStartingLineGeometry(direction = 1) {
    const isVertical = this.isVerticalMode();
    const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
    const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    const isBottomCover = this.style === "bottom-cover" || this.mode === "bottom-cover";
    const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);
    const padding = this.rulerPadding || 6;
    const isForward = direction >= 0;

    if (!this.isPdfMode && !isVertical && isForward) {
      const canonGeom = this.getCanonicalTopLineGeometry(0);
      if (canonGeom) {
        return canonGeom;
      }
    }

    let lineTop, lineBottom, left, width;

    if (this.isPdfMode) {
      const canvas = document.querySelector("#reader-content canvas");
      const cRect = canvas ? canvas.getBoundingClientRect() : (this._cachedCanvasRect || stageRect);
      const topBound = cRect ? cRect.top : stageRect.top;
      const bottomBound = cRect ? cRect.bottom : stageRect.bottom;
      lineTop = isForward ? Math.round(topBound) : Math.max(Math.round(topBound), Math.round(bottomBound - h));
      lineBottom = Math.round(lineTop + h);
      left = cRect ? Math.round(cRect.left) : Math.round(stageRect.left);
      width = cRect ? Math.round(cRect.width) : Math.round(stageRect.width);
    } else {
      const topBound = Math.round(stageRect.top + padding);
      const bottomBound = Math.round(stageRect.bottom - padding);
      lineTop = isForward ? topBound : Math.max(topBound, Math.round(bottomBound - h));
      lineBottom = Math.round(lineTop + h);

      if (this.isTwoCol && !isVertical) {
        const colIdx = isForward ? 0 : 1;
        left = colIdx === 1 ? (this.column1Left ?? Math.round(stageRect.left + stageRect.width / 2)) : (this.column0Left ?? Math.round(stageRect.left));
        width = colIdx === 1 ? (this.column1Width ?? Math.round(stageRect.width / 2)) : (this.column0Width ?? Math.round(stageRect.width / 2));
      } else {
        left = this.column0Left ?? Math.round(stageRect.left);
        width = this.column0Width ?? Math.round(stageRect.width);
      }
    }

    return {
      lineTop,
      lineBottom,
      height: isBottomCover ? 2 : Math.max(1, lineBottom - lineTop),
      targetY: isBottomCover ? lineBottom : lineTop,
      left: Math.round(left),
      width: Math.round(width)
    };
  }

  /**
   * Synchronně usadí masky zaostření (Focus Mode) na cílovou výchozí pozici nové strany.
   * Zajišťuje nepřetržité pokrytí obrazovky – uživatel nespatří nezakrytý text ani na jediný snímek.
   */
  prepareFocusMasksForTransition(direction = 1) {
    if (!this.enabled || !this.focusMode || this.focusMode === "off") return;

    this.isPageTransitioning = true;
    const isForward = direction >= 0;
    const isVertical = this.isVerticalMode();
    const vh = window.innerHeight;
    const dimOpacity = this.dimOpacity !== undefined ? this.dimOpacity : 0.65;
    const themeBg = "var(--bg-theme, var(--color-bg, #fbf0d9))";

    // 1. Zjištění geometrie výchozího řádku
    let lineTop, lineBottom, colLeft, colWidth;
    let canonGeom = null;
    if (isForward && !this.isPdfMode && !isVertical) {
      canonGeom = this.getCanonicalTopLineGeometry(0);
    }
    if (canonGeom) {
      lineTop = canonGeom.lineTop;
      lineBottom = canonGeom.lineBottom;
      colLeft = canonGeom.left;
      colWidth = canonGeom.width;
    } else if (this.cachedLines && this.cachedLines.length > 0) {
      const line = isForward ? this.cachedLines[0] : this.cachedLines[this.cachedLines.length - 1];
      const geom = this.computeLineGeometry(isForward ? 0 : this.cachedLines.length - 1);
      lineTop = (geom && Number.isFinite(geom.lineTop)) ? geom.lineTop : (line.lineTop ?? line.top);
      lineBottom = (geom && Number.isFinite(geom.lineBottom)) ? geom.lineBottom : (line.lineBottom ?? line.bottom);
      colLeft = (geom && Number.isFinite(geom.left)) ? geom.left : (line.columnLeft ?? line.left ?? this.column0Left);
      colWidth = (geom && Number.isFinite(geom.width)) ? geom.width : (line.columnWidth ?? line.width ?? this.column0Width);
    } else {
      const defGeom = this.getDefaultStartingLineGeometry(direction);
      lineTop = defGeom.lineTop;
      lineBottom = defGeom.lineBottom;
      colLeft = defGeom.left;
      colWidth = defGeom.width;
    }

    const vp = isVertical ? (this._cachedViewportEl || document.getElementById("paged-viewport")) : null;
    const vScrollTop = (isVertical && vp) ? vp.scrollTop : 0;
    const lineScreenTop = isVertical ? Math.round(lineTop - vScrollTop) : Math.round(lineTop);
    const lineScreenBottom = isVertical ? Math.round(lineBottom - vScrollTop) : Math.round(lineBottom);
    const lineH = Math.max(1, lineScreenBottom - lineScreenTop);

    // Kontrola dvoustrany / dvou sloupců
    const isSpread = !isVertical && this.isSpreadActive();
    const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;
    const isTwoCol = !isVertical && this.isTwoCol;

    let coverLeft = 0;
    let coverWidth = window.innerWidth;
    if (spreadInfo) {
      coverLeft = Math.round(spreadInfo.activeRect.left);
      coverWidth = Math.round(spreadInfo.activeRect.width);
    } else if (isTwoCol) {
      const activeCol = isForward ? 0 : 1;
      const c0Left = this.column0Left ?? 0;
      const c0Width = this.column0Width ?? Math.round(window.innerWidth / 2);
      const c1Left = this.column1Left ?? Math.round(c0Left + c0Width);
      const c1Width = this.column1Width ?? c0Width;
      coverLeft = activeCol === 1 ? c1Left : c0Left;
      coverWidth = activeCol === 1 ? c1Width : c0Width;
    }

    const useFullWidth = isVertical || (!spreadInfo && !isTwoCol && !this.isPdfMode);
    const maskLeft = useFullWidth ? 0 : coverLeft;
    const maskWidth = useFullWidth ? "100%" : `${coverWidth}px`;

    this.ensureOverlayContainer();

    // 1. Horní maska: pro "up" a "both"
    if (this.focusMode === "up" || this.focusMode === "both") {
      if (this.maskTopEl) {
        this.maskTopEl.className = "ruler-mask ruler-mask-top is-visible";
        this.maskTopEl.style.setProperty("display", "block", "important");
        this.maskTopEl.style.setProperty("visibility", "visible", "important");
        this.maskTopEl.style.setProperty("transition", "none", "important");
        this.maskTopEl.style.setProperty("background-color", themeBg, "important");
        this.maskTopEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskTopEl.style.setProperty("z-index", "15", "important");
        this.maskTopEl.style.setProperty("pointer-events", "none", "important");
        this.maskTopEl.style.top = "0px";
        this.maskTopEl.style.left = "0px";
        this.maskTopEl.style.width = maskWidth;
        this.maskTopEl.style.height = `${vh}px`;
        this.maskTopEl.style.transform = `translate3d(${maskLeft}px, ${Math.round(lineScreenTop - vh)}px, 0)`;
      }
    } else if (this.maskTopEl) {
      this.maskTopEl.style.display = "none";
      this.maskTopEl.classList.remove("is-visible");
      this.maskTopEl.classList.add("is-hidden");
    }

    // 2. Dolní maska: pro "down" a "both"
    if (this.focusMode === "down" || this.focusMode === "both") {
      if (this.maskBottomEl) {
        this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-visible";
        this.maskBottomEl.style.setProperty("display", "block", "important");
        this.maskBottomEl.style.setProperty("visibility", "visible", "important");
        this.maskBottomEl.style.setProperty("transition", "none", "important");
        this.maskBottomEl.style.setProperty("background-color", themeBg, "important");
        this.maskBottomEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskBottomEl.style.setProperty("z-index", "15", "important");
        this.maskBottomEl.style.setProperty("pointer-events", "none", "important");
        this.maskBottomEl.style.top = "0px";
        this.maskBottomEl.style.left = "0px";
        this.maskBottomEl.style.width = maskWidth;
        this.maskBottomEl.style.height = `${Math.max(vh * 2, 2000)}px`;
        this.maskBottomEl.style.transform = `translate3d(${maskLeft}px, ${lineScreenBottom}px, 0)`;
      }
    } else if (this.maskBottomEl) {
      this.maskBottomEl.style.display = "none";
      this.maskBottomEl.classList.remove("is-visible");
      this.maskBottomEl.classList.add("is-hidden");
    }

    // 3. Postranní masky: pro režim "both"
    const needSideMasks = this.focusMode === "both" && (isTwoCol || this.isPdfMode);
    if (needSideMasks) {
      const slitLeft = Math.max(0, Math.round(colLeft));
      const slitRight = Math.min(window.innerWidth, Math.round(colLeft + colWidth));
      if (this.maskLeftEl) {
        this.maskLeftEl.className = "ruler-mask ruler-mask-left is-visible";
        this.maskLeftEl.style.setProperty("display", "block", "important");
        this.maskLeftEl.style.setProperty("visibility", "visible", "important");
        this.maskLeftEl.style.setProperty("transition", "none", "important");
        this.maskLeftEl.style.setProperty("background-color", themeBg, "important");
        this.maskLeftEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskLeftEl.style.setProperty("z-index", "15", "important");
        this.maskLeftEl.style.top = "0px";
        this.maskLeftEl.style.left = "0px";
        this.maskLeftEl.style.width = `${slitLeft}px`;
        this.maskLeftEl.style.height = `${lineH}px`;
        this.maskLeftEl.style.transform = `translate3d(0, ${lineScreenTop}px, 0)`;
      }
      if (this.maskRightEl) {
        const rightWidth = Math.max(0, window.innerWidth - slitRight);
        this.maskRightEl.className = "ruler-mask ruler-mask-right is-visible";
        this.maskRightEl.style.setProperty("display", "block", "important");
        this.maskRightEl.style.setProperty("visibility", "visible", "important");
        this.maskRightEl.style.setProperty("transition", "none", "important");
        this.maskRightEl.style.setProperty("background-color", themeBg, "important");
        this.maskRightEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskRightEl.style.setProperty("z-index", "15", "important");
        this.maskRightEl.style.top = "0px";
        this.maskRightEl.style.left = "0px";
        this.maskRightEl.style.width = `${rightWidth}px`;
        this.maskRightEl.style.height = `${lineH}px`;
        this.maskRightEl.style.transform = `translate3d(${slitRight}px, ${lineScreenTop}px, 0)`;
      }
    } else {
      if (this.maskLeftEl) { this.maskLeftEl.style.display = "none"; this.maskLeftEl.classList.remove("is-visible"); this.maskLeftEl.classList.add("is-hidden"); }
      if (this.maskRightEl) { this.maskRightEl.style.display = "none"; this.maskRightEl.classList.remove("is-visible"); this.maskRightEl.classList.add("is-hidden"); }
    }

    // 4. Maska protilehlé neaktivní strany v režimu dvoustrany
    if (spreadInfo || isTwoCol) {
      const activeCol = isForward ? 0 : 1;
      const inactiveRect = spreadInfo ? spreadInfo.inactiveRect : {
        left: activeCol === 0 ? this.column1Left : this.column0Left,
        top: 0,
        width: activeCol === 0 ? this.column1Width : this.column0Width,
        height: vh
      };
      if (inactiveRect && inactiveRect.width > 50 && this.maskInactiveSpreadEl) {
        this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom ruler-mask-inactive-spread is-visible";
        this.maskInactiveSpreadEl.style.setProperty("display", "block", "important");
        this.maskInactiveSpreadEl.style.setProperty("visibility", "visible", "important");
        this.maskInactiveSpreadEl.style.setProperty("transition", "none", "important");
        this.maskInactiveSpreadEl.style.setProperty("background-color", themeBg, "important");
        this.maskInactiveSpreadEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskInactiveSpreadEl.style.setProperty("z-index", "15", "important");
        this.maskInactiveSpreadEl.style.top = `${Math.round(inactiveRect.top)}px`;
        this.maskInactiveSpreadEl.style.left = `${Math.round(inactiveRect.left)}px`;
        this.maskInactiveSpreadEl.style.width = `${Math.round(inactiveRect.width)}px`;
        this.maskInactiveSpreadEl.style.height = `${Math.round(inactiveRect.height)}px`;
        this.maskInactiveSpreadEl.style.transform = "none";
      }
    } else if (this.maskInactiveSpreadEl) {
      this.maskInactiveSpreadEl.style.display = "none";
      this.maskInactiveSpreadEl.classList.remove("is-visible");
      this.maskInactiveSpreadEl.classList.add("is-hidden");
    }
  }

  /**
   * Zjistí, zda je element interaktivním prvkem UI (tlačítko, formulář, dialog apod.),
   * aby Apple Pencil mohl stále ovládat tlačítka v lištách či vypnout pravítko.
   */
  isUiControl(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      "header, nav, .modal, .modal-content, .settings-modal, .stats-modal, .dropdown, button, input, select, textarea, a, [role='button'], [role='dialog'], [role='slider'], .btn, .btn-icon, .drawer-panel, .drawer, .drawer-backdrop, .modal-dialog, .modal-overlay, .paged-footer-bar, .reading-scrubber, .reader-header, .top-navbar, .ruler-btn-group, #ruler-toggle-btn, #ruler-split-pill, .ruler-split-pill, .split-pill-btn, #btn-toggle-ruler, #btn-ruler-quick-menu, .ruler-quick-popover, .ruler-floating-controls, #btn-reader-menu-fab, #reader-floating-dock, .reader-floating-dock, .dock-action-row, .dock-action-btn, #footer-remaining-chapter, #footer-book-pages, .footer-actions-group"
    );
  }

  /**
   * Zjistí, zda je otevřen rychlý popover pravítka, zásuvka nastavení nebo jiný overlay panel,
   * při kterém musí být pointer tracking a word proximity výpočty okamžitě pozastaveny.
   */
  isPopoverOrDrawerOpen() {
    if (typeof this.isAnyDrawerOpen === "function" && this.isAnyDrawerOpen()) {
      return true;
    }
    const popover = document.getElementById("ruler-quick-popover");
    if (popover && !popover.classList.contains("is-hidden")) return true;
    const settingsDrawer = document.getElementById("settings-drawer");
    if (settingsDrawer && settingsDrawer.classList.contains("open")) return true;
    const tocDrawer = document.getElementById("toc-drawer");
    if (tocDrawer && tocDrawer.classList.contains("open")) return true;
    const searchDrawer = document.getElementById("search-drawer");
    if (searchDrawer && searchDrawer.classList.contains("open")) return true;
    const statsModal = document.getElementById("stats-modal");
    if (statsModal && statsModal.classList.contains("open")) return true;
    return false;
  }

  /**
   * Zjistí, zda se souřadnice ukazatele nacházejí uvnitř čtecí plochy knihy,
   * aby kurzor v záhlaví či okrajích nestrhával pravítko na začátek textu.
   */
  isPointerInStage(clientX, clientY) {
    if (clientX == null || clientY == null) return false;
    let rect = this._cachedViewportRect;
    if (!rect || rect.width <= 50 || rect.height <= 50) {
      const stage = document.getElementById("paged-viewport") || this.container || document.getElementById("paged-stage");
      if (!stage) return false;
      rect = stage.getBoundingClientRect();
      this._cachedViewportRect = rect;
    }
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  /**
   * Zjistí, zda se souřadnice myši nacházejí uvnitř kombinované čtecí zóny
   * (od levého okraje 1. sloupce po pravý okraj 2. sloupce, včetně celé mezery mezi sloupci).
   */
  isPointerInReadingZone(clientX, clientY) {
    if (clientX == null || clientY == null) return false;
    if (
      this.readingLeft == null ||
      this.readingRight == null ||
      this.readingTop == null ||
      this.readingBottom == null ||
      !Number.isFinite(this.readingLeft) ||
      !Number.isFinite(this.readingRight)
    ) {
      this.updateReadingZoneBounds();
    }
    if (
      this.readingLeft == null ||
      this.readingRight == null ||
      this.readingTop == null ||
      this.readingBottom == null
    ) {
      return false;
    }
    return (
      clientX >= this.readingLeft &&
      clientX <= this.readingRight &&
      clientY >= this.readingTop &&
      clientY <= this.readingBottom
    );
  }

  /**
   * Řídí viditelnost systémového kurzoru myši podle geometrie čtecí zóny.
   * Aplikuje se VÝHRADNĚ pro myš (pointerType === 'mouse').
   * Stylus (Apple Pencil) i dotyková gesta zůstávají 100% nedotčena.
   */
  updateCursorVisibility(clientX, clientY, pointerType = "mouse", target = null) {
    if (pointerType !== "mouse") {
      this.setCursorHidden(false);
      return;
    }

    if (!this.enabled || this.followMode !== "mouse") {
      this.setCursorHidden(false);
      return;
    }

    if (this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || this.isLineLocked || Date.now() < this.navigatingPageLockoutEndTime) {
      this.setCursorHidden(false);
      return;
    }

    if (clientX == null || clientY == null) {
      this.setCursorHidden(false);
      return;
    }

    // Interaktivní prvky UI (tlačítka, navigační lišty, panely, popovery) mají vždy viditelný kurzor
    if (target && this.isUiControl(target)) {
      this.setCursorHidden(false);
      return;
    }

    const inZone = this.isPointerInReadingZone(clientX, clientY);
    this.setCursorHidden(inZone);
  }

  /**
   * Přepíná CSS třídu pro skrytí kurzoru myši.
   */
  setCursorHidden(hidden) {
    const shouldHide = !!hidden;
    if (this._isCursorHidden === shouldHide) return;
    this._isCursorHidden = shouldHide;

    document.body.classList.toggle("ruler-cursor-hidden", shouldHide);
    const viewport = document.getElementById("paged-viewport");
    if (viewport) {
      viewport.classList.toggle("ruler-cursor-hidden", shouldHide);
    }
  }

  /**
   * Bezpečný přepočet geometrických hranic čtecí zóny (fallback).
   */
  updateReadingZoneBounds() {
    if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
      this.updatePdfReadingZoneBounds();
      return;
    }

    const isVertical = this.isVerticalMode();
    const isSpread = !isVertical && this.isSpreadActive();
    const isTwoCol = !isVertical && (this.isTwoCol || isSpread);
    const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;

    if (this.column0Left != null && this.column0Right != null) {
      if (isTwoCol && this.column1Left != null && this.column1Right != null) {
        this.readingLeft = Math.min(this.column0Left, this.column1Left);
        this.readingRight = Math.max(this.column0Right, this.column1Right);
      } else {
        this.readingLeft = this.column0Left;
        this.readingRight = this.column0Right;
      }
    }

    const stage = document.getElementById("paged-stage") || document.getElementById("paged-viewport") || this.container || document.body;
    const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const textContainer = document.getElementById("reader-content") || stage;
    const tcRect = textContainer ? textContainer.getBoundingClientRect() : stageRect;

    if (isSpread && spreadInfo) {
      this.readingTop = Math.round(Math.min(spreadInfo.leftRect.top, spreadInfo.rightRect.top));
      this.readingBottom = Math.round(Math.max(spreadInfo.leftRect.bottom, spreadInfo.rightRect.bottom));
      if (this.readingLeft == null || this.readingRight == null) {
        this.readingLeft = Math.round(Math.min(spreadInfo.leftRect.left, spreadInfo.rightRect.left));
        this.readingRight = Math.round(Math.max(spreadInfo.leftRect.right, spreadInfo.rightRect.right));
      }
    } else if (this.isPdfMode) {
      const canvas = document.querySelector("#reader-content canvas");
      const cRect = canvas ? canvas.getBoundingClientRect() : null;
      if (cRect && cRect.height > 50) {
        this.readingTop = Math.round(cRect.top);
        this.readingBottom = Math.round(cRect.bottom);
        if (this.readingLeft == null || this.readingRight == null) {
          this.readingLeft = Math.round(cRect.left);
          this.readingRight = Math.round(cRect.right);
        }
      } else {
        this.readingTop = Math.round((tcRect && tcRect.height > 50) ? tcRect.top : stageRect.top);
        this.readingBottom = Math.round((tcRect && tcRect.height > 50) ? tcRect.bottom : stageRect.bottom);
      }
    } else {
      this.readingTop = Math.round((tcRect && tcRect.height > 50) ? tcRect.top : stageRect.top);
      this.readingBottom = Math.round((tcRect && tcRect.height > 50) ? tcRect.bottom : stageRect.bottom);
      if (this.readingLeft == null || this.readingRight == null) {
        this.readingLeft = Math.round((tcRect && tcRect.width > 50) ? tcRect.left : stageRect.left);
        this.readingRight = Math.round((tcRect && tcRect.width > 50) ? tcRect.right : stageRect.right);
      }
    }
  }

  /**
   * Spočítá hranice aktivní čtecí zóny pro PDF režim (jedna strana i dvoustrana).
   */
  updatePdfReadingZoneBounds(stageRect = null, isSpread = null, spreadInfo = null) {
    const isSpreadMode = isSpread !== null ? isSpread : (!this.isVerticalMode() && this.isSpreadActive());
    const spread = spreadInfo || (isSpreadMode ? this.getActiveSpreadInfo(null) : null);
    const stage = stageRect || (this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.() || { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };

    if (isSpreadMode && spread) {
      const col0Left = Math.round(spread.leftRect.left);
      const col0Right = Math.round(spread.leftRect.right);
      const col1Left = Math.round(spread.rightRect.left);
      const col1Right = Math.round(spread.rightRect.right);
      this.column0Left = col0Left;
      this.column0Right = col0Right;
      this.column1Left = col1Left;
      this.column1Right = col1Right;
      this.readingLeft = Math.min(col0Left, col1Left);
      this.readingRight = Math.max(col0Right, col1Right);
      this.readingTop = Math.round(Math.min(spread.leftRect.top, spread.rightRect.top));
      this.readingBottom = Math.round(Math.max(spread.leftRect.bottom, spread.rightRect.bottom));
      return;
    }

    const spreadContainer = document.querySelector("#reader-content .pdf-spread-container");
    if (spreadContainer) {
      const sRect = spreadContainer.getBoundingClientRect();
      if (sRect.width > 50 && sRect.height > 50) {
        this.readingLeft = Math.round(sRect.left);
        this.readingRight = Math.round(sRect.right);
        this.readingTop = Math.round(sRect.top);
        this.readingBottom = Math.round(sRect.bottom);
        this.column0Left = this.readingLeft;
        this.column0Right = this.readingRight;
        return;
      }
    }

    const canvas = document.querySelector("#reader-content canvas");
    if (canvas) {
      const cRect = canvas.getBoundingClientRect();
      if (cRect.width > 50 && cRect.height > 50) {
        this.readingLeft = Math.round(cRect.left);
        this.readingRight = Math.round(cRect.right);
        this.readingTop = Math.round(cRect.top);
        this.readingBottom = Math.round(cRect.bottom);
        this.column0Left = this.readingLeft;
        this.column0Right = this.readingRight;
        return;
      }
    }

    const pdfContainer = document.querySelector("#reader-content .pdf-page-container, #reader-content .pdf-page-slot");
    if (pdfContainer) {
      const pRect = pdfContainer.getBoundingClientRect();
      if (pRect.width > 50 && pRect.height > 50) {
        this.readingLeft = Math.round(pRect.left);
        this.readingRight = Math.round(pRect.right);
        this.readingTop = Math.round(pRect.top);
        this.readingBottom = Math.round(pRect.bottom);
        this.column0Left = this.readingLeft;
        this.column0Right = this.readingRight;
        return;
      }
    }

    this.readingLeft = Math.round(stage.left);
    this.readingRight = Math.round(stage.right);
    this.readingTop = Math.round(stage.top);
    this.readingBottom = Math.round(stage.bottom);
    this.column0Left = this.readingLeft;
    this.column0Right = this.readingRight;
  }

  /**
   * Zjistí, zda právě probíhá aktivní tažení / interakce s pravítkem,
   * nebo zda ještě trvá bezpečnostní cooldown po zvednutí ukazatele (zamezení kolizím s tap/click).
   */
  isInteracting() {
    if (!this.enabled) return false;
    if (this.isDraggingRuler || this.isPenTouching) return true;
    if (this.isHoldTriggered || this.wasHoldAborted) return true;
    if (Date.now() < this.dragCooldownEndTime) return true;
    return false;
  }

  /**
   * Detekuje, zda událost pochází z Apple Pencil (Stylus)
   */
  isPenEvent(e) {
    if (!e) return false;
    if (e.pointerType === "pen") return true;
    if (e.touches && e.touches.length > 0 && Array.from(e.touches).some(t => t.touchType === "stylus")) return true;
    if (e.changedTouches && e.changedTouches.length > 0 && Array.from(e.changedTouches).some(t => t.touchType === "stylus")) return true;
    if (Date.now() - this.lastPenTime < 500) return true;
    return false;
  }

  savePenDetails(e) {
    this.lastPenDetails = {
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      pressure: e.pressure ?? 0,
      twist: e.twist ?? 0,
      altitudeAngle: e.altitudeAngle ?? 0,
      azimuthAngle: e.azimuthAngle ?? 0
    };
  }

  /**
   * Nastaví povolení/zakázání švihnutí Apple Pencil pro listování stránek.
   */
  setPenFlickEnabled(enabled) {
    this.penFlickEnabled = !!enabled;
  }

  /**
   * Okamžitě resynchronizuje pravítko na první (horní) řádek stránky.
   */
  resyncToTopLine() {
    this.resetPositionForPage(1);
  }

  /**
   * Detekuje rychlé švihnutí stylusu (Apple Pencil Flick Gesture) nebo přejetí prstem (Touch Swipe).
   * 
   * Rozlišuje typ ukazatele (Pointer Types):
   * 1. Apple Pencil (pointerType === 'pen'):
   *    - Vyhodnocuje se při uvolnění hrotu z displeje (pointerup).
   *    - Časové okno: celková doba tahu od pointerdown do 320 ms.
   *    - Minimální vzdálenost: celkový horizontální posun |ΔX| >= 45 px.
   *    - Minimální rychlost: |ΔX| / Δt >= 0.6 px/ms.
   *    - Vertikální tolerance: maximální vertikální odchylka |ΔY| nesmí překročit 45 px.
   * 2. Přejetí prstem (pointerType === 'touch'):
   *    - Uvolněné ergonomické prahy odpovídající Apple Books:
   *    - Minimální vzdálenost: |ΔX| >= 30 px (krátké, uvolněné tahy palcem/prstem).
   *    - Práh rychlosti: |ΔX| / Δt >= 0.3 px/ms (pomalé, ležérní tahy bez nutnosti rychlého švihu).
   *    - Maximální doba trvání: Δt <= 450 ms (dostatečný prostor pro přirozený oblouk).
   *    - Tolerance vertikálního driftu: |ΔY| <= 65 px (přirozený rotační oblouk palce).
   */
  detectPenFlick(clientX, clientY, now, pointerType = "pen") {
    const isTouch = pointerType === "touch";
    const isPen = pointerType === "pen";

    if (isPen && !this.penFlickEnabled) return null;
    if (this.flickHandledInStroke) return null;

    // Cooldown proti vícenásobnému přeskakování stránek (400–500 ms)
    if (Date.now() - this.lastFlickNavigationTime < this.flickNavigationCooldown) {
      return null;
    }

    const history = (isTouch ? this.touchHistory : this.penHistory) || this.penHistory;
    const rawStartTime = isTouch ? this.touchStrokeStartTime : this.penStrokeStartTime;
    const rawStartX = isTouch ? this.touchStrokeStartX : this.penStrokeStartX;
    const rawStartY = isTouch ? this.touchStrokeStartY : this.penStrokeStartY;

    const strokeStartTime = (rawStartTime && rawStartTime > 0) ? rawStartTime : (history && history[0] ? history[0].time : now);
    const strokeStartX = (rawStartX != null && rawStartX > 0) ? rawStartX : (history && history[0] ? history[0].x : clientX);
    const strokeStartY = (rawStartY != null && rawStartY > 0) ? rawStartY : (history && history[0] ? history[0].y : clientY);

    // Gesto musí probíhat uvnitř čtecí oblasti knihy (buď výchozí nebo koncový bod)
    if (!this.isPointerInStage(clientX, clientY) && !this.isPointerInStage(strokeStartX, strokeStartY)) {
      return null;
    }

    const readerView = document.getElementById("view-reader");
    if (readerView && readerView.classList.contains("is-hidden")) {
      return null;
    }

    if (!history || (isTouch ? history.length === 0 : history.length < 2)) return null;

    // ==========================================
    // 1. RELAXED FINGER SWIPE (pointerType === 'touch')
    // ==========================================
    if (isTouch) {
      const strokeDuration = now - (strokeStartTime || now);
      if (strokeDuration > 450) {
        return null;
      }

      // Tolerance vertikálního driftu: |ΔY| <= 65 px (akomoduje přirozený oblouk palce)
      let strokeMinY = Math.min(strokeStartY, clientY);
      let strokeMaxY = Math.max(strokeStartY, clientY);
      for (let k = 0; k < history.length; k++) {
        const py = history[k].y;
        if (py < strokeMinY) strokeMinY = py;
        if (py > strokeMaxY) strokeMaxY = py;
      }
      if ((strokeMaxY - strokeMinY) > 65) {
        return null;
      }

      const startPoint = {
        x: strokeStartX,
        y: strokeStartY,
        time: strokeStartTime
      };
      const candidates = [startPoint, ...history];

      for (let i = 0; i < candidates.length; i++) {
        const p0 = candidates[i];
        const deltaT = now - p0.time;
        if (deltaT < 15 || deltaT > 450) continue;

        const deltaX = clientX - p0.x;
        const deltaY = clientY - p0.y;
        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);

        // Minimální vzdálenost: |ΔX| >= 30 px
        if (absDeltaX < 30) continue;

        // Tolerance vertikálního driftu: |ΔY| <= 65 px
        if (absDeltaY > 65) continue;

        // Práh rychlosti: |ΔX| / Δt >= 0.3 px/ms
        const velocity = absDeltaX / deltaT;
        if (velocity < 0.3) continue;

        // Výchozí nebo koncový bod gesta musel ležet v čtecí oblasti
        if (!this.isPointerInStage(p0.x, p0.y) && !this.isPointerInStage(clientX, clientY)) continue;

        const direction = deltaX < 0 ? 1 : -1;
        return {
          pointerType: "touch",
          direction,
          deltaX,
          deltaY,
          deltaT,
          velocity
        };
      }

      return null;
    }

    // ==========================================
    // 2. DEDICATED APPLE PENCIL FLICK (pointerType === 'pen')
    // ==========================================
    // 1. Časové okno (Time window): celková doba tahu od pointerdown do pointerup do 320 ms
    const strokeDuration = now - (strokeStartTime || now);
    if (strokeDuration <= 0 || strokeDuration > 320) {
      return null;
    }

    // 2. Vertikální tolerance: nesmí překročit 45 px
    let strokeMinY = Math.min(strokeStartY ?? clientY, clientY);
    let strokeMaxY = Math.max(strokeStartY ?? clientY, clientY);
    for (let k = 0; k < history.length; k++) {
      const py = history[k].y;
      if (py < strokeMinY) strokeMinY = py;
      if (py > strokeMaxY) strokeMaxY = py;
    }
    if ((strokeMaxY - strokeMinY) > 45) {
      return null;
    }

    // 3. Kinematika tahu pera:
    // - Minimální vzdálenost: |ΔX| >= 45 px
    // - Minimální rychlost: |ΔX| / Δt >= 0.6 px/ms
    // - Vertikální odchylka koncového bodu: |ΔY| <= 45 px
    const startPoint = {
      x: strokeStartX ?? history[0].x,
      y: strokeStartY ?? history[0].y,
      time: strokeStartTime || history[0].time
    };
    const candidates = [startPoint, ...history];

    for (let i = 0; i < candidates.length; i++) {
      const p0 = candidates[i];
      const deltaT = now - p0.time;
      if (deltaT < 20 || deltaT > 320) continue;

      const deltaX = clientX - p0.x;
      const deltaY = clientY - p0.y;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      if (absDeltaX < 45) continue;
      if (absDeltaY > 45) continue;

      const velocity = absDeltaX / deltaT;
      if (velocity < 0.6) continue;

      let segMinY = Math.min(p0.y, clientY);
      let segMaxY = Math.max(p0.y, clientY);
      for (let j = i; j < candidates.length; j++) {
        const py = candidates[j].y;
        if (py < segMinY) segMinY = py;
        if (py > segMaxY) segMaxY = py;
      }
      if ((segMaxY - segMinY) > 45) continue;

      if (!this.isPointerInStage(p0.x, p0.y)) continue;

      const direction = deltaX < 0 ? 1 : -1;
      return {
        pointerType: "pen",
        direction,
        deltaX,
        deltaY,
        deltaT,
        velocity
      };
    }

    return null;
  }

  /**
   * Spustí navigační akci po detekci švihnutí pera nebo přejetí prstem
   */
  triggerPenFlick(flick) {
    this.flickHandledInStroke = true;
    this.lastFlickNavigationTime = Date.now();
    this.lastSwipeTime = Date.now();
    this.flickResyncTopLine = true;

    // 1. Zrušit plánované přemístění pravítka a držení, aby nedošlo k vizuálnímu poskočení nebo posunutí pravítka
    if (this.pointerRafId) {
      cancelAnimationFrame(this.pointerRafId);
      this.pointerRafId = null;
    }
    this.rafPointerPending = false;
    this.cancelHold(false);
    this.isHoldTriggered = false;
    this.isDraggingRuler = false;
    this.isLineLocked = true;
    this.suppressLineAdvancement = true;
    this.lockAdvancement(400);

    // 2. Předat událost do aplikace pro otočení stránky
    if (typeof this.onSwipe === "function") {
      this.onSwipe(flick.direction);
    } else if (typeof this.onPenFlick === "function") {
      this.onPenFlick(flick.direction);
    }
  }

  /**
   * Plynulá aktualizace pozice pravítka synchronizovaná s obnovovací frekvencí displeje (120Hz ProMotion)
   */
  schedulePointerUpdate(clientX, clientY, pointerType = "mouse") {
    if (this.isPopoverOrDrawerOpen()) {
      this._trackingSuspendedByOverlay = true;
      if (this.pointerRafId) {
        cancelAnimationFrame(this.pointerRafId);
        this.pointerRafId = null;
        this.rafPointerPending = false;
      }
      return;
    }
    if (this._trackingSuspendedByOverlay) {
      return;
    }

    const isDocTurning = document.body.classList.contains("is-turning-page") ||
      document.body.classList.contains("is-chapter-loading") ||
      !!(this.app?.isNavigating) ||
      (Date.now() < this.navigatingPageLockoutEndTime);
    if (!isDocTurning && (pointerType === "mouse" || this.followMode === "mouse")) {
      this.isLineLocked = false;
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isPageTransitioning = false;
      this.suppressLineAdvancement = false;
    }

    if (this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime || this.isPageTransitioning) {
      return;
    }
    this.pendingPointerX = clientX;
    this.pendingPointerY = clientY;
    this.pendingPointerType = pointerType;
    this.activePointerType = pointerType;

    // Gating v rAF: pokud je přepočet na další snímek již naplánován, ignorovat mezilehlé události
    if (this.rafPointerPending) {
      return;
    }

    this.rafPointerPending = true;
    this.pointerRafId = requestAnimationFrame(() => {
      this.rafPointerPending = false;
      this.pointerRafId = null;
      if (!this.enabled || this.isPopoverOrDrawerOpen() || this._trackingSuspendedByOverlay) {
        return;
      }
      const turning = document.body.classList.contains("is-turning-page") ||
        document.body.classList.contains("is-chapter-loading") ||
        !!(this.app?.isNavigating) ||
        (Date.now() < this.navigatingPageLockoutEndTime);
      if (!turning && (this.pendingPointerType === "mouse" || this.followMode === "mouse")) {
        this.isLineLocked = false;
        this.isPageTransitioning = false;
      }
      if (!this.isLineLocked && !this.isPageTransitioning) {
        this.handlePointerMove(this.pendingPointerX, this.pendingPointerY, this.pendingPointerType);
      }
    });
  }

  isAlreadyAtPosition(clientX, clientY) {
    if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) return false;
    if (this.wordTracking && this.cachedWords.length > 0 && this.activeWordIndex >= 0) {
      const activeLine = (this.cachedLines && this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
        ? this.cachedLines[this.activeLineIndex]
        : null;
      if (activeLine && (clientY < activeLine.top - 8 || clientY > activeLine.bottom + 8)) {
        return false;
      }
      const effectiveY = clientY - 8;
      let minDiff = Infinity;
      let closestIdx = -1;
      for (let i = 0; i < this.cachedWords.length; i++) {
        const w = this.cachedWords[i];
        const dy = effectiveY < w.top ? w.top - effectiveY : effectiveY > w.bottom ? effectiveY - w.bottom : 0;
        const dx = clientX < w.left ? w.left - clientX : clientX > w.right ? clientX - w.right : 0;
        const dist = dy * 2.8 + dx;
        if (dist < minDiff) {
          minDiff = dist;
          closestIdx = i;
        }
      }
      return closestIdx === this.activeWordIndex;
    } else if (this.snapToLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
      let minDiff = Infinity;
      let closestIdx = -1;
      for (let i = 0; i < this.cachedLines.length; i++) {
        const diff = Math.abs(clientY - this.cachedLines[i].centerY);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      return closestIdx === this.activeLineIndex;
    }
    return false;
  }

  startHold(clientX, clientY, pointerType = "touch") {
    if (!this.enabled || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
    if (!this.isPointerInStage(clientX, clientY)) return;
    if (this.followMode === "mouse" || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) return;

    this.cancelHold(false);

    this.holdStartX = clientX;
    this.holdStartY = clientY;
    this.holdStartTime = Date.now();
    this.holdPointerType = pointerType;
    this.isHoldActive = true;
    this.isHoldTriggered = false;
    this.wasHoldAborted = false;

    document.body.classList.add("ruler-holding");
    if (window.getSelection) {
      const sel = window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }

    this.holdTimer = setTimeout(() => {
      this.triggerHoldSuccess(this.holdStartX, this.holdStartY);
    }, 500);
  }

  triggerHoldSuccess(x, y) {
    this.clearHoldTimer();
    this.isHoldActive = false;
    this.isHoldTriggered = true;
    this.wasHoldAborted = false;
    this.dragCooldownEndTime = Date.now() + 650; // Bezpečnostní okno blokující následný syntetický klik

    document.body.classList.remove("ruler-holding");
    if (window.getSelection) {
      const sel = window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }

    if (navigator.vibrate) {
      try {
        navigator.vibrate(25);
      } catch (err) {}
    }

    if (this.isVerticalMode() && this.followMode === "keyboard") {
      this.reanchorAt(x, y);
      return;
    }

    this.handlePointerMove(x, y);
  }

  initDefaultStationaryAnchor() {
    if (!this.enabled || !this.isVerticalMode() || this.followMode !== "keyboard") return;
    if (this.cachedLines.length === 0) {
      this.detectLines();
    }
    if (this.cachedLines.length === 0) return;

    const vp = document.querySelector(".paged-viewport") || document.getElementById("paged-viewport");
    const vScrollTop = vp ? vp.scrollTop : 0;
    const defaultScreenY = Math.round(window.innerHeight * 0.38);

    const targetDocY = vScrollTop + defaultScreenY;
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < this.cachedLines.length; i++) {
      const line = this.cachedLines[i];
      const diff = Math.abs(line.centerY - targetDocY);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    this.activeLineIndex = closestIdx;
    const geom = this.computeLineGeometry(closestIdx);
    if (geom) {
      this.height = geom.height;
      this.targetY = geom.targetY;
      this.currentY = this.targetY;
    }
    const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);
    this.stationaryScreenY = Math.round(defaultScreenY - h / 2);

    const line = this.cachedLines[closestIdx];
    this.lastPointerX = line.left != null ? line.left : 100;
    this.lastPointerY = Math.round(line.centerY - vScrollTop);
    this.lastValidPointerX = this.lastPointerX;
    this.lastValidPointerY = this.lastPointerY;

    if (this.wordTracking) {
      if (line && line.isMedia) {
        this.activeWordIndex = -1;
        this.rulerEl.classList.remove("word-tracking-mode");
      } else {
        const words = this.ensureActiveWords(closestIdx);
        if (words && words.length > 0) {
          this.activeWordIndex = 0;
          this.setWordWindow(0);
          const cw = words[0];
          if (cw) {
            this.lastPointerX = cw.centerX;
            this.lastPointerY = Math.round(cw.centerY - vScrollTop);
            this.lastValidPointerX = this.lastPointerX;
            this.lastValidPointerY = this.lastPointerY;
          }
        }
      }
    }

    this._snapRulerInstantOrAnimated();
    this.applyPosition();
  }

  /**
   * Dynamicky přenastaví stacionární teleprompter kotvu pravítka (stationaryScreenY)
   * ve vertikálním režimu čtení na nově vybraný řádek (nebo slovo) pod ukazatelem.
   */
  reanchorAt(clientX, clientY) {
    if (!this.enabled || !this.isVerticalMode()) return;

    if (this._programmaticScrollTimer) {
      clearTimeout(this._programmaticScrollTimer);
      this._programmaticScrollTimer = null;
    }
    this._isProgrammaticScroll = false;
    this.stationaryScreenY = null;
    this.isLineLocked = false;
    this.suppressLineAdvancement = false;
    this.isNavigating = false;
    this.isNavigatingPage = false;

    const viewport = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
    const vScrollTop = viewport ? viewport.scrollTop : 0;
    const docY = vScrollTop + clientY;

    if (this.cachedLines.length === 0) {
      this.detectLines();
    }

    let targetLineIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < this.cachedLines.length; i++) {
      const line = this.cachedLines[i];
      const dy = docY < line.top ? line.top - docY : docY > line.bottom ? docY - line.bottom : 0;
      const diff = dy * 2 + Math.abs(docY - line.centerY);
      if (diff < minDiff) {
        minDiff = diff;
        targetLineIdx = i;
      }
    }
    if (targetLineIdx < 0 && this.cachedLines.length > 0) {
      targetLineIdx = 0;
    }

    this.activeLineIndex = targetLineIdx;
    const targetLine = (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) ? this.cachedLines[targetLineIdx] : null;
    const isMediaLine = !!(targetLine && (targetLine.isMedia || !targetLine.hasText));

    const geom = this.computeLineGeometry(targetLineIdx);
    if (geom) {
      this.height = geom.height;
      this.targetY = geom.targetY;
      this.currentY = this.targetY;
    }

    const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);
    if (targetLine && targetLine.centerY != null) {
      this.stationaryScreenY = Math.round(targetLine.centerY - vScrollTop - h / 2);
    } else {
      this.stationaryScreenY = Math.round(clientY - h / 2);
    }

    if (this.wordTracking && !isMediaLine) {
      const words = this.ensureActiveWords(targetLineIdx);
      let closestWordIdx = -1;
      let minWordDist = Infinity;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const dy = docY < w.top ? w.top - docY : docY > w.bottom ? docY - w.bottom : 0;
        const dx = clientX < w.left ? w.left - clientX : clientX > w.right ? clientX - w.right : 0;
        const dist = dy * 3 + dx;
        if (dist < minWordDist) {
          minWordDist = dist;
          closestWordIdx = i;
        }
      }
      if (closestWordIdx >= 0) {
        this.activeWordIndex = closestWordIdx;
        this.setWordWindow(closestWordIdx);
        const cw = words[closestWordIdx];
        this.lastPointerX = cw ? cw.centerX : clientX;
        this.lastPointerY = cw ? Math.round(cw.centerY - vScrollTop) : clientY;
      }
      this.rulerEl.classList.add("word-tracking-mode");
    } else {
      this.activeWordIndex = -1;
      this.rulerEl.classList.remove("word-tracking-mode");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      this.lastPointerX = targetLine ? targetLine.left : clientX;
      this.lastPointerY = targetLine ? Math.round(targetLine.centerY - vScrollTop) : clientY;
    }

    this.lastValidPointerX = this.lastPointerX;
    this.lastValidPointerY = this.lastPointerY;

    if (this._programmaticScrollTimer) {
      clearTimeout(this._programmaticScrollTimer);
      this._programmaticScrollTimer = null;
    }
    this._isProgrammaticScroll = false;

    if (this.rulerEl) {
      this.rulerEl.style.display = "block";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
      this.rulerEl.classList.remove("is-hidden", "hidden");
      this.rulerEl.classList.add("is-visible");
    }
    this._snapRulerInstantOrAnimated();

    this.applyPosition();
  }

  cancelHold(aborted = false) {
    this.clearHoldTimer();
    this.isHoldActive = false;
    document.body.classList.remove("ruler-holding");
    if (aborted) {
      this.wasHoldAborted = true;
      this.dragCooldownEndTime = Math.max(this.dragCooldownEndTime, Date.now() + 450);
      setTimeout(() => {
        this.wasHoldAborted = false;
      }, 500);
    }
  }

  clearHoldTimer() {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  attachEvents() {
    // 1. POINTER EVENTS: Sjednocené sledování pro prst, Apple Pencil i myš
    const onPointerDown = (e) => {
      if (this.isPopoverOrDrawerOpen()) {
        this.isPenTouching = false;
        this._trackingSuspendedByOverlay = true;
        return;
      }

      if (this.isUiControl(e.target)) {
        this.isPenTouching = false;
        this._trackingSuspendedByOverlay = true;
        return;
      }

      if (this.isPointerInStage(e.clientX, e.clientY)) {
        this._trackingSuspendedByOverlay = false;
      }

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.isPenTouching = true;
        this.savePenDetails(e);
        if (this.penFlickEnabled) {
          const now = performance.now();
          this.penStrokeStartTime = now;
          this.penStrokeStartX = e.clientX;
          this.penStrokeStartY = e.clientY;
          this.penHistory = [{ x: e.clientX, y: e.clientY, time: now }];
          this.flickHandledInStroke = false;
        }
      } else if (e.pointerType === "touch") {
        const now = performance.now();
        this.touchStrokeStartTime = now;
        this.touchStrokeStartX = e.clientX;
        this.touchStrokeStartY = e.clientY;
        this.touchHistory = [{ x: e.clientX, y: e.clientY, time: now }];
      }

      if (e.pointerType === "mouse" || this.followMode === "mouse") {
        const isDocTurning = document.body.classList.contains("is-turning-page") ||
          document.body.classList.contains("is-chapter-loading") ||
          !!(this.app?.isNavigating) ||
          (Date.now() < this.navigatingPageLockoutEndTime);
        if (!isDocTurning) {
          this.isLineLocked = false;
          this.isNavigating = false;
          this.isNavigatingPage = false;
          this.isPageTransitioning = false;
          this.suppressLineAdvancement = false;
        }
      }

      if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
      if (this._scrollEndTimer) {
        clearTimeout(this._scrollEndTimer);
        this._scrollEndTimer = null;
      }
      if (this._scrollRafId) {
        cancelAnimationFrame(this._scrollRafId);
        this._scrollRafId = null;
      }
      this._scrollRafPending = false;
      this._isVerticalScrolling = false;
      if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
        this.holdStartTime = 0;
        return;
      }
      if (e.target?.closest && e.target.closest("hr")) return;

      // Pro myš na PC vyžadujeme výhradně stisknuté levé tlačítko (button === 0)
      if (e.pointerType === "mouse" && e.button !== 0) return;

      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        this.activePointerId = e.pointerId;
        this.activePointerType = e.pointerType;
        this.isPenTouching = (e.pointerType === "pen");
        this.isDraggingRuler = this.followMode !== "mouse" || e.pointerType === "touch";
        this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
        return;
      }

      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        this.activePointerId = e.pointerId;
        this.activePointerType = e.pointerType;
        this.isDraggingRuler = false;
        this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
        return;
      }

      // Klávesový režim (keyboard)
      if (e.pointerType === "pen") {
        this.startHold(e.clientX, e.clientY, "pen");
      } else if (e.pointerType === "touch" || e.pointerType === "mouse") {
        this.startHold(e.clientX, e.clientY, e.pointerType);
      }
    };

    const onPointerMove = (e) => {
      if (this.isPopoverOrDrawerOpen()) {
        this.isPenTouching = false;
        this._trackingSuspendedByOverlay = true;
        return;
      }

      if (this.isUiControl(e.target)) {
        this.isPenTouching = false;
        this._trackingSuspendedByOverlay = true;
        return;
      }

      if (this._trackingSuspendedByOverlay) {
        if (e.pointerType === "mouse" && this.isPointerInStage(e.clientX, e.clientY)) {
          this._trackingSuspendedByOverlay = false;
        } else {
          return;
        }
      }

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.savePenDetails(e);

        if (this.penFlickEnabled) {
          if (this.flickHandledInStroke) {
            // Aktuální tah již aktivoval švihnutí – zablokovat přemístění pravítka pro zbytek tohoto tahu
            return;
          }

          const now = performance.now();
          this.penHistory.push({ x: e.clientX, y: e.clientY, time: now });

          // Posuvné okno vzorků za posledních 320 ms
          while (this.penHistory.length > 0 && (now - this.penHistory[0].time > 320)) {
            this.penHistory.shift();
          }
          if (this.penHistory.length > 60) {
            this.penHistory.splice(0, this.penHistory.length - 60);
          }

          // Kontinuální kontakt stylusu na displeji slouží výhradně pro plynulé
          // navádění čtecího pravítka bez nechtěného přetáčení stránek.
        }
      } else if (e.pointerType === "touch") {
        const now = performance.now();
        if (!this.touchHistory) this.touchHistory = [];
        this.touchHistory.push({ x: e.clientX, y: e.clientY, time: now });

        // Posuvné okno vzorků za posledních 450 ms pro plynulý swipe
        while (this.touchHistory.length > 0 && (now - this.touchHistory[0].time > 450)) {
          this.touchHistory.shift();
        }
        if (this.touchHistory.length > 60) {
          this.touchHistory.splice(0, this.touchHistory.length - 60);
        }
      }

      if (e.pointerType === "mouse") {
        this.updateCursorVisibility(e.clientX, e.clientY, "mouse", e.target);
      }

      if (e.pointerType === "mouse" || this.followMode === "mouse") {
        const isDocTurning = document.body.classList.contains("is-turning-page") ||
          document.body.classList.contains("is-chapter-loading") ||
          !!(this.app?.isNavigating) ||
          (Date.now() < this.navigatingPageLockoutEndTime);
        if (!isDocTurning) {
          this.isLineLocked = false;
          this.isNavigating = false;
          this.isNavigatingPage = false;
          this.isPageTransitioning = false;
          this.suppressLineAdvancement = false;
        }
      }

      if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;

      // Pokud běží aktivní držení, zkontrolujeme prahový posun (tolerance 8px)
      if (this.isHoldActive) {
        const dx = Math.abs(e.clientX - this.holdStartX);
        const dy = Math.abs(e.clientY - this.holdStartY);
        if (Math.hypot(dx, dy) > 8 || dx > 8 || dy > 8) {
          this.cancelHold(false);
        }
      }

      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        if (!this.isUiControl(e.target) && this.isPointerInStage(e.clientX, e.clientY)) {
          this.activePointerType = e.pointerType;
          this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
        }
        return;
      }

      // Plynulé sledování v reálném čase v režimu sledování myši ("mouse") pro myš i Apple Pencil
      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        if (e.pointerType === "mouse" || e.pointerType === "pen") {
          if (!this.isUiControl(e.target) && this.isPointerInStage(e.clientX, e.clientY)) {
            this.activePointerType = e.pointerType;
            this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
          } else {
            this._relativeTrackingActive = false;
            this._verticalScrollAnchorPending = false;
            this._scrollAnchorPhysicalY = null;
            this._scrollAnchorVirtualY = null;
          }
        }
        return;
      }
    };

    const onPointerUp = (e) => {
      if (this.isUiControl(e.target)) {
        this.isPenTouching = false;
        return;
      }
      this.isPenTouching = false;
      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        this.isDraggingRuler = false;
        this.isPenTouching = false;
      }
      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.isPenTouching = false;
        this.dragCooldownEndTime = Date.now() + 350;

        if (this.penFlickEnabled && !this.flickHandledInStroke && !this.isNavigating && !this.isNavigatingPage && Date.now() >= this.navigatingPageLockoutEndTime) {
          const now = performance.now();
          const flick = this.detectPenFlick(e.clientX, e.clientY, now, "pen");
          if (flick) {
            this.triggerPenFlick(flick);
            this.penHistory = [];
            this.penStrokeStartTime = 0;
            this.flickHandledInStroke = false;
            return;
          }
        }

        this.penHistory = [];
        this.penStrokeStartTime = 0;
        this.flickHandledInStroke = false;
      } else if (e.pointerType === "touch") {
        if (!this.isNavigating && !this.isNavigatingPage && Date.now() >= this.navigatingPageLockoutEndTime) {
          const now = performance.now();
          const swipe = this.detectPenFlick(e.clientX, e.clientY, now, "touch");
          if (swipe) {
            this.triggerPenFlick(swipe);
            this.touchHistory = [];
            this.touchStrokeStartTime = 0;
            if (this.isHoldActive) this.cancelHold(false);
            this.holdStartTime = 0;
            this.isDraggingRuler = false;
            return;
          }
        }
        this.touchHistory = [];
        this.touchStrokeStartTime = 0;
      }

      if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
        this.cancelHold(false);
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        return;
      }

      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        if (e.pointerType === "pen") {
          return;
        }
        return;
      }

      // If any drawer or settings panel is open, yield to the backdrop close handler.
      if (typeof this.isAnyDrawerOpen === "function" && this.isAnyDrawerOpen()) {
        if (this.isHoldActive) this.cancelHold(false);
        this.holdStartTime = 0;
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        this.activePointerId = null;
        this.activePointerType = null;
        return;
      }

      if (this.isUiControl(e.target) || !this.holdStartTime) {
        if (this.isHoldActive) this.cancelHold(false);
        this.holdStartTime = 0;
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        this.activePointerId = null;
        this.activePointerType = null;
        return;
      }

      const deltaX = e.clientX - this.holdStartX;
      const deltaY = e.clientY - this.holdStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const holdDuration = Date.now() - (this.holdStartTime || 0);
      const velocity = holdDuration > 0 ? absX / holdDuration : 0;

      // Pokud pohyb překročil prahovou hodnotu pro swipe (|deltaX| >= 30px, |deltaY| <= 65px, holdDuration <= 450ms, velocity >= 0.3 px/ms):
      if (absX >= 30 && absY <= 65 && holdDuration <= 450 && velocity >= 0.3) {
        this.cancelHold(false);
        this.holdStartTime = 0;
        this.lastSwipeTime = Date.now();
        this.isHoldTriggered = false;
        this.isDraggingRuler = false;
        this.flickResyncTopLine = true;
        this.isLineLocked = true;
        this.suppressLineAdvancement = true;
        this.lockAdvancement(400);
        if (this.onSwipe) {
          this.onSwipe(deltaX < 0 ? 1 : -1);
        }
        return;
      }

      if (this.isHoldActive) {
        const holdDuration = Date.now() - (this.holdStartTime || 0);
        const dist = Math.hypot(deltaX, deltaY);
        // Krokování tapem se spustí POUZE při čistém, stacionárním klepnutí (|deltaX| < 8px a |deltaY| < 8px)
        const isTap = absX < 8 && absY < 8 && dist <= 8 && holdDuration < 500 && !this.isHoldTriggered;

        this.cancelHold(false);

        if (isTap && (e.pointerType === "touch" || e.pointerType === "mouse" || e.pointerType === "pen")) {
          this.handleTap(e.clientX, e.clientY, e.pointerType, dist);
        }
      }

      if (this.isHoldTriggered) {
        this.dragCooldownEndTime = Date.now() + 650;
        setTimeout(() => {
          this.isHoldTriggered = false;
        }, 400);
      }

      if (this.isDraggingRuler && (this.activePointerId === null || e.pointerId === this.activePointerId)) {
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        this.activePointerId = null;
        this.activePointerType = null;
        this.dragCooldownEndTime = Date.now() + 350;
        return;
      }

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.isPenTouching = false;
        this.dragCooldownEndTime = Date.now() + 350;
      }
    };

    const onPointerCancel = () => {
      this.isPenTouching = false;
      this.penHistory = [];
      this.penStrokeStartTime = 0;
      this.flickHandledInStroke = false;
      this.touchHistory = [];
      this.touchStrokeStartTime = 0;
      if (this.isHoldActive) {
        this.cancelHold(false);
      }
      this.isDraggingRuler = false;
      this.isPenTouching = false;
      this.activePointerId = null;
      this.activePointerType = null;
      this.dragCooldownEndTime = Date.now() + 350;
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerCancel, { passive: true });

    const onPointerLeaveWindow = (e) => {
      this._relativeTrackingActive = false;
      this._verticalScrollAnchorPending = false;
      this._scrollAnchorPhysicalY = null;
      this._scrollAnchorVirtualY = null;
      if (!e || e.pointerType === "mouse" || !e.pointerType) {
        this.setCursorHidden(false);
      }
    };
    window.addEventListener("pointerleave", onPointerLeaveWindow, { passive: true });
    document.addEventListener("mouseleave", onPointerLeaveWindow, { passive: true });
    window.addEventListener("blur", () => {
      this._relativeTrackingActive = false;
      this._verticalScrollAnchorPending = false;
      this._scrollAnchorPhysicalY = null;
      this._scrollAnchorVirtualY = null;
      this.setCursorHidden(false);
    }, { passive: true });

    // 2. TOUCH EVENTS (WebKit Safari fallback pro starší zařízení)
    const onTouchStart = (e) => {
      if (!this.enabled || this.isLineLocked) return;
      if (this.isPopoverOrDrawerOpen()) {
        this.holdStartTime = 0;
        this._trackingSuspendedByOverlay = true;
        return;
      }
      if (this._scrollEndTimer) {
        clearTimeout(this._scrollEndTimer);
        this._scrollEndTimer = null;
      }
      if (this._scrollRafId) {
        cancelAnimationFrame(this._scrollRafId);
        this._scrollRafId = null;
      }
      this._scrollRafPending = false;
      this._isVerticalScrolling = false;
      const touch = e.touches[0];
      if (this.isUiControl(e.target) || (touch && this.isUiControl(touch.target)) || !touch || !this.isPointerInStage(touch.clientX, touch.clientY)) {
        this.holdStartTime = 0;
        if (this.isUiControl(e.target) || (touch && this.isUiControl(touch.target))) {
          this._trackingSuspendedByOverlay = true;
        }
        return;
      }
      this._trackingSuspendedByOverlay = false;
      if (e.target?.closest && e.target.closest("hr")) return;
      const isStylus = Array.from(e.touches).some(t => t.touchType === "stylus");
      if (isStylus) {
        this.lastPenTime = Date.now();
      }
      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        this.activePointerType = isStylus ? "pen" : "touch";
        this.isDraggingRuler = true;
        this.schedulePointerUpdate(touch.clientX, touch.clientY, this.activePointerType);
        return;
      }
      if (this.followMode === "mouse") {
        if (isStylus && touch && this.isPointerInStage(touch.clientX, touch.clientY)) {
          this.activePointerType = "pen";
          this.schedulePointerUpdate(touch.clientX, touch.clientY, "pen");
        }
        return;
      }
      if (touch && !this.isHoldActive && this.isPointerInStage(touch.clientX, touch.clientY)) {
        this.startHold(touch.clientX, touch.clientY, isStylus ? "pen" : "touch");
      }
    };

    const onTouchMove = (e) => {
      if (this.isPopoverOrDrawerOpen() || this._trackingSuspendedByOverlay || this.isUiControl(e.target)) {
        if (this.isPopoverOrDrawerOpen() || this.isUiControl(e.target)) {
          this._trackingSuspendedByOverlay = true;
        }
        return;
      }

      if (e.pointerType === "mouse" || this.followMode === "mouse") {
        const isDocTurning = document.body.classList.contains("is-turning-page") ||
          document.body.classList.contains("is-chapter-loading") ||
          !!(this.app?.isNavigating) ||
          (Date.now() < this.navigatingPageLockoutEndTime);
        if (!isDocTurning) {
          this.isLineLocked = false;
          this.isNavigating = false;
          this.isNavigatingPage = false;
          this.isPageTransitioning = false;
          this.suppressLineAdvancement = false;
        }
      }

      if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
      const isStylus = Array.from(e.touches).some(t => t.touchType === "stylus");
      if (isStylus) {
        this.lastPenTime = Date.now();
      }

      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        const touch = e.touches[0];
        if (touch && !this.isUiControl(e.target) && this.isPointerInStage(touch.clientX, touch.clientY)) {
          this.activePointerType = isStylus ? "pen" : "touch";
          this.schedulePointerUpdate(touch.clientX, touch.clientY, this.activePointerType);
        }
        return;
      }

      // Apple Pencil sledování v režimu sledování myši ("mouse") i přes touchmove
      if (this.followMode === "mouse") {
        if (isStylus && !this.isDraggingRuler) {
          const stylusTouch = Array.from(e.touches).find(t => t.touchType === "stylus");
          if (stylusTouch && !this.isUiControl(e.target) && this.isPointerInStage(stylusTouch.clientX, stylusTouch.clientY)) {
            this.activePointerType = "pen";
            this.schedulePointerUpdate(stylusTouch.clientX, stylusTouch.clientY, "pen");
          }
        }
        return;
      }

      if (this.isHoldActive && e.touches.length > 0) {
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - this.holdStartX);
        const dy = Math.abs(touch.clientY - this.holdStartY);
        if (Math.hypot(dx, dy) > 8 || dx > 8 || dy > 8) {
          this.cancelHold(false);
        }
      }
    };

    const onTouchEnd = (e) => {
      if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        return;
      }
      if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime || Date.now() - this.lastSwipeTime < 450) {
        this.cancelHold(false);
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        return;
      }

      // If any drawer or settings panel is open, release the hold without stepping.
      // The touchend on the backdrop will handle drawer close instead.
      if (typeof this.isAnyDrawerOpen === "function" && this.isAnyDrawerOpen()) {
        if (this.isHoldActive) this.cancelHold(false);
        this.holdStartTime = 0;
        return;
      }

      if (this.followMode === "mouse") return;

      if (this.isUiControl(e.target) || !this.holdStartTime) {
        if (this.isHoldActive) this.cancelHold(false);
        this.holdStartTime = 0;
        return;
      }

      const touch = e.changedTouches && e.changedTouches[0];
      const clientX = touch ? touch.clientX : this.holdStartX;
      const clientY = touch ? touch.clientY : this.holdStartY;
      const deltaX = clientX - this.holdStartX;
      const deltaY = clientY - this.holdStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const holdDuration = Date.now() - (this.holdStartTime || 0);
      const velocity = holdDuration > 0 ? absX / holdDuration : 0;

      // Pokud pohyb překročil prahovou hodnotu pro swipe (|deltaX| >= 30px, |deltaY| <= 65px, holdDuration <= 450ms, velocity >= 0.3 px/ms):
      if (absX >= 30 && absY <= 65 && holdDuration <= 450 && velocity >= 0.3) {
        this.cancelHold(false);
        this.holdStartTime = 0;
        this.lastSwipeTime = Date.now();
        this.isHoldTriggered = false;
        this.isDraggingRuler = false;
        this.flickResyncTopLine = true;
        this.isLineLocked = true;
        this.suppressLineAdvancement = true;
        this.lockAdvancement(400);
        if (this.onSwipe) {
          this.onSwipe(deltaX < 0 ? 1 : -1);
        }
        return;
      }

      if (this.isHoldActive) {
        const holdDuration = Date.now() - (this.holdStartTime || 0);
        const dist = Math.hypot(deltaX, deltaY);
        // Krokování tapem se spustí POUZE při čistém, stacionárním klepnutí (|deltaX| < 8px a |deltaY| < 8px)
        const isTap = absX < 8 && absY < 8 && dist <= 8 && holdDuration < 500 && !this.isHoldTriggered;

        this.cancelHold(false);

        if (isTap) {
          this.handleTap(clientX, clientY, "touch", dist);
        }
      }

      if (this.isHoldTriggered) {
        this.dragCooldownEndTime = Date.now() + 650;
        setTimeout(() => {
          this.isHoldTriggered = false;
        }, 400);
      }
    };

    const onTouchCancel = () => {
      if (this.isHoldActive) {
        this.cancelHold(false);
      }
      this.isDraggingRuler = false;
      this.isPenTouching = false;
      this.dragCooldownEndTime = Date.now() + 350;
    };

    // 2. TOUCH & MOUSE EVENTS (WebKit Safari fallback pouze pro prohlížeče bez podpory PointerEvent)
    if (!window.PointerEvent) {
      window.addEventListener("touchstart", onTouchStart, { passive: true });
      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
      window.addEventListener("touchcancel", onTouchCancel, { passive: true });

      // 3. MOUSEMOVE fallback (pro prohlížeče bez PointerEvents)
      window.addEventListener("mousemove", (e) => {
        if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime || this.isDraggingRuler || this.isPenTouching) return;
        if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
          this._relativeTrackingActive = false;
          this._verticalScrollAnchorPending = false;
          this._scrollAnchorPhysicalY = null;
          this._scrollAnchorVirtualY = null;
          return;
        }
        if (this.followMode === "mouse") {
          this.activePointerType = "mouse";
          this.schedulePointerUpdate(e.clientX, e.clientY, "mouse");
        }
      }, { passive: true });
    }

    // Aktivní touchmove listener pro Apple Pencil na iPadOS Safari
    window.addEventListener("touchmove", (e) => {
      if (!this.enabled || this.followMode !== "mouse") return;
      if (this.isPopoverOrDrawerOpen() || this._trackingSuspendedByOverlay || this.isUiControl(e.target)) return;
      const touches = e.touches ? Array.from(e.touches) : [];
      const stylusTouch = touches.find(t => t.touchType === "stylus") || ((Date.now() - this.lastPenTime < 500) ? touches[0] : null);
      if (stylusTouch && this.isPointerInStage(stylusTouch.clientX, stylusTouch.clientY)) {
        if (e.cancelable) e.preventDefault();
        this.lastPenTime = Date.now();
        this.activePointerType = "pen";
        this.schedulePointerUpdate(stylusTouch.clientX, stylusTouch.clientY, "pen");
      }
    }, { passive: false });

    // Potlačení kontextového menu při podržení
    window.addEventListener("contextmenu", (e) => {
      if (!this.enabled) return;
      if (this.isHoldActive || this.isHoldTriggered || Date.now() < this.dragCooldownEndTime) {
        if (this.isPointerInStage(e.clientX, e.clientY)) {
          e.preventDefault();
        }
      }
    });

    // Ignorování kolečka myši a gest touchpadu během uzamčení řádků
    window.addEventListener("wheel", (e) => {
      if (!this.enabled || this.isLineLocked) {
        return;
      }
      if (this.isVerticalMode() && this.followMode === "mouse") {
        if (e.clientX != null) {
          this.lastPointerX = e.clientX;
          this.lastValidPointerX = e.clientX;
        }
        this._relativeTrackingActive = false;
        this._verticalScrollAnchorPending = false;
        this._scrollAnchorPhysicalY = null;
        this._scrollAnchorVirtualY = null;
        this.handleVerticalScroll();
      }
    }, { passive: true });

    // Zachycení kliknutí pro zabránění nežádoucího resetu nebo odskoku pravítka po dokončení podržení či jeho zrušení
    window.addEventListener("click", (e) => {
      if (!this.enabled) return;
      if (this.isUiControl(e.target)) return;
      // When any drawer/panel is open, do NOT swallow the event — let the backdrop handler close it.
      if (typeof this.isAnyDrawerOpen === "function" && this.isAnyDrawerOpen()) return;
      if (this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      if (!this.isPointerInStage(e.clientX, e.clientY)) return;

      // Pokud klik proběhl krátce po swipu nebo krokování tapem, zamezíme opětovnému spuštění a probublání
      if (Date.now() - this.lastSwipeTime < 500 || Date.now() - this.lastTapStepTime < 350) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      if (this.isHoldTriggered || this.wasHoldAborted || Date.now() < this.dragCooldownEndTime) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      // V klávesovém režimu diskrétní klik okamžitě odkrokuje pravítko (pokud ještě nebylo odkrokováno přes pointerup)
      if (this.followMode === "keyboard") {
        const handled = this.handleTap(e.clientX, e.clientY, "mouse", 0);
        if (handled) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
      }
    }, { capture: true });

    // 4. Klávesové ovládání (doplňkové klávesy j/k pro posun pravítka)
    window.addEventListener("keydown", (e) => {
      if (!this.enabled || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) return;
      this.cancelHold();
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      if (this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
        if (["j", "J", "k", "K", "ArrowDown", "ArrowUp", " "].includes(e.key) || e.code === "Space") {
          e.preventDefault();
          return;
        }
      }

      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        this.stepLine(1, true);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        this.stepLine(-1, true);
      }
    });

    let resizeDebounceTimer = null;
    window.addEventListener("resize", () => {
      if (this.enabled) {
        this.cancelHold();
        if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
          resizeDebounceTimer = null;
          if (!this.enabled) return;
          if (this._canonicalColTopOffsets) {
            this._canonicalColTopOffsets.clear();
          }
          this.refreshLines();
          if (this.wordTracking) this.refreshWords();
          this.applyPosition();
        }, 50);
      }
    });

    const onScroll = () => {
      if (!this.enabled || !this.isVerticalMode()) return;
      if (this._isProgrammaticScroll) return;

      this.handleVerticalScroll();
    };
    this._onScroll = onScroll;
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    const vp = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
    if (vp) {
      vp._rulerScrollAttached = true;
      vp.addEventListener("scroll", onScroll, { passive: true });
    }
  }

  ensureVerticalScrollListener() {
    const vp = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
    if (vp && !vp._rulerScrollAttached && this._onScroll) {
      vp._rulerScrollAttached = true;
      vp.addEventListener("scroll", this._onScroll, { passive: true });
    }
  }

  /**
   * Provede okamžitý synchronní posun vertikálního viewportu bez plynulých animací (behavior: 'auto'),
   * aby nedocházelo k zásekům a desynchronizaci WebKit compositoru na dotykových zařízeních.
   */
  _applyVerticalScrollDelta(vp, scrollDelta) {
    if (!vp || Math.abs(scrollDelta) < 0.5) return;
    if (this._programmaticScrollTimer) {
      clearTimeout(this._programmaticScrollTimer);
      this._programmaticScrollTimer = null;
    }
    this._isProgrammaticScroll = true;
    vp.scrollTop += scrollDelta;
    this._programmaticScrollTimer = setTimeout(() => {
      this._isProgrammaticScroll = false;
      this._programmaticScrollTimer = null;
    }, 40);
  }

  /**
   * Aplikuje okamžité přichycení pravítka. Ve vertikálním režimu striktně vynutí
   * transition: none !important bez třídy .is-snapped pro 1:1 synchronizaci bez lagu.
   */
  _snapRulerInstantOrAnimated() {
    if (this.isVerticalMode()) {
      if (this.rulerEl) {
        this.rulerEl.classList.remove("is-snapped");
        this.rulerEl.style.setProperty("transition", "none", "important");
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.classList.remove("is-snapped");
        this.wordWaveEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskTopEl) {
        this.maskTopEl.classList.remove("is-snapped");
        this.maskTopEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskBottomEl) {
        this.maskBottomEl.classList.remove("is-snapped");
        this.maskBottomEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskLeftEl) {
        this.maskLeftEl.classList.remove("is-snapped");
        this.maskLeftEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskRightEl) {
        this.maskRightEl.classList.remove("is-snapped");
        this.maskRightEl.style.setProperty("transition", "none", "important");
      }
    } else {
      if (this.rulerEl) {
        this.rulerEl.classList.add("is-snapped");
        if (this.followMode !== "mouse") this.rulerEl.style.removeProperty("transition");
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.classList.add("is-snapped");
        this.wordWaveEl.style.removeProperty("transition");
      }
      if (this.maskTopEl) {
        this.maskTopEl.classList.add("is-snapped");
        if (this.followMode !== "mouse") this.maskTopEl.style.removeProperty("transition");
      }
      if (this.maskBottomEl) {
        this.maskBottomEl.classList.add("is-snapped");
        if (this.followMode !== "mouse") this.maskBottomEl.style.removeProperty("transition");
      }
      if (this.maskLeftEl) {
        this.maskLeftEl.classList.add("is-snapped");
        if (this.followMode !== "mouse") this.maskLeftEl.style.removeProperty("transition");
      }
      if (this.maskRightEl) {
        this.maskRightEl.classList.add("is-snapped");
        if (this.followMode !== "mouse") this.maskRightEl.style.removeProperty("transition");
      }
    }
  }

  /**
   * Plynulá aktualizace pozice pravítka během vertikálního posuvu stránky (EPUB / PDF scroll).
   * Využívá RAF throttling a GPU transform (translate3d) bez nákladného měření DOMu.
   */
  handleVerticalScroll() {
    this._isVerticalScrolling = true;

    // Vypnout přechodové CSS animace pro okamžitou 1:1 synchronizaci bez zpoždění
    if (this.rulerEl) {
      this.rulerEl.classList.remove("is-snapped");
      this.rulerEl.style.transition = "none";
    }
    if (this.maskTopEl) {
      this.maskTopEl.classList.remove("is-snapped");
      this.maskTopEl.style.transition = "none";
    }
    if (this.maskBottomEl) {
      this.maskBottomEl.classList.remove("is-snapped");
      this.maskBottomEl.style.transition = "none";
    }
    if (this.maskLeftEl) {
      this.maskLeftEl.classList.remove("is-snapped");
      this.maskLeftEl.style.transition = "none";
    }
    if (this.maskRightEl) {
      this.maskRightEl.classList.remove("is-snapped");
      this.maskRightEl.style.transition = "none";
    }

    // Debounce timer (150 ms) pro resynchronizaci / přichycení k nejbližšímu řádku po zastavení posuvu
    if (this._scrollEndTimer) {
      clearTimeout(this._scrollEndTimer);
    }
    this._scrollEndTimer = setTimeout(() => {
      this._scrollEndTimer = null;
      this._onVerticalScrollEnd();
    }, 150);

    // RAF throttling pro samotný repaint
    if (!this._scrollRafPending) {
      this._scrollRafPending = true;
      this._scrollRafId = requestAnimationFrame(() => {
        this._scrollRafPending = false;
        this._scrollRafId = null;
        this._onVerticalScrollRaf();
      });
    }
  }

  /**
   * Samotný RAF callback: Čte scroll pozici a rozměry viewportu striktně zde.
   */
  _onVerticalScrollRaf() {
    if (!this.enabled || !this.isVerticalMode()) return;

    const viewport = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
    const vScrollTop = viewport ? viewport.scrollTop : (window.scrollY || 0);
    const vHeight = viewport ? viewport.clientHeight : window.innerHeight;
    this._cachedScrollTop = vScrollTop;
    this._cachedViewportHeight = vHeight;

    this._applyVisualScrollTransform(vScrollTop, vHeight);
  }

  /**
   * Aktualizuje výhradně GPU translate3d pozici pravítka a dimming masek během aktivního posuvu.
   * Neprovádí ŽÁDNÝ scan cachedLines ani nucený reflow (layout thrashing).
   */
  _applyVisualScrollTransform(vScrollTop, vHeight) {
    if (!this.rulerEl || !this.enabled) return;

    const isKb = this.followMode === "keyboard";
    const lineDocY = Number.isFinite(this.currentY) ? this.currentY : 150;
    const h = Number.isFinite(this.height) && this.height > 0 ? this.height : (this.manualHeight || 36);
    const lineScreenY = Math.round(lineDocY - vScrollTop);

    let screenY;
    if (isKb && this.stationaryScreenY !== null) {
      const viewport = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
      const maxScrollTop = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;
      if (vScrollTop <= 1 && lineScreenY < this.stationaryScreenY) {
        screenY = lineScreenY;
      } else if (vScrollTop >= maxScrollTop - 1 && lineScreenY > this.stationaryScreenY) {
        screenY = lineScreenY;
      } else {
        screenY = this.stationaryScreenY;
      }
    } else {
      const targetIdx = (this.cachedLines && this.cachedLines.length > 0)
        ? Math.max(0, Math.min(this.cachedLines.length - 1, this.activeLineIndex >= 0 ? this.activeLineIndex : 0))
        : -1;
      const targetLine = targetIdx >= 0 ? this.cachedLines[targetIdx] : null;

      if (targetLine) {
        if (this.mode === "bottom-cover") {
          const baselineDocY = Number.isFinite(this.currentY)
            ? this.currentY
            : (Number.isFinite(targetLine.bottom) ? (targetLine.bottom + COVER_LINE_OFFSET) : targetLine.centerY);
          screenY = Math.round(baselineDocY - vScrollTop);
        } else {
          screenY = Math.round(targetLine.centerY - vScrollTop - (h / 2));
        }
      } else {
        screenY = lineScreenY;
      }
    }

    const isBottomCoverWordTracking = (this.style === "bottom-cover" || this.mode === "bottom-cover") && !!this.wordTracking;
    const rx = Math.round((this.wordTracking && !isBottomCoverWordTracking) ? (this.wordLeft || 0) : (this._rulerLeft || 0));
    const ry = Math.round(screenY);

    this.rulerEl.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;

    // Optimalizovaná aktualizace dimming masek v režimu Focus výhradně přes transform (pro EPUB i PDF)
    const isFocusActive = this.enabled && this.focusMode && this.focusMode !== "off";
    if (isFocusActive) {
      const vh = vHeight || window.innerHeight;
      const rh = (this.style === "bottom-cover" || this.mode === "bottom-cover") ? 0 : Math.round(h);
      if (this.maskTopEl && this.maskTopEl.style.display !== "none") {
        this.maskTopEl.style.transform = `translate3d(0, ${Math.round(ry - vh)}px, 0)`;
      }
      if (this.maskBottomEl && this.maskBottomEl.style.display !== "none") {
        this.maskBottomEl.style.transform = `translate3d(0, ${Math.round(ry + rh)}px, 0)`;
      }
      if (this.maskLeftEl && this.maskLeftEl.style.display !== "none") {
        this.maskLeftEl.style.transform = `translate3d(0, ${ry}px, 0)`;
      }
      if (this.maskRightEl && this.maskRightEl.style.display !== "none") {
        const rRight = Math.round(this._slitRight || window.innerWidth);
        this.maskRightEl.style.transform = `translate3d(${rRight}px, ${ry}px, 0)`;
      }
    }
  }

  _getCachedSpreadInfoForLine(currentLine = null) {
    const base = this._cachedSpreadInfo;
    if (!base) return this.getActiveSpreadInfo(currentLine);

    const line = currentLine || (this.activeLineIndex >= 0 && this.cachedLines ? this.cachedLines[this.activeLineIndex] : null);
    let isLeftActive = true;
    if (line && line.columnIndex === 1) {
      isLeftActive = false;
    } else if (line && line.columnIndex === 0) {
      isLeftActive = true;
    } else {
      const midGap = base.midGap;
      const refX = Number.isFinite(line?.textLeft)
        ? line.textLeft
        : (Number.isFinite(line?.left)
          ? line.left
          : (this.lastPointerX ?? (base.leftRect.left + base.leftRect.width / 2)));
      isLeftActive = refX < midGap;
    }

    return {
      ...base,
      isLeftActive,
      activeSlot: isLeftActive ? base.leftSlot : base.rightSlot,
      inactiveSlot: isLeftActive ? base.rightSlot : base.leftSlot,
      activeCanvas: isLeftActive ? base.leftCanvas : base.rightCanvas,
      inactiveCanvas: isLeftActive ? base.rightCanvas : base.leftCanvas,
      activeRect: isLeftActive ? base.leftRect : base.rightRect,
      inactiveRect: isLeftActive ? base.rightRect : base.leftRect
    };
  }

  /**
   * Resynchronizuje a přichytí (magnetický snap) pravítko k nejbližšímu řádku, jakmile posuv ustane.
   */
  _onVerticalScrollEnd() {
    this._isVerticalScrolling = false;
    if (!this.enabled || !this.isVerticalMode() || this.isPageTransitioning) return;

    const viewport = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
    const vScrollTop = viewport ? viewport.scrollTop : (window.scrollY || 0);
    const vHeight = viewport ? viewport.clientHeight : window.innerHeight;

    if (!this.cachedLines || this.cachedLines.length === 0 || Math.abs(vScrollTop - (this._cachedScrollTop ?? -9999)) > 20) {
      this.refreshLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
      if (!this.cachedLines || this.cachedLines.length === 0) {
        this.applyPosition();
        return;
      }
    }

    if (this.followMode === "mouse") {
      const targetIdx = Math.max(0, Math.min(this.cachedLines.length - 1, this.activeLineIndex >= 0 ? this.activeLineIndex : 0));
      this.activeLineIndex = targetIdx;
      const targetLine = this.cachedLines[targetIdx];
      if (targetLine) {
        this.lastPointerY = Math.round(targetLine.centerY - vScrollTop);
        this.lastValidPointerY = this.lastPointerY;

        if (targetLine.isMedia) {
          this.activeWordIndex = -1;
          this.rulerEl.classList.remove("word-tracking-mode");
        } else if (this.wordTracking) {
          const words = this.ensureActiveWords(targetIdx);
          let wIdx = 0;
          if (this.activeWordIndex >= 0 && this.activeWordIndex < words.length) {
            wIdx = this.activeWordIndex;
          }
          if (words.length > 0) {
            this.activeWordIndex = wIdx;
            this.setWordWindow(wIdx);
            this.rulerEl.classList.add("word-tracking-mode");
          }
        }

        const geom = this.computeLineGeometry(targetIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }

        this._snapRulerInstantOrAnimated();
      }

      this.applyPosition();
      return;
    }

    let targetDocCenterY;
    if (this.followMode === "keyboard" && this.stationaryScreenY !== null) {
      targetDocCenterY = vScrollTop + this.stationaryScreenY + (this.height || 36) / 2;
    } else {
      const targetScreenY = this.lastPointerY ?? Math.round(vHeight * 0.38);
      targetDocCenterY = vScrollTop + targetScreenY;
    }

    let closestIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < this.cachedLines.length; i++) {
      const line = this.cachedLines[i];
      const diff = Math.abs(line.centerY - targetDocCenterY);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      } else if (diff > minDiff && closestIdx >= 0) {
        break;
      }
    }

    if (closestIdx >= 0) {
      this.activeLineIndex = closestIdx;
      const closestLine = this.cachedLines[closestIdx];
      if (closestLine && closestLine.isMedia) {
        this.activeWordIndex = -1;
        this.rulerEl.classList.remove("word-tracking-mode");
      } else if (this.wordTracking) {
        const words = this.ensureActiveWords(closestIdx);
        let wIdx = 0;
        if (this.activeWordIndex >= 0 && this.activeWordIndex < words.length) {
          wIdx = this.activeWordIndex;
        }
        if (words.length > 0) {
          this.activeWordIndex = wIdx;
          this.setWordWindow(wIdx);
          this.rulerEl.classList.add("word-tracking-mode");
        }
      }

      const geom = this.computeLineGeometry(closestIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      }

      this._snapRulerInstantOrAnimated();
    }

    this.applyPosition();
  }

  /**
   * Zmapuje přesné obdélníky všech viditelných řádků textu na aktuální stránce.
   * Využívá Range.prototype.getClientRects() nad textovými uzly.
   */
  /**
   * Bezpečná detekce řádků textu chráněná proti pádu (try-catch) a zacyklení.
   * Využívá standardní dotaz nad kandidátními elementy bez rekurzivního průchodu DOMem.
   */
  /**
   * Spolehlivě detekuje, zda je obsah zobrazen ve dvou sloupcích:
   * 1. Kontrola CSS tříd na documentElement, body a elementech čtečky
   * 2. Kontrola CSS proměnné --reader-column-count a getComputedStyle columnCount
   * 3. Geometrická autodetekce: ověření existence dvou sloupců textu vedle sebe
   */
  checkTwoColumnLayout(content, stageRect = null, rawLines = null) {
    if (this.isVerticalMode()) return false;
    if (this.isSpreadActive()) return true;

    // 1. Ověření CSS signálů dvousloupcového rozvržení výhradně na kontejnerech čtečky
    let cssTwoCol = false;
    if (document.documentElement && document.documentElement.classList.contains('columns-2')) cssTwoCol = true;
    else if (document.body && document.body.classList.contains('columns-2')) cssTwoCol = true;
    else if (document.querySelector('#reader-content.columns-2, .paged-content.columns-2, #paged-stage.columns-2') !== null) cssTwoCol = true;

    if (!cssTwoCol) {
      try {
        const colCountVal = getComputedStyle(document.documentElement).getPropertyValue('--reader-column-count')?.trim();
        if (colCountVal === '2') cssTwoCol = true;
      } catch (e) {}
    }

    if (!cssTwoCol && content) {
      try {
        const comp = getComputedStyle(content);
        if (comp.columnCount === '2' || comp.columnCount === 2 || parseInt(comp.columnCount, 10) === 2) {
          cssTwoCol = true;
        }
      } catch (e) {}
    }

    // Pokud CSS explicitně nedeklaruje dva sloupce, jedná se vždy o jednosloupcový layout
    if (!cssTwoCol) return false;

    // Pokud ještě nejsou načteny řádky (early check), vrátit stav podle CSS
    if (!rawLines || rawLines.length < 2) return cssTwoCol;

    // 2. Geometrická validace: ověření existence dvou skutečných sloupců textu vedle sebe
    const sRect = stageRect || (content ? content.getBoundingClientRect() : { left: 0, width: window.innerWidth });
    const stageCenterX = sRect.left + sRect.width / 2;
    const leftLines = [];
    const rightLines = [];
    let spanningLineCount = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const r = rawLines[i];
      const l = r.left;
      const right = r.right;
      if (l == null || right == null) continue;

      // Řádek procházející středovým předělem (typické pro jednosloupcový text)
      if (l < stageCenterX - 25 && right > stageCenterX + 25) {
        spanningLineCount++;
      } else if (right <= stageCenterX + 15) {
        leftLines.push(r);
      } else if (l >= stageCenterX - 15) {
        rightLines.push(r);
      }
    }

    // Pokud řádky procházejí napříč středem (jednosloupcový text), nejedná se o 2 sloupce
    if (spanningLineCount > 0 && spanningLineCount >= rawLines.length * 0.25) {
      return false;
    }

    // Pro 2 sloupce musí existovat řádky v obou polovinách
    if (leftLines.length === 0 || rightLines.length === 0) {
      return false;
    }

    // Ověření geometrického horizontálního překryvu přes oddělené X intervaly (levý a pravý sloupec ve stejném Y)
    let overlapCount = 0;
    for (let j = 0; j < leftLines.length; j++) {
      const lr = leftLines[j];
      for (let k = 0; k < rightLines.length; k++) {
        const rr = rightLines[k];
        if (Math.abs(lr.centerY - rr.centerY) < 18 && lr.right < rr.left - 10) {
          overlapCount++;
          if (overlapCount >= 1) return true;
        }
      }
    }
    return overlapCount >= 1;
  }

  /**
   * Ověří, zda se od posledního spuštění detectLines() nezměnil transform sloupce
   * nebo rozměry #paged-stage (např. po posunu posuvníků okrajů/písma nebo otočení stránky).
   * Pokud ano, okamžitě přepočítá řádky a geometrii aktivního řádku.
   */
  _ensureLinesFreshForCurrentLayout() {
    if (
      !this.enabled ||
      this.isImageOnlyPdf ||
      this._isEnsuringFreshLines ||
      this.isPageTransitioning ||
      this.isNavigating ||
      this.isNavigatingPage ||
      (Date.now() < this.navigatingPageLockoutEndTime) ||
      !!(this.app?.isNavigating) ||
      document.body.classList.contains("is-turning-page") ||
      document.body.classList.contains("is-chapter-loading")
    ) {
      return false;
    }
    if (!this.cachedLines || this.cachedLines.length === 0) {
      return false;
    }
    const content = document.querySelector('#reader-content, .page-content, .reader-text, article') || document.body;
    const stage = document.getElementById("paged-stage") || document.getElementById("paged-viewport") || this.container || document.body;
    const curTransform = content ? (content.style.transform || "") : "";
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    const curStageW = stageRect ? Math.round(stageRect.width) : this._cachedStageWidth;
    const curStageL = stageRect ? Math.round(stageRect.left) : this._cachedStageLeft;

    const transformChanged = this._cachedContentTransform !== undefined && curTransform !== this._cachedContentTransform;
    const stageChanged = (
      (this._cachedStageWidth !== undefined && Math.abs(curStageW - this._cachedStageWidth) > 1) ||
      (this._cachedStageLeft !== undefined && Math.abs(curStageL - this._cachedStageLeft) > 1)
    );
    if (!transformChanged && !stageChanged) {
      return false;
    }

    this._isEnsuringFreshLines = true;
    try {
      const prevIdx = this.activeLineIndex;
      this.refreshLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
      if (this.snapToLines && this.cachedLines.length > 0) {
        let targetIdx = prevIdx >= 0 ? Math.min(prevIdx, this.cachedLines.length - 1) : 0;
        if (Number.isFinite(this.currentY) && this.currentY > 0) {
          let bestIdx = targetIdx;
          let bestDist = Infinity;
          for (let i = 0; i < this.cachedLines.length; i++) {
            const d = Math.abs(this.cachedLines[i].centerY - this.currentY);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
          if (prevIdx < 0 || prevIdx >= this.cachedLines.length) {
            targetIdx = bestIdx;
          }
        }
        this.activeLineIndex = targetIdx;
        const geom = this.computeLineGeometry(targetIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          if (!this.isDraggingRuler && !this.isDragging) {
            this.currentY = geom.targetY;
          }
        }
      }
      return true;
    } finally {
      this._isEnsuringFreshLines = false;
    }
  }

  /**
   * Bezpečná detekce řádků textu chráněná proti pádu (try-catch) a zacyklení.
   * Využívá standardní dotaz nad kandidátními elementy bez rekurzivního průchodu DOMem.
   */
  detectLines(force = false) {
    this._lastComputedLineGeom = null;
    this._clearWordCache();
    if (!force && (!this.cachedLines || this.cachedLines.length === 0) && this._lastEmptyDetectTime && (performance.now() - this._lastEmptyDetectTime < 150)) {
      return [];
    }
    this.cachedLines = [];
    this.glyphHeightByFontSize = new Map();
    this.pitchByFontSize = new Map();
    if (!this.enabled) {
      return [];
    }
    if (this.isImageOnlyPdf) {
      return [];
    }
    const range = document.createRange();
    try {
      // Ensure we capture whatever typography container the reader engine actually uses:
      const content = document.querySelector('#reader-content, .page-content, .reader-text, article') || document.body;

      if (force && content) {
        void content.offsetWidth;
      }

      const stage = document.getElementById("paged-stage") || document.getElementById("paged-viewport") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
      this.stageLeft = Math.round(stageRect.left);
      this.stageWidth = Math.round(stageRect.width);
      const stageLeft = stageRect.left;
      const stageRight = stageRect.right;
      const stageTop = stageRect.top;
      const stageBottom = stageRect.bottom;
      const hasValidStageBounds = stageRect.width > 50 && stageRect.height > 50;

      const stageCenterX = stageRect.left + stageRect.width / 2;
      const isVertical = this.isVerticalMode();
      const isTwoColEarly = !isVertical && this.checkTwoColumnLayout(content, stageRect, null);
      const viewport = isVertical ? (document.getElementById("paged-viewport") || document.querySelector(".paged-viewport")) : null;
      const vScrollTop = (isVertical && viewport) ? viewport.scrollTop : 0;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;

      const vpEl = viewport || document.getElementById("paged-viewport");
      this._cachedStageRect = stageRect;
      this._cachedContentTransform = content ? (content.style.transform || "") : "";
      this._cachedStageWidth = Math.round(stageRect.width);
      this._cachedStageLeft = Math.round(stageRect.left);
      this._cachedViewportEl = vpEl;
      this._cachedViewportRect = vpEl ? vpEl.getBoundingClientRect() : stageRect;
      this._cachedScrollTop = vScrollTop;
      this._cachedViewportWidth = viewW;
      this._cachedViewportHeight = viewport ? viewport.clientHeight : viewH;
      this._cachedCanvasRect = null;

      const rawLines = [];

      // PDF coordinate normalization map against underlying <canvas>
      const pdfTransformMap = new Map();
      const getPdfTransform = (tl) => {
        if (!tl) return null;
        if (pdfTransformMap.has(tl)) return pdfTransformMap.get(tl);

        const slot = tl.closest('.pdf-page-container, .pdf-page-slot') || tl.parentElement;
        const canvas = slot ? slot.querySelector('canvas') : document.querySelector('#reader-content canvas');
        if (!canvas) {
          pdfTransformMap.set(tl, null);
          return null;
        }

        const canvasRect = canvas.getBoundingClientRect();
        const textLayerRect = tl.getBoundingClientRect();

        if (canvasRect.height > 10 && textLayerRect.height > 10) {
          if (!this._cachedCanvasRect) {
            this._cachedCanvasRect = canvasRect;
          }
          const scaleY = canvasRect.height / textLayerRect.height;
          const scaleX = (canvasRect.width > 10 && textLayerRect.width > 10) ? (canvasRect.width / textLayerRect.width) : 1;
          const tf = {
            canvasRect,
            textLayerRect,
            scaleY,
            scaleX
          };
          pdfTransformMap.set(tl, tf);
          return tf;
        }
        pdfTransformMap.set(tl, null);
        return null;
      };

      // 1. Extract rects ONLY from visible TEXT_NODEs via TreeWalker
      const styleCache = new Map();
      const blockRectCache = new Map();
      const parentRectCache = new Map();
      const offscreenBlocks = new Set();
      const hasTextLayer = this.isPdfMode || !!content.querySelector('.textLayer');
      const maxColSpan = (!isVertical && hasValidStageBounds)
        ? Math.max(120, (isTwoColEarly ? stageRect.width * 0.55 : stageRect.width) - 4)
        : Math.max(120, viewW);
      let colGapEarly = 0;
      if (isTwoColEarly) {
        try {
          colGapEarly = parseFloat(getComputedStyle(content).columnGap) || 0;
        } catch (e) {}
        if (!colGapEarly) colGapEarly = viewW * 0.05;
      }
      const col0RightEarly = isTwoColEarly ? (stageCenterX - colGapEarly / 2) : stageRight;

      const pushLineRect = (r, parentEl, blockEl, fontSize, isPdfEl, pdfTf, pageSlot) => {
        let rTop = r.top;
        let rBottom = r.bottom;
        let rHeight = r.height;
        let lineLeft = r.left;
        let lineRight = r.right;

        if (pdfTf) {
          const relTop = r.top - pdfTf.textLayerRect.top;
          const relBottom = r.bottom - pdfTf.textLayerRect.top;
          rTop = pdfTf.canvasRect.top + relTop * pdfTf.scaleY;
          rBottom = pdfTf.canvasRect.top + relBottom * pdfTf.scaleY;
          rHeight = rBottom - rTop;

          const relLeft = lineLeft - pdfTf.textLayerRect.left;
          const relRight = lineRight - pdfTf.textLayerRect.left;
          lineLeft = pdfTf.canvasRect.left + relLeft * pdfTf.scaleX;
          lineRight = pdfTf.canvasRect.left + relRight * pdfTf.scaleX;
        }

        // Tighten stage boundary clipping in horizontal/paged mode
        if (!isVertical && hasValidStageBounds) {
          if (rBottom <= stageTop + 2 || rTop >= stageBottom - 2 || lineRight <= stageLeft + 2 || lineLeft >= stageRight - 2) {
            return null;
          }
          const rMidX = (lineLeft + lineRight) / 2;
          if (rMidX <= stageLeft + 2 || rMidX >= stageRight - 2) {
            return null;
          }
        }

        const inStage = !hasValidStageBounds || isVertical || (
          lineRight > stageLeft + 2 &&
          lineLeft < stageRight - 2 &&
          rBottom > stageTop &&
          rTop < stageBottom
        );

        if (inStage && rHeight >= 6 && (lineRight - lineLeft) >= 1.5) {
          const isBionic = !!(
            parentEl &&
            parentEl.classList &&
            (parentEl.classList.contains("bionic-fixation") ||
              parentEl.classList.contains("bionic-bold") ||
              parentEl.closest?.(".bionic-fixation, .bionic-bold"))
          );
          const lineObj = {
            el: parentEl,
            element: parentEl,
            blockElement: blockEl,
            pageSlot,
            canvasRect: pdfTf ? pdfTf.canvasRect : null,
            fontSize,
            top: rTop + vScrollTop,
            bottom: rBottom + vScrollTop,
            left: lineLeft,
            right: lineRight,
            height: rHeight,
            centerY: rTop + rHeight / 2 + vScrollTop,
            hasText: true,
            isBionic,
            isPdfLine: !!isPdfEl,
            wordIndices: []
          };
          rawLines.push(lineObj);
          return lineObj;
        }
        return null;
      };

      const BLOCK_TAGS = new Set([
        "P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6",
        "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "NAV",
        "TABLE", "TR", "TD", "TH", "PRE", "DD", "DT"
      ]);
      const INLINE_STYLE_TAGS = new Set(["B", "STRONG", "EM", "I", "SPAN"]);

      const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node === content) {
              return NodeFilter.FILTER_SKIP;
            }
            const tag = node.tagName;
            if (
              tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "PICTURE" ||
              tag === "BUTTON" ||
              node.classList.contains("ruler-floating-controls") ||
              node.classList.contains("ruler-quick-popover") ||
              node.classList.contains("toast-container")
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (tag === "FIGURE" || node.classList.contains("chapter-illustration")) {
              if (!node.closest("figcaption")) return NodeFilter.FILTER_REJECT;
            }

            // Ořezání celých blokových elementů (odstavců) mimo viditelný viewport ještě před sestoupením do vnořených uzlů
            if (BLOCK_TAGS.has(tag)) {
              let rect = blockRectCache.get(node);
              if (!rect) {
                rect = node.getBoundingClientRect();
                blockRectCache.set(node, rect);
              }

              if (!isVertical && hasValidStageBounds) {
                if (
                  rect.right < stageLeft - 30 ||
                  rect.left > stageRight + 30 ||
                  rect.bottom < stageTop - 30 ||
                  rect.top > stageBottom + 30
                ) {
                  offscreenBlocks.add(node);
                  return NodeFilter.FILTER_REJECT;
                }
              } else if (isVertical) {
                if (
                  rect.bottom < -30 ||
                  rect.top > viewH + 30 ||
                  rect.right < -30 ||
                  rect.left > viewW + 30
                ) {
                  offscreenBlocks.add(node);
                  return NodeFilter.FILTER_REJECT;
                }
              }

              let compStyle = styleCache.get(node);
              if (!compStyle) {
                try {
                  compStyle = window.getComputedStyle(node);
                  styleCache.set(node, compStyle);
                } catch (e) {
                  offscreenBlocks.add(node);
                  return NodeFilter.FILTER_REJECT;
                }
              }
              if (compStyle.display === "none" || compStyle.visibility === "hidden" || parseFloat(compStyle.opacity) === 0) {
                offscreenBlocks.add(node);
                return NodeFilter.FILTER_REJECT;
              }

              return NodeFilter.FILTER_SKIP;
            }

            return NodeFilter.FILTER_SKIP;
          }

          // Zpracování TEXT_NODE
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const text = node.textContent;
          if (!text || text.length === 0) return NodeFilter.FILTER_REJECT;

          const rawContentText = text.replace(/[\s\u00A0\uFEFF]/g, "");
          if (!rawContentText || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(rawContentText)) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let textNode;
      while ((textNode = walker.nextNode())) {
        const parent = textNode.parentElement;
        if (!parent) continue;

        const blockElement = parent.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, div, td, th, pre, dd, dt') || parent;
        if (offscreenBlocks.has(blockElement)) {
          continue;
        }

        let blockRect = blockRectCache.get(blockElement);
        if (!blockRect) {
          blockRect = blockElement.getBoundingClientRect();
          blockRectCache.set(blockElement, blockRect);
        }

        let compStyle = styleCache.get(blockElement);
        if (!compStyle) {
          try {
            compStyle = window.getComputedStyle(blockElement);
            styleCache.set(blockElement, compStyle);
          } catch (e) {
            continue;
          }
        }

        const hasInlineStyleFontSize = parent.style && parent.style.fontSize && !Number.isNaN(parseFloat(parent.style.fontSize));
        const rawFontSize = (INLINE_STYLE_TAGS.has(parent.tagName) && !hasInlineStyleFontSize)
          ? (parseFloat(compStyle.fontSize) || 16)
          : (parseFloat(parent.style?.fontSize) || parseFloat(compStyle.fontSize) || 16);
        const isPdfEl = hasTextLayer && (this.isPdfMode || !!parent.closest('.textLayer'));
        const textLayer = isPdfEl ? parent.closest('.textLayer') : null;
        const pdfTf = textLayer ? getPdfTransform(textLayer) : null;
        const pageSlot = isPdfEl ? (parent.closest('.pdf-page-slot, .pdf-page-container') || textLayer) : null;
        const fontSize = Math.max(6, Math.round(pdfTf ? (rawFontSize * pdfTf.scaleY) : rawFontSize));

        let parentRect = null;
        if (parent === blockElement) {
          parentRect = blockRect;
        } else {
          parentRect = parentRectCache.get(parent);
          if (!parentRect) {
            parentRect = parent.getBoundingClientRect();
            parentRectCache.set(parent, parentRect);
          }

          if (!isVertical && hasValidStageBounds) {
            if (
              parentRect.right < stageLeft - 20 ||
              parentRect.left > stageRight + 20 ||
              parentRect.bottom < stageTop - 20 ||
              parentRect.top > stageBottom + 20
            ) {
              continue;
            }
          } else if (isVertical) {
            if (
              parentRect.right < -20 ||
              parentRect.left > viewW + 20 ||
              parentRect.bottom < -20 ||
              parentRect.top > viewH + 20
            ) {
              continue;
            }
          }
        }

        try {
          range.selectNodeContents(textNode);
          const rects = range.getClientRects();
          if (!rects || rects.length === 0) continue;

          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            pushLineRect(r, parent, blockElement, fontSize, isPdfEl, pdfTf, pageSlot);
          }
        } catch (e) {}
      }

      // Detekce samostatných obrázků, ilustrací a multimediálních elementů
      const mediaCandidates = content.querySelectorAll('img, figure, .chapter-illustration, svg, picture, [class*="ornament"], [class*="illustration"]');
      const handledMediaNodes = new Set();

      mediaCandidates.forEach(mediaEl => {
        if (handledMediaNodes.has(mediaEl)) return;

        // Přeskočit interaktivní ovládací prvky, toolbary a navigační prvky
        if (mediaEl.closest('button, nav, header, footer, [role="button"], a[href], .ruler-floating-controls, .ruler-quick-popover, .toast-container')) {
          return;
        }

        let target = mediaEl;
        if (mediaEl.tagName === 'FIGURE' || mediaEl.classList.contains('chapter-illustration') || mediaEl.tagName === 'PICTURE') {
          const innerImg = mediaEl.querySelector('img, svg');
          if (innerImg) {
            target = innerImg;
            handledMediaNodes.add(innerImg);
          }
          handledMediaNodes.add(mediaEl);
        } else if (mediaEl.tagName === 'IMG') {
          handledMediaNodes.add(mediaEl);
          const parentContainer = mediaEl.closest('figure, picture, .chapter-illustration, [class*="ornament"]');
          if (parentContainer) handledMediaNodes.add(parentContainer);
        } else if (mediaEl.tagName === 'SVG') {
          handledMediaNodes.add(mediaEl);
        }

        try {
          const compStyle = window.getComputedStyle(target);
          if (compStyle.display === 'none' || compStyle.visibility === 'hidden' || parseFloat(compStyle.opacity) === 0) {
            return;
          }
        } catch (e) {}

        const rect = target.getBoundingClientRect();
        // Přeskočit prázdné nebo miniaturní ikony/odrážky (< 12px x < 12px nebo < 6px výška)
        if ((rect.width < 12 && rect.height < 12) || rect.width < 8 || rect.height < 6) return;

        // Horizontální layout filtr pro stránkový režim
        if (!isVertical && hasValidStageBounds && (rect.right < stageLeft - 20 || rect.left > stageRight + 20)) {
          return;
        }

        const inStage = !hasValidStageBounds || isVertical || (
          rect.right > stageLeft + 2 &&
          rect.left < stageRight - 2 &&
          rect.bottom > stageTop &&
          rect.top < stageBottom
        );
        if (!inStage) return;

        if (!isVertical && hasValidStageBounds) {
          const midX = (rect.left + rect.right) / 2;
          if (midX <= stageLeft + 2 || midX >= stageRight - 2) return;
        }

        rawLines.push({
          el: target,
          element: target,
          top: rect.top + vScrollTop,
          bottom: rect.bottom + vScrollTop,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          mediaLeft: rect.left,
          mediaRight: rect.right,
          mediaWidth: rect.width,
          mediaHeight: rect.height,
          centerY: rect.top + rect.height / 2 + vScrollTop,
          hasText: false,
          isMedia: true
        });
      });

      // Autodetekce dvousloupcového rozvržení (CSS třídy + geometrické překryvy řádků)
      const isTwoCol = !isVertical && this.checkTwoColumnLayout(content, stageRect, rawLines);
      this.isTwoCol = isTwoCol;

      let colGap = 0;
      if (isTwoCol) {
        try {
          colGap = parseFloat(getComputedStyle(content).columnGap) || 0;
        } catch (e) {}
        if (!colGap) {
          colGap = window.innerWidth * 0.05;
        }
      }

      this.colGap = colGap;
      const singleColWidth = isTwoCol ? Math.max(100, (stageRect.width - colGap) / 2) : stageRect.width;
      const col0StageLeft = stageRect.left;
      const col0StageRight = isTwoCol ? stageRect.left + singleColWidth : stageRect.right;
      const col1StageLeft = isTwoCol ? col0StageRight + colGap : col0StageLeft;
      const col1StageRight = isTwoCol ? Math.round(col1StageLeft + singleColWidth) : col0StageRight;
      const colDividerX = isTwoCol ? (col0StageRight + col1StageLeft) / 2 : stageCenterX;

      const isSpread = !isVertical && this.isSpreadActive();
      const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;
      this._cachedIsSpread = isSpread;
      this._cachedSpreadInfo = spreadInfo;

      // Přiřazení indexu sloupce každému nalezenému řádku
      for (let i = 0; i < rawLines.length; i++) {
        const r = rawLines[i];
        if (!isTwoCol || isVertical) {
          r.columnIndex = 0;
        } else if (isSpread && spreadInfo) {
          const el = r.element || r.el;
          if (el && spreadInfo.rightSlot.contains(el)) {
            r.columnIndex = 1;
          } else if (el && spreadInfo.leftSlot.contains(el)) {
            r.columnIndex = 0;
          } else {
            const midX = (r.left + r.right) / 2;
            r.columnIndex = midX >= spreadInfo.midGap ? 1 : 0;
          }
        } else {
          const midX = (r.left + r.right) / 2;
          r.columnIndex = (midX >= colDividerX || r.left >= col0StageRight - 10) ? 1 : 0;
        }
      }

      // 2. Fix Line Clustering: filter out rects spanning multiple lines before clustering
      const validLines = rawLines.filter(r => {
        if (r.isMedia) return true;
        if (r.fontSize && r.height > r.fontSize * 2.2) return false;
        return true;
      });

      // Seskupení řádků odděleně podle sloupců, aby se řádky ve stejném Y v sousedních sloupcích nespojily do jednoho
      const computeWeightedMedian = (items, getVal, getWeight) => {
        if (!items || items.length === 0) return 0;
        if (items.length === 1) return getVal(items[0]);
        const sorted = items.slice().sort((a, b) => getVal(a) - getVal(b));
        let totalW = 0;
        for (let i = 0; i < sorted.length; i++) {
          totalW += Math.max(1, getWeight(sorted[i]));
        }
        const halfW = totalW / 2;
        let cumW = 0;
        for (let i = 0; i < sorted.length; i++) {
          const w = Math.max(1, getWeight(sorted[i]));
          cumW += w;
          if (cumW >= halfW) {
            return getVal(sorted[i]);
          }
        }
        return getVal(sorted[sorted.length - 1]);
      };

      const clusterColumnLines = (colLines, colIdx) => {
        if (colLines.length === 0) return [];
        colLines.sort((a, b) => (a.centerY - b.centerY) || (a.left - b.left));
        const colClustered = [];
        for (const r of colLines) {
          const fragW = Math.max(1, (r.right ?? 0) - (r.left ?? 0));
          const fragEntry = r.isMedia ? null : {
            top: r.top,
            bottom: r.bottom,
            centerY: r.centerY,
            height: r.height,
            weight: fragW,
            isBionic: !!r.isBionic
          };
          if (colClustered.length === 0) {
            colClustered.push({
              ...r,
              columnIndex: colIdx,
              element: r.element || r.el,
              isMedia: !!r.isMedia,
              _frags: fragEntry ? [fragEntry] : null,
              _cyWeightedSum: r.centerY * fragW,
              _hWeightedSum: r.height * fragW,
              _cyWeightTotal: fragW,
              _fsWeightedSum: (r.fontSize || 16) * fragW,
              _fsWeightTotal: fragW
            });
          } else {
            const prev = colClustered[colClustered.length - 1];
            const samePageSlot = !r.pageSlot || !prev.pageSlot || r.pageSlot === prev.pageSlot;
            const shouldMerge = !r.isMedia && !prev.isMedia && samePageSlot && (
              Math.abs(r.centerY - prev.centerY) <= Math.max(5, Math.min(r.height, prev.height) * 0.55)
            );
            if (shouldMerge) {
              if (fragEntry && prev._frags) {
                prev._frags.push(fragEntry);
              }
              prev.top = Math.min(prev.top, r.top);
              prev.bottom = Math.max(prev.bottom, r.bottom);
              prev.left = Math.min(prev.left ?? r.left, r.left);
              prev.right = Math.max(prev.right ?? r.right, r.right);
              prev._cyWeightedSum = (prev._cyWeightedSum || 0) + r.centerY * fragW;
              prev._hWeightedSum = (prev._hWeightedSum || 0) + r.height * fragW;
              prev._cyWeightTotal = (prev._cyWeightTotal || 0) + fragW;
              // Stabilize running centerY and height by width-weighted average during clustering
              // so a single outlier fragment never skews subsequent fragment merge checks
              prev.centerY = prev._cyWeightedSum / prev._cyWeightTotal;
              prev.height = prev._hWeightedSum / prev._cyWeightTotal;
              if (this.isPdfMode || prev.isPdfLine || r.isPdfLine) {
                prev._fsWeightedSum = (prev._fsWeightedSum || ((prev.fontSize || 16) * Math.max(1, prev.right - prev.left))) + (r.fontSize || 16) * fragW;
                prev._fsWeightTotal = (prev._fsWeightTotal || Math.max(1, prev.right - prev.left)) + fragW;
                prev.fontSize = Math.round(prev._fsWeightedSum / prev._fsWeightTotal);
              } else {
                prev.fontSize = Math.max(prev.fontSize || 0, r.fontSize || 0);
              }
              prev.element = prev.element || r.element || r.el;
              prev.blockElement = prev.blockElement || r.blockElement;
              prev.pageSlot = prev.pageSlot || r.pageSlot;
              prev.canvasRect = prev.canvasRect || r.canvasRect;
            } else {
              colClustered.push({
                ...r,
                columnIndex: colIdx,
                element: r.element || r.el,
                isMedia: !!r.isMedia,
                _frags: fragEntry ? [fragEntry] : null,
                _cyWeightedSum: r.centerY * fragW,
                _hWeightedSum: r.height * fragW,
                _cyWeightTotal: fragW,
                _fsWeightedSum: (r.fontSize || 16) * fragW,
                _fsWeightTotal: fragW
              });
            }
          }
        }

        // Compute outlier-resistant line vertical metrics from all collected fragments
        for (const line of colClustered) {
          if (line.isMedia || !line._frags || line._frags.length === 0) continue;
          const frags = line._frags;
          const medCenterY = computeWeightedMedian(frags, f => f.centerY, f => f.weight);
          const medHeight = computeWeightedMedian(frags, f => f.height, f => f.weight);
          line.rawTop = line.top;
          line.rawBottom = line.bottom;
          line.centerY = medCenterY;
          line.height = medHeight;
          line.top = medCenterY - medHeight / 2;
          line.bottom = medCenterY + medHeight / 2;
          delete line._frags;
          delete line._cyWeightedSum;
          delete line._hWeightedSum;
          delete line._cyWeightTotal;
        }
        return colClustered;
      };

      let clustered = [];
      if (isTwoCol && !isVertical) {
        const col0Lines = validLines.filter(l => l.columnIndex === 0);
        const col1Lines = validLines.filter(l => l.columnIndex === 1);
        clustered = [...clusterColumnLines(col0Lines, 0), ...clusterColumnLines(col1Lines, 1)];
      } else {
        clustered = clusterColumnLines(validLines, 0);
      }

      // Seskupení a seřazení řádků sekvenčně shora dolů (strictly transitive comparator)
      if (!isTwoCol || isVertical) {
        clustered.sort((a, b) => (a.centerY - b.centerY) || (a.left - b.left));
      } else {
        // Multi-column layout: keep Column 0 top-to-bottom, followed by Column 1 top-to-bottom
        clustered.sort((a, b) => ((a.columnIndex ?? 0) - (b.columnIndex ?? 0)) || (a.centerY - b.centerY) || (a.left - b.left));
      }

      this.cachedLines = clustered.filter(l => (l.hasText || l.isMedia) && l.height >= 6 && (l.right - l.left) >= 1.5);
      if (!isTwoCol || isVertical) {
        this.cachedLines.sort((a, b) => (a.centerY - b.centerY) || (a.left - b.left));
      } else {
        this.cachedLines.sort((a, b) => ((a.columnIndex ?? 0) - (b.columnIndex ?? 0)) || (a.centerY - b.centerY) || (a.left - b.left));
      }
      this.previousActiveLineIndex = -1;

      if (this.cachedLines.length === 0) {
        if (this.isPdfMode) {
          if (!this.pdfStandardLineHeight) {
            this.pdfStandardLineHeight = this.pdfRulerHeight || 24;
          }
          this.updatePdfReadingZoneBounds(stageRect, isSpread, spreadInfo);
        }
        this._lastEmptyDetectTime = performance.now();
        return [];
      }

      if (this.cachedLines.length > 0) {
        let minLeft0 = Infinity, maxRight0 = -Infinity;
        let minLeft1 = Infinity, maxRight1 = -Infinity;
        const hasTextLines = this.cachedLines.some(l => l.hasText);

        for (const line of this.cachedLines) {
          if (line.isMedia && hasTextLines) continue;
          if (line.columnIndex === 1) {
            if (line.left != null && line.left < minLeft1) minLeft1 = line.left;
            if (line.right != null && line.right > maxRight1) maxRight1 = line.right;
          } else {
            if (line.left != null && line.left < minLeft0) minLeft0 = line.left;
            if (line.right != null && line.right > maxRight0) maxRight0 = line.right;
          }
        }

        const horizontalPadding = 12; // px - jednotný offset pro odsazení zvýrazňovače přesahující okraje textu

        let gapMiddle = stageCenterX;
        if (isTwoCol && !isVertical) {
          if (minLeft1 < Infinity && maxRight0 > -Infinity && minLeft1 > maxRight0) {
            gapMiddle = Math.round((maxRight0 + minLeft1) / 2);
          }
        }
        this.gapMiddle = gapMiddle;

        // Horizontální ohraničení sloupce 0.
        // In 1-column mode: always use the stage right edge as c0Right authority so that
        // inline markup (e.g. Bionic/Fast Reading spans) cannot truncate the column width.
        const textContainer = document.getElementById("reader-content") || content || stage;
        const textContainerRect = textContainer ? textContainer.getBoundingClientRect() : stageRect;
        const textContainerWidth = (textContainerRect && textContainerRect.width > 50) ? textContainerRect.width : stageRect.width;

        let c0Left, c0Right;
        let c1Left, c1Right;
        let c0Width, c1Width;

        if (isSpread && spreadInfo) {
          const leftRect = spreadInfo.leftRect;
          const rightRect = spreadInfo.rightRect;
          const padding = 12;

          let col0Left = Math.round(leftRect.left + padding);
          let col0Right = Math.round(leftRect.right - padding);
          if (minLeft0 < Infinity && maxRight0 > -Infinity && maxRight0 > minLeft0) {
            col0Left = Math.max(Math.round(leftRect.left), Math.round(minLeft0 - padding));
            col0Right = Math.min(Math.round(leftRect.right), Math.round(maxRight0 + padding));
          }

          let col1Left = Math.round(rightRect.left + padding);
          let col1Right = Math.round(rightRect.right - padding);
          if (minLeft1 < Infinity && maxRight1 > -Infinity && maxRight1 > minLeft1) {
            col1Left = Math.max(Math.round(rightRect.left), Math.round(minLeft1 - padding));
            col1Right = Math.min(Math.round(rightRect.right), Math.round(maxRight1 + padding));
          }

          c0Left = col0Left;
          c0Right = col0Right;
          c1Left = col1Left;
          c1Right = col1Right;
          gapMiddle = Math.round(spreadInfo.midGap);
          this.gapMiddle = gapMiddle;
          c0Width = Math.max(50, c0Right - c0Left);
          c1Width = Math.max(50, c1Right - c1Left);
        } else if (isVertical) {
          const tcLeft = textContainerRect ? Math.round(textContainerRect.left) : Math.round(stageRect.left);
          const tcRight = textContainerRect ? Math.round(textContainerRect.right) : Math.round(stageRect.right);
          const textMinL = minLeft0 < Infinity ? Math.round(minLeft0 - horizontalPadding) : tcLeft;
          const rawMaxR = (!this.isPdfMode && this.app?.settings?.fastReading) ? tcRight : maxRight0;
          const textMaxR = rawMaxR > -Infinity ? Math.round(rawMaxR + horizontalPadding) : tcRight;
          c0Left = Math.max(tcLeft, textMinL);
          c0Right = Math.min(tcRight, textMaxR);
          if (c0Right <= c0Left) {
            c0Left = textMinL;
            c0Right = textMaxR;
          }
          c0Left = Math.max(0, c0Left);
          c0Right = Math.min(window.innerWidth, c0Right);
          c0Width = Math.max(80, Math.round(c0Right - c0Left));
          c1Left = c0Left;
          c1Right = c0Right;
          c1Width = c0Width;
        } else if (isTwoCol) {
          const col0MaxRight = gapMiddle - 4;
          c0Left = minLeft0 < Infinity ? (minLeft0 - horizontalPadding) : (col0StageLeft - horizontalPadding);
          c0Right = maxRight0 > -Infinity ? Math.max(maxRight0 + horizontalPadding, col0StageRight) : (gapMiddle - 4);
          const col0MinLeft = Math.max(0, Math.round(col0StageLeft - horizontalPadding));
          c0Left = Math.max(col0MinLeft, Math.round(c0Left));
          c0Right = Math.min(col0MaxRight, Math.round(c0Right));
          if (c0Right <= c0Left) {
            c0Left = Math.round(stageRect.left);
            c0Right = Math.round(stageRect.right);
          }
          c0Width = Math.max(80, Math.round(c0Right - c0Left));

          const computedColWidth = Math.max(80, Math.round((textContainerWidth - colGap) / 2));
          const columnWidth = (c0Width >= 80 && Math.abs(c0Width - computedColWidth) <= 60) ? c0Width : computedColWidth;

          const col1MinLeft = gapMiddle + 4;
          let col1TargetLeft = (minLeft1 < Infinity)
            ? Math.round(minLeft1 - horizontalPadding)
            : Math.round(c0Left + columnWidth + colGap);
          if (minLeft1 < Infinity && Math.abs(col1TargetLeft - Math.round(c0Left + columnWidth + colGap)) > 40) {
            col1TargetLeft = Math.round(c0Left + columnWidth + colGap);
          }
          c1Left = Math.max(col1MinLeft, col1TargetLeft);
          c1Width = columnWidth;
          c1Right = c1Left + c1Width;
        } else {
          // Single-column mode: enforce colLeft and colWidth to align with the actual text column
          // Never extend or bleed to viewport x = 0 or window.innerWidth
          const minLineLeft = minLeft0 < Infinity ? minLeft0 : stageRect.left;
          const maxLineRight = (!this.isPdfMode && this.app?.settings?.fastReading)
            ? stageRect.right
            : (maxRight0 > -Infinity ? maxRight0 : stageRect.right);
          const hPadding = 10; // px
          c0Left = Math.max(Math.round(stageRect.left), Math.round(minLineLeft - hPadding));
          c0Right = Math.min(Math.round(stageRect.right), Math.round(maxLineRight + hPadding));
          if (c0Right <= c0Left) {
            c0Left = Math.round(stageRect.left);
            c0Right = Math.round(stageRect.right);
          }
          c0Width = Math.max(80, Math.round(c0Right - c0Left));
          c1Left = c0Left;
          c1Right = c0Right;
          c1Width = c0Width;
        }

        for (const line of this.cachedLines) {
          line.textLeft = line.left;
          line.textRight = line.right;
          line.textWidth = (line.right != null && line.left != null) ? (line.right - line.left) : null;
          if (isVertical) {
            line.columnIndex = 0;
          }
          if (line.columnIndex === 1) {
            line.columnLeft = c1Left;
            line.columnWidth = c1Width;
            line.columnRight = c1Left + c1Width;
            line.colBoundaryLeft = (isSpread && spreadInfo) ? Math.round(spreadInfo.rightRect.left) : col1StageLeft;
            line.colBoundaryRight = (isSpread && spreadInfo) ? Math.round(spreadInfo.rightRect.right) : col1StageRight;
          } else {
            line.columnLeft = c0Left;
            line.columnWidth = c0Width;
            line.columnRight = c0Left + c0Width;
            line.colBoundaryLeft = (isSpread && spreadInfo) ? Math.round(spreadInfo.leftRect.left) : col0StageLeft;
            line.colBoundaryRight = (isSpread && spreadInfo) ? Math.round(spreadInfo.leftRect.right) : col0StageRight;
          }
          if (!line.isMedia) {
            line.left = line.columnLeft;
            line.width = line.columnWidth;
            line.right = line.columnRight;
          }
        }

        this.column0Left = c0Left;
        this.column0Width = c0Width;
        this.column0Right = c0Right;
        this.column1Left = c1Left;
        this.column1Width = c1Width;
        this.column1Right = c1Right;

        this.textBlockLeft = c0Left;
        this.textBlockWidth = c0Width;
        this.lastKnownColumnLeft = c0Left;
        this.lastKnownColumnWidth = c0Width;

        // Horizontální a vertikální ohraničení aktivní čtecí zóny pro viditelnost kurzoru myši
        if ((isTwoCol || isSpread) && Number.isFinite(c1Left) && Number.isFinite(c1Right)) {
          this.readingLeft = Math.min(c0Left, c1Left);
          this.readingRight = Math.max(c0Right, c1Right);
        } else {
          this.readingLeft = c0Left;
          this.readingRight = c0Right;
        }

        const tcRect = textContainer ? textContainer.getBoundingClientRect() : stageRect;
        if (isSpread && spreadInfo) {
          this.readingTop = Math.round(Math.min(spreadInfo.leftRect.top, spreadInfo.rightRect.top));
          this.readingBottom = Math.round(Math.max(spreadInfo.leftRect.bottom, spreadInfo.rightRect.bottom));
        } else if (this.isPdfMode) {
          const canvas = document.querySelector("#reader-content canvas");
          const cRect = canvas ? canvas.getBoundingClientRect() : null;
          if (cRect && cRect.height > 50) {
            this._cachedCanvasRect = cRect;
            this.readingTop = Math.round(cRect.top);
            this.readingBottom = Math.round(cRect.bottom);
          } else {
            this.readingTop = Math.round((tcRect && tcRect.height > 50) ? tcRect.top : stageRect.top);
            this.readingBottom = Math.round((tcRect && tcRect.height > 50) ? tcRect.bottom : stageRect.bottom);
          }
        } else {
          this.readingTop = Math.round((tcRect && tcRect.height > 50) ? tcRect.top : stageRect.top);
          this.readingBottom = Math.round((tcRect && tcRect.height > 50) ? tcRect.bottom : stageRect.bottom);
        }

        if (isVertical && Number.isFinite(this.currentY) && this.cachedLines.length > 0) {
          const targetCenter = this.currentY + this.height / 2;
          let bestIdx = 0;
          let minDiff = Infinity;
          for (let i = 0; i < this.cachedLines.length; i++) {
            const diff = Math.abs(this.cachedLines[i].centerY - targetCenter);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = i;
            }
          }
          this.activeLineIndex = bestIdx;
        } else if (this.activeLineIndex >= this.cachedLines.length) {
          this.activeLineIndex = Math.max(0, this.cachedLines.length - 1);
        }
      }

      // --- Uniform Auto-Height Calculation per Font Size ---
      this.lineHeightByFontSize = new Map();

      // Step A (Group by Font Size): Group non-media lines by their rounded fontSize
      const linesByFontSize = new Map();
      for (const line of this.cachedLines) {
        if (line.isMedia || !line.hasText) continue;
        const fs = Math.round(line.fontSize || 16);
        if (!linesByFontSize.has(fs)) {
          linesByFontSize.set(fs, []);
        }
        linesByFontSize.get(fs).push(line);
      }

      // In PDF mode, absorb ±1px font-matrix rounding jitter into the canonical fontSize bucket
      if (this.isPdfMode && linesByFontSize.size > 1) {
        const sortedBuckets = Array.from(linesByFontSize.entries()).sort((a, b) => b[1].length - a[1].length);
        const getMedianH = (arr) => {
          const hs = arr.map(l => l.height).filter(h => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
          return hs.length > 0 ? hs[Math.floor(hs.length / 2)] : 16;
        };
        const mergedKeys = new Set();
        for (let i = 0; i < sortedBuckets.length; i++) {
          const [canonFs, canonLines] = sortedBuckets[i];
          if (mergedKeys.has(canonFs)) continue;
          const canonMedH = getMedianH(canonLines);
          for (let j = i + 1; j < sortedBuckets.length; j++) {
            const [otherFs, otherLines] = sortedBuckets[j];
            if (mergedKeys.has(otherFs)) continue;
            if (Math.abs(otherFs - canonFs) <= 1) {
              const otherMedH = getMedianH(otherLines);
              if (Math.abs(otherMedH - canonMedH) <= 2.5) {
                for (const l of otherLines) {
                  l.fontSize = canonFs;
                  canonLines.push(l);
                }
                linesByFontSize.delete(otherFs);
                mergedKeys.add(otherFs);
              }
            }
          }
        }
      }

      const getBlockElement = (line) => {
        if (line.blockElement) return line.blockElement;
        const el = line.element || line.el;
        if (!el || typeof el.closest !== 'function') return el || null;
        return el.closest('p, blockquote, li, h1, h2, h3, h4, h5, h6, div') || el;
      };

      let dominantFontSize = null;
      let maxGroupCount = -1;
      const groupMedianGlyphHeights = new Map();

      // Step B (Calculate Uniform Height per Font Size):
      for (const [fs, groupLines] of linesByFontSize.entries()) {
        if (groupLines.length > maxGroupCount) {
          maxGroupCount = groupLines.length;
          dominantFontSize = fs;
        }

        // Measure the median glyph box height (line.height) for that fontSize
        const glyphHeights = groupLines.map(l => l.height).filter(h => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
        const medianGlyphHeight = glyphHeights.length > 0
          ? glyphHeights[Math.floor(glyphHeights.length / 2)]
          : (fs * 1.15);
        groupMedianGlyphHeights.set(fs, medianGlyphHeight);
        this.glyphHeightByFontSize.set(fs, medianGlyphHeight);

        if (this.isPdfMode) {
          // PDF Mode:
          // 1. Collect consecutive pitches on the same column and same PDF page slot for lines of the same font size
          const candidatePitches = [];
          for (let i = 0; i < this.cachedLines.length - 1; i++) {
            const cur = this.cachedLines[i];
            const next = this.cachedLines[i + 1];
            if (cur.columnIndex === next.columnIndex && !cur.isMedia && !next.isMedia) {
              const sameSlot = !cur.pageSlot || !next.pageSlot || cur.pageSlot === next.pageSlot;
              if (!sameSlot) continue;
              const curFs = Math.round(cur.fontSize || 16);
              const nextFs = Math.round(next.fontSize || 16);
              if (Math.abs(curFs - fs) <= 1 && Math.abs(nextFs - fs) <= 1) {
                const pitch = next.centerY - cur.centerY;
                const minP = Math.min(fs, medianGlyphHeight) * 0.95;
                const maxP = Math.max(fs, medianGlyphHeight) * 2.2;
                if (pitch >= minP && pitch <= maxP) {
                  candidatePitches.push(pitch);
                }
              }
            }
          }

          // Filter out inter-paragraph gaps (since all PDF spans share div.textLayer)
          let medianPitch = null;
          if (candidatePitches.length > 0) {
            candidatePitches.sort((a, b) => a - b);
            const refPitch = candidatePitches[Math.floor(candidatePitches.length * 0.35)];
            const intraParaPitches = candidatePitches.filter(
              p => p <= refPitch * 1.22 && p <= medianGlyphHeight * 1.65
            );
            const validPitches = intraParaPitches.length > 0 ? intraParaPitches : candidatePitches;
            medianPitch = validPitches[Math.floor(validPitches.length / 2)];
          }

          // 2. Strictly wrap the text line with minimal, uniform vertical padding (never expanding into margins)
          const compactPadY = Math.max(1, Math.min(2, Math.round(medianGlyphHeight * 0.08)));
          let targetHeight = Math.round(medianGlyphHeight + compactPadY * 2);

          // 3. Cap by intra-paragraph non-overlap clearance so middle lines and boundary/isolated lines
          //    share the exact same compact height without middle-only shrinking or boundary shifting
          if (medianPitch != null && medianPitch > 0) {
            const maxNonOverlapH = Math.floor(2 * medianPitch - medianGlyphHeight - 2);
            const maxPitchH = Math.floor(medianPitch - 2);
            const collisionSafeH = Math.max(Math.round(medianGlyphHeight), Math.min(maxNonOverlapH, maxPitchH));
            targetHeight = Math.min(targetHeight, collisionSafeH);
          }

          this.lineHeightByFontSize.set(fs, targetHeight);
        } else {
          // EPUB Mode:
          // 1. Measure the median intra-paragraph line pitch (next.centerY - cur.centerY for consecutive lines
          //    in the same column and same block element where pitch >= fontSize * 1.05 && pitch <= fontSize * 2.8)
          const intraBlockPitches = [];
          for (let i = 0; i < this.cachedLines.length - 1; i++) {
            const cur = this.cachedLines[i];
            const next = this.cachedLines[i + 1];
            if (cur.columnIndex === next.columnIndex && !cur.isMedia && !next.isMedia) {
              const curFs = Math.round(cur.fontSize || 16);
              const nextFs = Math.round(next.fontSize || 16);
              if (curFs === fs && nextFs === fs) {
                const blockA = getBlockElement(cur);
                const blockB = getBlockElement(next);
                if (blockA && blockB && blockA === blockB) {
                  const pitch = next.centerY - cur.centerY;
                  if (pitch >= fs * 1.05 && pitch <= fs * 2.8) {
                    intraBlockPitches.push(pitch);
                  }
                }
              }
            }
          }

          let medianPitch = null;
          if (intraBlockPitches.length > 0) {
            intraBlockPitches.sort((a, b) => a - b);
            medianPitch = intraBlockPitches[Math.floor(intraBlockPitches.length / 2)];
          }

          let fallbackPitch = 0;
          if (medianPitch == null || medianPitch <= 0) {
            try {
              const sampleEl = groupLines[0]?.element || groupLines[0]?.blockElement || content?.querySelector('p, div, li, blockquote') || content;
              if (sampleEl) {
                const cs = window.getComputedStyle(sampleEl);
                const parsedLh = parseFloat(cs.lineHeight);
                if (Number.isFinite(parsedLh) && parsedLh > 0) {
                  if (parsedLh < 4) {
                    fallbackPitch = fs * parsedLh;
                  } else {
                    fallbackPitch = parsedLh;
                  }
                }
              }
            } catch (e) {}

            if (!fallbackPitch || fallbackPitch < fs * 1.05) {
              const settingsLh = parseFloat(this.app?.settings?.lineHeight) || 1.45;
              fallbackPitch = fs * (settingsLh >= 1.05 ? settingsLh : 1.45);
            }
          }

          const effectivePitch = (medianPitch != null && medianPitch > 0) ? medianPitch : fallbackPitch;
          if (effectivePitch > 0) {
            this.pitchByFontSize.set(fs, effectivePitch);
          }

          // Normalize EPUB line top/bottom using medianGlyphHeight from the true measured line.centerY
          for (const l of groupLines) {
            l.rawTop = l.rawTop ?? l.top;
            l.rawBottom = l.rawBottom ?? l.bottom;
            l.height = medianGlyphHeight;
            l.top = l.centerY - medianGlyphHeight / 2;
            l.bottom = l.centerY + medianGlyphHeight / 2;
            if (effectivePitch > 0) {
              l.linePitch = effectivePitch;
            }
          }

          let targetHeight = Math.round(medianGlyphHeight + 4);
          if (effectivePitch > 0) {
            targetHeight = Math.min(targetHeight, Math.max(Math.round(medianGlyphHeight + 2), Math.floor(effectivePitch - 3)));
            const maxNonOverlapH = Math.floor(2 * effectivePitch - medianGlyphHeight - 2);
            if (maxNonOverlapH >= Math.round(medianGlyphHeight) && targetHeight > maxNonOverlapH) {
              targetHeight = maxNonOverlapH;
            }
          }

          // 6. Store this map on this.lineHeightByFontSize
          this.lineHeightByFontSize.set(fs, targetHeight);
        }
      }

      // In PDF mode, ensure standalone fontSize groups use the same tight vertical padding as the dominant body text
      if (this.isPdfMode && dominantFontSize && this.lineHeightByFontSize.has(dominantFontSize)) {
        const domH = this.lineHeightByFontSize.get(dominantFontSize);
        const domGlyphH = groupMedianGlyphHeights.get(dominantFontSize) || dominantFontSize;
        const domTotalPad = Math.max(0, Math.min(4, Math.round(domH - domGlyphH)));
        for (const [fs, h] of this.lineHeightByFontSize.entries()) {
          if (fs === dominantFontSize) continue;
          const gH = groupMedianGlyphHeights.get(fs) || fs;
          const alignedH = Math.round(gH + domTotalPad);
          if (h > alignedH) {
            this.lineHeightByFontSize.set(fs, alignedH);
          }
        }
      }

      // Set this.uniformLineHeight to the height of the dominant body fontSize
      if (dominantFontSize && this.lineHeightByFontSize.has(dominantFontSize)) {
        this.uniformLineHeight = this.lineHeightByFontSize.get(dominantFontSize);
      } else {
        this.uniformLineHeight = this.isPdfMode ? 20 : (this.manualHeight || 36);
      }

      // Step C (EPUB Canonical Top-of-Column Anchoring):
      // Anchor column-top body text lines to a canonical offset across pages so Line 0
      // sits at the exact invariant distance from the column top without jitter or drift.
      if (!this.isPdfMode && !isVertical && this.cachedLines.length > 0) {
        const domFs = dominantFontSize || Math.round(this.cachedLines[0]?.fontSize || 16);
        const domGlyphH = this.glyphHeightByFontSize.get(domFs) || (domFs * 1.15);

        for (let colIdx = 0; colIdx < (isTwoCol ? 2 : 1); colIdx++) {
          const colLines = this.cachedLines.filter(l => (l.columnIndex ?? 0) === colIdx && !l.isMedia && l.hasText);
          if (colLines.length === 0) continue;

          const firstLine = colLines[0];
          const lineFs = Math.round(firstLine.fontSize || 16);
          const isStandardBody = (lineFs === domFs);
          const blockEl = getBlockElement(firstLine);
          const isStandardParagraph = blockEl && blockEl.tagName === "P";
          const isHeading = !!(blockEl && /^(H[1-6]|HEADER)$/i.test(blockEl.tagName));
          const relativeTop = firstLine.top - stageTop;
          const isNearColTop = relativeTop >= -10 && relativeTop <= Math.max(30, domFs * 2);

          if (isStandardBody && !isHeading && isNearColTop && this._canonicalColTopOffsets) {
            const layoutKey = `${domFs}_${Math.round(stageTop)}_${colIdx}_${isTwoCol ? 2 : 1}`;
            const relCenterY = firstLine.centerY - stageTop;

            if (this._canonicalColTopOffsets.has(layoutKey)) {
              const cached = this._canonicalColTopOffsets.get(layoutKey);
              const canonicalRelY = typeof cached === "object" ? cached.relCenterY : cached;
              const canonicalGlyphH = (typeof cached === "object" && cached.glyphH) ? cached.glyphH : domGlyphH;
              const maxTolerance = Math.max(4, domFs * 0.25);

              if (Math.abs(relCenterY - canonicalRelY) <= maxTolerance) {
                firstLine.centerY = stageTop + canonicalRelY;
                firstLine.height = canonicalGlyphH;
                firstLine.top = firstLine.centerY - canonicalGlyphH / 2;
                firstLine.bottom = firstLine.centerY + canonicalGlyphH / 2;
              }
            } else if (isStandardParagraph) {
              this._canonicalColTopOffsets.set(layoutKey, { relCenterY, glyphH: domGlyphH });
            }
          }
        }
      }

      // Clear cached line geometry after Step B normalization & grid regularization
      this._lastComputedLineGeom = null;

      if (this.isPdfMode) {
        if (!this.pdfAutoHeight) {
          this.height = this.pdfRulerHeight || this.manualHeight || 32;
          this.uniformLineHeight = this.height;
        } else {
          this.pdfStandardLineHeight = this.uniformLineHeight;
          if (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
            const geom = this.computeLineGeometry(this.activeLineIndex);
            this.height = geom ? geom.height : (this.uniformLineHeight || 24);
          } else {
            this.height = this.uniformLineHeight || 24;
          }
        }
      } else {
        if (this.autoHeight) {
          this.height = this.uniformLineHeight;
        } else {
          this.height = this.manualHeight || 36;
          this.uniformLineHeight = this.height;
        }
      }

      if (!this.isPageTransitioning && this.cachedLines.length > 0) {
        this.updateStyles();
      }

      if (!this.cachedLines || this.cachedLines.length === 0) {
        this._lastEmptyDetectTime = performance.now();
      } else {
        this._lastEmptyDetectTime = 0;
      }
      return this.cachedLines;
    } catch (err) {
      console.error("[ReadingRuler] Error in detectLines:", err);
      this.cachedLines = [];
      this._lastEmptyDetectTime = performance.now();
      return [];
    } finally {
      try {
        range.detach();
      } catch (e) {}
    }
  }

  refreshLines() {
    this._lastComputedLineGeom = null;
    this._lastEmptyDetectTime = 0;
    this._lastActiveLineIndex = -1;
    this._lastActiveColumn = null;
    this._clearWordCache();
    this._activeReadingLineIndex = -1;
    this._activeLineStartTime = 0;
    this._completedLineIndices = new Set();
    this._lastWordLineIndex = -1;
    this._lastWordIndex = -1;
    this._wordsReadOnPage = new Set();
    return this.detectLines(true);
  }

  refreshLinesDebounced(delay = 150) {
    if (this._refreshLinesDebounceTimer) {
      clearTimeout(this._refreshLinesDebounceTimer);
    }
    this._refreshLinesDebounceTimer = setTimeout(() => {
      this._refreshLinesDebounceTimer = null;
      if (!this.enabled) return;
      this.refreshLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
    }, delay);
  }

  /**
   * Vymaže mezipaměť slov a asociovaná slova pro řádky.
   */
  _clearWordCache() {
    this._lineWordsCache = new Map();
    if (this.cachedLines) {
      for (let i = 0; i < this.cachedLines.length; i++) {
        this.cachedLines[i].words = null;
        this.cachedLines[i].wordIndices = [];
      }
    }
    this.cachedWords = [];
  }

  /**
   * Získá slova pro konkrétní řádek (lazy-load z cache nebo cíleným skenem jediného elementu/odstavce).
   */
  getWordsForLine(lineIdx) {
    if (lineIdx < 0 || !this.cachedLines || lineIdx >= this.cachedLines.length) {
      return [];
    }
    const line = this.cachedLines[lineIdx];
    if (!line || line.isMedia || !line.hasText) {
      return [];
    }
    if (line.words && Array.isArray(line.words)) {
      return line.words;
    }
    if (this._lineWordsCache && this._lineWordsCache.has(lineIdx)) {
      const cached = this._lineWordsCache.get(lineIdx);
      line.words = cached;
      return cached;
    }
    return this._computeWordsForLine(lineIdx);
  }

  /**
   * Cílený prostorový výpočet souřadnic slov pouze pro blok / element obsahující daný řádek.
   * Eliminuje layout thrashing na celé stránce a redukuje počet měřených slov z 300–600 na 8–15.
   */
  _computeWordsForLine(lineIdx) {
    const line = this.cachedLines[lineIdx];
    if (!line || line.isMedia || !line.hasText) {
      return [];
    }
    if (!this._lineWordsCache) this._lineWordsCache = new Map();

    const isVertical = this.isVerticalMode();
    const viewport = isVertical ? (this._cachedViewportEl || document.getElementById("paged-viewport") || document.querySelector(".paged-viewport")) : null;
    const vScrollTop = (isVertical && viewport) ? viewport.scrollTop : 0;
    const stage = this.container || document.getElementById("paged-stage");
    const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    const stageLeft = stageRect.left;
    const stageRight = stageRect.right;
    const stageTop = stageRect.top;
    const stageBottom = stageRect.bottom;
    const hasValidStageBounds = stageRect.width > 50 && stageRect.height > 50;
    const isSpread = !isVertical && this.isSpreadActive();
    const spreadInfo = isSpread ? this.getActiveSpreadInfo(line) : null;
    const isTwoCol = !isVertical && (this.isTwoCol || isSpread);
    const stageCenterX = stageRect.left + stageRect.width / 2;
    const splitX = (isSpread && spreadInfo) ? spreadInfo.midGap : (isTwoCol && this.gapMiddle ? this.gapMiddle : stageCenterX);

    let container = line.blockElement;
    if (!container && line.element) {
      container = line.element.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, div, td, th, pre, dd, dt") || line.element;
    }
    if (!container) {
      container = line.el || line.element;
    }
    if (!container) {
      line.words = [];
      this._lineWordsCache.set(lineIdx, []);
      return [];
    }

    let pdfTf = null;
    if (this.isPdfMode || line.isPdfLine) {
      const textLayer = container.closest(".textLayer") || (line.element ? line.element.closest(".textLayer") : null);
      if (textLayer) {
        const slot = textLayer.closest(".pdf-page-container, .pdf-page-slot") || textLayer.parentElement;
        const canvas = slot ? slot.querySelector("canvas") : document.querySelector("#reader-content canvas");
        if (canvas) {
          const canvasRect = canvas.getBoundingClientRect();
          const textLayerRect = textLayer.getBoundingClientRect();
          if (canvasRect.height > 10 && textLayerRect.height > 10) {
            pdfTf = {
              canvasRect,
              textLayerRect,
              scaleY: canvasRect.height / textLayerRect.height,
              scaleX: (canvasRect.width > 10 && textLayerRect.width > 10) ? (canvasRect.width / textLayerRect.width) : 1
            };
          }
        }
      }
    }

    // Identifikace kandidátních řádků spadajících pod tentýž kontejner
    const candidateLines = [];
    for (let j = 0; j < this.cachedLines.length; j++) {
      const cl = this.cachedLines[j];
      if (cl.isMedia) continue;
      if (cl.blockElement === container || cl.element === container || (cl.element && container.contains(cl.element))) {
        candidateLines.push({ line: cl, index: j });
      }
    }
    if (candidateLines.length === 0) {
      candidateLines.push({ line, index: lineIdx });
    }

    const words = [];
    const range = document.createRange();
    const wordRegex = /[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/g;
    const leadingNonSpaceRegex = /^[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/;
    const invisibleStripRegex = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;
    const visitedBionicSpans = new Set();
    const consumedTextOffsets = new Map();

    const pushRangeRectsToWords = (cleanToken) => {
      const clientRects = range.getClientRects();
      if (!clientRects || clientRects.length === 0) return;

      // Seskupení fragmentů téhož slova (např. Bionic fixace <b class="bionic-fixation">wor</b>d)
      // ležících na stejném řádku do jednoho kompaktního rámečku celého slova
      const lineClusters = [];
      for (let rIdx = 0; rIdx < clientRects.length; rIdx++) {
        const rect = clientRects[rIdx];
        if (!rect || rect.width <= 0.5 || rect.height <= 2) continue;
        const cy = (rect.top + rect.bottom) / 2;
        let matchedCluster = null;
        for (const cl of lineClusters) {
          if (Math.abs(cl.centerY - cy) <= 8 || Math.abs(cl.top - rect.top) <= 6) {
            matchedCluster = cl;
            break;
          }
        }
        if (matchedCluster) {
          matchedCluster.rects.push(rect);
          matchedCluster.top = Math.min(matchedCluster.top, rect.top);
          matchedCluster.bottom = Math.max(matchedCluster.bottom, rect.bottom);
          matchedCluster.left = Math.min(matchedCluster.left, rect.left);
          matchedCluster.right = Math.max(matchedCluster.right, rect.right);
          matchedCluster.centerY = (matchedCluster.top + matchedCluster.bottom) / 2;
        } else {
          lineClusters.push({
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            centerY: cy,
            rects: [rect]
          });
        }
      }

      for (const cl of lineClusters) {
        let rTop = cl.top;
        let rBottom = cl.bottom;
        let rHeight = rBottom - rTop;
        let rLeft = cl.left;
        let rRight = cl.right;

        if (pdfTf) {
          const relTop = rTop - pdfTf.textLayerRect.top;
          const relBottom = rBottom - pdfTf.textLayerRect.top;
          rTop = pdfTf.canvasRect.top + relTop * pdfTf.scaleY;
          rBottom = pdfTf.canvasRect.top + relBottom * pdfTf.scaleY;
          rHeight = rBottom - rTop;

          const relLeft = rLeft - pdfTf.textLayerRect.left;
          const relRight = rRight - pdfTf.textLayerRect.left;
          rLeft = pdfTf.canvasRect.left + relLeft * pdfTf.scaleX;
          rRight = pdfTf.canvasRect.left + relRight * pdfTf.scaleX;
        }

        const rWidth = rRight - rLeft;
        if (
          rWidth > 0.5 &&
          rHeight > 2 &&
          rRight > stageLeft + 2 &&
          rLeft < stageRight - 2 &&
          (isVertical || (rBottom > stageTop && rTop < stageBottom))
        ) {
          if (!isVertical && hasValidStageBounds) {
            const midX = (rLeft + rRight) / 2;
            if (midX <= stageLeft + 2 || midX >= stageRight - 2) continue;
          }
          words.push({
            text: cleanToken,
            left: rLeft,
            right: rRight,
            top: rTop + vScrollTop,
            bottom: rBottom + vScrollTop,
            width: rWidth,
            height: rHeight,
            centerX: rLeft + rWidth / 2,
            centerY: rTop + rHeight / 2 + vScrollTop
          });
        }
      }
    };

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "PICTURE" || tag === "BUTTON") {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;

      const bionicSpan = parent.closest(".bionic-word");
      if (bionicSpan) {
        if (visitedBionicSpans.has(bionicSpan)) continue;
        visitedBionicSpans.add(bionicSpan);
        const cleanToken = bionicSpan.textContent.replace(invisibleStripRegex, "").trim();
        if (!cleanToken) continue;
        try {
          range.selectNodeContents(bionicSpan);
          pushRangeRectsToWords(cleanToken);
        } catch (e) {}
        continue;
      }

      const isBionicFixationEl = parent.tagName === "B" && (parent.classList.contains("bionic-fixation") || parent.classList.contains("bionic-bold"));
      if (isBionicFixationEl) {
        if (visitedBionicSpans.has(parent)) continue;
        visitedBionicSpans.add(parent);
        let rawToken = parent.textContent || "";
        let startNode = node;
        let startOffset = 0;
        let endNode = node;
        let endOffset = (node.textContent || "").length;
        const nextSib = parent.nextSibling;
        if (nextSib && nextSib.nodeType === Node.TEXT_NODE) {
          const t = nextSib.textContent || "";
          const m = leadingNonSpaceRegex.exec(t);
          if (m && m[0].length > 0) {
            rawToken += m[0];
            endNode = nextSib;
            endOffset = m[0].length;
            consumedTextOffsets.set(nextSib, m[0].length);
          }
        }
        const cleanToken = rawToken.replace(invisibleStripRegex, "").trim();
        if (cleanToken) {
          try {
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            pushRangeRectsToWords(cleanToken);
          } catch (e) {}
        }
        continue;
      }

      const text = node.textContent;
      if (!text || !text.trim()) continue;
      const consumedStart = consumedTextOffsets.get(node) || 0;
      if (consumedStart >= text.length) continue;

      let match;
      wordRegex.lastIndex = consumedStart;
      while ((match = wordRegex.exec(text)) !== null) {
        const rawToken = match[0];
        const start = match.index;
        const end = start + rawToken.length;
        const cleanToken = rawToken.replace(invisibleStripRegex, "").trim();
        if (!cleanToken) continue;
        try {
          range.setStart(node, start);
          range.setEnd(node, end);
          pushRangeRectsToWords(cleanToken);
        } catch (e) {}
      }
    }

    try { range.detach(); } catch (e) {}

    const punctOnlyRegex = /^[-–—­‐.,;!?]+$/;
    const mergedWords = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (punctOnlyRegex.test(w.text)) {
        if (mergedWords.length > 0) {
          const prev = mergedWords[mergedWords.length - 1];
          const sameLine = Math.abs(w.centerY - prev.centerY) <= 8 || Math.abs(w.top - prev.top) <= 6;
          const isAdjacent = w.left >= prev.left - 2 && (w.left - prev.right) <= 5;
          if (sameLine && isAdjacent) {
            prev.right = Math.max(prev.right, w.right);
            prev.left = Math.min(prev.left, w.left);
            prev.top = Math.min(prev.top, w.top);
            prev.bottom = Math.max(prev.bottom, w.bottom);
            prev.width = prev.right - prev.left;
            prev.height = prev.bottom - prev.top;
            prev.centerX = prev.left + prev.width / 2;
            prev.centerY = prev.top + prev.height / 2;
            prev.text = prev.text + w.text;
            continue;
          }
        }
        continue;
      }
      mergedWords.push(w);
    }

    for (const w of mergedWords) {
      let bestCandIdx = candidateLines[0].index;
      let minDiff = Infinity;
      const isWordCol1 = isTwoCol && (w.centerX >= splitX);

      for (let c = 0; c < candidateLines.length; c++) {
        const cl = candidateLines[c].line;
        const cIdx = candidateLines[c].index;
        if (isTwoCol && (cl.columnIndex === 1) !== isWordCol1) continue;
        const dy = (w.centerY < cl.top) ? (cl.top - w.centerY) : (w.centerY > cl.bottom) ? (w.centerY - cl.bottom) : 0;
        const diff = dy * 3 + Math.abs(w.centerY - cl.centerY);
        if (diff < minDiff) {
          minDiff = diff;
          bestCandIdx = cIdx;
        }
      }
      w.lineIndex = bestCandIdx;
    }

    for (const cand of candidateLines) {
      const clIdx = cand.index;
      const cl = cand.line;
      const lineWords = mergedWords.filter(w => w.lineIndex === clIdx);
      lineWords.sort((a, b) => a.left - b.left);
      cl.words = lineWords;
      cl.wordIndices = lineWords.map((_, idx) => idx);
      this._lineWordsCache.set(clIdx, lineWords);
    }

    return line.words || [];
  }

  /**
   * Zajistí načtení slov pro aktivní řádek a nastaví je do this.cachedWords.
   * Volitelně pre-fetchuje slova pro sousední řádky.
   */
  ensureActiveWords(lineIdx) {
    if (lineIdx < 0 || !this.cachedLines || lineIdx >= this.cachedLines.length) {
      this.cachedWords = [];
      return [];
    }
    const words = this.getWordsForLine(lineIdx);
    this.cachedWords = words;
    if (lineIdx > 0) this.getWordsForLine(lineIdx - 1);
    if (lineIdx + 1 < this.cachedLines.length) this.getWordsForLine(lineIdx + 1);
    return words;
  }

  /**
   * Zmapuje slova pro aktuální řádek a invaliduje mezipaměť (nahrazuje původní full-page scan).
   */
  refreshWords() {
    this._clearWordCache();
    if (!this.enabled || !this.wordTracking || this.isImageOnlyPdf) {
      this.cachedWords = [];
      return [];
    }
    const targetIdx = (this.activeLineIndex >= 0 && this.activeLineIndex < (this.cachedLines?.length || 0))
      ? this.activeLineIndex
      : 0;
    return this.ensureActiveWords(targetIdx);
  }

  /**
   * Spočítá stabilní horizontální ohraničení textového bloku / sloupce pro konkrétní stránku.
   * V PDF vertikálním módu zaručuje, že se vodicí linka neroztahuje přes celou obrazovku,
   * ale drží pevnou konzistentní šířku odpovídající textovému sloupci na dané stránce
   * (bez poskakování či změn délky u jednotlivých kratších řádků).
   */
  getPageTextColumnBounds(currentLine) {
    const isVertical = this.isVerticalMode();
    const isSpread = !isVertical && this.isSpreadActive();
    const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
    const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, width: window.innerWidth };

    const lineEl = currentLine ? (currentLine.element || currentLine.el) : null;
    let pdfPage = null;
    let canvasRect = null;
    const padding = 12; // px jednotný offset pro odsazení pravítka

    if (isSpread) {
      const spreadInfo = this.getActiveSpreadInfo(currentLine);
      if (spreadInfo) {
        pdfPage = spreadInfo.activeSlot;
        canvasRect = spreadInfo.activeRect;
      }
    }

    if (!pdfPage) {
      pdfPage = lineEl ? lineEl.closest(".pdf-page-container, .pdf-page-slot") : null;
    }

    if (!pdfPage) {
      const pdfContainers = document.querySelectorAll("#reader-content .pdf-page-container, #reader-content .pdf-page-slot");
      if (pdfContainers.length === 1) {
        pdfPage = pdfContainers[0];
      } else if (pdfContainers.length > 1) {
        const lineY = Number.isFinite(currentLine?.centerY) ? currentLine.centerY : (this.currentY || (window.innerHeight / 2));
        const viewport = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
        const vScrollTop = (isVertical && viewport) ? viewport.scrollTop : 0;
        const screenY = lineY - vScrollTop;
        let minDist = Infinity;
        for (const c of pdfContainers) {
          const r = c.getBoundingClientRect();
          if (r.bottom >= 0 && r.top <= window.innerHeight) {
            const dist = Math.abs((r.top + r.bottom) / 2 - screenY);
            if (dist < minDist) {
              minDist = dist;
              pdfPage = c;
            }
          }
        }
        if (!pdfPage) pdfPage = pdfContainers[0];
      }
    }

    if (!canvasRect && pdfPage) {
      const canvas = pdfPage.querySelector("canvas") || pdfPage;
      const cr = canvas.getBoundingClientRect();
      if (cr.width > 50) {
        canvasRect = cr;
      }
    }

    // 1. Zkusíme odvodit stabilní textový sloupec ze všech řádků na dané stránce
    if (pdfPage && this.cachedLines && this.cachedLines.length > 0) {
      let minLeft = Infinity;
      let maxRight = -Infinity;
      let textLineCount = 0;

      for (const l of this.cachedLines) {
        if (l.isMedia) continue;
        const el = l.element || l.el;
        const belongsToPage = (el && (pdfPage.contains(el) || el.closest(".pdf-page-container, .pdf-page-slot") === pdfPage)) ||
          (isSpread && currentLine && l.columnIndex === currentLine.columnIndex);
        if (belongsToPage) {
          const lLeft = Number.isFinite(l.textLeft) ? l.textLeft : (Number.isFinite(l.left) ? l.left : null);
          const lRight = Number.isFinite(l.textRight) ? l.textRight : (Number.isFinite(l.right) ? l.right : null);
          if (lLeft !== null && lRight !== null && lRight > lLeft) {
            minLeft = Math.min(minLeft, lLeft);
            maxRight = Math.max(maxRight, lRight);
            textLineCount++;
          }
        }
      }

      if (textLineCount > 0 && minLeft < Infinity && maxRight > -Infinity && maxRight > minLeft) {
        let colLeft = Math.round(minLeft - padding);
        let colRight = Math.round(maxRight + padding);
        if (canvasRect) {
          colLeft = Math.max(Math.round(canvasRect.left), colLeft);
          colRight = Math.min(Math.round(canvasRect.right), colRight);
        }
        if (colRight > colLeft + 50) {
          return { left: colLeft, width: colRight - colLeft };
        }
      }
    }

    // 2. Pokud nemáme řádky specifické pro stránku, a NEJSME ve spread módu, zkusíme globální min/max z cachedLines
    if (!isSpread && this.cachedLines && this.cachedLines.length > 0) {
      let minLeft = Infinity;
      let maxRight = -Infinity;
      let textLineCount = 0;
      for (const l of this.cachedLines) {
        if (l.isMedia) continue;
        const lLeft = Number.isFinite(l.textLeft) ? l.textLeft : null;
        const lRight = Number.isFinite(l.textRight) ? l.textRight : null;
        if (lLeft !== null && lRight !== null && lRight > lLeft) {
          minLeft = Math.min(minLeft, lLeft);
          maxRight = Math.max(maxRight, lRight);
          textLineCount++;
        }
      }
      if (textLineCount > 0 && minLeft < Infinity && maxRight > -Infinity && maxRight > minLeft) {
        let colLeft = Math.round(minLeft - padding);
        let colRight = Math.round(maxRight + padding);
        if (canvasRect) {
          colLeft = Math.max(Math.round(canvasRect.left), colLeft);
          colRight = Math.min(Math.round(canvasRect.right), colRight);
        }
        if (colRight > colLeft + 50) {
          return { left: colLeft, width: colRight - colLeft };
        }
      }
    }

    // 3. Fallback na rozměry plátna stránky (canvas), pokud textová vrstva není dostupná
    if (canvasRect && canvasRect.width > 50) {
      if (isSpread) {
        const pad = Math.min(padding, Math.round(canvasRect.width * 0.05));
        return {
          left: Math.round(canvasRect.left + pad),
          width: Math.round(canvasRect.width - (pad * 2))
        };
      }
      return {
        left: Math.round(canvasRect.left),
        width: Math.round(canvasRect.width)
      };
    }

    // 4. Fallback na cached columnLeft/columnWidth pokud je rozumné (ne přes celou obrazovku)
    if (currentLine && Number.isFinite(currentLine.columnLeft) && Number.isFinite(currentLine.columnWidth) && currentLine.columnWidth > 50) {
      let cLeft = currentLine.columnLeft;
      let cWidth = currentLine.columnWidth;
      if (canvasRect && canvasRect.width > 50) {
        cLeft = Math.max(canvasRect.left, cLeft);
        if (cLeft + cWidth > canvasRect.right) {
          cWidth = Math.max(50, canvasRect.right - cLeft);
        }
      }
      if (cWidth < window.innerWidth - 20) {
        return {
          left: Math.round(cLeft),
          width: Math.round(cWidth)
        };
      }
    }

    // 5. Poslední fallback na stage ohraničení (nebo canvasRect)
    if (canvasRect && canvasRect.width > 50) {
      return {
        left: Math.round(canvasRect.left),
        width: Math.round(canvasRect.width)
      };
    }
    return {
      left: Math.round(stageRect.left),
      width: Math.round(stageRect.width)
    };
  }

  computeLineGeometry(lineIdx) {
    if (!this.cachedLines || this.cachedLines.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(this.cachedLines.length - 1, lineIdx));
    const currentAutoHeight = this.isPdfMode ? this.pdfAutoHeight : this.autoHeight;
    const currentManualHeight = this.isPdfMode ? this.pdfRulerHeight : this.manualHeight;
    if (
      this._lastComputedLineGeom &&
      this._lastComputedLineGeom.index === clampedIdx &&
      this._lastComputedLineGeom.mode === this.mode &&
      this._lastComputedLineGeom.style === (this.style || this.mode) &&
      this._lastComputedLineGeom.autoHeight === currentAutoHeight &&
      this._lastComputedLineGeom.manualHeight === currentManualHeight &&
      this._lastComputedLineGeom.linesRef === this.cachedLines
    ) {
      return this._lastComputedLineGeom.geom;
    }
    const line = this.cachedLines[clampedIdx];

    // Kontrola sousedních řádků ve stejném sloupci (a na téže PDF straně) pro zamezení přesahu do řádku nahoře i dole
    const lineSlot = line.pageSlot || (line.element || line.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
    let prevLine = null;
    for (let p = clampedIdx - 1; p >= 0; p--) {
      const cand = this.cachedLines[p];
      if (cand.columnIndex === line.columnIndex) {
        const candSlot = cand.pageSlot || (cand.element || cand.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
        if (!lineSlot || !candSlot || lineSlot === candSlot) {
          prevLine = cand;
        }
        break;
      }
    }

    let nextLine = null;
    for (let n = clampedIdx + 1; n < this.cachedLines.length; n++) {
      const cand = this.cachedLines[n];
      if (cand.columnIndex === line.columnIndex) {
        const candSlot = cand.pageSlot || (cand.element || cand.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
        if (!lineSlot || !candSlot || lineSlot === candSlot) {
          nextLine = cand;
        }
        break;
      }
    }

    if (line.isMedia) {
      const padding = 10;
      const mediaH = Math.round(line.mediaHeight ?? line.height);
      const mediaW = Math.round(line.mediaWidth ?? line.width);
      const mediaL = Math.round(line.mediaLeft ?? line.left);
      const mediaT = Math.round(line.top);

      let height = Math.round(mediaH + (padding * 2));
      let targetY = Math.round(mediaT - padding);

      // Collision prevention se sousedními řádky
      if (prevLine && Number.isFinite(prevLine.bottom) && targetY <= prevLine.bottom) {
        targetY = Math.round(prevLine.bottom + 1);
      }
      if (nextLine && Number.isFinite(nextLine.top) && targetY + height >= nextLine.top) {
        height = Math.max(mediaH, Math.round(nextLine.top - 1 - targetY));
      }

      let lineTop = Math.min(mediaT, targetY);
      let lineBottom = Math.max(mediaT + mediaH, targetY + height);

      if (this.mode === "bottom-cover" || this.style === "bottom-cover") {
        let hasNext = false;
        if (nextLine && (nextLine.columnIndex === line.columnIndex || (line.columnIndex == null && nextLine.columnIndex == null))) {
          const lineSlot = (line.element || line.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
          const nextSlot = (nextLine.element || nextLine.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
          if (!lineSlot || !nextSlot || lineSlot === nextSlot) {
            if (Number.isFinite(nextLine.top) && nextLine.top > (line.top ?? line.centerY)) {
              hasNext = true;
            }
          }
        }
        const curBottom = Number.isFinite(line.bottom) ? line.bottom : Math.round(mediaT + mediaH);

        // Strict constant offset from active line bottom across all lines
        let coverTargetY = Math.round(curBottom + COVER_LINE_OFFSET);
        if (hasNext && nextLine && Number.isFinite(nextLine.top)) {
          // Clamped only if it would literally overlap the next line's normalized top
          const maxAllowedY = Math.floor(nextLine.top - 1);
          coverTargetY = Math.min(coverTargetY, maxAllowedY);
          if (Number.isFinite(curBottom)) {
            coverTargetY = Math.max(Math.round(curBottom), coverTargetY);
          }
        }

        targetY = coverTargetY;
        height = 2;
        lineBottom = Math.max(mediaT + mediaH, coverTargetY);
      }

      // Horizontální hranice kontejneru / sloupce
      const sRect = (this.snapToLines && this.cachedLines && this.cachedLines.length > 0 && this._cachedStageRect)
        ? this._cachedStageRect
        : (this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.();
      const stageL = (sRect && sRect.width > 50) ? Math.round(sRect.left) : (this.stageLeft ?? 0);
      const stageR = (sRect && sRect.width > 50) ? Math.round(sRect.right) : ((this.stageLeft ?? 0) + (this.stageWidth ?? window.innerWidth));

      let colBoundaryLeft = line.colBoundaryLeft ?? (line.columnIndex === 1 ? this.column1Left : this.column0Left) ?? stageL;
      let colBoundaryRight = line.colBoundaryRight ?? (line.columnIndex === 1 ? this.column1Right : this.column0Right) ?? stageR;

      if (this.isSpreadActive()) {
        const spreadInfo = this.getActiveSpreadInfo(line);
        if (spreadInfo) {
          colBoundaryLeft = Math.round(spreadInfo.activeRect.left);
          colBoundaryRight = Math.round(spreadInfo.activeRect.right);
        }
      }

      colBoundaryLeft = Math.max(stageL, colBoundaryLeft);
      colBoundaryRight = Math.min(stageR, colBoundaryRight);
      if (colBoundaryRight <= colBoundaryLeft) {
        colBoundaryLeft = stageL;
        colBoundaryRight = stageR;
      }

      let targetLeft = Math.round(mediaL - padding);
      let targetWidth = Math.round(mediaW + (padding * 2));

      // Zamezení přetečení mimo kontejner
      if (targetLeft < colBoundaryLeft) {
        const diff = colBoundaryLeft - targetLeft;
        targetLeft = colBoundaryLeft;
        targetWidth = Math.max(20, targetWidth - diff);
      }
      if (targetLeft + targetWidth > colBoundaryRight) {
        targetWidth = Math.max(20, colBoundaryRight - targetLeft);
      }

      const mediaGeom = {
        height,
        targetY,
        lineTop,
        lineBottom,
        lineHeight: height,
        left: targetLeft,
        width: targetWidth,
        columnLeft: targetLeft,
        columnWidth: targetWidth,
        columnRight: targetLeft + targetWidth,
        colBoundaryLeft,
        colBoundaryRight,
        columnIndex: line.columnIndex ?? 0,
        isMedia: true
      };
      this._lastComputedLineGeom = {
        index: clampedIdx,
        mode: this.mode,
        style: this.style || this.mode,
        autoHeight: currentAutoHeight,
        manualHeight: currentManualHeight,
        linesRef: this.cachedLines,
        geom: mediaGeom
      };
      return mediaGeom;
    }

    let height;
    let targetY;

    // Vždy spočítáme referenční spodní okraj (bottom-cover linka / clona)
    let hasNext = false;
    if (nextLine && (nextLine.columnIndex === line.columnIndex || (line.columnIndex == null && nextLine.columnIndex == null))) {
      const lineSlot = (line.element || line.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
      const nextSlot = (nextLine.element || nextLine.el)?.closest?.(".pdf-page-slot, .pdf-page-container");
      if (!lineSlot || !nextSlot || lineSlot === nextSlot) {
        if (Number.isFinite(nextLine.top) && nextLine.top > (line.top ?? line.centerY)) {
          hasNext = true;
        }
      }
    }
    const roundedFs = Math.round(line.fontSize || 16);
    const glyphH = this.glyphHeightByFontSize?.get(roundedFs) || line.height || 18;
    const curBottom = line.centerY + glyphH / 2;

    const isPdfLine = !!(this.isPdfMode || line.isPdfLine);
    const effectiveCoverOffset = isPdfLine ? COVER_LINE_OFFSET : 1;

    let coverTargetY = Math.round(curBottom + effectiveCoverOffset);
    if (hasNext && nextLine && Number.isFinite(nextLine.top)) {
      const clearancePx = isPdfLine ? 1 : 2;
      const maxAllowedY = Math.floor(nextLine.top - clearancePx);
      if (coverTargetY > maxAllowedY) {
        coverTargetY = Math.max(Math.round(curBottom), maxAllowedY);
      }
    }

    // Spočítáme horní okraj a výšku řádku pro zvýrazňovač / zaostření
    const isAuto = this.isPdfMode ? this.pdfAutoHeight : this.autoHeight;
    let computedTopY;
    let computedLineH;
    if (isAuto) {
      const rFs = Math.round(line.fontSize || 0);
      let h = (this.lineHeightByFontSize && rFs && (
          this.lineHeightByFontSize.get(rFs) ||
          this.lineHeightByFontSize.get(rFs - 1) ||
          this.lineHeightByFontSize.get(rFs + 1)
        ))
        || this.uniformLineHeight
        || (this.isPdfMode ? this.pdfStandardLineHeight : null)
        || this.height
        || (this.isPdfMode ? 20 : 28);

      if (this.isPdfMode || line.isPdfLine) {
        if (Number.isFinite(line.height) && line.height > 0) {
          const maxCompactH = Math.round(line.height + 4);
          if (h > maxCompactH + 1) {
            h = maxCompactH;
          }
        }

        const minLineH = Math.max(8, Math.round(line.height || 10));
        if (prevLine && Number.isFinite(prevLine.bottom) && prevLine.bottom < line.centerY) {
          const symTopH = Math.floor((line.centerY - prevLine.bottom - 0.5) * 2);
          if (symTopH < h) {
            h = Math.max(minLineH, symTopH);
          }
        }
        if (nextLine && Number.isFinite(nextLine.top) && nextLine.top > line.centerY) {
          const symBottomH = Math.floor((nextLine.top - line.centerY - 0.5) * 2);
          if (symBottomH < h) {
            h = Math.max(minLineH, symBottomH);
          }
        }

        let topEdge = Math.round(line.centerY - h / 2);
        let bottomEdge = topEdge + h;

        if (prevLine && Number.isFinite(prevLine.bottom) && topEdge < prevLine.bottom) {
          topEdge = Math.ceil(prevLine.bottom);
        }
        if (nextLine && Number.isFinite(nextLine.top) && bottomEdge > nextLine.top) {
          bottomEdge = Math.floor(nextLine.top);
        }
        if (bottomEdge > topEdge) {
          computedLineH = bottomEdge - topEdge;
          computedTopY = topEdge;
        } else {
          computedLineH = h;
          computedTopY = Math.round(line.centerY - h / 2);
        }
      } else {
        computedLineH = h;
        const visualCenterY = line.centerY - 1;
        computedTopY = Math.round(visualCenterY - h / 2);
      }
    } else {
      const h = this.isPdfMode
        ? (Number.isFinite(this.pdfRulerHeight) ? this.pdfRulerHeight : 32)
        : (this.manualHeight || 36);
      computedTopY = Math.round(line.centerY - h / 2);
      computedLineH = h;
    }

    if (this.style === "bottom-cover" || this.mode === "bottom-cover") {
      targetY = coverTargetY;
      height = 2;
    } else {
      targetY = computedTopY;
      height = computedLineH;
    }

    let left = line.columnLeft ?? line.left ?? (line.columnIndex === 1 ? this.column1Left : this.column0Left) ?? this.textBlockLeft ?? 0;
    let width = line.columnWidth ?? line.width ?? (line.columnIndex === 1 ? this.column1Width : this.column0Width) ?? this.textBlockWidth ?? 200;

    const isPdfOrSlot = this.isPdfMode || !!document.querySelector("#reader-content .pdf-page-container, #reader-content .pdf-page-slot");
    if (this.isSpreadActive() && isPdfOrSlot) {
      const spreadInfo = this.getActiveSpreadInfo(line);
      if (spreadInfo) {
        const cRect = spreadInfo.activeRect;
        const pageCol = this.getPageTextColumnBounds(line);
        if (pageCol && pageCol.width > 50) {
          left = Math.max(Math.round(cRect.left), Math.round(pageCol.left));
          width = Math.min(Math.round(pageCol.width), Math.round(cRect.right - left));
        } else if (line.textLeft != null && line.textRight != null && line.textRight > line.textLeft) {
          const padding = 12;
          left = Math.max(Math.round(cRect.left), Math.round(line.textLeft - padding));
          const colR = Math.min(Math.round(cRect.right), Math.round(line.textRight + padding));
          width = Math.max(50, colR - left);
        } else {
          const padding = 12;
          left = Math.round(cRect.left + padding);
          width = Math.round(cRect.width - (padding * 2));
        }
        left = Math.max(Math.round(cRect.left), left);
        if (left + width > cRect.right) {
          width = Math.max(50, Math.round(cRect.right - left));
        }
      }
    } else if (this.isVerticalMode() && isPdfOrSlot) {
      const pageCol = this.getPageTextColumnBounds(line);
      if (pageCol && pageCol.width > 50) {
        left = pageCol.left;
        width = pageCol.width;
      }
    } else if (isPdfOrSlot) {
      const pageCol = this.getPageTextColumnBounds(line);
      if (pageCol && pageCol.width > 50) {
        left = pageCol.left;
        width = pageCol.width;
      }
    }

    if (!this.isPdfMode && isPdfOrSlot && Number.isFinite(line.textLeft) && Number.isFinite(line.textRight) && line.textRight > line.textLeft) {
      const textWidth = line.textRight - line.textLeft;
      const colWidth = line.columnWidth || width;
      if (textWidth < colWidth * 0.75) {
        const padX = 12;
        const shortLeft = Math.round(line.textLeft - padX);
        const shortRight = Math.round(line.textRight + padX);
        const boundLeft = line.colBoundaryLeft ?? (line.columnLeft ?? left);
        const boundRight = line.colBoundaryRight ?? ((line.columnLeft ?? left) + colWidth);
        left = Math.max(boundLeft, shortLeft);
        const right = Math.min(boundRight, shortRight);
        width = Math.max(30, right - left);
      }
    }

    const geom = {
      height,
      targetY,
      lineTop: computedTopY,
      lineBottom: coverTargetY,
      lineHeight: computedLineH,
      left,
      width,
      columnLeft: left,
      columnWidth: width,
      columnRight: left + width,
      colBoundaryLeft: line.colBoundaryLeft ?? left,
      colBoundaryRight: line.colBoundaryRight ?? (left + width),
      columnIndex: line.columnIndex ?? 0,
      isMedia: false
    };
    this._lastComputedLineGeom = {
      index: clampedIdx,
      mode: this.mode,
      style: this.style || this.mode,
      autoHeight: currentAutoHeight,
      manualHeight: currentManualHeight,
      linesRef: this.cachedLines,
      geom
    };
    return geom;
  }

  updateEffectiveHeight(lineHeight) {
    if (this.isPdfMode) {
      if (!this.cachedLines || this.cachedLines.length === 0) {
        this.height = (!this.pdfAutoHeight ? this.pdfRulerHeight : this.pdfStandardLineHeight) || 24;
        this.uniformLineHeight = !this.pdfAutoHeight ? this.height : null;
        this.applyPosition();
        return;
      }
      if (!this.pdfAutoHeight) {
        this.height = Number.isFinite(this.pdfRulerHeight) ? this.pdfRulerHeight : 32;
        this.uniformLineHeight = this.height;
      } else {
        this.uniformLineHeight = this.pdfStandardLineHeight || this.uniformLineHeight || 20;
        if (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) {
          const geom = this.computeLineGeometry(this.activeLineIndex);
          if (geom && geom.height) {
            this.height = geom.height;
            this.targetY = geom.targetY;
          } else {
            this.height = this.pdfStandardLineHeight || 20;
          }
        } else {
          this.height = this.pdfStandardLineHeight || 20;
        }
      }
      this.applyPosition();
      return;
    }
    if (this.autoHeight) {
      if (Number.isFinite(this.uniformLineHeight) && this.uniformLineHeight > 0) {
        this.height = this.uniformLineHeight;
      } else {
        let baseH = Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(lineHeight) : 0;
        let rawGlyphH = 0;
        if (this.cachedLines && this.cachedLines.length > 0) {
          const sortedHeights = this.cachedLines.map(l => l.height).filter(h => h > 0).sort((a, b) => a - b);
          if (sortedHeights.length > 0) {
            rawGlyphH = sortedHeights[Math.floor(sortedHeights.length / 2)];
            if (!baseH) baseH = rawGlyphH;
          }
        }
        if (!baseH || baseH < 14) {
          try {
            const content = document.querySelector('#reader-content, .page-content, .reader-text, article') || document.body;
            const sampleEl = content?.querySelector('p, div, li, blockquote') || content;
            if (sampleEl) {
              const cs = window.getComputedStyle(sampleEl);
              const fs = parseFloat(cs.fontSize);
              const lh = parseFloat(cs.lineHeight);
              if (Number.isFinite(lh) && lh > 0) {
                baseH = Math.max(baseH, Math.round(lh));
              } else if (Number.isFinite(fs) && fs > 0) {
                baseH = Math.max(baseH, Math.round(fs * 1.5));
              }
            }
          } catch (e) {}
        }
        if (!baseH || baseH < 14) {
          baseH = 26;
        }
        const padV = Math.max(5, Math.round(baseH * 0.15));
        const effectiveH = Math.round(baseH + (2 * padV));
        const minRequiredH = Math.round((rawGlyphH > 0 ? rawGlyphH : baseH) + 10);
        this.height = Math.max(effectiveH, minRequiredH);
        this.uniformLineHeight = this.height;
      }

      if (this.snapToLines && this.cachedLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom && Number.isFinite(geom.height) && geom.height > 0) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = geom.targetY;
        }
      }
    } else {
      this.height = this.manualHeight || 36;
      this.uniformLineHeight = this.height;
    }
    this.applyPosition();
  }

  /**
   * Vyhodnotí index řádku podle typu ukazatele a hysterezního tolerančního okna (Deadband Hysteresis):
   * - Pro Apple Pencil (pointerType === 'pen') a kurzor myši v režimu sledování (followMode === 'mouse'):
   *   1. Calibration Window / toleranční okno pro aktivní řádek N:
   *      - Pravítko zůstává pevně uzamčené na řádku N, dokud se svislá souřadnice ukazatele
   *        pohybuje v tolerančním okně (včetně inter-line mezery pod řádkem N).
   *   2. Symetrické přepínací prahy se stabilním deadbandem (Responsive & Symmetrical Thresholds):
   *      - Pohyb DOLŮ: Přeskok na řádek N+1 nastane, jakmile pointer překročí mezeru a zřetelně vstoupí
   *        do řádku N+1 (překročí 60 % výšky řádku N+1):
   *        (downThreshold = nextLine ? nextLine.top + nextLine.height * 0.60 : Infinity).
   *      - Pohyb NAHORU: Návrat na řádek N-1 nastane symetricky a pohotově, jakmile pointer vystoupá
   *        nad horní 40% hranici výšky aktuálně aktivního řádku N (na kterém pravítko sedí):
   *        (upThreshold = prevLine ? currentLine.top + currentLine.height * 0.40 : -Infinity).
   *      - Stabilní deadband: Mezi 40 % a 60 % výšky řádku se nachází 20% ochranné pásmo,
   *        které spolehlivě eliminuje oscilace a kmitání pravítka mezi sousedními řádky.
   *   3. Ochrana okrajů (First & Last Line Safeguards):
   *      - Pokud je pointerY nad řádkem 0, zůstane uzamčeno na řádku 0.
   *      - Pokud je pointerY pod posledním řádkem, zůstane uzamčeno na posledním řádku.
   * - Pro ostatní ukazatele mimo režim sledování: standardní přímé přichytávání bez hystereze.
   */
  getHysteresisLineIndex(curY, isPen = false, activeColumn = null) {
    if (!isPen || this.followMode === "mouse") {
      const isDocTurning = document.body.classList.contains("is-turning-page") ||
        document.body.classList.contains("is-chapter-loading") ||
        !!(this.app?.isNavigating) ||
        (Date.now() < this.navigatingPageLockoutEndTime);
      if (!isDocTurning) {
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.isPageTransitioning = false;
      }
    }
    if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
      return this.activeLineIndex >= 0 ? this.activeLineIndex : -1;
    }
    this._ensureLinesFreshForCurrentLayout();
    if (!this.cachedLines || this.cachedLines.length === 0) {
      this.detectLines();
    }
    if (!this.cachedLines || this.cachedLines.length === 0) return -1;

    const isVertical = this.isVerticalMode();
    const viewport = isVertical ? (this._cachedViewportEl || document.getElementById("paged-viewport")) : null;
    if (isVertical && viewport) {
      curY += viewport.scrollTop;
    }

    // Filtrování řádků podle aktivního sloupce
    const candidates = [];
    for (let i = 0; i < this.cachedLines.length; i++) {
      const l = this.cachedLines[i];
      if (activeColumn === null || l.columnIndex === activeColumn) {
        candidates.push({ line: l, index: i });
      }
    }

    const pool = candidates.length > 0 ? candidates : this.cachedLines.map((l, i) => ({ line: l, index: i }));
    if (pool.length === 0) return -1;

    const firstItem = pool[0];
    const lastItem = pool[pool.length - 1];

    if (this.isPdfMode) {
      let cRect = firstItem?.line?.canvasRect || null;
      if (!cRect && this._cachedSpreadInfo) {
        cRect = activeColumn === 1 ? this._cachedSpreadInfo.rightRect : this._cachedSpreadInfo.leftRect;
      }
      if (!cRect) {
        cRect = this._cachedCanvasRect;
      }
      if (!cRect && (!this.snapToLines || this.cachedLines.length === 0)) {
        const lineEl = firstItem?.line?.element || firstItem?.line?.el;
        let pageSlot = lineEl ? lineEl.closest(".pdf-page-container, .pdf-page-slot") : null;
        const isSpread = !isVertical && this.isSpreadActive();
        const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;
        if (!pageSlot && isSpread && spreadInfo) {
          pageSlot = activeColumn === 1 ? spreadInfo.rightSlot : spreadInfo.leftSlot;
        }
        if (!pageSlot) {
          pageSlot = document.querySelector("#reader-content .pdf-page-container, #reader-content .pdf-page-slot");
        }
        const canvas = pageSlot ? pageSlot.querySelector("canvas") : document.querySelector("#reader-content canvas");
        if (canvas) {
          cRect = canvas.getBoundingClientRect();
          this._cachedCanvasRect = cRect;
        }
      }
      if (cRect) {
        if (curY <= firstItem.line.top) {
          return firstItem.index;
        }
        if (curY >= lastItem.line.bottom) {
          return lastItem.index;
        }
      }
    }

    if (curY <= firstItem.line.top) {
      return firstItem.index;
    }
    if (curY >= lastItem.line.bottom) {
      return lastItem.index;
    }

    // Pro ukazatele mimo režim sledování a mimo stylus (např. klávesový režim) standardní přímé přichytávání bez hystereze
    if (!isPen && this.followMode !== "mouse") {
      let minDiff = Infinity;
      let closestIdx = pool[0].index;
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const line = item.line;
        const diff = Math.abs(curY - line.centerY);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = item.index;
        }
      }
      return closestIdx;
    }

    // 1., 2. & 3. Calibration Window & Switching Thresholds (Typographic Baseline & x-Height Hysteresis):
    let activeInPool = -1;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].index === this.activeLineIndex) {
        activeInPool = i;
        break;
      }
    }
    if (activeInPool === -1) {
      let minDiff = Infinity;
      activeInPool = 0;
      for (let i = 0; i < pool.length; i++) {
        const diff = Math.abs(curY - pool[i].line.centerY);
        if (diff < minDiff) {
          minDiff = diff;
          activeInPool = i;
        }
      }
    }

    const currentLine = pool[activeInPool]?.line;
    // Ensure currentLine is valid
    if (!currentLine) return pool[activeInPool]?.index ?? activeInPool;

    const prevLine = activeInPool > 0 ? pool[activeInPool - 1].line : null;
    const nextLine = activeInPool < pool.length - 1 ? pool[activeInPool + 1].line : null;

    // 1. Transition DOWN to nextLine:
    // Pro běžný text: 60 % výšky nextLine. Pro media (obrázky): citlivý přechod (max 14px / 20 % výšky)
    const nextHyst = nextLine
      ? (nextLine.isMedia ? Math.min(14, nextLine.height * 0.20) : (nextLine.height * 0.60))
      : 0;
    const downThreshold = nextLine
      ? (nextLine.top + nextHyst)
      : Infinity;

    // 2. Transition UP to prevLine:
    // Pro běžný text: horních 40 % výšky currentLine. Pro media (obrázky): citlivý přechod u horního okraje (max 12px / 15 % výšky)
    const curHyst = currentLine.isMedia
      ? Math.min(12, currentLine.height * 0.15)
      : (currentLine.height * 0.40);
    const upThreshold = prevLine
      ? (currentLine.top + curHyst)
      : -Infinity;

    if (curY > downThreshold) {
      let newPoolIdx = activeInPool + 1;
      while (newPoolIdx < pool.length - 1) {
        const next = pool[newPoolIdx + 1]?.line;
        const hOffset = next?.isMedia ? Math.min(14, next.height * 0.20) : (next ? next.height * 0.60 : 0);
        if (next && curY > next.top + hOffset) {
          newPoolIdx++;
        } else {
          break;
        }
      }
      return pool[newPoolIdx].index;
    } else if (curY < upThreshold) {
      // 3. First Line Safeguard: Pokud je pointerY nad řádkem 0, zůstává uzamčeno na řádku 0
      if (activeInPool === 0) return pool[0].index;
      let newPoolIdx = activeInPool - 1;
      while (newPoolIdx > 0) {
        const cur = pool[newPoolIdx]?.line;
        const hOffset = cur?.isMedia ? Math.min(12, cur.height * 0.15) : (cur ? cur.height * 0.40 : 0);
        if (cur && curY < cur.top + hOffset) {
          newPoolIdx--;
        } else {
          break;
        }
      }
      return pool[newPoolIdx].index;
    }
    return pool[activeInPool].index;
  }

  /**
   * Zpracuje pohyb ukazatele (myši nebo prstu)
   */
  handlePointerMove(clientX, clientY, pointerType = null) {
    if (this.isPopoverOrDrawerOpen() || this._trackingSuspendedByOverlay) return;
    const isDocTurning = document.body.classList.contains("is-turning-page") ||
      document.body.classList.contains("is-chapter-loading") ||
      !!(this.app?.isNavigating) ||
      (Date.now() < this.navigatingPageLockoutEndTime);
    if (!isDocTurning && (pointerType === "mouse" || this.followMode === "mouse" || pointerType === null)) {
      this.isLineLocked = false;
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isPageTransitioning = false;
      this.suppressLineAdvancement = false;
    }

    if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
    this.disableWordTransition();

    // Pokud probíhá aktivní vertikální posun v režimu myši, zamknout řádek a neprovádět vzorkování pod kurzorem
    if (this.isVerticalMode() && this.followMode === "mouse" && this._isVerticalScrolling) {
      return;
    }

    const effectiveClientY = clientY;
    const pType = pointerType || this.activePointerType || (Date.now() - this.lastPenTime < 500 ? "pen" : "mouse");

    const isMovingLeft = (this.lastValidPointerX !== null && clientX !== null)
      ? (clientX < this.lastValidPointerX - 10)
      : false;

    // Displacement / Delta Threshold Sanity Check:
    // Pokud probíhá aktivní tažení s předchozí platnou souřadnicí (mimo režim sledování myši), zachytíme anomální skok (např. dotyk dlaně).
    if (
      this.followMode !== "mouse" &&
      pType !== "mouse" &&
      pType !== "pen" &&
      (!this.isPdfMode || (this.cachedLines && this.cachedLines.length > 0)) &&
      this.isDraggingRuler &&
      this.lastValidPointerY !== null &&
      effectiveClientY != null
    ) {
      const dy = Math.abs(effectiveClientY - this.lastValidPointerY);
      const dx = clientX != null && this.lastValidPointerX !== null ? Math.abs(clientX - this.lastValidPointerX) : 0;
      if (clientX != null) {
        this.lastPointerX = clientX;
        this.lastValidPointerX = clientX;
      }
      if (effectiveClientY != null) {
        this.lastPointerY = effectiveClientY;
        this.lastValidPointerY = effectiveClientY;
      }
      if (dy > 160 || dx > 220) {
        return;
      }
    }

    if (clientX != null) {
      this.lastPointerX = clientX;
      this.lastValidPointerX = clientX;
    }
    if (effectiveClientY != null) {
      this.lastPointerY = effectiveClientY;
      this.lastValidPointerY = effectiveClientY;
    }

    if (pointerType) {
      this.activePointerType = pointerType;
    }
    const isPen = pType === "pen";

    const curX = this.lastPointerX;
    const curY = this.lastPointerY;

    if (!this.snapToLines && !this.wordTracking) {
      const isVertical = this.isVerticalMode();
      const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
      const vScrollTop = (isVertical && vp) ? vp.scrollTop : 0;
      const effectiveClientY = curY != null ? curY : (clientY != null ? clientY : 0);
      const h = Number.isFinite(this.height) && this.height > 0 ? this.height : (this.manualHeight || 36);

      if (this.mode === "bottom-cover") {
        this.targetY = isVertical ? (effectiveClientY + vScrollTop) : effectiveClientY;
      } else {
        this.targetY = (isVertical ? (effectiveClientY + vScrollTop) : effectiveClientY) - (h / 2);
      }
      this.currentY = this.targetY;

      const isTwoCol = !isVertical && !!this.isTwoCol;
      const stage = document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, width: window.innerWidth };
      const stageCenterX = stageRect.left + stageRect.width / 2;
      const splitX = (isTwoCol && this.gapMiddle) ? this.gapMiddle : stageCenterX;
      const activeColumn = isTwoCol ? ((curX >= splitX) ? 1 : 0) : 0;

      if (this.cachedLines && this.cachedLines.length > 0) {
        let nearestLineIdx = 0;
        let minLineDiff = Infinity;
        const docY = isVertical ? (effectiveClientY + vScrollTop) : effectiveClientY;
        for (let i = 0; i < this.cachedLines.length; i++) {
          const l = this.cachedLines[i];
          if (isTwoCol && l.columnIndex !== activeColumn) continue;
          const lineMidY = l.centerY ?? ((l.top + l.bottom) / 2);
          const diff = Math.abs(docY - lineMidY);
          if (diff < minLineDiff) {
            minLineDiff = diff;
            nearestLineIdx = i;
          }
        }
        this.activeLineIndex = nearestLineIdx;
        if (!this.wordTracking) {
          this._checkLineProgress(nearestLineIdx, false);
        }
      }

      this.rulerEl.classList.remove("word-tracking-mode", "is-snapped");
      if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
      if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
      if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");

      this.applyPosition();
      return;
    }

    if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
      const isVertical = this.isVerticalMode();
      const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
      const h = this.height || 32;

      if (isVertical && vp) {
        const vScrollTop = vp.scrollTop;
        const maxScrollHeight = Math.max(vp.scrollHeight, vp.clientHeight);
        let targetY;
        if (this.mode === "bottom-cover") {
          targetY = curY != null ? (curY + vScrollTop) : (vScrollTop + 50);
          this.currentY = Math.max(0, Math.min(maxScrollHeight, targetY));
        } else {
          targetY = (curY != null ? (curY + vScrollTop) : (vScrollTop + 50)) - h / 2;
          this.currentY = Math.max(0, Math.min(maxScrollHeight - h, targetY));
        }
        this.targetY = this.currentY;
        this.applyPosition();
        return;
      }

      const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const spread = document.querySelector("#reader-content .pdf-spread-container");
      let topBound = stageRect.top;
      let bottomBound = stageRect.bottom;
      const isSpread = this.isSpreadActive();
      const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;
      if (isSpread && spreadInfo) {
        const activeRect = spreadInfo.activeRect;
        if (activeRect.height > 50) {
          topBound = activeRect.top;
          bottomBound = activeRect.bottom;
        }
      } else if (spread) {
        const sRect = spread.getBoundingClientRect();
        if (sRect.height > 50) {
          topBound = sRect.top;
          bottomBound = sRect.bottom;
        }
      } else {
        const canvas = document.querySelector("#reader-content canvas");
        if (canvas) {
          const cRect = canvas.getBoundingClientRect();
          if (cRect.height > 50) {
            topBound = cRect.top;
            bottomBound = cRect.bottom;
          }
        }
      }

      if (this.mode === "bottom-cover") {
        const targetY = curY != null ? curY : topBound;
        this.currentY = Math.max(topBound, Math.min(bottomBound, targetY));
      } else {
        const targetY = (curY != null ? curY : (topBound + 50)) - h / 2;
        this.currentY = Math.max(topBound, Math.min(bottomBound - h, targetY));
      }
      this.targetY = this.currentY;
      this.applyPosition();
      return;
    }

    if (this.cachedLines.length === 0) {
      this.detectLines();
    }

    const useFastCachedGeom = this.snapToLines && this.cachedLines.length > 0;
    const stageRect = (useFastCachedGeom && this._cachedStageRect)
      ? this._cachedStageRect
      : ((document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.() || { left: 0, width: window.innerWidth });
    const stageCenterX = stageRect.left + stageRect.width / 2;
    const isVerticalNow = this.isVerticalMode();
    const isSpread = !isVerticalNow && (useFastCachedGeom ? !!this._cachedIsSpread : this.isSpreadActive());
    const spreadInfo = isSpread ? (useFastCachedGeom ? this._cachedSpreadInfo : this.getActiveSpreadInfo(null)) : null;
    const isTwoCol = !isVerticalNow && (!!this.isTwoCol || isSpread);
    const splitX = (isSpread && spreadInfo) ? spreadInfo.midGap : ((isTwoCol && this.gapMiddle) ? this.gapMiddle : stageCenterX);
    const activeColumn = isTwoCol ? ((curX >= splitX) ? 1 : 0) : 0;

    // --- PDF STANDARDNÍ ŘÁDKOVÝ REŽIM (Plnošířkové řádkové pravítko) ---
    if (this.isPdfMode && !this.wordTracking) {
      if (this.rulerEl) this.rulerEl.classList.remove("word-tracking-mode");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";

      if (this.cachedLines && this.cachedLines.length > 0) {
        const targetLineIdx = this.getHysteresisLineIndex(curY, isPen, activeColumn);
        if (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) {
          if (!this.wordTracking && this.snapToLines && targetLineIdx === this.activeLineIndex && activeColumn === this._lastActiveColumn && this._lastActiveLineIndex === targetLineIdx) {
            return;
          }
          this.activeLineIndex = targetLineIdx;
          this._lastActiveLineIndex = targetLineIdx;
          this._lastActiveColumn = activeColumn;
          this._checkLineProgress(targetLineIdx, false);
          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          if (this.followMode === "mouse") {
            this.rulerEl.classList.remove("is-snapped");
            if (this.wordWaveEl) this.wordWaveEl.classList.remove("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
          } else {
            this.rulerEl.classList.add("is-snapped");
            if (this.wordWaveEl) this.wordWaveEl.classList.add("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.add("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.add("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.add("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.add("is-snapped");
          }
          this.applyPosition();
          return;
        } else if (targetLineIdx < 0) {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.style.display = "none";
          if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
          if (this.maskTopEl) this.maskTopEl.style.display = "none";
          if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
          if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
          if (this.maskRightEl) this.maskRightEl.style.display = "none";
          if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
          this.clearFocusTextMask();
          this.setCursorHidden(false);
          return;
        }
      }
    }

    // --- REŽIM SLEDOVÁNÍ SLOV (Word-level Tracking) ---
    if (this.wordTracking) {
      if (this.cachedLines.length === 0) {
        this.detectLines();
      }

      if (this.cachedLines.length > 0) {
        const targetLineIdx = this.getHysteresisLineIndex(curY, isPen, activeColumn);
        if (targetLineIdx < 0) {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.style.display = "none";
          if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
          if (this.maskTopEl) this.maskTopEl.style.display = "none";
          if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
          if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
          if (this.maskRightEl) this.maskRightEl.style.display = "none";
          if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
          if (this._focusMaskDirty) {
            this.clearFocusTextMask();
            this._focusMaskDirty = false;
          }
          this.setCursorHidden(false);
          return;
        }

        const isVertical = this.isVerticalMode();
        const vp = isVertical ? (this._cachedViewportEl || document.getElementById("paged-viewport") || document.querySelector(".paged-viewport")) : null;
        const vScrollTop = (isVertical && vp) ? vp.scrollTop : 0;
        const wordCurY = isVertical ? (curY + vScrollTop) : curY;

        const targetLine = this.cachedLines[targetLineIdx];
        const isMediaLine = !!(targetLine && (targetLine.isMedia || !targetLine.hasText));

        // Word Mode Fallback: pokud ukazatel přejede přes obrázek / ornament, uzamknout pravítko na celém elementu
        if (isMediaLine) {
          this.activeLineIndex = targetLineIdx;
          this.activeWordIndex = -1;
          this.rulerEl.classList.remove("word-tracking-mode");
          if (this.wordWaveEl) this.wordWaveEl.style.display = "none";

          this.lastValidPointerX = curX;
          this.lastValidPointerY = curY;
          this.lastPointerX = curX;
          this.lastPointerY = curY;

          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          if (this.followMode === "mouse") {
            this.rulerEl.classList.remove("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
          } else {
            this.rulerEl.classList.add("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.add("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.add("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.add("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.add("is-snapped");
          }
          if (!this.isPageTransitioning) {
            this.rulerEl.style.display = "block";
            this.rulerEl.style.opacity = "1";
            this.rulerEl.style.visibility = "visible";
            this.rulerEl.classList.remove("is-hidden", "hidden");
            this.rulerEl.classList.add("is-visible");
          }
          this.applyPosition();
          return;
        }

        // Tier 2: Spočítat/získat slova pouze pro aktivní řádek (lazy cache)
        const lineWords = this.ensureActiveWords(targetLineIdx);
        this.activeLineIndex = targetLineIdx;

        if (!lineWords || lineWords.length === 0) {
          this.activeWordIndex = -1;
          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          this.applyPosition();
          return;
        }

        let closestWord = null;
        let closestIdx = -1;
        let minDiff = Infinity;

        for (let i = 0; i < lineWords.length; i++) {
          const w = lineWords[i];
          const dy = wordCurY < w.top ? w.top - wordCurY : wordCurY > w.bottom ? wordCurY - w.bottom : 0;
          const dx = curX < w.left ? w.left - curX : curX > w.right ? curX - w.right : 0;
          const dist = dy * 3 + dx;
          if (dist < minDiff) {
            minDiff = dist;
            closestWord = w;
            closestIdx = i;
          }
        }

        if (!closestWord && lineWords.length > 0) {
          closestWord = lineWords[0];
          closestIdx = 0;
        }

        if (this.followMode !== "mouse") {
          this.setWordWindow(closestIdx, isMovingLeft);
        }

        // V režimu sledování myši (mouse-follow) zajistit plynulý spojitý horizontální pohyb bez magnetického přichytávání a bez trhání zpět
        if (this.followMode === "mouse") {
          const geom = this.computeLineGeometry(this.activeLineIndex);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          const padX = 3;
          const activeLine = this.cachedLines[this.activeLineIndex];

          let textMinX = activeLine && activeLine.left != null ? Math.round(activeLine.left - padX) : 0;
          let textMaxX = activeLine && activeLine.right != null ? Math.round(activeLine.right + padX) : window.innerWidth;
          if (lineWords.length > 0) {
            textMinX = Math.round(lineWords[0].left - padX);
            textMaxX = Math.round(lineWords[lineWords.length - 1].right + padX);
          }

          const computeWordPreview = (wIdx) => {
            if (wIdx < 0 || wIdx >= lineWords.length) return 0;
            const w = lineWords[wIdx];
            const firstW = Math.round(w.width + padX * 2);
            let nextWLast = null;
            let prevCandLeft = w.left;
            for (let offset = 1; offset <= 2; offset++) {
              const nextIdx = wIdx + offset;
              if (nextIdx >= lineWords.length) break;
              const nw = lineWords[nextIdx];
              if (nw.left <= prevCandLeft) break;
              prevCandLeft = nw.left;
              nextWLast = nw;
            }
            if (!nextWLast) return 0;
            let trueLineRight = textMaxX;
            for (let i = wIdx; i < lineWords.length; i++) {
              trueLineRight = Math.max(trueLineRight, Math.round(lineWords[i].right + padX));
            }
            const rawTargetRight = Math.round(nextWLast.right + padX);
            const clampedTargetRight = Math.min(rawTargetRight, trueLineRight);
            const stableLeft = Math.round(w.left - padX);
            return Math.max(0, clampedTargetRight - stableLeft - firstW);
          };

          let continuousLeft = 0;
          let continuousWidth = this.activeWordWidth;
          let previewW = 0;

          if (lineWords.length > 0) {
            if (curX <= lineWords[0].centerX) {
              const firstItem = lineWords[0];
              continuousLeft = Math.round(firstItem.left - padX + (curX - firstItem.centerX));
              continuousWidth = Math.round(firstItem.width + padX * 2);
              previewW = computeWordPreview(0);
              this.activeWordIndex = 0;
            } else if (curX >= lineWords[lineWords.length - 1].centerX) {
              const lastIdx = lineWords.length - 1;
              const lastItem = lineWords[lastIdx];
              continuousLeft = Math.round(lastItem.left - padX + (curX - lastItem.centerX));
              continuousWidth = Math.round(lastItem.width + padX * 2);
              previewW = computeWordPreview(lastIdx);
              this.activeWordIndex = lastIdx;
            } else {
              let segIdx = 0;
              for (let k = 0; k < lineWords.length - 1; k++) {
                if (curX >= lineWords[k].centerX && curX <= lineWords[k + 1].centerX) {
                  segIdx = k;
                  break;
                }
              }
              const itemA = lineWords[segIdx];
              const itemB = lineWords[segIdx + 1];
              const dx = itemB.centerX - itemA.centerX;
              const t = dx > 0 ? (curX - itemA.centerX) / dx : 0;
              const clampedT = Math.max(0, Math.min(1, t));

              const leftA = itemA.left - padX;
              const leftB = itemB.left - padX;
              continuousLeft = Math.round(leftA + clampedT * (leftB - leftA));

              const widthA = itemA.width + padX * 2;
              const widthB = itemB.width + padX * 2;
              continuousWidth = Math.round(widthA + clampedT * (widthB - widthA));

              const prevA = computeWordPreview(segIdx);
              const prevB = computeWordPreview(segIdx + 1);
              previewW = Math.round(prevA + clampedT * (prevB - prevA));

              this.activeWordIndex = (clampedT < 0.5) ? segIdx : segIdx + 1;
            }
            this._checkWordProgress(this.activeWordIndex, isMovingLeft);
          } else {
            continuousLeft = Math.round(curX - this.activeWordWidth / 2);
            continuousWidth = this.activeWordWidth;
          }

          this.activeWordWidth = continuousWidth;
          this.totalWidth = continuousWidth + previewW;
          this.wordWidth = this.totalWidth;
          this.previewWidth = previewW;

          const clampedMax = Math.max(textMinX, textMaxX - this.totalWidth);
          this.wordLeft = Math.round(Math.max(textMinX, Math.min(clampedMax, continuousLeft)));
          this.previewLeft = this.wordLeft + continuousWidth;

          const firstWordRatio = Math.min(1, Math.max(0.15, continuousWidth / this.totalWidth));
          this.firstWordRatio = firstWordRatio;
          const roundedWidth = Math.round(this.totalWidth);
          if (this.rulerEl) {
            if (this._lastAppliedWordWidth == null || Math.abs(roundedWidth - this._lastAppliedWordWidth) >= 1) {
              this._lastAppliedWordWidth = roundedWidth;
              this.rulerEl.style.width = `${roundedWidth}px`;
            }
            const currentRatio = firstWordRatio * 100;
            if (this._lastWordSolidRatio == null || Math.abs(currentRatio - this._lastWordSolidRatio) >= 1) {
              this._lastWordSolidRatio = currentRatio;
              this.rulerEl.style.setProperty('--word-solid-ratio', `${currentRatio.toFixed(1)}%`);
            }
          }
        }

        this.rulerEl.classList.add("word-tracking-mode");
        if (this.followMode === "mouse") {
          this.rulerEl.classList.remove("is-snapped");
          if (this.wordWaveEl) this.wordWaveEl.classList.remove("is-snapped");
          this.maskTopEl.classList.remove("is-snapped");
          this.maskBottomEl.classList.remove("is-snapped");
          this.maskLeftEl.classList.remove("is-snapped");
          this.maskRightEl.classList.remove("is-snapped");
        } else {
          this.rulerEl.classList.add("is-snapped");
          if (this.wordWaveEl) this.wordWaveEl.classList.add("is-snapped");
          this.maskTopEl.classList.add("is-snapped");
          this.maskBottomEl.classList.add("is-snapped");
          this.maskLeftEl.classList.add("is-snapped");
          this.maskRightEl.classList.add("is-snapped");
        }
        this.applyPosition();
        return;
      }
    }


    // --- STANDARDNÍ ŘÁDKOVÝ REŽIM ---
    this.rulerEl.classList.remove("word-tracking-mode");

    if (this.cachedLines.length > 0) {
      const targetLineIdx = this.getHysteresisLineIndex(curY, isPen, activeColumn);
      if (targetLineIdx < 0) {
        this.rulerEl.classList.remove("is-visible");
        this.rulerEl.style.display = "none";
        if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
        if (this.maskTopEl) this.maskTopEl.style.display = "none";
        if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
        if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
        if (this.maskRightEl) this.maskRightEl.style.display = "none";
        if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
        if (this._focusMaskDirty) {
          this.clearFocusTextMask();
          this._focusMaskDirty = false;
        }
        this.setCursorHidden(false);
        return;
      }

      if (!this.wordTracking && this.snapToLines && targetLineIdx === this.activeLineIndex && activeColumn === this._lastActiveColumn && this._lastActiveLineIndex === targetLineIdx) {
        return;
      }
      this.activeLineIndex = targetLineIdx;
      this._lastActiveLineIndex = targetLineIdx;
      this._lastActiveColumn = activeColumn;

      if (!this.wordTracking) {
        this._checkLineProgress(targetLineIdx, false);
      }
      const closestLine = this.cachedLines[targetLineIdx];

      const geom = this.computeLineGeometry(targetLineIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
      }

      this.currentY = this.targetY;
      if (this.followMode === "mouse") {
        this.rulerEl.classList.remove("is-snapped");
        if (this.wordWaveEl) this.wordWaveEl.classList.remove("is-snapped");
        this.maskTopEl.classList.remove("is-snapped");
        this.maskBottomEl.classList.remove("is-snapped");
        this.maskLeftEl.classList.remove("is-snapped");
        this.maskRightEl.classList.remove("is-snapped");
      } else {
        this.rulerEl.classList.add("is-snapped");
        if (this.wordWaveEl) this.wordWaveEl.classList.add("is-snapped");
        this.maskTopEl.classList.add("is-snapped");
        this.maskBottomEl.classList.add("is-snapped");
        this.maskLeftEl.classList.add("is-snapped");
        this.maskRightEl.classList.add("is-snapped");
      }
      this.applyPosition();
      return;
    }

    this.rulerEl.classList.remove("is-snapped");
    this.maskTopEl.classList.remove("is-snapped");
    this.maskBottomEl.classList.remove("is-snapped");
    this.maskLeftEl.classList.remove("is-snapped");
    this.maskRightEl.classList.remove("is-snapped");
  }

  _estimateLineWordsFallback(lineIdx) {
    const l = (this.cachedLines && lineIdx >= 0 && lineIdx < this.cachedLines.length)
      ? this.cachedLines[lineIdx]
      : null;
    if (!l || l.isMedia) return 0;

    const pageWords = (this.app && typeof this.app.getVisibleWordsOnCurrentPage === "function")
      ? this.app.getVisibleWordsOnCurrentPage()
      : 250;
    const totalLines = (this.cachedLines && this.cachedLines.length > 0) ? this.cachedLines.length : 25;
    const avgWordsPerLine = Math.max(1, Math.min(25, Math.round(pageWords / totalLines)));

    // Pokud má řádek čistý text odpovídající jednomu řádku (nikoliv celému odstavci)
    if (l.text && typeof l.text === "string") {
      const cleanTokens = l.text.trim().split(/\s+/).filter(Boolean);
      if (cleanTokens.length >= 1 && cleanTokens.length <= 25) return cleanTokens.length;
    }

    return avgWordsPerLine;
  }

  _checkLineProgress(idx, isKeyboard = false) {
    if (this.rulerMode !== "line" || idx < 0) return;

    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

    if (this._activeReadingLineIndex < 0) {
      this._activeReadingLineIndex = idx;
      this._activeLineStartTime = now;
      if (!this._completedLineIndices) this._completedLineIndices = new Set();
      return;
    }

    if (idx === this._activeReadingLineIndex) return;

    const prevLineIdx = this._activeReadingLineIndex;
    const dwell = now - (this._activeLineStartTime || 0);

    // Dwell time threshold:
    // Pokud uživatel posunul kurzor myši příliš rychle (< 400ms) přes řádek,
    // šlo o rychlý přelet kurzoru / chvění myši, nikoliv čtení.
    // Klávesové šipky (isKeyboard = true) mají dwell ignorován (uživatel vědomě krokuje).
    const isDwellSufficient = isKeyboard || dwell >= 400;

    if (!this._completedLineIndices) this._completedLineIndices = new Set();

    if (idx > prevLineIdx) {
      // Uživatel postoupil vpřed na další řádek.
      // Započítá se POUZE předchozí řádek (prevLineIdx), na kterém čtenář skutečně setrval.
      // Přeskočené řádky se nezapočítávají, protože na nich čtenář nestrávil žádný čas.
      if (isDwellSufficient && !this._completedLineIndices.has(prevLineIdx)) {
        this._completedLineIndices.add(prevLineIdx);
        const lineWords = this.getWordsForLine(prevLineIdx);
        const count = Array.isArray(lineWords) && lineWords.length > 0
          ? lineWords.length
          : this._estimateLineWordsFallback(prevLineIdx);
        if (count > 0 && typeof this.onProgress === "function") {
          this.onProgress("line", count);
        }
      }
    }

    this._activeReadingLineIndex = idx;
    this._activeLineStartTime = now;
  }

  finalizeCurrentPageProgress() {
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const isKeyboard = this.followMode === "keyboard";

    if (this.rulerMode === "line" && this._activeReadingLineIndex >= 0) {
      if (!this._completedLineIndices) this._completedLineIndices = new Set();
      const dwell = now - (this._activeLineStartTime || 0);
      if ((isKeyboard || dwell >= 400) && !this._completedLineIndices.has(this._activeReadingLineIndex)) {
        this._completedLineIndices.add(this._activeReadingLineIndex);
        const lineWords = this.getWordsForLine(this._activeReadingLineIndex);
        const count = Array.isArray(lineWords) && lineWords.length > 0
          ? lineWords.length
          : this._estimateLineWordsFallback(this._activeReadingLineIndex);
        if (count > 0 && typeof this.onProgress === "function") {
          this.onProgress("line", count);
        }
      }
    }

    this._activeReadingLineIndex = -1;
    this._activeLineStartTime = 0;
    this._completedLineIndices = new Set();
    this._lastWordLineIndex = -1;
    this._lastWordIndex = -1;
    this._wordsReadOnPage = new Set();
  }

  _checkWordProgress(idx, isMovingLeft = false) {
    if (this.rulerMode !== "word" || idx < 0) return;

    const curLineIdx = this.activeLineIndex >= 0 ? this.activeLineIndex : 0;
    if (!this._wordsReadOnPage) this._wordsReadOnPage = new Set();

    // Prvotní umístění pravítka na slovo
    if (this._lastWordLineIndex < 0 || this._lastWordIndex < 0) {
      this._lastWordLineIndex = curLineIdx;
      this._lastWordIndex = idx;
      return;
    }

    let wordsPassedOver = 0;

    if (curLineIdx > this._lastWordLineIndex) {
      // 1. Dokončení předchozího řádku: pouze pokud jsme nestihli započíst při dopředném čtení (např. krok klávesnicí)
      if (!isMovingLeft) {
        const prevLineWords = this.getWordsForLine(this._lastWordLineIndex) || [];
        for (let w = Math.max(0, this._lastWordIndex); w < prevLineWords.length; w++) {
          const key = `${this._lastWordLineIndex}:${w}`;
          if (!this._wordsReadOnPage.has(key)) {
            this._wordsReadOnPage.add(key);
            wordsPassedOver++;
          }
        }
        for (let w = 0; w <= idx; w++) {
          const key = `${curLineIdx}:${w}`;
          if (!this._wordsReadOnPage.has(key)) {
            this._wordsReadOnPage.add(key);
            wordsPassedOver++;
          }
        }
      }

      this._lastWordLineIndex = curLineIdx;
      this._lastWordIndex = idx;
    } else if (curLineIdx === this._lastWordLineIndex) {
      // Na stejném řádku:
      if (!isMovingLeft && idx >= this._lastWordIndex) {
        const startW = this._wordsReadOnPage.has(`${curLineIdx}:${this._lastWordIndex}`)
          ? this._lastWordIndex + 1
          : this._lastWordIndex;
        for (let w = Math.max(0, startW); w <= idx; w++) {
          const key = `${curLineIdx}:${w}`;
          if (!this._wordsReadOnPage.has(key)) {
            this._wordsReadOnPage.add(key);
            wordsPassedOver++;
          }
        }
        this._lastWordIndex = idx;
      } else {
        this._lastWordIndex = idx;
      }
    } else {
      // Návrat na předchozí řádek (nahoru): pouze aktualizujeme pozici bez zápočtu
      this._lastWordLineIndex = curLineIdx;
      this._lastWordIndex = idx;
    }

    if (wordsPassedOver > 0 && typeof this.onProgress === "function") {
      this.onProgress("word", wordsPassedOver);
    }
  }

  /**
   * Nastaví geometrii asymetrického čtecího okna pro režim slov:
   * - Cílové slovo (activeWordWidth): plný kontrast bez vnitřního vyblednutí
   * - Dopředný náhled: plynulé lineární doznívání pokrývající 1.5–2 následující slova na témže řádku
   * - Celková šířka (totalWidth) ořezána striktně podle pravého okraje aktuálního řádku
   */
  setWordWindow(wordIndex, isMovingLeft = false) {
    if (wordIndex < 0 || wordIndex >= this.cachedWords.length) {
      this.activeWordIndex = -1;
      this.activeWordWidth = 0;
      this.totalWidth = 0;
      this.wordLeft = 0;
      this.wordWidth = 0;
      this.firstWordRatio = 1;
      this.previewLeft = 0;
      this.previewWidth = 0;
      return;
    }

    this.activeWordIndex = wordIndex;
    const w0 = this.cachedWords[wordIndex];
    if (w0 && w0.lineIndex != null && w0.lineIndex >= 0 && w0.lineIndex < this.cachedLines.length) {
      this.activeLineIndex = w0.lineIndex;
    }
    this._checkWordProgress(wordIndex, isMovingLeft);
    const padX = 3;
    const padY = 1.5;

    this.wordLeft = Math.round(w0.left - padX);
    const firstWordWidth = Math.round(w0.width + padX * 2);
    this.activeWordWidth = firstWordWidth;

    if (w0 && w0.lineIndex != null && w0.lineIndex >= 0 && w0.lineIndex < this.cachedLines.length) {
      const geom = this.computeLineGeometry(w0.lineIndex);
      if (geom && Number.isFinite(geom.targetY) && Number.isFinite(geom.height)) {
        const isAuto = this.isPdfMode ? this.pdfAutoHeight : this.autoHeight;
        if (isAuto && this.mode !== "bottom-cover") {
          this.height = geom.height;
        }
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      } else {
        if (this.isPdfMode ? this.pdfAutoHeight : this.autoHeight) {
          const baseH = Math.round(w0.height || 18);
          const padV = this.isPdfMode ? 2 : Math.max(5, Math.round(baseH * 0.15));
          this.height = Math.round(baseH + padV * 2);
          this.targetY = Math.round((w0.centerY ?? (w0.top + baseH / 2)) - this.height / 2);
        } else {
          this.targetY = Math.round(w0.top - (this.isPdfMode ? 2 : 5));
        }
        this.currentY = this.targetY;
      }
    } else {
      if (this.isPdfMode ? this.pdfAutoHeight : this.autoHeight) {
        const baseH = Math.round(w0.height || 18);
        const padV = this.isPdfMode ? 2 : Math.max(5, Math.round(baseH * 0.15));
        this.height = Math.round(baseH + padV * 2);
        this.targetY = Math.round((w0.centerY ?? (w0.top + baseH / 2)) - this.height / 2);
      } else {
        this.targetY = Math.round(w0.top - (this.isPdfMode ? 2 : 5));
      }
      this.currentY = this.targetY;
    }

    // Check up to 2 following words on the SAME line (w1, w2 where w.lineIndex === w0.lineIndex).
    // Compare each candidate's left against the PREVIOUS word in the chain (not always w0.left)
    // so that rightward progression across the full line is not cut off at the midpoint.
    const nextWords = [];
    let prevLeft = w0.left;
    for (let offset = 1; offset <= 2; offset++) {
      const nextIdx = wordIndex + offset;
      if (nextIdx >= this.cachedWords.length) break;
      const nw = this.cachedWords[nextIdx];
      const isSameLine = (nw.lineIndex != null && w0.lineIndex != null)
        ? (nw.lineIndex === w0.lineIndex)
        : (Math.abs(nw.centerY - w0.centerY) <= 10);
      if (!isSameLine || nw.left <= prevLeft) break;
      prevLeft = nw.left;
      nextWords.push(nw);
    }

    // Zjištění pravé hranice aktuálního řádku pro striktní ořezání.
    // Prefer textRight (true per-line text boundary) over right (column-wide boundary).
    const activeLine = (w0.lineIndex != null && w0.lineIndex >= 0 && w0.lineIndex < this.cachedLines.length)
      ? this.cachedLines[w0.lineIndex]
      : null;
    let lineRight = (activeLine?.textRight != null && activeLine.textRight > 0)
      ? activeLine.textRight
      : null;
    // Always scan same-lineIndex words to get actual text right for THIS specific line
    for (let i = wordIndex; i < this.cachedWords.length; i++) {
      const cw = this.cachedWords[i];
      const isSame = (cw.lineIndex != null && w0.lineIndex != null)
        ? (cw.lineIndex === w0.lineIndex)
        : (Math.abs(cw.centerY - w0.centerY) <= 10);
      if (!isSame) break;
      lineRight = Math.max(lineRight || 0, cw.right);
    }
    const maxBoundary = lineRight ? Math.round(lineRight + padX) : Infinity;

    let totalWidth = firstWordWidth;
    if (nextWords.length > 0) {
      const wLast = nextWords[nextWords.length - 1];
      const rawTargetRight = Math.round(wLast.right + padX);
      const clampedTargetRight = Math.min(rawTargetRight, maxBoundary);
      const stableLeft = Math.round(w0.left - padX);
      const previewW = Math.max(0, clampedTargetRight - stableLeft - firstWordWidth);
      totalWidth = firstWordWidth + previewW;
      this.previewLeft = this.wordLeft + firstWordWidth;
      this.previewWidth = previewW;
    } else {
      this.previewLeft = 0;
      this.previewWidth = 0;
    }

    this.totalWidth = totalWidth;
    this.wordWidth = totalWidth;

    const firstWordRatio = Math.min(1, Math.max(0.15, (w0.width + padX * 2) / totalWidth));
    this.firstWordRatio = firstWordRatio;
    if (this.rulerEl) {
      this.rulerEl.style.setProperty('--word-solid-ratio', `${(firstWordRatio * 100).toFixed(1)}%`);
    }
  }

  /**
   * Okamžitě usadí a přichytí pravítko na první element (první slovo či řádek) aktuální stránky.
   * Využívá se při aktivaci režimu sledování myši (mouse-follow) nebo při přechodu strany.
   */
  snapToFirstElement() {
    this.resetPositionForPage(1);
  }

  /**
   * Dočasně potlačí veškeré CSS přechody (transition: none) pro okamžité usazení bez animací.
   */
  setNoTransition(noTrans = true) {
    const elements = [this.rulerEl, this.maskTopEl, this.maskBottomEl, this.maskLeftEl, this.maskRightEl, this.wordWaveEl];
    for (const el of elements) {
      if (!el) continue;
      if (noTrans) {
        el.style.transition = "none";
        el.style.setProperty("transition", "none", "important");
      } else {
        el.style.removeProperty("transition");
      }
    }
  }

  /**
   * Resetuje pozici a indexy pravítka při přechodu na novou stránku podle směru listování:
   * - direction >= 0 (vpřed / nová kapitola): přichytí na první řádek / první slovo (index 0)
   * - direction < 0 (vzad / konec kapitoly): přichytí na poslední řádek / poslední slovo
   */
  resetPositionForPage(direction = 1, isPageChanged = true) {
    this.clearPageTransitionTimersAndRAFs();
    const initTime = Date.now();
    this._maxLineIndexOnPage = direction >= 0 ? 0 : -1;
    this._maxWordLineIndexOnPage = direction >= 0 ? 0 : -1;
    this._maxWordIndexOnPage = direction >= 0 ? 0 : -1;
    this._lastLineProgressTime = initTime;
    this._lastWordProgressTime = initTime;
    this._lastActiveLineIndex = -1;
    this._lastActiveColumn = null;
    this._lastEmptyWordsDetectTime = 0;
    if (isPageChanged) {
      this._activeReadingLineIndex = -1;
      this._activeLineStartTime = 0;
      this._completedLineIndices = new Set();
      this._lastWordLineIndex = -1;
      this._lastWordIndex = -1;
      this._wordsReadOnPage = new Set();
    }

    // Clear the transition lock:
    this.isPageTransitioning = false;
    this.isNavigating = false;
    this.isNavigatingPage = false;
    this.isLineLocked = false;
    this.suppressLineAdvancement = false;
    this.navigatingPageLockoutEndTime = Math.max(this.navigatingPageLockoutEndTime || 0, Date.now() + 200);

    const stage = this.getStageElement();
    const content = document.getElementById("reader-content");

    this.disableWordTransition();
    this.setNoTransition(true);
    this.previousActiveLineIndex = -1;
    if (this.rulerEl) {
      this.rulerEl.style.transition = "none";
    }

    const isBackward = direction < 0;

    const performReset = () => {
      if (!this.enabled) {
        this.clearPageTransitionTimersAndRAFs();
        this.forceReleaseNavigationLocks();
        return;
      }

      this.isPageTransitioning = false;
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.isLineLocked = false;
      this.suppressLineAdvancement = false;
      this.navigatingPageLockoutEndTime = Math.max(this.navigatingPageLockoutEndTime || 0, Date.now() + 200);

      try {
        // Refresh lines for the active page:
        this.refreshLines();

        if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
          const isVertical = this.isVerticalMode();
          const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;

          if (isVertical && vp) {
            this.height = this.pdfRulerHeight || 32;
            const targetContainer = document.querySelector(`.pdf-page-container[data-page-number="${this.app?.pdfLoader?.currentPage || 1}"]`);
            if (targetContainer) {
              const cRect = targetContainer.getBoundingClientRect();
              const offsetTop = targetContainer.offsetTop || (cRect.top + vp.scrollTop);
              this.targetY = isBackward ? Math.round(offsetTop + cRect.height - this.height) : Math.round(offsetTop + 20);
            } else {
              this.targetY = isBackward ? Math.round(vp.scrollTop + vp.clientHeight - 80) : Math.round(vp.scrollTop + 80);
            }
            this.currentY = this.targetY;
            this.isPageTransitioning = false;
            if (this.rulerEl) {
              this.rulerEl.classList.remove("is-page-transitioning", "is-hidden", "hidden");
              this.rulerEl.classList.add("is-visible");
              this.rulerEl.style.removeProperty("transition");
              this.rulerEl.style.display = "block";
              this.rulerEl.style.opacity = "1";
              this.rulerEl.style.visibility = "visible";
            }
            if (this.maskTopEl) this.maskTopEl.style.display = "";
            if (this.maskBottomEl) this.maskBottomEl.style.display = "";
            if (this.maskLeftEl) this.maskLeftEl.style.display = "";
            if (this.maskRightEl) this.maskRightEl.style.display = "";
            this.applyPosition();
            return;
          }

          const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
          const stageRect = stage ? stage.getBoundingClientRect() : { top: 60, bottom: window.innerHeight - 60 };
          const canvas = document.querySelector("#reader-content canvas");
          let topBound = stageRect.top;
          let bottomBound = stageRect.bottom;
          if (canvas) {
            const cRect = canvas.getBoundingClientRect();
            if (cRect.height > 50) {
              topBound = cRect.top;
              bottomBound = cRect.bottom;
            }
          }
          this.height = this.pdfRulerHeight || 32;
          this.targetY = isBackward ? Math.round(bottomBound - this.height) : Math.round(topBound);
          this.currentY = this.targetY;
          this.isPageTransitioning = false;
          if (this.rulerEl) {
            this.rulerEl.classList.remove("is-page-transitioning", "is-hidden", "hidden");
            this.rulerEl.classList.add("is-visible");
            this.rulerEl.style.removeProperty("transition");
            this.rulerEl.style.display = "block";
            this.rulerEl.style.opacity = "1";
            this.rulerEl.style.visibility = "visible";
          }
          if (this.maskTopEl) this.maskTopEl.style.display = "";
          if (this.maskBottomEl) this.maskBottomEl.style.display = "";
          if (this.maskLeftEl) this.maskLeftEl.style.display = "";
          if (this.maskRightEl) this.maskRightEl.style.display = "";
          this.applyPosition();
          return;
        }

        if (this.wordTracking) {
          const targetLineIdx = (this.cachedLines && this.cachedLines.length > 0)
            ? (direction < 0 ? this.cachedLines.length - 1 : 0)
            : 0;
          this.activeLineIndex = targetLineIdx;
          const words = this.ensureActiveWords(targetLineIdx);
          if (words && words.length > 0) {
            const targetWordIdx = direction >= 0 ? 0 : words.length - 1;
            this.activeWordIndex = targetWordIdx;
            this.setWordWindow(targetWordIdx);

            const targetWord = words[targetWordIdx];
            const isVertical = this.isVerticalMode();
            const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
            const vScrollTop = vp ? vp.scrollTop : 0;
            if (targetWord) {
              this.lastPointerX = targetWord.centerX;
              this.lastPointerY = isVertical ? Math.round(targetWord.centerY - vScrollTop) : targetWord.centerY;
              this.lastValidPointerX = this.lastPointerX;
              this.lastValidPointerY = this.lastPointerY;
            }

            const shouldSnapClass = this.followMode !== "mouse" && !this.isVerticalMode();
            if (this.rulerEl) {
              this.rulerEl.classList.add("word-tracking-mode");
              if (shouldSnapClass) {
                this.rulerEl.classList.add("is-snapped");
              } else {
                this.rulerEl.classList.remove("is-snapped");
              }
            }
            if (shouldSnapClass) {
              if (this.maskTopEl) this.maskTopEl.classList.add("is-snapped");
              if (this.maskBottomEl) this.maskBottomEl.classList.add("is-snapped");
              if (this.maskLeftEl) this.maskLeftEl.classList.add("is-snapped");
              if (this.maskRightEl) this.maskRightEl.classList.add("is-snapped");
            } else {
              if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
              if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
              if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
              if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
            }
          } else {
            // Fallback to line mode bounds on line 0 so the ruler never hides completely
            this.activeLineIndex = 0;
            const geom = this.computeLineGeometry(0);
            if (geom) {
              this.height = geom.height;
              this.targetY = geom.targetY;
              this.currentY = geom.targetY;
            }
          }
        } else {
          const targetLineIdx = (this.cachedLines && this.cachedLines.length > 0)
            ? (direction < 0 ? this.cachedLines.length - 1 : 0)
            : 0;
          this.activeLineIndex = targetLineIdx;

          if (this.cachedWords && this.cachedWords.length > 0) {
            if (direction < 0) {
              let lastWordIdx = this.cachedWords.length - 1;
              for (let i = this.cachedWords.length - 1; i >= 0; i--) {
                if (this.cachedWords[i].lineIndex === targetLineIdx) {
                  lastWordIdx = i;
                  break;
                }
              }
              this.activeWordIndex = lastWordIdx;
            } else {
              this.activeWordIndex = 0;
            }
          } else {
            this.activeWordIndex = 0;
          }

          if (this.rulerEl) this.rulerEl.classList.remove("word-tracking-mode");
          let geom = this.computeLineGeometry(targetLineIdx);
          if (!geom && (!this.cachedLines || this.cachedLines.length === 0)) {
            geom = (direction >= 0 && !this.isPdfMode && !this.isVerticalMode())
              ? (this.getCanonicalTopLineGeometry(0) || this.getDefaultStartingLineGeometry(direction))
              : this.getDefaultStartingLineGeometry(direction);
          }
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = geom.targetY;
          }

          const isVertical = this.isVerticalMode();
          const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
          const vScrollTop = vp ? vp.scrollTop : 0;
          const line = this.cachedLines && this.cachedLines[targetLineIdx];
          this.lastPointerX = line && line.left != null ? line.left : 100;
          this.lastPointerY = line ? (isVertical ? Math.round(line.centerY - vScrollTop) : line.centerY) : 150;
          this.lastValidPointerX = this.lastPointerX;
          this.lastValidPointerY = this.lastPointerY;

          const shouldSnapClass = this.followMode !== "mouse" && !this.isVerticalMode();
          if (shouldSnapClass) {
            if (this.rulerEl) this.rulerEl.classList.add("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.add("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.add("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.add("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.add("is-snapped");
          } else {
            if (this.rulerEl) this.rulerEl.classList.remove("is-snapped");
            if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
            if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
            if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
            if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
          }
        }

        // Explicitly UNHIDE and reveal the ruler DOM elements:
        if (this.rulerEl) {
          this.rulerEl.classList.remove("is-page-transitioning", "is-hidden", "hidden");
          this.rulerEl.classList.add("is-visible");
          this.rulerEl.style.removeProperty("transition");
          this.rulerEl.style.display = "block";
          this.rulerEl.style.opacity = "1";
          this.rulerEl.style.visibility = "visible";
          if (this.wordTracking) {
            this.rulerEl.classList.add("word-tracking-mode");
          }
        }
        if (this.maskTopEl) this.maskTopEl.style.display = "";
        if (this.maskBottomEl) this.maskBottomEl.style.display = "";
        if (this.maskLeftEl) this.maskLeftEl.style.display = "";
        if (this.maskRightEl) this.maskRightEl.style.display = "";

        // Immediately execute this.applyPosition(); so the ruler sits perfectly on the first word of the new page.
        this.applyPosition();
      } catch (err) {
        console.error("[ReadingRuler] Error in resetPositionForPage:", err);
        this.forceReleaseNavigationLocks();
      }

      requestAnimationFrame(() => {
        if (stage) stage.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (content) content.classList.remove("is-turning-page");
        if (this.followMode !== "mouse" && !this.isVerticalMode()) {
          this.setNoTransition(false);
        }
      });
    };

    performReset();
  }

  /**
   * Naplánuje tichou kalibrační kontrolu geometrie řádků na pozadí (Two-Pass Calibration).
   * Spouští se po ustálení navigačního zámku (220 ms) po úvodním přichycení pravítka na nové stránce.
   * Pokud se plně ustálené souřadnice liší od původního měření o více než 0.75 px,
   * hladce aktualizuje cachedLines a re-aplikuje pozici bez probliknutí či blokování navigace.
   */
  scheduleBackgroundCalibration(delay = 220) {
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }
    if (!this.enabled || this.isImageOnlyPdf) {
      return;
    }
    this._calibrationTimer = setTimeout(() => {
      this._calibrationTimer = null;
      this.runBackgroundCalibration();
    }, delay);
  }

  runBackgroundCalibration() {
    if (!this.enabled || this.isImageOnlyPdf) {
      return;
    }
    // Pokud uživatel aktivně manipuluje s pravítkem, kalibraci neprovádíme
    if (this.isDragging || this.isDraggingRuler || this.isHoldActive) {
      return;
    }

    // Pokud ještě dobíhá animace přechodu strany nebo navigační zámek, odložíme kontrolu
    const isNavigatingLocked = (
      this.isPageTransitioning ||
      this.isNavigating ||
      this.isNavigatingPage ||
      document.body.classList.contains("is-turning-page") ||
      document.body.classList.contains("is-chapter-loading") ||
      !!(this.app?.isNavigating)
    );
    if (isNavigatingLocked) {
      this.scheduleBackgroundCalibration(80);
      return;
    }

    if (!this.cachedLines || this.cachedLines.length === 0) {
      const newLines = this.detectLines(true);
      if (newLines && newLines.length > 0) {
        this.cachedLines = newLines;
        const activeIdx = 0;
        this.activeLineIndex = activeIdx;
        const geom = this.computeLineGeometry(activeIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = geom.targetY;
          this.setNoTransition(true);
          this.applyPosition();
          requestAnimationFrame(() => {
            if (this.followMode !== "mouse" && !this.isVerticalMode()) {
              this.setNoTransition(false);
            }
          });
        }
      }
      return;
    }

    const oldLines = this.cachedLines.slice();
    const oldActiveIdx = this.activeLineIndex;
    const oldWordIdx = this.activeWordIndex;

    // Tiché znovunačtení řádků nad plně ustáleným layoutem
    const newLines = this.detectLines(true);
    if (!newLines || newLines.length === 0) {
      this.cachedLines = oldLines;
      return;
    }

    // Porovnání souřadnic řádků mezi in-flight a settled stavem
    let maxDiffY = 0;
    const checkCount = Math.min(oldLines.length, newLines.length);
    for (let i = 0; i < checkCount; i++) {
      const diffY = Math.abs(newLines[i].centerY - oldLines[i].centerY);
      if (diffY > maxDiffY) {
        maxDiffY = diffY;
      }
    }

    const activeIdx = Math.max(0, Math.min(newLines.length - 1, oldActiveIdx >= 0 ? oldActiveIdx : 0));
    const activeDiffY = (oldLines[activeIdx] && newLines[activeIdx])
      ? Math.abs(newLines[activeIdx].centerY - oldLines[activeIdx].centerY)
      : maxDiffY;

    const effectiveDiff = Math.max(maxDiffY, activeDiffY);

    this.cachedLines = newLines;

    // Pokud je rozdíl zanedbatelný (< 4px), není třeba hýbat pravítkem
    if (effectiveDiff < 4.0) {
      return;
    }

    // Skutečný posun layoutu po ustálení
    if (this.wordTracking) {
      this.refreshWords();
    }
    this.activeLineIndex = activeIdx;
    const geom = this.computeLineGeometry(activeIdx);
    if (geom) {
      this.height = geom.height;
      this.targetY = geom.targetY;
      if (!this.isDragging && !this.isDraggingRuler) {
        this.currentY = geom.targetY;
      }
    }
    if (this.wordTracking && oldWordIdx >= 0) {
      const words = this.ensureActiveWords(activeIdx);
      if (words && words.length > 0) {
        const wIdx = Math.min(words.length - 1, oldWordIdx);
        this.activeWordIndex = wIdx;
        this.setWordWindow(wIdx);
      }
    }

    // Tiché usazení bez vizuálního škubnutí (dočasně vypneme CSS transition)
    this.setNoTransition(true);
    this.applyPosition();
    requestAnimationFrame(() => {
      if (this.followMode !== "mouse" && !this.isVerticalMode()) {
        this.setNoTransition(false);
      }
    });
  }

  getReaderContainer() {
    return document.getElementById("paged-viewport") || this.container || document.getElementById("paged-stage") || document.body;
  }

  /**
   * Určí směr posunu pravítka při klepnutí v klávesovém režimu podle layout zón:
   * - Krok vzad (-1):
   *   - Levý okraj: X <= 12 %
   *   - Střed-nahoře: (12 % < X < 80 %) A ZÁROVEŇ (Y <= 50 %)
   * - Krok vpřed (+1):
   *   - Pravý okraj: X >= 80 %
   *   - Střed-dole: (12 % < X < 80 %) A ZÁROVEŇ (Y > 50 %)
   */
  getTapDirection(clientX, clientY) {
    let relX = clientX;
    let relY = clientY;
    if (clientX > 1 || clientY > 1) {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      relX = clientX / width;
      relY = clientY / height;
    }

    if (relX <= 0.12) return -1;
    if (relX >= 0.80) return 1;
    return relY <= 0.50 ? -1 : 1;
  }

  /**
   * Zpracuje diskrétní klepnutí (tap / click) v klávesovém režimu:
   * - Povoleno výhradně pro pointerType === 'touch' nebo mouse click.
   * - Ignoruje při pohybu > 10px nebo pokud je aktivní / dokončené podržení (long-press).
   */
  handleTap(clientX, clientY, pointerType = "touch", movementDelta = 0) {
    if (!this.enabled || this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) || this.isLineLocked || this.followMode !== "keyboard") return false;
    if (this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return false;
    if (pointerType !== "touch" && pointerType !== "mouse" && pointerType !== "pen") return false;
    if (movementDelta > 10) return false;
    if (this.isHoldTriggered) return false;

    const now = Date.now();
    // Ochrana proti syntetickému clicku po dotyku (iOS Safari generuje click cca 300ms po touchend)
    if (pointerType === "mouse" && now - (this.lastTouchTapTime || 0) < 450) {
      return false;
    }
    // Ochrana proti duplikaci ze souběžných událostí v rámci téhož gesta (pointerup + touchend < 35ms)
    if (now - this.lastTapStepTime < 35) {
      return false;
    }

    if (pointerType === "touch") {
      this.lastTouchTapTime = now;
    }
    this.cancelHold(false);
    this.lastTapStepTime = now;

    if (this.isVerticalMode()) {
      let relX = clientX;
      if (clientX > 1) {
        const width = window.innerWidth || 1;
        relX = clientX / width;
      }
      if (pointerType === "mouse" || (relX > 0.12 && relX < 0.80)) {
        this.reanchorAt(clientX, clientY);
        return true;
      }
    }

    const dir = this.getTapDirection(clientX, clientY);
    this.stepLine(dir, true);
    return true;
  }

  /**
   * Posun o jeden řádek nebo slovo (krokování tlačítky na iPadu či šipkami)
   */
  stepLine(direction, force = false) {
    // Pokud probíhá přechod strany, aktivní tažení nebo dobíhá lockout přechodu strany, ignorovat krokování
    if (!this.enabled || this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
    if (direction > 0 && (this.suppressLineAdvancement || (performance.now() - this.pageTurnTimestamp < 350))) {
      return;
    }
    if (!force && this.isInteracting()) return;
    this.cancelHold();

    // Okamžitě zrušit jakýkoliv běžící programový scroll timer pro okamžitý snap bez prodlev
    if (this._programmaticScrollTimer) {
      clearTimeout(this._programmaticScrollTimer);
      this._programmaticScrollTimer = null;
    }
    this._isProgrammaticScroll = false;
    this._ensureLinesFreshForCurrentLayout();

    try {
      if (this.wordTracking) {
        if (this.isWordTransitioning) {
          if (this.wordTransitionTimer) {
            clearTimeout(this.wordTransitionTimer);
            this.wordTransitionTimer = null;
          }
          this.isWordTransitioning = false;
          this.disableWordTransition();
        }



        const isVertical = this.isVerticalMode();
        const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;

        // Pokud je aktuální řádek samostatné médium/obrázek
        if (this.activeWordIndex < 0 && this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length && this.cachedLines[this.activeLineIndex].isMedia) {
          const targetLineIdx = this.activeLineIndex + direction;
          if (direction > 0 && targetLineIdx >= this.cachedLines.length) {
            if (this.onBoundary && !isVertical) {
              this.lockAdvancement(350);
              this.onBoundary(1);
              return;
            }
          } else if (direction < 0 && targetLineIdx < 0) {
            if (this.onBoundary && !isVertical) {
              this.onBoundary(-1);
              return;
            }
          } else if (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) {
            const nextLine = this.cachedLines[targetLineIdx];
            if (nextLine.isMedia) {
              this.activeLineIndex = targetLineIdx;
              this.activeWordIndex = -1;
              this.rulerEl.classList.remove("word-tracking-mode");
              const geom = this.computeLineGeometry(targetLineIdx);
              if (geom) {
                this.height = geom.height;
                this.targetY = geom.targetY;
                this.currentY = this.targetY;
              }
              if (isVertical && this.followMode === "keyboard" && this.stationaryScreenY !== null && vp) {
                const h = geom ? geom.height : (Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36));
                const maxScrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
                const idealScrollTop = Math.round(nextLine.centerY - (this.stationaryScreenY + h / 2));
                const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, idealScrollTop));
                const scrollDelta = clampedScrollTop - vp.scrollTop;
                this._applyVerticalScrollDelta(vp, scrollDelta);
              }
              this.lastPointerX = nextLine.left != null ? nextLine.left : 100;
              this.lastPointerY = isVertical ? Math.round(nextLine.centerY - (vp ? vp.scrollTop : 0)) : nextLine.centerY;
              this.lastValidPointerX = this.lastPointerX;
              this.lastValidPointerY = this.lastPointerY;
              this._snapRulerInstantOrAnimated();
              this.applyPosition();
              return;
            } else {
              const words = this.ensureActiveWords(targetLineIdx);
              const targetWordIdx = direction > 0 ? 0 : Math.max(0, words.length - 1);
              this.activeLineIndex = targetLineIdx;
              this.activeWordIndex = targetWordIdx;
              this.setWordWindow(targetWordIdx);
              this.rulerEl.classList.add("word-tracking-mode");
              const targetWord = words[targetWordIdx];
              if (isVertical && this.followMode === "keyboard" && this.stationaryScreenY !== null && vp) {
                const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);
                const maxScrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
                const idealScrollTop = Math.round(nextLine.centerY - (this.stationaryScreenY + h / 2));
                const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, idealScrollTop));
                const scrollDelta = clampedScrollTop - vp.scrollTop;
                this._applyVerticalScrollDelta(vp, scrollDelta);
              }
              this.lastPointerX = targetWord ? targetWord.centerX : 100;
              this.lastPointerY = targetWord ? (isVertical ? Math.round(targetWord.centerY - (vp ? vp.scrollTop : 0)) : targetWord.centerY) : 150;
              this.lastValidPointerX = this.lastPointerX;
              this.lastValidPointerY = this.lastPointerY;
              this._snapRulerInstantOrAnimated();
              this.disableWordTransition();
              this.applyPosition();
              return;
            }
          }
        }

        // Běžné krokování po slovech na textových řádcích
        const curLineIdx = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) ? this.activeLineIndex : 0;
        let lineWords = this.ensureActiveWords(curLineIdx);

        if (direction > 0) {
          if (this.activeWordIndex < lineWords.length - 1 && this.activeWordIndex >= 0) {
            this.activeWordIndex++;
          } else {
            // Posun na další řádek
            const nextLineIdx = curLineIdx + 1;
            if (nextLineIdx >= this.cachedLines.length) {
              if (this.onBoundary && !isVertical) {
                this.lockAdvancement(350);
                this.onBoundary(1);
                return;
              }
            } else {
              const nextLine = this.cachedLines[nextLineIdx];
              if (nextLine && nextLine.isMedia) {
                this.activeLineIndex = nextLineIdx;
                this.activeWordIndex = -1;
                this.rulerEl.classList.remove("word-tracking-mode");
                const geom = this.computeLineGeometry(nextLineIdx);
                if (geom) {
                  this.height = geom.height;
                  this.targetY = geom.targetY;
                  this.currentY = this.targetY;
                }
                this.lastPointerX = nextLine.left != null ? nextLine.left : 100;
                this.lastPointerY = isVertical ? Math.round(nextLine.centerY - (vp ? vp.scrollTop : 0)) : nextLine.centerY;
                this.lastValidPointerX = this.lastPointerX;
                this.lastValidPointerY = this.lastPointerY;
                this._snapRulerInstantOrAnimated();
                this.disableWordTransition();
                this.applyPosition();
                return;
              }
              this.activeLineIndex = nextLineIdx;
              lineWords = this.ensureActiveWords(nextLineIdx);
              this.activeWordIndex = 0;
            }
          }
        } else if (direction < 0) {
          if (this.activeWordIndex > 0) {
            this.activeWordIndex--;
          } else {
            // Posun na předchozí řádek
            const prevLineIdx = curLineIdx - 1;
            if (prevLineIdx < 0) {
              if (this.onBoundary && !isVertical) {
                this.onBoundary(-1);
                return;
              }
            } else {
              const prevLine = this.cachedLines[prevLineIdx];
              if (prevLine && prevLine.isMedia) {
                this.activeLineIndex = prevLineIdx;
                this.activeWordIndex = -1;
                this.rulerEl.classList.remove("word-tracking-mode");
                const geom = this.computeLineGeometry(prevLineIdx);
                if (geom) {
                  this.height = geom.height;
                  this.targetY = geom.targetY;
                  this.currentY = this.targetY;
                }
                this.lastPointerX = prevLine.left != null ? prevLine.left : 100;
                this.lastPointerY = isVertical ? Math.round(prevLine.centerY - (vp ? vp.scrollTop : 0)) : prevLine.centerY;
                this.lastValidPointerX = this.lastPointerX;
                this.lastValidPointerY = this.lastPointerY;
                this._snapRulerInstantOrAnimated();
                this.disableWordTransition();
                this.applyPosition();
                return;
              }
              this.activeLineIndex = prevLineIdx;
              lineWords = this.ensureActiveWords(prevLineIdx);
              this.activeWordIndex = Math.max(0, lineWords.length - 1);
            }
          }
        }

        const newIdx = this.activeWordIndex;
        if (lineWords && lineWords.length > 0 && newIdx >= 0 && newIdx < lineWords.length) {
          const targetWord = lineWords[newIdx];
          const targetLineIdx = this.activeLineIndex;
          const nextLine = this.cachedLines[targetLineIdx];

          if (isVertical && this.followMode === "keyboard") {
            if (this.stationaryScreenY === null) {
              this.initDefaultStationaryAnchor();
            }
            if (this.stationaryScreenY !== null && vp && nextLine) {
              const geom = this.computeLineGeometry(targetLineIdx);
              if (geom) {
                this.height = geom.height;
                this.targetY = geom.targetY;
                this.currentY = this.targetY;
              }
              const h = geom ? geom.height : (Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36));
              const maxScrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
              const idealScrollTop = Math.round(nextLine.centerY - (this.stationaryScreenY + h / 2));
              const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, idealScrollTop));
              const scrollDelta = clampedScrollTop - vp.scrollTop;
              this._applyVerticalScrollDelta(vp, scrollDelta);
            }
          }

          this.setWordWindow(newIdx);
          this.lastPointerX = targetWord ? targetWord.centerX : 100;
          this.lastPointerY = targetWord ? (isVertical ? Math.round(targetWord.centerY - (vp ? vp.scrollTop : 0)) : targetWord.centerY) : 150;
          this.lastValidPointerX = this.lastPointerX;
          this.lastValidPointerY = this.lastPointerY;

          this.rulerEl.classList.add("word-tracking-mode");
          this._snapRulerInstantOrAnimated();
          this.disableWordTransition();
          this.applyPosition();

          if (this.isVerticalMode()) {
            if (vp && Number.isFinite(this.targetY)) {
              const screenY = this.targetY - vp.scrollTop;
              if (screenY < 80) {
                this._applyVerticalScrollDelta(vp, screenY - 120);
              } else if (screenY > vp.clientHeight - 120) {
                this._applyVerticalScrollDelta(vp, screenY - (vp.clientHeight - 160));
              }
            }
          }
          return;
        }
      }

      this.disableWordTransition();

      // --- STANDARDNÍ REŽIM ŘÁDKŮ (Line-level mode) ---
      if (this.cachedLines.length === 0) {
        this.refreshLines();
      }

      if (this.cachedLines.length > 0) {
        let newIdx;
        if (this.activeLineIndex < 0) {
          if (direction > 0) {
            newIdx = 0;
          } else if (direction < 0) {
            newIdx = this.cachedLines.length - 1;
          } else {
            newIdx = 0;
          }
        } else {
          const curIdx = this.activeLineIndex;
          if (direction > 0 && curIdx >= this.cachedLines.length - 1) {
            if (this.onBoundary && !this.isVerticalMode()) {
              this.lockAdvancement(350);
              this.onBoundary(1);
              return;
            }
          } else if (direction < 0 && curIdx <= 0) {
            if (this.onBoundary && !this.isVerticalMode()) {
              this.onBoundary(-1);
              return;
            }
          }
          newIdx = curIdx + direction;
        }

        newIdx = Math.max(0, Math.min(this.cachedLines.length - 1, newIdx));

        const isVertical = this.isVerticalMode();

        if (isVertical && this.followMode === "keyboard") {
          if (this.stationaryScreenY === null) {
            this.initDefaultStationaryAnchor();
          }
        }

        if (isVertical && this.followMode === "keyboard" && this.stationaryScreenY !== null) {
          const vp = document.querySelector(".paged-viewport") || document.getElementById("paged-viewport");
          const curIdx = this.activeLineIndex;
          const currentLine = (curIdx >= 0 && curIdx < this.cachedLines.length) ? this.cachedLines[curIdx] : null;
          const nextLine = (newIdx >= 0 && newIdx < this.cachedLines.length) ? this.cachedLines[newIdx] : null;

          if (currentLine && nextLine && vp) {
            this.activeLineIndex = newIdx;
            this._checkLineProgress(newIdx, true);
            this.rulerEl.classList.remove("word-tracking-mode");
            const geom = this.computeLineGeometry(newIdx);
            if (geom) {
              this.height = geom.height;
              this.targetY = geom.targetY;
              this.currentY = this.targetY;
            }
            const h = geom ? geom.height : (Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36));
            const maxScrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);

            // Keep the ruler fixed at stationaryScreenY by scrolling the viewport underneath
            // Clamped within [0, maxScrollTop] for edge boundaries
            const idealScrollTop = Math.round(nextLine.centerY - (this.stationaryScreenY + h / 2));
            const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, idealScrollTop));
            const scrollDelta = clampedScrollTop - vp.scrollTop;
            this._applyVerticalScrollDelta(vp, scrollDelta);

            this.lastPointerX = nextLine.left != null ? nextLine.left : 100;
            this.lastPointerY = isVertical ? Math.round(nextLine.centerY - (vp ? vp.scrollTop : 0)) : nextLine.centerY;
            this.lastValidPointerX = this.lastPointerX;
            this.lastValidPointerY = this.lastPointerY;

            this._snapRulerInstantOrAnimated();
            this.applyPosition();
            return;
          }
        }

        this.activeLineIndex = newIdx;
        this._checkLineProgress(newIdx, true);

        this.rulerEl.classList.remove("word-tracking-mode");
        const geom = this.computeLineGeometry(newIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }

        const line = this.cachedLines[newIdx];
        this.lastPointerX = line.left != null ? line.left : 100;
        this.lastPointerY = isVertical ? Math.round(line.centerY - (vp ? vp.scrollTop : 0)) : line.centerY;
        this.lastValidPointerX = this.lastPointerX;
        this.lastValidPointerY = this.lastPointerY;

        this._snapRulerInstantOrAnimated();
        this.applyPosition();
        if (isVertical) {
          const vp = document.querySelector(".paged-viewport") || document.getElementById("paged-viewport");
          if (vp && Number.isFinite(this.targetY)) {
            const screenY = this.targetY - vp.scrollTop;
            if (screenY < 80) {
              this._applyVerticalScrollDelta(vp, screenY - 120);
            } else if (screenY > vp.clientHeight - 120) {
              this._applyVerticalScrollDelta(vp, screenY - (vp.clientHeight - 160));
            }
          }
        }
        return;
      } else if (this.cachedLines.length === 0 && this.onBoundary && direction !== 0 && !this.isVerticalMode()) {
        if (direction > 0) {
          this.lockAdvancement(350);
        }
        this.onBoundary(direction > 0 ? 1 : -1);
        return;
      }
    } catch (err) {
      console.error("[ReadingRuler] Error in stepLine:", err);
    }
  }

  moveBy(deltaY) {
    if (this.isLineLocked) return;
    this.disableWordTransition();
    if (this.cachedLines.length > 0) {
      this.stepLine(deltaY > 0 ? 1 : -1);
    }
  }

  requestRender() {
    if (!this.animFrameId) {
      this.animFrameId = requestAnimationFrame(() => {
        this.currentY += (this.targetY - this.currentY) * 0.4;
        this.applyPosition();
        this.animFrameId = null;

        if (Math.abs(this.targetY - this.currentY) > 0.5) {
          this.requestRender();
        }
      });
    }
  }

  getStageElement() {
    return document.getElementById("paged-stage") || this.container || document.getElementById("reader-content") || document.body;
  }

  clearFocusTextMask(stage) {
    this._focusMaskDirty = false;
    const targets = new Set();
    const targetStage = stage || this.getStageElement();
    if (targetStage) targets.add(targetStage);
    const pStage = document.getElementById("paged-stage");
    if (pStage) targets.add(pStage);
    const rContent = document.getElementById("reader-content");
    if (rContent) targets.add(rContent);
    const pViewport = document.getElementById("paged-viewport");
    if (pViewport) targets.add(pViewport);
    if (this.container) targets.add(this.container);

    for (const el of targets) {
      if (!el || !el.classList || !el.style) continue;
      el.classList.remove("focus-active", "focus-mode-active");
      el.style.webkitMaskImage = "";
      el.style.maskImage = "";
      el.style.webkitMaskPosition = "";
      el.style.maskPosition = "";
      el.style.webkitMaskSize = "";
      el.style.maskSize = "";
      el.style.webkitMaskRepeat = "";
      el.style.maskRepeat = "";
      el.style.webkitMaskComposite = "";
      el.style.maskComposite = "";
      el.style.webkitMaskAttachment = "";
      el.style.maskAttachment = "";
      el.style.removeProperty("--mask-slit-top");
      el.style.removeProperty("--mask-slit-bottom");
      el.style.removeProperty("--focus-text-dim");
      el.style.removeProperty("-webkit-mask-image");
      el.style.removeProperty("mask-image");
      el.style.removeProperty("-webkit-mask-attachment");
      el.style.removeProperty("mask-attachment");
      el.style.removeProperty("-webkit-mask-size");
      el.style.removeProperty("mask-size");
      const mediaEls = el.querySelectorAll(".active-focus, .ruler-focused-image");
      mediaEls.forEach(m => m.classList.remove("active-focus", "ruler-focused-image"));
    }

    const allLines = document.querySelectorAll(".reading-line, .line-focused, .line-dimmed");
    allLines.forEach(l => l.classList.remove("line-focused", "line-dimmed", "active-focus"));

    const masks = [this.maskTopEl, this.maskBottomEl, this.maskLeftEl, this.maskRightEl, this.maskInactiveSpreadEl];
    for (const m of masks) {
      if (m) {
        m.style.display = "none";
        m.classList.remove("is-visible", "pdf-overlay-mask", "mode-bottom-cover");
        m.classList.add("is-hidden");
        m.style.removeProperty("background-color");
        m.style.removeProperty("opacity");
        m.style.removeProperty("max-width");
        m.style.removeProperty("right");
      }
    }

    if (this._lastFocusedMediaEl) {
      this._lastFocusedMediaEl.classList.remove("active-focus", "ruler-focused-image");
      const parentFig = this._lastFocusedMediaEl.closest("figure, picture, .chapter-illustration, [class*='ornament'], [class*='illustration']");
      if (parentFig && parentFig.classList) {
        parentFig.classList.remove("active-focus", "ruler-focused-image");
      }
      this._lastFocusedMediaEl = null;
    }
    if (this.rulerEl) {
      this.rulerEl.classList.remove("is-media-focus");
    }
  }

  applyPosition() {
    if (!this.rulerEl) return;

    if (!this.enabled) {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      this.clearFocusTextMask();
      return;
    }

    this._ensureLinesFreshForCurrentLayout();
    if (!this.cachedLines || this.cachedLines.length === 0) {
      this.detectLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
    }

    if (!this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      this.clearFocusTextMask();
      return;
    }

    const activeStyle = this.style || this.mode || "highlight";
    const isStyleOff = activeStyle === "off";

    if (this.isPageTransitioning || isStyleOff) {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      if (isStyleOff) {
        this.rulerEl.classList.add("mode-off");
      }
      if (this.isPageTransitioning) {
        this.rulerEl.classList.add("is-page-transitioning");
      }
      this.rulerEl.style.setProperty("display", "none", "important");
      this.rulerEl.style.setProperty("opacity", "0", "important");
      this.rulerEl.style.setProperty("visibility", "hidden", "important");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
    } else {
      this.rulerEl.classList.remove("is-hidden", "is-page-transitioning", "mode-off");
      this.rulerEl.classList.add("is-visible");
      if (this.rulerEl.style.display === "none") {
        this.rulerEl.style.display = "block";
      }
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
    }

    // --- PDF MODE CONTINUOUS MECHANICAL OVERLAY ---
    if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.pdfRulerHeight || 32);
      this.rulerEl.style.height = `${h}px`;
      this.rulerEl.style.transition = "none";

      const isVertical = this.isVerticalMode();
      const viewport = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
      const vScrollTop = (isVertical && viewport) ? viewport.scrollTop : 0;

      const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, bottom: window.innerHeight };

      let targetLeft = stageRect.left;
      let targetWidth = stageRect.width;

      if (isVertical && viewport) {
        const containers = document.querySelectorAll("#reader-content .pdf-page-container");
        let activeContainer = null;
        const vMid = window.innerHeight / 2;
        let minMidDist = Infinity;

        for (const c of containers) {
          const r = c.getBoundingClientRect();
          if (r.bottom >= 0 && r.top <= window.innerHeight) {
            const dist = Math.abs((r.top + r.bottom) / 2 - vMid);
            if (dist < minMidDist) {
              minMidDist = dist;
              activeContainer = c;
            }
          }
        }
        if (!activeContainer && containers.length > 0) {
          activeContainer = containers[0];
        }

        if (activeContainer) {
          const canvas = activeContainer.querySelector("canvas") || activeContainer;
          const cRect = canvas.getBoundingClientRect();
          if (cRect.width > 50) {
            targetLeft = cRect.left;
            targetWidth = cRect.width;
          }
        }

        const maxScrollHeight = Math.max(viewport.scrollHeight, stageRect.height);
        if (!Number.isFinite(this.currentY)) {
          this.currentY = vScrollTop + Math.round(window.innerHeight * 0.3);
        }
        if (this.style === "bottom-cover" || this.mode === "bottom-cover") {
          this.currentY = Math.max(0, Math.min(maxScrollHeight, this.currentY));
        } else {
          this.currentY = Math.max(0, Math.min(maxScrollHeight - h, this.currentY));
        }

        const screenY = Math.round(this.currentY - vScrollTop);
        const colorHexMap = {
          amber: "#f59e0b",
          cyan: "#06b6d4",
          emerald: "#10b981",
          lavender: "#a855f7",
          slate: "#64748b"
        };
        this._rulerLeft = Math.round(targetLeft);
        this._rulerWidth = Math.round(targetWidth);

        // 1. Vizuální indikátor pravítka ve vertikálním PDF módu
        if (this.style === "bottom-cover" || this.mode === "bottom-cover") {
          const hex = colorHexMap[this.color] || "#f59e0b";
          this.rulerEl.style.top = "0px";
          this.rulerEl.style.left = "0px";
          this.rulerEl.style.right = "auto";
          this.rulerEl.style.width = `${Math.round(targetWidth)}px`;
          this.rulerEl.style.maxWidth = `${Math.round(targetWidth)}px`;
          this.rulerEl.style.height = "2px";
          this.rulerEl.style.transform = `translate3d(${Math.round(targetLeft)}px, ${Math.round(screenY)}px, 0)`;
          this.rulerEl.style.setProperty("background-color", hex, "important");
          this.rulerEl.style.setProperty("color", hex, "important");
          this.rulerEl.style.border = "none";
          this.rulerEl.style.outline = "none";
          this.rulerEl.style.setProperty("box-shadow", "0 1px 4px rgba(var(--ruler-glow-rgb, 245, 158, 11), 0.45)", "important");
          this.rulerEl.style.opacity = "1";
          this.rulerEl.style.visibility = "visible";
          this.rulerEl.style.display = "block";
          this.rulerEl.style.setProperty("z-index", "20", "important");
        } else if (this.style === "off" || this.mode === "off") {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.classList.add("is-hidden", "mode-off");
          this.rulerEl.style.setProperty("display", "none", "important");
          this.rulerEl.style.setProperty("opacity", "0", "important");
          this.rulerEl.style.setProperty("visibility", "hidden", "important");
          this.rulerEl.style.backgroundColor = "transparent";
          this.rulerEl.style.border = "none";
          this.rulerEl.style.outline = "none";
          this.rulerEl.style.boxShadow = "none";
          if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
        } else {
          // Highlight
          this.rulerEl.style.top = "0px";
          this.rulerEl.style.left = "0px";
          this.rulerEl.style.right = "auto";
          this.rulerEl.style.width = `${Math.round(targetWidth)}px`;
          this.rulerEl.style.maxWidth = `${Math.round(targetWidth)}px`;
          this.rulerEl.style.height = `${h}px`;
          this.rulerEl.style.transform = `translate3d(${Math.round(targetLeft)}px, ${screenY}px, 0)`;
          this.rulerEl.style.backgroundColor = "";
          this.rulerEl.style.border = "none";
          this.rulerEl.style.outline = "none";
          this.rulerEl.style.boxShadow = "none";
          this.rulerEl.style.opacity = "1";
          this.rulerEl.style.visibility = "visible";
          this.rulerEl.style.display = "block";
        }

        // 2. Dimming masky ve vertikálním PDF módu dle focusMode
        const isPdfFocus = this.enabled && this.focusMode && this.focusMode !== "off";
        if (isPdfFocus) {
          const dimOpacity = this.dimOpacity !== undefined ? this.dimOpacity : 0.65;
          const themeBg = "var(--bg-theme, var(--color-bg, #fbf0d9))";
          const vh = window.innerHeight;
          const roundH = Math.round(h);
          const roundScreenY = Math.round(screenY);
          const topBandBottom = roundScreenY;
          const bottomBandTop = this.style === "bottom-cover" ? roundScreenY : Math.round(roundScreenY + roundH);

          if (this.focusMode === "up" || this.focusMode === "both") {
            if (this.maskTopEl) {
              this.maskTopEl.className = "ruler-mask ruler-mask-top is-visible";
              this.maskTopEl.classList.remove("pdf-overlay-mask");
              this.maskTopEl.style.setProperty("display", "block", "important");
              this.maskTopEl.style.setProperty("background-color", themeBg, "important");
              this.maskTopEl.style.setProperty("opacity", String(dimOpacity), "important");
              this.maskTopEl.style.setProperty("z-index", "15", "important");
              this.maskTopEl.style.setProperty("pointer-events", "none", "important");
              this.maskTopEl.style.top = "0px";
              this.maskTopEl.style.left = "0px";
              this.maskTopEl.style.right = "auto";
              this.maskTopEl.style.maxWidth = "none";
              this.maskTopEl.style.width = "100%";
              this.maskTopEl.style.height = `${vh}px`;
              this.maskTopEl.style.transform = `translate3d(0, ${Math.round(topBandBottom - vh)}px, 0)`;
            }
          } else if (this.maskTopEl) {
            this.maskTopEl.style.display = "none";
            this.maskTopEl.classList.remove("pdf-overlay-mask", "is-visible");
            this.maskTopEl.classList.add("is-hidden");
          }

          if (this.focusMode === "down" || this.focusMode === "both") {
            if (this.maskBottomEl) {
              this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-visible";
              this.maskBottomEl.classList.remove("pdf-overlay-mask", "mode-bottom-cover");
              this.maskBottomEl.style.setProperty("display", "block", "important");
              this.maskBottomEl.style.setProperty("background-color", themeBg, "important");
              this.maskBottomEl.style.setProperty("opacity", String(dimOpacity), "important");
              this.maskBottomEl.style.setProperty("z-index", "15", "important");
              this.maskBottomEl.style.setProperty("pointer-events", "none", "important");
              this.maskBottomEl.style.top = "0px";
              this.maskBottomEl.style.left = "0px";
              this.maskBottomEl.style.right = "auto";
              this.maskBottomEl.style.maxWidth = "none";
              this.maskBottomEl.style.width = "100%";
              this.maskBottomEl.style.height = `${Math.max(vh * 2, 2000)}px`;
              this.maskBottomEl.style.transform = `translate3d(0, ${bottomBandTop}px, 0)`;
            }
          } else if (this.maskBottomEl) {
            this.maskBottomEl.style.display = "none";
            this.maskBottomEl.classList.remove("pdf-overlay-mask", "is-visible");
            this.maskBottomEl.classList.add("is-hidden");
          }

          if (this.focusMode === "both") {
            const slitLeft = Math.max(0, Math.round(targetLeft));
            const slitRight = Math.min(window.innerWidth, Math.round(targetLeft + targetWidth));
            const leftBandWidth = Math.max(0, slitLeft);
            if (leftBandWidth > 0 && this.maskLeftEl) {
              this.maskLeftEl.className = "ruler-mask ruler-mask-left is-visible";
              this.maskLeftEl.classList.remove("pdf-overlay-mask");
              this.maskLeftEl.style.setProperty("display", "block", "important");
              this.maskLeftEl.style.setProperty("background-color", themeBg, "important");
              this.maskLeftEl.style.setProperty("opacity", String(dimOpacity), "important");
              this.maskLeftEl.style.setProperty("z-index", "15", "important");
              this.maskLeftEl.style.setProperty("pointer-events", "none", "important");
              this.maskLeftEl.style.top = "0px";
              this.maskLeftEl.style.left = "0px";
              this.maskLeftEl.style.right = "auto";
              this.maskLeftEl.style.maxWidth = "none";
              this.maskLeftEl.style.width = `${leftBandWidth}px`;
              this.maskLeftEl.style.height = `${roundH}px`;
              this.maskLeftEl.style.transform = `translate3d(0, ${roundScreenY}px, 0)`;
            } else if (this.maskLeftEl) {
              this.maskLeftEl.style.display = "none";
              this.maskLeftEl.classList.remove("is-visible");
              this.maskLeftEl.classList.add("is-hidden");
            }

            const rightBandLeft = slitRight;
            const rightBandWidth = Math.max(0, window.innerWidth - rightBandLeft);
            if (rightBandWidth > 0 && this.maskRightEl) {
              this.maskRightEl.className = "ruler-mask ruler-mask-right is-visible";
              this.maskRightEl.classList.remove("pdf-overlay-mask");
              this.maskRightEl.style.setProperty("display", "block", "important");
              this.maskRightEl.style.setProperty("background-color", themeBg, "important");
              this.maskRightEl.style.setProperty("opacity", String(dimOpacity), "important");
              this.maskRightEl.style.setProperty("z-index", "15", "important");
              this.maskRightEl.style.setProperty("pointer-events", "none", "important");
              this.maskRightEl.style.top = "0px";
              this.maskRightEl.style.left = "0px";
              this.maskRightEl.style.right = "auto";
              this.maskRightEl.style.maxWidth = "none";
              this.maskRightEl.style.width = `${rightBandWidth}px`;
              this.maskRightEl.style.height = `${roundH}px`;
              this.maskRightEl.style.transform = `translate3d(${rightBandLeft}px, ${roundScreenY}px, 0)`;
            } else if (this.maskRightEl) {
              this.maskRightEl.style.display = "none";
              this.maskRightEl.classList.remove("is-visible");
              this.maskRightEl.classList.add("is-hidden");
            }
          } else {
            if (this.maskLeftEl) { this.maskLeftEl.style.display = "none"; this.maskLeftEl.classList.remove("is-visible"); this.maskLeftEl.classList.add("is-hidden"); }
            if (this.maskRightEl) { this.maskRightEl.style.display = "none"; this.maskRightEl.classList.remove("is-visible"); this.maskRightEl.classList.add("is-hidden"); }
          }
          if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
        } else {
          if (this.maskTopEl) { this.maskTopEl.style.display = "none"; this.maskTopEl.classList.remove("pdf-overlay-mask", "is-visible"); }
          if (this.maskBottomEl) { this.maskBottomEl.style.display = "none"; this.maskBottomEl.classList.remove("pdf-overlay-mask", "is-visible"); }
          if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
          if (this.maskRightEl) this.maskRightEl.style.display = "none";
          if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
        }
        return;
      }

      // Horizontální režim PDF (jedna strana nebo dvoustrana)
      let boundsTop = stageRect.top;
      let boundsBottom = stageRect.bottom;
      const isSpread = this.isSpreadActive();
      const spreadInfo = isSpread ? this.getActiveSpreadInfo(null) : null;

      if (spreadInfo) {
        const activeSpreadRect = spreadInfo.activeRect;
        if (activeSpreadRect.width > 50) {
          targetLeft = activeSpreadRect.left;
          targetWidth = activeSpreadRect.width;
          boundsTop = activeSpreadRect.top;
          boundsBottom = activeSpreadRect.bottom;
        }
      } else {
        const spread = document.querySelector("#reader-content .pdf-spread-container");
        if (spread) {
          const sRect = spread.getBoundingClientRect();
          if (sRect.width > 50) {
            targetLeft = sRect.left;
            targetWidth = sRect.width;
            boundsTop = sRect.top;
            boundsBottom = sRect.bottom;
          }
        } else {
          const canvas = document.querySelector("#reader-content canvas");
          if (canvas) {
            const cRect = canvas.getBoundingClientRect();
            if (cRect.width > 50) {
              targetLeft = cRect.left;
              targetWidth = cRect.width;
              boundsTop = cRect.top;
              boundsBottom = cRect.bottom;
            }
          }
        }
      }

      // Clamp currentY within bounds
      let y = Number.isFinite(this.currentY) ? Math.round(this.currentY) : Math.round(boundsTop + 50);
      if (this.style === "bottom-cover" || this.mode === "bottom-cover") {
        y = Math.max(Math.round(boundsTop), Math.min(Math.round(boundsBottom), y));
      } else {
        y = Math.max(Math.round(boundsTop), Math.min(Math.round(boundsBottom - h), y));
      }
      this.currentY = y;

      const activeStyle = this.style || this.mode || "highlight";
      const colorHexMap = {
        amber: "#f59e0b",
        cyan: "#06b6d4",
        emerald: "#10b981",
        lavender: "#a855f7",
        slate: "#64748b"
      };

      // 1. Vizuální indikátor pravítka v horizontálním PDF módu
      const rulerTop = y;
      const rulerLeft = Math.round(targetLeft);
      const rulerWidth = Math.round(targetWidth);
      this._rulerLeft = rulerLeft;
      this._rulerWidth = rulerWidth;

      if (activeStyle === "bottom-cover") {
        const hex = colorHexMap[this.color] || "#f59e0b";
        this.rulerEl.style.top = "0px";
        this.rulerEl.style.left = "0px";
        this.rulerEl.style.right = "auto";
        this.rulerEl.style.width = `${rulerWidth}px`;
        this.rulerEl.style.maxWidth = `${rulerWidth}px`;
        this.rulerEl.style.height = "2px";
        this.rulerEl.style.transform = `translate3d(${rulerLeft}px, ${rulerTop}px, 0)`;
        this.rulerEl.style.setProperty("background-color", hex, "important");
        this.rulerEl.style.setProperty("color", hex, "important");
        this.rulerEl.style.border = "none";
        this.rulerEl.style.outline = "none";
        this.rulerEl.style.setProperty("box-shadow", "0 1px 4px rgba(var(--ruler-glow-rgb, 245, 158, 11), 0.45)", "important");
        this.rulerEl.style.opacity = "1";
        this.rulerEl.style.visibility = "visible";
        this.rulerEl.style.display = "block";
        this.rulerEl.style.setProperty("z-index", "20", "important");
      } else if (activeStyle === "off") {
        this.rulerEl.classList.remove("is-visible");
        this.rulerEl.classList.add("is-hidden", "mode-off");
        this.rulerEl.style.setProperty("display", "none", "important");
        this.rulerEl.style.setProperty("opacity", "0", "important");
        this.rulerEl.style.setProperty("visibility", "hidden", "important");
        this.rulerEl.style.backgroundColor = "transparent";
        this.rulerEl.style.border = "none";
        this.rulerEl.style.outline = "none";
        this.rulerEl.style.boxShadow = "none";
        if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      } else {
        // highlight
        this.rulerEl.style.top = "0px";
        this.rulerEl.style.left = "0px";
        this.rulerEl.style.right = "auto";
        this.rulerEl.style.width = `${rulerWidth}px`;
        this.rulerEl.style.maxWidth = `${rulerWidth}px`;
        this.rulerEl.style.height = `${Math.round(h)}px`;
        this.rulerEl.style.transform = `translate3d(${rulerLeft}px, ${rulerTop}px, 0)`;
        this.rulerEl.style.backgroundColor = "";
        this.rulerEl.style.border = "none";
        this.rulerEl.style.outline = "none";
        this.rulerEl.style.boxShadow = "none";
        this.rulerEl.style.opacity = "1";
        this.rulerEl.style.visibility = "visible";
        this.rulerEl.style.display = "block";
      }

      // 2. Dimming masky v horizontálním PDF módu dle focusMode
      const isPdfFocus = this.enabled && this.focusMode && this.focusMode !== "off";
      if (isPdfFocus) {
        const dimOpacity = this.dimOpacity !== undefined ? this.dimOpacity : 0.65;
        const themeBg = "var(--bg-theme, var(--color-bg, #fbf0d9))";
        const vh = window.innerHeight;
        const roundH = Math.round(h);
        const roundY = Math.round(y);
        const topBandBottom = roundY;
        const bottomBandTop = activeStyle === "bottom-cover" ? roundY : Math.round(roundY + roundH);

        const slitLeft = Math.max(0, Math.round(targetLeft));
        const slitRight = Math.min(window.innerWidth, Math.round(targetLeft + targetWidth));
        this._slitLeft = slitLeft;
        this._slitRight = slitRight;

        // Horní maska: pro "up" a "both"
        if (this.focusMode === "up" || this.focusMode === "both") {
          if (this.maskTopEl) {
            this.maskTopEl.className = "ruler-mask ruler-mask-top is-visible";
            this.maskTopEl.classList.remove("pdf-overlay-mask");
            this.maskTopEl.style.setProperty("display", "block", "important");
            this.maskTopEl.style.setProperty("background-color", themeBg, "important");
            this.maskTopEl.style.setProperty("opacity", String(dimOpacity), "important");
            this.maskTopEl.style.setProperty("z-index", "15", "important");
            this.maskTopEl.style.setProperty("pointer-events", "none", "important");
            this.maskTopEl.style.top = "0px";
            this.maskTopEl.style.left = "0px";
            this.maskTopEl.style.right = "auto";
            this.maskTopEl.style.maxWidth = "none";
            this.maskTopEl.style.width = "100%";
            this.maskTopEl.style.height = `${vh}px`;
            this.maskTopEl.style.transform = `translate3d(0, ${Math.round(topBandBottom - vh)}px, 0)`;
          }
        } else if (this.maskTopEl) {
          this.maskTopEl.style.display = "none";
          this.maskTopEl.classList.remove("pdf-overlay-mask", "is-visible");
          this.maskTopEl.classList.add("is-hidden");
        }

        // Dolní maska: pro "down" a "both"
        if (this.focusMode === "down" || this.focusMode === "both") {
          if (this.maskBottomEl) {
            this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-visible";
            this.maskBottomEl.classList.remove("pdf-overlay-mask", "mode-bottom-cover");
            this.maskBottomEl.style.setProperty("display", "block", "important");
            this.maskBottomEl.style.setProperty("background-color", themeBg, "important");
            this.maskBottomEl.style.setProperty("opacity", String(dimOpacity), "important");
            this.maskBottomEl.style.setProperty("z-index", "15", "important");
            this.maskBottomEl.style.setProperty("pointer-events", "none", "important");
            this.maskBottomEl.style.top = "0px";
            this.maskBottomEl.style.left = "0px";
            this.maskBottomEl.style.right = "auto";
            this.maskBottomEl.style.maxWidth = "none";
            this.maskBottomEl.style.width = "100%";
            this.maskBottomEl.style.height = `${vh}px`;
            this.maskBottomEl.style.transform = `translate3d(0, ${bottomBandTop}px, 0)`;
          }
        } else if (this.maskBottomEl) {
          this.maskBottomEl.style.display = "none";
          this.maskBottomEl.classList.remove("pdf-overlay-mask", "is-visible");
          this.maskBottomEl.classList.add("is-hidden");
        }

        // Postranní masky: aktivní pouze v režimu "both"
        if (this.focusMode === "both") {
          const leftBandWidth = Math.max(0, slitLeft);
          if (leftBandWidth > 0 && this.maskLeftEl) {
            this.maskLeftEl.className = "ruler-mask ruler-mask-left is-visible";
            this.maskLeftEl.classList.remove("pdf-overlay-mask");
            this.maskLeftEl.style.setProperty("display", "block", "important");
            this.maskLeftEl.style.setProperty("background-color", themeBg, "important");
            this.maskLeftEl.style.setProperty("opacity", String(dimOpacity), "important");
            this.maskLeftEl.style.setProperty("z-index", "15", "important");
            this.maskLeftEl.style.setProperty("pointer-events", "none", "important");
            this.maskLeftEl.style.top = "0px";
            this.maskLeftEl.style.left = "0px";
            this.maskLeftEl.style.right = "auto";
            this.maskLeftEl.style.maxWidth = "none";
            this.maskLeftEl.style.width = `${leftBandWidth}px`;
            this.maskLeftEl.style.height = `${roundH}px`;
            this.maskLeftEl.style.transform = `translate3d(0, ${roundY}px, 0)`;
          } else if (this.maskLeftEl) {
            this.maskLeftEl.style.display = "none";
            this.maskLeftEl.classList.remove("is-visible");
            this.maskLeftEl.classList.add("is-hidden");
          }

          const rightBandLeft = slitRight;
          const rightBandWidth = Math.max(0, window.innerWidth - rightBandLeft);
          if (rightBandWidth > 0 && this.maskRightEl) {
            this.maskRightEl.className = "ruler-mask ruler-mask-right is-visible";
            this.maskRightEl.classList.remove("pdf-overlay-mask");
            this.maskRightEl.style.setProperty("display", "block", "important");
            this.maskRightEl.style.setProperty("background-color", themeBg, "important");
            this.maskRightEl.style.setProperty("opacity", String(dimOpacity), "important");
            this.maskRightEl.style.setProperty("z-index", "15", "important");
            this.maskRightEl.style.setProperty("pointer-events", "none", "important");
            this.maskRightEl.style.top = "0px";
            this.maskRightEl.style.left = "0px";
            this.maskRightEl.style.right = "auto";
            this.maskRightEl.style.maxWidth = "none";
            this.maskRightEl.style.width = `${rightBandWidth}px`;
            this.maskRightEl.style.height = `${roundH}px`;
            this.maskRightEl.style.transform = `translate3d(${rightBandLeft}px, ${roundY}px, 0)`;
          } else if (this.maskRightEl) {
            this.maskRightEl.style.display = "none";
            this.maskRightEl.classList.remove("is-visible");
            this.maskRightEl.classList.add("is-hidden");
          }
        } else {
          if (this.maskLeftEl) { this.maskLeftEl.style.display = "none"; this.maskLeftEl.classList.remove("is-visible"); this.maskLeftEl.classList.add("is-hidden"); }
          if (this.maskRightEl) { this.maskRightEl.style.display = "none"; this.maskRightEl.classList.remove("is-visible"); this.maskRightEl.classList.add("is-hidden"); }
        }

        // Maska neaktivní stránky při dvoustraně
        if (spreadInfo) {
          const isLeftPage = spreadInfo.activeRect.left < spreadInfo.inactiveRect.left;
          const needInactiveSpread = (isLeftPage && (this.focusMode === "down" || this.focusMode === "both")) ||
                                     (!isLeftPage && (this.focusMode === "up" || this.focusMode === "both"));
          if (needInactiveSpread) {
            const inactiveRect = spreadInfo.inactiveRect;
            if (!this.maskInactiveSpreadEl) {
              this.maskInactiveSpreadEl = document.createElement("div");
              this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom ruler-mask-inactive-spread is-visible";
              this.maskInactiveSpreadEl.style.willChange = "transform";
              this.maskInactiveSpreadEl.style.contain = "paint";
              document.body.appendChild(this.maskInactiveSpreadEl);
            }
            this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom ruler-mask-inactive-spread is-visible";
            this.maskInactiveSpreadEl.classList.remove("pdf-overlay-mask", "is-hidden");
            this.maskInactiveSpreadEl.style.setProperty("display", "block", "important");
            this.maskInactiveSpreadEl.style.setProperty("background-color", themeBg, "important");
            this.maskInactiveSpreadEl.style.setProperty("opacity", String(dimOpacity), "important");
            this.maskInactiveSpreadEl.style.setProperty("z-index", "15", "important");
            this.maskInactiveSpreadEl.style.setProperty("pointer-events", "none", "important");
            this.maskInactiveSpreadEl.style.top = `${Math.round(inactiveRect.top)}px`;
            this.maskInactiveSpreadEl.style.left = `${Math.round(inactiveRect.left)}px`;
            this.maskInactiveSpreadEl.style.transform = "none";
            this.maskInactiveSpreadEl.style.width = `${Math.round(inactiveRect.width)}px`;
            this.maskInactiveSpreadEl.style.height = `${Math.round(inactiveRect.height)}px`;
          } else if (this.maskInactiveSpreadEl) {
            this.maskInactiveSpreadEl.style.display = "none";
          }
        } else if (this.maskInactiveSpreadEl) {
          this.maskInactiveSpreadEl.style.display = "none";
        }
      } else {
        if (this.maskTopEl) { this.maskTopEl.style.display = "none"; this.maskTopEl.classList.remove("pdf-overlay-mask", "is-visible"); }
        if (this.maskBottomEl) { this.maskBottomEl.style.display = "none"; this.maskBottomEl.classList.remove("pdf-overlay-mask", "is-visible"); }
        if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
        if (this.maskRightEl) this.maskRightEl.style.display = "none";
        if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
      }
      return;
    }

    if (this.activeLineIndex < 0 && this.cachedLines.length > 0) {
      this.activeLineIndex = 0;
    }
    if (this.activeLineIndex >= this.cachedLines.length) {
      this.activeLineIndex = Math.max(0, this.cachedLines.length - 1);
    }
    const currentLine = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
      ? this.cachedLines[this.activeLineIndex]
      : null;
    const isCurrentMedia = !!(currentLine && currentLine.isMedia);

    if (isCurrentMedia) {
      this.rulerEl.classList.add("is-media-focus");
    } else {
      this.rulerEl.classList.remove("is-media-focus");
    }

    const isVertical = this.isVerticalMode();
    const useFastCachedGeom = this.snapToLines && this.cachedLines && this.cachedLines.length > 0;
    const viewport = isVertical ? (this._cachedViewportEl || document.getElementById("paged-viewport")) : null;
    const vScrollTop = (isVertical && viewport) ? viewport.scrollTop : 0;

    let y = Number.isFinite(this.currentY) ? Math.round(this.currentY) : 150;
    let h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);

    let activeGeom = null;
    if (isCurrentMedia) {
      activeGeom = this.computeLineGeometry(this.activeLineIndex);
      if (activeGeom) {
        h = activeGeom.height;
        this.height = h;
        if (this.snapToLines) {
          y = activeGeom.targetY;
          this.currentY = y;
        }
      }
    } else if (this.snapToLines && !this.isDraggingRuler && !this.isDragging) {
      activeGeom = this.computeLineGeometry(this.activeLineIndex);
      if (activeGeom && Number.isFinite(activeGeom.targetY)) {
        y = activeGeom.targetY;
        this.targetY = activeGeom.targetY;
        this.currentY = activeGeom.targetY;
        if (this.style !== "bottom-cover" && this.mode !== "bottom-cover" && activeGeom.height) {
          h = activeGeom.height;
          this.height = h;
        }
      }
    } else if (this.isPdfMode && this.activeLineIndex >= 0 && this.cachedLines && this.cachedLines.length > 0) {
      activeGeom = this.computeLineGeometry(this.activeLineIndex);
      if (activeGeom) {
        if (Number.isFinite(activeGeom.targetY)) {
          y = activeGeom.targetY;
          this.targetY = activeGeom.targetY;
          this.currentY = activeGeom.targetY;
        }
        if (this.style !== "bottom-cover" && this.mode !== "bottom-cover" && activeGeom.height) {
          h = activeGeom.height;
          this.height = h;
        }
      }
    }

    this.rulerEl.style.height = (this.style === "bottom-cover" || this.mode === "bottom-cover") ? "2px" : `${h}px`;

    let screenY = isVertical ? Math.round(y - vScrollTop) : y;
    if (isVertical && this.followMode === "keyboard") {
      if (this.stationaryScreenY === null) {
        this.initDefaultStationaryAnchor();
        return;
      }
      const lineScreenY = Math.round(y - vScrollTop);
      const maxScrollTop = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;

      // In vertical mode: Set screenY = lineScreenY when isCurrentMedia so ruler aligns with media element
      if (isCurrentMedia) {
        screenY = lineScreenY;
      } else if (vScrollTop <= 1 && lineScreenY < this.stationaryScreenY) {
        screenY = lineScreenY;
      } else if (vScrollTop >= maxScrollTop - 1 && lineScreenY > this.stationaryScreenY) {
        screenY = lineScreenY;
      } else {
        screenY = this.stationaryScreenY;
      }

      if (!isCurrentMedia && !this._isVerticalScrolling && !this._isProgrammaticScroll && viewport && this.cachedLines.length > 0) {
        const targetDocCenterY = vScrollTop + screenY + h / 2;
        let closestIdx = -1;
        let minDiff = Infinity;
        for (let i = 0; i < this.cachedLines.length; i++) {
          const diff = Math.abs(this.cachedLines[i].centerY - targetDocCenterY);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = i;
          }
        }
        if (closestIdx >= 0 && closestIdx !== this.activeLineIndex) {
          this.activeLineIndex = closestIdx;
          if (!this.wordTracking) {
            this._checkLineProgress(closestIdx, false);
          } else {
            const words = this.ensureActiveWords(closestIdx);
            if (words && words.length > 0) {
              this.activeWordIndex = 0;
              this.setWordWindow(0);
            }
          }
        }
      }
    }

    if (this.followMode === "mouse" || this.isVerticalMode()) {
      if (this.rulerEl) {
        this.rulerEl.classList.remove("is-snapped");
        this.rulerEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskTopEl) {
        this.maskTopEl.classList.remove("is-snapped");
        this.maskTopEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskBottomEl) {
        this.maskBottomEl.classList.remove("is-snapped");
        this.maskBottomEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskLeftEl) {
        this.maskLeftEl.classList.remove("is-snapped");
        this.maskLeftEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskRightEl) {
        this.maskRightEl.classList.remove("is-snapped");
        this.maskRightEl.style.setProperty("transition", "none", "important");
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.classList.remove("is-snapped");
        this.wordWaveEl.style.setProperty("transition", "none", "important");
      }
    } else if ((this.style || this.mode) === "off" || !this.wordTracking) {
      if (this.rulerEl) this.rulerEl.style.transition = "none";
    }

    let slitLeft = 0;
    let slitRight = window.innerWidth;

    const isBottomCoverWordTracking = (this.style === "bottom-cover" || this.mode === "bottom-cover") && !!this.wordTracking;

    if (this.wordTracking && this.activeWordIndex >= 0 && !isCurrentMedia && !isBottomCoverWordTracking) {
      const x = Number.isFinite(this.wordLeft) ? Math.round(this.wordLeft) : 0;
      const w = Number.isFinite(this.totalWidth) && this.totalWidth > 0 ? Math.round(this.totalWidth) : 100;
      slitLeft = x;
      slitRight = x + w;

      this._rulerLeft = x;
      this._rulerWidth = w;
      this.rulerEl.style.top = "0px";
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "auto";
      if (this._lastAppliedWordWidth == null || Math.abs(w - this._lastAppliedWordWidth) >= 1) {
        this._lastAppliedWordWidth = w;
        this.rulerEl.style.width = `${w}px`;
      }
      this.rulerEl.style.maxWidth = "100%";
      this.rulerEl.style.transform = `translate3d(${x}px, ${screenY}px, 0)`;

      const aw = Number.isFinite(this.activeWordWidth) && this.activeWordWidth > 0 ? Math.round(this.activeWordWidth) : w;
      const pw = Number.isFinite(this.previewWidth) ? Math.round(this.previewWidth) : Math.max(0, w - aw);
      const fade1 = Math.round(aw + pw * 0.35);
      const fade2 = Math.round(aw + pw * 0.75);

      this.rulerEl.style.setProperty("--active-word-width", `${aw}px`);
      this.rulerEl.style.setProperty("--fade-stop-1", `${fade1}px`);
      this.rulerEl.style.setProperty("--fade-stop-2", `${fade2}px`);

      if (pw > 0) {
        this.rulerEl.classList.remove("no-preview");
      } else {
        this.rulerEl.classList.add("no-preview");
      }
      if (this.wordWaveEl) {
        this.wordWaveEl.style.display = "none";
      }
    } else {
      this.rulerEl.classList.remove("no-preview");
      const isTwoCol = !isVertical && this.isTwoCol;
      let colLeft = currentLine ? (currentLine.columnLeft ?? currentLine.left) : null;
      let colWidth = currentLine ? (currentLine.columnWidth ?? currentLine.width) : null;

      if (isCurrentMedia) {
        const geom = activeGeom || this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          colLeft = geom.left;
          colWidth = geom.width;
        }
      } else if (this.isPdfMode) {
        const geom = activeGeom || this.computeLineGeometry(this.activeLineIndex);
        if (geom && Number.isFinite(geom.left) && Number.isFinite(geom.width)) {
          colLeft = geom.left;
          colWidth = geom.width;
        }
      } else if (isVertical && (this.isPdfMode || currentLine?.isPdfLine)) {
        const pageCol = this.getPageTextColumnBounds(currentLine);
        if (pageCol && pageCol.width > 50) {
          colLeft = pageCol.left;
          colWidth = pageCol.width;
        }
      } else if (useFastCachedGeom ? !!this._cachedIsSpread : this.isSpreadActive()) {
        const spreadInfo = useFastCachedGeom ? this._getCachedSpreadInfoForLine(currentLine) : this.getActiveSpreadInfo(currentLine);
        if (spreadInfo) {
          const cRect = spreadInfo.activeRect;
          const padding = 12;
          const pageCol = useFastCachedGeom ? null : this.getPageTextColumnBounds(currentLine);
          if (pageCol && pageCol.width > 50) {
            colLeft = Math.max(Math.round(cRect.left), Math.round(pageCol.left));
            colWidth = Math.min(Math.round(pageCol.width), Math.round(cRect.right - colLeft));
          } else if (currentLine && currentLine.textLeft != null && currentLine.textRight != null && currentLine.textRight > currentLine.textLeft) {
            colLeft = Math.max(Math.round(cRect.left), Math.round(currentLine.textLeft - padding));
            const colRight = Math.min(Math.round(cRect.right), Math.round(currentLine.textRight + padding));
            colWidth = Math.max(50, colRight - colLeft);
          } else if (currentLine && currentLine.left != null && currentLine.width != null) {
            colLeft = Math.max(Math.round(cRect.left), Math.round(currentLine.left));
            colWidth = Math.min(Math.round(currentLine.width), Math.round(cRect.right - colLeft));
          } else {
            colLeft = Math.round(cRect.left + padding);
            colWidth = Math.round(cRect.width - (padding * 2));
          }
          colLeft = Math.max(Math.round(cRect.left), colLeft);
          if (colLeft + colWidth > cRect.right) {
            colWidth = Math.max(50, Math.round(cRect.right - colLeft));
          }
        }
      } else {
        if (colLeft == null || colWidth == null || !Number.isFinite(colLeft) || !Number.isFinite(colWidth) || colWidth < 80) {
          if (isTwoCol) {
            const colIdx = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
            colLeft = colIdx === 1 ? this.column1Left : this.column0Left;
            colWidth = colIdx === 1 ? this.column1Width : this.column0Width;
            if (colLeft == null || colWidth == null || colWidth < 80) {
              const singleColW = Math.max(80, Math.floor(((this.stageWidth || window.innerWidth) - (this.colGap || 40)) / 2));
              colLeft = colIdx === 1 ? Math.round((this.stageLeft || 0) + singleColW + (this.colGap || 40)) : Math.max(0, Math.round(this.stageLeft || 20));
              colWidth = singleColW;
            }
          } else {
            colLeft = this.column0Left ?? this.textBlockLeft;
            colWidth = this.column0Width ?? this.textBlockWidth;
            if (colLeft == null || colWidth == null || colWidth < 80) {
              const sRect = (useFastCachedGeom && this._cachedStageRect)
                ? this._cachedStageRect
                : (this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.();
              const sLeft = sRect && sRect.width > 50 ? Math.round(sRect.left) : (this.stageLeft ?? 20);
              const sWidth = sRect && sRect.width > 50 ? Math.round(sRect.width) : (this.stageWidth ?? (window.innerWidth - 40));
              colLeft = sLeft;
              colWidth = sWidth;
            }
          }
        }

        // Bezpečnostní limit: na jednosloupcových stránkách nesmí pravítko nikdy přetéct vlevo mimo stageRect.left ani vpravo mimo stageRect.right
        if (!isTwoCol) {
          const sRect = (useFastCachedGeom && this._cachedStageRect)
            ? this._cachedStageRect
            : (this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.();
          if (sRect && sRect.width > 50) {
            const stageLeftBound = Math.round(sRect.left);
            const stageRightBound = Math.round(sRect.right);
            if (colLeft == null || !Number.isFinite(colLeft) || colLeft < stageLeftBound) {
              colLeft = stageLeftBound;
            }
            if (colWidth == null || !Number.isFinite(colWidth) || colWidth < 80) {
              colWidth = Math.max(80, stageRightBound - colLeft);
            }
            if (colLeft + colWidth > stageRightBound) {
              colWidth = Math.max(80, stageRightBound - colLeft);
            }
          }
        }

        // Bezpečnostní limit: maxWidth pravítka nesmí překročit columnWidth aktivního sloupce (pouze pro běžný text)
        if (isTwoCol) {
          const colIdx = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
          const maxColW = colIdx === 1 ? (this.column1Width || this.column0Width) : this.column0Width;
          if (Number.isFinite(maxColW) && maxColW > 80 && colWidth > maxColW) {
            colWidth = maxColW;
          }
        }
      }

      slitLeft = Math.round(colLeft);
      slitRight = Math.round(colLeft + colWidth);

      this._rulerLeft = Math.round(colLeft);
      this._rulerWidth = Math.round(colWidth);

      this.rulerEl.style.top = "0px";
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(colWidth)}px`;
      this.rulerEl.style.maxWidth = `${Math.round(colWidth)}px`;
      this.rulerEl.style.transform = `translate3d(${Math.round(colLeft)}px, ${screenY}px, 0)`;

      if (isBottomCoverWordTracking && !isCurrentMedia) {
        let curWord = (this.activeWordIndex >= 0 && this.activeWordIndex < this.cachedWords.length)
          ? this.cachedWords[this.activeWordIndex]
          : null;

        if (!curWord && this.cachedWords.length > 0) {
          curWord = this.cachedWords[0];
          this.activeWordIndex = 0;
        }

        let currentPointerX;
        const isPointerInCol = Number.isFinite(this.lastPointerX) && this.lastPointerX >= colLeft && this.lastPointerX <= colLeft + colWidth;
        if (this.followMode !== "keyboard" && isPointerInCol) {
          currentPointerX = this.lastPointerX;
        } else if (curWord && Number.isFinite(curWord.centerX)) {
          currentPointerX = curWord.centerX;
        } else if (Number.isFinite(this.lastPointerX)) {
          currentPointerX = this.lastPointerX;
        } else {
          currentPointerX = Math.round(colLeft + colWidth / 2);
        }

        const WAVE_WIDTH = RULER_WAVE_WIDTH || 80;
        const rulerLeft = Math.round(colLeft);
        const rulerWidth = Math.round(colWidth);
        let waveX = Math.round((currentPointerX - rulerLeft) - (WAVE_WIDTH / 2));
        const maxWaveX = Math.max(0, rulerWidth - WAVE_WIDTH);
        waveX = Math.max(0, Math.min(maxWaveX, waveX));

        if (!this.wordWaveEl && this.rulerEl) {
          this.wordWaveEl = document.createElement("div");
          this.wordWaveEl.className = "ruler-word-wave";
          this.wordWaveEl.setAttribute("aria-hidden", "true");
          this.wordWaveEl.innerHTML = `<svg viewBox="0 0 80 12" width="80" height="12" preserveAspectRatio="none"><path d="M 0,0 C 20,0 24,12 40,12 C 56,12 60,0 80,0 Z" fill="currentColor" /></svg>`;
          this.rulerEl.appendChild(this.wordWaveEl);
        }

        if (this.wordWaveEl) {
          this.wordWaveEl.style.transform = `translate3d(${waveX}px, 0, 0)`;
          this.wordWaveEl.style.display = "block";
        }
      } else if (this.wordWaveEl) {
        this.wordWaveEl.style.display = "none";
      }
    }

    slitLeft = Math.max(0, slitLeft);
    slitRight = Math.min(window.innerWidth, Math.max(slitLeft, slitRight));

    const colorHexMap = {
      amber: "#f59e0b",
      cyan: "#06b6d4",
      emerald: "#10b981",
      lavender: "#a855f7",
      slate: "#64748b"
    };

    const colorGlowMap = {
      amber: "245, 158, 11",
      cyan: "6, 182, 212",
      emerald: "16, 185, 129",
      lavender: "168, 85, 247",
      slate: "100, 116, 139"
    };

    const geom = activeGeom || this.computeLineGeometry(this.activeLineIndex);
    const docLineTop = (geom && Number.isFinite(geom.lineTop)) ? geom.lineTop : (activeStyle === "bottom-cover" ? (y - h) : y);
    const docLineBottom = (geom && Number.isFinite(geom.lineBottom)) ? geom.lineBottom : (activeStyle === "bottom-cover" ? y : (y + h));
    const lineScreenTop = isVertical ? Math.round(docLineTop - vScrollTop) : Math.round(docLineTop);
    const lineScreenBottom = isVertical ? Math.round(docLineBottom - vScrollTop) : Math.round(docLineBottom);
    const lineH = Math.max(1, lineScreenBottom - lineScreenTop);

    // Vizuální indikátor pravítka dle activeStyle (off / highlight / bottom-cover)
    this.rulerEl.style.setProperty("transition", "none", "important");
    if (activeStyle === "bottom-cover") {
      const hex = colorHexMap[this.color] || "#f59e0b";
      const glowRgb = colorGlowMap[this.color] || "245, 158, 11";
      this.rulerEl.style.top = "0px";
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(this._rulerWidth || colWidth || 100)}px`;
      this.rulerEl.style.maxWidth = `${Math.round(this._rulerWidth || colWidth || 100)}px`;
      this.rulerEl.style.height = "2px";
      this.rulerEl.style.transform = `translate3d(${Math.round(this._rulerLeft != null ? this._rulerLeft : (colLeft || 0))}px, ${lineScreenBottom}px, 0)`;
      this.rulerEl.style.setProperty("background-color", hex, "important");
      this.rulerEl.style.setProperty("color", hex, "important");
      this.rulerEl.style.border = "none";
      this.rulerEl.style.outline = "none";
      this.rulerEl.style.setProperty("box-shadow", `0 1px 4px rgba(${glowRgb}, 0.45)`, "important");
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
      this.rulerEl.style.display = "block";
      this.rulerEl.style.overflow = "visible";
      this.rulerEl.style.contain = "none";
      this.rulerEl.style.setProperty("z-index", "20", "important");
    } else if (activeStyle === "off") {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden", "mode-off");
      this.rulerEl.style.setProperty("display", "none", "important");
      this.rulerEl.style.setProperty("opacity", "0", "important");
      this.rulerEl.style.setProperty("visibility", "hidden", "important");
      this.rulerEl.style.backgroundColor = "transparent";
      this.rulerEl.style.border = "none";
      this.rulerEl.style.outline = "none";
      this.rulerEl.style.boxShadow = "none";
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
    } else {
      // highlight
      this.rulerEl.style.top = "0px";
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(this._rulerWidth || colWidth || 100)}px`;
      this.rulerEl.style.maxWidth = `${Math.round(this._rulerWidth || colWidth || 100)}px`;
      this.rulerEl.style.height = `${lineH}px`;
      this.rulerEl.style.transform = `translate3d(${Math.round(this._rulerLeft != null ? this._rulerLeft : (colLeft || 0))}px, ${lineScreenTop}px, 0)`;
      this.rulerEl.style.backgroundColor = "";
      this.rulerEl.style.border = "none";
      this.rulerEl.style.outline = "none";
      this.rulerEl.style.boxShadow = "none";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
      this.rulerEl.style.display = "block";
      this.rulerEl.style.setProperty("z-index", "20", "important");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
    }

    const stage = this.getStageElement();
    const isFocus = this.enabled && this.focusMode && this.focusMode !== "off";

    if (isFocus) {
      this._focusMaskDirty = true;
      if (!currentLine && this.cachedLines.length === 0 && !this.isPdfMode) {
        this.prepareFocusMasksForTransition(1);
        return;
      }

      const vh = window.innerHeight;
      const dimOpacity = this.dimOpacity !== undefined ? this.dimOpacity : 0.65;
      const themeBg = "var(--bg-theme, var(--color-bg, #fbf0d9))";

      const isSpread = !isVertical && (useFastCachedGeom ? !!this._cachedIsSpread : this.isSpreadActive());
      const spreadInfo = isSpread ? (useFastCachedGeom ? this._getCachedSpreadInfoForLine(currentLine) : this.getActiveSpreadInfo(currentLine)) : null;
      const isTwoCol = !isVertical && this.isTwoCol;

      let coverLeft = 0;
      let coverWidth = window.innerWidth;

      if (spreadInfo) {
        const activeRect = spreadInfo.activeRect;
        coverLeft = Math.round(activeRect.left);
        coverWidth = Math.round(activeRect.width);
      } else if (isTwoCol) {
        const sRect = (useFastCachedGeom && this._cachedStageRect)
          ? this._cachedStageRect
          : (stage || this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.();
        if (sRect && sRect.width > 50) {
          const singleColW = Math.max(80, Math.floor(((this.stageWidth || sRect.width || window.innerWidth) - (this.colGap || 40)) / 2));
          const c0Left = this.column0Left ?? Math.max(0, Math.round(sRect.left));
          const c0Width = this.column0Width ?? singleColW;
          const c1Left = this.column1Left ?? Math.round(c0Left + singleColW + (this.colGap || 40));
          const c1Width = this.column1Width ?? singleColW;
          const activeCol = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
          coverLeft = activeCol === 1 ? c1Left : c0Left;
          coverWidth = activeCol === 1 ? c1Width : c0Width;
        }
      } else if (!isVertical && this.isPdfMode) {
        const cachedPdfRect = currentLine?.canvasRect || this._cachedCanvasRect;
        if (cachedPdfRect && cachedPdfRect.width > 50) {
          coverLeft = Math.round(cachedPdfRect.left);
          coverWidth = Math.round(cachedPdfRect.width);
        }
      }

      const useFullWidth = isVertical || (!spreadInfo && !isTwoCol && !this.isPdfMode);
      const maskLeft = useFullWidth ? 0 : coverLeft;
      const maskWidth = useFullWidth ? "100%" : `${coverWidth}px`;

      // 1. Horní maska: pro "up" a "both"
      if (this.focusMode === "up" || this.focusMode === "both") {
        if (this.maskTopEl) {
          this.maskTopEl.className = "ruler-mask ruler-mask-top is-visible";
          this.maskTopEl.classList.remove("pdf-overlay-mask");
          this.maskTopEl.style.setProperty("display", "block", "important");
          this.maskTopEl.style.setProperty("background-color", themeBg, "important");
          this.maskTopEl.style.setProperty("opacity", String(dimOpacity), "important");
          this.maskTopEl.style.setProperty("z-index", "15", "important");
          this.maskTopEl.style.setProperty("pointer-events", "none", "important");
          this.maskTopEl.style.top = "0px";
          this.maskTopEl.style.left = "0px";
          this.maskTopEl.style.right = "auto";
          this.maskTopEl.style.maxWidth = "none";
          this.maskTopEl.style.width = maskWidth;
          this.maskTopEl.style.height = `${vh}px`;
          this.maskTopEl.style.transform = `translate3d(${maskLeft}px, ${Math.round(lineScreenTop - vh)}px, 0)`;
        }
      } else if (this.maskTopEl) {
        this.maskTopEl.style.display = "none";
        this.maskTopEl.classList.remove("is-visible");
        this.maskTopEl.classList.add("is-hidden");
      }

      // 2. Dolní maska: pro "down" a "both"
      if (this.focusMode === "down" || this.focusMode === "both") {
        if (this.maskBottomEl) {
          this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-visible";
          this.maskBottomEl.classList.remove("pdf-overlay-mask", "mode-bottom-cover");
          this.maskBottomEl.style.setProperty("display", "block", "important");
          this.maskBottomEl.style.setProperty("background-color", themeBg, "important");
          this.maskBottomEl.style.setProperty("opacity", String(dimOpacity), "important");
          this.maskBottomEl.style.setProperty("z-index", "15", "important");
          this.maskBottomEl.style.setProperty("pointer-events", "none", "important");
          this.maskBottomEl.style.top = "0px";
          this.maskBottomEl.style.left = "0px";
          this.maskBottomEl.style.right = "auto";
          this.maskBottomEl.style.maxWidth = "none";
          this.maskBottomEl.style.width = maskWidth;
          this.maskBottomEl.style.height = `${Math.max(vh * 2, 2000)}px`;
          this.maskBottomEl.style.transform = `translate3d(${maskLeft}px, ${lineScreenBottom}px, 0)`;
        }
      } else if (this.maskBottomEl) {
        this.maskBottomEl.style.display = "none";
        this.maskBottomEl.classList.remove("is-visible");
        this.maskBottomEl.classList.add("is-hidden");
      }

      // 3. Postranní masky: pouze v režimu "both" (při sledování slov, 2-sloupcích nebo PDF)
      const needSideMasks = this.focusMode === "both" && ((this.wordTracking && this.activeWordIndex >= 0 && !isCurrentMedia) || isTwoCol || this.isPdfMode);
      if (needSideMasks) {
        const leftBandWidth = Math.max(0, Math.round(slitLeft));
        if (leftBandWidth > 0 && this.maskLeftEl) {
          this.maskLeftEl.className = "ruler-mask ruler-mask-left is-visible";
          this.maskLeftEl.style.setProperty("display", "block", "important");
          this.maskLeftEl.style.setProperty("background-color", themeBg, "important");
          this.maskLeftEl.style.setProperty("opacity", String(dimOpacity), "important");
          this.maskLeftEl.style.setProperty("z-index", "15", "important");
          this.maskLeftEl.style.setProperty("pointer-events", "none", "important");
          this.maskLeftEl.style.top = "0px";
          this.maskLeftEl.style.left = "0px";
          this.maskLeftEl.style.right = "auto";
          this.maskLeftEl.style.maxWidth = "none";
          this.maskLeftEl.style.width = `${leftBandWidth}px`;
          this.maskLeftEl.style.height = `${lineH}px`;
          this.maskLeftEl.style.transform = `translate3d(0, ${lineScreenTop}px, 0)`;
        } else if (this.maskLeftEl) {
          this.maskLeftEl.style.display = "none";
          this.maskLeftEl.classList.remove("is-visible");
          this.maskLeftEl.classList.add("is-hidden");
        }

        const rightBandLeft = Math.round(slitRight);
        const rightBandWidth = Math.max(0, window.innerWidth - rightBandLeft);
        if (rightBandWidth > 0 && this.maskRightEl) {
          this.maskRightEl.className = "ruler-mask ruler-mask-right is-visible";
          this.maskRightEl.style.setProperty("display", "block", "important");
          this.maskRightEl.style.setProperty("background-color", themeBg, "important");
          this.maskRightEl.style.setProperty("opacity", String(dimOpacity), "important");
          this.maskRightEl.style.setProperty("z-index", "15", "important");
          this.maskRightEl.style.setProperty("pointer-events", "none", "important");
          this.maskRightEl.style.top = "0px";
          this.maskRightEl.style.left = "0px";
          this.maskRightEl.style.right = "auto";
          this.maskRightEl.style.maxWidth = "none";
          this.maskRightEl.style.width = `${rightBandWidth}px`;
          this.maskRightEl.style.height = `${lineH}px`;
          this.maskRightEl.style.transform = `translate3d(${rightBandLeft}px, ${lineScreenTop}px, 0)`;
        } else if (this.maskRightEl) {
          this.maskRightEl.style.display = "none";
          this.maskRightEl.classList.remove("is-visible");
          this.maskRightEl.classList.add("is-hidden");
        }
      } else {
        if (this.maskLeftEl) { this.maskLeftEl.style.display = "none"; this.maskLeftEl.classList.remove("is-visible"); this.maskLeftEl.classList.add("is-hidden"); }
        if (this.maskRightEl) { this.maskRightEl.style.display = "none"; this.maskRightEl.classList.remove("is-visible"); this.maskRightEl.classList.add("is-hidden"); }
      }

      // 4. Maska protilehlé neaktivní stránky / sloupce při dvoustraně / 2-sloupcích
      let needInactiveMask = false;
      let inactiveRect = null;
      if (spreadInfo) {
        const isLeftPage = spreadInfo.activeRect.left < spreadInfo.inactiveRect.left;
        if ((isLeftPage && (this.focusMode === "down" || this.focusMode === "both")) ||
            (!isLeftPage && (this.focusMode === "up" || this.focusMode === "both"))) {
          needInactiveMask = true;
          inactiveRect = spreadInfo.inactiveRect;
        }
      } else if (isTwoCol) {
        const activeCol = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
        if ((activeCol === 0 && (this.focusMode === "down" || this.focusMode === "both")) ||
            (activeCol === 1 && (this.focusMode === "up" || this.focusMode === "both"))) {
          needInactiveMask = true;
          const sRect = (useFastCachedGeom && this._cachedStageRect)
            ? this._cachedStageRect
            : (stage || this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body)?.getBoundingClientRect?.();
          if (sRect && sRect.width > 50) {
            const singleColW = Math.max(80, Math.floor(((this.stageWidth || sRect.width || window.innerWidth) - (this.colGap || 40)) / 2));
            const c0Left = this.column0Left ?? Math.max(0, Math.round(sRect.left));
            const c0Width = this.column0Width ?? singleColW;
            const c1Left = this.column1Left ?? Math.round(c0Left + singleColW + (this.colGap || 40));
            const c1Width = this.column1Width ?? singleColW;
            inactiveRect = {
              left: activeCol === 1 ? c0Left : c1Left,
              top: Math.round(sRect.top),
              width: activeCol === 1 ? c0Width : c1Width,
              height: Math.max(0, Math.round(sRect.height))
            };
          }
        }
      }

      if (needInactiveMask && inactiveRect) {
        if (!this.maskInactiveSpreadEl) {
          this.maskInactiveSpreadEl = document.createElement("div");
          this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom ruler-mask-inactive-spread is-visible";
          this.maskInactiveSpreadEl.style.willChange = "transform";
          this.maskInactiveSpreadEl.style.contain = "paint";
          document.body.appendChild(this.maskInactiveSpreadEl);
        }
        this.maskInactiveSpreadEl.className = "ruler-mask ruler-mask-bottom ruler-mask-inactive-spread is-visible";
        this.maskInactiveSpreadEl.classList.remove("pdf-overlay-mask", "is-hidden");
        this.maskInactiveSpreadEl.style.setProperty("display", "block", "important");
        this.maskInactiveSpreadEl.style.setProperty("background-color", themeBg, "important");
        this.maskInactiveSpreadEl.style.setProperty("opacity", String(dimOpacity), "important");
        this.maskInactiveSpreadEl.style.setProperty("z-index", "15", "important");
        this.maskInactiveSpreadEl.style.setProperty("pointer-events", "none", "important");
        this.maskInactiveSpreadEl.style.top = `${Math.round(inactiveRect.top)}px`;
        this.maskInactiveSpreadEl.style.left = `${Math.round(inactiveRect.left)}px`;
        this.maskInactiveSpreadEl.style.transform = "none";
        this.maskInactiveSpreadEl.style.width = `${Math.round(inactiveRect.width)}px`;
        this.maskInactiveSpreadEl.style.maxWidth = `${Math.round(inactiveRect.width)}px`;
        this.maskInactiveSpreadEl.style.height = `${Math.round(inactiveRect.height)}px`;
      } else if (this.maskInactiveSpreadEl) {
        this.maskInactiveSpreadEl.style.display = "none";
        this.maskInactiveSpreadEl.classList.remove("is-visible");
        this.maskInactiveSpreadEl.classList.add("is-hidden");
      }
    } else {
      if (this.maskTopEl) { this.maskTopEl.style.display = "none"; this.maskTopEl.classList.remove("is-visible"); this.maskTopEl.classList.add("is-hidden"); }
      if (this.maskBottomEl) { this.maskBottomEl.style.display = "none"; this.maskBottomEl.classList.remove("is-visible"); this.maskBottomEl.classList.add("is-hidden"); }
      if (this.maskLeftEl) { this.maskLeftEl.style.display = "none"; this.maskLeftEl.classList.remove("is-visible"); this.maskLeftEl.classList.add("is-hidden"); }
      if (this.maskRightEl) { this.maskRightEl.style.display = "none"; this.maskRightEl.classList.remove("is-visible"); this.maskRightEl.classList.add("is-hidden"); }
      if (this.maskInactiveSpreadEl) { this.maskInactiveSpreadEl.style.display = "none"; this.maskInactiveSpreadEl.classList.remove("is-visible"); this.maskInactiveSpreadEl.classList.add("is-hidden"); }
      if (this._focusMaskDirty) {
        this.clearFocusTextMask(stage);
        this._focusMaskDirty = false;
      }
    }

    if (isCurrentMedia) {
      const curMediaEl = currentLine.element || currentLine.el;
      if (curMediaEl && curMediaEl.classList) {
        curMediaEl.classList.add("active-focus", "ruler-focused-image");
        const parentFig = curMediaEl.closest("figure, picture, .chapter-illustration, [class*='ornament'], [class*='illustration']");
        if (parentFig && parentFig.classList) {
          parentFig.classList.add("active-focus", "ruler-focused-image");
        }
      }
      this._lastFocusedMediaEl = curMediaEl;
    } else if (this._lastFocusedMediaEl) {
      this._lastFocusedMediaEl.classList.remove("active-focus", "ruler-focused-image");
      const parentFig = this._lastFocusedMediaEl.closest("figure, picture, .chapter-illustration, [class*='ornament'], [class*='illustration']");
      if (parentFig && parentFig.classList) {
        parentFig.classList.remove("active-focus", "ruler-focused-image");
      }
      this._lastFocusedMediaEl = null;
    }
  }

  updateRulerPosition(index = 0) {
    if (!this.rulerEl) return;
    this.refreshLines();

    if (this.cachedLines.length === 0) {
      if (this.isPdfMode) {
        this.height = this.pdfRulerHeight || 32;
        this.applyPosition();
        return;
      }
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.clearFocusTextMask();
      return;
    }

    const isVertical = this.isVerticalMode();
    const vp = isVertical ? (document.querySelector(".paged-viewport") || document.getElementById("paged-viewport")) : null;
    const vScrollTop = vp ? vp.scrollTop : 0;

    const lineIdx = Math.max(0, Math.min(this.cachedLines.length - 1, index));
    this.activeLineIndex = lineIdx;
    const targetLine = this.cachedLines[lineIdx];
    const isTargetMedia = !!(targetLine && (targetLine.isMedia || !targetLine.hasText));

    if (this.wordTracking && !isTargetMedia) {
      const words = this.ensureActiveWords(lineIdx);
      if (words && words.length > 0) {
        this.activeWordIndex = 0;
        this.setWordWindow(0);
        const targetWord = words[0];
        this.lastPointerX = targetWord ? targetWord.centerX : 100;
        this.lastPointerY = targetWord ? (isVertical ? Math.round(targetWord.centerY - vScrollTop) : targetWord.centerY) : 150;
        this.lastValidPointerX = this.lastPointerX;
        this.lastValidPointerY = this.lastPointerY;
        this.rulerEl.classList.add("word-tracking-mode");
        this._snapRulerInstantOrAnimated();
      }
    } else {
      const idx = Math.max(0, Math.min(this.cachedLines.length - 1, index));
      this.activeLineIndex = idx;
      this.activeWordIndex = -1;
      this.rulerEl.classList.remove("word-tracking-mode");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
      const geom = this.computeLineGeometry(idx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      }
      const line = this.cachedLines[idx];
      this.lastPointerX = line.left != null ? line.left : 100;
      this.lastPointerY = isVertical ? Math.round(line.centerY - vScrollTop) : line.centerY;
      this.lastValidPointerX = this.lastPointerX;
      this.lastValidPointerY = this.lastPointerY;
      this._snapRulerInstantOrAnimated();
    }

    if (!this.isPageTransitioning) {
      this.rulerEl.style.display = "block";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
      this.rulerEl.classList.remove("is-hidden", "hidden");
      this.rulerEl.classList.add("is-visible");
    }
    this.applyPosition();
  }

  updateStyles() {
    if (!this.rulerEl) return;

    this.rulerEl.style.willChange = "transform";
    this.rulerEl.style.contain = this.mode === "bottom-cover" ? "none" : "paint";

    if (this.maskTopEl) {
      this.maskTopEl.style.willChange = "transform";
      this.maskTopEl.style.contain = "paint";
      this.maskTopEl.style.pointerEvents = "none";
    }
    if (this.maskBottomEl) {
      this.maskBottomEl.style.willChange = "transform";
      this.maskBottomEl.style.contain = "paint";
      this.maskBottomEl.style.pointerEvents = "none";
    }
    if (this.maskLeftEl) {
      this.maskLeftEl.style.willChange = "transform";
      this.maskLeftEl.style.contain = "paint";
      this.maskLeftEl.style.pointerEvents = "none";
    }
    if (this.maskRightEl) {
      this.maskRightEl.style.willChange = "transform";
      this.maskRightEl.style.contain = "paint";
      this.maskRightEl.style.pointerEvents = "none";
    }
    if (this.maskInactiveSpreadEl) {
      this.maskInactiveSpreadEl.style.pointerEvents = "none";
    }

    const hasLines = this.isPdfMode || this.cachedLines.length > 0;
    const isFocus = this.enabled && this.focusMode && this.focusMode !== "off";
    const isBottomCover = this.enabled && (this.style === "bottom-cover" || this.mode === "bottom-cover") && !this.isPageTransitioning && hasLines;
    const transitionClass = this.horizontalWordTransition ? "word-transition-active" : "word-transition-snap";

    this.rulerEl.classList.add("reading-ruler");

    // Mode classes
    const activeStyle = this.style || this.mode || "highlight";
    this.rulerEl.classList.toggle("mode-off", activeStyle === "off");
    this.rulerEl.classList.toggle("mode-highlight", activeStyle === "highlight");
    this.rulerEl.classList.toggle("mode-focus", (this.focusMode && this.focusMode !== "off") && activeStyle === "off");
    this.rulerEl.classList.toggle("mode-underline", activeStyle === "underline");
    this.rulerEl.classList.toggle("mode-bottom-cover", activeStyle === "bottom-cover");

    // Color classes
    const classesToRemove = [];
    for (const cls of this.rulerEl.classList) {
      if (cls.startsWith("color-") && cls !== `color-${this.color}`) {
        classesToRemove.push(cls);
      }
    }
    classesToRemove.forEach(cls => this.rulerEl.classList.remove(cls));
    this.rulerEl.classList.add(`color-${this.color}`);

    const colorGlowMap = {
      amber: "245, 158, 11",
      cyan: "6, 182, 212",
      emerald: "16, 185, 129",
      lavender: "168, 85, 247",
      slate: "100, 116, 139"
    };
    if (colorGlowMap[this.color]) {
      this.rulerEl.style.setProperty("--ruler-glow-rgb", colorGlowMap[this.color]);
    }

    this.rulerEl.classList.toggle("word-tracking-mode", !!this.wordTracking);
    this.rulerEl.classList.toggle("word-transition-active", !!this.wordTracking && !!this.horizontalWordTransition);
    this.rulerEl.classList.toggle("word-transition-snap", !!this.wordTracking && !this.horizontalWordTransition);
    this.rulerEl.classList.toggle("is-page-transitioning", !!this.isPageTransitioning);

    const isTwoCol = !this.isVerticalMode() && this.isTwoCol;
    const showTopMask = isFocus && (this.focusMode === "up" || this.focusMode === "both");
    const showBottomMask = isFocus && (this.focusMode === "down" || this.focusMode === "both");
    const showSideMasks = isFocus && (this.focusMode === "both") && (this.wordTracking || isTwoCol || this.isPdfMode);

    if (this.maskTopEl) this.maskTopEl.className = `ruler-mask ruler-mask-top ${showTopMask ? "is-visible" : "is-hidden"}`;
    if (this.maskBottomEl) this.maskBottomEl.className = `ruler-mask ruler-mask-bottom ${showBottomMask ? "is-visible" : "is-hidden"}`;
    if (this.maskLeftEl) this.maskLeftEl.className = `ruler-mask ruler-mask-left ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;
    if (this.maskRightEl) this.maskRightEl.className = `ruler-mask ruler-mask-right ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;

    if (this.maskTopEl) this.maskTopEl.classList.remove("pdf-overlay-mask");
    if (this.maskBottomEl) this.maskBottomEl.classList.remove("pdf-overlay-mask", "mode-bottom-cover");
    if (this.maskLeftEl) this.maskLeftEl.classList.remove("pdf-overlay-mask");
    if (this.maskRightEl) this.maskRightEl.classList.remove("pdf-overlay-mask");

    if (!showTopMask && this.maskTopEl) this.maskTopEl.style.display = "none";
    if (!showBottomMask && this.maskBottomEl) this.maskBottomEl.style.display = "none";
    if (!showSideMasks) {
      if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
      if (this.maskRightEl) this.maskRightEl.style.display = "none";
    }
    if (!isFocus) {
      if (this.maskInactiveSpreadEl) {
        this.maskInactiveSpreadEl.style.display = "none";
        this.maskInactiveSpreadEl.classList.remove("is-visible");
        this.maskInactiveSpreadEl.classList.add("is-hidden");
      }
    }

    const colorHexMap = {
      amber: "#f59e0b",
      cyan: "#06b6d4",
      emerald: "#10b981",
      lavender: "#a855f7",
      slate: "#64748b"
    };
    if (activeStyle === "bottom-cover") {
      const hex = colorHexMap[this.color] || "#f59e0b";
      this.rulerEl.style.setProperty("background-color", hex, "important");
      this.rulerEl.style.setProperty("color", hex, "important");
      this.rulerEl.style.height = "2px";
      this.rulerEl.style.contain = "none";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
      this.rulerEl.style.setProperty("z-index", "20", "important");
    } else if (activeStyle === "off") {
      this.rulerEl.style.backgroundColor = "transparent";
      this.rulerEl.style.color = "";
      this.rulerEl.style.border = "none";
      this.rulerEl.style.outline = "none";
      this.rulerEl.style.boxShadow = "none";
      this.rulerEl.style.contain = "paint";
      this.rulerEl.style.setProperty("display", "none", "important");
      this.rulerEl.style.setProperty("opacity", "0", "important");
      this.rulerEl.style.setProperty("visibility", "hidden", "important");
    } else {
      this.rulerEl.style.backgroundColor = "";
      this.rulerEl.style.color = "";
      this.rulerEl.style.contain = "paint";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
    }

    const isBottomCoverWordTracking = activeStyle === "bottom-cover" && !!this.wordTracking;
    if (!isBottomCoverWordTracking && this.wordWaveEl) {
      this.wordWaveEl.style.display = "none";
    }

    if (this.enabled && !this.isPageTransitioning) {
      if (activeStyle === "off") {
        this.rulerEl.classList.remove("is-visible");
        this.rulerEl.classList.add("is-hidden", "mode-off");
        this.rulerEl.style.setProperty("display", "none", "important");
        this.rulerEl.style.setProperty("opacity", "0", "important");
        this.rulerEl.style.setProperty("visibility", "hidden", "important");
      } else {
        this.rulerEl.classList.remove("is-hidden", "hidden", "mode-off");
        this.rulerEl.classList.add("is-visible");
        if (this.rulerEl.style.display === "none") {
          this.rulerEl.style.display = "block";
        }
      }
    } else if (this.isPageTransitioning) {
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
    } else {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
    }

    if (this.isVerticalMode()) {
      if (this.rulerEl) {
        this.rulerEl.classList.remove("is-snapped");
        this.rulerEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskTopEl) {
        this.maskTopEl.classList.remove("is-snapped");
        this.maskTopEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskBottomEl) {
        this.maskBottomEl.classList.remove("is-snapped");
        this.maskBottomEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskLeftEl) {
        this.maskLeftEl.classList.remove("is-snapped");
        this.maskLeftEl.style.setProperty("transition", "none", "important");
      }
      if (this.maskRightEl) {
        this.maskRightEl.classList.remove("is-snapped");
        this.maskRightEl.style.setProperty("transition", "none", "important");
      }
    }

    this.applyPosition();
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  updateBodyClasses() {
    const isRulerActive = !!this.enabled;
    const isMouseFollow = isRulerActive && this.followMode === "mouse";
    const isWordTracking = isRulerActive && !!this.wordTracking;
    const isFocus = isRulerActive && this.focusMode && this.focusMode !== "off";
    const isBottomCover = isRulerActive && (this.style === "bottom-cover" || this.mode === "bottom-cover");
    const isVertical = isRulerActive && this.isVerticalMode();

    document.body.classList.toggle("ruler-active", isRulerActive);
    document.body.classList.toggle("ruler-mouse-follow-active", isMouseFollow);
    document.body.classList.toggle("word-tracking-active", isWordTracking);
    document.body.classList.toggle("ruler-mode-focus", isFocus);
    document.body.classList.toggle("ruler-mode-bottom-cover", isBottomCover);
    document.body.classList.toggle("ruler-vertical-mode", isVertical);

    if (!isMouseFollow) {
      this.setCursorHidden(false);
    }
  }

  setEnabled(val) {
    this.disableWordTransition();
    if (val) {
      const isStyleOff = (!this.style || this.style === "off" || this.mode === "off");
      const isFocusOff = (!this.focusMode || this.focusMode === "off");
      if (isStyleOff && isFocusOff) {
        const lastCombo = this.lastActiveCombination || this.app?.settings?.ruler?.lastActiveCombination;
        let restoredStyle = lastCombo?.style || this.lastActiveStyle || this.app?.settings?.ruler?.lastActiveStyle || "highlight";
        let restoredFocus = lastCombo?.focusMode || "off";
        if (restoredStyle === "off" && restoredFocus === "off") {
          restoredStyle = "highlight";
          restoredFocus = "off";
        }
        this.style = restoredStyle;
        this.mode = restoredStyle;
        this.focusMode = restoredFocus;
        if (this.app?.settings?.ruler) {
          this.app.settings.ruler.style = restoredStyle;
          this.app.settings.ruler.mode = restoredStyle;
          this.app.settings.ruler.focusMode = restoredFocus;
        }
      }
    }
    this.enabled = !!val;
    if (typeof this.onStateChange === "function") {
      this.onStateChange(this.enabled, this.rulerMode);
    }
    if (!this.enabled) {
      this.finalizeCurrentPageProgress();
      this.setCursorHidden(false);
      this.cancelHold();
      this.stationaryScreenY = null;
      this._verticalScrollAnchorPending = false;
      this._relativeTrackingActive = false;
      this._scrollAnchorPhysicalY = null;
      this._scrollAnchorVirtualY = null;
      if (this._scrollEndTimer) {
        clearTimeout(this._scrollEndTimer);
        this._scrollEndTimer = null;
      }
      if (this._scrollRafId) {
        cancelAnimationFrame(this._scrollRafId);
        this._scrollRafId = null;
      }
      this._scrollRafPending = false;
      this._isVerticalScrolling = false;
      if (this._programmaticScrollTimer) {
        clearTimeout(this._programmaticScrollTimer);
        this._programmaticScrollTimer = null;
      }
      this._isProgrammaticScroll = false;
      this.isDraggingRuler = false;
      this.isPenTouching = false;
      this.activePointerId = null;
      this.activePointerType = null;
      this.dragCooldownEndTime = 0;
      this.lastValidPointerX = null;
      this.lastValidPointerY = null;
      this.lastPenTime = 0;
      if (this.rulerEl) {
        this.rulerEl.style.display = "none";
        this.rulerEl.classList.remove("is-visible");
        this.rulerEl.classList.add("is-hidden");
      }
      if (this.maskTopEl) this.maskTopEl.style.display = "none";
      if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
      if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
      if (this.maskRightEl) this.maskRightEl.style.display = "none";
      if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.style.display = "none";
      this.clearFocusTextMask();
    } else {
      if (this.rulerEl && !document.body.contains(this.rulerEl)) {
        document.body.appendChild(this.maskTopEl);
        document.body.appendChild(this.maskBottomEl);
        document.body.appendChild(this.maskLeftEl);
        document.body.appendChild(this.maskRightEl);
        if (this.maskInactiveSpreadEl) document.body.appendChild(this.maskInactiveSpreadEl);
        document.body.appendChild(this.rulerEl);
      }
      if (this.rulerEl) {
        this.rulerEl.classList.remove("is-page-transitioning");
        this.isPageTransitioning = false;
        const isStyleOff = (this.style || this.mode) === "off";
        if (isStyleOff) {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.classList.add("is-hidden", "mode-off");
          this.rulerEl.style.setProperty("display", "none", "important");
          this.rulerEl.style.setProperty("opacity", "0", "important");
          this.rulerEl.style.setProperty("visibility", "hidden", "important");
        } else {
          this.rulerEl.classList.remove("mode-off", "is-hidden", "hidden");
          this.rulerEl.classList.add("is-visible");
          this.rulerEl.style.display = "block";
          this.rulerEl.style.opacity = "1";
          this.rulerEl.style.visibility = "visible";
        }
      }
    }
    this.updateStyles();
    this.updateBodyClasses();

    if (this.enabled) {
      if (this.isVerticalMode()) {
        this.ensureVerticalScrollListener();
      }
      if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
        this.applyPosition();
      } else {
        if (this.isVerticalMode() && this.followMode === "keyboard" && this.stationaryScreenY === null) {
          this.initDefaultStationaryAnchor();
        } else {
          this.updateRulerPosition(0);
        }
      }
      if (this.followMode === "mouse" && this.lastPointerX != null && this.lastPointerY != null) {
        this.updateCursorVisibility(this.lastPointerX, this.lastPointerY, "mouse");
      }
      console.log(`[Ruler] Activated, found lines: ${this.cachedLines.length}, current position: Top ${Math.round(this.currentY)} px, Height ${Math.round(this.height)} px`);
    }
  }

  refreshVisualState() {
    if (!this.rulerEl) return;
    this.rulerEl.style.contain = this.mode === "bottom-cover" ? "none" : "paint";
    if (!this.enabled) {
      this.updateStyles();
      this.applyPosition();
      return;
    }
    this.isPageTransitioning = false;
    const isStyleOff = (this.style || this.mode) === "off";
    if (isStyleOff) {
      this.rulerEl.classList.remove("is-page-transitioning", "is-visible");
      this.rulerEl.classList.add("is-hidden", "mode-off");
      this.rulerEl.style.setProperty("display", "none", "important");
      this.rulerEl.style.setProperty("opacity", "0", "important");
      this.rulerEl.style.setProperty("visibility", "hidden", "important");
      if (this.wordWaveEl) this.wordWaveEl.style.display = "none";
    } else {
      this.rulerEl.classList.remove("is-page-transitioning", "is-hidden", "hidden", "mode-off");
      this.rulerEl.classList.add("is-visible");
      this.rulerEl.style.display = "block";
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
    }

    if (!this.isImageOnlyPdf && (!this.cachedLines || this.cachedLines.length === 0)) {
      this.detectLines();
    }
    if (this.cachedLines && this.cachedLines.length > 0) {
      if (this.activeLineIndex < 0 || this.activeLineIndex >= this.cachedLines.length) {
        this.activeLineIndex = 0;
      }
      const geom = this.computeLineGeometry(this.activeLineIndex);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = geom.targetY;
      }
    }
    if (this.wordTracking && !this.isImageOnlyPdf && this.cachedLines && this.cachedLines.length > 0) {
      const lineIdx = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length) ? this.activeLineIndex : 0;
      this.activeLineIndex = lineIdx;
      const words = this.ensureActiveWords(lineIdx);
      if (words && words.length > 0) {
        if (this.activeWordIndex < 0 || this.activeWordIndex >= words.length) {
          this.activeWordIndex = 0;
        }
        this.setWordWindow(this.activeWordIndex);
      }
    }
    this.updateStyles();
    this.applyPosition();
  }

  setStyle(style) {
    if (["off", "highlight", "bottom-cover"].includes(style)) {
      this.style = style;
      this.mode = style;
      if (style !== "off") {
        this.lastActiveStyle = style;
        this.lastActiveCombination = { style, focusMode: this.focusMode || "off" };
      } else if (this.focusMode && this.focusMode !== "off") {
        this.lastActiveCombination = { style: "off", focusMode: this.focusMode };
      }

      this._lastComputedLineGeom = null;
      if (this.style === "bottom-cover" && (!this.cachedLines || this.cachedLines.length === 0)) {
        this.detectLines();
        if (this.wordTracking) {
          this.refreshWords();
        }
      }
      if (this.cachedLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }
      }
      this.updateEffectiveHeight();
      this.updateBodyClasses();
      this.updateRulerSettingsVisibility(this.style, this.focusMode, this.isPdfMode);

      // Pokud jsou obě volby (styl i zaostření) nastaveny na "off", automaticky deaktivovat master ruler
      if (this.style === "off" && (!this.focusMode || this.focusMode === "off")) {
        if (this.enabled) {
          this.setEnabled(false);
          if (this.app?.settings?.ruler) {
            this.app.settings.ruler.enabled = false;
          }
          if (typeof this.app?.updateRulerToggleButtonUI === "function") {
            this.app.updateRulerToggleButtonUI();
          }
        }
      }

      this.refreshVisualState();
    }
  }

  setFocusMode(focusMode) {
    if (focusMode === "above") focusMode = "up";
    if (focusMode === "below") focusMode = "down";
    if (["off", "up", "down", "both"].includes(focusMode)) {
      this.focusMode = focusMode;
      if (focusMode !== "off") {
        this.lastActiveFocus = focusMode;
        this.lastActiveCombination = { style: this.style || "off", focusMode };
      } else if (this.style && this.style !== "off") {
        this.lastActiveCombination = { style: this.style, focusMode: "off" };
      }

      if (this.focusMode !== "off") {
        this._focusMaskDirty = true;
        if (!this.cachedLines || this.cachedLines.length === 0) {
          this.detectLines();
          if (this.wordTracking) {
            this.refreshWords();
          }
        }
      } else {
        this.clearFocusTextMask();
        this._focusMaskDirty = false;
      }
      this.updateBodyClasses();
      this.updateRulerSettingsVisibility(this.style, this.focusMode, this.isPdfMode);

      // Pokud jsou obě volby (styl i zaostření) nastaveny na "off", automaticky deaktivovat master ruler
      if (this.focusMode === "off" && (!this.style || this.style === "off")) {
        if (this.enabled) {
          this.setEnabled(false);
          if (this.app?.settings?.ruler) {
            this.app.settings.ruler.enabled = false;
          }
          if (typeof this.app?.updateRulerToggleButtonUI === "function") {
            this.app.updateRulerToggleButtonUI();
          }
        }
      }

      this.refreshVisualState();
    }
  }

  setMode(mode) {
    if (mode === "focus") {
      this.setFocusMode("both");
      this.setStyle("off");
    } else if (["off", "highlight", "bottom-cover"].includes(mode)) {
      this.setStyle(mode);
    }
  }

  updateRulerSettingsVisibility(style = this.style, focusMode = this.focusMode, isPdf = this.isPdfMode) {
    if (this.app && typeof this.app.updateRulerSettingsVisibility === "function") {
      this.app.updateRulerSettingsVisibility(style, focusMode, isPdf);
      return;
    }
    const activeStyle = style || this.style || this.mode || "highlight";
    let activeFocus = focusMode || this.focusMode || "off";
    if (activeFocus === "above") activeFocus = "up";
    if (activeFocus === "below") activeFocus = "down";
    const activePdf = isPdf !== null && isPdf !== undefined ? !!isPdf : !!this.isPdfMode;
    const isImageOnly = activePdf && !!this.isImageOnlyPdf;

    const popoverColor = document.getElementById("popover-ruler-color-section");
    const drawerColor = document.getElementById("drawer-ruler-color-section");
    const hideColor = activeStyle === "off";
    if (popoverColor) popoverColor.classList.toggle("is-hidden", hideColor);
    if (drawerColor) drawerColor.classList.toggle("is-hidden", hideColor);

    const popoverOpacity = document.getElementById("popover-ruler-opacity-section");
    const drawerOpacity = document.getElementById("drawer-ruler-opacity-section");
    const hideOpacity = activeFocus === "off";
    if (popoverOpacity) popoverOpacity.classList.toggle("is-hidden", hideOpacity);
    if (drawerOpacity) drawerOpacity.classList.toggle("is-hidden", hideOpacity);

    const sliderOpacity = document.getElementById("slider-ruler-opacity");
    const popoverSliderOpacity = document.getElementById("popover-slider-ruler-opacity");
    if (sliderOpacity) sliderOpacity.disabled = hideOpacity;
    if (popoverSliderOpacity) popoverSliderOpacity.disabled = hideOpacity;

    const popoverPdf = document.getElementById("popover-pdf-ruler-section");
    const drawerPdf = document.getElementById("drawer-pdf-ruler-section");
    const hidePdfHeight = !activePdf || activeStyle === "bottom-cover";
    if (popoverPdf) popoverPdf.classList.toggle("is-hidden", hidePdfHeight);
    if (drawerPdf) drawerPdf.classList.toggle("is-hidden", hidePdfHeight);

    const popoverAutoHeight = document.getElementById("popover-pdf-auto-height-row");
    const drawerAutoHeight = document.getElementById("drawer-pdf-auto-height-row");
    if (popoverAutoHeight) popoverAutoHeight.classList.toggle("is-hidden", isImageOnly);
    if (drawerAutoHeight) drawerAutoHeight.classList.toggle("is-hidden", isImageOnly);

    const popoverSnap = document.getElementById("popover-snap-lines-section");
    const drawerSnap = document.getElementById("drawer-snap-lines-section");
    if (popoverSnap) popoverSnap.classList.toggle("is-hidden", isImageOnly);
    if (drawerSnap) drawerSnap.classList.toggle("is-hidden", isImageOnly);

    const popoverModeSection = document.getElementById("popover-ruler-mode-section");
    if (popoverModeSection) popoverModeSection.classList.toggle("is-hidden", isImageOnly);

    const popoverWord = document.getElementById("popover-mode-word");
    const drawerWord = document.getElementById("drawer-word-tracking-section");
    if (popoverWord) {
      popoverWord.classList.toggle("is-hidden", isImageOnly);
      popoverWord.disabled = isImageOnly;
    }
    if (drawerWord) drawerWord.classList.toggle("is-hidden", isImageOnly);

    const popoverFollow = document.getElementById("popover-follow-section");
    const settingsFollow = document.getElementById("settings-follow-section");
    if (popoverFollow) popoverFollow.classList.toggle("is-image-only", isImageOnly);
    if (settingsFollow) settingsFollow.classList.toggle("is-image-only", isImageOnly);

    document.querySelectorAll("[data-ruler-follow='keyboard']").forEach(btn => {
      btn.classList.toggle("is-hidden", isImageOnly);
      btn.disabled = isImageOnly;
    });
  }

  setColor(color) {
    if (!color) return;
    this.color = color;

    const colorGlowMap = {
      amber: "245, 158, 11",
      cyan: "6, 182, 212",
      emerald: "16, 185, 129",
      lavender: "168, 85, 247",
      slate: "100, 116, 139"
    };

    this._ensureLinesFreshForCurrentLayout();
    if (!this.cachedLines || this.cachedLines.length === 0) {
      this.detectLines();
      if (this.wordTracking) {
        this.refreshWords();
      }
    }

    if (this.rulerEl) {
      const classesToRemove = [];
      for (const cls of this.rulerEl.classList) {
        if (cls.startsWith("color-") && cls !== `color-${this.color}`) {
          classesToRemove.push(cls);
        }
      }
      classesToRemove.forEach(cls => this.rulerEl.classList.remove(cls));
      this.rulerEl.classList.add(`color-${this.color}`);

      const glowRgb = colorGlowMap[this.color];
      if (glowRgb) {
        this.rulerEl.style.setProperty("--ruler-glow-rgb", glowRgb);
      }

      if (this.mode === "bottom-cover") {
        const colorHexMap = {
          amber: "#f59e0b",
          cyan: "#06b6d4",
          emerald: "#10b981",
          lavender: "#a855f7",
          slate: "#64748b"
        };
        this.rulerEl.style.backgroundColor = colorHexMap[this.color] || "#f59e0b";
      }

      if (this.enabled && !this.isPageTransitioning) {
        if ((this.style || this.mode) === "off") {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.classList.add("is-hidden", "mode-off");
          this.rulerEl.style.setProperty("display", "none", "important");
          this.rulerEl.style.setProperty("opacity", "0", "important");
          this.rulerEl.style.setProperty("visibility", "hidden", "important");
        } else {
          this.rulerEl.classList.remove("mode-off", "is-hidden", "hidden");
          this.rulerEl.classList.add("is-visible");
          this.rulerEl.style.display = "block";
          this.rulerEl.style.opacity = "1";
          this.rulerEl.style.visibility = "visible";
        }
      }
    }

    this.refreshVisualState();
  }

  setHeight(px) {
    this._lastComputedLineGeom = null;
    if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
      this.setPdfRulerHeight(px);
      return;
    }
    if (this.isPdfMode) {
      this.setPdfRulerHeight(px, true);
      return;
    }
    this.manualHeight = Math.max(16, Math.min(120, parseInt(px, 10) || 48));
    if (!this.autoHeight) {
      this.height = this.manualHeight;
      this.uniformLineHeight = this.height;
      if (this.snapToLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }
      }
    }
    this.refreshVisualState();
  }

  setAutoHeight(enabled) {
    this._lastComputedLineGeom = null;
    if (this.isImageOnlyPdf) {
      this.setPdfAutoHeight(false);
      return;
    }
    if (this.isPdfMode) {
      this.setPdfAutoHeight(enabled);
      return;
    }
    this.autoHeight = true;
    this.isPdfHeightFromSlider = false;
    if (this.snapToLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
      const geom = this.computeLineGeometry(this.activeLineIndex);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      }
    } else {
      this.updateEffectiveHeight();
    }
    this.refreshVisualState();
  }

  setSnapToLines(enabled) {
    if (this.isImageOnlyPdf) {
      this.snapToLines = false;
      if (this.rulerEl) this.rulerEl.classList.remove("is-snapped");
      if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
      if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
      if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
      this.refreshVisualState();
      return;
    }
    this.snapToLines = !!enabled;
    if (!this.snapToLines) {
      if (this.rulerEl) this.rulerEl.classList.remove("is-snapped");
      if (this.maskTopEl) this.maskTopEl.classList.remove("is-snapped");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("is-snapped");
      if (this.maskLeftEl) this.maskLeftEl.classList.remove("is-snapped");
      if (this.maskRightEl) this.maskRightEl.classList.remove("is-snapped");
    } else if (this.cachedLines && this.cachedLines.length > 0) {
      const targetIdx = this.activeLineIndex >= 0 ? this.activeLineIndex : 0;
      this.activeLineIndex = targetIdx;
      const geom = this.computeLineGeometry(targetIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      }
    }
    this.refreshVisualState();
  }

  setWordTracking(enabled) {
    this.disableWordTransition();
    if (this.isImageOnlyPdf) {
      this.wordTracking = false;
    } else {
      this.wordTracking = !!enabled;
    }
    if (this.isPdfMode) {
      this.wordTrackingExplicitlyEnabledInPdf = this.wordTracking;
    }
    this._lastEmptyWordsDetectTime = 0;
    this._lastActiveLineIndex = -1;
    this._lastAppliedWordWidth = null;
    this._lastWordSolidRatio = null;
    this.updateBodyClasses();

    if (!this.enabled) {
      this.updateStyles();
      return;
    }

    if (!this.cachedLines || this.cachedLines.length === 0) {
      this.refreshLines();
    }

    if (this.wordTracking) {
      const targetLine = (this.activeLineIndex >= 0 && this.activeLineIndex < (this.cachedLines?.length || 0)) ? this.activeLineIndex : 0;
      this.activeLineIndex = targetLine;
      const words = this.ensureActiveWords(targetLine);
      if (words && words.length > 0) {
        this.activeWordIndex = 0;
        this.setWordWindow(0);
      } else {
        this.activeWordIndex = -1;
      }
      if (this.rulerEl) this.rulerEl.classList.add("word-tracking-mode");
    } else {
      this.activeWordIndex = -1;
      this._clearWordCache();
      if (this.rulerEl) {
        this.rulerEl.classList.remove("word-tracking-mode", "no-preview");
      }
      if (this.cachedLines && this.cachedLines.length > 0) {
        const lineIdx = Math.max(0, Math.min(this.cachedLines.length - 1, this.activeLineIndex >= 0 ? this.activeLineIndex : 0));
        this.activeLineIndex = lineIdx;
        const geom = this.computeLineGeometry(lineIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = geom.targetY;
        }
      }
    }

    this.updateStyles();
    this.applyPosition();
  }

  setDimOpacity(opacity) {
    this.dimOpacity = Math.max(0.1, Math.min(0.95, parseFloat(opacity) || 0.70));
    document.documentElement.style.setProperty("--focus-dim-opacity", String(this.dimOpacity));
    const masks = [this.maskTopEl, this.maskBottomEl, this.maskLeftEl, this.maskRightEl, this.maskInactiveSpreadEl];
    const themeBg = "var(--bg-theme, var(--color-bg, #fbf0d9))";
    for (const m of masks) {
      if (m) {
        m.style.setProperty("opacity", String(this.dimOpacity), "important");
        if (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0)) {
          m.style.setProperty("background-color", themeBg, "important");
        }
      }
    }
    this.refreshVisualState();
  }

  setFollowMode(mode) {
    if (this.isImageOnlyPdf || (this.isPdfMode && (!this.cachedLines || this.cachedLines.length === 0))) {
      this.followMode = "mouse";
      this.stationaryScreenY = null;
      this.updateBodyClasses();
      this.refreshVisualState();
      return;
    }
    this.disableWordTransition();
    this.followMode = mode;
    if (mode !== "keyboard") {
      this.stationaryScreenY = null;
    }
    this.updateBodyClasses();
    if (this.enabled) {
      if (this.followMode === "mouse") {
        this.snapToFirstElement();
        if (this.lastPointerX != null && this.lastPointerY != null) {
          this.updateCursorVisibility(this.lastPointerX, this.lastPointerY, "mouse");
        }
      } else {
        this.setCursorHidden(false);
        if (this.followMode === "keyboard" && (!this.isPdfMode || (this.cachedLines && this.cachedLines.length > 0)) && this.isVerticalMode() && this.stationaryScreenY === null) {
          this.initDefaultStationaryAnchor();
        }
      }
    } else {
      this.setCursorHidden(false);
    }
    this.refreshVisualState();
  }


  /**
   * Vyvolá se při přechodu na jinou stránku nebo kapitolu.
   * Zajišťuje, že se měření řádků provede až po úplném ustálení DOM layoutu a přechodových animací
   * (Post-Transition Settle Verification), s následnou tichou rekalibrací na pozadí (Two-Pass Calibration).
   */
  onPageChange(direction = 0, isPageChanged = true, immediateRuler = true) {
    if (!this.enabled) {
      this.forceReleaseNavigationLocks();
      return;
    }
    this.clearPageTransitionTimersAndRAFs();
    this.disableWordTransition();
    if (this.wordTransitionTimer) {
      clearTimeout(this.wordTransitionTimer);
      this.wordTransitionTimer = null;
    }
    this.isWordTransitioning = false;
    this.cancelHold();

    if (this.pageChangeTimer) {
      clearTimeout(this.pageChangeTimer);
      this.pageChangeTimer = null;
    }
    const content = document.getElementById("reader-content");
    if (content && this._onTransitionEnd) {
      content.removeEventListener("transitionend", this._onTransitionEnd);
      this._onTransitionEnd = null;
    }

    this.penHistory = [];
    this.touchHistory = [];
    this._maxLineIndexOnPage = -1;
    this._maxWordIndexOnPage = -1;
    this._lastLineProgressTime = 0;
    this._lastWordProgressTime = 0;

    const targetDirection = this.flickResyncTopLine ? 1 : direction;
    this.flickResyncTopLine = false;

    const stage = this.getStageElement();
    const isDocTurning = document.body.classList.contains("is-turning-page") ||
      (stage && stage.classList.contains("is-turning-page")) ||
      (content && content.classList.contains("is-turning-page"));

    let hasActiveTransition = false;
    let transitionDurationMs = 0;
    if (content) {
      try {
        const cs = window.getComputedStyle(content);
        const transProp = cs.transitionProperty || "";
        const dur = parseFloat(cs.transitionDuration) || 0;
        if (dur > 0 && (transProp.includes("transform") || transProp === "all")) {
          hasActiveTransition = true;
          transitionDurationMs = dur * 1000;
        }
      } catch (e) {}
    }

    const executePageReset = () => {
      if (this.pageChangeTimer) {
        clearTimeout(this.pageChangeTimer);
        this.pageChangeTimer = null;
      }
      if (content && this._onTransitionEnd) {
        content.removeEventListener("transitionend", this._onTransitionEnd);
        this._onTransitionEnd = null;
      }
      this.resetPositionForPage(targetDirection, isPageChanged);
    };

    // 1. Post-Transition Settle Verification:
    // Pokud je CSS přechod aktivní, počkáme na transitionend (s pojistným timeoutem)
    if (hasActiveTransition && content) {
      this._onTransitionEnd = (e) => {
        if (e && e.target !== content) return;
        executePageReset();
      };
      content.addEventListener("transitionend", this._onTransitionEnd, { once: true });
      this.pageChangeTimer = setTimeout(executePageReset, Math.round(transitionDurationMs + 50));
      return;
    }

    // Pokud je požadováno okamžité usazení pravítka (immediateRuler), provedeme reset přímo
    if (immediateRuler) {
      executePageReset();
      return;
    }

    // Pokud probíhá otáčení stránky v DOMu, počkáme na double requestAnimationFrame + debounced settle timeout (60ms)
    if (isDocTurning) {
      this.pageChangeRafId = requestAnimationFrame(() => {
        this.pageChangeRafId = requestAnimationFrame(() => {
          this.pageChangeRafId = null;
          this.pageChangeTimer = setTimeout(executePageReset, 60);
        });
      });
      return;
    }

    // Pokud je již layout plně ustálen, provedeme usazení rovnou
    executePageReset();
  }

  destroy() {
    this.clearPageTransitionTimersAndRAFs();
    this.forceReleaseNavigationLocks();
    if (this._canonicalColTopOffsets) {
      this._canonicalColTopOffsets.clear();
    }
    if (this._onScroll) {
      window.removeEventListener("scroll", this._onScroll, { passive: true, capture: true });
      const vp = document.getElementById("paged-viewport") || document.querySelector(".paged-viewport");
      if (vp) {
        vp.removeEventListener("scroll", this._onScroll, { passive: true });
        vp._rulerScrollAttached = false;
      }
    }
    if (this._refreshLinesDebounceTimer) {
      clearTimeout(this._refreshLinesDebounceTimer);
      this._refreshLinesDebounceTimer = null;
    }
    if (this._programmaticScrollTimer) {
      clearTimeout(this._programmaticScrollTimer);
      this._programmaticScrollTimer = null;
    }
    this._isProgrammaticScroll = false;
    this.stationaryScreenY = null;
    this._verticalScrollAnchorPending = false;
    this._relativeTrackingActive = false;
    this._scrollAnchorPhysicalY = null;
    this._scrollAnchorVirtualY = null;
    this.penHistory = [];
    this.touchHistory = [];
    this._maxLineIndexOnPage = -1;
    this._maxWordIndexOnPage = -1;
    this._lastLineProgressTime = 0;
    this._lastWordProgressTime = 0;
    this.cachedLines = [];
    this.cachedWords = [];
    this.penStrokeStartTime = 0;
    this.flickHandledInStroke = false;
    if (this.pointerRafId) {
      cancelAnimationFrame(this.pointerRafId);
      this.pointerRafId = null;
    }
    if (this._navSafetyTimer) {
      clearTimeout(this._navSafetyTimer);
      this._navSafetyTimer = null;
    }
    if (this.lineLockTimer) {
      clearTimeout(this.lineLockTimer);
      this.lineLockTimer = null;
    }
    this.isLineLocked = false;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
    this.suppressLineAdvancement = false;
    if (this.pageChangeRafId) {
      cancelAnimationFrame(this.pageChangeRafId);
      this.pageChangeRafId = null;
    }
    if (this.navigatingPageTimer) {
      clearTimeout(this.navigatingPageTimer);
      this.navigatingPageTimer = null;
    }
    this.isNavigating = false;
    this.isNavigatingPage = false;
    if (this.wordTransitionTimer) {
      clearTimeout(this.wordTransitionTimer);
      this.wordTransitionTimer = null;
    }
    this.isWordTransitioning = false;
    if (this.pageChangeTimer) {
      clearTimeout(this.pageChangeTimer);
      this.pageChangeTimer = null;
    }
    const content = document.getElementById("reader-content");
    if (content && this._onTransitionEnd) {
      content.removeEventListener("transitionend", this._onTransitionEnd);
      this._onTransitionEnd = null;
    }
    if (this.rulerEl) this.rulerEl.remove();
    if (this.maskTopEl) this.maskTopEl.remove();
    if (this.maskBottomEl) this.maskBottomEl.remove();
    if (this.maskLeftEl) this.maskLeftEl.remove();
    if (this.maskRightEl) this.maskRightEl.remove();
    if (this.maskInactiveSpreadEl) this.maskInactiveSpreadEl.remove();
    if (this.overlayContainer) {
      this.overlayContainer.remove();
      this.overlayContainer = null;
    }
    document.querySelectorAll(".ruler-hold-indicator").forEach(el => el.remove());
    this.clearFocusTextMask();
    this.setCursorHidden(false);
    document.body.classList.remove("ruler-active", "ruler-mouse-follow-active", "ruler-cursor-hidden", "word-tracking-active", "ruler-mode-focus");
    document.getElementById("paged-viewport")?.classList.remove("ruler-cursor-hidden");
  }
}
