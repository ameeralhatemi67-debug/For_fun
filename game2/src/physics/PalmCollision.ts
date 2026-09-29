import type { Settings } from '../config/schema';
import { polygonSignedDistance } from '../tracking/handModel';
import type { PalmSample } from '../tracking/HandPipeline';
import type { FluidBody } from './FluidBody';
import { RING_DIST, shapeCalibration } from './shape';

const sd = { d: 0, nx: 0, ny: 0 };

export interface PalmContact {
  /** True if the body overlaps the (padded) palm collider this step. */
  touching: boolean;
  /** Approach speed that was reflected (u/s), 0 for resting contact. */
  impact: number;
  nx: number;
  ny: number;
}

/**
 * Soft water-ball vs moving palm (convex polygon + padding):
 *   1. depenetrate (fully when shallow; gradually when the palm opened on top of the ball),
 *   2. reflect the approach velocity relative to the palm (restitution × impulse strength),
 *      add the palm's velocity (× influence), remove some tangential slip (friction),
 *   3. squash the surface on the impact side and flatten ring points against the palm.
 */
export function collideBodyWithPalm(b: FluidBody, palm: PalmSample, s: Settings, out: PalmContact): PalmContact {
  out.touching = false;
  out.impact = 0;
  if (palm.n < 3) return out;
  const R = b.radius(s);
  polygonSignedDistance(palm.poly, palm.n, b.x, b.y, sd);
  const reach = R * (1 + s.palmColliderPadding);
  const pen = reach - sd.d;
  if (pen <= 0) return out;
  const nx = sd.nx;
  const ny = sd.ny;
  out.touching = true;
  out.nx = nx;
  out.ny = ny;

  // Shallow: resolve at once. Deep (a palm opened right on top of the ball): slide
  // out over a few substeps instead of popping.
  const corr = pen < R ? pen : R * 0.06;
  b.translate(nx * corr, ny * corr);

  const pvx = palm.vx * s.palmVelocityInfluence;
  const pvy = palm.vy * s.palmVelocityInfluence;
  // A palm moving into the ball steers the bounce toward its own motion (a push goes
  // where the hand pushes, not only along the contact normal of a small, knobbly hull).
  let jx = nx;
  let jy = ny;
  const pl = Math.hypot(pvx, pvy);
  if (s.palmSteer > 0 && pl > 0.05) {
    const toward = (pvx * nx + pvy * ny) / pl;
    if (toward > 0.2) {
      const k = s.palmSteer * toward;
      jx = nx + (pvx / pl) * k;
      jy = ny + (pvy / pl) * k;
      const jl = Math.hypot(jx, jy);
      jx /= jl;
      jy /= jl;
    }
  }
  const rvx = b.vx - pvx;
  const rvy = b.vy - pvy;
  const vn = rvx * jx + rvy * jy;
  if (vn < 0) {
    const jn = -(1 + s.palmRestitution) * vn * s.palmImpulseStrength;
    const tx = rvx - vn * jx;
    const ty = rvy - vn * jy;
    b.vx += jx * jn - tx * s.palmFriction;
    b.vy += jy * jn - ty * s.palmFriction;
    out.impact = -vn;
    b.impactImpulse(nx, ny, -vn, s.secondaryCount);
  }
  // Never keep sinking into the palm (e.g. impulse strength < 1 or a pushing palm).
  const vn2 = (b.vx - pvx) * nx + (b.vy - pvy) * ny;
  if (vn2 < 0) {
    b.vx -= vn2 * nx;
    b.vy -= vn2 * ny;
  }

  // Flatten the contact side: surface points may not enter the padded palm.
  const n = s.secondaryCount;
  const ringRest = RING_DIST * shapeCalibration(n) * R;
  const minD = R * s.palmColliderPadding + (R - ringRest) * 0.8;
  for (let i = 0; i < n; i++) {
    polygonSignedDistance(palm.poly, palm.n, b.rx[i], b.ry[i], sd);
    if (sd.d >= minD) continue;
    const push = minD - sd.d;
    b.rx[i] += sd.nx * push;
    b.ry[i] += sd.ny * push;
    const rn = (b.rvx[i] - pvx) * sd.nx + (b.rvy[i] - pvy) * sd.ny;
    if (rn < 0) {
      b.rvx[i] -= rn * sd.nx;
      b.rvy[i] -= rn * sd.ny;
    }
  }
  return out;
}
