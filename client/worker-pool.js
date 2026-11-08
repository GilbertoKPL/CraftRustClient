// Bounded, persistent CPU pool. A failed worker falls back to the cooperative Rust path.
class CraftMeshPool {
  slots = []; results = []; generation = 0; wanted = 0; failed = false;
  configure(count) {
    count = Math.max(1, Math.min(count, navigator.hardwareConcurrency || 1, 32));
    if (this.wanted === count) return;
    this.reset();
    this.restart = false;
    this.wanted = count; this.failed = false;
    this.start();
  }
  start() {
    if (typeof Worker === "undefined") { this.fail(); return; }
    const generation = this.generation;
    this.module ??= (globalThis.craftAssets ? craftAssets.fetch("/mesh-worker.wasm") : fetch("/mesh-worker.wasm")).then(r => {
      if (!r.ok) throw Error("Unable to load mesh WASM");
      return r.arrayBuffer();
    }).then(bytes => WebAssembly.compile(bytes));
    this.module.then(module => {
      if (generation !== this.generation) return;
      for (let i = 0; i < this.wanted; i++) {
        const worker = new Worker(globalThis.craftAssets ? craftAssets.url("/mesh-worker.js") : "/mesh-worker.js", { name: "CraftRust mesh " + (i + 1) });
        const slot = { worker, ready: false, id: 0, timer: null };
        this.slots.push(slot);
        slot.timer = setTimeout(() => this.fail(), 30000);
        worker.onmessage = ({ data }) => {
          if (generation !== this.generation || this.failed) return;
          clearTimeout(slot.timer); slot.timer = null;
          slot.memory = data.memory || slot.memory || 0;
          if (data.ready) { slot.ready = true; return; }
          if (data.id !== slot.id || !slot.id) { this.fail(); return; }
          this.results.push({ id: slot.id, bytes: data.bytes ? new Uint8Array(data.bytes) : new Uint8Array() });
          slot.id = 0;
          if (data.error) { console.warn("CraftRust mesh worker:", data.error); this.fail(); }
        };
        worker.onerror = () => this.fail();
        worker.postMessage({ module });
      }
    }).catch(error => { console.warn("CraftRust workers:", error); this.fail(); });
  }
  fail() {
    if (this.failed) return;
    this.failed = true;
    for (const slot of this.slots) {
      clearTimeout(slot.timer); slot.worker.terminate();
      if (slot.id) this.results.push({ id: slot.id, bytes: new Uint8Array() });
    }
    this.slots = [];
  }
  reset() {
    this.generation++;
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.worker.terminate(); }
    this.slots = []; this.results = [];
    // Restart lazily on the next frame, after old session data has been dropped.
    this.restart = true;
  }
  workers() {
    if (this.restart) { this.restart = false; if (!this.failed && this.wanted) this.start(); }
    return this.failed ? 0 : this.wanted;
  }
  capacity() {
    // Retain at most one result per worker, including results waiting for GPU uploads.
    return this.results.length ? 0 : this.slots.filter(s => s.ready && !s.id).length;
  }
  submit(id, bytes) {
    const slot = this.slots.find(s => s.ready && !s.id);
    if (!slot || this.failed || bytes.length > 8 * 1024 * 1024) return 0;
    slot.id = id;
    const copy = bytes.slice();
    slot.timer = setTimeout(() => this.fail(), 30000);
    slot.worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
    return 1;
  }
}
globalThis.CraftMeshPool = CraftMeshPool;
