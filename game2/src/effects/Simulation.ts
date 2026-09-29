/**
 * The DOM-free heart of the effect: hands → anchors → body control → physics
 * → fusion → metaballs. The EffectController owns camera/mouse/scripts,
 * rendering and the loop; tests drive this class directly with synthetic hands.
 *
 *   HandState[] (gesture, tips, dirs, palm, depth)
 *        │ source assignment (sandbox owner / fusion A-B rules)
 *        ▼
 *   offset anchor = fingertip + dir·(gap+1)·R ──▶ AnchorFilter ×2
 *        │
 *   body control per ball:  ANCHORED ⇄ FREE / SHOT ⇄ RECAPTURING   (+ spawn / despawn)
 *        │
 *   FluidBody ×2, DropletSystem, palm collisions, FusionStateMachine (surface-gap contact)
 */
import { DEFAULT_SETTINGS, type Settings } from '../config/schema';
import { BlobBuffer } from '../physics/blobBuffer';
import { DROPLET_POOL, DropletSystem } from '../physics/DropletSystem';
import { FluidBody, isFreeControl, type BodyControl } from '../physics/FluidBody';
import { collideBodyWithPalm, type PalmContact } from '../physics/PalmCollision';
import { AnchorFilter } from '../tracking/AnchorFilter';
import { isAnchoringGesture } from '../tracking/GestureClassifier';
import { newPalmSample, type HandState } from '../tracking/HandPipeline';
import type { FingerName } from '../tracking/handModel';
import { clamp01, easeInOutCubic, expAlpha, makeRng, smoothstep } from '../utils/math';
import { FusionStateMachine } from './FusionStateMachine';

export type Mode = 'sandbox' | 'fusion';
export type PaletteName = 'purple' | 'blue' | 'red';

export interface LookState {
  base: PaletteName;
  purpleMix: number;
  flash: number;
  energy: number;
}

export interface AnchorSource {
  hand: HandState;
  finger: FingerName;
}

interface BodyCtl {
  /** Hand that released/shot the ball (−1 = none) and its gesture epoch at that moment. */
  releasedBy: number;
  releaseEpoch: number;
  releaseTime: number;
  offscreenT: number;
  shotReadyAt: number;
  /** Palm-contact flags per hand id (to count distinct hits). */
  contacts: Set<number>;
}

export interface AnchorDebug {
  valid: boolean;
  tipX: number;
  tipY: number;
  dirX: number;
  dirY: number;
  targetX: number;
  targetY: number;
}

export interface SimCounters {
  spawns: number;
  despawns: number;
  releases: number;
  recaptures: number;
  shots: number;
  palmHits: number;
  fusions: number;
}

export interface PalmHitEvent {
  hand: number;
  body: number;
  impact: number;
  /** Contact normal (away from the palm). */
  nx: number;
  ny: number;
  t: number;
}

const SHOCK_TIME = 0.55;
/** Number of metaballs in the fusion neck. */
const NECK_BLOBS = 5;

export class Simulation {
  settings: Settings = { ...DEFAULT_SETTINGS };
  mode: Mode = 'sandbox';
  readonly anchors = [new AnchorFilter(), new AnchorFilter()] as const;
  readonly bodies = [new FluidBody(1.3), new FluidBody(4.7)] as const;
  readonly droplets = new DropletSystem();
  readonly fusion = new FusionStateMachine();
  readonly looks: [LookState, LookState] = [
    { base: 'purple', purpleMix: 0, flash: 0, energy: 0 },
    { base: 'red', purpleMix: 0, flash: 0, energy: 0 },
  ];
  readonly sources: [AnchorSource | null, AnchorSource | null] = [null, null];
  readonly anchorDebug: [AnchorDebug, AnchorDebug] = [newAnchorDebug(), newAnchorDebug()];
  readonly counters: SimCounters = { spawns: 0, despawns: 0, releases: 0, recaptures: 0, shots: 0, palmHits: 0, fusions: 0 };
  readonly palmHits: PalmHitEvent[] = [];
  readonly shock = { x: 0, y: 0, t: SHOCK_TIME, strength: 0 };
  lastShot: { x: number; y: number; dx: number; dy: number; t: number } | null = null;
  hands: readonly HandState[] = [];
  /** Viewport size in world units (for off-screen cleanup). */
  viewW = 1;
  viewH = 1;
  twoHandMode = false;
  /** Fusion diagnostics. */
  centerDistance = 0;
  surfaceGap = Infinity;
  neck = 0;
  /** Simulation clock (s). */
  time = 0;

  private ctl: [BodyCtl, BodyCtl] = [newCtl(), newCtl()];
  private owner = -1;
  private twoSince = -1;
  private oneSince = -1;
  private purpleTarget = [0, 0];
  private sizeTarget = [1, 1];
  private flashTarget = [0, 0];
  private rng = makeRng(99);
  private palmTmp = newPalmSample();
  private contact: PalmContact = { touching: false, impact: 0, nx: 0, ny: 0 };

  control(i: number): BodyControl {
    return this.bodies[i].control;
  }

  /** Number of bodies that can exist in the current mode. */
  get bodyCount(): number {
    return this.mode === 'fusion' ? 2 : 1;
  }

  setMode(m: Mode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.reset();
  }

  reset(): void {
    this.fusion.reset();
    this.droplets.clear();
    this.anchors.forEach((a) => a.reset());
    this.owner = -1;
    this.twoHandMode = false;
    this.twoSince = this.oneSince = -1;
    for (let i = 0; i < 2; i++) {
      this.kill(i, false);
      const b = this.bodies[i];
      b.sizeScale = 1;
      b.compression = 1;
      b.depthScale = 1;
      this.looks[i].purpleMix = this.purpleTarget[i] = 0;
      this.looks[i].flash = 0;
      this.sizeTarget[i] = 1;
    }
    this.neck = 0;
    this.surfaceGap = Infinity;
    this.shock.t = SHOCK_TIME;
    this.lastShot = null;
  }

  requestSplit(): void {
    this.fusion.requestSplit();
  }

  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Per-frame logic. `trackerFresh` = a new tracker result arrived this tick
   * (anchors get pushed or marked missing only then).
   */
  update(dt: number, now: number, hands: readonly HandState[], trackerFresh: boolean): void {
    const s = this.settings;
    this.hands = hands;
    for (const b of this.bodies) {
      b.extAx = b.extAy = 0;
      b.reachGain = 0;
      b.tremble = 0;
      b.stiffnessBoost = 1;
    }
    this.flashTarget[0] = this.flashTarget[1] = 0;
    if (this.mode === 'sandbox') this.kill(1, false);

    this.resolveSources(now);
    this.decideControl(now);
    this.resolveSources(now);
    this.feedAnchors(now, trackerFresh);
    for (let i = 0; i < this.bodyCount; i++) this.driveBody(i, dt, now);

    if (this.mode === 'sandbox') {
      this.looks[0].base = 'purple';
      this.purpleTarget[0] = 0;
      this.sizeTarget[0] = 1;
      const b0 = this.bodies[0];
      b0.compression += (1 - b0.compression) * expAlpha(dt, 0.08);
      this.neck *= Math.exp(-dt * 8);
    } else {
      this.updateFusion(dt, now);
    }

    // Presence: spawn condenses over spawnGrowDuration; recovery from a partial fade is quick;
    // loss fades over fadeDuration (the mass evaporates/shrinks).
    for (let i = 0; i < 2; i++) {
      const b = this.bodies[i];
      if (!b.alive) continue;
      if (b.presenceTarget > b.presence) {
        b.presence = Math.min(b.presenceTarget, b.presence + dt / (b.spawning ? s.spawnGrowDuration : 0.22));
        if (b.spawning && b.presence >= 1) b.spawning = false;
      } else {
        b.presence = Math.max(b.presenceTarget, b.presence - dt / s.fadeDuration);
        b.spawning = false;
      }
      if (b.control === 'ANCHORED' && b.presenceTarget === 0 && b.presence <= 0) this.kill(i, true);
    }
    for (let i = 0; i < 2; i++) {
      const look = this.looks[i];
      look.purpleMix += (this.purpleTarget[i] - look.purpleMix) * expAlpha(dt, 0.22);
      look.flash = Math.max(this.flashTarget[i], look.flash * Math.exp(-dt * 3.2));
      const b = this.bodies[i];
      b.sizeScale += (this.sizeTarget[i] - b.sizeScale) * expAlpha(dt, 0.18);
      const R = s.baseRadius * b.sizeScale * b.depthScale;
      b.volumeScale = Math.max(0.7, 1 - 0.5 * this.droplets.detachedVolume(i, R));
      look.energy = clamp01(b.speed / 3);
    }
    this.shock.t += dt;
  }

  /** One physics substep. `t` is the substep's clock time (for palm extrapolation). */
  step(dt: number, t: number): void {
    const s = this.settings;
    this.time = t;
    for (let i = 0; i < 2; i++) {
      const b = this.bodies[i];
      if (b.alive) b.step(dt, s, t);
    }
    for (let i = 0; i < this.bodyCount; i++) this.collidePalms(i, t);
    this.droplets.emit(dt, 0, this.bodies[0], s);
    if (this.mode === 'fusion' && this.fusion.state !== 'PURPLE') this.droplets.emit(dt, 1, this.bodies[1], s);
    this.droplets.update(dt, this.bodies, s);
  }

  writeBlobs(out: BlobBuffer): void {
    const s = this.settings;
    out.clear();
    if (this.bodies[0].alive) this.bodies[0].writeBlobs(out, s, 0);
    if (this.bodies[1].alive) this.bodies[1].writeBlobs(out, s, 1);
    this.writeNeck(out);
    this.droplets.writeBlobs(out, this.bodies);
  }

  // ── Sources ────────────────────────────────────────────────────────────
  private resolveSources(now: number): void {
    const s = this.settings;
    const hands = this.hands;
    if (this.mode === 'sandbox') {
      const b0 = this.bodies[0];
      let ownerHand = hands.find((h) => h.id === this.owner);
      const anchoring = hands.find((h) => h.visible && isAnchoringGesture(h.gesture));
      if (!b0.alive) {
        // Spawn at a hand that is pointing, preferring the current owner.
        if (anchoring && !(ownerHand && ownerHand.visible && isAnchoringGesture(ownerHand.gesture))) this.owner = anchoring.id;
      } else if (!isFreeControl(b0.control)) {
        const ownerGone = !ownerHand || (!ownerHand.visible && now - ownerHand.lastSeen > s.graceDuration);
        if (ownerGone && anchoring) this.owner = anchoring.id;
      }
      if (!hands.some((h) => h.id === this.owner) && hands.length) {
        this.owner = (hands.find((h) => h.visible) ?? hands[0]).id;
      }
      ownerHand = hands.find((h) => h.id === this.owner);
      this.sources[0] = ownerHand ? { hand: ownerHand, finger: 'index' } : null;
      this.sources[1] = null;
      return;
    }
    // Fusion: debounced one-hand / two-hand assignment (stable hand ids, not detector order).
    const visible = hands.filter((h) => h.visible);
    const nVis = visible.length;
    if (s.anchorMode === 'twoHands') this.twoHandMode = true;
    else if (s.anchorMode === 'oneHand') this.twoHandMode = false;
    else if (nVis >= 2) {
      this.oneSince = -1;
      if (this.twoSince < 0) this.twoSince = now;
      if (now - this.twoSince > 0.3) this.twoHandMode = true;
    } else {
      this.twoSince = -1;
      if (this.oneSince < 0) this.oneSince = now;
      if (now - this.oneSince > 0.4) this.twoHandMode = false;
    }
    if (!hands.length) {
      this.sources[0] = this.sources[1] = null;
      return;
    }
    if (this.twoHandMode) {
      // Hand A index → ball A, hand B index → ball B (ids keep this stable through brief misses).
      this.sources[0] = { hand: hands[0], finger: 'index' };
      this.sources[1] = hands[1] ? { hand: hands[1], finger: 'index' } : null;
    } else {
      const primary = visible[0] ?? hands[0];
      this.sources[0] = { hand: primary, finger: 'index' };
      this.sources[1] = { hand: primary, finger: s.anchorBFinger as FingerName };
    }
  }

  // ── Gesture-driven control transitions ────────────────────────────────
  private decideControl(now: number): void {
    for (let i = 0; i < this.bodyCount; i++) {
      const b = this.bodies[i];
      if (!b.alive || this.fusion.state === 'FUSING') continue;
      const c = this.ctl[i];
      const h = this.sources[i]?.hand;
      if (b.control === 'ANCHORED' || b.control === 'RECAPTURING') {
        if (h && h.visible && h.gesture === 'PALM_PUSH') {
          // Open hand: the hand becomes a collider and the ball keeps its own momentum.
          this.release(i, h, 'FREE', now);
        } else if (
          b.control === 'ANCHORED' &&
          h &&
          h.fire &&
          h.gesture === 'HANDGUN' &&
          this.sources[i]!.finger === 'index' &&
          now >= c.shotReadyAt &&
          b.presence > 0.5
        ) {
          this.shoot(i, h, now);
        }
        continue;
      }
      // FREE / SHOT: recaptured by a hand that (newly) points at it.
      const eligible = (hh: HandState) =>
        hh.visible && isAnchoringGesture(hh.gesture) && (hh.id !== c.releasedBy || hh.epoch !== c.releaseEpoch);
      let catcher: HandState | undefined;
      if (this.mode === 'sandbox') catcher = this.hands.find(eligible);
      else if (h && eligible(h)) catcher = h;
      if (catcher) {
        if (this.mode === 'sandbox') this.owner = catcher.id;
        b.control = 'RECAPTURING';
        this.counters.recaptures++;
      }
    }
  }

  private release(i: number, h: HandState | null, kind: 'FREE' | 'SHOT', now: number): void {
    const b = this.bodies[i];
    const c = this.ctl[i];
    b.control = kind;
    b.tvx = b.tvy = 0;
    c.releasedBy = h ? h.id : -1;
    c.releaseEpoch = h ? h.epoch : -1;
    c.releaseTime = now;
    c.offscreenT = 0;
    this.counters.releases++;
  }

  private shoot(i: number, h: HandState, now: number): void {
    const s = this.settings;
    const b = this.bodies[i];
    const A = this.anchors[i];
    const ax = h.aim.x;
    const ay = h.aim.y;
    // Launch from where the liquid IS (no snap to the ray origin), with the hand's momentum.
    b.vx = ax * s.shotSpeed + A.vx * s.shotHandVelocityInfluence;
    b.vy = ay * s.shotSpeed + A.vy * s.shotHandVelocityInfluence;
    this.release(i, h, 'SHOT', now);
    this.ctl[i].shotReadyAt = now + s.shotCooldown;
    this.looks[i].flash = Math.max(this.looks[i].flash, 0.45);
    this.lastShot = { x: b.x, y: b.y, dx: ax, dy: ay, t: now };
    this.counters.shots++;
  }

  // ── Anchors ─────────────────────────────────────────────────────────────
  private feedAnchors(now: number, fresh: boolean): void {
    const s = this.settings;
    for (let i = 0; i < 2; i++) {
      const A = this.anchors[i];
      const src = this.sources[i];
      const dbg = this.anchorDebug[i];
      if (i >= this.bodyCount) {
        if (fresh) A.missing(now, s);
        A.sample(now, s);
        dbg.valid = false;
        continue;
      }
      if (fresh) {
        if (src && src.hand.visible && src.hand.fresh) {
          const h = src.hand;
          const tip = h.tips[src.finger];
          const dir = h.dirs[src.finger];
          // Nominal radius (not the animated one) so the gap does not breathe during spawn/fusion.
          const R = s.baseRadius * this.sizeTarget[i] * h.depthScale;
          const off = (s.fingerGap + 1) * R;
          const tx = tip.x + dir.x * off;
          const ty = tip.y + dir.y * off;
          A.push(tx, ty, h.confidence, now, s);
          dbg.valid = true;
          dbg.tipX = tip.x;
          dbg.tipY = tip.y;
          dbg.dirX = dir.x;
          dbg.dirY = dir.y;
          dbg.targetX = tx;
          dbg.targetY = ty;
        } else {
          A.missing(now, s);
          dbg.valid = false;
        }
      }
      A.sample(now, s);
    }
  }

  // ── Per-body drive: spawn, targets, presence, despawn ──────────────────
  private canSpawn(i: number): boolean {
    if (this.mode === 'sandbox') return i === 0;
    const st = this.fusion.state;
    return st !== 'FUSING' && st !== 'PURPLE';
  }

  private driveBody(i: number, dt: number, now: number): void {
    const s = this.settings;
    const b = this.bodies[i];
    const A = this.anchors[i];
    const c = this.ctl[i];
    const h = this.sources[i]?.hand;
    const pointing = !!h && h.visible && isAnchoringGesture(h.gesture);

    if (A.reappeared) {
      A.reappeared = false;
      // True loss → reacquire after the body has meaningfully faded: condense anew at
      // the finger instead of flying in from where it evaporated.
      if (b.alive && b.control === 'ANCHORED' && b.presence < 0.5) this.kill(i, false);
    }
    if (!b.alive) {
      if (this.canSpawn(i) && pointing && A.active) this.spawn(i, h!, now);
      else return;
    }

    if (h && !isFreeControl(b.control)) b.depthScale = h.depthScale;

    switch (b.control) {
      case 'ANCHORED':
        b.tx = A.x;
        b.ty = A.y;
        b.tvx = A.vx;
        b.tvy = A.vy;
        b.presenceTarget = A.active ? 1 : 0;
        break;
      case 'RECAPTURING': {
        b.presenceTarget = 1;
        if (!A.active) {
          this.release(i, null, 'FREE', now);
          break;
        }
        b.tx = A.x;
        b.ty = A.y;
        b.tvx = A.vx;
        b.tvy = A.vy;
        const d = Math.hypot(A.x - b.x, A.y - b.y);
        const rv = Math.hypot(b.vx - A.vx, b.vy - A.vy);
        if (d < s.recaptureDistance * b.radius(s) && rv < 2.5) b.control = 'ANCHORED';
        break;
      }
      case 'FREE':
      case 'SHOT': {
        b.presenceTarget = 1;
        b.tvx = b.tvy = 0;
        const R = b.radius(s);
        const m = s.freeBoundsMargin + R;
        const outside = b.x < -m || b.y < -m || b.x > this.viewW + m || b.y > this.viewH + m;
        c.offscreenT = outside ? c.offscreenT + dt : 0;
        if (c.offscreenT > s.offscreenDespawnDelay) this.kill(i, true);
        break;
      }
    }
  }

  private spawn(i: number, h: HandState, now: number): void {
    const s = this.settings;
    const b = this.bodies[i];
    const A = this.anchors[i];
    // Appear exactly at the current offset anchor, invisible, and condense there.
    A.clearBlend();
    A.sample(now, s);
    b.teleport(A.x, A.y);
    b.flowX = A.x;
    b.flowY = A.y;
    b.alive = true;
    b.spawning = true;
    b.presence = 0;
    b.presenceTarget = 1;
    b.control = 'ANCHORED';
    b.depthScale = h.depthScale;
    b.volumeScale = 1;
    b.compression = 1;
    // A gentle inward pinch that rebounds while it grows: reads as liquid condensing.
    b.radialImpulse(-0.35 * s.baseRadius * 3);
    resetCtl(this.ctl[i]);
    this.looks[i].flash = Math.max(this.looks[i].flash, 0.3);
    this.counters.spawns++;
  }

  private kill(i: number, count: boolean): void {
    const b = this.bodies[i];
    if (!b.alive && b.presence === 0) return;
    b.alive = false;
    b.spawning = false;
    b.presence = b.presenceTarget = 0;
    b.control = 'ANCHORED';
    b.vx = b.vy = 0;
    this.droplets.releaseBody(i);
    resetCtl(this.ctl[i]);
    if (count) this.counters.despawns++;
  }

  // ── Palm collisions ────────────────────────────────────────────────────
  private collidePalms(i: number, t: number): void {
    const s = this.settings;
    const b = this.bodies[i];
    const c = this.ctl[i];
    if (!b.alive || b.presence < 0.2 || b.control === 'ANCHORED') {
      c.contacts.clear();
      return;
    }
    for (const h of this.hands) {
      const usable = h.gesture === 'PALM_PUSH' && (h.visible || t - h.lastSeen < s.graceDuration);
      if (!usable) {
        c.contacts.delete(h.id);
        continue;
      }
      h.palm.sample(t, this.palmTmp);
      const r = collideBodyWithPalm(b, this.palmTmp, s, this.contact);
      if (r.touching) {
        if (!c.contacts.has(h.id) && r.impact > 0.05) {
          this.counters.palmHits++;
          this.palmHits.push({ hand: h.id, body: i, impact: r.impact, nx: r.nx, ny: r.ny, t });
          if (this.palmHits.length > 64) this.palmHits.shift();
          // A hard hit tears a little liquid off the far side.
          if (r.impact > 1.6 && s.dropletsEnabled) this.impactDroplet(i, r.nx, r.ny, r.impact);
        }
        c.contacts.add(h.id);
        if (isFreeControl(b.control)) c.offscreenT = 0;
      } else c.contacts.delete(h.id);
    }
  }

  private impactDroplet(i: number, nx: number, ny: number, impact: number): void {
    const s = this.settings;
    const b = this.bodies[i];
    const R = b.radius(s);
    const px = -ny;
    const py = nx;
    const side = this.rng() < 0.5 ? -1 : 1;
    const sp = Math.min(1.5, impact * 0.35);
    const r = R * (s.dropletMinSize + (s.dropletMaxSize - s.dropletMinSize) * 0.5 * this.rng());
    this.droplets.spawn(
      i,
      b.x + (px * side * 0.8 - nx * 0.3) * R,
      b.y + (py * side * 0.8 - ny * 0.3) * R,
      b.vx + px * side * sp,
      b.vy + py * side * sp,
      r,
      s.maxDroplets,
    );
  }

  // ── Fusion ─────────────────────────────────────────────────────────────
  private updateFusion(dt: number, now: number): void {
    const s = this.settings;
    const [A, B] = this.anchors;
    const [b0, b1] = this.bodies;
    this.looks[0].base = 'blue';
    this.looks[1].base = 'red';
    const bothActive = b0.alive && b1.alive && b0.presence > 0.5 && b1.presence > 0.5;
    let d = Math.hypot(b1.x - b0.x, b1.y - b0.y);
    let gap = Infinity;
    if (b0.alive && b1.alive) {
      const ux = d > 1e-9 ? (b1.x - b0.x) / d : 1;
      const uy = d > 1e-9 ? (b1.y - b0.y) / d : 0;
      gap = d - b0.surfaceExtent(ux, uy, s) - b1.surfaceExtent(-ux, -uy, s);
    } else d = Infinity;
    this.centerDistance = d;
    this.surfaceGap = gap;
    const Rm = (b0.radius(s) + b1.radius(s)) / 2;
    const ev = this.fusion.update(dt, d, gap, bothActive, s, Rm);
    if (ev === 'fuseStart') {
      b0.control = b1.control = 'ANCHORED';
    } else if (ev === 'release') this.releaseFusion(now);
    else if (ev === 'split') this.split();

    const st = this.fusion.state;
    const relaxComp = (b: FluidBody) => (b.compression += (1 - b.compression) * expAlpha(dt, 0.06));

    // Neck progress: grows as the visible surfaces approach, full at contact.
    let neckTarget = 0;
    if ((st === 'ATTRACTING' || st === 'CONTACT' || st === 'FUSING') && b0.alive && b1.alive) {
      const enter = FusionStateMachine.contactEnterGap(s, Rm);
      neckTarget = smoothstep(enter + 1.6 * Rm, enter, gap);
      if (st === 'CONTACT') neckTarget = Math.max(neckTarget, 0.8 + 0.2 * this.fusion.contactProgress(s));
      if (st === 'FUSING') neckTarget = 1;
    }
    this.neck += (neckTarget - this.neck) * expAlpha(dt, neckTarget > this.neck ? 0.1 : 0.06);

    if (st === 'PURPLE') {
      b1.presenceTarget = 0;
      this.purpleTarget[0] = 1;
      this.sizeTarget[0] = s.purpleScale;
      relaxComp(b0);
      // Purple gone (evaporated / shot off-screen) → silently start over with blue + red.
      if (!b0.alive) {
        this.fusion.reset();
        this.purpleTarget[0] = this.looks[0].purpleMix = 0;
        this.sizeTarget[0] = b0.sizeScale = 1;
      }
      return;
    }

    if (st === 'FUSING') {
      const fp = this.fusion.fuseProgress(s);
      const e = easeInOutCubic(fp);
      const anchorsOk = A.active && B.active;
      const mx = anchorsOk ? (A.x + B.x) / 2 : (b0.x + b1.x) / 2;
      const my = anchorsOk ? (A.y + B.y) / 2 : (b0.y + b1.y) / 2;
      for (let i = 0; i < 2; i++) {
        const b = this.bodies[i];
        const o = this.bodies[1 - i];
        b.control = 'ANCHORED';
        b.tx = mx;
        b.ty = my;
        b.tvx = b.tvy = 0;
        b.stiffnessBoost = 1 + 3 * e;
        b.presenceTarget = 1;
        b.compression = 1 - 0.42 * e;
        // Squeeze: the pair shrinks slightly while charging, then pops out bigger on release.
        b.sizeScale = this.sizeTarget[i] = 1 - 0.14 * e;
        const dx = o.x - b.x;
        const dy = o.y - b.y;
        const dl = Math.hypot(dx, dy) || 1;
        b.extAx = (dx / dl) * s.attractionStrength * 1.5;
        b.extAy = (dy / dl) * s.attractionStrength * 1.5;
        b.reachX = dx / dl;
        b.reachY = dy / dl;
        b.reachGain = s.reachStrength * (1 - e);
        b.tremble = 0.5 + 0.5 * (1 - fp);
        this.purpleTarget[i] = 0.25 + 0.75 * fp;
        this.looks[i].purpleMix = Math.max(this.looks[i].purpleMix, this.purpleTarget[i]);
        this.flashTarget[i] = 0.3 + 0.7 * fp * fp;
      }
      return;
    }

    // IDLE / DUAL / ATTRACTING / CONTACT / RECOVERING: two independent masses.
    this.sizeTarget[0] = this.sizeTarget[1] = 1;
    relaxComp(b0);
    relaxComp(b1);
    const cp = this.fusion.contactProgress(s);
    this.purpleTarget[0] = this.purpleTarget[1] = st === 'CONTACT' ? 0.22 * cp : 0;

    if ((st === 'ATTRACTING' || st === 'CONTACT') && Number.isFinite(d)) {
      const k = clamp01(1 - d / (s.attractionRadius * (1 + s.hysteresis)));
      const ux = (b1.x - b0.x) / (d || 1);
      const uy = (b1.y - b0.y) / (d || 1);
      const a = s.attractionStrength * k * k;
      b0.extAx = ux * a;
      b0.extAy = uy * a;
      b1.extAx = -ux * a;
      b1.extAy = -uy * a;
      const reach = s.reachStrength * Math.sqrt(k);
      b0.reachX = ux;
      b0.reachY = uy;
      b1.reachX = -ux;
      b1.reachY = -uy;
      b0.reachGain = b1.reachGain = reach;
      if (st === 'CONTACT') {
        b0.tremble = b1.tremble = 0.25 + 0.6 * cp;
        this.flashTarget[0] = this.flashTarget[1] = 0.3 * cp;
      }
    }
  }

  /** FUSING finished: the two masses become one purple mass, with a pop. */
  private releaseFusion(now: number): void {
    const s = this.settings;
    const [b0, b1] = this.bodies;
    const cx = (b0.x + b1.x) / 2;
    const cy = (b0.y + b1.y) / 2;
    // Collision axis and incoming velocities (before the merge) shape the splash.
    let ax = b1.x - b0.x;
    let ay = b1.y - b0.y;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    const in0x = b0.vx;
    const in0y = b0.vy;
    const in1x = b1.vx;
    const in1y = b1.vy;
    const vx = (b0.vx + b1.vx) / 2;
    const vy = (b0.vy + b1.vy) / 2;
    b0.translate(cx - b0.x, cy - b0.y);
    b0.vx = vx;
    b0.vy = vy;
    b0.sizeScale = this.sizeTarget[0] = s.purpleScale;
    b0.compression = 0.55;
    b0.radialImpulse(0.9 * s.fusionImpulse);
    this.droplets.reparent(1, 0);
    this.kill(1, false);
    this.looks[0].purpleMix = this.purpleTarget[0] = 1;
    this.looks[1].purpleMix = this.purpleTarget[1] = 1;
    this.looks[0].flash = 1.2;
    this.shock.x = cx;
    this.shock.y = cy;
    this.shock.t = 0;
    this.shock.strength = s.fusionImpulse;
    this.counters.fusions++;
    // Purple goes back to hand A if it is pointing, otherwise it floats free.
    const h = this.sources[0]?.hand;
    if (!(h && h.visible && isAnchoringGesture(h.gesture)) || !this.anchors[0].active) this.release(0, null, 'FREE', now);

    // Micro-droplets: two liquids colliding squirt out sideways (perpendicular to the
    // collision axis), some keep going with the incoming momentum, a few go radial.
    const R = s.baseRadius * s.purpleScale;
    const n = s.fusionDroplets;
    const px = -ay;
    const py = ax;
    for (let k = 0; k < n; k++) {
      const kind = k % 4;
      let ux: number;
      let uy: number;
      let sp = s.fusionImpulse * (0.3 + 0.35 * this.rng());
      if (kind <= 1) {
        const side = kind === 0 ? 1 : -1;
        const spread = (this.rng() - 0.5) * 0.9;
        ux = px * side * Math.cos(spread) + ax * Math.sin(spread);
        uy = py * side * Math.cos(spread) + ay * Math.sin(spread);
        sp *= 1.25;
      } else if (kind === 2) {
        // Carried on by whichever side came in faster.
        const iv = (k >> 2) % 2 === 0 ? [in0x, in0y] : [in1x, in1y];
        const il = Math.hypot(iv[0], iv[1]);
        const ang = this.rng() * Math.PI * 2;
        ux = il > 0.15 ? iv[0] / il : Math.cos(ang);
        uy = il > 0.15 ? iv[1] / il : Math.sin(ang);
        const j = (this.rng() - 0.5) * 0.7;
        const cj = Math.cos(j);
        const sj = Math.sin(j);
        [ux, uy] = [ux * cj - uy * sj, ux * sj + uy * cj];
        sp *= 0.9;
      } else {
        const ang = this.rng() * Math.PI * 2;
        ux = Math.cos(ang);
        uy = Math.sin(ang);
        sp *= 0.7;
      }
      const r = s.baseRadius * (s.dropletMinSize + (s.dropletMaxSize - s.dropletMinSize) * this.rng() * 0.8);
      this.droplets.spawn(0, cx + ux * R * 0.85, cy + uy * R * 0.85, vx + ux * sp, vy + uy * sp, r, DROPLET_POOL);
    }
  }

  /** Purple splits back into blue (A) and red (B); red flows out of the purple mass. */
  private split(): void {
    const [b0, b1] = this.bodies;
    b1.teleport(b0.x, b0.y);
    b1.vx = b0.vx;
    b1.vy = b0.vy;
    b1.alive = true;
    b1.spawning = false;
    b1.control = 'ANCHORED';
    b1.presence = 0.3;
    b1.sizeScale = 0.8;
    b1.depthScale = b0.depthScale;
    resetCtl(this.ctl[1]);
    this.looks[1].purpleMix = 1;
    this.purpleTarget[0] = this.purpleTarget[1] = 0;
    this.sizeTarget[0] = this.sizeTarget[1] = 1;
    b0.radialImpulse(0.5 * this.settings.fusionImpulse);
  }

  /**
   * Liquid bridge between blue and red: a few metaballs along a curve between
   * the facing surfaces. Palette position runs 0 → 1 along it, so the shader
   * renders blue → violet → red. It follows the bodies and fades if they separate.
   */
  private writeNeck(out: BlobBuffer): void {
    const s = this.settings;
    const [b0, b1] = this.bodies;
    const k = this.neck * s.neckStrength;
    if (this.mode !== 'fusion' || k < 0.02 || !b0.alive || !b1.alive) return;
    const dx = b1.x - b0.x;
    const dy = b1.y - b0.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    const ux = dx / d;
    const uy = dy / d;
    const e0 = b0.surfaceExtent(ux, uy, s);
    const e1 = b1.surfaceExtent(-ux, -uy, s);
    const p0x = b0.x + ux * e0 * 0.65;
    const p0y = b0.y + uy * e0 * 0.65;
    const p1x = b1.x - ux * e1 * 0.65;
    const p1y = b1.y - uy * e1 * 0.65;
    // Sideways relative motion bends the bridge (it lags like a stretched filament).
    const px = -uy;
    const py = ux;
    const vrel = (b1.vx - b0.vx) * px + (b1.vy - b0.vy) * py;
    const bend = Math.max(-0.6, Math.min(0.6, vrel * 0.06)) * d;
    const cx = (p0x + p1x) / 2 - px * bend;
    const cy = (p0y + p1y) / 2 - py * bend;
    const Rm = (b0.visibleRadius(s) + b1.visibleRadius(s)) / 2;
    const fusing = this.fusion.state === 'FUSING';
    const kk = Math.min(1, k);
    for (let j = 0; j < NECK_BLOBS; j++) {
      const t = (j + 1) / (NECK_BLOBS + 1);
      const a = (1 - t) * (1 - t);
      const bb = 2 * t * (1 - t);
      const c = t * t;
      const x = a * p0x + bb * cx + c * p1x;
      const y = a * p0y + bb * cy + c * p1y;
      const tx = 2 * (1 - t) * (cx - p0x) + 2 * t * (p1x - cx);
      const ty = 2 * (1 - t) * (cy - p0y) + 2 * t * (p1y - cy);
      const tl = Math.hypot(tx, ty) || 1;
      const thin = 1 - 0.4 * Math.sin(Math.PI * t);
      const sup = Rm * (0.38 + 0.3 * kk + (fusing ? 0.2 : 0)) * thin;
      const w = (0.18 + 0.62 * kk) * Math.min(1, k + 0.2);
      out.push(x, y, sup, w, tx / tl, ty / tl, 1.5, t);
    }
  }
}

function newCtl(): BodyCtl {
  return { releasedBy: -1, releaseEpoch: -1, releaseTime: 0, offscreenT: 0, shotReadyAt: 0, contacts: new Set() };
}
function resetCtl(c: BodyCtl): void {
  c.releasedBy = -1;
  c.releaseEpoch = -1;
  c.releaseTime = 0;
  c.offscreenT = 0;
  c.shotReadyAt = 0;
  c.contacts.clear();
}
function newAnchorDebug(): AnchorDebug {
  return { valid: false, tipX: 0, tipY: 0, dirX: 0, dirY: 0, targetX: 0, targetY: 0 };
}
