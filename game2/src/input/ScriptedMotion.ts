import { easeInOutCubic, smoothstep } from '../utils/math';
import type { SimPose } from './SyntheticHand';

/**
 * Deterministic test motions. Each frame describes up to two *virtual hands*
 * (position, pose, roll, apparent size, thumb press). They are turned into
 * 21 synthetic landmarks and go through the same geometry → gesture →
 * physics pipeline as the camera, so every interaction is testable without
 * a webcam. Positions are in world units relative to the viewport center.
 */
export const SCRIPT_NAMES = [
  'circle',
  'medium',
  'sweep',
  'stop',
  'reverse',
  'shake',
  'loss',
  'spawn',
  'depth',
  'palm',
  'volley',
  'gun',
  'fusion',
] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

export const SCRIPT_LABELS: Record<ScriptName, string> = {
  circle: 'Circle',
  medium: 'Medium sweep',
  sweep: 'Fast sweep',
  stop: 'Abrupt stops',
  reverse: 'Direction reversal',
  shake: 'Shake gentle→aggressive',
  loss: 'Tracking loss',
  spawn: 'Spawn / respawn',
  depth: 'Depth grow/shrink',
  palm: 'Palm: release, push, recapture',
  volley: 'Two-palm volley',
  gun: 'Handgun: aim, fire, reload',
  fusion: 'Fusion approach',
};

/** Scripts that need both hands in Purple mode too (palm play). */
export const TWO_HAND_SCRIPTS: readonly ScriptName[] = ['palm', 'volley', 'gun'];

export interface ScriptHand {
  on: boolean;
  x: number;
  y: number;
  pose: SimPose;
  /** Which hand point sits at (x, y). */
  anchor: 'indexTip' | 'palm';
  /** In-plane rotation (rad), 0 = fingers up, +π/2 = pointing right. */
  roll: number;
  /** Apparent size multiplier (depth: >1 closer). */
  size: number;
  /** Thumb held pressed (handgun trigger). */
  press: boolean;
}

export interface ScriptFrame {
  a: ScriptHand;
  b: ScriptHand;
  /** Request a fusion split at this moment. */
  split: boolean;
}

const hand = (): ScriptHand => ({ on: true, x: 0, y: 0, pose: 'TRACK', anchor: 'indexTip', roll: 0, size: 1, press: false });
const out: ScriptFrame = { a: hand(), b: hand(), split: false };

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

/**
 * With the hand rolled to point sideways, the anchored ball sits at the index
 * finger's height: this far (world units) off the palm center for the sim hand.
 */
const BALL_LINE = 0.073;

/** Ball position relative to the view center (lets palm scripts "play" like a person would). */
export interface ScriptBall {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
const noBall: ScriptBall = { alive: false, x: 0, y: 0, vx: 0, vy: 0 };

/**
 * Palm heights for the palm-play scripts: like a player, each palm lines up
 * with the ball while it is on the far half and holds still while it arrives
 * (a palm moving vertically at contact would pass its velocity to the ball).
 */
const aim = { a: -BALL_LINE, b: -BALL_LINE };
/** Volley: when each palm last started a jab / when the current serve began (script time). */
const volley = { a: -9, b: -9, serve: 0 };
/** Height where the ball will cross x = px (a player anticipates), clamped to the view. */
function arrivalY(ball: ScriptBall, px: number, H: number): number {
  let y = ball.y;
  if (Math.abs(ball.vx) > 0.2) {
    const tt = (px - ball.x) / ball.vx;
    if (tt > 0) y += ball.vy * Math.min(tt, 1.5);
  }
  return Math.max(-H, Math.min(H, y));
}
function updateAim(ball: ScriptBall, H: number, t: number, firstPush: number, ax: number, bx: number): void {
  if (t < 0.05 || !ball.alive) {
    aim.a = aim.b = -BALL_LINE;
    return;
  }
  // Line up while the ball is still far; hold still for the last stretch (a palm moving
  // vertically at contact hands its velocity to the ball).
  const k = 0.15;
  if (ball.x - ax > 0.3 || t < firstPush - 0.08) aim.a += (arrivalY(ball, ax, H) - aim.a) * k;
  if (bx - ball.x > 0.3) aim.b += (arrivalY(ball, bx, H) - aim.b) * k;
}

/** A quick forward jab of `dist` starting at `t0` (0.18 s out, 0.5 s back). */
function jab(t: number, t0: number, dist: number): number {
  const u = t - t0;
  if (u < 0 || u > 0.68) return 0;
  if (u < 0.18) return dist * easeInOutCubic(u / 0.18);
  return dist * (1 - easeInOutCubic((u - 0.18) / 0.5));
}

function reset(h: ScriptHand): void {
  h.on = true;
  h.x = h.y = 0;
  h.pose = 'TRACK';
  h.anchor = 'indexTip';
  h.roll = 0;
  h.size = 1;
  h.press = false;
}

export function scriptFrame(name: ScriptName, t: number, halfW: number, halfH: number, ball: ScriptBall = noBall): ScriptFrame {
  const W = Math.min(halfW * 0.65, 0.6);
  const H = Math.min(halfH * 0.7, 0.35);
  const { a, b } = out;
  reset(a);
  reset(b);
  out.split = false;
  b.x = W * 0.7;
  b.on = false;
  switch (name) {
    case 'circle': {
      const w = 2.4;
      a.x = Math.cos(t * w) * H * 0.8;
      a.y = Math.sin(t * w) * H * 0.8;
      break;
    }
    case 'medium': {
      [a.x, a.y] = legs(t, [[-W * 0.7, 0], [W * 0.7, 0]], 0.9, 0.8);
      break;
    }
    case 'sweep': {
      [a.x, a.y] = legs(t, [[-W, 0], [W, 0]], 1.1, 0.42);
      break;
    }
    case 'stop': {
      [a.x, a.y] = legs(t, [[-W * 0.8, -H * 0.4], [W * 0.1, -H * 0.4], [W * 0.8, H * 0.3], [-W * 0.2, H * 0.4]], 1.3, 0.14);
      break;
    }
    case 'reverse': {
      // Constant-speed motion that snaps its direction every 0.6 s.
      const p = 1.2;
      const ph = (t % p) / p;
      const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      a.x = (tri * 2 - 1) * W * 0.7;
      break;
    }
    case 'shake': {
      const phase = t % 6;
      const aggressive = phase >= 3;
      const f = aggressive ? 7 : 3.5;
      const amp = aggressive ? W * 0.28 : W * 0.08;
      a.x = Math.sin(t * f * Math.PI * 2) * amp;
      a.y = Math.sin(t * f * Math.PI * 1.3) * amp * 0.2;
      break;
    }
    case 'loss': {
      // 0-2 s tracked motion, 2-2.15 brief loss (grace), 2.15-4 tracked,
      // 4-6 long loss (fade), 6+ reappears elsewhere, 8 loop.
      const tt = t % 8;
      a.x = Math.cos(tt * 1.8) * W * 0.6;
      a.y = Math.sin(tt * 1.8) * H * 0.5;
      a.on = !((tt > 2 && tt < 2.15) || (tt > 4 && tt < 6));
      break;
    }
    case 'spawn': {
      // Appears at 0.4 s (condenses in place), long absence 3.2–4.4 s, reappears elsewhere.
      const tt = t % 6.5;
      a.on = tt > 0.4 && !(tt > 3.2 && tt < 4.4);
      const late = tt >= 4.4;
      a.x = (late ? W * 0.45 : -W * 0.45) + 0.05 * Math.sin(tt * 1.3);
      a.y = (late ? -H * 0.25 : H * 0.15) + 0.03 * Math.sin(tt * 0.9);
      a.roll = late ? -0.35 : 0.3;
      break;
    }
    case 'depth': {
      // Hand moves toward / away from the camera (apparent size), with a one-frame
      // detector spike at 2.0 s that must not make the liquid pulse.
      const tt = t % 8;
      a.x = 0.08 * Math.sin(tt * 0.7);
      a.y = H * 0.25;
      const phase = smoothstep(0.5, 2.5, tt) - smoothstep(4.0, 6.5, tt);
      a.size = 1 + 0.45 * phase - 0.3 * smoothstep(5.5, 7.0, tt) * (1 - smoothstep(7.4, 8, tt));
      if (tt > 2.0 && tt < 2.02) a.size = 2.2;
      break;
    }
    case 'palm': {
      // A points (ball anchored) → opens palm (release) → pushes the ball across →
      // it bounces off B's open palm → B hits it back → A points again (recapture).
      const tt = t % 9;
      a.anchor = b.anchor = 'palm';
      a.roll = Math.PI / 2;
      b.roll = -Math.PI / 2;
      a.pose = tt > 1.5 && tt < 6.5 ? 'PALM' : 'TRACK';
      a.x = -W * 0.85 + jab(tt, 2.0, 0.15);
      // After opening, the palm slides onto the ball's line, then pushes.
      updateAim(ball, H, tt, 2.0, -W * 0.85, W * 1.05);
      const k = smoothstep(1.5, 1.9, tt) - smoothstep(6.3, 6.6, tt);
      a.y = aim.a * k;
      b.on = tt > 0.6;
      b.pose = 'PALM';
      b.x = W * 1.05 - jab(tt, 3.4, 0.12);
      b.y = aim.b;
      break;
    }
    case 'volley': {
      // Rally between two open palms. Each palm jabs when the ball arrives; if the ball
      // is lost, A points to condense a new one and serves again.
      const ax0 = -W * 0.85;
      const bx0 = W * 1.05;
      a.anchor = b.anchor = 'palm';
      a.roll = Math.PI / 2;
      b.roll = -Math.PI / 2;
      b.pose = 'PALM';
      b.on = t > 0.6;
      if (t < 0.1) {
        volley.a = volley.b = -9;
        volley.serve = 0;
      }
      if (!ball.alive && t - volley.serve > 1.5) volley.serve = t; // lost → new serve cycle
      const st = t - volley.serve;
      a.pose = st < 1.2 ? 'TRACK' : 'PALM';
      if (st > 1.6 && volley.a < volley.serve + 1.6) volley.a = volley.serve + 1.6;
      if (ball.alive && st > 2) {
        if (ball.vx < -0.2 && ball.x - ax0 < 0.3 && t - volley.a > 0.7) volley.a = t;
        if (ball.vx > 0.2 && bx0 - ball.x < 0.3 && t - volley.b > 0.7) volley.b = t;
      }
      updateAim(ball, H, st, 1.6, ax0, bx0);
      a.x = ax0 + jab(t, volley.a, 0.15);
      a.y = aim.a * smoothstep(1.2, 1.5, st);
      b.x = bx0 - jab(t, volley.b, 0.12);
      b.y = aim.b;
      break;
    }
    case 'gun': {
      // Aim right, thumb-fire at B's palm, fist (TRACK) to recapture, aim again, fire again.
      const tt = t % 8;
      a.anchor = b.anchor = 'palm';
      a.roll = Math.PI / 2 + 0.08;
      b.roll = -Math.PI / 2;
      a.x = -W * 0.9;
      a.y = H * 0.1 + 0.02 * Math.sin(tt * 1.7);
      // Thumbs-up fist (ring + pinky closed, no trigger fold) = TRACK → recapture.
      a.pose = tt < 0.6 ? 'FIST' : tt < 3.4 ? 'GUN' : tt < 4.6 ? 'FIST' : 'GUN';
      a.press = (tt > 1.8 && tt < 1.98) || (tt > 6.0 && tt < 6.18);
      b.on = true;
      b.pose = 'PALM';
      b.x = W * 1.05;
      updateAim(ball, H, tt, 99, -W * 0.9, W * 1.05);
      b.y = aim.b;
      break;
    }
    case 'fusion': {
      // 0-3.5 approach slowly, 3.5-5 hold together (fuse), 5-8 purple moves,
      // 8 split, 8-10 separate, 10 loop.
      const tt = t % 10.5;
      const approach = easeInOutCubic(Math.min(1, tt / 3.5));
      const gap = tt < 5 ? W * 1.3 * (1 - approach) + 0.02 : Math.min(W * 1.3, 0.02 + Math.max(0, tt - 8) * 0.6);
      const cx = tt > 5 && tt < 8 ? Math.sin((tt - 5) * 3) * W * 0.4 : 0;
      const cy = tt > 5 && tt < 8 ? Math.sin((tt - 5) * 5) * H * 0.3 : 0;
      a.x = cx - gap / 2;
      a.y = cy;
      b.on = true;
      b.x = gap / 2;
      b.y = 0;
      out.split = tt > 8 && tt < 8.05;
      break;
    }
  }
  return out;
}
