import type { Settings } from '../config/schema';
import { clamp01 } from '../utils/math';
import { OneEuroFilter2D } from './OneEuroFilter';

export type AnchorState = 'none' | 'tracking' | 'predicting' | 'lost';

/**
 * Turns a stream of raw fingertip samples (any rate, may drop out) into a
 * stable, continuous target that can be sampled at render time.
 *
 *   raw ─▶ One-Euro ─▶ interpolated between samples ─▶ + reacquire offset ─▶ target
 *
 * - Brief loss: keeps moving on the last velocity (decaying) for `graceDuration`.
 * - Longer loss: state becomes `lost`, target freezes (the body fades out).
 * - Reacquire or single-sample jumps: the output blends from where it was to
 *   the new position (offset decays over `reacquireTime`) instead of teleporting.
 */
export class AnchorFilter {
  state: AnchorState = 'none';
  /** Latest raw sample (for debug). */
  rawX = 0;
  rawY = 0;
  confidence = 0;
  /** Current output target. */
  x = 0;
  y = 0;
  /** Estimated target velocity (u/s). */
  vx = 0;
  vy = 0;
  /** Set when the anchor comes back after being fully lost / newly appears. Consumer clears it. */
  reappeared = false;

  private euro = new OneEuroFilter2D();
  private prevX = 0;
  private prevY = 0;
  private prevT = 0;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private lastSeen = 0;
  private offX0 = 0;
  private offY0 = 0;
  private offT = 0;
  private hasOutput = false;

  get active(): boolean {
    return this.state === 'tracking' || this.state === 'predicting';
  }

  reset(): void {
    this.state = 'none';
    this.hasOutput = false;
    this.vx = this.vy = 0;
    this.offX0 = this.offY0 = 0;
  }

  /** A new raw sample at time t (seconds). */
  push(x: number, y: number, confidence: number, t: number, s: Settings): void {
    this.rawX = x;
    this.rawY = y;
    this.confidence = confidence;
    const jumped =
      this.state === 'tracking' && Math.hypot(x - this.euro.x, y - this.euro.y) > s.jumpThreshold;

    if (this.state === 'tracking' && !jumped) {
      this.euro.filter(x, y, t, s.smoothingMinCutoff, s.smoothingBeta);
      this.prevX = this.lastX;
      this.prevY = this.lastY;
      this.prevT = this.lastT;
      this.lastX = this.euro.x;
      this.lastY = this.euro.y;
      this.lastT = t;
      const dt = this.lastT - this.prevT;
      if (dt > 1e-4) {
        const k = 0.5;
        this.vx += ((this.lastX - this.prevX) / dt - this.vx) * k;
        this.vy += ((this.lastY - this.prevY) / dt - this.vy) * k;
      }
    } else {
      // First sight, reacquire after loss/prediction, or identity jump.
      if (this.state === 'none' || this.state === 'lost') this.reappeared = true;
      this.euro.reset(x, y, t);
      if (this.hasOutput) {
        this.offX0 = this.x - x;
        this.offY0 = this.y - y;
        this.offT = t;
      } else {
        this.offX0 = this.offY0 = 0;
      }
      this.prevX = this.lastX = x;
      this.prevY = this.lastY = y;
      this.prevT = t - 1 / 60;
      this.lastT = t;
      this.vx = this.vy = 0;
      this.state = 'tracking';
    }
    this.lastSeen = t;
  }

  /** Drop any pending reacquire blend (used when the body was invisible anyway). */
  clearBlend(): void {
    this.offX0 = this.offY0 = 0;
  }

  /** The source looked for this anchor at time t and did not find it. */
  missing(t: number, s: Settings): void {
    if (this.state === 'tracking') this.state = 'predicting';
    if (this.state === 'predicting' && t - this.lastSeen > s.graceDuration) this.state = 'lost';
  }

  /** Evaluate the target at render time `now`. */
  sample(now: number, s: Settings): void {
    if (this.state === 'none') return;
    // A stalled source (no pushes, no misses) is treated like a miss.
    if (this.state === 'tracking' && now - this.lastSeen > Math.max(0.25, s.graceDuration)) this.state = 'predicting';
    if (this.state === 'predicting' && now - this.lastSeen > s.graceDuration) this.state = 'lost';

    let bx: number;
    let by: number;
    if (this.state === 'tracking') {
      // Between samples: interpolate (a ∈ 0..1) shifted forward by `controlPrediction`
      // intervals, so the control point is not a full tracker interval late. The heavy
      // body downstream supplies the visible lag.
      const interval = Math.max(this.lastT - this.prevT, 1 / 240);
      const a = clamp01((now - this.lastT) / interval) + s.controlPrediction;
      bx = this.prevX + (this.lastX - this.prevX) * a;
      by = this.prevY + (this.lastY - this.prevY) * a;
    } else if (this.state === 'predicting') {
      // Coast on the last velocity, decaying so it glides to a stop.
      const e = Math.max(0, now - this.lastSeen);
      const tau = Math.max(0.05, s.graceDuration * 0.6);
      const travel = tau * (1 - Math.exp(-e / tau));
      bx = this.lastX + this.vx * travel;
      by = this.lastY + this.vy * travel;
    } else {
      return; // lost: output frozen
    }
    const decay = Math.exp(-Math.max(0, now - this.offT) / Math.max(0.01, s.reacquireTime));
    this.x = bx + this.offX0 * decay;
    this.y = by + this.offY0 * decay;
    this.hasOutput = true;
  }
}
