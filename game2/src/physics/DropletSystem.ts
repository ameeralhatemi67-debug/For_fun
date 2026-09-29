import type { Settings } from '../config/schema';
import { clamp, makeRng, smoothstep } from '../utils/math';
import type { BlobBuffer } from './blobBuffer';
import type { FluidBody } from './FluidBody';
import { SINGLE_BLOB_SUPPORT } from './shape';

/** Hard cap regardless of settings; pool is preallocated. */
export const DROPLET_POOL = 32;
const ABSORB_TIME = 0.14;
const FADE_TIME = 0.4;

export interface Droplet {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual radius (u). */
  r: number;
  age: number;
  body: number;
  /** >0 while being absorbed into the body. */
  absorbT: number;
  /** >0 while fading out at end of life. */
  fadeT: number;
  seed: number;
}

/**
 * Detached droplets. They are thrown off in the direction of the inertial
 * pseudo-force (opposite the body's acceleration) or pinch off the tail tip,
 * drift in zero-g, then get gently pulled back and merge into their body.
 */
export class DropletSystem {
  readonly drops: Droplet[] = [];
  private accum = [0, 0];
  private cooldown = [0, 0];
  private rng = makeRng(1234);

  constructor() {
    for (let i = 0; i < DROPLET_POOL; i++) {
      this.drops.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, r: 0, age: 0, body: 0, absorbT: 0, fadeT: 0, seed: i });
    }
  }

  get activeCount(): number {
    let c = 0;
    for (const d of this.drops) if (d.active) c++;
    return c;
  }

  clear(): void {
    for (const d of this.drops) d.active = false;
    this.accum[0] = this.accum[1] = 0;
  }

  reparent(from: number, to: number): void {
    for (const d of this.drops) if (d.active && d.body === from) d.body = to;
  }

  /** Σ (r/R)² of droplets currently detached from a body — used for volume conservation. */
  detachedVolume(body: number, R: number): number {
    let v = 0;
    for (const d of this.drops) {
      if (!d.active || d.body !== body || d.absorbT > 0) continue;
      v += (d.r / R) ** 2;
    }
    return v;
  }

  spawn(body: number, x: number, y: number, vx: number, vy: number, r: number, maxCount: number): boolean {
    if (this.activeCount >= Math.min(maxCount, DROPLET_POOL)) return false;
    const d = this.drops.find((q) => !q.active);
    if (!d) return false;
    d.active = true;
    d.x = x;
    d.y = y;
    d.vx = vx;
    d.vy = vy;
    d.r = r;
    d.age = 0;
    d.body = body;
    d.absorbT = 0;
    d.fadeT = 0;
    d.seed = this.rng() * 100;
    return true;
  }

  /** Motion-driven emission for one body. */
  emit(dt: number, bodyIndex: number, body: FluidBody, s: Settings): void {
    this.cooldown[bodyIndex] = Math.max(0, this.cooldown[bodyIndex] - dt);
    if (!s.dropletsEnabled || body.presence < 0.85 || s.maxDroplets <= 0) {
      this.accum[bodyIndex] = 0;
      return;
    }
    // A free-flying ball is not being yanked by anything: speed alone sheds much less,
    // and there is no tether tension. Impacts still shed through the acceleration term.
    const tethered = body.control === 'ANCHORED' || body.control === 'RECAPTURING';
    const speedEx = Math.max(0, body.speed / s.dropletSpeedThreshold - 1) * (tethered ? 1 : 0.25);
    const accelEx = Math.max(0, body.accel / s.dropletAccelThreshold - 1);
    // Tether tension: the finger yanking relative to the mass pulls liquid out.
    const relX = tethered ? body.tvx - body.vx : 0;
    const relY = tethered ? body.tvy - body.vy : 0;
    const rel = Math.hypot(relX, relY);
    const tensionEx = Math.max(0, rel / (s.dropletSpeedThreshold * 1.1) - 1);
    const drive = speedEx * 0.6 + accelEx + tensionEx * 0.7;
    if (drive <= 0) {
      this.accum[bodyIndex] *= Math.exp(-dt * 1.2);
      return;
    }
    this.accum[bodyIndex] = Math.min(2, this.accum[bodyIndex] + s.dropletRate * drive * dt);
    const R = body.radius(s);
    while (this.accum[bodyIndex] >= 1 && this.cooldown[bodyIndex] <= 0) {
      this.accum[bodyIndex] -= 1;
      this.cooldown[bodyIndex] = 0.035;
      const rnd = this.rng;
      const size = R * (s.dropletMinSize + (s.dropletMaxSize - s.dropletMinSize) * Math.pow(rnd(), 1.6));
      const jitter = rnd() * 2 - 1;
      let x: number, y: number, vx: number, vy: number;
      const pick = rnd() * drive;
      if (pick < tensionEx * 0.7 && rel > 1e-3) {
        // Yank: a droplet is pulled out of the surface in the finger's relative direction.
        const ux = relX / rel;
        const uy = relY / rel;
        const px = -uy;
        const py = ux;
        x = body.x + ux * R * 0.9 + px * jitter * R * 0.4;
        y = body.y + uy * R * 0.9 + py * jitter * R * 0.4;
        vx = body.vx + relX * 0.35 + ux * s.dropletEjectSpeed * 0.5 + px * jitter * s.dropletEjectSpeed * 0.4;
        vy = body.vy + relY * 0.35 + uy * s.dropletEjectSpeed * 0.5 + py * jitter * s.dropletEjectSpeed * 0.4;
      } else if (pick < tensionEx * 0.7 + accelEx && body.accel > 1e-3) {
        // Fling: liquid keeps going where the body's acceleration is pulling away from.
        const ux = -body.ax / body.accel;
        const uy = -body.ay / body.accel;
        const px = -uy;
        const py = ux;
        x = body.x + ux * R * 0.85 + px * jitter * R * 0.45;
        y = body.y + uy * R * 0.85 + py * jitter * R * 0.45;
        const ej = s.dropletEjectSpeed * (0.6 + Math.min(accelEx, 3) * 0.4);
        vx = body.vx + ux * ej + px * jitter * s.dropletEjectSpeed * 0.5;
        vy = body.vy + uy * ej + py * jitter * s.dropletEjectSpeed * 0.5;
      } else {
        // Pinch off the tail tip.
        const tip = body.tailTip();
        const sp = body.speed || 1;
        const px = -body.vy / sp;
        const py = body.vx / sp;
        x = tip.x + px * jitter * R * 0.3;
        y = tip.y + py * jitter * R * 0.3;
        vx = tip.vx * 0.85 + px * jitter * s.dropletEjectSpeed * 0.6;
        vy = tip.vy * 0.85 + py * jitter * s.dropletEjectSpeed * 0.6;
      }
      if (!this.spawn(bodyIndex, x, y, vx, vy, size, s.maxDroplets)) {
        this.accum[bodyIndex] = 0;
        break;
      }
    }
  }

  update(dt: number, bodies: readonly FluidBody[], s: Settings): void {
    for (const d of this.drops) {
      if (!d.active) continue;
      const body = bodies[d.body];
      const R = body.radius(s);
      d.age += dt;

      if (d.absorbT > 0) {
        // Being swallowed: slide into the center and shrink; the metaball blend hides the seam.
        d.absorbT += dt;
        const k = 1 - Math.exp(-dt * 18);
        d.x += (body.x - d.x) * k;
        d.y += (body.y - d.y) * k;
        if (d.absorbT >= ABSORB_TIME) d.active = false;
        continue;
      }

      const damp = Math.exp(-s.dropletDrag * dt);
      d.vx *= damp;
      d.vy *= damp;

      const dx = body.x - d.x;
      const dy = body.y - d.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      if (body.presence > 0.3 && d.fadeT === 0) {
        const ramp = smoothstep(s.dropletFreeTime, s.dropletFreeTime + 0.45, d.age);
        if (ramp > 0) {
          const a = s.dropletAttraction * ramp * Math.min(dist, 4 * R);
          d.vx += (dx / dist) * a * dt;
          d.vy += (dy / dist) * a * dt;
          // Extra drag while returning so droplets don't orbit forever.
          const extra = Math.exp(-Math.sqrt(s.dropletAttraction) * 0.5 * ramp * dt);
          d.vx = body.vx + (d.vx - body.vx) * extra;
          d.vy = body.vy + (d.vy - body.vy) * extra;
        }
        if (d.age > s.dropletFreeTime * 0.5 && dist < s.dropletMergeRadius * R) {
          d.absorbT = 1e-6;
          body.absorbImpulse(d.x, d.y, (d.vx - body.vx) * 0.5, (d.vy - body.vy) * 0.5, s.secondaryCount);
        }
      }

      d.x += d.vx * dt;
      d.y += d.vy * dt;

      if (d.fadeT > 0) {
        d.fadeT += dt;
        if (d.fadeT >= FADE_TIME) d.active = false;
      } else if (d.age > s.dropletLifetime || body.presence < 0.05) {
        d.fadeT = 1e-6;
      }
    }
  }

  writeBlobs(out: BlobBuffer, bodies: readonly FluidBody[]): void {
    for (const d of this.drops) {
      if (!d.active) continue;
      let scale = 1;
      if (d.absorbT > 0) scale = 1 - smoothstep(0, ABSORB_TIME, d.absorbT) * 0.6;
      if (d.fadeT > 0) scale *= 1 - smoothstep(0, FADE_TIME, d.fadeT);
      // Pop-in: droplets grow over their first ~50 ms instead of appearing instantly.
      scale *= smoothstep(0, 0.05, d.age) * 0.6 + 0.4;
      // Torn liquid, not a particle sprite: irregular wobble, velocity-stretched,
      // with a thinner trailing sliver while it still flies fast.
      const wob = 1 + 0.07 * Math.sin(d.age * 16 + d.seed) + 0.05 * Math.sin(d.age * 27.3 + d.seed * 2.1);
      const b = bodies[d.body];
      const rvx = d.vx - b.vx * 0.3;
      const rvy = d.vy - b.vy * 0.3;
      const sp = Math.hypot(rvx, rvy);
      const stretch = 1 + clamp(sp * 0.45, 0, 1.8) + 0.12 * Math.sin(d.age * 11 + d.seed * 3.7) ** 2;
      const dirX = sp > 1e-4 ? rvx / sp : 1;
      const dirY = sp > 1e-4 ? rvy / sp : 0;
      // While being swallowed the droplet reads as part of the body (no droplet shading).
      const dropness = d.absorbT > 0 ? 0.3 : 1;
      const sup = d.r * SINGLE_BLOB_SUPPORT * scale * wob;
      out.push(d.x, d.y, sup, 1, dirX, dirY, stretch, d.body, dropness);
      if (sp > 0.35 && d.absorbT === 0) {
        const k = smoothstep(0.35, 1.2, sp);
        const back = sup * (0.55 + 0.35 * k);
        out.push(d.x - dirX * back, d.y - dirY * back, sup * 0.62, 0.75 * k, dirX, dirY, stretch * 1.2, d.body, dropness);
      }
    }
  }

  /** Remove all droplets belonging to a body (despawn). They fade instead of popping. */
  releaseBody(body: number): void {
    for (const d of this.drops) if (d.active && d.body === body && d.fadeT === 0) d.fadeT = 1e-6;
  }
}
