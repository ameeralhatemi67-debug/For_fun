export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInOutCubic = (t: number) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Frame-rate independent exponential smoothing factor for time constant tau. */
export const expAlpha = (dt: number, tau: number) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** Smooth, cheap, allocation-free pseudo-noise in [-1, 1] (sum of incommensurate sines). */
export function wobbleNoise(t: number, seed: number): number {
  return (
    0.55 * Math.sin(t * 1.0 + seed * 12.9898) +
    0.3 * Math.sin(t * 1.731 + seed * 78.233 + 1.3) +
    0.15 * Math.sin(t * 2.917 + seed * 37.719 + 4.1)
  );
}

/** Deterministic PRNG (mulberry32) so tests and scripted runs are repeatable. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Vec2 {
  x: number;
  y: number;
}
