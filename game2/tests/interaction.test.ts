import { describe, expect, it } from 'vitest';
import { coverRect, videoToScreen } from '../src/camera/CameraController';
import { DEFAULT_SETTINGS } from '../src/config/schema';
import { POSE_CURLS, synthHand } from '../src/input/SyntheticHand';
import { SIM_PALM_SIZE } from '../src/input/ScriptDriver';
import { HandPipeline, type HandInput } from '../src/tracking/HandPipeline';
import { FIELD_THRESHOLD } from '../src/physics/shape';
import { BlobBuffer } from '../src/physics/blobBuffer';
import { fieldAt } from './helpers/silhouette';
import { World, type SimHandSpec } from './helpers/world';

const S = DEFAULT_SETTINGS;
const R = S.baseRadius;
const point = (x: number, y: number, extra: Partial<SimHandSpec> = {}): SimHandSpec => ({ id: 1, pose: 'TRACK', x, y, ...extra });

describe('finger gap + spawn', () => {
  it('puts the anchor beyond the fingertip along the finger, at (gap + 1)·R', () => {
    for (const roll of [0, 1.2, -2.4]) {
      for (const gap of [0, 0.8, 2]) {
        const w = new World({ fingerGap: gap });
        w.run(0.6, () => [point(0.6, 0.5, { roll })]);
        const d = w.sim.anchorDebug[0];
        const dist = Math.hypot(d.targetX - d.tipX, d.targetY - d.tipY);
        expect(dist).toBeCloseTo((gap + 1) * R, 6);
        // Along the finger: roll r points along (sin r, −cos r) for the sim hand (±splay).
        const dirX = (d.targetX - d.tipX) / dist;
        const dirY = (d.targetY - d.tipY) / dist;
        expect(dirX * Math.sin(roll) - dirY * Math.cos(roll)).toBeGreaterThan(0.98);
      }
    }
  });

  it('mirroring the camera mirrors the pointing direction (the gap stays beyond the fingertip on screen)', () => {
    // Camera path: normalized video landmarks → videoToScreen (same transform as the renderer).
    const rect = coverRect(1280, 720, 1280, 720);
    const video = synthHand(POSE_CURLS.TRACK, { x: 0.4, y: 0.6, anchor: 'indexTip', roll: 0.7, size: 0.2 });
    for (const mirror of [false, true]) {
      const lm = new Float64Array(63);
      for (let i = 0; i < 21; i++) {
        const q = videoToScreen(video[i * 3], video[i * 3 + 1], rect, mirror, 1280);
        lm[i * 3] = q.x / 720;
        lm[i * 3 + 1] = q.y / 720;
        lm[i * 3 + 2] = (video[i * 3 + 2] * rect.w) / 720;
      }
      const p = new HandPipeline();
      for (let k = 0; k < 10; k++) p.update([{ id: 1, label: 'x', confidence: 1, lm }], k / 30, S);
      const d = p.hands[0].dirs.index;
      // Video roll 0.7 points right (+x) in the image; mirrored it must point left on screen.
      expect(Math.sign(d.x)).toBe(mirror ? -1 : 1);
      // The screen-space tip → anchor offset continues the on-screen finger (PIP → TIP).
      const tipX = lm[8 * 3];
      const pipX = lm[6 * 3];
      expect(Math.sign(tipX - pipX)).toBe(Math.sign(d.x));
    }
  });

  it('spawns exactly at the anchor, starts invisible and grows over spawnGrowDuration', () => {
    const w = new World({ spawnGrowDuration: 0.5 });
    const seen: { t: number; pres: number; dx: number }[] = [];
    w.run(1.2, () => [point(0.9, 0.6)], (ww, t) => {
      const b = ww.body;
      if (b.alive) seen.push({ t, pres: b.presence, dx: Math.hypot(b.x - ww.sim.anchors[0].x, b.y - ww.sim.anchors[0].y) });
    });
    const first = seen[0];
    expect(first.pres).toBeLessThan(0.06); // effectively invisible
    expect(first.dx).toBeLessThan(0.1 * R); // in place, no fly-in
    const full = seen.find((f) => f.pres >= 1)!;
    expect(full.t - first.t).toBeGreaterThan(0.5 - 0.05);
    expect(full.t - first.t).toBeLessThan(0.5 + 0.05);
    // Grows monotonically while condensing.
    for (let i = 1; i < seen.length; i++) expect(seen[i].pres).toBeGreaterThanOrEqual(seen[i - 1].pres);
  });

  it('a hand that reappears elsewhere after a real loss condenses there (no fly-in); brief loss does not respawn', () => {
    const w = new World();
    w.run(1.0, () => [point(0.3, 0.5)]);
    const spawns0 = w.sim.counters.spawns;
    // Brief loss (shorter than the grace period): same body continues.
    w.run(S.graceDuration * 0.5, () => []);
    w.run(0.5, () => [point(0.31, 0.5)]);
    expect(w.sim.counters.spawns).toBe(spawns0);
    expect(w.body.presence).toBeGreaterThan(0.95);
    // Real loss: body fades out completely.
    w.run(S.graceDuration + S.fadeDuration + 0.8, () => []);
    expect(w.body.alive).toBe(false);
    // Reappears far away: first visible frame is already at the new place.
    let maxJumpFromNew = 0;
    let firstX = NaN;
    w.run(0.6, () => [point(1.1, 0.4)], (ww) => {
      const b = ww.body;
      if (!b.alive) return;
      if (Number.isNaN(firstX)) firstX = b.x;
      maxJumpFromNew = Math.max(maxJumpFromNew, Math.abs(b.x - ww.sim.anchors[0].x));
    });
    expect(w.sim.counters.spawns).toBe(spawns0 + 1);
    expect(firstX).toBeGreaterThan(1.0);
    expect(maxJumpFromNew).toBeLessThan(0.5 * R);
  });
});

describe('depth scale', () => {
  it('closer hand grows the liquid, farther shrinks it, clamped to the limits', () => {
    const w = new World({ depthSmoothing: 0.1 });
    w.run(0.8, () => [point(0.6, 0.5, { size: 1 })]);
    expect(w.body.depthScale).toBeCloseTo(1, 2);
    w.run(1.2, () => [point(0.6, 0.5, { size: 1.25 })]);
    const expected = 1 + S.depthScaleStrength * 0.25;
    expect(w.body.depthScale).toBeCloseTo(expected, 2);
    expect(w.body.radius(w.s)).toBeCloseTo(R * expected, 3); // one radius for render, collisions, fusion
    w.run(1.2, () => [point(0.6, 0.5, { size: 0.8 })]);
    expect(w.body.depthScale).toBeLessThan(1);
    w.run(1.2, () => [point(0.6, 0.5, { size: 3 })]);
    expect(w.body.depthScale).toBeCloseTo(S.depthMaxScale, 3);
    w.run(1.2, () => [point(0.6, 0.5, { size: 0.3 })]);
    expect(w.body.depthScale).toBeCloseTo(S.depthMinScale, 3);
  });

  it('rejects single-frame detector spikes and smooths real changes', () => {
    const w = new World();
    w.run(0.8, () => [point(0.6, 0.5)]);
    let maxDev = 0;
    w.run(1.0, (t) => [point(0.6, 0.5, { size: t > 0.3 && t < 0.3 + 1 / 60 ? 2.5 : 1 })], (ww) => {
      maxDev = Math.max(maxDev, Math.abs(ww.body.depthScale - 1));
    });
    expect(maxDev).toBeLessThan(0.01);
    // A real step is followed smoothly (not instantly).
    w.tickHands(1 / 60, [point(0.6, 0.5, { size: 1.3 })]);
    w.tickHands(1 / 60, [point(0.6, 0.5, { size: 1.3 })]);
    w.tickHands(1 / 60, [point(0.6, 0.5, { size: 1.3 })]);
    expect(w.body.depthScale).toBeLessThan(1 + S.depthScaleStrength * 0.3 * 0.5);
  });

  it('disabled depth keeps scale 1', () => {
    const w = new World({ depthScaleEnabled: false });
    w.run(0.5, () => [point(0.6, 0.5)]);
    w.run(1.0, () => [point(0.6, 0.5, { size: 1.5 })]);
    expect(w.body.depthScale).toBe(1);
  });
});

/** Hand A holds the ball pointing right, at (x, y) palm center. */
const pointRight = (x: number, y: number, pose: SimHandSpec['pose'] = 'TRACK', id = 1): SimHandSpec => ({
  id,
  pose,
  x,
  y,
  anchor: 'palm',
  roll: Math.PI / 2,
});

describe('free ball, palm push, recapture', () => {
  it('opening the hand releases the ball with its current momentum, and there is no hidden tether', () => {
    const w = new World();
    // Move right steadily, then open the palm mid-motion.
    const x = (t: number) => 0.3 + 0.6 * t;
    w.run(0.8, (t) => [pointRight(x(t), 0.5)]);
    const vBefore = w.body.vx;
    expect(vBefore).toBeGreaterThan(0.3);
    let releasedV = NaN;
    w.run(0.5, (t) => [pointRight(x(0.8 + t), 0.5, 'PALM')], (ww) => {
      if (Number.isNaN(releasedV) && ww.body.control === 'FREE') releasedV = ww.body.vx;
    });
    expect(w.body.control).toBe('FREE');
    expect(releasedV).toBeGreaterThan(vBefore * 0.7);
    // The hand now moves far away (up): a free ball only feels drag.
    const v0 = w.body.vx;
    const y0 = w.body.y;
    w.run(0.5, () => [pointRight(0.2, 0.1, 'PALM')]);
    expect(w.body.vx).toBeCloseTo(v0 * Math.exp(-S.freeDrag * 0.5), 1);
    expect(Math.abs(w.body.y - y0)).toBeLessThan(0.03);
  });

  it('a moving palm hits the free ball and transfers momentum; a still palm bounces it back', () => {
    const w = new World({ freeDrag: 0 });
    // Spawn at hand A, release, then hand B's open palm approaches from the right.
    w.run(0.8, () => [pointRight(0.3, 0.5)]);
    w.run(0.4, () => [pointRight(0.3, 0.5, 'PALM')]);
    expect(w.body.control).toBe('FREE');
    const bx = w.body.x;
    const by = w.body.y;
    // B: left-facing palm centered on the ball's line, sweeping left at ~1.5 u/s.
    const specB = (t: number): SimHandSpec => ({ id: 2, pose: 'PALM', x: bx + 0.45 - 1.5 * Math.max(0, t - 0.1), y: by, anchor: 'palm', roll: -Math.PI / 2, flip: true });
    const hits0 = w.sim.palmHits.length;
    w.run(0.35, (t) => [pointRight(0.1, 0.5, 'PALM'), specB(t)]);
    const hit = w.sim.palmHits.slice(hits0).find((h) => h.hand === 2);
    expect(hit).toBeDefined();
    expect(w.body.vx).toBeLessThan(-1.5); // pushed left, faster than the palm (bounce)
    expect(w.body.control).toBe('FREE'); // not captured by the palm
  });

  it('two-hand volley: A → B → A with both palms colliding', () => {
    const w = new World({ freeDrag: 0.1 });
    w.run(0.8, () => [pointRight(0.25, 0.5)]);
    w.run(0.4, () => [pointRight(0.25, 0.5, 'PALM')]);
    const by = w.body.y;
    // Line both palms up with the ball, B waits on the right; A jabs.
    const A = (t: number): SimHandSpec => ({ id: 1, pose: 'PALM', x: 0.25 + (t > 0.3 && t < 0.45 ? (t - 0.3) * 1.6 : t >= 0.45 ? 0.24 : 0), y: by + 0.015, anchor: 'palm', roll: Math.PI / 2 });
    const B = (): SimHandSpec => ({ id: 2, pose: 'PALM', x: 1.1, y: by + 0.015, anchor: 'palm', roll: -Math.PI / 2, flip: true });
    const signs: number[] = [];
    w.run(3, (t) => [A(t), B()], (ww) => {
      const s = Math.sign(Math.round(ww.body.vx * 10));
      if (s !== 0 && s !== signs[signs.length - 1]) signs.push(s);
    });
    const hands = w.sim.palmHits.map((h) => h.hand);
    expect(hands).toContain(1);
    expect(hands).toContain(2);
    // Went right (A's push), came back left (B's bounce), and right again (A).
    expect(signs.slice(0, 3)).toEqual([1, -1, 1]);
  });

  it('returning to TRACK recaptures magnetically: no teleport, ends anchored at the finger', () => {
    const w = new World();
    w.run(0.8, () => [pointRight(0.3, 0.5)]);
    w.run(0.4, () => [pointRight(0.3, 0.5, 'PALM')]);
    // Push the ball away and let it drift.
    w.body.vx = 0.8;
    w.run(0.8, () => [pointRight(0.3, 0.5, 'PALM')]);
    const far = Math.hypot(w.body.x - w.sim.anchors[0].x, w.body.y - w.sim.anchors[0].y);
    expect(far).toBeGreaterThan(4 * R);
    let maxStep = 0;
    let px = w.body.x;
    let py = w.body.y;
    let anchoredAt = -1;
    w.run(2.5, () => [pointRight(0.3, 0.5, 'TRACK')], (ww, t) => {
      const b = ww.body;
      maxStep = Math.max(maxStep, Math.hypot(b.x - px, b.y - py));
      px = b.x;
      py = b.y;
      if (anchoredAt < 0 && b.control === 'ANCHORED') anchoredAt = t;
    });
    expect(w.sim.counters.recaptures).toBeGreaterThanOrEqual(1);
    expect(maxStep).toBeLessThan(0.05); // ≤ 3 u/s at 60 Hz: glides, never jumps
    expect(anchoredAt).toBeGreaterThan(0.1);
    expect(anchoredAt).toBeLessThan(2.0);
    expect(Math.hypot(w.body.x - w.sim.anchors[0].x, w.body.y - w.sim.anchors[0].y)).toBeLessThan(0.5 * R);
  });
});

describe('handgun', () => {
  const gun = (press: boolean, x = 0.3, y = 0.5, roll = Math.PI / 2 + 0.3): SimHandSpec => ({
    id: 1,
    pose: 'GUN',
    x,
    y,
    anchor: 'palm',
    roll,
    press,
  });

  it('fires along the index direction from the current position with shotSpeed', () => {
    const w = new World({ shotHandVelocityInfluence: 0 });
    w.run(1.0, () => [gun(false)]);
    expect(w.pipe.hands[0].gesture).toBe('HANDGUN');
    expect(w.body.control).toBe('ANCHORED');
    const aim = { ...w.pipe.hands[0].aim };
    let before = { x: 0, y: 0 };
    let fired: { x: number; y: number; vx: number; vy: number } | null = null;
    w.run(0.3, (t) => [gun(t < 0.15)], (ww) => {
      const b = ww.body;
      if (!fired && b.control === 'SHOT') fired = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
      if (!fired) before = { x: b.x, y: b.y };
    });
    expect(fired).not.toBeNull();
    const f = fired!;
    // Launched from where it was (one frame of travel at most), not from the ray origin.
    expect(Math.hypot(f.x - before.x, f.y - before.y)).toBeLessThan((S.shotSpeed / 60) * 1.5 + 0.005);
    const sp = Math.hypot(f.vx, f.vy);
    expect(sp).toBeGreaterThan(S.shotSpeed * 0.9);
    expect(sp).toBeLessThan(S.shotSpeed * 1.1);
    expect((f.vx * aim.x + f.vy * aim.y) / sp).toBeGreaterThan(0.99); // along the aim (±8°)
    expect(w.sim.counters.shots).toBe(1);
  });

  it('holding the thumb down fires once; re-arm is needed; cooldown blocks rapid refire', () => {
    const w = new World({ shotCooldown: 0.8, offscreenDespawnDelay: 0.05 });
    w.run(1.0, () => [gun(false)]);
    w.run(0.35, () => [gun(true)]); // hold pressed (below the hold-release time)
    expect(w.sim.counters.shots).toBe(1);
    // The shot flies away and despawns; the gun hand reloads a fresh ball in place.
    w.run(1.0, () => [gun(false)]);
    expect(w.body.alive).toBe(true);
    expect(w.body.control).toBe('ANCHORED');
    expect(w.sim.counters.despawns).toBeGreaterThanOrEqual(1);
    // Re-armed; a press right now is still inside the cooldown of 0.8 s? (1.35 s elapsed → allowed)
    w.run(0.2, () => [gun(true)]);
    expect(w.sim.counters.shots).toBe(2);
    // Quick re-arm + press inside the cooldown: ignored.
    w.run(0.15, () => [gun(false)]);
    w.run(0.15, () => [gun(true)]);
    expect(w.sim.counters.shots).toBe(2);
  });

  it('an off-screen shot is cleaned up after the delay', () => {
    const w = new World({ offscreenDespawnDelay: 0.4 });
    w.run(1.0, () => [gun(false)]);
    w.run(0.2, (t) => [gun(t < 0.1)]);
    expect(w.body.control).toBe('SHOT');
    // Hand leaves; the shot keeps flying right and leaves the view.
    let despawnedAt = -1;
    let leftAt = -1;
    w.run(2.5, () => [], (ww, t) => {
      const b = ww.body;
      if (leftAt < 0 && b.x > ww.viewW + S.freeBoundsMargin + b.radius(ww.s)) leftAt = t;
      if (despawnedAt < 0 && !b.alive) despawnedAt = t;
    });
    expect(leftAt).toBeGreaterThan(0);
    expect(despawnedAt - leftAt).toBeGreaterThan(0.4 - 0.05);
    expect(despawnedAt - leftAt).toBeLessThan(0.4 + 0.1);
  });

  it('a shot collides with an open palm', () => {
    const w = new World();
    w.run(1.0, () => [gun(false, 0.25, 0.5, Math.PI / 2)]);
    const by = w.body.y;
    const B: SimHandSpec = { id: 2, pose: 'PALM', x: 1.05, y: by + 0.015, anchor: 'palm', roll: -Math.PI / 2, flip: true };
    w.run(1.0, (t) => [gun(t < 0.12, 0.25, 0.5, Math.PI / 2), B]);
    expect(w.sim.palmHits.some((h) => h.hand === 2 && h.impact > 1)).toBe(true);
    expect(w.body.vx).toBeLessThan(0);
  });
});

describe('fusion contact', () => {
  const two = (ax: number, bx: number, y = 0.5): SimHandSpec[] => [
    { id: 1, pose: 'TRACK', x: ax, y },
    { id: 2, pose: 'TRACK', x: bx, y, flip: true },
  ];

  it('surface extent of a resting body is its radius; gap = distance − both extents', () => {
    const w = new World({ idleWobble: 0 }, 'fusion');
    w.run(1.5, () => two(0.3, 1.0));
    const [b0, b1] = w.sim.bodies;
    expect(b0.surfaceExtent(1, 0, w.s)).toBeCloseTo(b0.radius(w.s), 2);
    const d = Math.hypot(b1.x - b0.x, b1.y - b0.y);
    expect(w.sim.surfaceGap).toBeCloseTo(d - b0.radius(w.s) - b1.radius(w.s), 2);
  });

  it('CONTACT happens exactly when the rendered liquids touch, and not while they are visibly apart', () => {
    const w = new World({ attractionStrength: 0, reachStrength: 0, neckStrength: 0, minContactTime: 5 }, 'fusion');
    const buf = new BlobBuffer();
    let contactWhileApart = 0;
    let touchingWithoutContact = 0;
    let firstTouch = -1;
    let firstContact = -1;
    // Slowly bring two fingers together.
    w.run(4, (t) => two(0.3 + 0.08 * t, 1.0 - 0.08 * t), (ww, t) => {
      const [b0, b1] = ww.sim.bodies;
      if (!b0.alive || !b1.alive || b0.presence < 1 || b1.presence < 1) return;
      ww.sim.writeBlobs(buf);
      // Rendered field at the midpoint between the surfaces.
      const mx = (b0.x + b1.x) / 2;
      const my = (b0.y + b1.y) / 2;
      const touching = fieldAt(buf, mx, my) > FIELD_THRESHOLD;
      const st = ww.sim.fusion.state;
      if (touching && firstTouch < 0) firstTouch = t;
      if (st === 'CONTACT' && firstContact < 0) firstContact = t;
      if (st === 'CONTACT' && ww.sim.surfaceGap > 0.4 * R) contactWhileApart++;
      if (touching && st !== 'CONTACT' && firstContact > 0) touchingWithoutContact++;
    });
    expect(firstTouch).toBeGreaterThan(0);
    expect(firstContact).toBeGreaterThan(0);
    expect(Math.abs(firstContact - firstTouch)).toBeLessThan(0.35);
    expect(contactWhileApart).toBe(0);
    expect(touchingWithoutContact).toBe(0);
  });

  it('fusion neck appears on approach, carries a blue→red gradient, and vanishes on separation', () => {
    const w = new World({ minContactTime: 5 }, 'fusion');
    const buf = new BlobBuffer();
    w.run(1.0, () => two(0.3, 1.0));
    expect(w.sim.neck).toBeLessThan(0.01);
    w.run(3, (t) => two(0.3 + 0.1 * Math.min(t, 2.2), 1.0 - 0.1 * Math.min(t, 2.2)));
    expect(w.sim.neck).toBeGreaterThan(0.5);
    w.sim.writeBlobs(buf);
    // Some blob carries an intermediate palette position (the gradient bridge).
    const mixes: number[] = [];
    for (let i = 0; i < buf.count; i++) mixes.push(buf.data[i * 8 + 7] % 2);
    expect(mixes.some((m) => m > 0.3 && m < 0.7)).toBe(true);
    // Pull apart: the neck fades away.
    w.run(2, (t) => two(0.52 - 0.12 * t, 0.78 + 0.12 * t));
    expect(w.sim.neck).toBeLessThan(0.05);
  });

  it('blue and red fuse into purple when held in contact', () => {
    const w = new World({}, 'fusion');
    w.run(1.0, () => two(0.3, 1.0));
    w.run(4, (t) => two(0.3 + 0.12 * Math.min(t, 2.1), 1.0 - 0.12 * Math.min(t, 2.1)));
    expect(w.sim.counters.fusions).toBe(1);
    expect(['PURPLE']).toContain(w.sim.fusion.state);
    expect(w.sim.bodies[1].alive).toBe(false);
  });
});

describe('hand pipeline plumbing', () => {
  it('drops hands below the confidence threshold and forgets hands after a while', () => {
    const p = new HandPipeline();
    const lm = synthHand(POSE_CURLS.TRACK, { x: 0.5, y: 0.5, anchor: 'indexTip', roll: 0, size: SIM_PALM_SIZE });
    const inp = (c: number): HandInput[] => [{ id: 7, label: 'x', confidence: c, lm }];
    p.update(inp(0.1), 0, S);
    expect(p.hands.length).toBe(0);
    p.update(inp(0.9), 0.1, S);
    expect(p.hands.length).toBe(1);
    p.update([], 0.2, S);
    expect(p.hands[0].visible).toBe(false);
    p.update([], 1.0, S);
    expect(p.hands.length).toBe(0);
  });
});
