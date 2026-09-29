import type { EffectController } from '../effects/EffectController';
import type { ScriptName } from '../input/ScriptedMotion';

/**
 * Dev-only visual inspection helper (exposed as `window.__filmstrip`).
 * Deterministically steps the simulation and copies a crop around a body
 * from the WebGL canvas after each step into one grid image laid over the
 * page, so a whole motion can be judged from a single screenshot.
 *
 *   __filmstrip({ script: 'medium', t0: 1, dt: 0.06, n: 12, cols: 4, crop: 0.45 })
 *   __filmstrip.clear()
 */
export interface FilmstripOptions {
  script?: ScriptName;
  mode?: 'sandbox' | 'fusion';
  /** Seconds to advance before the first frame. */
  t0?: number;
  /** Seconds between frames. */
  dt?: number;
  n?: number;
  cols?: number;
  /** Crop size in world units. */
  crop?: number;
  /** Overall strip width in CSS px. */
  width?: number;
  /** Also copy the debug overlay. */
  debug?: boolean;
  /** Which body the crop follows (default 0). */
  body?: number;
  /** Keep the crop where the first frame was. */
  fixed?: boolean;
  /** Custom crop center (world units). */
  center?: (e: EffectController) => [number, number];
  label?: (e: EffectController) => string;
  setup?: (e: EffectController) => void;
}

export function installFilmstrip(engine: EffectController): void {
  const strip = (o: FilmstripOptions): string[] => {
    const e = engine;
    const { t0 = 0, dt = 0.1, n = 12, cols = 4, crop = 0.45, width = 780 } = o;
    if (o.mode) e.setMode(o.mode);
    if (o.script) {
      e.input = 'script';
      e.setScript(o.script);
    }
    o.setup?.(e);
    const prevDebug = e.debug;
    e.debug = !!o.debug;
    const gl = e.canvas;
    const pr = gl.width / e.cssW;
    const opr = e.overlay.width / e.cssW;
    const cell = Math.floor(width / cols);
    const rows = Math.ceil(n / cols);
    let c = document.getElementById('__filmstrip') as HTMLCanvasElement | null;
    if (!c) {
      c = document.createElement('canvas');
      c.id = '__filmstrip';
      c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000;pointer-events:none';
      document.body.appendChild(c);
    }
    c.width = cols * cell;
    c.height = rows * (cell + 14);
    c.style.width = `${c.width}px`;
    c.style.height = `${c.height}px`;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    if (t0 > 0) e.advance(t0);
    let fx = NaN;
    let fy = NaN;
    const info: string[] = [];
    for (let k = 0; k < n; k++) {
      e.advance(dt);
      const b = e.sim.bodies[o.body ?? 0];
      let [cx, cy] = o.center ? o.center(e) : [b.x, b.y];
      if (o.fixed) {
        if (Number.isNaN(fx)) {
          fx = cx;
          fy = cy;
        }
        cx = fx;
        cy = fy;
      }
      const half = (crop * e.S) / 2;
      const sx = cx * e.S - half;
      const sy = cy * e.S - half;
      const dx = (k % cols) * cell;
      const dy = Math.floor(k / cols) * (cell + 14);
      ctx.drawImage(gl, sx * pr, sy * pr, half * 2 * pr, half * 2 * pr, dx, dy, cell, cell);
      if (o.debug) ctx.drawImage(e.overlay, sx * opr, sy * opr, half * 2 * opr, half * 2 * opr, dx, dy, cell, cell);
      ctx.fillStyle = '#ccc';
      ctx.font = '11px monospace';
      const lab = o.label ? o.label(e) : `${(t0 + (k + 1) * dt).toFixed(2)}s v${b.speed.toFixed(2)} ${b.control}`;
      ctx.fillText(lab, dx + 4, dy + cell + 11);
      info.push(lab);
    }
    e.debug = prevDebug;
    return info;
  };
  const w = window as unknown as { __filmstrip: typeof strip & { clear: () => void } };
  w.__filmstrip = Object.assign(strip, { clear: () => document.getElementById('__filmstrip')?.remove() });
}
