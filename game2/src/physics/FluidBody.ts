import type { Settings } from '../config/schema';
import { clamp, expAlpha, smoothstep, wobbleNoise } from '../utils/math';
import type { BlobBuffer } from './blobBuffer';
import { CENTER_SUPPORT, RING_DIST, RING_SUPPORT, TAIL_SUPPORT, ringWeight, shapeCalibration } from './shape';

export const MAX_RING = 12;
export const TAIL_NODES = TAIL_SUPPORT.length;
/** Fraction of the surface-spring force fed back into the core (shell/core mass ratio). */
const RING_REACTION = 0.3;

/**
 * One zero-gravity liquid mass.
 *
 *   target ──spring──▶ center (inertia) ──springs──▶ surface ring points (jelly)
 *                                     └──chain──▶ tail nodes (viscous trail)
 *
 * The fingertip is only ever a *target*. The center has its own momentum;
 * the ring points are separate particles tethered to rest offsets around
 * the center, so they naturally lag opposite to acceleration, overshoot on
 * stops and wobble while settling. Nothing here knows about cameras.
 */
export class FluidBody {
  // Center state
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Smoothed measured acceleration of the center (u/s²). */
  ax = 0;
  ay = 0;
  /** Smoothed velocity for the stretch axis. */
  svx = 0;
  svy = 0;

  // Target (and its velocity, for relative damping)
  tx = 0;
  ty = 0;
  tvx = 0;
  tvy = 0;

  // Surface ring particles
  readonly rx = new Float64Array(MAX_RING);
  readonly ry = new Float64Array(MAX_RING);
  readonly rvx = new Float64Array(MAX_RING);
  readonly rvy = new Float64Array(MAX_RING);
  private gx = new Float64Array(MAX_RING);
  private gy = new Float64Array(MAX_RING);
  private dispX = new Float64Array(MAX_RING);
  private dispY = new Float64Array(MAX_RING);
  private meanDispX = 0;
  private meanDispY = 0;
  // Tail chain particles
  readonly tlx = new Float64Array(TAIL_NODES);
  readonly tly = new Float64Array(TAIL_NODES);
  readonly tlvx = new Float64Array(TAIL_NODES);
  readonly tlvy = new Float64Array(TAIL_NODES);

  /** 0..1 visibility; shrinks the mass (evaporates) rather than just fading. */
  presence = 0;
  presenceTarget = 0;
  /** Size multiplier (purple is bigger than blue/red). */
  sizeScale = 1;
  /** Volume factor from droplets that left the body (≤1). */
  volumeScale = 1;
  /** Ring rest-radius multiplier; <1 compresses (fusion). */
  compression = 1;
  /** Extra acceleration on the center for this step (attraction). Cleared by the owner. */
  extAx = 0;
  extAy = 0;
  /** Stiffness multiplier on the target spring (fusion compression). */
  stiffnessBoost = 1;
  /** Facing surface points stretch along this unit direction. */
  reachX = 0;
  reachY = 0;
  reachGain = 0;
  /** High-frequency energetic tremble (0..1) used while charging a fusion. */
  tremble = 0;
  /** Render-only: bright core flash 0..1, decays in the controller. */
  flash = 0;

  private phaseSeed: number;
  private time = 0;
  private stepsSinceReset = 0;

  constructor(seed = 1) {
    this.phaseSeed = seed;
  }

  /** Physical radius in world units (before presence). */
  radius(s: Settings): number {
    return s.baseRadius * this.sizeScale * Math.sqrt(this.volumeScale);
  }

  /** Place everything at a point with no motion (used when (re)spawning while invisible). */
  teleport(x: number, y: number): void {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.tvx = this.tvy = 0;
    this.vx = this.vy = this.ax = this.ay = this.svx = this.svy = 0;
    this.rx.fill(x);
    this.ry.fill(y);
    this.rvx.fill(0);
    this.rvy.fill(0);
    this.tlx.fill(x);
    this.tly.fill(y);
    this.tlvx.fill(0);
    this.tlvy.fill(0);
    this.meanDispX = this.meanDispY = 0;
    this.stepsSinceReset = 0;
  }

  /** Adds velocity to every surface point, radially outward (fusion pop / absorb splash). */
  radialImpulse(speed: number): void {
    for (let i = 0; i < MAX_RING; i++) {
      const dx = this.rx[i] - this.x;
      const dy = this.ry[i] - this.y;
      const d = Math.hypot(dx, dy) || 1;
      this.rvx[i] += (dx / d) * speed;
      this.rvy[i] += (dy / d) * speed;
    }
  }

  /** A droplet merging in pushes the nearest surface point (tiny splash). */
  absorbImpulse(px: number, py: number, ivx: number, ivy: number, n: number): void {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (this.rx[i] - px) ** 2 + (this.ry[i] - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.rvx[best] += ivx;
    this.rvy[best] += ivy;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }
  get accel(): number {
    return Math.hypot(this.ax, this.ay);
  }

  /** Current tail tip (last tail node). */
  tailTip(): { x: number; y: number; vx: number; vy: number } {
    const k = TAIL_NODES - 1;
    return { x: this.tlx[k], y: this.tly[k], vx: this.tlvx[k], vy: this.tlvy[k] };
  }

  /** Largest surface-point displacement from its rest pose, in radii (0 = perfectly round). */
  deformationAmount(s: Settings): number {
    const R = this.radius(s);
    const n = s.secondaryCount;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(this.rx[i] - this.x, this.ry[i] - this.y);
      m = Math.max(m, d);
    }
    const rest = RING_DIST * shapeCalibration(n) * R;
    return Math.max(0, m - rest) / R;
  }

  /** Fixed-timestep integration (semi-implicit Euler). */
  step(dt: number, s: Settings, time: number): void {
    this.time = time;
    const R = this.radius(s);
    const n = s.secondaryCount;
    const calib = shapeCalibration(n);
    const wobSpeed = s.idleWobbleSpeed;

    // ── Center: damped spring toward the (slightly drifting) target ──────
    const drift = s.idleWobble * 0.1 * R;
    const gx = this.tx + drift * wobbleNoise(time * wobSpeed * 0.7, this.phaseSeed + 11);
    const gy = this.ty + drift * wobbleNoise(time * wobSpeed * 0.63, this.phaseSeed + 23);
    const ex = gx - this.x;
    const ey = gy - this.y;
    const k = s.stiffness * this.stiffnessBoost;
    let fx = k * ex;
    let fy = k * ey;
    const dist = Math.hypot(ex, ey);
    const maxLag = s.maxLag * R;
    if (dist > maxLag) {
      // Tether goes taut: strongly stiffening instead of a hard clamp (keeps momentum feel).
      const extra = (k * 8 * (dist - maxLag)) / dist;
      fx += extra * ex;
      fy += extra * ey;
    }
    const pvx = this.vx;
    const pvy = this.vy;
    const invM = 1 / s.mass;
    const hardLag = maxLag * 1.4;
    // Damping is split: `trailingDrag` of it resists world velocity (the mass trails a
    // steadily moving finger), the rest resists velocity relative to the finger.
    const drag = s.trailingDrag;
    const dvx = this.vx - (1 - drag) * this.tvx;
    const dvy = this.vy - (1 - drag) * this.tvy;
    // Reaction from the surface springs (previous step): sloshing liquid tugs the core,
    // so the whole mass moves as one body instead of a core with a detached shell.
    const react = RING_REACTION * (30 + 570 * s.surfaceTension * s.surfaceTension);
    this.vx += ((fx - s.damping * dvx) * invM + this.extAx + react * this.meanDispX) * dt;
    this.vy += ((fy - s.damping * dvy) * invM + this.extAy + react * this.meanDispY) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // Past the soft zone the tether is inextensible: project and drop the separating velocity.
    const hx = this.x - this.tx;
    const hy = this.y - this.ty;
    const hd = Math.hypot(hx, hy);
    if (hd > hardLag) {
      const ux = hx / hd;
      const uy = hy / hd;
      this.x = this.tx + ux * hardLag;
      this.y = this.ty + uy * hardLag;
      const sep = (this.vx - this.tvx) * ux + (this.vy - this.tvy) * uy;
      if (sep > 0) {
        this.vx -= sep * ux;
        this.vy -= sep * uy;
      }
    }

    // Measured acceleration (what the liquid "feels"), smoothed a little.
    if (this.stepsSinceReset > 0) {
      const aA = expAlpha(dt, 0.03);
      this.ax += ((this.vx - pvx) / dt - this.ax) * aA;
      this.ay += ((this.vy - pvy) / dt - this.ay) * aA;
    }
    const aV = expAlpha(dt, 0.05);
    this.svx += (this.vx - this.svx) * aV;
    this.svy += (this.vy - this.svy) * aV;
    this.stepsSinceReset++;

    // ── Surface ring: jelly particles around the center ─────────────────
    const st = s.surfaceTension;
    const kS = 30 + 570 * st * st; // ring spring stiffness
    const omega = Math.sqrt(kS);
    const cS = 2 * s.settleStrength * omega; // relative damping → damping ratio = settleStrength
    const ringDist = RING_DIST * calib * R * this.compression;
    const rot = time * 0.12 * wobSpeed + this.phaseSeed;
    const wobAmp = s.idleWobble * 0.22;
    const pseudoX = -s.accelInfluence * this.ax;
    const pseudoY = -s.accelInfluence * this.ay;
    const maxD = s.maxStretch * R;
    const trem = this.tremble * kS * R * 0.06;
    // Rest goals + current displacement from them.
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2;
      const wob = 1 + wobAmp * wobbleNoise(time * wobSpeed * 1.3, this.phaseSeed * 7 + i + 1);
      this.gx[i] = this.x + Math.cos(ang) * ringDist * wob;
      this.gy[i] = this.y + Math.sin(ang) * ringDist * wob;
      this.dispX[i] = this.rx[i] - this.gx[i];
      this.dispY[i] = this.ry[i] - this.gy[i];
    }
    // Mean displacement = shell sliding off the core. Beyond a soft limit it stiffens
    // sharply so the mass stays one connected drop (no dumbbell split).
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += this.dispX[i];
      my += this.dispY[i];
    }
    mx /= n;
    my /= n;
    this.meanDispX = mx;
    this.meanDispY = my;
    const mLen = Math.hypot(mx, my);
    const mLim = 0.45 * R;
    const mK = mLen > mLim ? (kS * 4 * (mLen - mLim)) / mLen : 0;
    // Neighbour coupling = surface tension proper: it resists local curvature, so
    // lumps flatten quickly while the smooth squash/stretch modes stay soft.
    const kN = kS * 1.2;
    const adh = s.fingerAdhesion;
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ip = (i + n - 1) % n;
      const inx = (i + 1) % n;
      const lapX = (this.dispX[ip] + this.dispX[inx]) * 0.5 - this.dispX[i];
      const lapY = (this.dispY[ip] + this.dispY[inx]) * 0.5 - this.dispY[i];
      let ax = -kS * this.dispX[i] + kN * lapX - mK * mx - cS * (this.rvx[i] - this.vx) + pseudoX;
      let ay = -kS * this.dispY[i] + kN * lapY - mK * my - cS * (this.rvy[i] - this.vy) + pseudoY;
      // Adhesion: the fingertip is wetted by the liquid and stirs the surface directly,
      // so fast shakes (above the core's resonance) still slosh the mass.
      ax += adh * (this.tvx - this.rvx[i]);
      ay += adh * (this.tvy - this.rvy[i]);
      if (this.reachGain > 0) {
        const facing = Math.max(0, ca * this.reachX + sa * this.reachY);
        const g = this.reachGain * facing * facing;
        ax += g * this.reachX;
        ay += g * this.reachY;
      }
      if (trem > 0) {
        ax += trem * wobbleNoise(time * 31 + i * 3.1, this.phaseSeed + i);
        ay += trem * wobbleNoise(time * 29 + i * 5.7, this.phaseSeed + i + 50);
      }
      this.rvx[i] += ax * dt;
      this.rvy[i] += ay * dt;
      this.rx[i] += this.rvx[i] * dt;
      this.ry[i] += this.rvy[i] * dt;
      // Guard against excessive goo: project back inside maxStretch, kill outward velocity.
      const dx = this.rx[i] - this.x;
      const dy = this.ry[i] - this.y;
      const d = Math.hypot(dx, dy);
      if (d > maxD) {
        const ux = dx / d;
        const uy = dy / d;
        this.rx[i] = this.x + ux * maxD;
        this.ry[i] = this.y + uy * maxD;
        const rel = (this.rvx[i] - this.vx) * ux + (this.rvy[i] - this.vy) * uy;
        if (rel > 0) {
          this.rvx[i] -= rel * ux;
          this.rvy[i] -= rel * uy;
        }
      }
    }

    // ── Tail chain: viscous trail that lags with speed and snaps back ───
    const tl = s.tailLength;
    const kT = 420;
    const cRel = 2 * 0.9 * Math.sqrt(kT);
    const tailDrag = kT * 0.016 * tl;
    for (let j = 0; j < TAIL_NODES; j++) {
      // Keep consecutive nodes close enough that their metaballs always connect (a tube, not beads).
      const maxSeg = Math.min(maxD * 0.5, TAIL_SUPPORT[j] * calib * R * 0.95);
      const px = j === 0 ? this.x : this.tlx[j - 1];
      const py = j === 0 ? this.y : this.tly[j - 1];
      const pvxJ = j === 0 ? this.vx : this.tlvx[j - 1];
      const pvyJ = j === 0 ? this.vy : this.tlvy[j - 1];
      const ax = kT * (px - this.tlx[j]) - cRel * (this.tlvx[j] - pvxJ) - tailDrag * this.tlvx[j];
      const ay = kT * (py - this.tly[j]) - cRel * (this.tlvy[j] - pvyJ) - tailDrag * this.tlvy[j];
      this.tlvx[j] += ax * dt;
      this.tlvy[j] += ay * dt;
      this.tlx[j] += this.tlvx[j] * dt;
      this.tly[j] += this.tlvy[j] * dt;
      const dx = this.tlx[j] - px;
      const dy = this.tly[j] - py;
      const d = Math.hypot(dx, dy);
      if (d > maxSeg) {
        this.tlx[j] = px + (dx / d) * maxSeg;
        this.tly[j] = py + (dy / d) * maxSeg;
      }
    }
  }

  /** Emit metaballs for the renderer. */
  writeBlobs(out: BlobBuffer, s: Settings, bodyIndex: number): void {
    const pres = smoothstep(0, 1, this.presence);
    if (pres <= 0.002) return;
    const R = this.radius(s) * pres;
    const n = s.secondaryCount;
    const calib = shapeCalibration(n);
    const unit = calib * R;
    const def = s.deformation;

    // Core blob, elongated along its (smoothed) velocity.
    const sp = Math.hypot(this.svx, this.svy);
    const stretch = 1 + clamp(s.velocityInfluence * sp * def, 0, s.maxStretch - 1);
    const dirX = sp > 1e-4 ? this.svx / sp : 1;
    const dirY = sp > 1e-4 ? this.svy / sp : 0;
    out.push(this.x, this.y, CENTER_SUPPORT * unit, 1, dirX, dirY, stretch, bodyIndex);

    // Surface points: draw rest pose + deformation·(actual − rest), all scaled by
    // presence so a fading/appearing mass shrinks as a whole (no separated petals).
    const rest = RING_DIST * (unit / pres) * this.compression;
    const rot = this.time * 0.12 * s.idleWobbleSpeed + this.phaseSeed;
    const w = ringWeight(n);
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2;
      const restX = Math.cos(ang) * rest;
      const restY = Math.sin(ang) * rest;
      const px = this.x + (restX + (this.rx[i] - this.x - restX) * def) * pres;
      const py = this.y + (restY + (this.ry[i] - this.y - restY) * def) * pres;
      out.push(px, py, RING_SUPPORT * unit, w, 1, 0, 1, bodyIndex);
    }

    // Tail nodes fade in only once they actually trail behind. A half-weight blob
    // at each segment midpoint keeps the tail a continuous tapering tube.
    if (s.tailLength > 0) {
      const R0 = this.radius(s);
      let lx = this.x;
      let ly = this.y;
      let lw = 0;
      let ls = CENTER_SUPPORT * unit;
      for (let j = 0; j < TAIL_NODES; j++) {
        const px = this.x + (this.tlx[j] - this.x) * def * pres;
        const py = this.y + (this.tly[j] - this.y) * def * pres;
        const d = Math.hypot(px - this.x, py - this.y);
        // Only visible once clearly outside the core, so a compact body keeps its size.
        const wt = smoothstep(0.45 * R0, 1.25 * R0, d) * 0.8;
        const sup = TAIL_SUPPORT[j] * unit;
        const mw = (j === 0 ? wt : Math.min(wt, lw)) * 0.55;
        out.push((px + lx) / 2, (py + ly) / 2, (sup + ls) * 0.42, mw, 1, 0, 1, bodyIndex);
        out.push(px, py, sup, wt, 1, 0, 1, bodyIndex);
        lx = px;
        ly = py;
        lw = wt;
        ls = sup;
      }
    }
  }
}
