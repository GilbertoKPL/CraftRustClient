// WebGL 2 terrain backend. Persistent VAOs replace per-range attribute setup;
// a packed command buffer crosses the WASM boundary once per render pass.
class CraftTerrain {
  meshes = new Map(); next = 1; bytes = 0; dataBytes = 0; legacyBytes = 0; draws = 0;
  uploads = 0; reuses = 0; allocations = 0;
  upload(vertices, indices, id = 0) {
    // 0xffff is the fixed primitive-restart index in WebGL 2, never a vertex.
    const small = vertices.byteLength / 32 <= 65535;
    const packed = small ? new Uint16Array(indices) : indices;
    const dataBytes = vertices.byteLength + packed.byteLength;
    const legacyBytes = vertices.byteLength / 32 * 44 + indices.byteLength;
    const previous = this.meshes.get(id);
    this.uploads++;
    if (previous && previous.vertexBytes >= vertices.byteLength && previous.indexBytes >= packed.byteLength && previous.stride === (small ? 2 : 4)) {
      try {
        gl.bindVertexArray(previous.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, previous.vertex);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, packed);
      } finally {
        gl.bindVertexArray(GL.boundVertexArray ?? null);
        gl.bindBuffer(gl.ARRAY_BUFFER, GL.boundArrayBuffer ?? null);
      }
      this.dataBytes += dataBytes - previous.dataBytes;
      this.legacyBytes += legacyBytes - previous.legacyBytes;
      previous.dataBytes = dataBytes; previous.legacyBytes = legacyBytes;
      this.reuses++;
      return id;
    }
    // Release old storage before growing: no overlap larger than the budget.
    if (previous) this.delete(id);
    const vao = gl.createVertexArray(), vertex = gl.createBuffer(), index = gl.createBuffer();
    if (!vao || !vertex || !index) throw Error('Unable to allocate WebGL terrain');
    try {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
      for (const [slot, size, type, offset] of [[0,3,gl.FLOAT,0],[1,4,gl.UNSIGNED_BYTE,12],[2,3,gl.FLOAT,16],[3,2,gl.SHORT,28]]) {
        gl.enableVertexAttribArray(slot);
        gl.vertexAttribPointer(slot, size, type, false, 32, offset);
      }
    } catch (error) {
      gl.deleteVertexArray(vao); gl.deleteBuffer(vertex); gl.deleteBuffer(index);
      throw error;
    } finally {
      // Preserve the UI/actor backend's state without synchronous driver queries.
      gl.bindVertexArray(GL.boundVertexArray ?? null);
      gl.bindBuffer(gl.ARRAY_BUFFER, GL.boundArrayBuffer ?? null);
    }
    if (!id) id = this.next++;
    const bytes = dataBytes;
    this.meshes.set(id, {vao, vertex, index, bytes, dataBytes, legacyBytes,
      vertexBytes: vertices.byteLength, indexBytes: packed.byteLength,
      type: small ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, stride: small ? 2 : 4});
    this.bytes += bytes;
    this.dataBytes += dataBytes;
    this.legacyBytes += legacyBytes;
    this.allocations++;
    return id;
  }
  delete(id) {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    gl.deleteVertexArray(mesh.vao); gl.deleteBuffer(mesh.vertex); gl.deleteBuffer(mesh.index);
    this.bytes -= mesh.bytes; this.dataBytes -= mesh.dataBytes;
    this.legacyBytes -= mesh.legacyBytes; this.meshes.delete(id);
  }
  draw(commands, pass) {
    let last = 0, culling = false;
    try {
      for (let i = 0; i < commands.length; i += 4) {
        const id = commands[i], mesh = this.meshes.get(id);
        if (!mesh || commands[i + 2] === 0) continue;
        const cull = commands[i + 3] !== 0;
        if (cull !== culling) {
          if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); }
          else gl.disable(gl.CULL_FACE);
          culling = cull;
        }
        if (last !== id) { gl.bindVertexArray(mesh.vao); last = id; }
        gl.drawElements(gl.TRIANGLES, commands[i + 2], mesh.type, commands[i + 1] * mesh.stride);
        this.draws++;
      }
    } finally {
      if (culling) gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(GL.boundVertexArray ?? null);
    }
  }
}
globalThis.CraftTerrain = CraftTerrain;
