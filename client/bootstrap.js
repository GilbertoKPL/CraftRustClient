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
        if (!wanted.has(cursor.key)) store.delete(cursor.key);
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
