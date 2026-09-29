/**
 * Flat, preallocated list of metaballs handed from physics to the renderer.
 * Layout per blob (8 floats):
 *   x, y (world units), support radius, weight,
 *   dirX, dirY (unit stretch axis), aspect (≥1, area-preserving stretch),
 *   packed = colorMix + 2·dropTag
 *
 * colorMix is continuous: 0 = body A palette, 1 = body B palette; values in
 * between run A → purple → B, so a fusion neck can carry a gradient.
 * dropTag 0..7 marks torn-off liquid (droplets): the shader gives those
 * pixels less rim/glow and more translucency.
 */
export const MAX_BLOBS = 80;
export const BLOB_STRIDE = 8;
export const DROP_TAG_LEVELS = 7;

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
    mix: number,
    dropness = 0,
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
    const m = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    const tag = Math.round((dropness < 0 ? 0 : dropness > 1 ? 1 : dropness) * DROP_TAG_LEVELS);
    // Keep mix strictly below 2 per tag slot (1.0 + 2·tag stays decodable).
    d[o + 7] = Math.min(m, 0.999) + 2 * tag;
    this.count++;
  }
}
