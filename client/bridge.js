// Only platform services. The entire game, menus and HUD run in client.wasm.
(() => {
  // The running server serves both the game page and its WebSocket gateway.
  const gameServer = () => new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play`);
  function socketUrl(address) {
    const server = gameServer();
    const host = new URL(`${server.protocol}//${address}`).host;
    if (host === server.host) return server.href;
    return `${location.protocol === "https:" ? "wss" : "ws"}://${address}/play`;
  }
  const resource = (path) => globalThis.craftAssets ? craftAssets.fetch(path) : fetch(path);
  const decoder = new TextDecoder(),
    encoder = new TextEncoder(),
    sockets = new Map();
  const meshPool = new CraftMeshPool();
  let terrain;
  globalThis.craftTerrainStats = () => ({meshes: terrain?.meshes.size ?? 0,
    bytes: terrain?.bytes ?? 0, dataBytes: terrain?.dataBytes ?? 0,
    legacyBytes: terrain?.legacyBytes ?? 0, draws: terrain?.draws ?? 0,
    uploads: terrain?.uploads ?? 0, reuses: terrain?.reuses ?? 0, allocations: terrain?.allocations ?? 0});
  globalThis.craftWorkerStats = () => ({workers: meshPool.slots?.length ?? 0,
    busy: meshPool.slots?.filter(slot => slot.id).length ?? 0, results: meshPool.results.length,
    wasmBytes: meshPool.slots?.reduce((n,slot) => n + (slot.memory || 0), 0) ?? 0});
  const input = new CraftInput(canvas, () => wasm_exports);
  let next = 1;
  let maximumFps = 0,
    lastFrame = 0;
  // EXT_disjoint_timer_query_webgl2: one asynchronous query every 16 frames,
  // only inside a manual capture. Never wait for the GPU or install an interval.
  const gpuCapture = {
    deadline: 0, timer: null, context: null, ext: undefined,
    query: null, recording: false, frame: 0, result: -1, submitted: 0,
    stop() {
      if (this.timer !== null) clearTimeout(this.timer);
      if (this.query && this.context && !this.context.isContextLost()) {
        if (this.recording) this.context.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.context.deleteQuery(this.query);
      }
      this.deadline = 0; this.timer = null; this.context = null;
      this.ext = undefined; this.query = null; this.recording = false;
      this.frame = 0; this.result = -1;
    },
    start(seconds) {
      this.stop();
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) return;
      this.deadline = performance.now() + seconds * 1000;
      // Expiry also releases queries when requestAnimationFrame is suspended.
      this.timer = setTimeout(() => this.stop(), seconds * 1000);
    },
    begin() {
      this.result = -1;
      if (!this.deadline) return;
      if (performance.now() >= this.deadline) { this.stop(); return; }
      if (typeof gl === 'undefined' || !gl || gl.isContextLost()) {
        this.query = null; this.recording = false; this.ext = undefined;
        return;
      }
      if (this.context !== gl) {
        if (this.query && this.context && !this.context.isContextLost()) this.context.deleteQuery(this.query);
        this.query = null; this.recording = false; this.ext = undefined;
        this.context = gl;
      }
      if (this.ext === undefined) this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!this.ext) return;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (this.query) {
        const available = gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE);
        if (available && !disjoint && performance.now() - this.submitted < 1000) {
          const ms = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
          if (Number.isFinite(ms) && ms >= 0) this.result = ms;
        }
        if (available || disjoint || performance.now() - this.submitted >= 1000) {
          gl.deleteQuery(this.query); this.query = null;
        }
      }
      if (disjoint) return;
      if (this.frame++ % 16 === 0 && !this.query) {
        this.query = gl.createQuery();
        if (this.query) {
          gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
          this.recording = true;
          this.submitted = performance.now();
        }
      }
    },
    end() {
      if (this.recording) {
        this.context.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.recording = false;
      }
      const result = this.result;
      this.result = -1; // A completed query contributes exactly one sample.
      return result;
    },
  };
  // Preserve the native FPS option while yielding to the browser event loop.
  animation = function () {
    // Reconcile before applying the cap: a focus event can be missed during
    // startup/tab restoration, leaving Rust's background limit stuck at 30 FPS.
    check_window_focus();
    const now = performance.now();
    const interval = maximumFps ? 1000 / maximumFps : 0;
    const elapsed = now - lastFrame;
    if (!interval || elapsed >= interval - 0.0001) {
      // Keep the fractional refresh interval. Resetting to `now` turns a
      // 120 FPS cap on a 144 Hz display into 72 FPS (60 on 144 becomes 48).
      // Skip missed deadlines after a stall without running catch-up frames.
      lastFrame = interval
        ? lastFrame + Math.max(1, Math.floor((elapsed + 0.0001) / interval)) * interval
        : now;
      wasm_exports.frame();
    }
    if (!window.blocking_event_loop) {
      // Miniquad can schedule an update during frame() (focus, resize, menus).
      // Keep exactly one callback instead of starting another animation chain.
      if (animation_frame_timeout)
        window.cancelAnimationFrame(animation_frame_timeout);
      animation_frame_timeout = window.requestAnimationFrame(animation);
    }
  };
  const text = (p, n) =>
    decoder.decode(new Uint8Array(wasm_memory.buffer, p, n));
  const read = (key) => {
    if (key === "page-server") return encoder.encode(gameServer().host);
    try {
      let value = localStorage.getItem("craftrust.native." + key);
      if (value === null && key === "player-id") {
        value = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join("");
        localStorage.setItem("craftrust.native." + key, value);
      }
      if (value === null && key === "servers.json")
        value = JSON.stringify({
          servers: [{ name: "CraftRust", address: gameServer().host }],
          last_address: gameServer().host,
        });
      return value === null ? null : encoder.encode(value);
    } catch {
      return key === "player-id" ? encoder.encode("1") : null;
    }
  };
  let audio,
    outputChannels = 2,
    listener = {
      position: [0, 0, 0],
      yaw: 0,
      volume: Array(9).fill(1),
      mode: 0,
      in_game: false,
    },
    nextMusic = performance.now() + 10000,
    music,
    musicPending = false;
  const categories = [
    "master",
    "music",
    "record",
    "weather",
    "block",
    "hostile",
    "neutral",
    "player",
    "ambient",
  ];
  const catalog = Promise.all([
    resource("/sounds/sounds.json").then(r => r.json()).catch(() => ({})),
    resource("/sounds/matmos/events.json").then(r => r.json()).catch(() => ({})),
  ]).then(([base, matmos]) => Object.assign(base, matmos));
  const buffers = new Map(),
    voices = new Set(),
    cartVoices = new Map(),
    pendingCarts = new Set(),
    pendingAmbience = new Set();
  const bufferSizes = new Map();
  let decodedBytes = 0;
  function wake() {
    try {
      if (!audio) {
        audio = new AudioContext({ latencyHint: "interactive" });
        const max = audio.destination.maxChannelCount || 2;
        const channels = [8, 6, 4, 2, 1].find(n => n <= max);
        try {
          audio.destination.channelCount = channels;
          if (channels > 2) audio.destination.channelInterpretation = "discrete";
          outputChannels = channels;
        } catch { outputChannels = 2; }
      }
      if (audio.state === "suspended") audio.resume();
      warmActionSounds();
    } catch {}
  }
  document.addEventListener("pointerdown", wake, { capture: true });
  document.addEventListener("keydown", wake, { capture: true });
  function speakerGains(delta, channels) {
    const sin = Math.sin(listener.yaw), cos = Math.cos(listener.yaw);
    // Same right/forward basis as the rendered camera.
    const right = -delta[0] * cos + delta[2] * sin;
    const forward = delta[0] * sin + delta[2] * cos;
    const gains = Array(channels).fill(0);
    const ring = channels === 8
      ? [[2, 0], [1, 30], [7, 90], [5, 150], [4, 210], [6, 270], [0, 330]]
      : channels === 6
        ? [[2, 0], [1, 30], [5, 110], [4, 250], [0, 330]]
        : [[1, 45], [3, 135], [2, 225], [0, 315]];
    const angle = (Math.atan2(right, forward) * 180 / Math.PI + 360) % 360;
    for (let i = 0; i < ring.length; i++) {
      const [left, start] = ring[i], [right, end] = ring[(i + 1) % ring.length];
      const width = (end - start + 360) % 360, offset = (angle - start + 360) % 360;
      if (offset <= width) {
        const t = offset / width * Math.PI / 2;
        gains[left] = Math.cos(t);
        gains[right] = Math.sin(t);
        break;
      }
    }
    return gains;
  }
  function createPanner(positional) {
    if (!positional || outputChannels <= 2) {
      const input = audio.createStereoPanner();
      input.connect(audio.destination);
      return { input, update(delta) {
        input.pan.value = Math.max(-1, Math.min(1,
          (-delta[0] * Math.cos(listener.yaw) + delta[2] * Math.sin(listener.yaw)) /
          Math.max(0.01, Math.hypot(...delta))));
      }, disconnect() { input.disconnect(); } };
    }
    const input = audio.createGain(), merger = audio.createChannelMerger(outputChannels);
    // Web Audio averages stereo into mono before distributing each world sound.
    input.channelCount = 1;
    input.channelCountMode = "explicit";
    input.channelInterpretation = "speakers";
    const speakers = Array.from({ length: outputChannels }, (_, index) => {
      const gain = audio.createGain();
      gain.gain.value = 0;
      input.connect(gain);
      gain.connect(merger, 0, index);
      return gain;
    });
    merger.connect(audio.destination);
    return { input, update(delta) {
      speakerGains(delta, outputChannels).forEach((value, i) => { speakers[i].gain.value = value; });
    }, disconnect() {
      input.disconnect();
      speakers.forEach(gain => gain.disconnect());
      merger.disconnect();
    } };
  }
  async function resolve(name, depth = 0) {
    if (depth > 8) return null;
    const events = await catalog;
    // Custom packs can fall back to footsteps; the original pack has dedicated
    // mining transients for every material, including glass.
    const hit = name.startsWith("hit.");
    const fallback = hit ? "step." + (name === "hit.glass" ? "stone" : name.slice(4)) : name;
    const event = events[name] || events[fallback];
    if (!event?.sounds?.length) return null;
    const choices = event.sounds.map((s) =>
        typeof s === "string" ? { name: s } : s,
      ),
      total = choices.reduce((n, s) => n + (s.weight || 1), 0);
    let random = Math.random() * total,
      entry = choices.at(-1);
    for (const choice of choices) {
      random -= choice.weight || 1;
      if (random < 0) {
        entry = choice;
        break;
      }
    }
    if (entry.type === "event") return resolve(entry.name, depth + 1);
    return { ...entry, category: hit ? "block" : event.category || "master" };
  }
  function play(event) {
    const ambience = ["liquid.water", "liquid.lava"].includes(event.event);
    if (ambience && pendingAmbience.has(event.event)) return;
    if (ambience) pendingAmbience.add(event.event);
    const isMusic = event.event.startsWith("music.");
    if (isMusic && musicPending) return;
    if (isMusic) musicPending = true;
    if (event.loopId) {
      if (cartVoices.has(event.loopId) || pendingCarts.has(event.loopId))
        return;
      pendingCarts.add(event.loopId);
    }
    return playSound(event).finally(() => {
      if (ambience) pendingAmbience.delete(event.event);
      if (isMusic) musicPending = false;
      if (event.loopId) pendingCarts.delete(event.loopId);
    });
  }
  function updateVoice(voice) {
    let attenuation = 1;
    if (voice.position) {
      const delta = voice.position.map((v, i) => v - listener.position[i]),
        distance = Math.hypot(...delta),
        range = voice.event.includes(".weather.thunder") ? 256 : voice.event.startsWith("mob.ghast.") ? 80 : voice.event.startsWith("matmos") ? 64 : 16;
      attenuation = Math.max(0, 1 - distance / range);
      voice.pan.update(delta);
    }
    voice.gain.gain.value =
      voice.baseVolume *
      (voice.event.includes(".weather.thunder") || voice.event.includes("lightning")
        ? 1.4 : voice.index === 1 ? 0.343 : voice.index === 8 ? 0.48 : 1) *
      attenuation *
      listener.volume[0] *
      (voice.index ? listener.volume[voice.index] : 1) *
      (voice.index === 1 && [...voices].some(v => v.index === 2) ? 0.18 : 1) *
      (voice.fadeGain ?? 1);
  }
  function loadBuffer(name) {
    const url = "/sounds/" + name + ".ogg";
    if (!buffers.has(url))
      buffers.set(
        url,
        resource(url)
          .then((r) => {
            if (!r.ok) throw Error("audio");
            return r.arrayBuffer();
          })
          .then((bytes) => audio.decodeAudioData(bytes))
          .then((buffer) => {
            const size = buffer.length * buffer.numberOfChannels * 4;
            bufferSizes.set(url, size);
            decodedBytes += size;
            for (const [old, bytes] of bufferSizes) {
              if (decodedBytes <= 32 * 1024 * 1024) break;
              if (old === url) continue;
              buffers.delete(old);
              bufferSizes.delete(old);
              decodedBytes -= bytes;
            }
            return buffer;
          })
          .catch(() => null),
      );
    return buffers.get(url);
  }
  let warmingActions = false;
  async function warmActionSounds() {
    if (warmingActions) return;
    warmingActions = true;
    const events = await catalog, names = new Set(), visited = new Set();
    function collect(name) {
      if (visited.has(name)) return;
      visited.add(name);
      for (const entry of events[name]?.sounds || []) {
        if (typeof entry === "string") names.add(entry);
        else if (entry.type === "event") collect(entry.name);
        else names.add(entry.name);
      }
    }
    for (const name of Object.keys(events)) {
      if (/^(step\.|hit\.|dig\.)/.test(name) || ["random.eat", "random.burp"].includes(name)) collect(name);
    }
    const pending = [...names];
    // Bound background decoding so warmup does not monopolize the game frame.
    await Promise.all([0, 1].map(async () => {
      while (pending.length) await loadBuffer(pending.shift());
    }));
  }
  async function playSound(event) {
    const requestedAt = performance.now();
    if (!audio || audio.state !== "running") return;
    if (
      ["liquid.water", "liquid.lava"].includes(event.event) &&
      [...voices].some((v) => v.event === event.event)
    )
      return;
    if (event.event === "records.stop") {
      for (const voice of voices)
        if (voice.category === "record") voice.source.stop();
      return;
    }
    const entry = await resolve(event.event);
    if (!entry) return;
    const category = Math.max(0, categories.indexOf(entry.category));
    if (event.loopId && cartVoices.has(event.loopId)) return;
    if (listener.volume[0] * listener.volume[category] === 0) return;
    try {
      const buffer = await loadBuffer(entry.name);
      if (!buffer) return;
      // Discard an obsolete action instead of playing it behind the moving player.
      if (!event.loopId && /^(step\.|hit\.|dig\.|random\.eat$)/.test(event.event) && performance.now() - requestedAt > 250) return;
      // A world transition can finish while a large ambience buffer is loading.
      // Never start a loop after its scene or vehicle has already disappeared.
      if (event.loopId && (!listener.in_game ||
          ![...(listener.carts || []), ...(listener.ambience || [])].some(c => c.id === event.loopId))) return;
      const source = audio.createBufferSource(),
        gain = audio.createGain(),
        pan = createPanner(!!event.position);
      source.buffer = buffer;
      source.loop = !!event.loopId;
      source.playbackRate.value = (event.pitch || 1) * (entry.pitch || 1);
      source.connect(gain).connect(pan.input);
      const voice = {
        source,
        gain,
        category: entry.category,
        index: category,
        pan,
        event: event.event,
        position: event.position,
        baseVolume: (event.volume ?? 1) * (entry.volume ?? 1),
        fadeGain: event.fade ? 0 : 1,
        fade: event.fade,
        attack: event.attack ?? event.fade,
        updated: performance.now(),
      };
      updateVoice(voice);
      voices.add(voice);
      if (event.loopId) cartVoices.set(event.loopId, voice);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        pan.disconnect();
        voices.delete(voice);
        if (event.loopId) cartVoices.delete(event.loopId);
        if (music === source) {
          music = undefined;
          nextMusic = performance.now() + 90000;
        }
      };
      if (category === 1) {
        if (music) music.stop();
        music = source;
      }
      if (voices.size > 128) voices.values().next().value.source.stop();
      source.start();
    } catch {}
  }
  miniquad_add_plugin({
    name: "craftrust",
    version: 1,
    register_plugin(imports) {
      const texImage2D = imports.env.glTexImage2D;
      const runLoop = imports.env.run_animation_loop;
      imports.env.run_animation_loop = blocking => { runLoop(blocking); input.install(); };
      Object.assign(imports.env, {
        cr_mod_resource_size: (ptr, len) => {
          const path = text(ptr, len), mods = globalThis.craftMods;
          return (path ? mods?.bytes.get(path) : mods?.encoded)?.length ?? -1;
        },
        cr_mod_resource_read: (ptr, len, out, capacity) => {
          const path = text(ptr, len), mods = globalThis.craftMods;
          const bytes = path ? mods?.bytes.get(path) : mods?.encoded;
          if (!bytes || bytes.length > capacity) return 0;
          new Uint8Array(wasm_memory.buffer, out, bytes.length).set(bytes);
          return bytes.length;
        },
        // WebGL 2 requires a sized internal format for depth attachments.
        glTexImage2D: (
          target,
          level,
          internal,
          width,
          height,
          border,
          format,
          type,
          pixels,
        ) => {
          if (internal === 0x1902)
            internal =
              type === 0x1406 ? 0x8cac : type === 0x1405 ? 0x81a6 : 0x81a5;
          texImage2D(
            target,
            level,
            internal,
            width,
            height,
            border,
            format,
            type,
            pixels,
          );
        },
        cr_now: () => performance.now(),
        cr_gpu_capture_start: seconds => gpuCapture.start(seconds),
        cr_gpu_capture_begin: () => gpuCapture.begin(),
        cr_gpu_capture_end: () => gpuCapture.end(),
        glDepthMask: (value) => gl.depthMask(!!value),
        sapp_set_cursor_grab: grab => input.grab(grab),
        cr_input_state: flags => input.setState(flags),
        cr_text_input: (ptr, len) => input.mobile?.setText(JSON.parse(text(ptr, len))),
        cr_hardware_threads: () => Math.max(1, navigator.hardwareConcurrency || 1),
        cr_mesh_configure: count => meshPool.configure(count),
        cr_mesh_workers: () => meshPool.workers(),
        cr_mesh_capacity: () => meshPool.capacity(),
        cr_mesh_submit: (id, p, n) => meshPool.submit(id, new Uint8Array(wasm_memory.buffer,p,n)),
        cr_mesh_result_id: () => meshPool.results[0]?.id || 0,
        cr_mesh_result_size: () => meshPool.results[0]?.bytes.length || 0,
        cr_mesh_result_read: p => {
          const result=meshPool.results.shift();
          if(result) new Uint8Array(wasm_memory.buffer,p,result.bytes.length).set(result.bytes);
        },
        cr_mesh_reset: () => meshPool.reset(),
        cr_terrain_upload: (p, n, indices, count) => (terrain ??= new CraftTerrain()).upload(
          new Uint8Array(wasm_memory.buffer, p, n), new Uint32Array(wasm_memory.buffer, indices, count)),
        cr_terrain_delete: id => terrain?.delete(id),
        cr_terrain_replace: (id, p, n, indices, count) => terrain.upload(
          new Uint8Array(wasm_memory.buffer, p, n), new Uint32Array(wasm_memory.buffer, indices, count), id),
        cr_terrain_draw: (p, count, pass) => terrain?.draw(new Uint32Array(wasm_memory.buffer, p, count * 4), pass),
        cr_frame_limit: (fps) => {
          maximumFps = fps;
        },
        cr_default_port: () =>
          Number(gameServer().port || (gameServer().protocol === "wss:" ? 443 : 80)),
        cr_storage_size: (p, n) => {
          if (text(p, n) === "maintenance-resume") {
            try { return encoder.encode(sessionStorage.getItem("craftrust.maintenance-resume") || "").length; } catch { return -1; }
          }
          return read(text(p, n))?.length ?? -1;
        },
        cr_storage_read: (p, n, out) => {
          let bytes;
          if (text(p, n) === "maintenance-resume") {
            try {
              bytes = encoder.encode(sessionStorage.getItem("craftrust.maintenance-resume") || "");
              sessionStorage.removeItem("craftrust.maintenance-resume");
            } catch { return; }
          } else bytes = read(text(p, n));
          if (bytes)
            new Uint8Array(wasm_memory.buffer, out, bytes.length).set(bytes);
        },
        cr_storage_write: (p, n, v, l) => {
          try {
            localStorage.setItem("craftrust.native." + text(p, n), text(v, l));
          } catch {}
        },
        cr_ws_open: (p, n) => {
          const id = next++,
            address = text(p, n),
            state = { ws: null, status: 0, queue: [], bytes: 0 };
          sockets.set(id, state);
          (async () => {
            try {
              const response = await fetch("/asset-manifest.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
              if (!response.ok) throw Error("Manifesto indisponível");
              const manifest = await response.json();
              if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.version)) throw Error("Manifesto inválido");
              if (sockets.get(id) !== state) return;
              if (globalThis.craftAssets && manifest.version !== craftAssets.version) {
                // The existing loader downloads/verifies the changed assets before entering again.
                sessionStorage.setItem("craftrust.maintenance-resume", address);
                location.reload();
                return;
              }
              const ws = state.ws = new WebSocket(socketUrl(address));
              ws.binaryType = "arraybuffer";
              ws.onmessage = (e) => {
                if (sockets.get(id) !== state) return;
                if (!(e.data instanceof ArrayBuffer)) {
                  ws.close(1003);
                  return;
                }
                const bytes = new Uint8Array(e.data);
                // A hidden tab may stop animation frames. Keep protocol heartbeats
                // on socket events, using the same Rust codec as the native client.
                if (bytes.length <= 64 && wasm_exports?.cr_web_heartbeat) {
                  const pointer = wasm_exports.allocate_vec_u8(bytes.length);
                  new Uint8Array(wasm_memory.buffer, pointer, bytes.length).set(bytes);
                  if (wasm_exports.cr_web_heartbeat(id, pointer, bytes.length)) return;
                }
                // Apply snapshots on delivery even when rendering is capped or the
                // tab is hidden. Rust retains the latest state; meshing stays in frame().
                if (wasm_exports?.cr_web_receive) {
                  const pointer = wasm_exports.allocate_vec_u8(bytes.length);
                  new Uint8Array(wasm_memory.buffer, pointer, bytes.length).set(bytes);
                  if (wasm_exports.cr_web_receive(id, pointer, bytes.length)) return;
                }
                state.bytes += bytes.length;
                if (state.bytes > 8 * 1024 * 1024) {
                  ws.close(1009);
                  return;
                }
                state.queue.push(bytes);
              };
            } catch (error) {
              if (sockets.get(id) === state) state.status = 3;
              console.warn("Verificação de atualização:", error);
            }
          })();
          return id;
        },
        cr_ws_state: (id) => (sockets.get(id)?.ws?.readyState ?? sockets.get(id)?.status ?? 3),
        cr_ws_size: (id) => sockets.get(id)?.queue[0]?.length ?? 0,
        cr_ws_read: (id, out) => {
          const state = sockets.get(id),
            bytes = state?.queue.shift();
          if (bytes) {
            state.bytes -= bytes.length;
            new Uint8Array(wasm_memory.buffer, out, bytes.length).set(bytes);
          }
        },
        cr_ws_send: (id, p, n) => {
          const socket = sockets.get(id)?.ws;
          if (socket?.readyState === 1) {
            if (socket.bufferedAmount > 2 * 1024 * 1024) {
              socket.close(1009);
              return;
            }
            socket.send(new Uint8Array(wasm_memory.buffer, p, n).slice());
          }
        },
        cr_ws_close: (id) => {
          gpuCapture.stop();
          sockets.get(id)?.ws?.close();
          sockets.delete(id);
        },
        cr_audio: (p, n) => {
          play(JSON.parse(text(p, n)));
        },
        cr_audio_listener: (p, n) => {
          listener = JSON.parse(text(p, n));
          const carts = listener.in_game ? [...(listener.carts || []), ...(listener.ambience || [])] : [];
          for (const [id, voice] of cartVoices)
            if (!carts.some((c) => c.id === id)) {
              if (voice.fade) {
                const dt = Math.min(0.1, Math.max(0, (performance.now() - voice.updated) / 1000));
                voice.fadeGain = Math.max(0, voice.fadeGain - dt / voice.fade);
                voice.updated = performance.now();
              }
              if (!voice.fade || voice.fadeGain <= 0) {
                voice.source.stop();
                cartVoices.delete(id);
              }
            }
          for (const cart of carts) {
            const voice = cartVoices.get(cart.id);
            if (voice) {
              if (voice.fade) {
                const dt = Math.min(0.1, Math.max(0, (performance.now() - voice.updated) / 1000));
                voice.fadeGain = Math.min(1, voice.fadeGain + dt / voice.attack);
                voice.updated = performance.now();
              }
              voice.baseVolume = cart.volume;
              voice.position = cart.position;
              voice.source.playbackRate.value = cart.pitch;
            } else play({ ...cart, loopId: cart.id });
          }
          for (const voice of voices) updateVoice(voice);
          if (!music && !musicPending && performance.now() >= nextMusic &&
              ![...voices].some(v => v.index === 2)) {
            // Let full compositions finish. Failed loads retry after a delay.
            nextMusic = performance.now() + 30000;
            play({
              event: !listener.in_game
                ? "music.menu"
                : listener.mode === 1
                  ? "music.game.creative"
                  : "music.game",
              volume: 1,
              pitch: 1,
            });
          }
        },
      });
    },
  });
  const original = console.error;
  console.error = (...args) => {
    original(...args);
    globalThis.craftLoading.error("Falha ao iniciar Total Craft. " + args.map(String).join(" "));
  };
  function ready() {
    if (typeof wasm_exports !== "undefined" && wasm_exports?.memory) {
      if (globalThis.craftLoading.root.dataset.failed !== "true") globalThis.craftLoading.finish();
      return;
    }
    requestAnimationFrame(ready);
  }
  requestAnimationFrame(ready);
  load("/client.wasm");
})();
