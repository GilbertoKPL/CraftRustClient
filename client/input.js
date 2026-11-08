// Only first-person gameplay captures the mouse; menus use the browser cursor.
class CraftInput {
  look = false; held = false; playing = false; paused = false; ui = false; suspended = false; pauseQueued = false; x = 0; y = 0;
  escapeHeld = false; resumeOnEscapeUp = false; unlockedEscape = false; releasePending = false;
  captureNotBefore = 0; captureAttempts = 0; captureRetry = null; pendingKey = null;
  capturedBefore = false; resumePending = false;
  constructor(canvas, getExports) {
    this.canvas = canvas; this.exports = getExports;
    this.cursor = document.createElement("div");
    this.cursor.id = "game-cursor"; this.cursor.hidden = true;
    document.body.append(this.cursor);
    this.notice = document.createElement("div");
    this.notice.id = "capture-notice"; this.notice.hidden = true; this.notice.role = "status";
    this.notice.textContent = "Pressione uma tecla de jogo ou clique para continuar.";
    document.body.append(this.notice);
    this.beforeUnload = event => {
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("fullscreenchange", () => this.syncKeyboardLock());
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === canvas;
      if (locked) {
        this.requestPending = false;
        if (!this.look) { this.release(); return; }
        this.held = true; this.notice.hidden = true;
        this.capturedBefore = true; this.resumePending = false;
        this.captureAttempts = 0;
        queueMicrotask(() => { if (this.look && this.held) this.resumeKey?.(); });
      }
      else if (this.releasePending) {
        this.releasePending = false; this.held = false;
        // An inventory can close before the browser finishes its unlock. Once
        // that release completes, capture again if Rust has returned to play.
        this.queueCapture();
      }
      else if (this.held) {
        // A physical Escape reaches the browser before JavaScript. Chromium
        // can block recapture for 1.25s. Remember the deadline for a rejected
        // request, but let browsers that allow immediate recapture try first.
        this.held = false;
        if (this.look) {
          this.captureNotBefore = performance.now() + 1300;
          this.unlockedEscape = true; this.pause();
        }
      }
      this.paint();
    });
    document.addEventListener("pointerlockerror", () => {
      if (!this.promiseRequest) { this.requestPending = false; this.denied(); }
    });
    window.addEventListener("blur", () => {
      this.escapeHeld = false; this.resumeOnEscapeUp = false; this.unlockedEscape = false;
      if (this.playing && (this.held || this.look)) this.pause();
    });
  }
  setState(flags) {
    const wasLook = this.look, wasPlaying = this.playing, wasPaused = this.paused, wasUi = this.ui;
    this.playing = !!(flags & 1);
    this.paused = !!(flags & 2);
    this.ui = !!(flags & 4);
    this.dead = !!(flags & 8);
    if (this.playing !== wasPlaying) {
      // Reserved tab shortcuts can bypass keydown entirely outside fullscreen.
      // Keep the browser's leave confirmation through pause/inventory as well.
      window[this.playing ? "addEventListener" : "removeEventListener"]("beforeunload", this.beforeUnload);
      this.syncKeyboardLock();
    }
    if ((!this.playing && wasPlaying) || (this.paused && !wasPaused) || (this.ui && wasLook)) this.cancelCapture();
    if (!this.playing || this.paused || this.ui) {
      this.pauseQueued = false;
      this.suspended = false;
      // Clear ownership before releasing: this is an intentional UI transition,
      // not the browser's Escape gesture asking Rust to open the pause menu.
      this.release();
    }
    if (!this.playing || this.paused || this.ui) this.notice.hidden = true;
    if (!this.playing) {
      this.notice.hidden = true;
      this.escapeHeld = false; this.resumeOnEscapeUp = false; this.unlockedEscape = false;
    }
    this.look = this.playing && !this.paused && !this.ui && !this.suspended;
    if (this.look && !wasLook) {
      // Resume gameplay within the closing gesture. Relative mouse events are
      // also available unlocked, so a browser cooldown need not freeze input.
      this.resumePending = this.capturedBefore && (wasPaused || wasUi);
      // A Continue click can resume even when the browser swallowed Escape's
      // keyup. Do not let that old key suppress Escape in the next inventory.
      this.escapeHeld = false; this.resumeOnEscapeUp = false; this.unlockedEscape = false;
      this.x = this.canvas.width / 2; this.y = this.canvas.height / 2;
      this.queueCapture();
    }
    this.paint();
    this.mobile?.update();
  }
  syncKeyboardLock() {
    const keyboard = globalThis.navigator?.keyboard;
    const fullscreen = document.fullscreenElement;
    const active = this.playing && !!fullscreen
      && (fullscreen === this.canvas || fullscreen.contains(this.canvas));
    if (!active) {
      if (this.keyboardLockRequested) keyboard?.unlock();
      this.keyboardLockRequested = false;
    } else if (!this.keyboardLockRequested && keyboard?.lock) {
      // Ctrl+W is reserved by Chromium even with preventDefault. Keyboard Lock
      // delivers it in API fullscreen; leave Escape available to exit normally.
      this.keyboardLockRequested = true;
      try { Promise.resolve(keyboard.lock(["KeyW"])).catch(() => {}); }
      catch { /* Unsupported/denied: beforeunload still protects the session. */ }
    }
  }
  grab(look) {
    // SetCursorGrab is queued by Miniquad. It cannot tell us whether Esc has
    // already opened a menu; only setState's Rust snapshot is authoritative.
    if (look && this.look) this.request();
    this.paint();
  }
  release() {
    this.held = false;
    if (!this.releasePending && document.pointerLockElement === this.canvas) {
      this.releasePending = true;
      document.exitPointerLock();
    }
  }
  queueCapture() {
    // Rust may still own Miniquad's event-handler borrow. Capture after it
    // returns, within the closing gesture rather than waiting for a game frame.
    if (!this.captureQueued) {
      this.captureQueued = true;
      queueMicrotask(() => { this.captureQueued = false; if (this.look) this.request(); });
    }
  }
  request() {
    if (this.mobile) return;
    if (!this.look || this.suspended || this.releasePending || document.pointerLockElement === this.canvas) return;
    if (this.requestPending || this.captureRetry !== null) return;
    this.requestPending = true; this.promiseRequest = false;
    this.captureAttempts++;
    const epoch = this.captureEpoch;
    this.canvas.focus();
    try {
      const request = this.canvas.requestPointerLock();
      if (request?.then) {
        this.promiseRequest = true;
        request.then(() => { if (epoch === this.captureEpoch) this.requestPending = false; }, error => {
          if (epoch === this.captureEpoch) { this.requestPending = false; this.denied(error); }
        });
      }
      // Legacy requestPointerLock completes through pointerlockchange/error.
    } catch (error) { this.requestPending = false; this.denied(error); }
  }
  cancelCapture() {
    this.captureEpoch = (this.captureEpoch || 0) + 1;
    this.requestPending = false;
    if (this.captureRetry !== null) clearTimeout(this.captureRetry);
    this.captureRetry = null; this.captureAttempts = 0; this.pendingKey = null;
    this.resumePending = false;
  }
  retryCapture(delay) {
    if (this.captureRetry !== null) return;
    this.notice.textContent = "Voltando ao jogo...";
    this.notice.hidden = this.resumePending;
    this.captureRetry = setTimeout(() => {
      this.captureRetry = null;
      if (this.look && !this.suspended) this.request();
    }, delay);
  }
  denied(error) {
    if (!this.look || this.suspended) return;
    // Retry a temporary browser cooldown once, with enough spacing to respect
    // its request rate limit. Permission/focus/activation errors need a gesture.
    if (this.captureAttempts < 2) {
      const message = error?.message || "";
      const remaining = this.captureNotBefore - performance.now();
      const delay = /immediately after.*exited the lock/i.test(message)
        ? (remaining > 0 ? remaining : 1300)
        : /too many pointer lock requests/i.test(message) ? 2100 : 0;
      if (delay) { this.captureNotBefore = performance.now() + delay; this.retryCapture(delay); return; }
    }
    this.notice.textContent = "Pressione uma tecla de jogo ou clique para continuar.";
    this.notice.hidden = false;
    this.resumePending = false;
    this.paint();
  }
  pause() {
    if (!this.playing || this.paused || this.ui || this.pauseQueued) return;
    this.cancelCapture();
    this.pauseQueued = true; this.suspended = true; this.look = false; this.held = false;
    this.release();
    // An idempotent request consumed by Rust on the next update, never a
    // synthetic key which could toggle pause twice and flood StopUsing packets.
    this.exports()?.cr_web_pause();
    this.paint();
  }
  paint() {
    const cursor = this.look && (this.held || this.resumePending) ? "none" : "";
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
    this.cursor.hidden = !(this.held && !this.look);
    // The browser cursor handles menus. A hidden software cursor needs no
    // layout read or position writes on every Rust state publication.
    if (this.cursor.hidden) return;
    const rect = this.canvas.getBoundingClientRect();
    this.cursor.style.left = rect.left + this.x * rect.width / this.canvas.width + "px";
    this.cursor.style.top = rect.top + this.y * rect.height / this.canvas.height + "px";
  }
  controlsReady() {
    return this.look && (!!this.mobile || document.pointerLockElement === this.canvas || this.resumePending);
  }
  install() {
    const canvas = this.canvas;
    // Right click opens containers and manipulates stacks. Opening a container
    // releases pointer lock mid-click, but must never open the browser menu.
    canvas.oncontextmenu = event => event.preventDefault();
    canvas.onauxclick = event => event.preventDefault();
    canvas.ondragstart = event => event.preventDefault();
    const keydown = canvas.onkeydown, keyup = canvas.onkeyup;
    const preventBrowserShortcut = event => {
      // Ctrl is also sprint: Ctrl+D must move right without bookmarking the
      // page. Menus still belong to the focused canvas after releasing capture.
      // Keep native clipboard events (Miniquad handles copy/cut/paste) and
      // AltGraph text entry; cancel Alt on release too, to avoid browser menus.
      const clipboard = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && /^(Key[CXV]|Insert)$/.test(event.code);
      if (!clipboard && !event.getModifierState?.("AltGraph")
          && (event.ctrlKey || event.metaKey || event.altKey || /^Alt(Left|Right)$/.test(event.code)
            || /^(Tab|Backspace|Space|Arrow(Up|Down|Left|Right)|F([1-9]|10))$/.test(event.code))) {
        event.preventDefault?.();
      }
    };
    this.resumeKey = () => {
      const event = this.pendingKey; this.pendingKey = null;
      if (event && document.pointerLockElement === canvas) keydown(event);
    };
    canvas.onkeydown = event => {
      preventBrowserShortcut(event);
      if (event.code === "Escape" && this.playing) {
        if (event.repeat || this.escapeHeld) return;
        this.escapeHeld = true;
        // Recapturing while the browser is still processing its unlock key can
        // fail and reopen pause. Resume on release, within this user gesture.
        this.resumeOnEscapeUp = (this.paused || this.ui) && !this.unlockedEscape;
        if (!this.paused && !this.ui) this.pause();
        this.notice.hidden = true;
        return;
      }
      if (this.look && !this.controlsReady()) {
        if (!event.repeat && !event.altKey && !event.metaKey && !event.ctrlKey
            && /^(Key[WASDETFQ]|Digit[1-9]|Space|ShiftLeft|ShiftRight|Arrow(Up|Down|Left|Right))$/.test(event.code)) {
          event.preventDefault?.();
          this.pendingKey = event;
          this.request();
        }
        return;
      }
      keydown(event);
    };
    canvas.onkeyup = event => {
      preventBrowserShortcut(event);
      if (this.pendingKey?.code === event.code) this.pendingKey = null;
      if (event.code === "Escape") {
        const resume = this.resumeOnEscapeUp;
        this.escapeHeld = false; this.resumeOnEscapeUp = false; this.unlockedEscape = false;
        if (resume && this.playing && (this.paused || this.ui)) keydown(event);
      }
      keyup(event);
    };
    const position = event => {
      const rect = canvas.getBoundingClientRect();
      return [(event.clientX - rect.left) * canvas.width / rect.width,
        (event.clientY - rect.top) * canvas.height / rect.height];
    };
    canvas.onmousemove = event => {
      const api = this.exports();
      if (document.pointerLockElement === canvas) {
        if (this.look) api.raw_mouse_move(event.movementX || 0, event.movementY || 0);
        else {
          const rect = canvas.getBoundingClientRect();
          this.x = Math.max(0, Math.min(canvas.width - 1, this.x + (event.movementX || 0) * canvas.width / rect.width));
          this.y = Math.max(0, Math.min(canvas.height - 1, this.y + (event.movementY || 0) * canvas.height / rect.height));
          api.mouse_move(this.x, this.y); this.paint();
        }
      } else if (this.controlsReady()) api.raw_mouse_move(event.movementX || 0, event.movementY || 0);
      else if (!this.look) api.mouse_move(...position(event));
    };
    const button = event => event.button === 2 ? 1 : event.button === 1 ? 2 : 0;
    // A click consumed to capture must consume its release as well, even if
    // capture completes or a pause menu opens between the two events.
    const captureButtons = new Set();
    canvas.onmousedown = event => {
      event.preventDefault?.();
      canvas.focus();
      if (![0, 1, 2].includes(event.button)) return;
      if (this.look && !this.controlsReady()) {
        captureButtons.add(event.button); this.request(); return;
      }
      // Resume can temporarily accept input during Chromium's unlock cooldown.
      // Every fresh click is also a user gesture for browsers requiring one.
      if (this.look && document.pointerLockElement !== canvas) this.request();
      const xy = this.held && !this.look ? [this.x, this.y] : position(event);
      this.exports().mouse_down(...xy, button(event));
    };
    canvas.onmouseup = event => {
      event.preventDefault?.();
      if (captureButtons.delete(event.button) || ![0, 1, 2].includes(event.button)) return;
      if (this.look && !this.controlsReady()) return;
      const xy = this.held && !this.look ? [this.x, this.y] : position(event);
      this.exports().mouse_up(...xy, button(event));
    };
    if (globalThis.navigator?.maxTouchPoints > 0 && globalThis.matchMedia?.("(pointer: coarse)").matches) {
      this.mobile = new CraftTouch(this);
    }
  }
}
// Touch adapts platform input. Rust owns all menus, gameplay and networking.
class CraftTouch {
  pointers = new Map(); keys = new Set(); buttons = new Set(); composing = false;
  constructor(input) {
    this.input = input; this.canvas = input.canvas;
    this.root = document.createElement("div"); this.root.id = "touch-controls";
    this.root.innerHTML = `
      <div class="touch-top">
        <button data-key="256" aria-label="Pausa ou voltar">☰</button>
        <button data-key="69" data-play>Inventário</button>
        <button data-key="84" data-play>Chat</button>
        <button data-key="257" data-respawn>Renascer</button>
        <button data-fullscreen aria-label="Tela cheia">⛶</button>
      </div>
      <div class="touch-play">
        <div class="touch-stick" aria-label="Arraste para andar"><span></span></div>
        <div class="touch-actions">
          <button data-mouse="0">Quebrar / atacar</button>
          <button data-mouse="1">Colocar / usar</button>
          <button data-hold="32">Pular</button>
          <button data-hold="340">Agachar</button>
          <button data-hold="341">Correr</button>
        </div>
        <div class="touch-hotbar" aria-label="Barra de itens">${Array.from({length: 9}, (_, i) => `<button data-key="${49 + i}">${i + 1}</button>`).join("")}</div>
      </div>`;
    document.body.append(this.root);
    this.play = this.root.querySelector(".touch-play");
    this.stick = this.root.querySelector(".touch-stick");
    this.knob = this.stick.firstElementChild;
    this.editor = document.createElement("input"); this.editor.id = "touch-text";
    this.editor.type = "text"; this.editor.autocomplete = "off";
    this.editor.autocapitalize = "off"; this.editor.spellcheck = false;
    this.editor.enterKeyHint = "done"; this.editor.hidden = true;
    this.editor.setAttribute("aria-label", "Digitar no jogo");
    document.body.append(this.editor);
    this.editor.addEventListener("compositionstart", () => { this.composing = true; });
    this.editor.addEventListener("compositionend", () => { this.composing = false; this.edit(); });
    this.editor.addEventListener("input", () => { if (!this.composing) this.edit(); });
    this.editor.addEventListener("select", () => { if (!this.syncing && !this.composing) this.edit(); });
    this.editor.addEventListener("keydown", event => {
      if (event.isComposing || this.composing || event.keyCode === 229) return;
      if (["Enter", "Escape", "Tab"].includes(event.key)) {
        event.preventDefault(); this.edit();
        this.tap(event.key === "Enter" ? 257 : event.key === "Tab" ? 258 : 256);
        if (event.key !== "Tab") this.editor.blur();
      }
      event.stopPropagation();
    });
    this.root.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const button = event.target.closest("button");
      if (!button && !this.stick.contains(event.target)) return;
      event.preventDefault(); event.target.setPointerCapture?.(event.pointerId);
      if (button?.hasAttribute("data-fullscreen")) {
        const request = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
        request?.catch(() => {}); return;
      }
      if (button?.dataset.key) {
        this.tap(Number(button.dataset.key)); this.focusText(); return;
      }
      if (!input.look) return;
      let pointer;
      if (button?.dataset.hold) {
        pointer = {key: Number(button.dataset.hold)};
        if (![...this.pointers.values()].some(p => p.key === pointer.key)) this.key(pointer.key, true);
      } else if (button?.dataset.mouse) {
        pointer = {button: Number(button.dataset.mouse)};
        if (!this.buttons.has(pointer.button)) {
          this.buttons.add(pointer.button);
          input.exports().mouse_down(this.canvas.width / 2, this.canvas.height / 2, pointer.button);
        }
      } else {
        if ([...this.pointers.values()].some(p => p.stick)) return;
        pointer = {stick: true}; this.moveStick(event);
      }
      this.pointers.set(event.pointerId, pointer);
    });
    this.root.addEventListener("pointermove", event => {
      if (this.pointers.get(event.pointerId)?.stick) this.moveStick(event);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.root.addEventListener(name, event => this.end(event.pointerId));
    }
    // Consume Miniquad's legacy touch-to-mouse path: each finger has a role.
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      this.canvas.addEventListener(name, event => { event.preventDefault(); event.stopImmediatePropagation(); }, {capture: true, passive: false});
    }
    this.canvas.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch") return;
      event.preventDefault(); this.canvas.setPointerCapture?.(event.pointerId);
      if (input.look) this.pointers.set(event.pointerId, {look: true, x: event.clientX, y: event.clientY});
      else {
        const xy = this.position(event);
        input.exports().mouse_move(...xy); input.exports().mouse_down(...xy, 0);
        this.pointers.set(event.pointerId, {menu: true}); this.focusText(event);
      }
    });
    this.canvas.addEventListener("pointermove", event => {
      const p = this.pointers.get(event.pointerId);
      if (p?.look && input.look) {
        input.exports().raw_mouse_move(event.clientX - p.x, event.clientY - p.y);
        p.x = event.clientX; p.y = event.clientY;
      } else if (p?.menu && !input.look) input.exports().mouse_move(...this.position(event));
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.canvas.addEventListener(name, event => this.end(event.pointerId, event));
    }
    window.addEventListener("blur", () => this.reset());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.reset(); input.pause(); }
    });
    window.addEventListener("resize", () => this.layoutText());
    window.visualViewport?.addEventListener("resize", () => this.layoutText());
    window.visualViewport?.addEventListener("scroll", () => this.layoutText());
    this.update();
  }
  position(event) {
    const r = this.canvas.getBoundingClientRect();
    return [(event.clientX - r.left) * this.canvas.width / r.width, (event.clientY - r.top) * this.canvas.height / r.height];
  }
  key(code, down) {
    if (down === this.keys.has(code)) return;
    if (down) this.keys.add(code); else this.keys.delete(code);
    this.input.exports()?.[down ? "key_down" : "key_up"](code, 0, false);
  }
  tap(code) {
    this.input.exports().key_down(code, 0, false);
    this.input.exports().key_up(code, 0);
  }
  moveStick(event) {
    const r = this.stick.getBoundingClientRect();
    const x = (event.clientX - r.left - r.width / 2) / (r.width / 2);
    const y = (event.clientY - r.top - r.height / 2) / (r.height / 2);
    const length = Math.max(1, Math.hypot(x, y));
    this.knob.style.transform = `translate(${x / length * 32}px, ${y / length * 32}px)`;
    for (const [code, down] of [[87, y < -.25], [83, y > .25], [65, x < -.25], [68, x > .25]]) this.key(code, down);
  }
  end(id, event) {
    const p = this.pointers.get(id); if (!p) return;
    this.pointers.delete(id);
    if (p.stick) { for (const code of [87, 83, 65, 68]) this.key(code, false); this.knob.style.transform = ""; }
    if (p.key !== undefined && ![...this.pointers.values()].some(q => q.key === p.key)) this.key(p.key, false);
    if (p.button !== undefined && ![...this.pointers.values()].some(q => q.button === p.button)) {
      this.buttons.delete(p.button);
      this.input.exports().mouse_up(this.canvas.width / 2, this.canvas.height / 2, p.button);
    }
    if (p.menu) this.input.exports().mouse_up(...(event ? this.position(event) : [0, 0]), 0);
  }
  reset() {
    for (const id of [...this.pointers.keys()]) this.end(id);
    for (const code of [...this.keys]) this.key(code, false);
  }
  update() {
    const active = this.input.look && !this.input.dead;
    if (active !== this.wasLook) {
      this.play.hidden = !active;
      for (const b of this.root.querySelectorAll("[data-play]")) b.hidden = !active;
    }
    if (this.wasDead !== this.input.dead) this.root.querySelector("[data-respawn]").hidden = !this.input.dead;
    if (!active && this.wasLook) queueMicrotask(() => this.reset());
    this.wasLook = active; this.wasDead = this.input.dead;
  }
  setText(state) {
    const changed = this.text?.id !== state?.id;
    this.text = state; this.editor.hidden = !state;
    if (!state) { this.editor.blur(); return; }
    if (changed) { this.editor.setAttribute("aria-label", state.label); this.editor.placeholder = state.label; }
    if (changed || (document.activeElement !== this.editor && !this.composing)) {
      this.syncing = true; this.editor.value = state.text;
      const caret = Array.from(state.text).slice(0, state.caret).join("").length;
      this.editor.setSelectionRange(state.select_all ? 0 : caret, state.select_all ? state.text.length : caret);
      this.syncing = false;
    }
    this.layoutText();
  }
  layoutText() {
    if (!this.text) return;
    const r = this.canvas.getBoundingClientRect(), rect = this.text.rect;
    const viewport = window.visualViewport;
    const bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
    const x = rect ? r.left + rect[0] * r.width / this.canvas.width : 12;
    let y = rect ? r.top + rect[1] * r.height / this.canvas.height : bottom - 56;
    const width = rect ? rect[2] * r.width / this.canvas.width : window.innerWidth - 24;
    const height = Math.max(36, rect ? rect[3] * r.height / this.canvas.height : 44);
    y = Math.max(viewport?.offsetTop || 0, Math.min(y, bottom - height - 8));
    Object.assign(this.editor.style, {left: x + "px", top: y + "px", width: width + "px", height: height + "px"});
  }
  focusText(event) {
    if (!this.text) return;
    if (event && this.text.rect) {
      const [x, y] = this.position(event), [left, top, w, h] = this.text.rect;
      if (x < left || x > left + w || y < top || y > top + h) return;
    }
    this.editor.focus({preventScroll: true});
  }
  edit() {
    if (!this.text || this.composing) return;
    const data = new TextEncoder().encode(JSON.stringify({id: this.text.id, text: this.editor.value,
      caret: Array.from(this.editor.value.slice(0, this.editor.selectionStart)).length}));
    if (data.length > 16384) return;
    const api = this.input.exports(), ptr = api.allocate_vec_u8(data.length);
    // Allocation may grow memory; resolve the buffer afterwards.
    new Uint8Array(wasm_memory.buffer, ptr, data.length).set(data);
    api.cr_web_text_edit(ptr, data.length);
  }
}
globalThis.CraftInput = CraftInput;
