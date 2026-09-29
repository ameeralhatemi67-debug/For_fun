/**
 * Hand geometry on MediaPipe-style landmarks (21 points).
 *
 * Landmarks are stored flat as `Float64Array(63)`: x, y, z per point in
 * *world units* (screen-isotropic, mirror already applied, z on the same scale).
 * Everything here is pure math on that array, so camera, mouse simulation and
 * tests all share it.
 */
import { clamp01 } from '../utils/math';

export type Landmarks = Float64Array;
export const LANDMARK_COUNT = 21;

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
} as const;

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export const FINGER_NAMES: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
/** [base, joint1, joint2, tip] per finger (thumb: CMC, MCP, IP, TIP). */
export const FINGER_JOINTS: Record<FingerName, readonly [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const newLandmarks = (): Landmarks => new Float64Array(LANDMARK_COUNT * 3);

export function lmX(lm: Landmarks, i: number): number {
  return lm[i * 3];
}
export function lmY(lm: Landmarks, i: number): number {
  return lm[i * 3 + 1];
}

export function dist3(lm: Landmarks, a: number, b: number): number {
  const dx = lm[a * 3] - lm[b * 3];
  const dy = lm[a * 3 + 1] - lm[b * 3 + 1];
  const dz = lm[a * 3 + 2] - lm[b * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Apparent palm size (3D landmark lengths, so it is fairly rotation-robust).
 * Used both to normalize gesture thresholds and as the primary depth signal:
 * it shrinks as the hand moves away from the camera.
 */
export function palmSize(lm: Landmarks): number {
  return (
    (dist3(lm, LM.WRIST, LM.MIDDLE_MCP) +
      dist3(lm, LM.WRIST, LM.INDEX_MCP) +
      dist3(lm, LM.WRIST, LM.PINKY_MCP) +
      dist3(lm, LM.INDEX_MCP, LM.PINKY_MCP) * 1.4) /
    4
  );
}

const remap = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/**
 * Normalized finger extension: 0 = fully curled, 1 = straight.
 * Combines two rotation-invariant cues:
 *  - straightness: tip–base distance over the summed segment lengths,
 *  - reach: is the tip farther from the wrist than the middle joint?
 * Neither uses a screen axis, so it works with the hand rotated in the image.
 */
export function fingerExtension(lm: Landmarks, finger: Exclude<FingerName, 'thumb'>): number {
  const [m, p, d, t] = FINGER_JOINTS[finger];
  const len = dist3(lm, m, p) + dist3(lm, p, d) + dist3(lm, d, t);
  const straight = len > 1e-9 ? dist3(lm, m, t) / len : 0;
  const pw = dist3(lm, p, LM.WRIST);
  const reach = pw > 1e-9 ? dist3(lm, t, LM.WRIST) / pw : 0;
  return 0.5 * remap(straight, 0.5, 0.92) + 0.5 * remap(reach, 0.9, 1.25);
}

/**
 * Thumb openness: distance of the thumb tip from the index finger's base
 * segment (index MCP → PIP), in palm sizes. ≈0.2 when folded/pressed onto
 * the side of the index, ≈0.7+ when extended like a raised hammer.
 */
export function thumbOpenness(lm: Landmarks): number {
  const ps = palmSize(lm);
  if (ps <= 1e-9) return 0;
  const t = LM.THUMB_TIP * 3;
  const a = LM.INDEX_MCP * 3;
  const b = LM.INDEX_PIP * 3;
  const abx = lm[b] - lm[a];
  const aby = lm[b + 1] - lm[a + 1];
  const abz = lm[b + 2] - lm[a + 2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  const u = ab2 > 1e-12 ? clamp01(((lm[t] - lm[a]) * abx + (lm[t + 1] - lm[a + 1]) * aby + (lm[t + 2] - lm[a + 2]) * abz) / ab2) : 0;
  const dx = lm[t] - (lm[a] + abx * u);
  const dy = lm[t + 1] - (lm[a + 1] + aby * u);
  const dz = lm[t + 2] - (lm[a + 2] + abz * u);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / ps;
}

export interface Dir2 {
  x: number;
  y: number;
}

/**
 * Screen-space pointing direction of a finger (unit vector, world units).
 * Uses PIP/IP → TIP. When the finger is curled or strongly foreshortened
 * (pointing at the camera) its own direction is unreliable, so it is blended
 * toward the whole hand's direction (wrist → finger base).
 */
export function fingerDirection(lm: Landmarks, finger: FingerName, extension: number, out: Dir2): Dir2 {
  const [base, j1, , tip] = FINGER_JOINTS[finger];
  let fx = lm[tip * 3] - lm[j1 * 3];
  let fy = lm[tip * 3 + 1] - lm[j1 * 3 + 1];
  const fl = Math.hypot(fx, fy);
  let hx = lm[base * 3] - lm[LM.WRIST * 3];
  let hy = lm[base * 3 + 1] - lm[LM.WRIST * 3 + 1];
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl;
  hy /= hl;
  const ps2 = Math.hypot(lm[LM.MIDDLE_MCP * 3] - lm[0], lm[LM.MIDDLE_MCP * 3 + 1] - lm[1]) || 1;
  // Reliability of the finger's own direction: extended and clearly visible in 2D.
  const w = clamp01(extension * 1.4 - 0.2) * remap(fl / ps2, 0.12, 0.35);
  if (fl > 1e-9) {
    fx /= fl;
    fy /= fl;
  } else {
    fx = hx;
    fy = hy;
  }
  let x = hx + (fx - hx) * w;
  let y = hy + (fy - hy) * w;
  const l = Math.hypot(x, y) || 1;
  x /= l;
  y /= l;
  out.x = x;
  out.y = y;
  return out;
}

/** Index aim direction for the handgun: index MCP → TIP (long, stable baseline). */
export function aimDirection(lm: Landmarks, out: Dir2): Dir2 {
  const x = lm[LM.INDEX_TIP * 3] - lm[LM.INDEX_MCP * 3];
  const y = lm[LM.INDEX_TIP * 3 + 1] - lm[LM.INDEX_MCP * 3 + 1];
  const l = Math.hypot(x, y);
  if (l > 1e-9) {
    out.x = x / l;
    out.y = y / l;
  }
  return out;
}

const PALM_POINTS = [LM.WRIST, LM.THUMB_CMC, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
const PALM_CENTER_POINTS = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
const FINGER_PIPS = [LM.INDEX_PIP, LM.MIDDLE_PIP, LM.RING_PIP, LM.PINKY_PIP];

export function palmCenter(lm: Landmarks, out: Dir2): Dir2 {
  let x = 0;
  let y = 0;
  for (const i of PALM_CENTER_POINTS) {
    x += lm[i * 3];
    y += lm[i * 3 + 1];
  }
  out.x = x / PALM_CENTER_POINTS.length;
  out.y = y / PALM_CENTER_POINTS.length;
  return out;
}

/**
 * Convex palm polygon (world units, CCW in screen coords) from wrist + MCPs,
 * optionally extended by the PIP joints of open fingers. Returns the vertex count.
 */
export function palmHull(lm: Landmarks, fingerOpen: readonly boolean[] | null, out: Float64Array): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of PALM_POINTS) {
    xs.push(lm[i * 3]);
    ys.push(lm[i * 3 + 1]);
  }
  if (fingerOpen) {
    for (let f = 0; f < 4; f++) {
      if (!fingerOpen[f + 1]) continue;
      xs.push(lm[FINGER_PIPS[f] * 3]);
      ys.push(lm[FINGER_PIPS[f] * 3 + 1]);
    }
  }
  return convexHull(xs, ys, out);
}

/** Andrew's monotone chain. Writes x,y pairs into `out`, returns vertex count. */
export function convexHull(xs: number[], ys: number[], out: Float64Array): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const cross = (o: number, a: number, b: number) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const hull: number[] = [];
  for (const i of idx) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = idx.length - 2; k >= 0; k--) {
    const i = idx[k];
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  const n = Math.min(hull.length, out.length / 2);
  for (let k = 0; k < n; k++) {
    out[k * 2] = xs[hull[k]];
    out[k * 2 + 1] = ys[hull[k]];
  }
  return n;
}

/**
 * Signed distance from point to a convex polygon (negative inside) and the
 * outward normal at the closest feature. Polygon winding may be either way.
 */
export function polygonSignedDistance(
  poly: Float64Array,
  n: number,
  px: number,
  py: number,
  out: { d: number; nx: number; ny: number },
): { d: number; nx: number; ny: number } {
  let best = Infinity;
  let bnx = 0;
  let bny = 0;
  let inside = true;
  // Winding sign so that "left of edge" consistently means inside.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  const wind = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const ex = poly[j * 2] - ax;
    const ey = poly[j * 2 + 1] - ay;
    const e2 = ex * ex + ey * ey;
    const u = e2 > 1e-18 ? clamp01(((px - ax) * ex + (py - ay) * ey) / e2) : 0;
    const cx = ax + ex * u;
    const cy = ay + ey * u;
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    if ((ex * (py - ay) - ey * (px - ax)) * wind < 0) inside = false;
    if (d < best) {
      best = d;
      if (d > 1e-12) {
        bnx = dx / d;
        bny = dy / d;
      } else {
        // On the edge: use the edge's outward normal.
        const el = Math.sqrt(e2) || 1;
        bnx = (ey / el) * wind;
        bny = (-ex / el) * wind;
      }
    }
  }
  if (inside) {
    // Closest edge point direction points inward; flip to get the outward normal.
    out.d = -best;
    out.nx = -bnx;
    out.ny = -bny;
    if (best <= 1e-12) {
      out.nx = bnx;
      out.ny = bny;
    }
  } else {
    out.d = best;
    out.nx = bnx;
    out.ny = bny;
  }
  return out;
}
