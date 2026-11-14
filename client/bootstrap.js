// The page/manifest check for updates. Game bytes are stored once per content revision,
// including on plain HTTP where Service Workers and CacheStorage are unavailable.
class CraftResourceCache {
  blobs = new Map();
  urls = new Map();
  constructor(manifest, database) {
    if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.version) ||
        !Array.isArray(manifest.assets) || !manifest.assets.length)
      throw Error("Manifesto de recursos inválido.");
    this.entries = new Map();
    for (const entry of manifest.assets) {
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.path.split("/").includes("..") ||
          !/^[a-f0-9]{40}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          typeof entry.mime !== "string" || this.entries.has(entry.path))
        throw Error("Recurso inválido no manifesto.");
      this.entries.set(entry.path, entry);
    }
    if (manifest.download_base !== undefined &&
        (typeof manifest.download_base !== "string" ||
         !/^https:\/\/raw\.githubusercontent\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-f0-9]{40}\/client$/.test(manifest.download_base) ||
         manifest.chunk_size !== 32 * 1024 * 1024))
      throw Error("Origem de download inválida.");
    this.downloadBase = manifest.download_base;
    this.chunkSize = manifest.chunk_size;
    this.version = manifest.version;
    this.database = database;
  }
  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("craftrust.resources", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("assets");
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("Feche as outras abas do jogo e tente novamente."));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  key(entry) { return entry.path + "?v=" + entry.hash; }
  async download(entry, options) {
    if (!this.downloadBase) return fetch(this.key(entry), options);
    const base = this.downloadBase + entry.path;
    if (entry.size <= this.chunkSize) return fetch(base, options);
    // Large files are stored as bounded Git blobs. Reassemble the original bytes
    // before the existing size/hash check, cache, WASM loader and Blob scripts.
    let index = 0, reader;
    const count = Math.ceil(entry.size / this.chunkSize);
    const stream = new ReadableStream({
      pull: async controller => {
        try {
          while (true) {
            if (!reader) {
              if (index === count) { controller.close(); return; }
              const response = await fetch(base + ".part-" + String(index++).padStart(4, "0"), options);
              if (!response.ok) {
                const error = Error("HTTP " + response.status);
                error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
                throw error;
              }
              reader = response.body.getReader();
            }
            const { done, value } = await reader.read();
            if (done) { reader.releaseLock(); reader = null; continue; }
            controller.enqueue(value);
            return;
          }
        } catch (error) { controller.error(error); }
      },
      cancel: async () => { if (reader) await reader.cancel(); }
    });
    return new Response(stream, { headers: { "Content-Type": entry.mime } });
  }
  static async request(path, options, consume, download = fetch) {
    // A failed body read also needs a fresh GET; never save partial responses.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await download(path, attempt && options.cache !== "no-store"
          ? { ...options, cache: "reload" } : options);
        if (response.status === 409)
          throw Error("Uma atualização foi publicada. Recarregue a página.");
        if (!response.ok) {
          const error = Error("HTTP " + response.status);
          error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          throw error;
        }
        return await consume(response);
      } catch (error) {
        if (error instanceof TypeError || error.retryable) {
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            continue;
          }
          throw Error("Falha de rede ao baixar " + path.split("?")[0] +
            " após 3 tentativas. Verifique a conexão e recarregue a página para continuar.");
        }
        if (/^HTTP /.test(error.message))
          throw Error("Falha ao baixar " + path.split("?")[0] + " (" + error.message + "). Recarregue a página.");
        throw error;
      }
    }
  }
  transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("assets", mode);
      const request = operation(transaction.objectStore("assets"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || Error("Falha no armazenamento local."));
    });
  }
  async prepare(progress = () => {}, ready = () => {}) {
    const entries = [...this.entries.values()].sort((a, b) =>
      Number(b.path === "/loading-background.png") - Number(a.path === "/loading-background.png"));
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let cursor = 0, loaded = 0, downloaded = 0, files = 0, cachedFiles = 0, failed = false;
    const inFlight = new Map();
    let lastReport = -Infinity, currentFile = "";
    const report = (force = true) => {
      const now = performance.now();
      if (!force && now - lastReport < 80) return;
      lastReport = now;
      const received = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
      progress({ loaded: loaded + received, total, downloaded: downloaded + received,
        files, cachedFiles, totalFiles: entries.length, currentFile: inFlight.keys().next().value || currentFile });
    };
    report();
    // Bound HTTP connections, temporary download memory and IndexedDB work.
    const download = async () => {
      while (!failed && cursor < entries.length) {
        const entry = entries[cursor++], key = this.key(entry);
        try {
          let blob = await this.transaction("readonly", store => store.get(key));
          if (!(blob instanceof Blob) || blob.size !== entry.size) {
            blob = await CraftResourceCache.request(key, { cache: "default" }, async response => {
              currentFile = entry.path;
              inFlight.set(entry.path, 0);
              report();
              try {
                let blob;
                if (response.body?.getReader) {
                  const reader = response.body.getReader(), chunks = [];
                  let size = 0;
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      size += value.byteLength;
                      if (size > entry.size) {
                        await reader.cancel();
                        const error = Error("Tamanho inválido: " + entry.path);
                        error.retryable = true;
                        throw error;
                      }
                      chunks.push(value);
                      inFlight.set(entry.path, size);
                      report(false);
                    }
                    blob = new Blob(chunks, { type: entry.mime });
                  } finally { reader.releaseLock(); }
                } else {
                  blob = await response.blob();
                  inFlight.set(entry.path, blob.size);
                }
                if (blob.size !== entry.size) {
                  const error = Error("Download incompleto: " + entry.path);
                  error.retryable = true;
                  throw error;
                }
                return blob;
              } catch (error) {
                // A new attempt replaces partial bytes instead of double counting them.
                inFlight.delete(entry.path);
                report();
                throw error;
              }
            }, (_path, options) => this.download(entry, options));
            // WebCrypto is optional on HTTP. Versioned URLs are also validated by the server.
            if (globalThis.crypto?.subtle) {
              const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
              const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
              if (hash !== entry.hash) throw Error("Recurso corrompido: " + entry.path);
            }
            blob = new Blob([blob], { type: entry.mime });
            await this.transaction("readwrite", store => store.put(blob, key));
            downloaded += entry.size;
            inFlight.delete(entry.path);
          } else cachedFiles++;
          // Blob handles pin this tab's release even after a newer tab cleans old disk entries.
          // Sounds remain compressed; WebAudio decodes only those actually played.
          this.blobs.set(entry.path, blob);
          loaded += entry.size;
          files++;
          ready(entry.path, blob);
          report();
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, entries.length) }, download));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    // Only remove obsolete revisions after the complete new release is safely stored.
    const wanted = new Set(entries.map(entry => this.key(entry)));
    await this.transaction("readwrite", store => {
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!String(cursor.key).startsWith("mod-sha256:") && !wanted.has(cursor.key)) store.delete(cursor.key);
        cursor.continue();
      };
    });
  }
  async fetch(path) {
    const blob = this.blobs.get(path);
    if (!blob) throw Error("Recurso não preparado: " + path);
    return new Response(blob, { headers: { "Content-Type": this.entries.get(path).mime } });
  }
  url(path) {
    if (!this.blobs.has(path)) throw Error("Recurso não preparado: " + path);
    if (!this.urls.has(path)) this.urls.set(path, URL.createObjectURL(this.blobs.get(path)));
    return this.urls.get(path);
  }
}
globalThis.CraftResourceCache = CraftResourceCache;

// Server mods expose only this declarative catalogue and PNG/OGG/language data.
// Native code and source archives have no public HTTP route.
class CraftModResources {
  blobs = new Map(); bytes = new Map(); pending = new Map();
  constructor(manifest, cache) {
    if (manifest.schema !== 1 || !Array.isArray(manifest.blocks) || manifest.blocks.length > 1024 ||
        !Array.isArray(manifest.items) || manifest.items.length > 8192 || !manifest.assets ||
        Object.keys(manifest.assets).length > 8192) throw Error("Catálogo de mods inválido.");
    for (const [path, entry] of Object.entries(manifest.assets)) {
      if (!/^[a-zA-Z0-9_./ -]+$/.test(path) || path.split("/").some(p => !p || p === ".." || p === ".") ||
          !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 16777216 ||
          !["image/png", "audio/ogg", "text/plain"].includes(entry.mime)) throw Error("Recurso de mod inválido.");
    }
    const sprite = (path, frame) => manifest.assets[path]?.mime === "image/png" && Number.isInteger(frame) && frame >= 0 && frame < 1024;
    const ids = new Set(), items = new Set();
    for (const block of manifest.blocks) {
      if (!Number.isInteger(block.id) || block.id < 198 || block.id > 65535 || ids.has(block.id) ||
          !Array.isArray(block.faces) || block.faces.length !== 6 || !Array.isArray(block.frames) || block.frames.length !== 6 ||
          !block.faces.every((path, i) => sprite(path, block.frames[i]))) throw Error("Bloco de mod inválido.");
      ids.add(block.id);
      if(block.variants && (!Array.isArray(block.variants) || ![0,16].includes(block.variants.length) || block.variants.some(state=>!Array.isArray(state)||state.length!==6||state.some((frame,i)=>!sprite(block.faces[i],frame))))) throw Error("Estado de bloco de mod inválido.");
      if (block.container) {
        const c=block.container;
        if (!sprite(c.texture,0) || !Array.isArray(c.cells) || c.cells.length!==256 || !c.cells.every(k=>/^[a-f0-9]{64}$/.test(k)) ||
            !Array.isArray(c.slots) || c.slots.length>54 || c.slots.some(s=>!Number.isInteger(s.x)||!Number.isInteger(s.y)||s.x<0||s.y<0||s.x+16>c.width||s.y+16>c.height)) throw Error("Interface de mod inválida.");
      }
    }
    for (const item of manifest.items) {
      if (!Number.isInteger(item.id) || item.id < 0 || item.id > 65535 || items.has(item.id) || !sprite(item.texture, item.frame))
        throw Error("Item de mod inválido.");
      items.add(item.id);
    }
    const tiles = new Set(manifest.blocks.flatMap(b => b.faces.map((p,i) => p + "#" + b.frames[i])));
    for(const b of manifest.blocks) for(const state of b.variants||[]) for(let i=0;i<6;i++) tiles.add(b.faces[i]+"#"+state[i]);
    for (const item of manifest.items) tiles.add(item.texture + "#" + item.frame);
    for(const b of manifest.blocks) if(b.container) for(const key of b.container.cells) tiles.add("gui:"+key);
    if (!Number.isInteger(manifest.tile_capacity) || manifest.tile_capacity < 0 || manifest.tile_capacity > 2048 || tiles.size > manifest.tile_capacity)
      throw Error("Os mods excedem a capacidade do atlas de texturas.");
    this.manifest = manifest; this.cache = cache;
    this.encoded = new TextEncoder().encode(JSON.stringify(manifest));
  }
  async fetch(path) {
    const entry = this.manifest.assets[path];
    if (!entry) throw Error("Recurso não declarado pelo mod: " + path);
    if (!this.pending.has(entry.hash)) this.pending.set(entry.hash, this.load(entry).catch(error => { this.pending.delete(entry.hash); throw error; }));
    const blob = await this.pending.get(entry.hash);
    this.blobs.set(path, blob);
    return new Response(blob, { headers: { "Content-Type": entry.mime } });
  }
  async load(entry) {
    const key = "mod-sha256:" + entry.hash;
    const verify = async blob => blob instanceof Blob && blob.size === entry.size &&
      await CraftModResources.hash(new Uint8Array(await blob.arrayBuffer())) === entry.hash;
    let blob = await this.cache.transaction("readonly", store => store.get(key));
    if (!await verify(blob)) {
      blob = await CraftResourceCache.request("/mod-assets/" + entry.hash, { cache: "default" }, async response => {
        const chunks = []; let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > entry.size) { await reader.cancel(); throw Error("Recurso de mod maior que o declarado."); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return new Blob(chunks, { type: entry.mime });
      });
      if (!await verify(blob)) throw Error("Recurso de mod corrompido.");
      await this.cache.transaction("readwrite", store => store.put(blob, key));
    }
    return blob;
  }
  async prepare() {
    const wanted = [...new Set([...this.manifest.blocks.flatMap(b => b.faces), ...this.manifest.items.map(i => i.texture),...this.manifest.blocks.filter(b=>b.container).map(b=>b.container.texture)])];
    let cursor = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, wanted.length) }, async () => {
      while (cursor < wanted.length) {
        const path = wanted[cursor++]; const response = await this.fetch(path);
        this.bytes.set(path, new Uint8Array(await response.arrayBuffer()));
      }
    }));
    const failure = results.find(r => r.status === "rejected"); if (failure) throw failure.reason;
    // Keep only revisions from the complete, validated current mod catalogue.
    const hashes = new Set(Object.values(this.manifest.assets).map(e => "mod-sha256:" + e.hash));
    await this.cache.transaction("readwrite", store => {
      const request = store.openKeyCursor(); request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        if (String(cursor.key).startsWith("mod-sha256:") && !hashes.has(cursor.key)) store.delete(cursor.key);
        cursor.continue();
      };
    });
  }
  static async hash(bytes) {
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }
    // HTTP WebViews lack WebCrypto. This fallback also verifies disk-cache data.
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); padded.set(bytes); padded[bytes.length] = 128;
    const view = new DataView(padded.buffer); view.setUint32(padded.length - 4, bytes.length * 8); view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
    const r = (x,n) => (x >>> n) | (x << (32-n)), w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i=0;i<16;i++) w[i] = view.getUint32(offset+i*4);
      for (let i=16;i<64;i++) w[i] = (w[i-16] + (r(w[i-15],7)^r(w[i-15],18)^(w[i-15]>>>3)) + w[i-7] + (r(w[i-2],17)^r(w[i-2],19)^(w[i-2]>>>10))) >>> 0;
      let [a,b,c,d,e,f,g,hh] = h;
      for (let i=0;i<64;i++) { const t1 = (hh + (r(e,6)^r(e,11)^r(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) >>> 0;
        const t2 = ((r(a,2)^r(a,13)^r(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
        hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
      [a,b,c,d,e,f,g,hh].forEach((v,i) => { h[i]=(h[i]+v)>>>0; });
    }
    return h.map(v => v.toString(16).padStart(8,"0")).join("");
  }
}
globalThis.CraftModResources = CraftModResources;

class CraftLoadingScreen {
  constructor() {
    this.root = document.getElementById("loading");
    this.tips = ["Seu próximo mundo começa com um bloco.",
      "Explore, construa e descubra novos caminhos.",
      "Jogue com amigos. Crie algo extraordinário.",
      "Os recursos salvos são reutilizados na próxima visita."];
    this.started = performance.now();
    this.element("retry").addEventListener("click", () => location.reload());
    this.timer = setInterval(() => this.metrics(), 1000);
    addEventListener("pagehide", () => this.stop(), { once: true });
    this.metrics();
  }
  element(name) { return document.getElementById("loading-" + name); }
  text(name, value) { this.element(name).textContent = value; }
  static bytes(bytes) {
    return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(2) + " GB"
      : (bytes / 1048576).toFixed(1) + " MB";
  }
  metrics() {
    const memory = performance.memory;
    if (memory && Number.isFinite(memory.usedJSHeapSize) && memory.jsHeapSizeLimit > 0) {
      this.text("memory", `${CraftLoadingScreen.bytes(memory.usedJSHeapSize)} / ${CraftLoadingScreen.bytes(memory.jsHeapSizeLimit)}`);
      this.element("memory-fill").style.width = Math.min(100, memory.usedJSHeapSize / memory.jsHeapSizeLimit * 100) + "%";
    } else {
      this.text("memory", "Indisponível na web");
      this.text("memory-note", "Este navegador não expõe a memória JS.");
    }
    this.text("tip", this.tips[Math.floor((performance.now() - this.started) / 7000) % this.tips.length]);
  }
  stage(message) { this.text("message", message); }
  progress({ loaded, total, downloaded, files, cachedFiles, totalFiles, currentFile }) {
    const percent = Math.min(100, total ? loaded / total * 100 : files / Math.max(1, totalFiles) * 100);
    this.root.dataset.indeterminate = "false";
    this.stage(downloaded > 0 ? "Baixando recursos do jogo" : "Verificando recursos salvos");
    this.element("fill").style.width = percent + "%";
    this.element("progress").setAttribute("aria-valuenow", Math.floor(percent));
    this.text("percent", Math.floor(percent) + "%");
    this.text("bytes", `Recursos: ${CraftLoadingScreen.bytes(loaded)} / ${CraftLoadingScreen.bytes(total)}`);
    this.text("files", `${files} / ${totalFiles} arquivos · ${cachedFiles} do cache`);
    this.text("file", `Baixados nesta sessão: ${CraftLoadingScreen.bytes(downloaded)}${currentFile ? " · " + currentFile : ""}`);
  }
  stop() { clearInterval(this.timer); }
  finish() { this.stop(); this.root.hidden = true; }
  error(message) {
    this.stop();
    this.root.hidden = false;
    this.root.dataset.failed = "true";
    this.root.dataset.indeterminate = "false";
    this.stage(message);
    this.element("progress").removeAttribute("aria-valuenow");
    this.text("percent", "!");
    this.text("bytes", "Seus arquivos completos continuam salvos.");
    this.text("files", "Tente novamente para continuar.");
    this.element("retry").hidden = false;
  }
}
globalThis.craftLoading = new CraftLoadingScreen();

(async () => {
  const loading = globalThis.craftLoading;
  try {
    loading.stage("Verificando atualizações de recursos...");
    const manifest = await CraftResourceCache.request("/asset-manifest.json", { cache: "no-store" }, response => response.json());
    const cache = new CraftResourceCache(manifest, await CraftResourceCache.open());
    // Browsers may grant persistence automatically; rejection does not prevent ordinary disk caching.
    navigator.storage?.persist?.().catch(() => {});
    await cache.prepare(value => loading.progress(value), path => {
      if (path === "/loading-background.png") {
        loading.root.style.setProperty("--loading-background", `url("${cache.url(path)}")`);
      }
    });
    globalThis.craftAssets = cache;
    loading.stage("Preparando texturas dos mods...");
    const modManifest = await CraftResourceCache.request("/mod-manifest.json", { cache: "no-store" }, response => response.json());
    globalThis.craftMods = new CraftModResources(modManifest, cache);
    await craftMods.prepare();
    loading.stage("Iniciando Total Craft...");
    loading.text("file", "Recursos prontos. Preparando o motor do jogo...");
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = cache.url("/style.css");
    document.head.append(style);
    for (const path of ["/gl.js", "/terrain.js", "/worker-pool.js", "/input.js", "/bridge.js"]) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = cache.url(path);
        script.onload = resolve;
        script.onerror = () => reject(Error("Falha ao iniciar " + path));
        document.body.append(script);
      });
    }
  } catch (error) {
    console.error("CraftRust resources:", error);
    loading.error("Falha ao preparar recursos. " +
      (["QuotaExceededError", "SecurityError", "InvalidStateError", "UnknownError"].includes(error.name)
        ? "Permita o armazenamento local e libere espaço no navegador/WebView. Depois recarregue a página."
        : error.message));
  }
})();
