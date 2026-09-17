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
    this.pendingPointerX = 300;
    this.pendingPointerY = 200;

    // 1,1s podržení pro přemístění pravítka (prst, Apple Pencil, kurzor)
    this.holdTimer = null;
    this.holdStartX = 0;
    this.holdStartY = 0;
    this.holdStartTime = 0;
    this.holdPointerType = null;
    this.isHoldActive = false;
    this.isHoldTriggered = false;
    this.wasHoldAborted = false;
    this.holdIndicatorEl = null;
    this.lastTapStepTime = 0;
    this.lastTouchTapTime = 0;
    this.lastSwipeTime = 0;
    this.onBoundary = null;
    this.onSwipe = null;
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

  lockAdvancement(duration = 350) {
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

  isLastLine() {
    if (!this.enabled) return false;
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
      "header, nav, .modal, .modal-content, .settings-modal, .stats-modal, .dropdown, button, input, select, textarea, a, [role='button'], [role='dialog'], [role='slider'], .btn, .btn-icon, .drawer-panel, .drawer, .drawer-backdrop, .modal-dialog, .modal-overlay, .paged-footer-bar, .reading-scrubber, .reader-header, .top-navbar, .ruler-btn-group, #ruler-split-pill, .split-pill-btn, #btn-toggle-ruler, #btn-ruler-quick-menu, .ruler-quick-popover, .ruler-floating-controls, #btn-reader-menu-fab, #reader-floating-dock, .reader-floating-dock, .dock-action-row, .dock-action-btn, #footer-remaining-chapter, #footer-book-pages, .footer-actions-group"
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
      requestAnimationFrame(() => {
        this.rafPointerPending = false;
        if (this.enabled && !this.isLineLocked && !this.isPageTransitioning) {
          this.handlePointerMove(this.pendingPointerX, this.pendingPointerY, this.pendingPointerType);
        }
      });
    }
  }

  createHoldIndicator() {
    if (this.holdIndicatorEl) return this.holdIndicatorEl;
    const el = document.createElement("div");
    el.className = "ruler-hold-indicator";
    el.innerHTML = `
      <svg viewBox="0 0 44 44">
        <circle class="bg" cx="22" cy="22" r="16" />
        <circle class="progress" cx="22" cy="22" r="16" />
      </svg>
    `;
    document.body.appendChild(el);
    this.holdIndicatorEl = el;
    return el;
  }

  isAlreadyAtPosition(clientX, clientY) {
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

    const indicator = this.createHoldIndicator();
    indicator.style.left = `${Math.round(clientX)}px`;
    indicator.style.top = `${Math.round(clientY)}px`;
    indicator.classList.remove("is-completed", "is-active");
    void indicator.offsetWidth;
    indicator.classList.add("is-active");

    this.holdTimer = setTimeout(() => {
      this.triggerHoldSuccess(this.holdStartX, this.holdStartY);
    }, 1100);
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

    if (this.holdIndicatorEl) {
      this.holdIndicatorEl.classList.remove("is-active");
      this.holdIndicatorEl.classList.add("is-completed");
      setTimeout(() => {
        if (!this.isHoldActive) {
          this.holdIndicatorEl?.classList.remove("is-completed");
        }
      }, 350);
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
    if (this.holdIndicatorEl) {
      this.holdIndicatorEl.classList.remove("is-active", "is-completed");
    }
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
      if (!this.enabled || this.isLineLocked || this.isPageTransitioning || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;
      if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
        this.holdStartTime = 0;
        return;
      }
      if (e.target?.closest && e.target.closest("img, svg, figure, picture, canvas, hr")) return;

      // Pro myš na PC vyžadujeme výhradně stisknuté levé tlačítko (button === 0)
      if (e.pointerType === "mouse" && e.button !== 0) return;

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.isPenTouching = true;
        this.savePenDetails(e);
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
      if (!this.enabled || this.isLineLocked || this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) return;

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.savePenDetails(e);
      }

      // Pokud běží aktivní držení, zkontrolujeme prahový posun (tolerance 10px)
      if (this.isHoldActive) {
        const dx = Math.abs(e.clientX - this.holdStartX);
        const dy = Math.abs(e.clientY - this.holdStartY);
        if (Math.hypot(dx, dy) > 10 || dx > 10 || dy > 10) {
          this.cancelHold(false);
        }
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
      if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
        this.cancelHold(false);
        this.isDraggingRuler = false;
        this.isPenTouching = false;
        return;
      }

      if (this.followMode === "mouse") {
        if (e.pointerType === "touch") return;
        if (e.pointerType === "pen") {
          this.lastPenTime = Date.now();
          this.isPenTouching = false;
          this.dragCooldownEndTime = Date.now() + 350;
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

      // Pokud pohyb překročil prahovou hodnotu pro swipe (|deltaX| > 30px a |deltaX| > |deltaY| * 1.5):
      if (absX > 30 && absX > absY * 1.5) {
        this.cancelHold(false);
        this.holdStartTime = 0;
        this.lastSwipeTime = Date.now();
        if (this.onSwipe) {
          this.onSwipe(deltaX < 0 ? 1 : -1);
        }
        return;
      }

      if (this.isHoldActive) {
        const holdDuration = Date.now() - (this.holdStartTime || 0);
        const dist = Math.hypot(deltaX, deltaY);
        // Krokování tapem se spustí POUZE při čistém, stacionárním klepnutí (|deltaX| < 10px a |deltaY| < 10px)
        const isTap = absX < 10 && absY < 10 && dist <= 10 && holdDuration < 1100 && !this.isHoldTriggered;

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
      if (e.target?.closest && e.target.closest("img, svg, figure, picture, canvas, hr")) return;
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
        if (Math.hypot(dx, dy) > 10 || dx > 10 || dy > 10) {
          this.cancelHold(false);
        }
      }
    };

    const onTouchEnd = (e) => {
      if (this.isNavigating || this.isNavigatingPage || Date.now() < this.navigatingPageLockoutEndTime) {
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

      // Pokud pohyb překročil prahovou hodnotu pro swipe (|deltaX| > 30px a |deltaX| > |deltaY| * 1.5):
      if (absX > 30 && absX > absY * 1.5) {
        this.cancelHold(false);
        this.holdStartTime = 0;
        this.lastSwipeTime = Date.now();
        if (this.onSwipe) {
          this.onSwipe(deltaX < 0 ? 1 : -1);
        }
        return;
      }

      if (this.isHoldActive) {
        const holdDuration = Date.now() - (this.holdStartTime || 0);
        const dist = Math.hypot(deltaX, deltaY);
        // Krokování tapem se spustí POUZE při čistém, stacionárním klepnutí (|deltaX| < 10px a |deltaY| < 10px)
        const isTap = absX < 10 && absY < 10 && dist <= 10 && holdDuration < 1100 && !this.isHoldTriggered;

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
              for (let i = 0; i < rects.length; i++) {
                const r = rects[i];
                const inStage = !hasValidStageBounds || (
                  r.right > stageLeft - 4 &&
                  r.left < stageRight + 4 &&
                  r.bottom > stageTop + 2 &&
                  r.top < stageBottom - 2
                );
                if (inStage && r.height >= 8 && r.width >= 8) {
                  rawLines.push({
                    el,
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

        // 2. Fallback: Bounding rect hlavního odstavce nebo kontejneru
        if (rawLines.length === 0) {
          const mainParagraph = content.querySelector('p, div, article') || content;
          const r = mainParagraph ? mainParagraph.getBoundingClientRect() : null;
          if (r && r.width > 0 && r.height > 0) {
            const defaultLineHeight = 32;
            const count = Math.max(1, Math.min(20, Math.floor(r.height / defaultLineHeight)));
            for (let i = 0; i < count; i++) {
              const top = r.top + i * defaultLineHeight;
              const bottom = top + defaultLineHeight;
              rawLines.push({
                el: mainParagraph,
                rect: { top, bottom, left: r.left, right: r.right, width: r.width, height: defaultLineHeight },
                top,
                bottom,
                left: r.left,
                right: r.right,
                height: defaultLineHeight,
                centerY: top + defaultLineHeight / 2,
                hasText: true,
                columnIndex: 0
              });
            }
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
      const col1StageRight = isTwoCol ? stageRect.right : col0StageRight;

      // Přiřazení indexu sloupce každému nalezenému řádku
      for (let i = 0; i < rawLines.length; i++) {
        const r = rawLines[i];
        r.columnIndex = isTwoCol ? (((r.left + r.right) / 2 >= stageCenterX) ? 1 : 0) : 0;
      }
      const validLines = rawLines;

      // Seskupení řádků odděleně podle sloupců, aby se řádky ve stejném Y v sousedních sloupcích nespojily do jednoho
      const clusterColumnLines = (colLines, colIdx) => {
        if (colLines.length === 0) return [];
        colLines.sort((a, b) => a.centerY - b.centerY);
        const colClustered = [];
        for (const r of colLines) {
          if (colClustered.length === 0) {
            colClustered.push({ ...r, columnIndex: colIdx });
          } else {
            const prev = colClustered[colClustered.length - 1];
            if (Math.abs(r.centerY - prev.centerY) < 8 || (Math.max(r.top, prev.top) < Math.min(r.bottom, prev.bottom) - 3)) {
              prev.top = Math.min(prev.top, r.top);
              prev.bottom = Math.max(prev.bottom, r.bottom);
              prev.left = Math.min(prev.left ?? r.left, r.left);
              prev.right = Math.max(prev.right ?? r.right, r.right);
              prev.height = prev.bottom - prev.top;
              prev.centerY = prev.top + prev.height / 2;
            } else {
              colClustered.push({ ...r, columnIndex: colIdx });
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

      this.cachedLines = clustered.filter(l => l.hasText && l.height >= 8 && (l.right - l.left) >= 8);

      // Pokud ani clustering nezachoval řádek, vytvoříme záchranný řádek z rozměrů čtecího pole
      if (this.cachedLines.length === 0) {
        const top = (stageRect.top > 0 && stageRect.top < window.innerHeight) ? stageRect.top + 50 : 150;
        const height = this.manualHeight || 36;
        const left = (stageRect.left >= 0 && stageRect.width > 100) ? stageRect.left : 40;
        const width = (stageRect.width > 100) ? (isTwoCol ? singleColWidth : stageRect.width) : (window.innerWidth - 80);
        this.cachedLines = [{
          top,
          bottom: top + height,
          left,
          right: left + width,
          height,
          centerY: top + height / 2,
          hasText: true,
          columnIndex: 0,
          columnLeft: left,
          columnWidth: width,
          columnRight: left + width,
          colBoundaryLeft: col0StageLeft,
          colBoundaryRight: col0StageRight
        }];
      }

      if (this.cachedLines.length > 0) {
        let minLeft0 = Infinity, maxRight0 = -Infinity;
        let minLeft1 = Infinity, maxRight1 = -Infinity;

        for (const line of this.cachedLines) {
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

        // Horizontální ohraničení sloupce 0
        const col0MaxRight = isTwoCol ? (gapMiddle - 4) : window.innerWidth;
        let c0Left = minLeft0 < Infinity ? (minLeft0 - horizontalPadding) : (col0StageLeft - horizontalPadding);
        let c0Right = maxRight0 > -Infinity ? (maxRight0 + horizontalPadding) : (isTwoCol ? (gapMiddle - 4) : col0StageRight + horizontalPadding);
        c0Left = Math.max(0, Math.round(c0Left));
        c0Right = Math.min(col0MaxRight, Math.round(c0Right));
        if (c0Right <= c0Left) {
          c0Left = Math.max(0, Math.round(col0StageLeft - horizontalPadding));
          c0Right = Math.min(col0MaxRight, Math.round(col0StageRight + horizontalPadding));
        }
        const c0Width = Math.max(80, Math.round(c0Right - c0Left));

        // Horizontální ohraničení sloupce 1 (pokud je 2-sloupcový režim)
        let c1Left = gapMiddle + 4;
        let c1Right = col1StageRight;
        if (isTwoCol) {
          const col1MinLeft = gapMiddle + 4;
          c1Left = minLeft1 < Infinity ? (minLeft1 - horizontalPadding) : (col1StageLeft - horizontalPadding);
          c1Right = maxRight1 > -Infinity ? (maxRight1 + horizontalPadding) : (col1StageRight + horizontalPadding);
          c1Left = Math.max(col1MinLeft, Math.round(c1Left));
          c1Right = Math.min(window.innerWidth, Math.round(c1Right));
          if (c1Right <= c1Left) {
            c1Left = Math.max(col1MinLeft, Math.round(col1StageLeft - horizontalPadding));
            c1Right = Math.min(window.innerWidth, Math.round(col1StageRight + horizontalPadding));
          }
        }
        const c1Width = Math.max(80, Math.round(c1Right - c1Left));

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
          line.left = line.columnLeft;
          line.width = line.columnWidth;
          line.right = line.columnRight;
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

        this.updateStyles();
      }

      if (this.autoHeight) {
        let baseH = 0;
        if (this.cachedLines.length > 0) {
          const sortedHeights = this.cachedLines.map(l => l.height).filter(h => h > 0).sort((a, b) => a - b);
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
            if (cur.columnIndex === next.columnIndex) {
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

    if (this.cachedLines.length === 0) {
      this.refreshLines();
    }

    const curX = this.lastPointerX;
    const curY = this.lastPointerY;

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
          const lineWords = [];
          for (let i = 0; i < this.cachedWords.length; i++) {
            if (this.cachedWords[i].lineIndex === targetLineIdx) {
              lineWords.push({ word: this.cachedWords[i], index: i });
            }
          }

          const activeLine = (targetLineIdx >= 0 && targetLineIdx < this.cachedLines.length) ? this.cachedLines[targetLineIdx] : null;
          const activeLineWords = lineWords.map(item => item.word);
          const firstWord = activeLineWords.length > 0 ? activeLineWords[0] : null;
          const lastWord = activeLineWords.length > 0 ? activeLineWords[activeLineWords.length - 1] : null;

          const textMinX = firstWord ? Math.round(firstWord.left - padX) : (activeLine && activeLine.left != null ? Math.round(activeLine.left - padX) : 0);
          const textMaxX = lastWord ? Math.round(lastWord.right + padX) : (activeLine && activeLine.right != null ? Math.round(activeLine.right + padX) : window.innerWidth);

          const computeWordPreview = (wIdx) => {
            if (wIdx < 0 || wIdx >= this.cachedWords.length) return 0;
            const w = this.cachedWords[wIdx];
            const firstW = Math.round(w.width + padX * 2);
            let nextWLast = null;
            for (let offset = 1; offset <= 2; offset++) {
              const nextIdx = wIdx + offset;
              if (nextIdx >= this.cachedWords.length) break;
              const nw = this.cachedWords[nextIdx];
              const isSameLine = (nw.lineIndex != null && w.lineIndex != null)
                ? (nw.lineIndex === w.lineIndex)
                : (Math.abs(nw.centerY - w.centerY) <= 10);
              if (!isSameLine || nw.left <= w.left) break;
              nextWLast = nw;
            }
            if (!nextWLast) return 0;
            const maxB = textMaxX;
            const rawTargetRight = Math.round(nextWLast.right + padX);
            const clampedTargetRight = Math.min(rawTargetRight, maxB);
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

    // Check up to 2 following words on the SAME line (w1, w2 where w.lineIndex === w0.lineIndex)
    const nextWords = [];
    for (let offset = 1; offset <= 2; offset++) {
      const nextIdx = wordIndex + offset;
      if (nextIdx >= this.cachedWords.length) break;
      const nw = this.cachedWords[nextIdx];
      const isSameLine = (nw.lineIndex != null && w0.lineIndex != null)
        ? (nw.lineIndex === w0.lineIndex)
        : (Math.abs(nw.centerY - w0.centerY) <= 10);
      if (!isSameLine || nw.left <= w0.left) break;
      nextWords.push(nw);
    }

    // Zjištění pravé hranice aktuálního řádku pro striktní ořezání
    const activeLine = (w0.lineIndex != null && w0.lineIndex >= 0 && w0.lineIndex < this.cachedLines.length)
      ? this.cachedLines[w0.lineIndex]
      : null;
    let lineRight = activeLine?.right || null;
    if (!lineRight) {
      for (let i = wordIndex; i < this.cachedWords.length; i++) {
        const cw = this.cachedWords[i];
        const isSame = (cw.lineIndex != null && w0.lineIndex != null)
          ? (cw.lineIndex === w0.lineIndex)
          : (Math.abs(cw.centerY - w0.centerY) <= 10);
        if (!isSame) break;
        lineRight = Math.max(lineRight || 0, cw.right);
      }
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
  resetPositionForPage(direction = 1) {
    this.disableWordTransition();
    this.setNoTransition(true);
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
      }
    }, 300); // 300ms maximum lock lifetime

    const isBackward = direction < 0;
    if (!isBackward) {
      this.activeLineIndex = 0;
      this.activeWordIndex = 0;
    }

    if (this.pageChangeRafId) {
      cancelAnimationFrame(this.pageChangeRafId);
      this.pageChangeRafId = null;
    }

    this.pageChangeRafId = requestAnimationFrame(() => {
      this.pageChangeRafId = null;
      if (!this.enabled) {
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        return;
      }

      try {
        this.refreshLines();
        this.refreshWords();

        if (this.wordTracking) {
          if (this.cachedWords.length > 0) {
            const targetWordIdx = isBackward ? this.cachedWords.length - 1 : 0;
            this.activeWordIndex = targetWordIdx;
            const targetWord = this.cachedWords[targetWordIdx];

            if (targetWord && targetWord.lineIndex != null) {
              this.activeLineIndex = targetWord.lineIndex;
            } else if (this.cachedLines.length > 0) {
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
            this.applyPosition();
          }
        } else {
          if (this.cachedLines.length > 0) {
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
            this.applyPosition();
          }
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
        this.setNoTransition(false);
      });
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
      if (this.wordTracking) {
        if (this.isWordTransitioning) {
          if (this.wordTransitionTimer) {
            clearTimeout(this.wordTransitionTimer);
            this.wordTransitionTimer = null;
          }
          this.isWordTransitioning = false;
          this.disableWordTransition();
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
    }
  }

  applyPosition() {
    if (!this.rulerEl) return;

    if (this.enabled) {
      this.rulerEl.classList.add("is-visible");
      this.rulerEl.classList.remove("is-hidden");
      if (!this.isPageTransitioning) {
        this.rulerEl.classList.remove("is-page-transitioning");
      }
      if (this.rulerEl.style.display === "none") {
        this.rulerEl.style.display = "block";
      }
      this.rulerEl.style.opacity = "1";
    } else {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
    }

    const y = Number.isFinite(this.currentY) ? Math.round(this.currentY) : 150;
    const h = Number.isFinite(this.height) && this.height > 0 ? Math.round(this.height) : (this.manualHeight || 36);
    this.rulerEl.style.height = `${h}px`;

    if (this.wordTracking) {
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
      const currentLine = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
        ? this.cachedLines[this.activeLineIndex]
        : null;

      const isTwoCol = this.isTwoCol;
      let colLeft = currentLine ? (currentLine.columnLeft ?? currentLine.left) : null;
      let colWidth = currentLine ? (currentLine.columnWidth ?? currentLine.width) : null;

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
            colLeft = Math.max(0, (this.stageLeft != null ? this.stageLeft - 12 : 20));
            colWidth = (this.stageWidth != null ? this.stageWidth + 24 : (window.innerWidth - 40));
          }
        }
      }

      this.rulerEl.style.top = `${y}px`;
      this.rulerEl.style.left = `${Math.round(colLeft)}px`;
      this.rulerEl.style.right = "auto";
      this.rulerEl.style.width = `${Math.round(colWidth)}px`;
      this.rulerEl.style.maxWidth = "100%";
      this.rulerEl.style.transform = "none";
    }

    const stage = this.getStageElement();
    if (this.mode === "focus" && this.enabled && stage) {
      this.maskTopEl.style.display = "none";
      this.maskBottomEl.style.display = "none";
      this.maskLeftEl.style.display = "none";
      this.maskRightEl.style.display = "none";

      const stageRect = stage.getBoundingClientRect();
      const inactiveAlpha = Math.max(0.12, Math.min(0.65, Number((1 - this.dimOpacity).toFixed(2))));

      const relY = Math.max(0, Math.round(y - stageRect.top));
      const relH = Math.max(10, Math.round(h));

      let activeGradient = "";
      let activeSize = "";
      let activePos = "";

      if (this.wordTracking) {
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
        const currentLine = (this.activeLineIndex >= 0 && this.activeLineIndex < this.cachedLines.length)
          ? this.cachedLines[this.activeLineIndex]
          : null;

        let colLeft = currentLine ? (currentLine.columnLeft ?? currentLine.left) : null;
        let colWidth = currentLine ? (currentLine.columnWidth ?? currentLine.width) : null;

        if (colLeft == null || colWidth == null || !Number.isFinite(colLeft) || !Number.isFinite(colWidth) || colWidth < 80) {
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

        const relX = Math.max(0, Math.round(colLeft - stageRect.left));
        const relW = Math.max(80, Math.round(colWidth));

        activeGradient = "linear-gradient(#000, #000)";
        activeSize = `${relW}px ${relH}px`;
        activePos = `${relX}px ${relY}px`;
      }

      // Detekce a vyloučení multimediálních elementů (obrázky, ilustrace, SVG emblémy) z de-emphasis masky
      const mediaBoxes = [];
      const mediaEls = Array.from(stage.querySelectorAll("img, svg, figure, picture, canvas"));
      const rootMediaEls = mediaEls.filter(el => {
        return !el.parentElement || !el.parentElement.closest("img, svg, figure, picture, canvas");
      });

      for (const el of rootMediaEls) {
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2 &&
            r.bottom > stageRect.top + 2 && r.top < stageRect.bottom - 2 &&
            r.right > stageRect.left + 2 && r.left < stageRect.right - 2) {
          const mX = Math.max(0, Math.round(r.left - stageRect.left));
          const mY = Math.max(0, Math.round(r.top - stageRect.top));
          const mW = Math.min(Math.round(stageRect.width - mX), Math.round(r.width));
          const mH = Math.min(Math.round(stageRect.height - mY), Math.round(r.height));
          if (mW > 0 && mH > 0) {
            mediaBoxes.push({ x: mX, y: mY, w: mW, h: mH });
          }
        }
      }

      const gradients = [activeGradient];
      const sizes = [activeSize];
      const positions = [activePos];

      for (const mb of mediaBoxes) {
        gradients.push("linear-gradient(#000, #000)");
        sizes.push(`${mb.w}px ${mb.h}px`);
        positions.push(`${mb.x}px ${mb.y}px`);
      }

      gradients.push(`linear-gradient(rgba(0, 0, 0, ${inactiveAlpha}), rgba(0, 0, 0, ${inactiveAlpha}))`);
      sizes.push("100% 100%");
      positions.push("0px 0px");

      const maskImage = gradients.join(", ");
      const maskSize = sizes.join(", ");
      const maskPos = positions.join(", ");
      const maskRepeat = new Array(gradients.length).fill("no-repeat").join(", ");

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
    this.refreshLines();
    if (this.wordTracking) {
      this.refreshWords();
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
    } else if (this.cachedLines.length > 0) {
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
    } else {
      const stage = this.container || document.getElementById("paged-stage") || document.getElementById("reader-content") || document.body;
      const sRect = stage ? stage.getBoundingClientRect() : { top: 150, left: 40, width: 600 };
      this.targetY = (sRect.top > 0 && sRect.top < window.innerHeight) ? sRect.top + 40 : 150;
      this.currentY = this.targetY;
      this.height = this.manualHeight || 36;
    }

    this.rulerEl.style.display = "block";
    this.rulerEl.style.opacity = "1";
    this.rulerEl.classList.remove("is-hidden", "hidden");
    this.rulerEl.classList.add("is-visible");
    this.applyPosition();
  }

  updateStyles() {
    if (!this.rulerEl) return;

    if (this.wordTracking) {
      this.rulerEl.style.willChange = "transform";
    } else {
      this.rulerEl.style.willChange = "auto";
    }

    const isFocus = this.enabled && this.mode === "focus";
    const transitionClass = this.horizontalWordTransition ? "word-transition-active" : "word-transition-snap";
    const showSideMasks = isFocus && (this.wordTracking || this.isTwoCol);
    this.rulerEl.className = `reading-ruler mode-${this.mode} color-${this.color} ${this.enabled ? "is-visible" : "is-hidden"} ${this.wordTracking ? "word-tracking-mode " + transitionClass : ""}`;
    this.maskTopEl.className = `ruler-mask ruler-mask-top ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskBottomEl.className = `ruler-mask ruler-mask-bottom ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskLeftEl.className = `ruler-mask ruler-mask-left ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;
    this.maskRightEl.className = `ruler-mask ruler-mask-right ${showSideMasks ? "is-visible " + (this.wordTracking ? transitionClass : "") : "is-hidden"}`;

    if (this.enabled) {
      this.rulerEl.classList.add("is-visible");
      this.rulerEl.classList.remove("is-hidden");
      if (!this.isPageTransitioning) {
        this.rulerEl.classList.remove("is-page-transitioning");
      }
      this.rulerEl.style.display = "block";
      this.rulerEl.style.opacity = "1";
    } else {
      this.rulerEl.classList.remove("is-visible");
      this.rulerEl.classList.add("is-hidden");
      this.rulerEl.style.display = "none";
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

    document.body.classList.toggle("ruler-active", isRulerActive);
    document.body.classList.toggle("ruler-mouse-follow-active", isMouseFollow);
    document.body.classList.toggle("word-tracking-active", isWordTracking);
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
      this.updateRulerPosition(0);
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
  onPageChange(direction = 0, isPageChanged = true) {
    if (!this.enabled) return;
    this.isLineLocked = true;

    clearTimeout(this._navSafetyTimer);
    this._navSafetyTimer = setTimeout(() => {
      if (this.isNavigating || this.isLineLocked) {
        console.warn('Navigation lock timed out. Forcing release.');
        this.isNavigating = false;
        this.isNavigatingPage = false;
        this.isLineLocked = false;
        this.suppressLineAdvancement = false;
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
    const content = document.getElementById("reader-content");
    if (content && this._onTransitionEnd) {
      content.removeEventListener("transitionend", this._onTransitionEnd);
      this._onTransitionEnd = null;
    }

    this.isPageTransitioning = false;
    this.rulerEl?.classList.remove("is-page-transitioning");

    // Okamžité synchronní usazení pravítka na nové stránce podle směru listování
    this.resetPositionForPage(direction);
  }

  destroy() {
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
    this.clearFocusTextMask();
    document.body.classList.remove("ruler-active", "ruler-mouse-follow-active", "word-tracking-active");
  }
}
