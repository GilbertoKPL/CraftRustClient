// Independent WASM memories; transferable buffers, no Atomics.wait on the UI thread.
let instance;
self.onmessage = async ({ data }) => {
  try {
    if (data.module) {
      const env = {};
      for (const entry of WebAssembly.Module.imports(data.module)) {
        if (entry.kind !== "function" || entry.module !== "env")
          throw Error("Unsupported worker import: " + entry.name);
        env[entry.name] = () => { throw Error("Unexpected mesh import: " + entry.name); };
      }
      env.cr_now = () => performance.now();
      instance = (await WebAssembly.instantiate(data.module, { env })).exports;
      self.postMessage({ ready: true, memory: instance.memory.buffer.byteLength });
      return;
    }
    const bytes = new Uint8Array(data.bytes);
    const ptr = instance.cr_worker_alloc(bytes.length);
    if (!ptr) throw Error("Mesh snapshot too large");
    new Uint8Array(instance.memory.buffer, ptr, bytes.length).set(bytes);
    const size = instance.cr_worker_execute(ptr, bytes.length);
    if (!size) throw Error("Mesh builder rejected snapshot");
    const result = new Uint8Array(instance.memory.buffer, instance.cr_worker_output(), size).slice();
    instance.cr_worker_clear();
    self.postMessage({ id: data.id, bytes: result.buffer, memory: instance.memory.buffer.byteLength }, [result.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
