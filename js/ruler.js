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
    this.mode = "highlight"; // "highlight" | "focus" | "underline"
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
    this.cachedLines = []; // Seznam řádků na aktuální stránce [{ top, bottom, height, centerY }]
    this.cachedWords = []; // Seznam slov na aktuální stránce [{ text, left, right, top, bottom, width, height, centerX, centerY }]
    this.activeLineIndex = -1;
    this.activeWordIndex = -1;
    this.animFrameId = null;
    this.isDragging = false;
    this.isPageTransitioning = false;
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
    this.holdPointerType = null;
    this.isHoldActive = false;
    this.isHoldTriggered = false;
    this.holdIndicatorEl = null;

    this.createDomElements();
    this.attachEvents();
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
      "button, a, input, select, textarea, [role='button'], .btn, .btn-icon, .drawer-panel, .drawer, .modal-dialog, .modal-overlay, .paged-footer-bar, .reader-header, .top-navbar, .ruler-quick-popover, .ruler-floating-controls"
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
  schedulePointerUpdate(clientX, clientY) {
    this.pendingPointerX = clientX;
    this.pendingPointerY = clientY;
    if (this.isPageTransitioning) {
      this.lastPointerX = clientX;
      this.lastPointerY = clientY;
      return;
    }
    if (!this.rafPointerPending) {
      this.rafPointerPending = true;
      requestAnimationFrame(() => {
        this.rafPointerPending = false;
        if (this.enabled && !this.isPageTransitioning) {
          this.handlePointerMove(this.pendingPointerX, this.pendingPointerY);
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
    if (!this.enabled || this.isPageTransitioning) return;
    if (!this.isPointerInStage(clientX, clientY)) return;
    if (this.followMode === "mouse" && pointerType === "mouse") return;

    this.cancelHold();

    this.holdStartX = clientX;
    this.holdStartY = clientY;
    this.holdPointerType = pointerType;
    this.isHoldActive = true;
    this.isHoldTriggered = false;

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
    this.dragCooldownEndTime = Date.now() + 500; // Bezpečnostní okno blokující následný syntetický klik

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

  cancelHold() {
    this.clearHoldTimer();
    this.isHoldActive = false;
    document.body.classList.remove("ruler-holding");
    if (this.holdIndicatorEl) {
      this.holdIndicatorEl.classList.remove("is-active", "is-completed");
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
      if (!this.enabled) return;
      if (this.isUiControl(e.target)) return;
      if (!this.isPointerInStage(e.clientX, e.clientY)) return;

      // Pro myš na PC vyžadujeme výhradně stisknuté levé tlačítko (button === 0)
      if (e.pointerType === "mouse" && e.button !== 0) return;

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.savePenDetails(e);
      }

      // Zahájit 1,1s podržení pro přemístění pravítka
      this.startHold(e.clientX, e.clientY, e.pointerType || "mouse");
    };

    const onPointerMove = (e) => {
      if (!this.enabled) return;

      if (e.pointerType === "pen") {
        this.lastPenTime = Date.now();
        this.savePenDetails(e);
      }

      // Pokud běží aktivní držení, zkontrolujeme prahový posun (tolerance 16px)
      if (this.isHoldActive) {
        const dx = Math.abs(e.clientX - this.holdStartX);
        const dy = Math.abs(e.clientY - this.holdStartY);
        if (dx > 16 || dy > 16) {
          this.cancelHold();
        }
      }

      // Plynulé sledování v reálném čase v režimu sledování myši ("mouse")
      if (this.followMode === "mouse" && e.pointerType === "mouse" && !this.isDraggingRuler) {
        if (!this.isUiControl(e.target) && this.isPointerInStage(e.clientX, e.clientY)) {
          this.schedulePointerUpdate(e.clientX, e.clientY);
        }
      }
    };

    const onPointerUp = (e) => {
      if (this.isHoldActive) {
        this.cancelHold();
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

    const onPointerCancel = (e) => {
      if (this.isHoldActive) {
        this.cancelHold();
      }
      this.isDraggingRuler = false;
      this.isPenTouching = false;
      this.activePointerId = null;
      this.activePointerType = null;
      this.dragCooldownEndTime = Date.now() + 350;
    };

    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
    window.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });

    // 2. TOUCH EVENTS (WebKit Safari fallback pro starší zařízení)
    const onTouchStart = (e) => {
      if (!this.enabled) return;
      if (this.isUiControl(e.target)) return;
      const touch = e.touches[0];
      if (touch && !this.isHoldActive && this.isPointerInStage(touch.clientX, touch.clientY)) {
        const isStylus = Array.from(e.touches).some(t => t.touchType === "stylus");
        this.startHold(touch.clientX, touch.clientY, isStylus ? "pen" : "touch");
      }
    };

    const onTouchMove = (e) => {
      if (!this.enabled) return;
      if (this.isHoldActive && e.touches.length > 0) {
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - this.holdStartX);
        const dy = Math.abs(touch.clientY - this.holdStartY);
        if (dx > 16 || dy > 16) {
          this.cancelHold();
        }
      }
    };

    const onTouchEnd = () => {
      if (this.isHoldActive) {
        this.cancelHold();
      }
    };

    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });

    // 3. MOUSEMOVE fallback (pro prohlížeče bez PointerEvents)
    window.addEventListener("mousemove", (e) => {
      if (!this.enabled || this.isDraggingRuler || this.isPenTouching) return;
      if (this.isUiControl(e.target) || !this.isPointerInStage(e.clientX, e.clientY)) {
        return;
      }
      if (this.followMode === "mouse") {
        this.schedulePointerUpdate(e.clientX, e.clientY);
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

    // 4. Klávesové ovládání (doplňkové klávesy j/k pro posun pravítka)
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      this.cancelHold();
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        this.stepLine(1);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        this.stepLine(-1);
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
  refreshLines() {
    const stage = this.container || document.getElementById("paged-stage");
    const content = document.getElementById("reader-content");
    if (!stage || !content) {
      this.cachedLines = [];
      return;
    }

    const stageRect = stage.getBoundingClientRect();
    const stageLeft = stageRect.left;
    const stageRight = stageRect.right;
    const stageTop = stageRect.top;
    const stageBottom = stageRect.bottom;

    const rawLines = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const range = document.createRange();

    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text || !text.trim()) continue;

      try {
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (
            r.right > stageLeft + 15 &&
            r.left < stageRight - 15 &&
            r.bottom > stageTop - 25 &&
            r.top < stageBottom + 25 &&
            r.height >= 10 &&
            r.width >= 10
          ) {
            rawLines.push({
              top: r.top,
              bottom: r.bottom,
              height: r.height,
              centerY: r.top + r.height / 2
            });
          }
        }
      } catch (err) {}
    }

    if (rawLines.length === 0) {
      const style = window.getComputedStyle(content);
      const computedLh = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.65) || 32;
      const startY = Math.max(70, stageTop + 20);
      const count = Math.max(3, Math.floor((stageRect.height - 40) / computedLh));
      for (let i = 0; i < count; i++) {
        const top = startY + i * computedLh;
        rawLines.push({
          top: top,
          bottom: top + computedLh,
          height: computedLh,
          centerY: top + computedLh / 2
        });
      }
    }

    rawLines.sort((a, b) => a.centerY - b.centerY);

    const clustered = [];
    for (const r of rawLines) {
      if (clustered.length === 0) {
        clustered.push({ ...r });
      } else {
        const prev = clustered[clustered.length - 1];
        if (Math.abs(r.centerY - prev.centerY) < 8) {
          prev.top = Math.min(prev.top, r.top);
          prev.bottom = Math.max(prev.bottom, r.bottom);
          prev.height = prev.bottom - prev.top;
          prev.centerY = prev.top + prev.height / 2;
        } else {
          clustered.push({ ...r });
        }
      }
    }

    this.cachedLines = clustered;

    if (this.autoHeight && this.cachedLines.length > 0) {
      const medianLine = this.cachedLines[Math.floor(this.cachedLines.length / 2)];
      this.updateEffectiveHeight(medianLine.height);
    }
  }

  /**
   * Zmapuje přesné obdélníky všech viditelných slov na aktuální stránce.
   */
  refreshWords() {
    const stage = this.container || document.getElementById("paged-stage");
    const content = document.getElementById("reader-content");
    if (!stage || !content) {
      this.cachedWords = [];
      return;
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
    const wordRegex = /[^\s\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF\u00AD]+/g;

    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text || !text.trim()) continue;

      let match;
      wordRegex.lastIndex = 0;
      while ((match = wordRegex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        try {
          range.setStart(node, start);
          range.setEnd(node, end);
          const clientRects = range.getClientRects();
          if (!clientRects || clientRects.length === 0) continue;

          // Pokud je slovo na jednom řádku (standardní případ), použijeme přesný getBoundingClientRect()
          if (clientRects.length === 1) {
            const bRect = range.getBoundingClientRect();
            if (
              bRect.right > stageLeft + 5 &&
              bRect.left < stageRight - 5 &&
              bRect.bottom > stageTop - 25 &&
              bRect.top < stageBottom + 25 &&
              bRect.width >= 2 &&
              bRect.width < stageRect.width * 0.85 &&
              bRect.height >= 8 &&
              bRect.height <= 65
            ) {
              words.push({
                text: match[0],
                left: bRect.left,
                right: bRect.right,
                top: bRect.top,
                bottom: bRect.bottom,
                width: bRect.width,
                height: bRect.height,
                centerX: bRect.left + bRect.width / 2,
                centerY: bRect.top + bRect.height / 2
              });
            }
          } else {
            // Zalomené slovo na více řádcích
            for (let rIdx = 0; rIdx < clientRects.length; rIdx++) {
              const rect = clientRects[rIdx];
              if (
                rect.right > stageLeft + 5 &&
                rect.left < stageRight - 5 &&
                rect.bottom > stageTop - 25 &&
                rect.top < stageBottom + 25 &&
                rect.width >= 2 &&
                rect.width < stageRect.width * 0.85 &&
                rect.height >= 8 &&
                rect.height <= 65
              ) {
                words.push({
                  text: match[0],
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                  centerX: rect.left + rect.width / 2,
                  centerY: rect.top + rect.height / 2
                });
              }
            }
          }
        } catch (e) {}
      }
    }

    // Seřadíme čtecím pořadím: shora dolů (tolerance 8px pro tentýž řádek), a zleva doprava
    words.sort((a, b) => {
      if (Math.abs(a.centerY - b.centerY) > 8) {
        return a.centerY - b.centerY;
      }
      return a.left - b.left;
    });

    this.cachedWords = words;
  }

  computeLineGeometry(lineIdx) {
    if (lineIdx < 0 || lineIdx >= this.cachedLines.length) return null;
    const line = this.cachedLines[lineIdx];
    let height = this.manualHeight;
    let targetY = line.top;

    if (this.autoHeight) {
      const baseH = Math.round(line.height);
      if (this.mode === "underline") {
        height = Math.max(16, baseH);
        targetY = line.bottom - height;
      } else if (this.mode === "focus") {
        let focusTop = line.top;
        let focusBottom = line.bottom;
        if (lineIdx > 0 && this.cachedLines[lineIdx - 1]) {
          const prevBottom = this.cachedLines[lineIdx - 1].bottom;
          focusTop = Math.max(prevBottom + 1, Math.min(line.top, (prevBottom + line.top) / 2));
        } else {
          focusTop = line.top - 2;
        }
        if (lineIdx < this.cachedLines.length - 1 && this.cachedLines[lineIdx + 1]) {
          const nextTop = this.cachedLines[lineIdx + 1].top;
          focusBottom = Math.min(nextTop - 1, Math.max(line.bottom, (line.bottom + nextTop) / 2));
        } else {
          focusBottom = line.bottom + 2;
        }
        targetY = Math.round(focusTop);
        height = Math.round(focusBottom - focusTop);
      } else {
        // Highlight mode
        height = Math.max(26, baseH + 8);
        targetY = line.top - 4;
      }
    } else {
      height = this.manualHeight;
      if (this.mode === "underline") {
        targetY = line.bottom - height;
      } else {
        targetY = Math.round(line.centerY - height / 2);
      }
    }

    return { height, targetY };
  }

  updateEffectiveHeight(lineHeight) {
    if (this.autoHeight) {
      const baseH = Math.round(lineHeight || 32);
      if (this.mode === "underline") {
        this.height = Math.max(16, baseH);
      } else if (this.mode === "focus") {
        this.height = baseH;
      } else {
        this.height = Math.max(26, baseH + 8);
      }
    } else {
      this.height = this.manualHeight;
    }
    this.applyPosition();
  }

  /**
   * Zpracuje pohyb ukazatele (myši nebo prstu)
   */
  handlePointerMove(clientX, clientY) {
    if (!this.enabled || this.isPageTransitioning) return;

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

    const curX = this.lastPointerX;
    const curY = this.lastPointerY;

    // --- REŽIM SLEDOVÁNÍ SLOV (Word-level Tracking) ---
    if (this.wordTracking) {
      if (this.cachedWords.length === 0) {
        this.refreshWords();
      }

      if (this.cachedWords.length > 0) {
        let closestWord = this.cachedWords[0];
        let minDiff = Infinity;
        let closestIdx = 0;

        // Posun o 8px nahoru pro přirozené vedení čtení zespodu (vodítko nezakrývá písmena)
        const effectiveY = curY - 8;

        for (let i = 0; i < this.cachedWords.length; i++) {
          const w = this.cachedWords[i];
          const dy = effectiveY < w.top ? w.top - effectiveY : effectiveY > w.bottom ? effectiveY - w.bottom : 0;
          const dx = curX < w.left ? w.left - curX : curX > w.right ? curX - w.right : 0;
          const dist = dy * 2.8 + dx; // Důraz na shodu v řádku
          if (dist < minDiff) {
            minDiff = dist;
            closestWord = w;
            closestIdx = i;
          }
        }

        this.activeWordIndex = closestIdx;
        this.activeLineIndex = -1;

        // Přesný symetrický padding: 3px po stranách (nezasahuje do sousedních slov), 2.5px vertikálně
        const padX = 3;
        const padY = 2.5;

        this.wordLeft = Math.round(closestWord.left - padX);
        this.wordWidth = Math.round(closestWord.width + padX * 2);

        if (this.autoHeight) {
          const baseH = Math.round(closestWord.height);
          this.height = this.mode === "underline" ? Math.max(16, baseH) : Math.round(baseH + padY * 2);
        }

        if (this.mode === "underline") {
          this.targetY = Math.round(closestWord.bottom - this.height);
        } else {
          this.targetY = Math.round(closestWord.top - padY);
        }

        this.currentY = this.targetY;
        this.rulerEl.classList.add("word-tracking-mode");
        this.rulerEl.classList.add("is-snapped");
        this.maskTopEl.classList.add("is-snapped");
        this.maskBottomEl.classList.add("is-snapped");
        this.maskLeftEl.classList.add("is-snapped");
        this.maskRightEl.classList.add("is-snapped");
        this.applyPosition();
        return;
      }
    }

    // --- STANDARDNÍ ŘÁDKOVÝ REŽIM ---
    this.rulerEl.classList.remove("word-tracking-mode");

    if (this.cachedLines.length === 0) {
      this.refreshLines();
    }

    if (this.snapToLines && this.cachedLines.length > 0) {
      let closestLine = this.cachedLines[0];
      let minDiff = Infinity;
      let closestIdx = 0;

      for (let i = 0; i < this.cachedLines.length; i++) {
        const line = this.cachedLines[i];
        const diff = Math.abs(curY - line.centerY);
        if (diff < minDiff) {
          minDiff = diff;
          closestLine = line;
          closestIdx = i;
        }
      }

      this.activeLineIndex = closestIdx;

      const geom = this.computeLineGeometry(closestIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
      }

      this.currentY = this.targetY;
      this.rulerEl.classList.add("is-snapped");
      this.maskTopEl.classList.add("is-snapped");
      this.maskBottomEl.classList.add("is-snapped");
      this.maskLeftEl.classList.add("is-snapped");
      this.maskRightEl.classList.add("is-snapped");
      this.applyPosition();
    } else {
      this.rulerEl.classList.remove("is-snapped");
      this.maskTopEl.classList.remove("is-snapped");
      this.maskBottomEl.classList.remove("is-snapped");
      this.maskLeftEl.classList.remove("is-snapped");
      this.maskRightEl.classList.remove("is-snapped");

      const maxY = window.innerHeight - this.height - 20;
      this.targetY = Math.max(60, Math.min(maxY, curY - this.height / 2));
      this.requestRender();
    }
  }

  /**
   * Posun o jeden řádek nebo slovo (krokování tlačítky na iPadu či šipkami)
   */
  stepLine(direction) {
    // Pokud probíhá přechod strany, aktivní tažení nebo ještě neuběhl cooldown po uvolnění, ignorovat krokování
    if (!this.enabled || this.isPageTransitioning || this.isInteracting()) return;
    this.cancelHold();

    if (this.wordTracking) {
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
        this.activeWordIndex = newIdx;

        const w = this.cachedWords[newIdx];
        const padX = 3;
        const padY = 2.5;

        this.wordLeft = Math.round(w.left - padX);
        this.wordWidth = Math.round(w.width + padX * 2);

        if (this.autoHeight) {
          const baseH = Math.round(w.height);
          this.height = this.mode === "underline" ? Math.max(16, baseH) : Math.round(baseH + padY * 2);
        }

        if (this.mode === "underline") {
          this.targetY = Math.round(w.bottom - this.height);
        } else {
          this.targetY = Math.round(w.top - padY);
        }

        this.currentY = this.targetY;
        this.rulerEl.classList.add("word-tracking-mode");
        this.rulerEl.classList.add("is-snapped");
        this.maskTopEl.classList.add("is-snapped");
        this.maskBottomEl.classList.add("is-snapped");
        this.maskLeftEl.classList.add("is-snapped");
        this.maskRightEl.classList.add("is-snapped");
        this.applyPosition();
        return;
      }
    }

    if (this.cachedLines.length === 0) {
      this.refreshLines();
    }

    if (this.snapToLines && this.cachedLines.length > 0) {
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

      const geom = this.computeLineGeometry(newIdx);
      if (geom) {
        this.height = geom.height;
        this.targetY = geom.targetY;
      }

      this.currentY = this.targetY;
      this.rulerEl.classList.add("is-snapped");
      this.maskTopEl.classList.add("is-snapped");
      this.maskBottomEl.classList.add("is-snapped");
      this.maskLeftEl.classList.add("is-snapped");
      this.maskRightEl.classList.add("is-snapped");
      this.applyPosition();
    } else {
      const step = Math.round(this.height * 0.75) * direction;
      this.moveBy(step);
    }
  }

  moveBy(deltaY) {
    this.targetY += deltaY;
    const maxY = window.innerHeight - this.height - 40;
    this.targetY = Math.max(65, Math.min(maxY, this.targetY));
    this.currentY = this.targetY;
    this.applyPosition();
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

  applyPosition() {
    if (!this.rulerEl) return;

    const y = Math.round(this.currentY);
    this.rulerEl.style.top = `${y}px`;
    this.rulerEl.style.height = `${this.height}px`;

    if (this.wordTracking) {
      this.rulerEl.style.left = `${Math.round(this.wordLeft)}px`;
      this.rulerEl.style.width = `${Math.round(this.wordWidth)}px`;
      this.rulerEl.style.right = "auto";
    } else {
      this.rulerEl.style.left = "0px";
      this.rulerEl.style.right = "0px";
      this.rulerEl.style.width = "auto";
    }

    if (this.mode === "focus" && this.enabled) {
      this.maskTopEl.style.display = "block";
      this.maskBottomEl.style.display = "block";
      this.maskTopEl.style.height = `${Math.max(0, y)}px`;
      this.maskBottomEl.style.top = `${y + this.height}px`;
      this.maskBottomEl.style.height = `${Math.max(0, window.innerHeight - (y + this.height))}px`;
      this.maskTopEl.style.opacity = this.dimOpacity;
      this.maskBottomEl.style.opacity = this.dimOpacity;

      if (this.wordTracking) {
        const leftW = Math.max(0, Math.round(this.wordLeft));
        const rightL = Math.max(0, Math.round(this.wordLeft + this.wordWidth));

        this.maskLeftEl.style.display = "block";
        this.maskLeftEl.style.top = `${y}px`;
        this.maskLeftEl.style.height = `${this.height}px`;
        this.maskLeftEl.style.left = "0px";
        this.maskLeftEl.style.right = "auto";
        this.maskLeftEl.style.width = `${leftW}px`;
        this.maskLeftEl.style.opacity = this.dimOpacity;

        this.maskRightEl.style.display = "block";
        this.maskRightEl.style.top = `${y}px`;
        this.maskRightEl.style.height = `${this.height}px`;
        this.maskRightEl.style.left = `${rightL}px`;
        this.maskRightEl.style.right = "0px";
        this.maskRightEl.style.width = "auto";
        this.maskRightEl.style.opacity = this.dimOpacity;
      } else {
        this.maskLeftEl.style.display = "none";
        this.maskRightEl.style.display = "none";
      }
    } else {
      this.maskTopEl.style.display = "none";
      this.maskBottomEl.style.display = "none";
      this.maskLeftEl.style.display = "none";
      this.maskRightEl.style.display = "none";
    }
  }

  updateStyles() {
    if (!this.rulerEl) return;

    const isFocus = this.enabled && this.mode === "focus";
    this.rulerEl.className = `reading-ruler mode-${this.mode} color-${this.color} ${this.enabled ? "is-visible" : "is-hidden"} ${this.wordTracking ? "word-tracking-mode" : ""}`;
    this.maskTopEl.className = `ruler-mask ruler-mask-top ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskBottomEl.className = `ruler-mask ruler-mask-bottom ${isFocus ? "is-visible" : "is-hidden"}`;
    this.maskLeftEl.className = `ruler-mask ruler-mask-left ${isFocus && this.wordTracking ? "is-visible" : "is-hidden"}`;
    this.maskRightEl.className = `ruler-mask ruler-mask-right ${isFocus && this.wordTracking ? "is-visible" : "is-hidden"}`;

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
    }
    this.updateStyles();
    this.updateBodyClasses();

    if (this.enabled) {
      this.refreshLines();
      if (this.wordTracking) this.refreshWords();
      if (this.followMode === "mouse" && this.lastPointerY != null && this.isPointerInStage(this.lastPointerX, this.lastPointerY)) {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      } else if (this.wordTracking && this.cachedWords.length > 0 && this.activeWordIndex < 0) {
        this.stepLine(0);
      } else if (this.snapToLines && this.cachedLines.length > 0 && this.activeLineIndex < 0) {
        this.stepLine(0);
      }
    }
  }

  setMode(mode) {
    if (["highlight", "focus", "underline"].includes(mode)) {
      this.mode = mode;
      this.updateEffectiveHeight();
      this.updateStyles();
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
    this.autoHeight = !!enabled;
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
    this.snapToLines = !!enabled;
    if (this.snapToLines) {
      this.refreshLines();
      if (this.followMode === "mouse" && this.lastPointerY != null) {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      } else if (this.cachedLines.length > 0) {
        this.stepLine(0);
      }
    } else {
      this.rulerEl.classList.remove("is-snapped");
      this.maskTopEl.classList.remove("is-snapped");
      this.maskBottomEl.classList.remove("is-snapped");
      this.maskLeftEl.classList.remove("is-snapped");
      this.maskRightEl.classList.remove("is-snapped");
      if (this.followMode === "mouse" && this.lastPointerY != null) {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      }
    }
  }

  setWordTracking(enabled) {
    this.wordTracking = !!enabled;
    this.updateBodyClasses();
    if (this.wordTracking) {
      this.refreshWords();
      if (this.cachedWords.length > 0) {
        this.handlePointerMove(this.lastPointerX, this.lastPointerY);
      }
    } else {
      this.rulerEl.classList.remove("word-tracking-mode");
      this.applyPosition();
      this.handlePointerMove(this.lastPointerX, this.lastPointerY);
    }
    this.updateStyles();
  }

  setDimOpacity(opacity) {
    this.dimOpacity = Math.max(0.1, Math.min(0.95, parseFloat(opacity) || 0.65));
    this.updateStyles();
  }

  setFollowMode(mode) {
    this.followMode = mode;
    this.updateBodyClasses();
    if (this.enabled && this.followMode === "mouse" && this.lastPointerY != null && this.isPointerInStage(this.lastPointerX, this.lastPointerY)) {
      this.handlePointerMove(this.lastPointerX, this.lastPointerY);
    }
  }


  /**
   * Vyvolá se při přechodu na jinou stránku nebo kapitolu
   */
  onPageChange(direction = 0, isPageChanged = true) {
    if (!this.enabled) return;

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

    // 1. Okamžitá invalidace všech uložených pozic a rozměrů slov/řádků
    this.cachedWords = [];
    this.cachedLines = [];
    this.activeWordIndex = -1;
    this.activeLineIndex = -1;
    this.wordLeft = 0;
    this.wordWidth = 0;
    this.isPageTransitioning = true;

    // 2. Vizuální skrytí pravítka během animace přechodu strany (maska zůstává ztmavená, aby nedošlo k probliknutí bílé)
    this.rulerEl?.classList.add("is-page-transitioning");

    const finishPageChange = () => {
      if (!this.isPageTransitioning) return;
      this.isPageTransitioning = false;
      if (this.pageChangeTimer) {
        clearTimeout(this.pageChangeTimer);
        this.pageChangeTimer = null;
      }
      if (content && this._onTransitionEnd) {
        content.removeEventListener("transitionend", this._onTransitionEnd);
        this._onTransitionEnd = null;
      }

      // Přepočet přesných rozměrů a ohraničení z nového statického DOMu
      this.refreshLines();
      if (this.wordTracking) {
        this.refreshWords();
      }

      // Usazení pravítka na nové stránce
      if (this.followMode === "mouse") {
        const isMouseInStage = this.isPointerInStage(this.lastPointerX, this.lastPointerY);

        if (isMouseInStage) {
          this.handlePointerMove(this.lastPointerX, this.lastPointerY);
        } else if (this.wordTracking && this.cachedWords.length > 0) {
          this.activeWordIndex = direction < 0 ? this.cachedWords.length - 1 : 0;
          this.stepLine(0);
        } else if (this.snapToLines && this.cachedLines.length > 0) {
          this.activeLineIndex = direction < 0 ? this.cachedLines.length - 1 : 0;
          this.stepLine(0);
        }
      } else if (this.wordTracking && this.cachedWords.length > 0) {
        this.activeWordIndex = direction < 0 ? this.cachedWords.length - 1 : 0;
        this.stepLine(0);
      } else if (this.snapToLines && this.cachedLines.length > 0) {
        this.activeLineIndex = direction < 0 ? this.cachedLines.length - 1 : 0;
        this.stepLine(0);
      }

      // Odkrytí pravítka s čistě přepočtenými souřadnicemi
      this.rulerEl?.classList.remove("is-page-transitioning");
    };

    if (!isPageChanged) {
      requestAnimationFrame(finishPageChange);
      return;
    }

    if (content) {
      this._onTransitionEnd = (e) => {
        if (e.target === content && e.propertyName === "transform") {
          finishPageChange();
        }
      };
      content.addEventListener("transitionend", this._onTransitionEnd, { once: true });
    }
    // Pojistný časovač pro případ, že se transitionend nevyvolá (délka CSS přechodu je 200ms)
    this.pageChangeTimer = setTimeout(finishPageChange, 230);
  }

  destroy() {
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
    document.body.classList.remove("ruler-active", "ruler-mouse-follow-active", "word-tracking-active");
  }
}
