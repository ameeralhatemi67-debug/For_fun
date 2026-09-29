import type { AnchorFilter } from '../tracking/AnchorFilter';
import type { IdentifiedHand } from '../tracking/AnchorResolver';
import type { FluidBody } from '../physics/FluidBody';
import type { DropletSystem } from '../physics/DropletSystem';
import type { Settings } from '../config/schema';

const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export interface DebugScene {
  ctx: CanvasRenderingContext2D;
  S: number;
  debug: boolean;
  handles: boolean;
  fusionMode: boolean;
  anchors: readonly AnchorFilter[];
  bodies: readonly FluidBody[];
  droplets: DropletSystem;
  hands: IdentifiedHand[];
  handToScreen: (nx: number, ny: number) => { x: number; y: number };
  settings: Settings;
  bodyCount: number;
}

const ANCHOR_COLORS = ['#6fb6ff', '#ff6f6f'];

/** 2D overlay (separate canvas, never recorded): debug markers and mouse-mode handles. */
export function drawDebug(d: DebugScene): void {
  const { ctx, S } = d;
  const w = (v: number) => v * S;

  if (d.handles && d.fusionMode) {
    // Mouse-mode anchor handles so B can be found and dragged.
    for (let i = 0; i < 2; i++) {
      const a = d.anchors[i];
      if (a.state === 'none') continue;
      ctx.beginPath();
      ctx.arc(w(a.x), w(a.y), 22, 0, Math.PI * 2);
      ctx.strokeStyle = ANCHOR_COLORS[i] + 'bb';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ANCHOR_COLORS[i] + 'dd';
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(i === 0 ? 'A' : 'B', w(a.x) + 23, w(a.y) - 14);
    }
  }
  if (!d.debug) return;

  // Hand skeletons.
  ctx.lineWidth = 1;
  for (const hand of d.hands) {
    const pts = hand.landmarks.map((p) => d.handToScreen(p.x, p.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (const p of pts) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    ctx.fillText(`#${hand.id} ${hand.label} ${hand.score.toFixed(2)}`, pts[0].x + 6, pts[0].y + 14);
  }

  // Fusion radii around anchor A.
  if (d.fusionMode) {
    const a = d.anchors[0];
    const b = d.anchors[1];
    if (a.state !== 'none' && b.state !== 'none') {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.arc(w(a.x), w(a.y), w(d.settings.attractionRadius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w(a.x), w(a.y), w(d.settings.mergeRadius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(w(a.x), w(a.y));
      ctx.lineTo(w(b.x), w(b.y));
      ctx.stroke();
    }
  }

  for (let i = 0; i < d.bodyCount; i++) {
    const a = d.anchors[i];
    const body = d.bodies[i];
    if (a.state !== 'none') {
      // Raw sample (x), smoothed target (ring).
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 1.5;
      const rx = w(a.rawX);
      const ry = w(a.rawY);
      ctx.beginPath();
      ctx.moveTo(rx - 5, ry - 5);
      ctx.lineTo(rx + 5, ry + 5);
      ctx.moveTo(rx + 5, ry - 5);
      ctx.lineTo(rx - 5, ry + 5);
      ctx.stroke();
      ctx.strokeStyle = a.state === 'tracking' ? '#ffd166' : a.state === 'predicting' ? '#ff9f1c' : '#888';
      ctx.beginPath();
      ctx.arc(w(a.x), w(a.y), 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (body.presence <= 0.01) continue;
    // Surface points and tail.
    ctx.fillStyle = 'rgba(120,255,220,0.8)';
    for (let k = 0; k < d.settings.secondaryCount; k++) ctx.fillRect(w(body.rx[k]) - 1.5, w(body.ry[k]) - 1.5, 3, 3);
    ctx.fillStyle = 'rgba(255,200,120,0.8)';
    for (let k = 0; k < body.tlx.length; k++) ctx.fillRect(w(body.tlx[k]) - 1.5, w(body.tly[k]) - 1.5, 3, 3);
    // Simulated center + tether + velocity.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(w(body.x), w(body.y));
    ctx.lineTo(w(body.tx), w(body.ty));
    ctx.stroke();
    ctx.fillStyle = '#4dffd2';
    ctx.beginPath();
    ctx.arc(w(body.x), w(body.y), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4dffd2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w(body.x), w(body.y));
    ctx.lineTo(w(body.x + body.vx * 0.1), w(body.y + body.vy * 0.1));
    ctx.stroke();
    // Acceleration (pseudo-force direction is opposite).
    ctx.strokeStyle = '#c77dff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w(body.x), w(body.y));
    ctx.lineTo(w(body.x + body.ax * 0.004), w(body.y + body.ay * 0.004));
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  for (const dr of d.droplets.drops) {
    if (!dr.active) continue;
    ctx.beginPath();
    ctx.arc(w(dr.x), w(dr.y), Math.max(2, w(dr.r)), 0, Math.PI * 2);
    ctx.stroke();
  }
}
