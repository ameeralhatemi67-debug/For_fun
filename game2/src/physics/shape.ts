/**
 * Shared metaball field definition. The renderer's GLSL uses the exact same
 * kernel and threshold, so the TS side can calibrate blob sizes such that the
 * resting silhouette radius equals the configured base radius regardless of
 * how many secondary points are used.
 */

/** Iso-surface threshold of the summed field. */
export const FIELD_THRESHOLD = 0.35;

/** Wyvill-style compact kernel: w·(1-q²)³ for q = d/support < 1. */
export function kernel(d: number, support: number, weight = 1): number {
  const q2 = (d * d) / (support * support);
  if (q2 >= 1) return 0;
  const t = 1 - q2;
  return weight * t * t * t;
}

/** Visual radius → support radius for an isolated blob of weight 1. */
export const SINGLE_BLOB_SUPPORT = 1 / Math.sqrt(1 - Math.cbrt(FIELD_THRESHOLD));

// Unit-shape layout (before calibration): body radius 1.
// v0.2: a smaller, lighter core and a wider, heavier ring, so the surface
// points own more of the silhouette (≈35% more visible response to ring
// deformation than v0.1) while the core still keeps the drop connected.
export const RING_DIST = 0.55;
export const CENTER_SUPPORT = 0.8;
export const CENTER_WEIGHT = 0.7;
export const RING_SUPPORT = 0.68;
/** Ring blob weight is normalised by count so N does not change the look much. */
export const ringWeight = (n: number) => 6.5 / n;
export const TAIL_SUPPORT = [0.8, 0.64, 0.5] as const;

const calibCache = new Map<number, number>();

/**
 * Returns the factor that maps the unit layout to a silhouette of radius 1.
 * Multiply every unit length (ring distance, supports) by calib·R.
 */
export function shapeCalibration(n: number): number {
  const cached = calibCache.get(n);
  if (cached !== undefined) return cached;
  const w = ringWeight(n);
  const fieldAt = (r: number, theta: number) => {
    let f = kernel(r, CENTER_SUPPORT, CENTER_WEIGHT);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dx = r * Math.cos(theta) - RING_DIST * Math.cos(a);
      const dy = r * Math.sin(theta) - RING_DIST * Math.sin(a);
      f += kernel(Math.hypot(dx, dy), RING_SUPPORT, w);
    }
    return f;
  };
  const silhouette = (theta: number) => {
    let lo = 0;
    let hi = RING_DIST + RING_SUPPORT;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (fieldAt(mid, theta) > FIELD_THRESHOLD) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const r0 = 0.5 * (silhouette(0) + silhouette(Math.PI / n));
  const c = 1 / r0;
  calibCache.set(n, c);
  return c;
}
