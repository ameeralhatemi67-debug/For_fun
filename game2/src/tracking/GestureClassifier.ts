/**
 * Hand gesture classification: landmarks → stable semantic gesture.
 *
 *   landmarks ─▶ finger extensions (rotation-invariant geometry)
 *             ─▶ open/closed per finger (Schmitt trigger)
 *             ─▶ raw pose (priority HANDGUN > PALM_PUSH > TRACK > NEUTRAL)
 *             ─▶ dwell/hysteresis stabilizer ─▶ stable gesture + epoch
 *             ─▶ thumb hammer trigger (HANDGUN only) ─▶ one `fire` per press
 *
 * Rules:
 *   TRACK      ring closed + pinky closed
 *   PALM_PUSH  ring open   + pinky open
 *   HANDGUN    index open, middle/ring/pinky closed, thumb extended (armed).
 *              Once active it stays active while the thumb is pressed — the
 *              press is the trigger, not a pose change. A thumb held folded
 *              longer than GUN_HOLD_RELEASE means "just pointing" → TRACK.
 *   NEUTRAL    anything else (ring and pinky disagree)
 *
 * Nothing in here knows about bodies or physics.
 */
import type { Settings } from '../config/schema';
import { fingerExtension, thumbOpenness, type Landmarks } from './handModel';

export type Gesture = 'TRACK' | 'PALM_PUSH' | 'HANDGUN' | 'NEUTRAL';

/** Gestures in which the index finger anchors a ball. */
export const isAnchoringGesture = (g: Gesture) => g === 'TRACK' || g === 'HANDGUN';

/** Thumb must extend this factor above the trigger threshold to re-arm. */
export const THUMB_REARM_FACTOR = 1.35;
/** A hammer press is quick: a thumb kept folded this long (s) ends the gun pose. */
export const GUN_HOLD_RELEASE = 0.5;

type GestureSettings = Pick<
  Settings,
  | 'fingerOpenAbove'
  | 'fingerClosedBelow'
  | 'gestureEnterDwell'
  | 'gestureExitDwell'
  | 'gunGestureDwell'
  | 'thumbTriggerThreshold'
>;

/**
 * Pure raw-pose rule on finger states [thumb, index, middle, ring, pinky].
 * `gunHold`: the gun is active and the thumb has not been folded for too long.
 */
export function rawGesture(open: readonly boolean[], thumbArmed: boolean, current: Gesture, gunHold = true): Gesture {
  const [, index, middle, ring, pinky] = open;
  const gunShape = index && !middle && !ring && !pinky;
  if (gunShape && (thumbArmed || (current === 'HANDGUN' && gunHold))) return 'HANDGUN';
  if (ring && pinky) return 'PALM_PUSH';
  if (!ring && !pinky) return 'TRACK';
  return 'NEUTRAL';
}

/**
 * Time-based stabilizer: the stable gesture only changes after a different
 * raw gesture has persisted for its enter dwell AND the old one has been
 * absent for the exit dwell. `epoch` counts stable changes.
 */
export class GestureStabilizer {
  stable: Gesture = 'NEUTRAL';
  since = 0;
  epoch = 0;
  private candidate: Gesture = 'NEUTRAL';
  private candidateSince = 0;
  private mismatchSince = -1;

  reset(t: number): void {
    this.stable = this.candidate = 'NEUTRAL';
    this.since = this.candidateSince = t;
    this.mismatchSince = -1;
  }

  update(raw: Gesture, t: number, s: GestureSettings): Gesture {
    if (raw === this.stable) {
      this.candidate = raw;
      this.mismatchSince = -1;
      return this.stable;
    }
    if (this.mismatchSince < 0) this.mismatchSince = t;
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateSince = t;
    }
    const enter =
      raw === 'HANDGUN' ? s.gunGestureDwell : raw === 'NEUTRAL' ? Math.max(0.2, s.gestureEnterDwell * 2) : s.gestureEnterDwell;
    // Tiny epsilon: dwell comparisons at exactly sampled times should pass.
    if (t - this.candidateSince >= enter - 1e-9 && t - this.mismatchSince >= s.gestureExitDwell - 1e-9) {
      this.stable = raw;
      this.since = t;
      this.epoch++;
    }
    return this.stable;
  }
}

export interface GestureReading {
  gesture: Gesture;
  raw: Gesture;
  /** Extension 0..1 for [thumb (openness, unclamped), index, middle, ring, pinky]. */
  ext: number[];
  open: boolean[];
  thumbOpen: number;
  thumbArmed: boolean;
  /** True exactly on the update where a thumb press fired a shot. */
  fire: boolean;
  epoch: number;
}

/** Per-hand stateful classifier. */
export class HandGestureClassifier {
  readonly reading: GestureReading = {
    gesture: 'NEUTRAL',
    raw: 'NEUTRAL',
    ext: [0, 0, 0, 0, 0],
    open: [false, false, false, false, false],
    thumbOpen: 0,
    thumbArmed: false,
    fire: false,
    epoch: 0,
  };
  private stab = new GestureStabilizer();
  private initialized = false;
  /** Thumb had to be seen armed while HANDGUN was already stable (prevents firing on entry). */
  private gunArmed = false;
  /** When the thumb last went from armed to folded (for GUN_HOLD_RELEASE). */
  private foldedSince = -1;

  reset(t: number): void {
    this.initialized = false;
    this.stab.reset(t);
    this.gunArmed = false;
    this.foldedSince = -1;
  }

  update(lm: Landmarks, t: number, s: GestureSettings): GestureReading {
    const r = this.reading;
    r.fire = false;
    r.ext[0] = thumbOpenness(lm);
    r.ext[1] = fingerExtension(lm, 'index');
    r.ext[2] = fingerExtension(lm, 'middle');
    r.ext[3] = fingerExtension(lm, 'ring');
    r.ext[4] = fingerExtension(lm, 'pinky');
    const hiO = Math.max(s.fingerOpenAbove, s.fingerClosedBelow);
    const loC = Math.min(s.fingerOpenAbove, s.fingerClosedBelow);
    for (let f = 1; f < 5; f++) {
      const e = r.ext[f];
      if (!this.initialized) r.open[f] = e >= (hiO + loC) / 2;
      else if (r.open[f] && e < loC) r.open[f] = false;
      else if (!r.open[f] && e > hiO) r.open[f] = true;
    }
    // Thumb: Schmitt trigger between the fire threshold and the re-arm threshold.
    const thr = s.thumbTriggerThreshold;
    const tOpen = r.ext[0];
    r.thumbOpen = tOpen;
    if (!this.initialized) r.thumbArmed = tOpen >= thr * THUMB_REARM_FACTOR;
    else if (r.thumbArmed && tOpen < thr) {
      r.thumbArmed = false;
      this.foldedSince = t;
    } else if (!r.thumbArmed && tOpen > thr * THUMB_REARM_FACTOR) r.thumbArmed = true;
    r.open[0] = r.thumbArmed;
    if (!this.initialized) {
      this.initialized = true;
      this.stab.reset(t);
    }

    const prev = this.stab.stable;
    const gunHold = r.thumbArmed || this.foldedSince < 0 || t - this.foldedSince < GUN_HOLD_RELEASE;
    r.raw = rawGesture(r.open, r.thumbArmed, prev, gunHold);
    r.gesture = this.stab.update(r.raw, t, s);
    r.epoch = this.stab.epoch;

    if (r.gesture === 'HANDGUN') {
      if (prev !== 'HANDGUN') this.gunArmed = r.thumbArmed;
      if (r.thumbArmed) this.gunArmed = true;
      else if (this.gunArmed) {
        // Hammer dropped: armed → pressed while the gun pose is stable.
        this.gunArmed = false;
        r.fire = true;
      }
    } else {
      this.gunArmed = false;
    }
    return r;
  }
}
