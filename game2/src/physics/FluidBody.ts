import type { Settings } from '../config/schema';
import { clamp, expAlpha, smoothstep, wobbleNoise } from '../utils/math';
import type { BlobBuffer } from './blobBuffer';
import {
  CENTER_SUPPORT,
  CENTER_WEIGHT,
  RING_DIST,
  RING_SUPPORT,
  TAIL_SUPPORT,
  ringWeight,
  shapeCalibration,
} from './shape';

export const MAX_RING = 12;
export const TAIL_NODES = TAIL_SUPPORT.length;
/** Fraction of the surface-spring force fed back into the core (shell/core mass ratio). */
const RING_REACTION = 0.3;
/** Cap on the recapture pull so a far-away ball glides in instead of rocketing. */
const RECAPTURE_MAX_PULL = 0.35;
/** Scratch: rendered surface-point positions (writeBlobs is not re-entrant). */
const RX = new Float64Array(MAX_RING);
const RY = new Float64Array(MAX_RING);
/** Rendered surface displacement saturates toward this many radii. */
const DISPLAY_SATURATION = 1.6;

/**
 * How the body's center is driven (separate from the Blue/Red fusion state):
 *   ANCHORED     spring to the finger anchor (+ lag tether)
 *   FREE         no tether; drifts on its own momentum, collides with palms
 *   SHOT         like FREE, entered by firing
 *   RECAPTURING  strong magnetic spring back to the anchor, no tether clamp (no teleport)
 */
export type BodyControl = 'ANCHORED' | 'FREE' | 'SHOT' | 'RECAPTURING';

export const isFreeControl = (c: BodyControl) => c === 'FREE' || c === 'SHOT';

/**
 * One zero-gravity liquid mass.
 *
 *   target ──spring──▶ center (inertia) ──springs──▶ surface ring points (jelly)
 *                                     └──chain──▶ tail nodes (viscous trail)
 *
 * The anchor is only ever a *target*. The center has its own momentum;
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

  control: BodyControl = 'ANCHORED';
  /** False when the body does not exist at all (never spawned, faded out, despawned). */
  alive = false;
  /** True while condensing into existence (presence grows over spawnGrowDuration). */
  spawning = false;

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

  /** Internal-flow origin: follows the center with inertia (shader pattern lags/sloshes). */
  flowX = 0;
  flowY = 0;
  private flowVx = 0;
  private flowVy = 0;

  /** 0..1 visibility; shrinks the mass (evaporates) rather than just fading. */
  presence = 0;
  presenceTarget = 0;
  /** Size multiplier (purple is bigger than blue/red). */
  sizeScale = 1;
  /** Smoothed depth scale from the controlling hand (closer = bigger). */
  depthScale = 1;
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

  private phaseSeed: number;
  private time = 0;
  private stepsSinceReset = 0;

  constructor(seed = 1) {
    this.phaseSeed = seed;
  }

  /** Physical radius in world units (before presence). Rendering, collisions and fusion all use this. */
  radius(s: Settings): number {
    return s.baseRadius * this.sizeScale * this.depthScale * Math.sqrt(this.volumeScale);
  }

  /** Radius as currently rendered (presence shrinks the whole mass). */
  visibleRadius(s: Settings): number {
    return this.radius(s) * smoothstep(0, 1, this.presence);
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
    this.flowVx = this.flowVy = 0;
    this.meanDispX = this.meanDispY = 0;
    this.stepsSinceReset = 0;
  }

  /** Rigidly move the whole body (core, surface, tail) — used for collision depenetration. */
  translate(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    for (let i = 0; i < MAX_RING; i++) {
      this.rx[i] += dx;
      this.ry[i] += dy;
    }
    for (let j = 0; j < TAIL_NODES; j++) {
      this.tlx[j] += dx;
      this.tly[j] += dy;
    }
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

  /**
   * Impact squash from a hit whose outward normal (away from the obstacle) is n:
   * the facing side is pushed flat, the sides bulge, the internal flow swirls.
   */
  impactImpulse(nx: number, ny: number, speed: number, n: number): void {
    for (let i = 0; i < n; i++) {
      let dx = this.rx[i] - this.x;
      let dy = this.ry[i] - this.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const facing = -(dx * nx + dy * ny); // 1 = points at the obstacle
      if (facing > 0) {
        const k = speed * 0.9 * facing * facing;
        this.rvx[i] += nx * k;
        this.rvy[i] += ny * k;
      }
      const side = 1 - facing * facing;
      this.rvx[i] += dx * speed * 0.35 * side;
      this.rvy[i] += dy * speed * 0.35 * side;
    }
    this.flowVx -= ny * speed * 0.8;
    this.flowVy += nx * speed * 0.8;
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

  /** Silhouette aspect ratio proxy: max/min rendered surface-point distance from the center. */
  aspectAmount(s: Settings): number {
    const n = s.secondaryCount;
    let mx = 0;
    let mn = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(this.rx[i] - this.x, this.ry[i] - this.y);
      mx = Math.max(mx, d);
      mn = Math.min(mn, d);
    }
    return mn > 1e-9 ? mx / mn : 1;
  }

  /**
   * How far the rendered liquid reaches from the center along unit direction u
   * (world units, includes presence). Used for surface-gap fusion contact.
   */
  surfaceExtent(ux: number, uy: number, s: Settings): number {
    const pres = smoothstep(0, 1, this.presence);
    if (pres <= 0.002) return 0;
    const R = this.radius(s) * pres;
    const n = s.secondaryCount;
    const rest = RING_DIST * shapeCalibration(n) * R * this.compression;
    const margin = R - rest; // silhouette extends this far beyond a resting ring point
    const def = s.deformation;
    const rot = this.time * 0.12 * s.idleWobbleSpeed + this.phaseSeed;
    let m = R * 0.9;
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2;
      const rX = Math.cos(ang) * rest;
      const rY = Math.sin(ang) * rest;
      const ox = rX + (this.rx[i] - this.x - rX / pres) * def * pres;
      const oy = rY + (this.ry[i] - this.y - rY / pres) * def * pres;
      m = Math.max(m, ox * ux + oy * uy + margin);
    }
    return m;
  }

  /** Fixed-timestep integration (semi-implicit Euler). */
  step(dt: number, s: Settings, time: number): void {
    this.time = time;
    const R = this.radius(s);
    const n = s.secondaryCount;
    const calib = shapeCalibration(n);
    const wobSpeed = s.idleWobbleSpeed;
    const ctl = this.control;
    const anchored = ctl === 'ANCHORED';
    const recap = ctl === 'RECAPTURING';
    const tethered = anchored || recap;

    const pvx = this.vx;
    const pvy = this.vy;
    const invM = 1 / s.mass;
    const react = RING_REACTION * (30 + 570 * s.surfaceTension * s.surfaceTension);
    const maxLag = s.maxLag * R;

    if (anchored) {
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
      if (dist > maxLag) {
        // Tether goes taut: strongly stiffening instead of a hard clamp (keeps momentum feel).
        const extra = (k * 8 * (dist - maxLag)) / dist;
        fx += extra * ex;
        fy += extra * ey;
      }
      // Damping is split: `trailingDrag` of it resists world velocity (the mass trails a
      // steadily moving finger), the rest resists velocity relative to the finger.
      const drag = s.trailingDrag;
      const dvx = this.vx - (1 - drag) * this.tvx;
      const dvy = this.vy - (1 - drag) * this.tvy;
      // Reaction from the surface springs (previous step): sloshing liquid tugs the core,
      // so the whole mass moves as one body instead of a core with a detached shell.
      this.vx += ((fx - s.damping * dvx) * invM + this.extAx + react * this.meanDispX) * dt;
      this.vy += ((fy - s.damping * dvy) * invM + this.extAy + react * this.meanDispY) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      // Past the soft zone the tether is inextensible: project and drop the separating velocity.
      const hardLag = maxLag * 1.4;
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
    } else if (recap) {
      // Magnetic recapture: strong spring with a capped pull, no tether clamp → never teleports.
      let ex = this.tx - this.x;
      let ey = this.ty - this.y;
      const d = Math.hypot(ex, ey);
      if (d > RECAPTURE_MAX_PULL) {
        ex *= RECAPTURE_MAX_PULL / d;
        ey *= RECAPTURE_MAX_PULL / d;
      }
      const k = s.recaptureStrength * this.stiffnessBoost;
      const dvx = this.vx - this.tvx;
      const dvy = this.vy - this.tvy;
      this.vx += ((k * ex - s.recaptureDamping * dvx) * invM + this.extAx + react * this.meanDispX) * dt;
      this.vy += ((k * ey - s.recaptureDamping * dvy) * invM + this.extAy + react * this.meanDispY) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    } else {
      // FREE / SHOT: zero-g drift with a little air drag. No hidden tether.
      const drag = Math.exp(-s.freeDrag * dt);
      this.vx = this.vx * drag + (this.extAx + react * this.meanDispX) * dt;
      this.vy = this.vy * drag + (this.extAy + react * this.meanDispY) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
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

    // Internal flow origin: a softer spring behind the center (sloshes after stops/impacts).
    const kF = 60;
    this.flowVx += (kF * (this.x - this.flowX) - 2 * 0.55 * Math.sqrt(kF) * (this.flowVx - this.vx)) * dt;
    this.flowVy += (kF * (this.y - this.flowY) - 2 * 0.55 * Math.sqrt(kF) * (this.flowVy - this.vy)) * dt;
    this.flowX += this.flowVx * dt;
    this.flowY += this.flowVy * dt;

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
    // Attachment tension: the liquid leans toward the (offset) anchor it is being pulled to.
    let tex = 0;
    let tey = 0;
    let teL = 0;
    if (tethered && s.tetherDeformInfluence > 0) {
      tex = this.tx - this.x;
      tey = this.ty - this.y;
      teL = Math.hypot(tex, tey);
      const cap = Math.min(maxLag, 2.5 * R);
      if (teL > cap) {
        tex *= cap / teL;
        tey *= cap / teL;
        teL = cap;
      }
    }
    const teGain = kS * s.tetherDeformInfluence * 0.4;
    const teUx = teL > 1e-9 ? tex / teL : 0;
    const teUy = teL > 1e-9 ? tey / teL : 0;
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
    const adh = tethered ? s.fingerAdhesion : 0;
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
      // Adhesion: the anchor stirs the surface directly, so fast shakes (above the
      // core's resonance) still slosh the mass.
      if (adh > 0) {
        ax += adh * (this.tvx - this.rvx[i]);
        ay += adh * (this.tvy - this.rvy[i]);
      }
      if (teL > 0) {
        const facing = Math.max(0, ca * teUx + sa * teUy);
        const g = teGain * (0.25 + 0.75 * facing * facing);
        ax += g * tex;
        ay += g * tey;
      }
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

  /** Emit metaballs for the renderer. `mix` is the palette position (0 = A, 1 = B). */
  writeBlobs(out: BlobBuffer, s: Settings, mix: number): void {
    const pres = smoothstep(0, 1, this.presence);
    if (pres <= 0.002) return;
    const R = this.radius(s) * pres;
    const n = s.secondaryCount;
    const calib = shapeCalibration(n);
    const unit = calib * R;
    const def = s.deformation;

    // Core blob: area-preserving stretch along velocity + attachment tension.
    const Rw = this.radius(s);
    let axX = this.svx * s.velocityInfluence;
    let axY = this.svy * s.velocityInfluence;
    if (this.control === 'ANCHORED' || this.control === 'RECAPTURING') {
      const k = (s.tetherDeformInfluence * 0.3) / Rw;
      axX += (this.tx - this.x) * k;
      axY += (this.ty - this.y) * k;
    }
    const am = Math.hypot(axX, axY);
    const stretch = 1 + clamp(((am / (1 + 0.35 * am)) * def), 0, s.maxStretch - 1);
    const dirX = am > 1e-6 ? axX / am : 1;
    const dirY = am > 1e-6 ? axY / am : 0;

    // Surface points: draw rest pose + deformation·(actual − rest), all scaled by
    // presence so a fading/appearing mass shrinks as a whole (no separated petals).
    const rest = RING_DIST * (unit / pres) * this.compression;
    const rot = this.time * 0.12 * s.idleWobbleSpeed + this.phaseSeed;
    const w = ringWeight(n);
    let mx = 0;
    let my = 0;
    // Amplified displacement saturates (≈linear in the midrange, capped for violent
    // motion) so far-flung surface points never detach into separate petals.
    const sat = DISPLAY_SATURATION * Rw;
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2;
      const restX = Math.cos(ang) * rest;
      const restY = Math.sin(ang) * rest;
      let ddx = (this.rx[i] - this.x - restX) * def;
      let ddy = (this.ry[i] - this.y - restY) * def;
      const dl = Math.hypot(ddx, ddy);
      if (dl > 1e-9) {
        const k = (sat * Math.tanh(dl / sat)) / dl;
        ddx *= k;
        ddy *= k;
      }
      const px = this.x + (restX + ddx) * pres;
      const py = this.y + (restY + ddy) * pres;
      RX[i] = px;
      RY[i] = py;
      mx += px;
      my += py;
    }
    // The drawn core follows the sloshing shell part of the way, so the liquid's
    // interior stays filled when the surface slides (no donut hole on hard stops).
    const cx = this.x + (mx / n - this.x) * 0.2;
    const cy = this.y + (my / n - this.y) * 0.2;
    out.push(cx, cy, CENTER_SUPPORT * unit, CENTER_WEIGHT, dirX, dirY, stretch, mix);
    const restR = rest * pres;
    for (let i = 0; i < n; i++) out.push(RX[i], RY[i], RING_SUPPORT * unit, w, 1, 0, 1, mix);
    // Filler between the core and far-out surface points keeps the stretched liquid solid.
    for (let i = 0; i < n; i++) {
      const dx = RX[i] - cx;
      const dy = RY[i] - cy;
      const L = Math.hypot(dx, dy);
      const f = smoothstep(1.15 * restR, 1.9 * restR, L);
      if (f > 0.01) out.push(cx + dx * 0.5, cy + dy * 0.5, RING_SUPPORT * unit, w * 0.9 * f, 1, 0, 1, mix);
    }

    // Tail nodes fade in only once they actually trail behind. A half-weight blob
    // at each segment midpoint keeps the tail a continuous tapering tube.
    if (s.tailLength > 0) {
      // The tail has its own length control; the surface amplification does not stretch it.
      const tdef = Math.min(def, 1);
      let lx = this.x;
      let ly = this.y;
      let lw = 0;
      let ls = CENTER_SUPPORT * unit;
      for (let j = 0; j < TAIL_NODES; j++) {
        const px = this.x + (this.tlx[j] - this.x) * tdef * pres;
        const py = this.y + (this.tly[j] - this.y) * tdef * pres;
        const d = Math.hypot(px - this.x, py - this.y);
        // Only visible once clearly outside the core, so a compact body keeps its size.
        const wt = smoothstep(0.45 * Rw, 1.25 * Rw, d) * 0.8;
        const sup = TAIL_SUPPORT[j] * unit;
        const mw = (j === 0 ? wt : Math.min(wt, lw)) * 0.55;
        out.push((px + lx) / 2, (py + ly) / 2, (sup + ls) * 0.42, mw, 1, 0, 1, mix);
        out.push(px, py, sup, wt, 1, 0, 1, mix);
        lx = px;
        ly = py;
        lw = wt;
        ls = sup;
      }
    }
  }
}
