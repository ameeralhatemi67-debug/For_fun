import { describe, expect, it } from 'vitest';
import { coverRect, videoToScreen } from '../src/camera/CameraController';

/** TS copy of the shader's screen → video UV mapping (fluidShader.ts `background`). */
function shaderScreenToVideo(x: number, y: number, rect: ReturnType<typeof coverRect>, mirror: boolean, viewW: number) {
  const xx = mirror ? viewW - x : x;
  return { u: (xx - rect.x) / rect.w, v: (y - rect.y) / rect.h };
}

describe('camera mapping', () => {
  it('cover rect fills the view and keeps aspect', () => {
    const r = coverRect(1280, 720, 390, 844); // landscape camera on a portrait phone
    expect(r.h).toBeCloseTo(844);
    expect(r.w / r.h).toBeCloseTo(1280 / 720);
    expect(r.x).toBeLessThan(0);
  });

  it('tracking→screen and shader screen→video are exact inverses (mirrored and not)', () => {
    for (const [vw, vh, W, H] of [
      [1280, 720, 1920, 1080],
      [1280, 720, 390, 844],
      [640, 480, 1024, 768],
    ]) {
      const rect = coverRect(vw, vh, W, H);
      for (const mirror of [true, false]) {
        for (const [nx, ny] of [
          [0.5, 0.5],
          [0.1, 0.9],
          [0.83, 0.27],
        ]) {
          const p = videoToScreen(nx, ny, rect, mirror, W);
          const uv = shaderScreenToVideo(p.x, p.y, rect, mirror, W);
          expect(uv.u).toBeCloseTo(nx, 9);
          expect(uv.v).toBeCloseTo(ny, 9);
        }
      }
    }
  });

  it('mirroring flips left and right', () => {
    const rect = coverRect(1280, 720, 1280, 720);
    expect(videoToScreen(0.2, 0.5, rect, true, 1280).x).toBeCloseTo(1280 * 0.8);
    expect(videoToScreen(0.2, 0.5, rect, false, 1280).x).toBeCloseTo(1280 * 0.2);
  });
});
