import { BLOB_STRIDE, type BlobBuffer } from '../../src/physics/blobBuffer';
import { FIELD_THRESHOLD } from '../../src/physics/shape';

/** Same field as the shader (area-preserving anisotropic Wyvill kernel). */
export function fieldAt(buf: BlobBuffer, x: number, y: number): number {
  const d = buf.data;
  let F = 0;
  for (let i = 0; i < buf.count; i++) {
    const o = i * BLOB_STRIDE;
    const dx = x - d[o];
    const dy = y - d[o + 1];
    const R = d[o + 2];
    const w = d[o + 3];
    const dirX = d[o + 4];
    const dirY = d[o + 5];
    const sq = Math.sqrt(d[o + 6]);
    const vx = (dx * dirX + dy * dirY) / sq / R;
    const vy = (-dx * dirY + dy * dirX) * sq / R;
    const q2 = vx * vx + vy * vy;
    if (q2 < 1) {
      const t = 1 - q2;
      F += w * t * t * t;
    }
  }
  return F;
}

/** Distance from (cx, cy) to the silhouette along unit direction (ux, uy) (marching from the center). */
export function extentAlong(buf: BlobBuffer, cx: number, cy: number, ux: number, uy: number, maxR: number): number {
  const step = maxR / 400;
  let r = 0;
  let last = 0;
  // Walk outward; the last inside point before a long outside run is the extent.
  for (let k = 0; k <= 400; k++) {
    r = k * step;
    if (fieldAt(buf, cx + ux * r, cy + uy * r) > FIELD_THRESHOLD) last = r;
  }
  return last;
}

/** Silhouette length (along u) / width (across u), both through the given center. */
export function silhouetteAspect(buf: BlobBuffer, cx: number, cy: number, ux: number, uy: number, maxR: number) {
  const a = extentAlong(buf, cx, cy, ux, uy, maxR) + extentAlong(buf, cx, cy, -ux, -uy, maxR);
  const b = extentAlong(buf, cx, cy, -uy, ux, maxR) + extentAlong(buf, cx, cy, uy, -ux, maxR);
  return { length: a, width: b, aspect: b > 1e-9 ? a / b : 1 };
}

/** Max aspect over a few axes (the body is not always stretched along velocity). */
export function maxSilhouetteAspect(buf: BlobBuffer, cx: number, cy: number, maxR: number): number {
  let m = 1;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI;
    m = Math.max(m, silhouetteAspect(buf, cx, cy, Math.cos(a), Math.sin(a), maxR).aspect);
  }
  return m;
}

/**
 * Holes: along rays from the center, once the field drops below the threshold
 * it must not come back above it within `maxR` (a star-shaped drop, no donut
 * holes or detached rings). Returns the number of rays that re-enter.
 */
export function holeRays(buf: BlobBuffer, cx: number, cy: number, maxR: number, rays = 48): number {
  let bad = 0;
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let exited = false;
    for (let j = 0; j <= 200; j++) {
      const r = (j / 200) * maxR;
      const inside = fieldAt(buf, cx + ux * r, cy + uy * r) > FIELD_THRESHOLD;
      if (!inside) exited = true;
      else if (exited) {
        bad++;
        break;
      }
    }
  }
  return bad;
}
