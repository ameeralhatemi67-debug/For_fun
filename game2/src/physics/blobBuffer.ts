/**
 * Flat, preallocated list of metaballs handed from physics to the renderer.
 * Layout per blob (8 floats):
 *   x, y (world units), support radius, weight,
 *   dirX, dirY (unit stretch axis), stretch (≥1 along axis), body index
 */
export const MAX_BLOBS = 64;
export const BLOB_STRIDE = 8;

export class BlobBuffer {
  readonly data = new Float32Array(MAX_BLOBS * BLOB_STRIDE);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  push(
    x: number,
    y: number,
    support: number,
    weight: number,
    dirX: number,
    dirY: number,
    stretch: number,
    body: number,
  ): void {
    if (this.count >= MAX_BLOBS || support <= 1e-5 || weight <= 1e-4) return;
    const o = this.count * BLOB_STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = support;
    d[o + 3] = weight;
    d[o + 4] = dirX;
    d[o + 5] = dirY;
    d[o + 6] = stretch;
    d[o + 7] = body;
    this.count++;
  }
}
