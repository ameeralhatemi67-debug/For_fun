import { easeInOutCubic } from '../utils/math';

/**
 * Deterministic test motions that feed the same anchor pipeline as the mouse
 * and the camera. Used for repeatable visual comparisons (and automated tests).
 * Positions are in world units relative to the viewport center.
 */
export const SCRIPT_NAMES = ['circle', 'sweep', 'stop', 'reverse', 'shake', 'loss', 'fusion'] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

export const SCRIPT_LABELS: Record<ScriptName, string> = {
  circle: 'Circle',
  sweep: 'Fast sweep',
  stop: 'Abrupt stops',
  reverse: 'Direction reversal',
  shake: 'Shake gentle→aggressive',
  loss: 'Tracking loss',
  fusion: 'Fusion approach',
};

export interface ScriptFrame {
  ax: number;
  ay: number;
  aOn: boolean;
  bx: number;
  by: number;
  bOn: boolean;
  /** Request a fusion split at this moment. */
  split: boolean;
}

const out: ScriptFrame = { ax: 0, ay: 0, aOn: true, bx: 0.3, by: 0, bOn: true, split: false };

/** Piecewise hold-then-move between waypoints (time in s per leg, move takes `mv`). */
function legs(t: number, pts: readonly (readonly [number, number])[], hold: number, mv: number): [number, number] {
  const leg = hold + mv;
  const total = leg * pts.length;
  const tt = ((t % total) + total) % total;
  const i = Math.floor(tt / leg);
  const local = tt - i * leg;
  const from = pts[i];
  const to = pts[(i + 1) % pts.length];
  if (local < hold) return [from[0], from[1]];
  const k = easeInOutCubic((local - hold) / mv);
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
}

export function scriptFrame(name: ScriptName, t: number, halfW: number, halfH: number): ScriptFrame {
  const W = Math.min(halfW * 0.65, 0.6);
  const H = Math.min(halfH * 0.7, 0.35);
  out.aOn = true;
  out.bOn = true;
  out.split = false;
  out.bx = W * 0.7;
  out.by = 0;
  switch (name) {
    case 'circle': {
      const w = 2.4;
      out.ax = Math.cos(t * w) * H * 0.8;
      out.ay = Math.sin(t * w) * H * 0.8;
      break;
    }
    case 'sweep': {
      [out.ax, out.ay] = legs(t, [[-W, 0], [W, 0]], 1.1, 0.42);
      break;
    }
    case 'stop': {
      [out.ax, out.ay] = legs(t, [[-W * 0.8, -H * 0.4], [W * 0.1, -H * 0.4], [W * 0.8, H * 0.3], [-W * 0.2, H * 0.4]], 1.3, 0.14);
      break;
    }
    case 'reverse': {
      // Constant-speed motion that snaps its direction every 0.6 s.
      const p = 1.2;
      const ph = (t % p) / p;
      const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      out.ax = (tri * 2 - 1) * W * 0.7;
      out.ay = 0;
      break;
    }
    case 'shake': {
      const phase = t % 6;
      const aggressive = phase >= 3;
      const f = aggressive ? 7 : 3.5;
      const amp = aggressive ? W * 0.28 : W * 0.08;
      out.ax = Math.sin(t * f * Math.PI * 2) * amp;
      out.ay = Math.sin(t * f * Math.PI * 1.3) * amp * 0.2;
      break;
    }
    case 'loss': {
      // 0-2 s tracked motion, 2-2.15 brief loss (grace), 2.15-4 tracked,
      // 4-6 long loss (fade), 6+ reappears elsewhere, 8 loop.
      const tt = t % 8;
      out.ax = Math.cos(tt * 1.8) * W * 0.6;
      out.ay = Math.sin(tt * 1.8) * H * 0.5;
      out.aOn = !((tt > 2 && tt < 2.15) || (tt > 4 && tt < 6));
      break;
    }
    case 'fusion': {
      // 0-3.5 approach slowly, 3.5-5 hold together (fuse), 5-8 purple moves,
      // 8 split, 8-10 separate, 10 loop.
      const tt = t % 10.5;
      const approach = easeInOutCubic(Math.min(1, tt / 3.5));
      const gap = tt < 5 ? W * 0.75 * (1 - approach) + 0.02 : Math.min(W * 0.75, 0.02 + Math.max(0, tt - 8) * 0.4);
      const cx = tt > 5 && tt < 8 ? Math.sin((tt - 5) * 3) * W * 0.4 : 0;
      const cy = tt > 5 && tt < 8 ? Math.sin((tt - 5) * 5) * H * 0.3 : 0;
      out.ax = cx - gap / 2;
      out.ay = cy;
      out.bx = gap / 2;
      out.by = 0;
      out.split = tt > 8 && tt < 8.05;
      break;
    }
  }
  return out;
}
