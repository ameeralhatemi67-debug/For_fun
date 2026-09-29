/**
 * Landmarks (world units) → per-hand state the simulation consumes:
 * stable gesture, finger tips + smoothed pointing directions, handgun aim,
 * a palm collider with velocity, and a smoothed depth scale.
 *
 * Camera, mouse simulation and scripts all feed this with 21 landmarks per
 * hand and a stable id; nothing downstream knows where the hand came from.
 */
import type { Settings } from '../config/schema';
import { clamp, expAlpha } from '../utils/math';
import { HandGestureClassifier, type Gesture, type GestureReading } from './GestureClassifier';
import {
  FINGER_JOINTS,
  aimDirection,
  fingerDirection,
  newLandmarks,
  palmCenter,
  palmHull,
  palmSize,
  type Dir2,
  type FingerName,
  type Landmarks,
} from './handModel';
import { OneEuroFilter2D } from './OneEuroFilter';

export interface HandInput {
  id: number;
  label: string;
  confidence: number;
  lm: Landmarks;
}

/** How long a hand that is no longer detected keeps its identity/state. */
export const HAND_FORGET_AFTER = 0.6;
/** Max extrapolation of the palm collider between tracker samples (s). */
const PALM_EXTRAPOLATE = 0.08;
const MAX_POLY = 12;

export interface PalmSample {
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  readonly poly: Float64Array;
  n: number;
}

/** Smoothed palm center + velocity + convex polygon, sampleable at any time. */
export class PalmTracker {
  cx = 0;
  cy = 0;
  vx = 0;
  vy = 0;
  lastT = -1;
  private rawCx = 0;
  private rawCy = 0;
  private euro = new OneEuroFilter2D();
  private prevX = 0;
  private prevY = 0;
  private local = new Float64Array(MAX_POLY * 2);
  private hull = new Float64Array(MAX_POLY * 2);
  private n = 0;
  private c: Dir2 = { x: 0, y: 0 };

  update(lm: Landmarks, fingerOpen: readonly boolean[] | null, t: number, s: Settings): void {
    palmCenter(lm, this.c);
    if (this.lastT < 0 || t - this.lastT > 0.3) {
      this.euro.reset(this.c.x, this.c.y, t);
      this.vx = this.vy = 0;
      this.prevX = this.c.x;
      this.prevY = this.c.y;
    } else {
      // Palm is a big, well-tracked region: lighter smoothing than the fingertip.
      this.euro.filter(this.c.x, this.c.y, t, s.smoothingMinCutoff * 1.6, s.smoothingBeta);
      const dt = t - this.lastT;
      if (dt > 1e-4) {
        const k = 0.6;
        this.vx += ((this.euro.x - this.prevX) / dt - this.vx) * k;
        this.vy += ((this.euro.y - this.prevY) / dt - this.vy) * k;
      }
      this.prevX = this.euro.x;
      this.prevY = this.euro.y;
    }
    this.cx = this.euro.x;
    this.cy = this.euro.y;
    this.rawCx = this.c.x;
    this.rawCy = this.c.y;
    this.n = palmHull(lm, fingerOpen, this.hull);
    for (let i = 0; i < this.n; i++) {
      this.local[i * 2] = this.hull[i * 2] - this.rawCx;
      this.local[i * 2 + 1] = this.hull[i * 2 + 1] - this.rawCy;
    }
    this.lastT = t;
  }

  /** Collider at time `now` (extrapolated a little along the palm velocity). */
  sample(now: number, out: PalmSample): PalmSample {
    const e = clamp(now - this.lastT, 0, PALM_EXTRAPOLATE);
    out.cx = this.cx + this.vx * e;
    out.cy = this.cy + this.vy * e;
    out.vx = this.vx;
    out.vy = this.vy;
    out.n = this.n;
    for (let i = 0; i < this.n; i++) {
      out.poly[i * 2] = out.cx + this.local[i * 2];
      out.poly[i * 2 + 1] = out.cy + this.local[i * 2 + 1];
    }
    return out;
  }
}

export const newPalmSample = (): PalmSample => ({ cx: 0, cy: 0, vx: 0, vy: 0, poly: new Float64Array(MAX_POLY * 2), n: 0 });

const TRACKED_FINGERS: readonly FingerName[] = ['index', 'middle', 'thumb', 'pinky'];

export class HandState {
  readonly id: number;
  label = '';
  confidence = 0;
  /** Detected in the most recent tracker result. */
  visible = false;
  /** Updated during the current tick (a fresh tracker result arrived). */
  fresh = false;
  firstSeen = 0;
  lastSeen = 0;
  readonly lm = newLandmarks();
  readonly classifier = new HandGestureClassifier();
  /** Finger tips (world) and smoothed pointing directions. */
  readonly tips: Record<FingerName, Dir2> = {
    thumb: { x: 0, y: 0 },
    index: { x: 0, y: 0 },
    middle: { x: 0, y: 0 },
    ring: { x: 0, y: 0 },
    pinky: { x: 0, y: 0 },
  };
  readonly dirs: Record<FingerName, Dir2> = {
    thumb: { x: 0, y: -1 },
    index: { x: 0, y: -1 },
    middle: { x: 0, y: -1 },
    ring: { x: 0, y: -1 },
    pinky: { x: 0, y: -1 },
  };
  readonly aim: Dir2 = { x: 0, y: -1 };
  readonly palm = new PalmTracker();
  /** Raw apparent palm size (world units) = primary depth signal. */
  palmSize = 0;
  /** Median-filtered palm size relative to the depth baseline. */
  depthRel = 1;
  /** Smoothed, clamped depth scale for bodies controlled by this hand. */
  depthScale = 1;
  /** Developer fallback (Space/click): fire as if the thumb was pressed. */
  forceFire = false;
  private sizeHist: number[] = [];
  private tmp: Dir2 = { x: 0, y: 0 };
  private dirInit = false;

  constructor(id: number) {
    this.id = id;
  }

  get reading(): GestureReading {
    return this.classifier.reading;
  }
  get gesture(): Gesture {
    return this.classifier.reading.gesture;
  }
  get epoch(): number {
    return this.classifier.reading.epoch;
  }
  /** One-shot fire event for this tick (thumb hammer or developer fallback). */
  get fire(): boolean {
    return this.fresh && (this.classifier.reading.fire || this.forceFire);
  }

  update(input: HandInput, t: number, s: Settings, baseline: number): void {
    const dt = this.dirInit ? Math.max(1e-3, t - this.lastSeen) : 0;
    this.label = input.label;
    this.confidence = input.confidence;
    this.lm.set(input.lm);
    const r = this.classifier.update(this.lm, t, s);

    for (const f of TRACKED_FINGERS) {
      const tip = FINGER_JOINTS[f][3];
      this.tips[f].x = this.lm[tip * 3];
      this.tips[f].y = this.lm[tip * 3 + 1];
      const ext = f === 'thumb' ? Math.min(1, r.ext[0]) : r.ext[f === 'index' ? 1 : f === 'middle' ? 2 : 4];
      fingerDirection(this.lm, f, ext, this.tmp);
      this.smoothDir(this.dirs[f], this.tmp, dt, s.fingerDirSmoothing);
    }
    aimDirection(this.lm, this.tmp);
    this.smoothDir(this.aim, this.tmp, dt, Math.min(0.05, s.fingerDirSmoothing));
    this.dirInit = true;

    this.palm.update(this.lm, s.palmIncludeFingers ? r.open : null, t, s);

    // Depth: median of recent palm sizes (spike rejection) → relative to baseline → smoothed.
    this.palmSize = palmSize(this.lm);
    this.sizeHist.push(this.palmSize);
    if (this.sizeHist.length > 5) this.sizeHist.shift();
    const med = [...this.sizeHist].sort((a, b) => a - b)[this.sizeHist.length >> 1];
    this.depthRel = baseline > 0 ? med / baseline : 1;
    const target = s.depthScaleEnabled
      ? clamp(1 + s.depthScaleStrength * (this.depthRel - 1), s.depthMinScale, s.depthMaxScale)
      : 1;
    if (dt === 0) this.depthScale = target;
    else this.depthScale += (target - this.depthScale) * expAlpha(dt, s.depthSmoothing);

    if (!this.visible) this.firstSeen = t;
    this.visible = true;
    this.fresh = true;
    this.lastSeen = t;
  }

  /** Median palm size so far (for establishing a depth baseline). */
  medianSize(): number {
    if (!this.sizeHist.length) return 0;
    return [...this.sizeHist].sort((a, b) => a - b)[this.sizeHist.length >> 1];
  }
  get sampleCount(): number {
    return this.sizeHist.length;
  }

  private smoothDir(out: Dir2, v: Dir2, dt: number, tau: number): void {
    if (!this.dirInit || dt === 0) {
      out.x = v.x;
      out.y = v.y;
      return;
    }
    const a = expAlpha(dt, tau);
    let x = out.x + (v.x - out.x) * a;
    let y = out.y + (v.y - out.y) * a;
    const l = Math.hypot(x, y);
    if (l < 1e-6) {
      x = v.x;
      y = v.y;
    } else {
      x /= l;
      y /= l;
    }
    out.x = x;
    out.y = y;
  }
}

/**
 * Keeps one HandState per stable hand id. `hands` is sorted by id, so the
 * oldest hand is first (primary).
 */
export class HandPipeline {
  hands: HandState[] = [];
  /** Palm size that maps to depth scale 1 (−1 = not established yet). */
  depthBaseline = -1;
  private byId = new Map<number, HandState>();

  reset(): void {
    this.hands = [];
    this.byId.clear();
  }

  resetDepthBaseline(): void {
    this.depthBaseline = -1;
  }

  /** Call once per tick before `update`: clears per-tick events. */
  beginTick(): void {
    for (const h of this.hands) {
      h.fresh = false;
      h.forceFire = false;
    }
  }

  /**
   * `inputs` = the hands of a new tracker result (possibly empty), or null when
   * no new result arrived this tick.
   */
  update(inputs: readonly HandInput[] | null, t: number, s: Settings): void {
    if (inputs) {
      const seen = new Set<number>();
      for (const inp of inputs) {
        if (inp.confidence < s.confidenceThreshold) continue;
        let h = this.byId.get(inp.id);
        if (!h) {
          h = new HandState(inp.id);
          this.byId.set(inp.id, h);
        }
        h.update(inp, t, s, this.depthBaseline);
        seen.add(inp.id);
        if (this.depthBaseline < 0 && h.sampleCount >= 5) {
          this.depthBaseline = h.medianSize();
          h.depthScale = 1;
        }
      }
      for (const h of this.byId.values()) if (!seen.has(h.id)) h.visible = false;
    }
    for (const [id, h] of this.byId) if (!h.visible && t - h.lastSeen > HAND_FORGET_AFTER) this.byId.delete(id);
    this.hands = [...this.byId.values()].sort((a, b) => a.id - b.id);
  }
}
