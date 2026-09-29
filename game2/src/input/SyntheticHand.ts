/**
 * Procedural 21-landmark hand, so mouse mode, scripted motions and unit tests
 * drive the *same* geometry → gesture → physics pipeline as the camera.
 *
 * Local model: palm length (wrist → middle MCP) = 1, fingers pointing up
 * (−y), palm facing the camera, z < 0 toward the camera (MediaPipe convention).
 * Curling bends each finger toward the camera and back down into the palm.
 */
import { newLandmarks, type Landmarks } from '../tracking/handModel';

/** [thumbFold, index, middle, ring, pinky]: thumb 0 = extended/armed, 1 = pressed; fingers 0 = straight, 1 = fist. */
export type HandCurls = [number, number, number, number, number];

export type SimPose = 'TRACK' | 'PALM' | 'GUN' | 'TWO' | 'NEUTRAL' | 'FIST';

export const POSE_CURLS: Record<SimPose, HandCurls> = {
  TRACK: [0.9, 0, 1, 1, 1],
  PALM: [0.05, 0, 0, 0, 0],
  GUN: [0, 0, 1, 1, 1],
  TWO: [0.9, 0, 0, 1, 1],
  NEUTRAL: [0.6, 0, 1, 0, 1],
  /** Thumbs-up fist: ring + pinky closed → TRACK, without a thumb "trigger" fold. */
  FIST: [0, 1, 1, 1, 1],
};

export interface SynthOptions {
  x: number;
  y: number;
  /** Which point lands on (x, y). */
  anchor: 'indexTip' | 'middleTip' | 'palm' | 'wrist';
  /** In-plane rotation (rad). 0 = fingers up; positive turns clockwise on screen. */
  roll: number;
  /** Palm length in world units (≈ apparent hand size → depth). */
  size: number;
  /** Mirror the hand model (left vs right hand). */
  flip?: boolean;
}

const DEG = Math.PI / 180;
// Finger bases (x, y), splay angle and segment lengths, in palm lengths.
const FINGERS: { base: [number, number]; splay: number; seg: [number, number, number] }[] = [
  { base: [-0.36, -0.95], splay: -0.08, seg: [0.45, 0.27, 0.22] },
  { base: [-0.06, -1.0], splay: 0, seg: [0.5, 0.31, 0.24] },
  { base: [0.2, -0.93], splay: 0.08, seg: [0.46, 0.29, 0.23] },
  { base: [0.42, -0.8], splay: 0.18, seg: [0.36, 0.22, 0.2] },
];
const JOINT_CURL = [80 * DEG, 100 * DEG, 60 * DEG];
const THUMB_CMC: [number, number] = [-0.28, -0.22];
const THUMB_SEG = [0.38, 0.3, 0.26];

const local = new Float64Array(63);

function setLocal(i: number, x: number, y: number, z: number): void {
  local[i * 3] = x;
  local[i * 3 + 1] = y;
  local[i * 3 + 2] = z;
}

/** Writes world landmarks for the given curls/placement into `out` (allocates if omitted). */
export function synthHand(curls: readonly number[], o: SynthOptions, out: Landmarks = newLandmarks()): Landmarks {
  setLocal(0, 0, 0, 0);
  // Thumb: in-plane angle swings from abducted (hammer up) to across the index side; flexes toward the camera.
  const f = Math.min(1, Math.max(0, curls[0]));
  const alpha = (-62 + 50 * f) * DEG;
  const flex = (5 + 25 * f) * DEG;
  const dx0 = Math.sin(alpha);
  const dy0 = -Math.cos(alpha);
  let px = THUMB_CMC[0];
  let py = THUMB_CMC[1];
  let pz = 0;
  setLocal(1, px, py, pz);
  const thumbFlex = [0, flex * 0.5, flex];
  for (let k = 0; k < 3; k++) {
    const c = Math.cos(thumbFlex[k]);
    px += THUMB_SEG[k] * dx0 * c;
    py += THUMB_SEG[k] * dy0 * c;
    pz -= THUMB_SEG[k] * Math.sin(thumbFlex[k]);
    setLocal(2 + k, px, py, pz);
  }
  // Fingers.
  for (let fi = 0; fi < 4; fi++) {
    const F = FINGERS[fi];
    const c = Math.min(1, Math.max(0, curls[fi + 1]));
    const d0x = Math.sin(F.splay);
    const d0y = -Math.cos(F.splay);
    const base = 5 + fi * 4;
    px = F.base[0];
    py = F.base[1];
    pz = 0;
    setLocal(base, px, py, pz);
    let th = 0;
    for (let k = 0; k < 3; k++) {
      th += JOINT_CURL[k] * c;
      const ct = Math.cos(th);
      px += F.seg[k] * d0x * ct;
      py += F.seg[k] * d0y * ct;
      pz -= F.seg[k] * Math.sin(th);
      setLocal(base + 1 + k, px, py, pz);
    }
  }
  // Placement point in local coords.
  let ax = 0;
  let ay = 0;
  if (o.anchor === 'indexTip') {
    ax = local[24];
    ay = local[25];
  } else if (o.anchor === 'middleTip') {
    ax = local[36];
    ay = local[37];
  } else if (o.anchor === 'palm') {
    for (const i of [0, 5, 9, 13, 17]) {
      ax += local[i * 3] / 5;
      ay += local[i * 3 + 1] / 5;
    }
  }
  const cr = Math.cos(o.roll);
  const sr = Math.sin(o.roll);
  const fl = o.flip ? -1 : 1;
  for (let i = 0; i < 21; i++) {
    const lx = (local[i * 3] - ax) * fl;
    const ly = local[i * 3 + 1] - ay;
    out[i * 3] = o.x + (lx * cr - ly * sr) * o.size;
    out[i * 3 + 1] = o.y + (lx * sr + ly * cr) * o.size;
    out[i * 3 + 2] = local[i * 3 + 2] * o.size;
  }
  return out;
}

/** Smoothly animated synthetic hand (curls ease toward the target pose like real fingers). */
export class SimHand {
  curls: HandCurls = [...POSE_CURLS.TRACK];
  pose: SimPose = 'TRACK';
  /** Extra thumb press 0..1 on top of the pose (trigger animation). */
  private press = 0;
  private pressUntil = -1;
  readonly lm = newLandmarks();

  setPose(p: SimPose): void {
    this.pose = p;
  }

  /** Animate a thumb hammer press lasting `dur` seconds. */
  pressThumb(now: number, dur = 0.14): void {
    this.pressUntil = now + dur;
  }

  update(dt: number, now: number): void {
    const target = POSE_CURLS[this.pose];
    const k = 1 - Math.exp(-dt / 0.045);
    for (let i = 0; i < 5; i++) this.curls[i] += (target[i] - this.curls[i]) * k;
    const pTarget = now < this.pressUntil ? 1 : 0;
    this.press += (pTarget - this.press) * (1 - Math.exp(-dt / 0.03));
  }

  /** Snap the curls to the pose (no animation). */
  snap(): void {
    this.curls = [...POSE_CURLS[this.pose]];
    this.press = 0;
  }

  write(o: SynthOptions): Landmarks {
    const c = this.curls;
    const thumb = Math.max(c[0], this.press);
    return synthHand([thumb, c[1], c[2], c[3], c[4]], o, this.lm);
  }
}
