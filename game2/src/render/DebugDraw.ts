import type { Settings } from '../config/schema';
import type { Simulation } from '../effects/Simulation';
import { newPalmSample, type HandState } from '../tracking/HandPipeline';

const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export interface DebugScene {
  ctx: CanvasRenderingContext2D;
  S: number;
  debug: boolean;
  /** CSS px position of the draggable hand-B handle (mouse mode), or null. */
  handleB: { x: number; y: number } | null;
  sim: Simulation;
  hands: readonly HandState[];
  now: number;
  settings: Settings;
}

const ANCHOR_COLORS = ['#6fb6ff', '#ff6f6f'];
const GESTURE_COLORS: Record<string, string> = {
  TRACK: '#ffd166',
  PALM_PUSH: '#4dffb0',
  HANDGUN: '#ff7ad9',
  NEUTRAL: '#aaaaaa',
};
const palmTmp = newPalmSample();

/**
 * 2D overlay (separate canvas, never recorded): debug layers and mouse-mode handles.
 *   hand skeleton + gesture label · palm collider + palm velocity · finger direction →
 *   offset anchor · aim ray (handgun) · raw/smoothed anchor · body center/velocity/accel ·
 *   surface + tail points · droplets · fusion radius + surface gap
 */
export function drawDebug(d: DebugScene): void {
  const { ctx, S, sim } = d;
  const w = (v: number) => v * S;
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';

  if (d.handleB) {
    // Mouse-mode grab handle for hand B (A simply follows the pointer).
    const { x, y } = d.handleB;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.strokeStyle = ANCHOR_COLORS[1] + 'bb';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = ANCHOR_COLORS[1] + 'dd';
    ctx.fillText('B', x + 23, y - 14);
  }
  if (!d.debug) return;

  // ── Hands ────────────────────────────────────────────────────────────────
  for (const hand of d.hands) {
    const lm = hand.lm;
    const g = hand.gesture;
    const gc = GESTURE_COLORS[g] ?? '#fff';
    const alpha = hand.visible ? 1 : 0.35;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      ctx.moveTo(w(lm[a * 3]), w(lm[a * 3 + 1]));
      ctx.lineTo(w(lm[b * 3]), w(lm[b * 3 + 1]));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 21; i++) ctx.fillRect(w(lm[i * 3]) - 1.5, w(lm[i * 3 + 1]) - 1.5, 3, 3);

    // Palm collider (solid when it is active) + palm velocity.
    hand.palm.sample(d.now, palmTmp);
    if (palmTmp.n >= 3) {
      ctx.beginPath();
      for (let i = 0; i < palmTmp.n; i++) {
        const x = w(palmTmp.poly[i * 2]);
        const y = w(palmTmp.poly[i * 2 + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      if (g === 'PALM_PUSH') {
        ctx.fillStyle = 'rgba(77,255,176,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(77,255,176,0.8)';
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(77,255,176,0.25)';
        ctx.setLineDash([3, 4]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#4dffb0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w(palmTmp.cx), w(palmTmp.cy));
      ctx.lineTo(w(palmTmp.cx + palmTmp.vx * 0.1), w(palmTmp.cy + palmTmp.vy * 0.1));
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Finger direction (index) and handgun aim ray.
    const tip = hand.tips.index;
    const dir = hand.dirs.index;
    ctx.strokeStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(w(tip.x), w(tip.y));
    ctx.lineTo(w(tip.x + dir.x * 0.05), w(tip.y + dir.y * 0.05));
    ctx.stroke();
    if (g === 'HANDGUN') {
      ctx.strokeStyle = 'rgba(255,122,217,0.7)';
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(w(tip.x), w(tip.y));
      ctx.lineTo(w(tip.x + hand.aim.x * 1.5), w(tip.y + hand.aim.y * 1.5));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label: id, gesture, ring/pinky, thumb.
    const r = hand.reading;
    const lx = w(lm[0]) + 8;
    const ly = w(lm[1]) + 16;
    ctx.fillStyle = gc;
    ctx.fillText(`#${hand.id} ${g}${r.raw !== g ? ` (raw ${r.raw})` : ''}`, lx, ly);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(
      `ring ${r.open[3] ? 'open' : 'closed'} ${r.ext[3].toFixed(2)} · pinky ${r.open[4] ? 'open' : 'closed'} ${r.ext[4].toFixed(2)}`,
      lx,
      ly + 13,
    );
    ctx.fillText(`thumb ${r.thumbArmed ? 'ARMED' : 'folded'} ${r.thumbOpen.toFixed(2)} · depth ×${hand.depthScale.toFixed(2)}`, lx, ly + 26);
    ctx.globalAlpha = 1;
  }

  // ── Fusion: attraction radius around A's body, surface gap at the midpoint ─
  const [b0, b1] = sim.bodies;
  if (sim.mode === 'fusion' && b0.alive && b1.alive) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(w(b0.x), w(b0.y), w(d.settings.attractionRadius), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(w(b0.x), w(b0.y));
    ctx.lineTo(w(b1.x), w(b1.y));
    ctx.stroke();
    ctx.fillStyle = sim.fusion.state === 'CONTACT' || sim.fusion.state === 'FUSING' ? '#ff7ad9' : '#ddd';
    const gapR = sim.surfaceGap / Math.max(1e-6, b0.radius(d.settings));
    ctx.fillText(`gap ${Number.isFinite(gapR) ? gapR.toFixed(2) : '∞'} R · ${sim.fusion.state}`, w((b0.x + b1.x) / 2) + 6, w((b0.y + b1.y) / 2) - 8);
  }

  // ── Anchors + bodies ─────────────────────────────────────────────────────
  for (let i = 0; i < sim.bodyCount; i++) {
    const a = sim.anchors[i];
    const body = sim.bodies[i];
    const ad = sim.anchorDebug[i];
    if (ad.valid) {
      // Fingertip → offset anchor target (the finger gap).
      ctx.strokeStyle = 'rgba(255,209,102,0.5)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(w(ad.tipX), w(ad.tipY));
      ctx.lineTo(w(ad.targetX), w(ad.targetY));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (a.state !== 'none') {
      // Raw offset sample (x), smoothed target (ring).
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
      ctx.lineWidth = 1;
    }
    if (!body.alive || body.presence <= 0.01) continue;
    // Surface points and tail.
    ctx.fillStyle = 'rgba(120,255,220,0.8)';
    for (let k = 0; k < d.settings.secondaryCount; k++) ctx.fillRect(w(body.rx[k]) - 1.5, w(body.ry[k]) - 1.5, 3, 3);
    ctx.fillStyle = 'rgba(255,200,120,0.8)';
    for (let k = 0; k < body.tlx.length; k++) ctx.fillRect(w(body.tlx[k]) - 1.5, w(body.tly[k]) - 1.5, 3, 3);
    // Tether to the target (only while anchored/recapturing).
    if (body.control === 'ANCHORED' || body.control === 'RECAPTURING') {
      ctx.strokeStyle = body.control === 'RECAPTURING' ? 'rgba(255,122,217,0.7)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(w(body.x), w(body.y));
      ctx.lineTo(w(body.tx), w(body.ty));
      ctx.stroke();
    }
    ctx.fillStyle = '#4dffd2';
    ctx.beginPath();
    ctx.arc(w(body.x), w(body.y), 4, 0, Math.PI * 2);
    ctx.fill();
    // Effective (collision/fusion) radius.
    ctx.strokeStyle = 'rgba(77,255,210,0.3)';
    ctx.beginPath();
    ctx.arc(w(body.x), w(body.y), w(body.visibleRadius(d.settings)), 0, Math.PI * 2);
    ctx.stroke();
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
    ctx.fillStyle = '#4dffd2';
    ctx.fillText(body.spawning ? 'SPAWN' : body.control, w(body.x) + 8, w(body.y) + 16);
  }

  // Last shot origin + direction.
  const shot = sim.lastShot;
  if (shot && d.now - shot.t < 1.5) {
    ctx.strokeStyle = 'rgba(255,122,217,0.9)';
    ctx.beginPath();
    ctx.arc(w(shot.x), w(shot.y), 6, 0, Math.PI * 2);
    ctx.moveTo(w(shot.x), w(shot.y));
    ctx.lineTo(w(shot.x + shot.dx * 0.12), w(shot.y + shot.dy * 0.12));
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  for (const dr of sim.droplets.drops) {
    if (!dr.active) continue;
    ctx.beginPath();
    ctx.arc(w(dr.x), w(dr.y), Math.max(2, w(dr.r)), 0, Math.PI * 2);
    ctx.stroke();
  }
}
