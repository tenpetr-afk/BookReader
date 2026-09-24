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

export class ReadingRuler {
  constructor(containerElement) {
    this.container = containerElement;
    this.rulerEl = null;
    this.maskTopEl = null;
    this.maskBottomEl = null;
    this.maskLeftEl = null;
    this.maskRightEl = null;
    this.onBoundary = null; // Callback vyvolaný při překročení hranice strany (direction: 1 | -1)

    // PDF Mode
    this.isPdfMode = false;
    this.pdfRulerHeight = 32; // px - výchozí výška mechanického pravítka pro PDF

    // Nastavení
    this.enabled = false;
    this.mode = "highlight"; // "highlight" | "focus"
    this.rulerPadding = RULER_PADDING;
    this.manualHeight = 48; // px (při vypnutém autoHeight)
    this.height = 36; // aktuální efektivní výška
    this.autoHeight = true; // Automatická výška podle velikosti řádku
    this.snapToLines = true; // Magnetická přilnavost k řádkům
    this.wordTracking = false; // Sledování jednotlivých slov
    this.color = "amber"; // amber | cyan | emerald | lavender | slate
    this.dimOpacity = 0.65;
    this.followMode = "mouse"; // "mouse" | "keyboard" | "auto"

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
    this.animFrameId = null;
    this.isDragging = false;
    this.isPageTransitioning = false;
    this.isNavigating = false;
    this.isNavigatingPage = false;
    this.navigatingPageTimer = null;
    this.navigatingPageLockoutEndTime = 0;
    this.pageChangeTimer = null;
    this._onTransitionEnd = null;

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
    // Callback wired by app.js: () => bool — returns true when any drawer/panel is open.
    // When true, ruler click/tap handlers must yield to backdrop close logic.
    this.isAnyDrawerOpen = null;

    this.createDomElements();
    this.attachEvents();
  }

  /**
   * Okamžitě skryje pravítko během přechodu na jinou stránku a výpočtu řádků.
   */
  hideForPageTransition() {
    this.isPageTransitioning = true;
    if (this.rulerEl) {
      this.rulerEl.classList.add("is-page-transitioning");
      this.rulerEl.style.transition = "none";
      this.rulerEl.style.setProperty("transition", "none", "important");
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
    }
    if (this.maskTopEl) this.maskTopEl.style.display = "none";
    if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
    if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
    if (this.maskRightEl) this.maskRightEl.style.display = "none";
    if (this.mode !== "focus") {
      this.clearFocusTextMask();
    }
  }

  lockAdvancement(duration = 350) {
    const stage = this.getStageElement();
    if (stage) stage.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");
    const content = document.getElementById("reader-content");
    if (content) content.classList.add("is-turning-page");

    this.hideForPageTransition();
    this.pageTurnTimestamp = performance.now();
    this.suppressLineAdvancement = true;
    if (this.suppressTimer) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressLineAdvancement = false;
      this.suppressTimer = null;
    }, duration);

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isLineLocked = false;
        this.suppressLineAdvancement = false;
      }
    }, 300); // 300ms maximum lock lifetime
  }

  setPdfMode(enabled) {
    this.isPdfMode = !!enabled;
    if (this.isPdfMode) {
      this.cachedLines = [];
      this.cachedWords = [];
      this.height = this.pdfRulerHeight || 32;
      if (this.rulerEl) {
        this.rulerEl.classList.add("pdf-ruler-overlay");
        this.rulerEl.classList.remove("word-tracking-mode");
      }
      if (this.enabled) {
        this.applyPosition();
      }
    } else {
      if (this.rulerEl) {
        this.rulerEl.classList.remove("pdf-ruler-overlay");
      }
      if (this.maskTopEl) this.maskTopEl.classList.remove("pdf-overlay-mask");
      if (this.maskBottomEl) this.maskBottomEl.classList.remove("pdf-overlay-mask");
      if (this.enabled) {
        this.refreshLines();
        this.applyPosition();
      }
    }
  }

  isLastLine() {
    if (!this.enabled) return false;
    if (this.isPdfMode) {
      const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { bottom: window.innerHeight - 60 };
      const canvas = document.querySelector("#reader-content canvas");
      const bottomBound = canvas ? canvas.getBoundingClientRect().bottom : stageRect.bottom;
      const h = this.height || 32;
      return (this.currentY + h >= bottomBound - 8);
    }
    if (this.wordTracking) {
      if (this.cachedWords.length === 0) return false;
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
    return this.wordTracking ? "word" : "line";
  }

  set rulerMode(val) {
    this.setWordTracking(val === "word");
  }

  enableWordTransition() {
    this.disableWordTransition();
  }

  disableWordTransition() {
    this.horizontalWordTransition = false;
    if (this.wordTransitionTimer) {
      clearTimeout(this.wordTransitionTimer);
      this.wordTransitionTimer = null;
    }
    this.isWordTransitioning = false;
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

    this.maskTopEl = document.createElement("div");
    this.maskTopEl.className = "ruler-mask ruler-mask-top is-hidden";

    this.maskBottomEl = document.createElement("div");
    this.maskBottomEl.className = "ruler-mask ruler-mask-bottom is-hidden";

    this.maskLeftEl = document.createElement("div");
    this.maskLeftEl.className = "ruler-mask ruler-mask-left is-hidden";

    this.maskRightEl = document.createElement("div");
    this.maskRightEl.className = "ruler-mask ruler-mask-right is-hidden";

    document.body.appendChild(this.maskTopEl);
    document.body.appendChild(this.maskBottomEl);
    document.body.appendChild(this.maskLeftEl);
    document.body.appendChild(this.maskRightEl);
    document.body.appendChild(this.rulerEl);

    this.updateStyles();
    this.applyPosition();
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
   * Zjistí, zda se souřadnice ukazatele nacházejí uvnitř čtecí plochy knihy,
   * aby kurzor v záhlaví či okrajích nestrhával pravítko na začátek textu.
   */
  isPointerInStage(clientX, clientY) {
    if (clientX == null || clientY == null) return false;
    const stage = document.getElementById("paged-viewport") || this.container || document.getElementById("paged-stage");
    if (!stage) return false;
    const rect = stage.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
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
    if (this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime || this.isPageTransitioning) {
      return;
    }
    this.pendingPointerX = clientX;
    this.pendingPointerY = clientY;
    this.pendingPointerType = pointerType;
    this.activePointerType = pointerType;
    if (!this.rafPointerPending) {
      this.rafPointerPending = true;
      this.pointerRafId = requestAnimationFrame(() => {
        this.rafPointerPending = false;
        this.pointerRafId = null;
        if (this.enabled && !this.isLineLocked && !this.isPageTransitioning) {
          this.handlePointerMove(this.pendingPointerX, this.pendingPointerY, this.pendingPointerType);
        }
      });
    }
  }

  isAlreadyAtPosition(clientX, clientY) {
    if (this.isPdfMode) return false;
    if (this.wordTracking && this.cachedWords.length > 0 && this.activeWordIndex >= 0) {
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
    if (this.followMode === "mouse") return;

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

    this.handlePointerMove(x, y);
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

      if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
      if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
        this.holdStartTime = 0;
        return;
      }
      if (e.target?.closest && e.target.closest("hr")) return;

      // Pro myš na PC vyžadujeme výhradně stisknuté levé tlačítko (button === 0)
      if (e.pointerType === "mouse" && e.button !== 0) return;

      if (this.isPdfMode) {
        if (e.pointerType === "pen" || e.pointerType === "mouse") {
          this.activePointerId = e.pointerId;
          this.activePointerType = e.pointerType;
          this.isPenTouching = (e.pointerType === "pen");
          this.isDraggingRuler = true;
          this.handlePointerMove(e.clientX, e.clientY, e.pointerType);
          return;
        }
      }

      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        this.activePointerId = e.pointerId;
        this.activePointerType = e.pointerType;
        this.handlePointerMove(e.clientX, e.clientY, e.pointerType);
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

      if (this.isPdfMode) {
        if (e.pointerType === "pen" || (e.pointerType === "mouse" && this.followMode === "mouse") || this.isDraggingRuler) {
          if (!this.isUiControl(e.target) && this.isPointerInStage(e.clientX, e.clientY)) {
            this.activePointerType = e.pointerType;
            this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
          }
        }
        return;
      }

      // Plynulé sledování v reálném čase v režimu sledování myši ("mouse") pro myš i Apple Pencil
      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        if ((e.pointerType === "mouse" || e.pointerType === "pen") && !this.isDraggingRuler) {
          if (!this.isUiControl(e.target) && this.isPointerInStage(e.clientX, e.clientY)) {
            this.activePointerType = e.pointerType;
            this.schedulePointerUpdate(e.clientX, e.clientY, e.pointerType);
          }
        }
        return;
      }
    };

    const onPointerUp = (e) => {
      if (this.isPdfMode) {
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

        if (isTap && (e.pointerType === "touch" || e.pointerType === "mouse")) {
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

    // 2. TOUCH EVENTS (WebKit Safari fallback pro starší zařízení)
    const onTouchStart = (e) => {
      if (!this.enabled || this.isLineLocked) return;
      const touch = e.touches[0];
      if (this.isUiControl(e.target) || !touch || !this.isPointerInStage(touch.clientX, touch.clientY)) {
        this.holdStartTime = 0;
        return;
      }
      if (e.target?.closest && e.target.closest("hr")) return;
      const isStylus = Array.from(e.touches).some(t => t.touchType === "stylus");
      if (isStylus) {
        this.lastPenTime = Date.now();
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
      if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
      const isStylus = Array.from(e.touches).some(t => t.touchType === "stylus");
      if (isStylus) {
        this.lastPenTime = Date.now();
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

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });

    // 3. MOUSEMOVE fallback (pro prohlížeče bez PointerEvents)
    window.addEventListener("mousemove", (e) => {
      if (window.PointerEvent) return;
      if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime || this.isDraggingRuler || this.isPenTouching) return;
      if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
        return;
      }
      if (this.followMode === "mouse") {
        this.activePointerType = "mouse";
        this.schedulePointerUpdate(e.clientX, e.clientY, "mouse");
      }
    }, { passive: true });

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
    }, { passive: true });

    // Zachycení kliknutí pro zabránění nežádoucího resetu nebo odskoku pravítka po dokončení podržení či jeho zrušení
    window.addEventListener("click", (e) => {
      if (!this.enabled) return;
      // When any drawer/panel is open, do NOT swallow the event — let the backdrop handler close it.
      if (typeof this.isAnyDrawerOpen === "function" && this.isAnyDrawerOpen()) return;
      if (this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      if (this.isUiControl(e.target)) return;
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
      if (!this.enabled) return;
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

    window.addEventListener("resize", () => {
      if (this.enabled) {
        this.cancelHold();
        this.refreshLines();
        if (this.wordTracking) this.refreshWords();
        this.applyPosition();
      }
    });
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
    if (document.body && document.body.classList.contains('columns-2')) return true;
    if (document.documentElement && document.documentElement.classList.contains('columns-2')) return true;
    if (document.querySelector('.columns-2') !== null) return true;
    if (document.querySelector('#reader-content.columns-2, .paged-content.columns-2, #paged-stage.columns-2') !== null) return true;

    try {
      const colCountVal = getComputedStyle(document.documentElement).getPropertyValue('--reader-column-count')?.trim();
      if (colCountVal === '2') return true;
    } catch (e) {}

    try {
      if (content) {
        const comp = getComputedStyle(content);
        if (comp.columnCount === '2' || comp.columnCount === 2 || parseInt(comp.columnCount, 10) === 2) {
          return true;
        }
      }
    } catch (e) {}

    // Geometrická autodetekce: ověření existence dvou sloupců vedle sebe podle souřadnic řádků
    if (rawLines && rawLines.length >= 4) {
      const sRect = stageRect || (content ? content.getBoundingClientRect() : { left: 0, width: window.innerWidth });
      const stageCenterX = sRect.left + sRect.width / 2;
      const leftLines = [];
      const rightLines = [];
      for (let i = 0; i < rawLines.length; i++) {
        const r = rawLines[i];
        const cx = (r.left + r.right) / 2;
        if (cx < stageCenterX - 30 && r.right <= stageCenterX + 15) {
          leftLines.push(r);
        } else if (cx > stageCenterX + 30 && r.left >= stageCenterX - 15) {
          rightLines.push(r);
        }
      }
      if (leftLines.length >= 2 && rightLines.length >= 2) {
        let overlapCount = 0;
        for (let j = 0; j < leftLines.length; j++) {
          const lr = leftLines[j];
          for (let k = 0; k < rightLines.length; k++) {
            const rr = rightLines[k];
            if (Math.abs(lr.centerY - rr.centerY) < 16 && lr.right < rr.left) {
              overlapCount++;
              if (overlapCount >= 2) return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * Bezpečná detekce řádků textu chráněná proti pádu (try-catch) a zacyklení.
   * Využívá standardní dotaz nad kandidátními elementy bez rekurzivního průchodu DOMem.
   */
  detectLines() {
    if (this.isPdfMode) {
      this.cachedLines = [];
      return [];
    }
    try {
      // Ensure we capture whatever typography container the reader engine actually uses:
      const content = document.querySelector('#reader-content, .page-content, .reader-text, article') || document.body;
      const elements = content.querySelectorAll('p, div, span, h1, h2, h3, h4, h5, h6, li, blockquote');

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
      const isTwoColEarly = this.checkTwoColumnLayout(content, stageRect, null);

      const rawLines = [];

      elements.forEach(el => {
        // Explicitně přeskočit obrázky, svg a prázdné elementy
        if (el.closest('svg, figure, picture') || el.tagName === 'IMG' || el.tagName === 'HR' || el.tagName === 'CANVAS') return;
        if (!el.textContent || el.textContent.trim().length === 0) return;

        // Pokud element obsahuje jiné blokové potomky z candidateElements, necháme zpracovat až konkrétní potomky
        if (el.tagName === 'DIV' && el.querySelector('p, div, h1, h2, h3, h4, h5, h6, li, blockquote')) return;

        // Přeskočit vnořené inline elementy, pokud je již zachycen jejich nadřazený blok
        if (el.tagName === 'SPAN' && el.closest('p, div, h1, h2, h3, h4, h5, h6, li, blockquote')) return;

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Bezpečně extrahovat nebo seskupit ohraničení řádků
          try {
            const range = document.createRange();
            range.selectNodeContents(el);
            const rects = range.getClientRects();
            if (rects && rects.length > 0) {
              // For block elements (p, h1-h6, li, etc.) in single-column mode, the element's
              // own bounding rect anchors the left/right of each raw line rect so inline fragment
              // rects (e.g. Bionic markup) don't truncate the measured column width.
              // In multi-column mode or for blocks spanning across columns, NEVER apply blockLeft/Right:
              // individual lines must retain their true physical column coordinates so continuation
              // fragments across the column split (e.g. top of col 1) are never misassigned to col 0.
              const isBlock = /^(P|H[1-6]|LI|BLOCKQUOTE|DIV)$/.test(el.tagName);
              // In two-column mode, a <p> can span across the column divider —
              // suppress blockBounds only for those cross-column blocks so that
              // individual line fragments keep their true column coordinates.
              // In single-column mode, all full-width paragraphs naturally span
              // the stage centre (isMultiColumnBlock would fire for nearly every
              // paragraph), so we ALWAYS apply blockBounds in 1-col mode to ensure
              // every fragment rect is anchored to the paragraph's true left/right
              // and the geometric two-column detector isn't fed half-width fragments.
              const isMultiColumnBlock = isTwoColEarly && (rect.left < stageCenterX - 30 && rect.right > stageCenterX + 30);
              const useBlockBounds = isBlock && !isMultiColumnBlock;
              const blockLeft = useBlockBounds ? rect.left : null;
              const blockRight = useBlockBounds ? rect.right : null;
              for (let i = 0; i < rects.length; i++) {
                const r = rects[i];
                const inStage = !hasValidStageBounds || (
                  r.right > stageLeft - 4 &&
                  r.left < stageRight + 4 &&
                  r.bottom > stageTop + 2 &&
                  r.top < stageBottom - 2
                );
                if (inStage && r.height >= 8 && r.width >= 8) {
                  let lineLeft = r.left;
                  let lineRight = r.right;
                  if (useBlockBounds) {
                    // In 2-col mode only clamp to blockLeft/Right if the fragment
                    // is in the same column as the block anchor edge.
                    // In 1-col mode always clamp (sameLeftCol/sameRightCol = true).
                    const sameLeftCol = !isTwoColEarly || !(r.left >= stageCenterX - 15 && blockLeft < stageCenterX - 15);
                    const sameRightCol = !isTwoColEarly || !(r.right <= stageCenterX + 15 && blockRight > stageCenterX + 15);
                    if (blockLeft != null && sameLeftCol) lineLeft = Math.min(lineLeft, blockLeft);
                    if (blockRight != null && sameRightCol) lineRight = Math.max(lineRight, blockRight);
                  }
                  rawLines.push({
                    el,
                    element: el,
                    rect: r,
                    top: r.top,
                    bottom: r.bottom,
                    left: lineLeft,
                    right: lineRight,
                    height: r.height,
                    centerY: r.top + r.height / 2,
                    hasText: true
                  });
                }
              }
            } else {
              const inStage = !hasValidStageBounds || (
                rect.right > stageLeft - 4 &&
                rect.left < stageRight + 4 &&
                rect.bottom > stageTop + 2 &&
                rect.top < stageBottom - 2
              );
              if (inStage && rect.height >= 8 && rect.width >= 8) {
                rawLines.push({
                  el,
                  element: el,
                  rect,
                  top: rect.top,
                  bottom: rect.bottom,
                  left: rect.left,
                  right: rect.right,
                  height: rect.height,
                  centerY: rect.top + rect.height / 2,
                  hasText: true
                });
              }
            }
          } catch (e) {
            const inStage = !hasValidStageBounds || (
              rect.right > stageLeft - 4 &&
              rect.left < stageRight + 4 &&
              rect.bottom > stageTop + 2 &&
              rect.top < stageBottom - 2
            );
            if (inStage && rect.height >= 8 && rect.width >= 8) {
              rawLines.push({
                el,
                element: el,
                rect,
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                height: rect.height,
                centerY: rect.top + rect.height / 2,
                hasText: true
              });
            }
          }
        }
      });

      // Pokud standardní selektory nenašly řádky, nesmíme pravítko trvale skrýt
      if (rawLines.length === 0) {
        // 1. Fallback: Prohledat všechny listové textové uzly
        try {
          const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              if (!node.textContent || node.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
              const parent = node.parentElement;
              if (!parent || parent.closest('svg, figure, picture, script, style') || parent.tagName === 'IMG') return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          });

          let textNode;
          while ((textNode = walker.nextNode())) {
            try {
              const range = document.createRange();
              range.selectNodeContents(textNode);
              const rects = range.getClientRects();
              for (let i = 0; i < rects.length; i++) {
                const r = rects[i];
                if (r.width >= 8 && r.height >= 8) {
                  rawLines.push({
                    el: textNode.parentElement,
                    element: textNode.parentElement,
                    rect: r,
                    top: r.top,
                    bottom: r.bottom,
                    left: r.left,
                    right: r.right,
                    height: r.height,
                    centerY: r.top + r.height / 2,
                    hasText: true
                  });
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      // Detekce multimediálních elementů (img, svg, figure, picture, canvas, .chapter-illustration)
      const mediaCandidates = Array.from(content.querySelectorAll('img, svg, canvas, figure, picture, .chapter-illustration'));
      const processedMedia = new Set();

      for (const mEl of mediaCandidates) {
        if (mEl.tagName === 'HR') continue;
        if ((mEl.tagName === 'FIGURE' || mEl.tagName === 'PICTURE' || mEl.classList.contains('chapter-illustration')) &&
            mEl.querySelector('img, svg, canvas')) {
          continue;
        }
        if (mEl.tagName !== 'svg' && mEl.tagName !== 'SVG' && mEl.closest('svg')) {
          continue;
        }
        if (processedMedia.has(mEl)) continue;
        processedMedia.add(mEl);

        const r = mEl.getBoundingClientRect();
        if (r.width >= 10 && r.height >= 10) {
          const inStage = !hasValidStageBounds || (
            r.bottom > stageTop + 2 &&
            r.top < stageBottom - 2 &&
            r.right > stageLeft - 10 &&
            r.left < stageRight + 10
          );
          if (inStage) {
            rawLines.push({
              el: mEl,
              element: mEl,
              rect: r,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
              centerY: r.top + r.height / 2,
              hasText: true,
              isMedia: true
            });
          }
        }
      }

      // Autodetekce dvousloupcového rozvržení (CSS třídy + geometrické překryvy řádků)
      const isTwoCol = this.checkTwoColumnLayout(content, stageRect, rawLines);
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

      // Přiřazení indexu sloupce každému nalezenému řádku
      for (let i = 0; i < rawLines.length; i++) {
        const r = rawLines[i];
        if (!isTwoCol) {
          r.columnIndex = 0;
        } else {
          const midX = (r.left + r.right) / 2;
          r.columnIndex = (midX >= colDividerX || r.left >= col0StageRight - 10) ? 1 : 0;
        }
      }
      const validLines = rawLines;

      // Seskupení řádků odděleně podle sloupců, aby se řádky ve stejném Y v sousedních sloupcích nespojily do jednoho
      const clusterColumnLines = (colLines, colIdx) => {
        if (colLines.length === 0) return [];
        colLines.sort((a, b) => {
          if (Math.abs(a.top - b.top) > 3) {
            return a.top - b.top;
          }
          return a.centerY - b.centerY;
        });
        const colClustered = [];
        for (const r of colLines) {
          if (colClustered.length === 0) {
            colClustered.push({ ...r, columnIndex: colIdx, element: r.element || r.el });
          } else {
            const prev = colClustered[colClustered.length - 1];
            const shouldMerge = !r.isMedia && !prev.isMedia && (
              Math.abs(r.centerY - prev.centerY) < 8 ||
              (Math.max(r.top, prev.top) < Math.min(r.bottom, prev.bottom) - 3)
            );
            if (shouldMerge) {
              prev.top = Math.min(prev.top, r.top);
              prev.bottom = Math.max(prev.bottom, r.bottom);
              prev.left = Math.min(prev.left ?? r.left, r.left);
              prev.right = Math.max(prev.right ?? r.right, r.right);
              prev.height = prev.bottom - prev.top;
              prev.centerY = prev.top + prev.height / 2;
              prev.element = prev.element || r.element || r.el;
            } else {
              colClustered.push({ ...r, columnIndex: colIdx, element: r.element || r.el });
            }
          }
        }
        return colClustered;
      };

      let clustered = [];
      if (isTwoCol) {
        const col0Lines = validLines.filter(l => l.columnIndex === 0);
        const col1Lines = validLines.filter(l => l.columnIndex === 1);
        clustered = [...clusterColumnLines(col0Lines, 0), ...clusterColumnLines(col1Lines, 1)];
      } else {
        clustered = clusterColumnLines(validLines, 0);
      }

      this.cachedLines = clustered.filter(l => (l.hasText || l.isMedia) && l.height >= 8 && (l.right - l.left) >= 8);
      this.previousActiveLineIndex = -1;

      // Pokud na stránce není detekován žádný řádek textu, pravítko nesmí vytvářet náhodné záchranné souřadnice
      if (this.cachedLines.length === 0) {
        this.column0Left = 0;
        this.column0Width = stageRect.width;
        this.column0Right = stageRect.right;
        this.activeLineIndex = 0;
        return;
      }

      if (this.cachedLines.length > 0) {
        let minLeft0 = Infinity, maxRight0 = -Infinity;
        let minLeft1 = Infinity, maxRight1 = -Infinity;

        for (const line of this.cachedLines) {
          if (line.isMedia) continue;
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
        if (isTwoCol) {
          if (minLeft1 < Infinity && maxRight0 > -Infinity && minLeft1 > maxRight0) {
            gapMiddle = Math.round((maxRight0 + minLeft1) / 2);
          }
        }
        this.gapMiddle = gapMiddle;

        // Horizontální ohraničení sloupce 0.
        // In 1-column mode: always use the stage right edge as c0Right authority so that
        // inline markup (e.g. Bionic/Fast Reading spans) cannot truncate the column width.
        const col0MaxRight = isTwoCol ? (gapMiddle - 4) : window.innerWidth;
        let c0Left = minLeft0 < Infinity ? (minLeft0 - horizontalPadding) : (col0StageLeft - horizontalPadding);
        let c0Right;
        if (isTwoCol) {
          // 2-col: derive from measured maxRight0 or col0StageRight
          c0Right = maxRight0 > -Infinity ? Math.max(maxRight0 + horizontalPadding, col0StageRight) : (gapMiddle - 4);
        } else {
          // 1-col: always anchor to stage right — Bionic inline rects cannot shrink this
          c0Right = col0StageRight + horizontalPadding;
        }
        const col0MinLeft = Math.max(0, Math.round(col0StageLeft - horizontalPadding));
        c0Left = Math.max(col0MinLeft, Math.round(c0Left));
        c0Right = Math.min(col0MaxRight, Math.round(c0Right));
        if (c0Right <= c0Left) {
          c0Left = col0MinLeft;
          c0Right = Math.min(col0MaxRight, Math.round(col0StageRight + horizontalPadding));
        }
        const c0Width = Math.max(80, Math.round(c0Right - c0Left));

        // Horizontální ohraničení sloupce 1 (pokud je 2-sloupcový režim)
        // Šířka pravého sloupce je striktně symetrická k sloupci 0 a nesmí být
        // nikdy odvozována z window.innerWidth, stageRect.right ani pravého okraje viewportu.
        const textContainer = content || stage;
        const textContainerRect = textContainer ? textContainer.getBoundingClientRect() : stageRect;
        const textContainerWidth = (textContainerRect && textContainerRect.width > 50) ? textContainerRect.width : stageRect.width;
        const computedColWidth = Math.max(80, Math.round((textContainerWidth - colGap) / 2));
        const columnWidth = isTwoCol
          ? ((c0Width >= 80 && Math.abs(c0Width - computedColWidth) <= 60) ? c0Width : computedColWidth)
          : c0Width;

        let c1Left = gapMiddle + 4;
        let c1Width = columnWidth;
        let c1Right = c1Left + c1Width;

        if (isTwoCol) {
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
        }

        for (const line of this.cachedLines) {
          line.textLeft = line.left;
          line.textRight = line.right;
          line.textWidth = (line.right != null && line.left != null) ? (line.right - line.left) : null;
          if (line.columnIndex === 1) {
            line.columnLeft = c1Left;
            line.columnWidth = c1Width;
            line.columnRight = c1Left + c1Width;
            line.colBoundaryLeft = col1StageLeft;
            line.colBoundaryRight = col1StageRight;
          } else {
            line.columnLeft = c0Left;
            line.columnWidth = c0Width;
            line.columnRight = c0Left + c0Width;
            line.colBoundaryLeft = col0StageLeft;
            line.colBoundaryRight = col0StageRight;
          }
          if (line.isMedia) {
            line.width = line.width ?? (line.right - line.left);
            line.height = line.height ?? (line.bottom - line.top);
          } else {
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

        if (this.activeLineIndex >= this.cachedLines.length) {
          this.activeLineIndex = Math.max(0, this.cachedLines.length - 1);
        }

        if (!this.isPageTransitioning && this.cachedLines.length > 0) {
          this.updateStyles();
        }
      }

      if (this.autoHeight) {
        let baseH = 0;
        if (this.cachedLines.length > 0) {
          const sortedHeights = this.cachedLines.filter(l => !l.isMedia).map(l => l.height).filter(h => h > 0).sort((a, b) => a - b);
          if (sortedHeights.length > 0) {
            baseH = sortedHeights[Math.floor(sortedHeights.length / 2)];
          }
        }
        if (!baseH || baseH < 12) {
          try {
            const cs = content ? window.getComputedStyle(content) : null;
            if (cs) {
              const lh = parseFloat(cs.lineHeight);
              const fs = parseFloat(cs.fontSize);
              if (Number.isFinite(lh) && lh > 0) {
                baseH = lh;
              } else if (Number.isFinite(fs) && fs > 0) {
                baseH = fs * 1.35;
              }
            }
          } catch (e) {}
        }
        if (!baseH || baseH < 12) {
          baseH = 24;
        }

        // Vypočítat mediánovou vzdálenost mezi sousedními řádky (baseline pitch) ve stejném sloupci
        let medianPitch = 0;
        if (this.cachedLines.length > 1) {
          const pitches = [];
          for (let i = 0; i < this.cachedLines.length - 1; i++) {
            const cur = this.cachedLines[i];
            const next = this.cachedLines[i + 1];
            if (!cur.isMedia && !next.isMedia && cur.columnIndex === next.columnIndex) {
              const p = next.centerY - cur.centerY;
              if (p > 8 && p < 150) pitches.push(p);
            }
          }
          if (pitches.length > 0) {
            pitches.sort((a, b) => a - b);
            medianPitch = pitches[Math.floor(pitches.length / 2)];
          }
        }

        // Dynamické vertikální odsazení: nesmí za žádných okolností přesáhnout mezilinkovou vzdálenost
        let padV = 0;
        if (medianPitch > 0) {
          const maxAllowedH = Math.max(10, Math.floor(medianPitch - 2));
          const availableGap = Math.max(0, maxAllowedH - baseH);
          padV = Math.max(0, Math.min(2, Math.floor(availableGap / 2)));
          this.height = Math.min(maxAllowedH, Math.round(baseH + (2 * padV)));
        } else {
          padV = Math.max(0, Math.min(2, Math.round(baseH * 0.05)));
          this.height = Math.round(baseH + (2 * padV));
        }
      } else {
        this.height = this.manualHeight || 36;
      }

      return this.cachedLines;
    } catch (err) {
      console.error("[ReadingRuler] Error in detectLines:", err);
      if (!this.cachedLines || this.cachedLines.length === 0) {
        const height = this.manualHeight || 36;
        this.cachedLines = [{
          top: 150,
          bottom: 150 + height,
          left: 40,
          right: window.innerWidth - 40,
          height,
          centerY: 150 + height / 2,
          hasText: true,
          columnIndex: 0,
          columnLeft: 40,
          columnWidth: window.innerWidth - 80,
          columnRight: window.innerWidth - 40
        }];
      }
      return this.cachedLines;
    }
  }

  refreshLines() {
    return this.detectLines();
  }

  /**
   * Zmapuje přesné obdélníky všech viditelných slov na aktuální stránce.
   */
  refreshWords() {
    if (this.isPdfMode) {
      this.cachedWords = [];
      return [];
    }
    try {
      const stage = this.container || document.getElementById("paged-stage");
      const content = document.getElementById("reader-content");
      if (!stage || !content) {
        this.cachedWords = [];
        return [];
      }

      const stageRect = stage.getBoundingClientRect();
      const stageLeft = stageRect.left;
      const stageRight = stageRect.right;
      const stageTop = stageRect.top;
      const stageBottom = stageRect.bottom;

      const words = [];
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null, false);
      let node;
      const range = document.createRange();
      // Podpora všech unicode mezer, nezlomitelných mezer i neviditelných dělicích znaků
      const wordRegex = /[^\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF\u2060]+/g;
      const invisibleStripRegex = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;

      const visitedBionicSpans = new Set();
      while ((node = walker.nextNode())) {
        if (node.parentElement) {
          const parentTag = node.parentElement.tagName;
          if (parentTag === 'SCRIPT' || parentTag === 'STYLE') continue;
          if (node.parentElement.closest('svg, audio, video')) continue;
        }

        const bionicSpan = node.parentElement ? node.parentElement.closest('.bionic-word') : null;
        if (bionicSpan) {
          if (visitedBionicSpans.has(bionicSpan)) continue;
          visitedBionicSpans.add(bionicSpan);

          const rawToken = bionicSpan.textContent;
          const cleanToken = rawToken.replace(invisibleStripRegex, "").trim();
          if (!cleanToken) continue;

          try {
            range.selectNodeContents(bionicSpan);
            const clientRects = range.getClientRects();
            if (!clientRects || clientRects.length === 0) continue;

            const subRects = [];
            for (let rIdx = 0; rIdx < clientRects.length; rIdx++) {
              const rect = clientRects[rIdx];
              if (
                rect.width > 0.5 &&
                rect.height > 2 &&
                rect.right > stageLeft &&
                rect.left < stageRight &&
                rect.bottom > stageTop - 40 &&
                rect.top < stageBottom + 40
              ) {
                subRects.push(rect);
              }
            }

            if (subRects.length === 0) continue;

            if (subRects.length > 1) {
              subRects.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            }

            const lineMergedRects = [];
            for (let sIdx = 0; sIdx < subRects.length; sIdx++) {
              const r = subRects[sIdx];
              if (lineMergedRects.length === 0) {
                lineMergedRects.push({
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                  width: r.width,
                  height: r.height
                });
              } else {
                const prevR = lineMergedRects[lineMergedRects.length - 1];
                const prevCenterY = (prevR.top + prevR.bottom) / 2;
                const rCenterY = (r.top + r.bottom) / 2;
                if (Math.abs(rCenterY - prevCenterY) <= 8 || Math.abs(r.top - prevR.top) <= 6) {
                  prevR.left = Math.min(prevR.left, r.left);
                  prevR.top = Math.min(prevR.top, r.top);
                  prevR.right = Math.max(prevR.right, r.right);
                  prevR.bottom = Math.max(prevR.bottom, r.bottom);
                  prevR.width = prevR.right - prevR.left;
                  prevR.height = prevR.bottom - prevR.top;
                } else {
                  lineMergedRects.push({
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                    width: r.width,
                    height: r.height
                  });
                }
              }
            }

            for (let sIdx = 0; sIdx < lineMergedRects.length; sIdx++) {
              const r = lineMergedRects[sIdx];
              words.push({
                text: cleanToken,
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
                centerX: r.left + r.width / 2,
                centerY: r.top + r.height / 2
              });
            }
          } catch (e) {
            // Ignore range errors
          }
          continue;
        }

        const text = node.textContent;
        if (!text || !text.trim()) continue;

        let match;
        wordRegex.lastIndex = 0;
        while ((match = wordRegex.exec(text)) !== null) {
          const rawToken = match[0];
          const cleanToken = rawToken.replace(invisibleStripRegex, "").trim();
          if (!cleanToken) continue;

          const start = match.index;
          const end = start + rawToken.length;
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
            const clientRects = range.getClientRects();
            if (!clientRects || clientRects.length === 0) continue;

            // Extrahujeme všechny validní bounding boxy viditelné na aktuální stránce/sloupci
            const subRects = [];
            for (let rIdx = 0; rIdx < clientRects.length; rIdx++) {
              const rect = clientRects[rIdx];
              if (
                rect.width > 0.5 &&
                rect.height > 2 &&
                rect.right > stageLeft &&
                rect.left < stageRight &&
                rect.bottom > stageTop - 40 &&
                rect.top < stageBottom + 40
              ) {
                subRects.push(rect);
              }
            }

            if (subRects.length === 0) continue;

            // Pouze v rámci jednoho rozděleného slova seřadíme jeho části shora dolů (řádek 1 před řádkem 2)
            if (subRects.length > 1) {
              subRects.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            }

            // Sloučíme fragmenty na stejném řádku (např. slovo a připojený spojovník / hyphen)
            const lineMergedRects = [];
            for (let sIdx = 0; sIdx < subRects.length; sIdx++) {
              const r = subRects[sIdx];
              if (lineMergedRects.length === 0) {
                lineMergedRects.push({
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                  width: r.width,
                  height: r.height
                });
              } else {
                const prevR = lineMergedRects[lineMergedRects.length - 1];
                const prevCenterY = (prevR.top + prevR.bottom) / 2;
                const rCenterY = (r.top + r.bottom) / 2;
                if (Math.abs(rCenterY - prevCenterY) <= 8 || Math.abs(r.top - prevR.top) <= 6) {
                  prevR.left = Math.min(prevR.left, r.left);
                  prevR.top = Math.min(prevR.top, r.top);
                  prevR.right = Math.max(prevR.right, r.right);
                  prevR.bottom = Math.max(prevR.bottom, r.bottom);
                  prevR.width = prevR.right - prevR.left;
                  prevR.height = prevR.bottom - prevR.top;
                } else {
                  lineMergedRects.push({
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                    width: r.width,
                    height: r.height
                  });
                }
              }
            }

            for (let sIdx = 0; sIdx < lineMergedRects.length; sIdx++) {
              const r = lineMergedRects[sIdx];
              words.push({
                text: cleanToken,
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
                centerX: r.left + r.width / 2,
                centerY: r.top + r.height / 2
              });
            }
          } catch (e) {}
        }
      }

      // Sloučení bezprostředně navazujících spojovníků / pomlček a vyřazení samostatných interpunkčních cílů
      const punctOnlyRegex = /^[-\u2010\u00AD—–.,;!?]+$/;
      const mergedWords = [];

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const isPunctOnly = punctOnlyRegex.test(w.text);

        if (isPunctOnly) {
          if (mergedWords.length > 0) {
            const prev = mergedWords[mergedWords.length - 1];
            const sameLine = Math.abs(w.centerY - prev.centerY) <= 8 || Math.abs(w.top - prev.top) <= 6;
            const maxGap = 5; // Bezprostředně navazující znak bez mezery
            const isAdjacent = w.left >= prev.left - 2 && (w.left - prev.right) <= maxGap;
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
          // Samostatná interpunkce / spojovníky se zahodí
          continue;
        }

        mergedWords.push(w);
      }

      const finalWords = mergedWords;

      if (this.cachedLines.length === 0) {
        this.detectLines();
      }

      if (this.cachedLines.length > 0) {
        const stage = this.container || document.getElementById("paged-stage");
        const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, width: window.innerWidth };
        const stageCenterX = stageRect.left + stageRect.width / 2;
        const isTwoCol = this.isTwoCol;

        for (const w of finalWords) {
          let bestIdx = 0;
          let minDiff = Infinity;
          const isWordCol1 = isTwoCol && (w.centerX >= stageCenterX);
          for (let j = 0; j < this.cachedLines.length; j++) {
            const line = this.cachedLines[j];
            if (line.isMedia) continue;
            if (isTwoCol && (line.columnIndex === 1) !== isWordCol1) {
              continue;
            }
            const diff = Math.abs(w.centerY - line.centerY);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = j;
            }
          }
          w.lineIndex = bestIdx;
        }
      } else {
        let currentLine = 0;
        let lastCenterY = null;
        for (const w of finalWords) {
          if (lastCenterY !== null && Math.abs(w.centerY - lastCenterY) > 8) {
            currentLine++;
          }
          w.lineIndex = currentLine;
          lastCenterY = w.centerY;
        }
      }

      this.cachedWords = finalWords;
      return this.cachedWords;
    } catch (err) {
      console.error("[ReadingRuler] Error in refreshWords:", err);
      this.cachedWords = [];
      return [];
    }
  }

  computeLineGeometry(lineIdx) {
    if (!this.cachedLines || this.cachedLines.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(this.cachedLines.length - 1, lineIdx));
    const line = this.cachedLines[clampedIdx];

    if (line.isMedia) {
      const mediaH = Math.round(line.rect?.height ?? line.height ?? (line.bottom - line.top) ?? 100);
      const mediaW = Math.round(line.rect?.width ?? line.width ?? (line.right - line.left) ?? (line.columnWidth || 200));
      const mediaTop = Math.round(line.rect?.top ?? line.top);
      const mediaLeft = Math.round(line.rect?.left ?? line.left);
      return {
        height: mediaH,
        targetY: mediaTop,
        left: mediaLeft,
        width: mediaW,
        columnLeft: mediaLeft,
        columnWidth: mediaW,
        columnRight: mediaLeft + mediaW,
        colBoundaryLeft: mediaLeft,
        colBoundaryRight: mediaLeft + mediaW,
        columnIndex: line.columnIndex ?? 0,
        isMedia: true,
        element: line.element
      };
    }

    let height = Math.round((this.autoHeight && Number.isFinite(this.height) && this.height > 0)
      ? this.height
      : (this.manualHeight || 36));

    // Kontrola sousedních řádků ve stejném sloupci pro zamezení přesahu do řádku nahoře i dole
    const prevLine = clampedIdx > 0 ? this.cachedLines[clampedIdx - 1] : null;
    const nextLine = clampedIdx < this.cachedLines.length - 1 ? this.cachedLines[clampedIdx + 1] : null;

    let maxLineH = Infinity;
    if (prevLine && prevLine.columnIndex === line.columnIndex) {
      const distPrev = line.centerY - prevLine.centerY;
      if (distPrev > 8) maxLineH = Math.min(maxLineH, distPrev - 2);
    }
    if (nextLine && nextLine.columnIndex === line.columnIndex) {
      const distNext = nextLine.centerY - line.centerY;
      if (distNext > 8) maxLineH = Math.min(maxLineH, distNext - 2);
    }

    if (Number.isFinite(maxLineH) && maxLineH > 10) {
      height = Math.min(height, Math.round(maxLineH));
    }

    let targetY = Math.round(line.centerY - height / 2);
    if (prevLine && prevLine.columnIndex === line.columnIndex && Number.isFinite(prevLine.bottom)) {
      if (targetY <= prevLine.bottom) {
        targetY = Math.round(prevLine.bottom + 1);
      }
    }
    if (nextLine && nextLine.columnIndex === line.columnIndex && Number.isFinite(nextLine.top)) {
      if (targetY + height >= nextLine.top) {
        height = Math.max(10, Math.round(nextLine.top - 1 - targetY));
      }
    }

    const left = line.columnLeft ?? line.left ?? (line.columnIndex === 1 ? this.column1Left : this.column0Left) ?? this.textBlockLeft ?? 0;
    const width = line.columnWidth ?? line.width ?? (line.columnIndex === 1 ? this.column1Width : this.column0Width) ?? this.textBlockWidth ?? 200;

    return {
      height,
      targetY,
      left,
      width,
      columnLeft: left,
      columnWidth: width,
      columnRight: left + width,
      colBoundaryLeft: line.colBoundaryLeft ?? left,
      colBoundaryRight: line.colBoundaryRight ?? (left + width),
      columnIndex: line.columnIndex ?? 0
    };
  }

  updateEffectiveHeight(lineHeight) {
    if (this.isPdfMode) {
      this.height = this.pdfRulerHeight || 32;
      this.applyPosition();
      return;
    }
    if (this.autoHeight) {
      const baseH = Math.round(lineHeight || 32);
      const padV = Math.max(0, Math.min(2, Math.round(baseH * 0.05)));
      this.height = Math.round(baseH + (2 * padV));
    } else {
      this.height = this.manualHeight;
    }
    this.applyPosition();
  }

  /**
   * Vyhodnotí index řádku podle typu ukazatele:
   * - Pro Apple Pencil (pointerType === 'pen') v režimu sledování myši:
   *   1. Calibration Window pro aktivní řádek N:
   *      - Pravítko je uzamčené na řádku N, pokud se fyzické e.clientY nachází v rozsahu:
   *        Min Y: lineN.top + (lineN.height * 0.5) (vertikální střed řádku N)
   *        Max Y: lineNext.top + (lineNext.height * 0.5) (vertikální střed řádku N+1)
   *      - Včetně inter-line mezery mezi řádky N a N+1.
   *   2. Přepínací prahy (Switching Thresholds):
   *      - Pohyb DOLŮ: Přeskok na řádek N+1 nastane POUZE tehdy, když e.clientY překročí střed řádku N+1.
   *      - Pohyb NAHORU: Návrat na řádek N-1 okamžitě, když e.clientY vystoupá nad střed řádku N.
   *   3. Ochrana okrajů (First & Last Line Safeguards):
   *      - Pokud je e.clientY nad středem řádku 0, zůstane uzamčeno na řádku 0.
   *      - Pokud je e.clientY pod středem posledního řádku, zůstane uzamčeno na posledním řádku.
   * - Pro myš (pointerType === 'mouse'): standardní přímé přichytávání centrované přímo na kurzor bez zkreslení.
   */
  getHysteresisLineIndex(curY, isPen = false, activeColumn = null) {
    if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
      return this.activeLineIndex >= 0 ? this.activeLineIndex : 0;
    }
    if (this.cachedLines.length === 0) {
      this.refreshLines();
    }
    if (this.cachedLines.length === 0) return 0;

    // Filtrování řádků podle aktivního sloupce
    const candidates = [];
    for (let i = 0; i < this.cachedLines.length; i++) {
      const l = this.cachedLines[i];
      if (activeColumn === null || l.columnIndex === activeColumn) {
        candidates.push({ line: l, index: i });
      }
    }

    const pool = candidates.length > 0 ? candidates : this.cachedLines.map((l, i) => ({ line: l, index: i }));
    const firstItem = pool[0];
    const lastItem = pool[pool.length - 1];

    // Ochrana prázdných ploch: pokud je kurzor příliš daleko mimo textové řádky sloupce, vrátit -1 (skrýt pravítko)
    if (curY < firstItem.line.top - 60 || curY > lastItem.line.bottom + 60) {
      return -1;
    }

    if (curY <= firstItem.line.top) {
      return firstItem.index;
    }
    if (curY >= lastItem.line.bottom) {
      return lastItem.index;
    }

    // 4. Pointer Isolation: Pro myš (pointerType === 'mouse') standardní přímé přichytávání bez zkreslení
    if (!isPen || this.followMode !== "mouse") {
      let minDiff = Infinity;
      let closestIdx = pool[0].index;
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const line = item.line;
        const dy = curY < line.top ? line.top - curY : curY > line.bottom ? curY - line.bottom : 0;
        const diff = dy * 2 + Math.abs(curY - line.centerY);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = item.index;
        }
      }
      return closestIdx;
    }

    // 1., 2. & 3. Calibration Window & Switching Thresholds pro Apple Pencil (pointerType === 'pen'):
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

    const currentLine = pool[activeInPool].line;
    const nextLine = activeInPool < pool.length - 1 ? pool[activeInPool + 1].line : null;

    // Hranice pro přeskok dolů na následující řádek: vertikální střed řádku N + 1
    const downThreshold = nextLine ? (nextLine.top + nextLine.height * 0.5) : Infinity;
    // Hranice pro návrat nahoru na předchozí řádek: vertikální střed aktuálního řádku N
    const upThreshold = currentLine.top + currentLine.height * 0.5;

    if (curY > downThreshold) {
      let newPoolIdx = activeInPool + 1;
      while (newPoolIdx < pool.length - 1) {
        const next = pool[newPoolIdx + 1].line;
        if (curY > next.top + next.height * 0.5) {
          newPoolIdx++;
        } else {
          break;
        }
      }
      return pool[newPoolIdx].index;
    } else if (curY < upThreshold) {
      // 3. First Line Safeguard: Pokud je e.clientY nad středem řádku 0, zůstává uzamčeno na řádku 0
      if (activeInPool === 0) return pool[0].index;
      let newPoolIdx = activeInPool - 1;
      while (newPoolIdx > 0) {
        const prev = pool[newPoolIdx].line;
        if (curY < prev.top + prev.height * 0.5) {
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
    if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
    this.disableWordTransition();

    // Displacement / Delta Threshold Sanity Check:
    // Pokud probíhá aktivní tažení s předchozí platnou souřadnicí, zachytíme anomální skok (např. dotyk dlaně nebo teleport).
    if (this.isDraggingRuler && this.lastValidPointerY !== null && clientY != null) {
      const dy = Math.abs(clientY - this.lastValidPointerY);
      const dx = clientX != null && this.lastValidPointerX !== null ? Math.abs(clientX - this.lastValidPointerX) : 0;
      if (dy > 160 || dx > 220) {
        // Anomální skok v jednom snímku – ignorovat, aby nedošlo k odteleportování pravítka
        return;
      }
    }

    if (clientX != null) {
      this.lastPointerX = clientX;
      this.lastValidPointerX = clientX;
    }
    if (clientY != null) {
      this.lastPointerY = clientY;
      this.lastValidPointerY = clientY;
    }

    const pType = pointerType || this.activePointerType || (Date.now() - this.lastPenTime < 500 ? "pen" : "mouse");
    if (pointerType) {
      this.activePointerType = pointerType;
    }
    const isPen = pType === "pen";

    const curX = this.lastPointerX;
    const curY = this.lastPointerY;

    if (this.isPdfMode) {
      const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
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
      const h = this.height || 32;
      const targetY = (curY != null ? curY : (topBound + 50)) - h / 2;
      this.currentY = Math.max(topBound, Math.min(bottomBound - h, targetY));
      this.targetY = this.currentY;
      this.applyPosition();
      return;
    }

    if (this.cachedLines.length === 0) {
      this.refreshLines();
    }

    const stage = document.getElementById("paged-stage") || this.container || document.body;
    const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    const stageCenterX = stageRect.left + stageRect.width / 2;
    const isTwoCol = this.checkTwoColumnLayout(document.getElementById("reader-content"), stageRect) || this.isTwoCol;
    if (isTwoCol !== this.isTwoCol) {
      this.isTwoCol = isTwoCol;
    }
    const splitX = (this.isTwoCol && this.gapMiddle) ? this.gapMiddle : stageCenterX;
    const activeColumn = this.isTwoCol ? ((curX >= splitX) ? 1 : 0) : 0;

    // --- REŽIM SLEDOVÁNÍ SLOV (Word-level Tracking) ---
    if (this.wordTracking) {
      if (this.cachedWords.length === 0) {
        this.refreshWords();
      }

      if (this.cachedWords.length > 0) {
        const targetLineIdx = this.getHysteresisLineIndex(curY, isPen, activeColumn);
        if (targetLineIdx < 0) {
          this.rulerEl.classList.remove("is-visible");
          this.rulerEl.style.display = "none";
          this.maskTopEl.style.display = "none";
          this.maskBottomEl.style.display = "none";
          this.maskLeftEl.style.display = "none";
          this.maskRightEl.style.display = "none";
          return;
        }
        this.activeLineIndex = targetLineIdx;
        const activeLine = (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) ? this.cachedLines[targetLineIdx] : null;

        if (activeLine && activeLine.isMedia) {
          this.rulerEl.classList.remove("word-tracking-mode");
          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          this.lastPointerX = curX;
          this.lastPointerY = curY;
          this.rulerEl.classList.add("is-snapped");
          this.applyPosition();
          return;
        }

        let closestWord = null;
        let closestIdx = -1;
        let minDiff = Infinity;

        // Přednostně vyhledáme slovo na aktuálním hysterezním řádku
        for (let i = 0; i < this.cachedWords.length; i++) {
          const w = this.cachedWords[i];
          const isLineMatch = (w.lineIndex != null && w.lineIndex === targetLineIdx);
          const dy = curY < w.top ? w.top - curY : curY > w.bottom ? curY - w.bottom : 0;
          const dx = curX < w.left ? w.left - curX : curX > w.right ? curX - w.right : 0;
          const linePenalty = isLineMatch ? 0 : 100;
          const dist = dy * 3 + dx + linePenalty;
          if (dist < minDiff) {
            minDiff = dist;
            closestWord = w;
            closestIdx = i;
          }
        }

        if (!closestWord && this.cachedWords.length > 0) {
          closestWord = this.cachedWords[0];
          closestIdx = 0;
        }

        this.setWordWindow(closestIdx);

        // V režimu sledování myši (mouse-follow) zajistit plynulý spojitý horizontální pohyb bez magnetického přichytávání a bez trhání zpět
        if (this.followMode === "mouse") {
          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }
          const padX = 3;
          const activeLine = (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) ? this.cachedLines[targetLineIdx] : null;
          const lineWords = [];

          // Primary pass: collect words by lineIndex
          for (let i = 0; i < this.cachedWords.length; i++) {
            if (this.cachedWords[i].lineIndex === targetLineIdx) {
              lineWords.push({ word: this.cachedWords[i], index: i });
            }
          }

          // Fallback: if lineWords is sparse (< 2 words) and activeLine has a known centerY,
          // add words by Y-proximity (within ±10px of line centerY) that aren't already included.
          // This recovers words whose lineIndex was misassigned due to sub-pixel Y differences.
          if (lineWords.length < 2 && activeLine && activeLine.centerY != null) {
            const lineCY = activeLine.centerY;
            const includedIndices = new Set(lineWords.map(lw => lw.index));
            for (let i = 0; i < this.cachedWords.length; i++) {
              if (includedIndices.has(i)) continue;
              const cw = this.cachedWords[i];
              if (Math.abs(cw.centerY - lineCY) <= 10) {
                lineWords.push({ word: cw, index: i });
              }
            }
            lineWords.sort((a, b) => a.word.left - b.word.left);
          }

          // Compute true horizontal text bounds for this line from all matching words
          let textMinX = activeLine && activeLine.left != null ? Math.round(activeLine.left - padX) : 0;
          let textMaxX = activeLine && activeLine.right != null ? Math.round(activeLine.right + padX) : window.innerWidth;
          if (lineWords.length > 0) {
            textMinX = Math.round(lineWords[0].word.left - padX);
            textMaxX = Math.round(lineWords[lineWords.length - 1].word.right + padX);
          }

          const computeWordPreview = (wIdx) => {
            if (wIdx < 0 || wIdx >= this.cachedWords.length) return 0;
            const w = this.cachedWords[wIdx];
            const firstW = Math.round(w.width + padX * 2);
            let nextWLast = null;
            // Compare each candidate's left against the PREVIOUS word (not always w.left),
            // so rightward words on the same line are not cut off past the screen midpoint.
            let prevCandLeft = w.left;
            for (let offset = 1; offset <= 2; offset++) {
              const nextIdx = wIdx + offset;
              if (nextIdx >= this.cachedWords.length) break;
              const nw = this.cachedWords[nextIdx];
              const isSameLine = (nw.lineIndex != null && w.lineIndex != null)
                ? (nw.lineIndex === w.lineIndex)
                : (Math.abs(nw.centerY - w.centerY) <= 10);
              if (!isSameLine || nw.left <= prevCandLeft) break;
              prevCandLeft = nw.left;
              nextWLast = nw;
            }
            if (!nextWLast) return 0;
            // Use the true right boundary of this word's line from cachedWords (not the outer
            // textMaxX which is derived from lineWords and may be incomplete in 1-col mode).
            let trueLineRight = textMaxX;
            if (w.lineIndex != null) {
              for (let i = wIdx; i < this.cachedWords.length; i++) {
                const cw = this.cachedWords[i];
                const isSame = (cw.lineIndex != null)
                  ? (cw.lineIndex === w.lineIndex)
                  : (Math.abs(cw.centerY - w.centerY) <= 10);
                if (!isSame) break;
                trueLineRight = Math.max(trueLineRight, Math.round(cw.right + padX));
              }
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
            if (curX <= lineWords[0].word.centerX) {
              const firstItem = lineWords[0];
              continuousLeft = Math.round(firstItem.word.left - padX + (curX - firstItem.word.centerX));
              continuousWidth = Math.round(firstItem.word.width + padX * 2);
              previewW = computeWordPreview(firstItem.index);
              this.activeWordIndex = firstItem.index;
            } else if (curX >= lineWords[lineWords.length - 1].word.centerX) {
              const lastItem = lineWords[lineWords.length - 1];
              continuousLeft = Math.round(lastItem.word.left - padX + (curX - lastItem.word.centerX));
              continuousWidth = Math.round(lastItem.word.width + padX * 2);
              previewW = computeWordPreview(lastItem.index);
              this.activeWordIndex = lastItem.index;
            } else {
              // Najdeme dvojici sousedních slov, mezi jejichž středy se curX nachází
              let segIdx = 0;
              for (let k = 0; k < lineWords.length - 1; k++) {
                if (curX >= lineWords[k].word.centerX && curX <= lineWords[k + 1].word.centerX) {
                  segIdx = k;
                  break;
                }
              }
              const itemA = lineWords[segIdx];
              const itemB = lineWords[segIdx + 1];
              const dx = itemB.word.centerX - itemA.word.centerX;
              const t = dx > 0 ? (curX - itemA.word.centerX) / dx : 0;
              const clampedT = Math.max(0, Math.min(1, t));

              const leftA = itemA.word.left - padX;
              const leftB = itemB.word.left - padX;
              continuousLeft = Math.round(leftA + clampedT * (leftB - leftA));

              const widthA = itemA.word.width + padX * 2;
              const widthB = itemB.word.width + padX * 2;
              continuousWidth = Math.round(widthA + clampedT * (widthB - widthA));

              const prevA = computeWordPreview(itemA.index);
              const prevB = computeWordPreview(itemB.index);
              previewW = Math.round(prevA + clampedT * (prevB - prevA));

              this.activeWordIndex = (clampedT < 0.5) ? itemA.index : itemB.index;
            }
          } else {
            continuousLeft = Math.round(curX - this.activeWordWidth / 2);
            continuousWidth = this.activeWordWidth;
          }

          this.activeWordWidth = continuousWidth;
          this.totalWidth = continuousWidth + previewW;
          this.wordWidth = this.totalWidth;
          this.previewWidth = previewW;

          // Omezení horizontální pozice striktně na hranice viditelného textu (zamezení plovutí do prázdného místa)
          const clampedMax = Math.max(textMinX, textMaxX - this.totalWidth);
          this.wordLeft = Math.round(Math.max(textMinX, Math.min(clampedMax, continuousLeft)));
          this.previewLeft = this.wordLeft + continuousWidth;

          const firstWordRatio = Math.min(1, Math.max(0.15, continuousWidth / this.totalWidth));
          this.firstWordRatio = firstWordRatio;
          if (this.rulerEl) {
            this.rulerEl.style.setProperty('--word-solid-ratio', `${(firstWordRatio * 100).toFixed(1)}%`);
          }
        }

        this.rulerEl.classList.add("word-tracking-mode");
        if (this.followMode === "mouse") {
          this.rulerEl.classList.remove("is-snapped");
          this.maskTopEl.classList.remove("is-snapped");
          this.maskBottomEl.classList.remove("is-snapped");
          this.maskLeftEl.classList.remove("is-snapped");
          this.maskRightEl.classList.remove("is-snapped");
        } else {
          this.rulerEl.classList.add("is-snapped");
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
        this.maskTopEl.style.display = "none";
        this.maskBottomEl.style.display = "none";
        this.maskLeftEl.style.display = "none";
        this.maskRightEl.style.display = "none";
        return;
      }
      this.activeLineIndex = targetLineIdx;
      const closestLine = this.cachedLines[targetLineIdx];

      if (this.cachedWords.length > 0) {
        let closestWordIdx = 0;
        let minWordDiff = Infinity;
        for (let j = 0; j < this.cachedWords.length; j++) {
          const w = this.cachedWords[j];
          const wDiff = Math.abs(closestLine.centerY - w.centerY) * 3 + Math.abs(curX - w.centerX);
          if (wDiff < minWordDiff) {
            minWordDiff = wDiff;
            closestWordIdx = j;
          }
        }
        this.activeWordIndex = closestWordIdx;
      }

      const geom = this.computeLineGeometry(targetLineIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
      }

      this.currentY = this.targetY;
      if (this.followMode === "mouse") {
        this.rulerEl.classList.remove("is-snapped");
        this.maskTopEl.classList.remove("is-snapped");
        this.maskBottomEl.classList.remove("is-snapped");
        this.maskLeftEl.classList.remove("is-snapped");
        this.maskRightEl.classList.remove("is-snapped");
      } else {
        this.rulerEl.classList.add("is-snapped");
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

  /**
   * Nastaví geometrii asymetrického čtecího okna pro režim slov:
   * - Cílové slovo (activeWordWidth): plný kontrast bez vnitřního vyblednutí
   * - Dopředný náhled: plynulé lineární doznívání pokrývající 1.5–2 následující slova na témže řádku
   * - Celková šířka (totalWidth) ořezána striktně podle pravého okraje aktuálního řádku
   */
  setWordWindow(wordIndex) {
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
    const padX = 3;
    const padY = 1.5;

    this.wordLeft = Math.round(w0.left - padX);
    const firstWordWidth = Math.round(w0.width + padX * 2);
    this.activeWordWidth = firstWordWidth;

    if (this.autoHeight) {
      const baseH = Math.round(w0.height);
      this.height = Math.round(baseH + padY * 2);
    }

    this.targetY = Math.round(w0.top - padY);
    this.currentY = this.targetY;

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
    const elements = [this.rulerEl, this.maskTopEl, this.maskBottomEl, this.maskLeftEl, this.maskRightEl];
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
  resetPositionForPage(direction = 1, immediate = true) {
    const stage = this.getStageElement();
    if (stage) stage.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");
    const content = document.getElementById("reader-content");
    if (content) content.classList.add("is-turning-page");

    this.hideForPageTransition();
    this.disableWordTransition();
    this.setNoTransition(true);
    this.previousActiveLineIndex = -1;
    if (this.rulerEl) {
      this.rulerEl.style.transition = "none";
    }

    if (this.lineLockTimer) {
      clearTimeout(this.lineLockTimer);
      this.lineLockTimer = null;
    }
    this.isLineLocked = true;

    if (this.navigatingPageTimer) {
      clearTimeout(this.navigatingPageTimer);
    }
    this.isNavigating = true;
    this.isNavigatingPage = true;
    this.navigatingPageLockoutEndTime = Date.now() + 250;
    this.navigatingPageTimer = setTimeout(() => {
      this.isNavigating = false;
      this.isNavigatingPage = false;
      this.navigatingPageTimer = null;
    }, 250);

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.suppressLineAdvancement = false;
        if (stage) stage.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (content) content.classList.remove("is-turning-page");
      }
    }, 300); // 300ms maximum lock lifetime

    const isBackward = direction < 0;

    if (this.pageChangeRafId) {
      cancelAnimationFrame(this.pageChangeRafId);
      this.pageChangeRafId = null;
    }

    const performReset = () => {
      if (!this.enabled) {
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.isPageTransitioning = false;
        if (stage) stage.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (content) content.classList.remove("is-turning-page");
        return;
      }

      try {
        if (this.isPdfMode) {
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
            this.rulerEl.classList.remove("is-page-transitioning");
          }
          this.applyPosition();
          return;
        }

        this.refreshLines();
        if (this.wordTracking) {
          this.refreshWords();
        }

        // Fallback ochrana: Pokud na stránce není detekován žádný řádek, pravítko zůstane skryté
        if (this.cachedLines.length === 0) {
          this.isPageTransitioning = false;
          if (this.rulerEl) {
            this.rulerEl.style.display = "none";
            this.rulerEl.style.opacity = "0";
            this.rulerEl.style.visibility = "hidden";
            this.rulerEl.classList.remove("is-visible");
            this.rulerEl.classList.add("is-hidden");
          }
          if (this.mode !== "focus") {
            this.clearFocusTextMask();
          }
          return;
        }

        if (this.wordTracking) {
          if (this.cachedWords.length > 0) {
            const targetWordIdx = isBackward ? this.cachedWords.length - 1 : 0;
            this.activeWordIndex = targetWordIdx;
            const targetWord = this.cachedWords[targetWordIdx];

            if (targetWord && targetWord.lineIndex != null) {
              this.activeLineIndex = targetWord.lineIndex;
            } else {
              this.activeLineIndex = isBackward ? this.cachedLines.length - 1 : 0;
            }

            this.setWordWindow(targetWordIdx);
            this.lastPointerX = targetWord.centerX;
            this.lastPointerY = targetWord.centerY;
            this.lastValidPointerX = targetWord.centerX;
            this.lastValidPointerY = targetWord.centerY;

            this.rulerEl.classList.add("word-tracking-mode", "is-snapped");
            this.maskTopEl.classList.add("is-snapped");
            this.maskBottomEl.classList.add("is-snapped");
            this.maskLeftEl.classList.add("is-snapped");
            this.maskRightEl.classList.add("is-snapped");

            // Atomické usazení: nejprve aplikujeme přesné souřadnice skrytému elementu
            this.applyPosition();
            void this.rulerEl.offsetWidth; // Vynutí layout pro eliminaci skoku

            // Až po usazení na skutečný řádek vrátíme viditelnost
            this.isPageTransitioning = false;
            this.rulerEl.classList.remove("is-page-transitioning");
            this.applyPosition();
          } else {
            this.activeLineIndex = isBackward ? this.cachedLines.length - 1 : 0;
            this.rulerEl.classList.remove("word-tracking-mode");
            const geom = this.computeLineGeometry(this.activeLineIndex);
            if (geom) {
              this.height = geom.height;
              this.targetY = geom.targetY;
              this.currentY = this.targetY;
            }
            this.applyPosition();
            void this.rulerEl.offsetWidth;

            this.isPageTransitioning = false;
            this.rulerEl.classList.remove("is-page-transitioning");
            this.applyPosition();
          }
        } else {
          const targetLineIdx = isBackward ? this.cachedLines.length - 1 : 0;
          this.activeLineIndex = targetLineIdx;

          if (this.cachedWords.length > 0) {
            if (isBackward) {
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

          this.rulerEl.classList.remove("word-tracking-mode");
          const geom = this.computeLineGeometry(targetLineIdx);
          if (geom) {
            this.height = geom.height;
            this.targetY = geom.targetY;
            this.currentY = this.targetY;
          }

          const line = this.cachedLines[targetLineIdx];
          this.lastPointerX = line.left != null ? line.left : 100;
          this.lastPointerY = line.centerY;
          this.lastValidPointerX = this.lastPointerX;
          this.lastValidPointerY = this.lastPointerY;

          this.rulerEl.classList.add("is-snapped");
          this.maskTopEl.classList.add("is-snapped");
          this.maskBottomEl.classList.add("is-snapped");
          this.maskLeftEl.classList.add("is-snapped");
          this.maskRightEl.classList.add("is-snapped");

          // Atomické usazení: nejprve aplikujeme přesné souřadnice skrytému elementu
          this.applyPosition();
          void this.rulerEl.offsetWidth; // Vynutí layout před zobrazením

          // Až po usazení na skutečný řádek vrátíme viditelnost
          this.isPageTransitioning = false;
          this.rulerEl.classList.remove("is-page-transitioning");
          this.applyPosition();
        }
      } catch (err) {
        console.error("[ReadingRuler] Error in resetPositionForPage:", err);
      } finally {
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.suppressLineAdvancement = false;
        if (this.lineLockTimer) {
          clearTimeout(this.lineLockTimer);
          this.lineLockTimer = null;
        }
      }

      requestAnimationFrame(() => {
        if (stage) stage.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (content) content.classList.remove("is-turning-page");
        this.setNoTransition(false);
      });
    };

    if (immediate) {
      performReset();
    } else {
      this.pageChangeRafId = requestAnimationFrame(() => {
        this.pageChangeRafId = null;
        performReset();
      });
    }
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
    if (!this.enabled || this.isLineLocked || this.followMode !== "keyboard") return false;
    if (this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return false;
    if (pointerType !== "touch" && pointerType !== "mouse") return false;
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

    const dir = this.getTapDirection(clientX, clientY);
    this.stepLine(dir, true);
    return true;
  }

  /**
   * Posun o jeden řádek nebo slovo (krokování tlačítky na iPadu či šipkami)
   */
  stepLine(direction, force = false) {
    // Pokud probíhá přechod strany, aktivní tažení nebo dobíhá lockout přechodu strany, ignorovat krokování
    if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
    if (direction > 0 && (this.suppressLineAdvancement || (performance.now() - this.pageTurnTimestamp < 350))) {
      return;
    }
    if (!force && this.isInteracting()) return;
    this.cancelHold();

    try {
      if (this.isPdfMode) {
        const stepSize = this.height || 32;
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
        const minY = Math.round(topBound);
        const maxY = Math.round(bottomBound - (this.height || 32));

        let nextY = (Number.isFinite(this.currentY) ? this.currentY : minY) + direction * stepSize;
        if (direction > 0 && nextY > maxY) {
          if (this.onBoundary) {
            this.lockAdvancement(350);
            this.onBoundary(1);
            return;
          }
          nextY = maxY;
        } else if (direction < 0 && nextY < minY) {
          if (this.onBoundary) {
            this.onBoundary(-1);
            return;
          }
          nextY = minY;
        }
        this.currentY = nextY;
        this.targetY = nextY;
        this.applyPosition();
        return;
      }

      if (this.wordTracking) {
        if (this.isWordTransitioning) {
          if (this.wordTransitionTimer) {
            clearTimeout(this.wordTransitionTimer);
            this.wordTransitionTimer = null;
          }
          this.isWordTransitioning = false;
          this.disableWordTransition();
        }

        const currentActiveLine = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
          ? this.cachedLines[this.activeLineIndex]
          : null;
        if (currentActiveLine && currentActiveLine.isMedia) {
          const nextLineIdx = this.activeLineIndex + direction;
          if (direction > 0 && nextLineIdx >= this.cachedLines.length) {
            if (this.onBoundary) {
              this.lockAdvancement(350);
              this.onBoundary(1);
              return;
            }
          } else if (direction < 0 && nextLineIdx < 0) {
            if (this.onBoundary) {
              this.onBoundary(-1);
              return;
            }
          } else if (nextLineIdx >= 0 && nextLineIdx < this.cachedLines.length) {
            const nextTarget = this.cachedLines[nextLineIdx];
            if (nextTarget.isMedia) {
              this.activeLineIndex = nextLineIdx;
              this.rulerEl.classList.remove("word-tracking-mode");
              const geom = this.computeLineGeometry(nextLineIdx);
              if (geom) {
                this.height = geom.height;
                this.targetY = geom.targetY;
                this.currentY = this.targetY;
              }
              this.rulerEl.classList.add("is-snapped");
              this.applyPosition();
              return;
            } else {
              if (this.cachedWords.length === 0) this.refreshWords();
              const matchingWords = this.cachedWords.map((w, idx) => ({ w, idx })).filter(item => item.w.lineIndex === nextLineIdx);
              if (matchingWords.length > 0) {
                const targetW = direction > 0 ? matchingWords[0] : matchingWords[matchingWords.length - 1];
                this.activeLineIndex = nextLineIdx;
                this.setWordWindow(targetW.idx);
                this.rulerEl.classList.add("word-tracking-mode", "is-snapped");
                this.disableWordTransition();
                this.applyPosition();
                return;
              }
            }
          }
        }

        if (this.cachedWords.length === 0) {
          this.refreshWords();
        }

        if (this.cachedWords.length > 0) {
          let newIdx;
          if (this.activeWordIndex < 0) {
            if (direction > 0) {
              newIdx = 0;
            } else if (direction < 0) {
              newIdx = this.cachedWords.length - 1;
            } else {
              newIdx = 0;
            }
          } else {
            const curIdx = this.activeWordIndex;
            const curWord = this.cachedWords[curIdx];
            const curLineIdx = curWord ? curWord.lineIndex : this.activeLineIndex;

            if (direction > 0) {
              const nextLineIdx = curLineIdx != null ? curLineIdx + 1 : -1;
              if (nextLineIdx >= 0 && nextLineIdx < this.cachedLines.length && this.cachedLines[nextLineIdx].isMedia) {
                const isLastWordOnLine = (curIdx === this.cachedWords.length - 1) || (this.cachedWords[curIdx + 1].lineIndex !== curLineIdx);
                if (isLastWordOnLine) {
                  this.activeLineIndex = nextLineIdx;
                  this.rulerEl.classList.remove("word-tracking-mode");
                  const geom = this.computeLineGeometry(nextLineIdx);
                  if (geom) {
                    this.height = geom.height;
                    this.targetY = geom.targetY;
                    this.currentY = this.targetY;
                  }
                  this.rulerEl.classList.add("is-snapped");
                  this.applyPosition();
                  return;
                }
              }
            } else if (direction < 0) {
              const prevLineIdx = curLineIdx != null ? curLineIdx - 1 : -1;
              if (prevLineIdx >= 0 && prevLineIdx < this.cachedLines.length && this.cachedLines[prevLineIdx].isMedia) {
                const isFirstWordOnLine = (curIdx === 0) || (this.cachedWords[curIdx - 1].lineIndex !== curLineIdx);
                if (isFirstWordOnLine) {
                  this.activeLineIndex = prevLineIdx;
                  this.rulerEl.classList.remove("word-tracking-mode");
                  const geom = this.computeLineGeometry(prevLineIdx);
                  if (geom) {
                    this.height = geom.height;
                    this.targetY = geom.targetY;
                    this.currentY = this.targetY;
                  }
                  this.rulerEl.classList.add("is-snapped");
                  this.applyPosition();
                  return;
                }
              }
            }

            if (direction > 0 && curIdx >= this.cachedWords.length - 1) {
              if (this.onBoundary) {
                this.lockAdvancement(350);
                this.onBoundary(1);
                return;
              }
            } else if (direction < 0 && curIdx <= 0) {
              if (this.onBoundary) {
                this.onBoundary(-1);
                return;
              }
            }
            newIdx = curIdx + direction;
          }

          newIdx = Math.max(0, Math.min(this.cachedWords.length - 1, newIdx));
          this.setWordWindow(newIdx);

          this.rulerEl.classList.add("word-tracking-mode");
          this.rulerEl.classList.add("is-snapped");
          this.maskTopEl.classList.add("is-snapped");
          this.maskBottomEl.classList.add("is-snapped");
          this.maskLeftEl.classList.add("is-snapped");
          this.maskRightEl.classList.add("is-snapped");

          this.disableWordTransition();
          this.applyPosition();
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
            if (this.onBoundary) {
              this.lockAdvancement(350);
              this.onBoundary(1);
              return;
            }
          } else if (direction < 0 && curIdx <= 0) {
            if (this.onBoundary) {
              this.onBoundary(-1);
              return;
            }
          }
          newIdx = curIdx + direction;
        }

        newIdx = Math.max(0, Math.min(this.cachedLines.length - 1, newIdx));
        this.activeLineIndex = newIdx;

        this.rulerEl.classList.remove("word-tracking-mode");
        const geom = this.computeLineGeometry(newIdx);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }

        const line = this.cachedLines[newIdx];
        this.lastPointerX = line.left != null ? line.left : 100;
        this.lastPointerY = line.centerY;
        this.lastValidPointerX = this.lastPointerX;
        this.lastValidPointerY = this.lastPointerY;

        this.rulerEl.classList.add("is-snapped");
        this.maskTopEl.classList.add("is-snapped");
        this.maskBottomEl.classList.add("is-snapped");
        this.maskLeftEl.classList.add("is-snapped");
        this.maskRightEl.classList.add("is-snapped");
        if (this.rulerEl) {
          this.rulerEl.style.transition = "none";
        }
        this.applyPosition();
        return;
      } else if (this.cachedLines.length === 0 && this.onBoundary && direction !== 0) {
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
    const targetStage = stage || this.getStageElement();
    if (targetStage) {
      targetStage.classList.remove("focus-active");
      targetStage.style.webkitMaskImage = "";
      targetStage.style.maskImage = "";
      targetStage.style.webkitMaskPosition = "";
      targetStage.style.maskPosition = "";
      targetStage.style.webkitMaskSize = "";
      targetStage.style.maskSize = "";
      targetStage.style.webkitMaskRepeat = "";
      targetStage.style.maskRepeat = "";
      targetStage.style.webkitMaskComposite = "";
      targetStage.style.maskComposite = "";
      const mediaEls = targetStage.querySelectorAll(".active-focus, .ruler-focused-image");
      mediaEls.forEach(el => el.classList.remove("active-focus", "ruler-focused-image"));
    }
    const content = document.getElementById("reader-content");
    if (content && content !== targetStage) {
      content.classList.remove("focus-active");
      content.style.webkitMaskImage = "";
      content.style.maskImage = "";
      content.style.webkitMaskPosition = "";
      content.style.maskPosition = "";
      content.style.webkitMaskSize = "";
      content.style.maskSize = "";
      content.style.webkitMaskRepeat = "";
      content.style.maskRepeat = "";
      content.style.webkitMaskComposite = "";
      content.style.maskComposite = "";
      const mediaEls = content.querySelectorAll(".active-focus, .ruler-focused-image");
      mediaEls.forEach(el => el.classList.remove("active-focus", "ruler-focused-image"));
    }
  }

  applyPosition() {
    if (!this.rulerEl) return;

    if (!this.enabled || (!this.isPdfMode && this.cachedLines.length === 0)) {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
      if (this.maskTopEl) this.maskTopEl.style.display = "none";
      if (this.maskBottomEl) this.maskBottomEl.style.display = "none";
      if (this.mode === "focus") {
        this.clearFocusTextMask();
      }
      return;
    }

    if (this.isPageTransitioning) {
      this.rulerEl.classList.add("is-page-transitioning");
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
    } else {
      this.rulerEl.classList.add("is-visible");
      this.rulerEl.classList.remove("is-hidden", "is-page-transitioning");
      if (this.rulerEl.style.display === "none") {
        this.rulerEl.style.display = "block";
      }
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
    }

    // --- PDF MODE CONTINUOUS MECHANICAL OVERLAY ---
    if (this.isPdfMode) {
      const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.pdfRulerHeight || 32);
      this.rulerEl.style.height = `${h}px`;
      this.rulerEl.style.transition = "none";

      const canvas = document.querySelector("#reader-content canvas");
      const stage = this.getStageElement() || document.getElementById("paged-stage") || this.container || document.body;
      const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, bottom: window.innerHeight };

      let targetLeft = stageRect.left;
      let targetWidth = stageRect.width;
      let boundsTop = stageRect.top;
      let boundsBottom = stageRect.bottom;

      if (canvas) {
        const cRect = canvas.getBoundingClientRect();
        if (cRect.width > 50) {
          targetLeft = cRect.left;
          targetWidth = cRect.width;
          boundsTop = cRect.top;
          boundsBottom = cRect.bottom;
        }
      }

      // Clamp currentY within bounds
      let y = Number.isFinite(this.currentY) ? Math.round(this.currentY) : Math.round(boundsTop + 50);
      y = Math.max(Math.round(boundsTop), Math.min(Math.round(boundsBottom - h), y));
      this.currentY = y;

      this.rulerEl.style.top = `${y}px`;
      this.rulerEl.style.left = `${Math.round(targetLeft)}px`;
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(targetWidth)}px`;
      this.rulerEl.style.maxWidth = `${Math.round(targetWidth)}px`;
      this.rulerEl.style.transform = "none";

      // Dimming mode in PDF: use top and bottom semi-transparent overlay bands leaving the active line slot un-dimmed.
      if (this.mode === "focus" && this.enabled && !this.isPageTransitioning) {
        const dimOpacity = this.dimOpacity !== undefined ? this.dimOpacity : 0.65;
        const dimBg = `rgba(0, 0, 0, ${dimOpacity})`;

        // Top band: covers from boundsTop down to y
        const topBandHeight = Math.max(0, y - boundsTop);
        if (this.maskTopEl) {
          this.maskTopEl.className = "ruler-mask ruler-mask-top pdf-overlay-mask is-visible";
          this.maskTopEl.style.setProperty("display", "block", "important");
          this.maskTopEl.style.setProperty("background-color", dimBg, "important");
          this.maskTopEl.style.setProperty("opacity", "1", "important");
          this.maskTopEl.style.top = `${Math.round(boundsTop)}px`;
          this.maskTopEl.style.left = `${Math.round(targetLeft)}px`;
          this.maskTopEl.style.width = `${Math.round(targetWidth)}px`;
          this.maskTopEl.style.height = `${Math.round(topBandHeight)}px`;
        }

        // Bottom band: covers from y + h down to boundsBottom
        const bottomBandTop = y + h;
        const bottomBandHeight = Math.max(0, boundsBottom - bottomBandTop);
        if (this.maskBottomEl) {
          this.maskBottomEl.className = "ruler-mask ruler-mask-bottom pdf-overlay-mask is-visible";
          this.maskBottomEl.style.setProperty("display", "block", "important");
          this.maskBottomEl.style.setProperty("background-color", dimBg, "important");
          this.maskBottomEl.style.setProperty("opacity", "1", "important");
          this.maskBottomEl.style.top = `${Math.round(bottomBandTop)}px`;
          this.maskBottomEl.style.left = `${Math.round(targetLeft)}px`;
          this.maskBottomEl.style.width = `${Math.round(targetWidth)}px`;
          this.maskBottomEl.style.height = `${Math.round(bottomBandHeight)}px`;
        }

        if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
        if (this.maskRightEl) this.maskRightEl.style.display = "none";
      } else {
        if (this.maskTopEl) {
          this.maskTopEl.style.display = "none";
          this.maskTopEl.classList.remove("pdf-overlay-mask", "is-visible");
        }
        if (this.maskBottomEl) {
          this.maskBottomEl.style.display = "none";
          this.maskBottomEl.classList.remove("pdf-overlay-mask", "is-visible");
        }
        if (this.maskLeftEl) this.maskLeftEl.style.display = "none";
        if (this.maskRightEl) this.maskRightEl.style.display = "none";
      }
      return;
    }

    const currentLine = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
      ? this.cachedLines[this.activeLineIndex]
      : null;
    const isCurrentMedia = !!(currentLine && currentLine.isMedia);

    let y = Number.isFinite(this.currentY) ? Math.round(this.currentY) : 150;
    let h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);

    if (isCurrentMedia) {
      y = Math.round(currentLine.top);
      h = Math.round(currentLine.height);
    }
    this.rulerEl.style.height = `${h}px`;

    if (this.mode === "focus" || !this.wordTracking) {
      this.rulerEl.style.transition = "none";
    }

    if (this.wordTracking && !isCurrentMedia) {
      const x = Number.isFinite(this.wordLeft) ? Math.round(this.wordLeft) : 0;
      const w = Number.isFinite(this.totalWidth) && this.totalWidth > 0 ? Math.round(this.totalWidth) : 100;
      this.rulerEl.style.top = "0px";
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${w}px`;
      this.rulerEl.style.maxWidth = "100%";
      this.rulerEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;

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
    } else {
      this.rulerEl.classList.remove("no-preview");
      const isTwoCol = this.isTwoCol;
      let colLeft = currentLine ? (currentLine.columnLeft ?? currentLine.left) : null;
      let colWidth = currentLine ? (currentLine.columnWidth ?? currentLine.width) : null;

      if (isCurrentMedia) {
        colLeft = currentLine.left;
        colWidth = currentLine.width;
      } else if (colLeft == null || colWidth == null || !Number.isFinite(colLeft) || !Number.isFinite(colWidth) || colWidth < 80) {
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
            // Fallback: measure the stage live to avoid stale/zero stageLeft cache
            const stageEl = document.getElementById("paged-stage") || this.container || document.body;
            const sRect = stageEl ? stageEl.getBoundingClientRect() : null;
            const sLeft = sRect && sRect.width > 50 ? sRect.left : (this.stageLeft ?? 0);
            const sWidth = sRect && sRect.width > 50 ? sRect.width : (this.stageWidth ?? (window.innerWidth - 40));
            colLeft = Math.max(0, sLeft - 12);
            colWidth = sWidth + 24;
          }
          // Safety guard: colLeft must never be more than 12px left of the current stage left
          const guardStageEl = document.getElementById("paged-stage") || this.container || document.body;
          const guardRect = guardStageEl ? guardStageEl.getBoundingClientRect() : null;
          if (guardRect && guardRect.width > 50 && colLeft < guardRect.left - 12) {
            colLeft = Math.max(0, guardRect.left - 8);
          }
        }
      }

      // Bezpečnostní limit: maxWidth pravítka nesmí překročit columnWidth aktivního sloupce (pouze pro běžný text)
      if (isTwoCol && !isCurrentMedia) {
        const colIdx = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
        const maxColW = colIdx === 1 ? (this.column1Width || this.column0Width) : this.column0Width;
        if (Number.isFinite(maxColW) && maxColW > 80 && colWidth > maxColW) {
          colWidth = maxColW;
        }
      }

      this.rulerEl.style.top = `${y}px`;
      this.rulerEl.style.left = `${Math.round(colLeft)}px`;
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(colWidth)}px`;
      this.rulerEl.style.maxWidth = `${Math.round(colWidth)}px`;
      this.rulerEl.style.transform = "none";
    }

    const stage = this.getStageElement();
    if (this.mode === "focus" && this.enabled && stage) {
      if (this.cachedLines.length === 0) {
        this.clearFocusTextMask();
        this.maskTopEl.style.display = "none";
        this.maskBottomEl.style.display = "none";
        this.maskLeftEl.style.display = "none";
        this.maskRightEl.style.display = "none";
        return;
      }
      this.maskTopEl.style.display = "none";
      this.maskBottomEl.style.display = "none";
      this.maskLeftEl.style.display = "none";
      this.maskRightEl.style.display = "none";

      // Synchronizace tříd aktivního zaostření na multimédia v stage
      const allMedia = stage.querySelectorAll("img, svg, canvas, figure, picture, .chapter-illustration");
      const targetEl = (isCurrentMedia && currentLine && currentLine.element) ? currentLine.element : null;
      for (const m of allMedia) {
        if (targetEl && (m === targetEl || targetEl.contains(m) || m.contains(targetEl))) {
          m.classList.add("active-focus", "ruler-focused-image");
        } else {
          m.classList.remove("active-focus", "ruler-focused-image");
        }
      }

      // Synchronní výměna tříd na řádcích textu (reading lines)
      const prevIdx = this.previousActiveLineIndex;
      const curIdx = this.activeLineIndex;
      if (prevIdx != null && prevIdx >= 0 && prevIdx < this.cachedLines.length && prevIdx !== curIdx) {
        const prevLine = this.cachedLines[prevIdx];
        const prevEl = prevLine ? (prevLine.element || prevLine.el) : null;
        if (prevEl && prevEl.classList) {
          prevEl.classList.remove("line-focused", "active-focus");
          prevEl.classList.add("line-dimmed");
        }
      } else {
        const allLines = stage.querySelectorAll(".reading-line, .line-focused, .line-dimmed");
        for (const l of allLines) {
          l.classList.remove("line-focused", "active-focus");
          l.classList.add("line-dimmed");
        }
      }
      const curEl = currentLine ? (currentLine.element || currentLine.el) : null;
      if (curEl && curEl.classList) {
        curEl.classList.remove("line-dimmed");
        curEl.classList.add("line-focused", "active-focus");
      }
      this.previousActiveLineIndex = curIdx;

      const stageRect = stage.getBoundingClientRect();
      const inactiveAlpha = Math.max(0.12, Math.min(0.65, Number((1 - this.dimOpacity).toFixed(2))));

      const relY = Math.max(0, Math.round(y - stageRect.top));
      const relH = Math.max(10, Math.round(h));

      let activeGradient = "";
      let activeSize = "";
      let activePos = "";

      if (this.wordTracking && !isCurrentMedia) {
        const relX = Math.max(0, Math.round(this.wordLeft - stageRect.left));
        const aw = Number.isFinite(this.activeWordWidth) && this.activeWordWidth > 0 ? Math.round(this.activeWordWidth) : 100;
        const pw = Number.isFinite(this.previewWidth) && this.previewWidth > 0 ? Math.round(this.previewWidth) : 0;

        if (pw > 0) {
          const totalW = aw + pw;
          activeGradient = `linear-gradient(to right, #000 0px, #000 ${aw}px, rgba(0, 0, 0, 0) ${totalW}px)`;
          activeSize = `${totalW}px ${relH}px`;
        } else {
          activeGradient = "linear-gradient(#000, #000)";
          activeSize = `${aw}px ${relH}px`;
        }
        activePos = `${relX}px ${relY}px`;
      } else {
        let colLeft = currentLine ? (currentLine.columnLeft ?? currentLine.left) : null;
        let colWidth = currentLine ? (currentLine.columnWidth ?? currentLine.width) : null;

        if (isCurrentMedia) {
          colLeft = currentLine.left;
          colWidth = currentLine.width;
        } else if (colLeft == null || colWidth == null || !Number.isFinite(colLeft) || !Number.isFinite(colWidth) || colWidth < 80) {
          if (this.isTwoCol) {
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
              colLeft = Math.max(0, (this.stageLeft != null ? this.stageLeft - 12 : 20));
              colWidth = (this.stageWidth != null ? this.stageWidth + 24 : (window.innerWidth - 40));
            }
          }
        }

        if (this.isTwoCol && !isCurrentMedia) {
          const colIdx = (currentLine && currentLine.columnIndex === 1) ? 1 : 0;
          const maxColW = colIdx === 1 ? (this.column1Width || this.column0Width) : this.column0Width;
          if (Number.isFinite(maxColW) && maxColW > 80 && colWidth > maxColW) {
            colWidth = maxColW;
          }
        }

        const relX = Math.max(0, Math.round(colLeft - stageRect.left));
        const relW = Math.max(isCurrentMedia ? 10 : 80, Math.round(colWidth));

        activeGradient = "linear-gradient(#000, #000)";
        activeSize = `${relW}px ${relH}px`;
        activePos = `${relX}px ${relY}px`;
      }

      // V de-emphasis masce již nevylučujeme neaktivní multimédia: neaktivní obrázky zůstávají ztmavené spolu s okolním textem
      const gradients = [
        activeGradient,
        `linear-gradient(rgba(0, 0, 0, ${inactiveAlpha}), rgba(0, 0, 0, ${inactiveAlpha}))`
      ];
      const sizes = [
        activeSize,
        "100% 100%"
      ];
      const positions = [
        activePos,
        "0px 0px"
      ];

      const maskImage = gradients.join(", ");
      const maskSize = sizes.join(", ");
      const maskPos = positions.join(", ");
      const maskRepeat = "no-repeat, no-repeat";

      stage.classList.add("focus-active");
      stage.style.webkitMaskImage = maskImage;
      stage.style.maskImage = maskImage;
      stage.style.webkitMaskPosition = maskPos;
      stage.style.maskPosition = maskPos;
      stage.style.webkitMaskSize = maskSize;
      stage.style.maskSize = maskSize;
      stage.style.webkitMaskRepeat = maskRepeat;
      stage.style.maskRepeat = maskRepeat;
      stage.style.webkitMaskComposite = "source-over";
      stage.style.maskComposite = "add";
    } else {
      this.clearFocusTextMask(stage);
      this.maskTopEl.style.display = "none";
      this.maskBottomEl.style.display = "none";
      this.maskLeftEl.style.display = "none";
      this.maskRightEl.style.display = "none";
    }
  }

  updateRulerPosition(index = 0) {
    if (!this.rulerEl) return;
    if (this.isPdfMode) {
      this.height = this.pdfRulerHeight || 32;
      this.applyPosition();
      return;
    }
    this.refreshLines();
    if (this.wordTracking) {
      this.refreshWords();
    }

    if (this.cachedLines.length === 0) {
      this.rulerEl.style.display = "none";
      this.rulerEl.style.opacity = "0";
      this.rulerEl.style.visibility = "hidden";
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.clearFocusTextMask();
      return;
    }

    if (this.wordTracking && this.cachedWords.length > 0) {
      const idx = Math.max(0, Math.min(this.cachedWords.length - 1, index));
      this.activeWordIndex = idx;
      const targetWord = this.cachedWords[idx];
      if (targetWord && targetWord.lineIndex != null) {
        this.activeLineIndex = targetWord.lineIndex;
      }
      this.setWordWindow(idx);
      this.lastPointerX = targetWord ? targetWord.centerX : 100;
      this.lastPointerY = targetWord ? targetWord.centerY : 150;
      this.lastValidPointerX = this.lastPointerX;
      this.lastValidPointerY = this.lastPointerY;
      this.rulerEl.classList.add("word-tracking-mode", "is-snapped");
    } else {
      const idx = Math.max(0, Math.min(this.cachedLines.length - 1, index));
      this.activeLineIndex = idx;
      this.rulerEl.classList.remove("word-tracking-mode");
      const geom = this.computeLineGeometry(idx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
        this.currentY = this.targetY;
      }
      const line = this.cachedLines[idx];
      this.lastPointerX = line.left != null ? line.left : 100;
      this.lastPointerY = line.centerY;
      this.lastValidPointerX = this.lastPointerX;
      this.lastValidPointerY = this.lastPointerY;
      this.rulerEl.classList.add("is-snapped");
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

    if (this.wordTracking) {
      this.rulerEl.style.willChange = "transform";
    } else {
      this.rulerEl.style.willChange = "auto";
    }

    const isFocus = this.enabled && this.mode === "focus" && !this.isPageTransitioning && this.cachedLines.length > 0;
    const transitionClass = this.horizontalWordTransition ? "word-transition-active" : "word-transition-snap";
    const showSideMasks = isFocus && (this.wordTracking || this.isTwoCol);
    this.rulerEl.className = `reading-ruler mode-${this.mode} color-${this.color} ${this.enabled && !this.isPageTransitioning && this.cachedLines.length > 0 ? "is-visible" : "is-hidden"} ${this.wordTracking ? "word-tracking-mode " + transitionClass : ""} ${this.isPageTransitioning ? "is-page-transitioning" : ""}`;
    this.maskTopEl.className = `ruler-mask ruler-mask-top ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskBottomEl.className = `ruler-mask ruler-mask-bottom ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskLeftEl.className = `ruler-mask ruler-mask-left ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;
    this.maskRightEl.className = `ruler-mask ruler-mask-right ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;

    if (this.enabled && !this.isPageTransitioning && this.cachedLines.length > 0) {
      this.rulerEl.classList.add("is-visible");
      this.rulerEl.classList.remove("is-hidden", "is-page-transitioning");
      if (this.rulerEl.style.display === "none") {
        this.rulerEl.style.display = "block";
      }
      this.rulerEl.style.opacity = "1";
      this.rulerEl.style.visibility = "visible";
    } else {
      if (this.isPageTransitioning) {
        this.rulerEl.classList.add("is-page-transitioning");
        this.rulerEl.style.opacity = "0";
        this.rulerEl.style.visibility = "hidden";
      } else {
        this.rulerEl.classList.remove("is-visible");
        this.rulerEl.classList.add("is-hidden");
        this.rulerEl.style.display = "none";
        this.rulerEl.style.opacity = "0";
        this.rulerEl.style.visibility = "hidden";
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
    const isFocus = isRulerActive && this.mode === "focus";

    document.body.classList.toggle("ruler-active", isRulerActive);
    document.body.classList.toggle("ruler-mouse-follow-active", isMouseFollow);
    document.body.classList.toggle("word-tracking-active", isWordTracking);
    document.body.classList.toggle("ruler-mode-focus", isFocus);
  }

  setEnabled(val) {
    this.disableWordTransition();
    this.enabled = !!val;
    if (!this.enabled) {
      this.cancelHold();
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
      this.clearFocusTextMask();
    } else {
      if (this.rulerEl && !document.body.contains(this.rulerEl)) {
        document.body.appendChild(this.maskTopEl);
        document.body.appendChild(this.maskBottomEl);
        document.body.appendChild(this.maskLeftEl);
        document.body.appendChild(this.maskRightEl);
        document.body.appendChild(this.rulerEl);
      }
      if (this.rulerEl) {
        this.rulerEl.classList.remove("is-page-transitioning");
        this.isPageTransitioning = false;
        this.rulerEl.style.display = "block";
        this.rulerEl.style.opacity = "1";
        this.rulerEl.classList.remove("is-hidden", "hidden");
        this.rulerEl.classList.add("is-visible");
      }
    }
    this.updateStyles();
    this.updateBodyClasses();

    if (this.enabled) {
      if (this.isPdfMode) {
        this.applyPosition();
      } else {
        this.updateRulerPosition(0);
      }
      console.log(`[Ruler] Activated, found lines: ${this.cachedLines.length}, current position: Top ${Math.round(this.currentY)} px, Height ${Math.round(this.height)} px`);
    }
  }

  setMode(mode) {
    if (["highlight", "focus"].includes(mode)) {
      if (this.mode === "focus" && mode !== "focus") {
        this.clearFocusTextMask();
      }
      this.mode = mode;
      this.updateEffectiveHeight();
      this.updateStyles();
      this.updateBodyClasses();
      this.applyPosition();
    }
  }

  setColor(color) {
    this.color = color;
    this.updateStyles();
  }

  setHeight(px) {
    this.manualHeight = Math.max(16, Math.min(120, parseInt(px, 10) || 48));
    if (!this.autoHeight) {
      this.height = this.manualHeight;
      if (this.snapToLines && this.cachedLines.length > 0 && this.activeLineIndex >= 0) {
        const geom = this.computeLineGeometry(this.activeLineIndex);
        if (geom) {
          this.height = geom.height;
          this.targetY = geom.targetY;
          this.currentY = this.targetY;
        }
      }
      this.applyPosition();
    }
  }

  setAutoHeight(enabled) {
    this.autoHeight = true;
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
    this.applyPosition();
  }

  setSnapToLines(enabled) {
    this.disableWordTransition();
    this.snapToLines = true;
    this.refreshLines();
    if (this.followMode === "mouse") {
      this.snapToFirstElement();
    } else if (this.cachedLines.length > 0) {
      this.stepLine(0);
    }
  }

  setWordTracking(enabled) {
    this.disableWordTransition();
    this.wordTracking = !!enabled;
    this.updateBodyClasses();
    if (this.wordTracking) {
      this.refreshWords();
      if (this.followMode === "mouse") {
        this.snapToFirstElement();
      } else if (this.cachedWords.length > 0) {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      }
    } else {
      this.previewWidth = 0;
      this.totalWidth = 0;
      this.rulerEl.classList.remove("word-tracking-mode");
      this.applyPosition();
      if (this.followMode === "mouse") {
        this.snapToFirstElement();
      } else {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      }
    }
    this.updateStyles();
  }

  setDimOpacity(opacity) {
    this.dimOpacity = Math.max(0.1, Math.min(0.95, parseFloat(opacity) || 0.65));
    this.updateStyles();
    if (this.mode === "focus" && this.enabled) {
      this.applyPosition();
    }
  }

  setFollowMode(mode) {
    this.disableWordTransition();
    this.followMode = mode;
    this.updateBodyClasses();
    if (this.enabled && this.followMode === "mouse") {
      this.snapToFirstElement();
    }
  }


  /**
   * Vyvolá se při přechodu na jinou stránku nebo kapitolu.
   * Okamžitě a synchronně usadí pravítko na cílový řádek bez jakéhokoliv časovače či prodlevy.
   */
  onPageChange(direction = 0, isPageChanged = true, immediate = true) {
    if (!this.enabled) return;
    this.isLineLocked = true;

    const stage = this.getStageElement();
    if (stage) stage.classList.add("is-turning-page");
    document.body.classList.add("is-turning-page");
    const content = document.getElementById("reader-content");
    if (content) content.classList.add("is-turning-page");

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.suppressLineAdvancement = false;
        if (stage) stage.classList.remove("is-turning-page");
        document.body.classList.remove("is-turning-page");
        if (content) content.classList.remove("is-turning-page");
      }
    }, 300); // 300ms maximum lock lifetime

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
    if (content && this._onTransitionEnd) {
      content.removeEventListener("transitionend", this._onTransitionEnd);
      this._onTransitionEnd = null;
    }

    this.hideForPageTransition();

    // Okamžité synchronní usazení pravítka na nové stránce podle směru listování
    // Pro švihnutí stylusu vždy resynchronizovat na horní řádek příchozí stránky
    const targetDirection = this.flickResyncTopLine ? 1 : direction;
    this.flickResyncTopLine = false;
    this.resetPositionForPage(targetDirection, immediate);
  }

  destroy() {
    this.penHistory = [];
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
    document.querySelectorAll(".ruler-hold-indicator").forEach(el => el.remove());
    this.clearFocusTextMask();
    document.body.classList.remove("ruler-active", "ruler-mouse-follow-active", "word-tracking-active", "ruler-mode-focus");
  }
}
