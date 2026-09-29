import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/schema';
import { POSE_CURLS, synthHand, type HandCurls, type SimPose } from '../src/input/SyntheticHand';
import { GUN_HOLD_RELEASE, GestureStabilizer, HandGestureClassifier, rawGesture, type Gesture } from '../src/tracking/GestureClassifier';
import { fingerDirection, fingerExtension, palmSize, thumbOpenness } from '../src/tracking/handModel';

const S: Settings = { ...DEFAULT_SETTINGS };
const DT = 1 / 30; // tracker rate

const pose = (p: SimPose | HandCurls, roll = 0, flip = false, size = 0.13) =>
  synthHand(typeof p === 'string' ? POSE_CURLS[p] : p, { x: 0.5, y: 0.5, anchor: 'palm', roll, size, flip });

/** Feed a pose for `secs` at tracker rate; returns the last gesture. */
function hold(c: HandGestureClassifier, p: SimPose | HandCurls, secs: number, t0: number, roll = 0, flip = false) {
  let t = t0;
  let g: Gesture = 'NEUTRAL';
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    t += DT;
    g = c.update(pose(p, roll, flip), t, S).gesture;
  }
  return { g, t };
}

describe('finger geometry', () => {
  it('extension separates straight and curled fingers at any roll, handedness and scale', () => {
    for (const roll of [0, 0.9, -2.2, Math.PI]) {
      for (const flip of [false, true]) {
        for (const size of [0.08, 0.2]) {
          const open = pose('PALM', roll, flip, size);
          const fist = pose([0, 1, 1, 1, 1], roll, flip, size);
          for (const f of ['index', 'middle', 'ring', 'pinky'] as const) {
            expect(fingerExtension(open, f)).toBeGreaterThan(0.9);
            expect(fingerExtension(fist, f)).toBeLessThan(0.1);
          }
        }
      }
    }
  });

  it('thumb openness: extended hammer vs pressed onto the index side', () => {
    expect(thumbOpenness(pose('GUN'))).toBeGreaterThan(S.thumbTriggerThreshold * 1.35);
    expect(thumbOpenness(pose([1, 0, 1, 1, 1]))).toBeLessThan(S.thumbTriggerThreshold);
  });

  it('palm size scales with apparent hand size (depth signal)', () => {
    expect(palmSize(pose('PALM', 0, false, 0.2)) / palmSize(pose('PALM', 0, false, 0.1))).toBeCloseTo(2, 5);
  });

  it('finger direction follows the pointing finger, mirrored hands mirror it', () => {
    const d = { x: 0, y: 0 };
    fingerDirection(pose('TRACK', Math.PI / 2), 'index', 1, d);
    expect(d.x).toBeGreaterThan(0.95); // pointing right
    const lm = pose('TRACK', 0.6);
    fingerDirection(lm, 'index', 1, d);
    const mirrored = Float64Array.from(lm);
    for (let i = 0; i < 21; i++) mirrored[i * 3] = 1 - mirrored[i * 3];
    const dm = { x: 0, y: 0 };
    fingerDirection(mirrored, 'index', 1, dm);
    expect(dm.x).toBeCloseTo(-d.x, 6);
    expect(dm.y).toBeCloseTo(d.y, 6);
  });
});

describe('raw gesture rules', () => {
  // [thumb, index, middle, ring, pinky] open flags
  it('TRACK = ring + pinky closed; PALM_PUSH = ring + pinky open; else NEUTRAL', () => {
    expect(rawGesture([false, true, false, false, false], false, 'NEUTRAL')).toBe('TRACK');
    expect(rawGesture([false, true, true, false, false], true, 'NEUTRAL')).toBe('TRACK'); // middle open: two-finger track
    expect(rawGesture([true, true, true, true, true], true, 'NEUTRAL')).toBe('PALM_PUSH');
    expect(rawGesture([false, true, false, true, false], false, 'NEUTRAL')).toBe('NEUTRAL');
  });
  it('HANDGUN has priority over TRACK when the thumb is armed', () => {
    expect(rawGesture([true, true, false, false, false], true, 'TRACK')).toBe('HANDGUN');
    // Thumb pressed: stays a gun only while the gun is already active.
    expect(rawGesture([false, true, false, false, false], false, 'HANDGUN')).toBe('HANDGUN');
    expect(rawGesture([false, true, false, false, false], false, 'TRACK')).toBe('TRACK');
    expect(rawGesture([false, true, false, false, false], false, 'HANDGUN', false)).toBe('TRACK');
  });
});

describe('HandGestureClassifier (synthetic landmarks)', () => {
  it('classifies TRACK, PALM_PUSH, HANDGUN and NEUTRAL poses at several rolls', () => {
    for (const roll of [0, 1.3, -1.9]) {
      for (const flip of [false, true]) {
        const expectPose = (p: SimPose, g: Gesture) => {
          const c = new HandGestureClassifier();
          expect(hold(c, p, 0.5, 0, roll, flip).g).toBe(g);
        };
        expectPose('TRACK', 'TRACK');
        expectPose('TWO', 'TRACK');
        expectPose('FIST', 'TRACK');
        expectPose('PALM', 'PALM_PUSH');
        expectPose('GUN', 'HANDGUN');
        expectPose('NEUTRAL', 'NEUTRAL');
      }
    }
  });

  it('needs the enter dwell before switching and ignores brief flickers', () => {
    const c = new HandGestureClassifier();
    let { t } = hold(c, 'TRACK', 0.5, 0);
    expect(c.reading.gesture).toBe('TRACK');
    // A 2-sample (≈67 ms) palm flicker is shorter than the enter dwell: no switch.
    ({ t } = hold(c, 'PALM', 2 * DT, t));
    expect(c.reading.gesture).toBe('TRACK');
    ({ t } = hold(c, 'TRACK', 0.3, t));
    expect(c.reading.gesture).toBe('TRACK');
    // A held palm switches after ~max(enter, exit) dwell.
    let switched = -1;
    for (let i = 1; i <= 15; i++) {
      t += DT;
      if (c.update(pose('PALM'), t, S).gesture === 'PALM_PUSH' && switched < 0) switched = i * DT;
    }
    expect(switched).toBeGreaterThanOrEqual(Math.max(S.gestureEnterDwell, S.gestureExitDwell) - 1e-6);
    expect(switched).toBeLessThan(Math.max(S.gestureEnterDwell, S.gestureExitDwell) + 3 * DT);
  });

  it('does not flicker when a finger hovers around the open/closed thresholds', () => {
    const c = new HandGestureClassifier();
    let { t } = hold(c, 'TRACK', 0.5, 0);
    let changes = 0;
    let prev = c.reading.gesture;
    // Ring + pinky jitter between curls whose extensions straddle the thresholds.
    for (let i = 0; i < 120; i++) {
      t += DT;
      const k = i % 2 ? 0.46 : 0.54;
      const g = c.update(pose([0.9, 0, 1, k, k]), t, S).gesture;
      if (g !== prev) changes++;
      prev = g;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('stabilizer: a new gesture must be seen continuously for the dwell', () => {
    const st = new GestureStabilizer();
    st.reset(0);
    let t = 0;
    for (let i = 0; i < 20; i++) st.update('TRACK', (t += DT), S);
    expect(st.stable).toBe('TRACK');
    const e0 = st.epoch;
    // Alternating raw PALM / TRACK never persists long enough.
    for (let i = 0; i < 40; i++) st.update(i % 3 === 0 ? 'TRACK' : 'PALM_PUSH', (t += DT), S);
    expect(st.stable).toBe('TRACK');
    expect(st.epoch).toBe(e0);
  });

  it('thumb trigger: one shot per press, re-arm required, no shot on entering the gun pose', () => {
    const c = new HandGestureClassifier();
    let t = 0;
    let fires = 0;
    const feed = (curls: HandCurls, secs: number) => {
      for (let i = 0; i < Math.round(secs / DT); i++) {
        t += DT;
        if (c.update(pose(curls), t, S).fire) fires++;
      }
    };
    const armed: HandCurls = [0, 0, 1, 1, 1];
    const pressed: HandCurls = [1, 0, 1, 1, 1];
    feed(armed, 0.5);
    expect(c.reading.gesture).toBe('HANDGUN');
    expect(fires).toBe(0);
    feed(pressed, 0.1); // press
    expect(fires).toBe(1);
    expect(c.reading.gesture).toBe('HANDGUN'); // pressing is the trigger, not a pose change
    feed(pressed, 0.2); // keep holding: no auto-fire
    expect(fires).toBe(1);
    feed(armed, 0.15); // re-arm
    feed(pressed, 0.1);
    expect(fires).toBe(2);
    // Holding the thumb folded longer means "just pointing" → TRACK.
    feed(pressed, GUN_HOLD_RELEASE + 0.4);
    expect(c.reading.gesture).toBe('TRACK');
    expect(fires).toBe(2);
  });

  it('a pointing hand that raises its thumb becomes a gun only after the gun dwell', () => {
    const c = new HandGestureClassifier();
    let { t } = hold(c, 'TRACK', 0.5, 0);
    let at = -1;
    for (let i = 1; i <= 20; i++) {
      t += DT;
      if (c.update(pose('GUN'), t, S).gesture === 'HANDGUN' && at < 0) at = i * DT;
    }
    expect(at).toBeGreaterThanOrEqual(S.gunGestureDwell - 1e-6);
    expect(at).toBeLessThan(S.gunGestureDwell + 0.2);
  });
});
