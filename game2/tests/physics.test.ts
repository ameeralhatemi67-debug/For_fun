import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/schema';
import { DropletSystem } from '../src/physics/DropletSystem';
import { FluidBody } from '../src/physics/FluidBody';

const DT = 1 / 240;
const S: Settings = { ...DEFAULT_SETTINGS };
const R = S.baseRadius;

function spawn(x = 0.5, y = 0.5): FluidBody {
  const b = new FluidBody(1);
  b.teleport(x, y);
  b.presence = b.presenceTarget = 1;
  return b;
}

/** Runs the body; returns time series of center x. */
function run(b: FluidBody, seconds: number, t0 = 0, target?: (t: number) => [number, number], drops?: DropletSystem) {
  const xs: number[] = [];
  let t = t0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (target) [b.tx, b.ty] = target(t);
    b.step(DT, S, t);
    if (drops) {
      drops.emit(DT, 0, b, S);
      drops.update(DT, [b, b], S);
    }
    xs.push(b.x);
    t += DT;
  }
  return xs;
}

describe('FluidBody', () => {
  it('lags behind a target step, overshoots slightly, then settles', () => {
    const b = spawn(0.5, 0.5);
    const goal = 0.5 + 2 * R;
    b.tx = goal;
    const xs = run(b, 3);
    // Has inertia: after 50 ms it has covered well under half the distance.
    expect(xs[Math.round(0.05 / DT)] - 0.5).toBeLessThan(R);
    const overshoot = Math.max(...xs) - goal;
    expect(overshoot).toBeGreaterThan(0.01 * R); // some overshoot…
    expect(overshoot).toBeLessThan(0.4 * R); // …but only slight
    console.log('step overshoot (radii)', (overshoot / R).toFixed(3));
    expect(Math.abs(b.x - goal)).toBeLessThan(0.02 * R);
    expect(b.deformationAmount(S)).toBeLessThan(0.1);
  });

  it('is alive but compact when the target is still', () => {
    const b = spawn();
    run(b, 1);
    let maxDev = 0;
    let maxDef = 0;
    let t = 1;
    for (let i = 0; i < 5 / DT; i++) {
      b.step(DT, S, t);
      t += DT;
      maxDev = Math.max(maxDev, Math.hypot(b.x - 0.5, b.y - 0.5));
      maxDef = Math.max(maxDef, b.deformationAmount(S));
    }
    expect(maxDev).toBeGreaterThan(0.005 * R); // idle drift exists
    expect(maxDev).toBeLessThan(0.2 * R);
    expect(maxDef).toBeLessThan(0.35);
  });

  it('keeps surface points within max stretch under violent motion', () => {
    const b = spawn();
    run(b, 2, 0, (t) => [0.5 + 0.3 * Math.sin(t * 40), 0.5]);
    for (let i = 0; i < S.secondaryCount; i++) {
      expect(Math.hypot(b.rx[i] - b.x, b.ry[i] - b.y)).toBeLessThanOrEqual(S.maxStretch * R + 1e-9);
    }
  });
});

describe('DropletSystem', () => {
  it('emits under aggressive motion only, stays bounded, and reabsorbs', () => {
    const b = spawn();
    const d = new DropletSystem();
    run(b, 2, 0, () => [0.5 + 0.004 * Math.sin(0), 0.5], d);
    expect(d.activeCount).toBe(0); // no emission when calm

    let peak = 0;
    let t = 2;
    for (let i = 0; i < 2 / DT; i++) {
      b.tx = 0.5 + 0.25 * Math.sin(t * 14);
      b.step(DT, S, t);
      d.emit(DT, 0, b, S);
      d.update(DT, [b, b], S);
      peak = Math.max(peak, d.activeCount);
      t += DT;
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(S.maxDroplets);

    b.tx = 0.5;
    run(b, S.dropletLifetime + 1.5, t, undefined, d);
    expect(d.activeCount).toBe(0);
  });
});

/** Simulates a single eased sweep of `dist` in `moveTime`, then a hold. */
function sweepReport(dist: number, moveTime: number) {
  const b = spawn(0.5, 0.5);
  const d = new DropletSystem();
  const hold = 0.3;
  const x0 = 0.5 - dist / 2;
  const x1 = 0.5 + dist / 2;
  const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const tx = (t: number) => (t < hold ? x0 : t > hold + moveTime ? x1 : x0 + (x1 - x0) * ease((t - hold) / moveTime));
  b.teleport(x0, 0.5);
  let maxLag = 0;
  let maxDef = 0;
  let emitted = 0;
  let prev = 0;
  let overshoot = 0;
  let settle = -1;
  let peakSpeed = 0;
  const tEnd = hold + moveTime;
  for (let t = 0; t < tEnd + 1.5; t += DT) {
    b.tx = tx(t);
    b.tvx = (tx(t + DT) - tx(t - DT)) / (2 * DT);
    b.step(DT, S, t);
    d.emit(DT, 0, b, S);
    d.update(DT, [b, b], S);
    if (d.activeCount > prev) emitted += d.activeCount - prev;
    prev = d.activeCount;
    peakSpeed = Math.max(peakSpeed, Math.abs(b.tvx));
    maxLag = Math.max(maxLag, Math.abs(b.tx - b.x));
    maxDef = Math.max(maxDef, b.deformationAmount(S));
    if (t > tEnd) {
      overshoot = Math.max(overshoot, b.x - x1);
      if (settle < 0 && Math.abs(b.x - x1) < 0.05 * R && b.speed < 0.02) settle = t - tEnd;
    }
  }
  return {
    fingerPeakSpeed: +peakSpeed.toFixed(2),
    maxLagRadii: +(maxLag / R).toFixed(2),
    overshootRadii: +(overshoot / R).toFixed(2),
    settleSeconds: +settle.toFixed(2),
    maxDeformationRadii: +maxDef.toFixed(2),
    dropletsEmitted: emitted,
  };
}

function shakeReport(amp: number, hz: number) {
  const b = spawn(0.5, 0.5);
  const d = new DropletSystem();
  let emitted = 0;
  let prev = 0;
  let maxDef = 0;
  for (let t = 0; t < 3; t += DT) {
    b.tx = 0.5 + amp * Math.sin(t * hz * Math.PI * 2);
    b.tvx = amp * hz * Math.PI * 2 * Math.cos(t * hz * Math.PI * 2);
    b.step(DT, S, t);
    d.emit(DT, 0, b, S);
    d.update(DT, [b, b], S);
    if (d.activeCount > prev) emitted += d.activeCount - prev;
    prev = d.activeCount;
    if (t > 0.5) maxDef = Math.max(maxDef, b.deformationAmount(S));
  }
  return { maxDeformationRadii: +maxDef.toFixed(2), dropletsIn3s: emitted };
}

describe('motion report', () => {
  it('gentle shake stays calm, aggressive shake sloshes and sheds', () => {
    const gentle = shakeReport(0.03, 3.5);
    const aggressive = shakeReport(0.11, 7);
    console.table({ gentle, aggressive });
    expect(gentle.dropletsIn3s).toBe(0);
    expect(aggressive.dropletsIn3s).toBeGreaterThan(0);
    expect(aggressive.maxDeformationRadii).toBeGreaterThan(gentle.maxDeformationRadii);
  });

  it('slow / medium / fast / violent sweeps behave progressively', () => {
    const slow = sweepReport(0.6, 1.6);
    const medium = sweepReport(0.8, 0.8);
    const fast = sweepReport(1.0, 0.5);
    const violent = sweepReport(1.1, 0.35);
    console.table({ slow, medium, fast, violent });
    // Slow: compact, close follow, no droplets.
    expect(slow.maxLagRadii).toBeLessThan(1.2);
    expect(slow.maxDeformationRadii).toBeLessThan(0.5);
    expect(slow.dropletsEmitted).toBe(0);
    // Progressively more lag/deformation.
    expect(medium.maxLagRadii).toBeGreaterThan(slow.maxLagRadii);
    expect(fast.maxLagRadii).toBeGreaterThan(medium.maxLagRadii);
    expect(violent.dropletsEmitted).toBeGreaterThan(0);
    expect(violent.maxLagRadii).toBeLessThanOrEqual(S.maxLag * 1.4 + 0.05);
  });
});
