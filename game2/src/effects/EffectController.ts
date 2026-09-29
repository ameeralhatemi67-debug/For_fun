import { CameraController, coverRect, videoToScreen, type CoverRect } from '../camera/CameraController';
import { DEFAULT_SETTINGS, type Settings } from '../config/schema';
import { MouseInput } from '../input/MouseInput';
import { scriptFrame, type ScriptName } from '../input/ScriptedMotion';
import { BlobBuffer } from '../physics/blobBuffer';
import { DROPLET_POOL, DropletSystem } from '../physics/DropletSystem';
import { FluidBody } from '../physics/FluidBody';
import { drawDebug } from '../render/DebugDraw';
import { PALETTES, Renderer, type BodyLook } from '../render/Renderer';
import { AnchorFilter } from '../tracking/AnchorFilter';
import { AnchorResolver, HandIdentity, type IdentifiedHand } from '../tracking/AnchorResolver';
import { HandTracker } from '../tracking/HandTracker';
import { clamp01, easeInOutCubic, expAlpha, makeRng } from '../utils/math';
import { FusionStateMachine, type FusionState } from './FusionStateMachine';

export type Mode = 'sandbox' | 'fusion';
export type InputSource = 'mouse' | 'camera' | 'script';

export interface EngineStats {
  fps: number;
  trackerFps: number;
  effectState: string;
  fusionState: FusionState | '-';
  anchorA: string;
  anchorB: string;
  confidence: number;
  distance: number;
  droplets: number;
  speed: number;
  deformation: number;
  handsMode: string;
  cameraStatus: string;
  trackerStatus: string;
  message: string;
}

const MAX_STEP_DT = 1 / 240;
const MAX_SUBSTEPS = 16;
const SHOCK_TIME = 0.55;

/**
 * The engine: input → anchors → physics → renderer. It owns the render loop;
 * React only drives settings/mode and reads stats. Physics and rendering never
 * know whether an anchor came from MediaPipe, the mouse, or a test script.
 */
export class EffectController {
  settings: Settings = { ...DEFAULT_SETTINGS };
  mode: Mode = 'sandbox';
  input: InputSource = 'mouse';
  script: ScriptName = 'circle';
  debug = false;
  showHandles = true;
  /** Slow-motion factor for inspecting motion (1 = real time). Everything runs on this clock. */
  timeScale = 1;
  message = '';

  readonly renderer = new Renderer();
  readonly overlay = document.createElement('canvas');
  readonly camera = new CameraController();
  readonly tracker = new HandTracker();
  private identity = new HandIdentity();
  private resolver = new AnchorResolver();
  readonly mouse = new MouseInput();
  readonly anchors = [new AnchorFilter(), new AnchorFilter()] as const;
  readonly bodies = [new FluidBody(1.3), new FluidBody(4.7)] as const;
  readonly droplets = new DropletSystem();
  readonly fusion = new FusionStateMachine();
  private blobs = new BlobBuffer();
  private looks: [BodyLook, BodyLook] = [
    { base: PALETTES.purple, purpleMix: 0, flash: 0, energy: 0 },
    { base: PALETTES.red, purpleMix: 0, flash: 0, energy: 0 },
  ];
  private purpleTarget = [0, 0];
  private sizeTarget = [1, 1];
  private flashTarget = [0, 0];
  private rng = makeRng(99);

  private container: HTMLElement | null = null;
  private octx: CanvasRenderingContext2D | null = null;
  private resizeObs: ResizeObserver | null = null;
  private raf = 0;
  private lastTime = -1;
  private simTime = 0;
  /** Scaled clock (s) used by anchors, scripts and physics. */
  private clock = 0;
  private fps = 60;
  private scriptT0 = 0;
  private hands: IdentifiedHand[] = [];
  private rect: CoverRect = { x: 0, y: 0, w: 1, h: 1 };
  private shock = { x: 0, y: 0, t: SHOCK_TIME, strength: 0 };
  private overlayDirty = true;
  cssW = 1;
  cssH = 1;
  /** CSS px per world unit (= shorter viewport side). */
  S = 1;

  mount(container: HTMLElement): void {
    this.container = container;
    this.overlay.className = 'overlay-canvas';
    container.appendChild(this.renderer.canvas);
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d');
    this.mouse.attach(container);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.lastTime = -1;
    this.raf = requestAnimationFrame(this.frame);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.mouse.detach();
    this.camera.stop();
    this.tracker.close();
    this.renderer.canvas.remove();
    this.overlay.remove();
    this.renderer.dispose();
    this.container = null;
  }

  setSettings(s: Settings): void {
    const prq = s.maxPixelRatio !== this.settings.maxPixelRatio;
    this.settings = s;
    if (prq) this.resize();
  }

  setMode(m: Mode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.resetEffect();
  }

  setScript(name: ScriptName): void {
    this.script = name;
    this.scriptT0 = this.clock;
    this.resetEffect();
  }

  async setInput(src: InputSource): Promise<void> {
    this.input = src;
    this.message = '';
    this.scriptT0 = this.clock;
    this.anchors[0].reset();
    this.anchors[1].reset();
    if (src === 'camera') {
      try {
        await this.camera.start();
        this.setMessage('Loading hand tracker…', 60);
        await this.tracker.init();
        this.setMessage('Show your index finger to the camera.', 4);
      } catch (e) {
        // Camera or tracker unavailable: stay usable by falling back to the mouse.
        this.camera.stop();
        this.input = 'mouse';
        this.setMessage(`${(e as Error).message || String(e)} — switched to Mouse mode.`, 8);
      }
    } else if (this.camera.status === 'on') {
      this.camera.stop();
    }
  }

  private messageUntil = 0;
  private setMessage(msg: string, seconds: number): void {
    this.message = msg;
    this.messageUntil = performance.now() + seconds * 1000;
  }

  /** R: put everything back to a clean state for the current mode. */
  resetEffect(): void {
    this.fusion.reset();
    this.droplets.clear();
    this.anchors.forEach((a) => a.reset());
    this.identity.reset();
    this.mouse.resetPlacement();
    for (let i = 0; i < 2; i++) {
      const b = this.bodies[i];
      b.presence = 0;
      b.presenceTarget = 0;
      b.sizeScale = 1;
      b.compression = 1;
      this.looks[i].purpleMix = this.purpleTarget[i] = 0;
      this.looks[i].flash = 0;
      this.sizeTarget[i] = 1;
    }
    this.shock.t = SHOCK_TIME;
  }

  requestSplit(): void {
    this.fusion.requestSplit();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.canvas;
  }

  getStats(): EngineStats {
    const [A, B] = this.anchors;
    const b0 = this.bodies[0];
    const fusion = this.mode === 'fusion';
    let effectState: string;
    if (fusion) effectState = this.fusion.state;
    else if (A.state === 'tracking') effectState = 'TRACKING';
    else if (A.state === 'predicting') effectState = 'PREDICTING';
    else if (A.state === 'lost') effectState = b0.presence > 0.01 ? 'FADING' : 'LOST';
    else effectState = 'IDLE';
    return {
      fps: this.fps,
      trackerFps: this.input === 'camera' ? this.tracker.fps : 0,
      effectState,
      fusionState: fusion ? this.fusion.state : '-',
      anchorA: A.state,
      anchorB: fusion ? B.state : '-',
      confidence: A.confidence,
      distance: fusion ? Math.hypot(A.x - B.x, A.y - B.y) : 0,
      droplets: this.droplets.activeCount,
      speed: b0.speed,
      deformation: b0.deformationAmount(this.settings),
      handsMode: this.input === 'camera' ? (this.resolver.twoHandMode ? 'two hands' : 'one hand') : '-',
      cameraStatus: this.camera.status,
      trackerStatus: this.tracker.status,
      message: performance.now() < this.messageUntil ? this.message : '',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  private resize(): void {
    if (!this.container) return;
    this.cssW = Math.max(1, this.container.clientWidth);
    this.cssH = Math.max(1, this.container.clientHeight);
    this.S = Math.min(this.cssW, this.cssH);
    this.renderer.resize(this.cssW, this.cssH, this.settings.maxPixelRatio);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(this.cssW * dpr);
    this.overlay.height = Math.round(this.cssH * dpr);
    this.overlay.style.width = `${this.cssW}px`;
    this.overlay.style.height = `${this.cssH}px`;
    this.octx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private frame = (ms: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.frozen) {
      this.lastTime = ms / 1000;
      return;
    }
    const wall = ms / 1000;
    let dt = this.lastTime < 0 ? 1 / 60 : wall - this.lastTime;
    this.lastTime = wall;
    if (!(dt > 0)) dt = 0;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    this.tick(Math.min(dt, 0.05) * this.timeScale, ms); // clamp tab-switch / hitch spikes
  };

  /** Debug/automation: freeze the live loop. */
  frozen = false;

  /**
   * Debug/automation: deterministically advance the simulation by `seconds` of
   * scaled time in 60 Hz frames, then leave it frozen so the frame can be inspected.
   */
  advance(seconds: number): number {
    this.frozen = true;
    const n = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) this.tick(1 / 60, performance.now());
    return this.clock - this.scriptT0;
  }

  private tick(dt: number, ms: number): void {
    this.clock += dt;
    this.simTime += dt;
    const now = this.clock;

    if (this.input === 'camera' && this.camera.ready) {
      this.rect = coverRect(this.camera.video.videoWidth, this.camera.video.videoHeight, this.cssW, this.cssH);
    }
    this.updateInputs(now, ms);
    const s = this.settings;
    this.anchors[0].sample(now, s);
    this.anchors[1].sample(now, s);
    this.updateEffect(dt, now);

    // Split the frame into equal substeps no larger than MAX_STEP_DT. Unlike a fixed step
    // with a leftover accumulator this never aliases against 90/120/144 Hz displays.
    if (dt > 0) {
      const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / MAX_STEP_DT - 1e-6));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) this.physicsStep(h);
    }

    this.renderFrame(dt);
  }

  private updateInputs(now: number, ms: number): void {
    const s = this.settings;
    const [A, B] = this.anchors;
    const S = this.S;
    const fusion = this.mode === 'fusion';

    if (this.input === 'mouse') {
      this.mouse.fusionMode = fusion;
      this.mouse.ensurePlaced(this.cssW, this.cssH, S);
      if (this.mouse.aInside) A.push(this.mouse.aX / S, this.mouse.aY / S, 1, now, s);
      else A.missing(now, s);
      if (fusion) B.push(this.mouse.bX / S, this.mouse.bY / S, 1, now, s);
      else B.missing(now, s);
      this.mouse.bHandleX = B.x * S;
      this.mouse.bHandleY = B.y * S;
      this.hands = [];
    } else if (this.input === 'script') {
      const cx = this.cssW / S / 2;
      const cy = this.cssH / S / 2;
      const f = scriptFrame(this.script, now - this.scriptT0, cx, cy);
      if (f.aOn) A.push(cx + f.ax, cy + f.ay, 1, now, s);
      else A.missing(now, s);
      if (fusion && f.bOn) B.push(cx + f.bx, cy + f.by, 1, now, s);
      else B.missing(now, s);
      if (f.split && this.fusion.state === 'PURPLE') this.fusion.requestSplit();
      this.hands = [];
    } else if (this.camera.ready && this.tracker.status === 'ready') {
      const raw = this.tracker.detect(this.camera.video, ms, s.trackerMaxFps);
      if (raw) {
        this.hands = this.identity.assign(raw, now);
        const { a, b } = this.resolver.resolve(this.hands, s, now);
        if (a) {
          const p = videoToScreen(a.nx, a.ny, this.rect, s.mirror, this.cssW);
          A.push(p.x / S, p.y / S, a.confidence, now, s);
        } else A.missing(now, s);
        if (fusion && b) {
          const p = videoToScreen(b.nx, b.ny, this.rect, s.mirror, this.cssW);
          B.push(p.x / S, p.y / S, b.confidence, now, s);
        } else B.missing(now, s);
      }
    }
  }

  /** New anchor after a long absence: spawn the (invisible) body there instead of flying in. */
  private handleReappear(i: number, now: number): void {
    const a = this.anchors[i];
    if (!a.reappeared) return;
    a.reappeared = false;
    const b = this.bodies[i];
    if (b.presence < 0.08) {
      a.clearBlend();
      a.sample(now, this.settings);
      b.teleport(a.x, a.y);
    }
  }

  private updateEffect(dt: number, now: number): void {
    const s = this.settings;
    const [A, B] = this.anchors;
    const [b0, b1] = this.bodies;
    for (const b of this.bodies) {
      b.extAx = b.extAy = 0;
      b.reachGain = 0;
      b.tremble = 0;
      b.stiffnessBoost = 1;
    }
    this.flashTarget[0] = this.flashTarget[1] = 0;
    this.handleReappear(0, now);

    if (this.mode === 'sandbox') {
      this.looks[0].base = PALETTES.purple;
      b0.tx = A.x;
      b0.ty = A.y;
      b0.presenceTarget = A.active ? 1 : 0;
      b1.presenceTarget = 0;
      b1.presence = 0;
      b0.tvx = A.vx;
      b0.tvy = A.vy;
      this.purpleTarget[0] = 0;
      this.sizeTarget[0] = 1;
      b0.compression += (1 - b0.compression) * expAlpha(dt, 0.08);
    } else {
      this.handleReappear(1, now);
      this.looks[0].base = PALETTES.blue;
      this.looks[1].base = PALETTES.red;
      const bothActive = A.active && B.active;
      const d = Math.hypot(A.x - B.x, A.y - B.y);
      const ev = this.fusion.update(dt, d, bothActive, s);
      if (ev === 'release') this.release();
      else if (ev === 'split') this.split();
      this.applyFusionState(dt, d);
    }

    // Presence: quick fade-in, configurable fade-out (the mass evaporates/shrinks).
    for (const b of this.bodies) {
      if (b.presenceTarget > b.presence) b.presence = Math.min(b.presenceTarget, b.presence + dt / 0.22);
      else b.presence = Math.max(b.presenceTarget, b.presence - dt / s.fadeDuration);
    }
    for (let i = 0; i < 2; i++) {
      const look = this.looks[i];
      look.purpleMix += (this.purpleTarget[i] - look.purpleMix) * expAlpha(dt, 0.22);
      look.flash = Math.max(this.flashTarget[i], look.flash * Math.exp(-dt * 3.2));
      const b = this.bodies[i];
      b.sizeScale += (this.sizeTarget[i] - b.sizeScale) * expAlpha(dt, 0.18);
      const R = s.baseRadius * b.sizeScale;
      b.volumeScale = Math.max(0.7, 1 - 0.5 * this.droplets.detachedVolume(i, R));
      look.energy = clamp01(b.speed / 3);
    }
  }

  private applyFusionState(dt: number, d: number): void {
    const s = this.settings;
    const [A, B] = this.anchors;
    const [b0, b1] = this.bodies;
    const st = this.fusion.state;
    const relaxComp = (b: FluidBody) => (b.compression += (1 - b.compression) * expAlpha(dt, 0.06));

    if (st === 'PURPLE') {
      b0.tx = A.x;
      b0.ty = A.y;
      b0.tvx = A.vx;
      b0.tvy = A.vy;
      b0.presenceTarget = A.active ? 1 : 0;
      b1.presenceTarget = 0;
      b1.presence = 0;
      this.purpleTarget[0] = 1;
      this.sizeTarget[0] = s.purpleScale;
      relaxComp(b0);
      // Hand gone long enough for purple to evaporate → silently start over.
      if (!A.active && b0.presence <= 0.001) {
        this.fusion.reset();
        this.purpleTarget[0] = this.looks[0].purpleMix = 0;
        this.sizeTarget[0] = b0.sizeScale = 1;
      }
      return;
    }

    if (st === 'FUSING') {
      const fp = this.fusion.fuseProgress(s);
      const e = easeInOutCubic(fp);
      const mx = B.active ? (A.x + B.x) / 2 : A.x;
      const my = B.active ? (A.y + B.y) / 2 : A.y;
      for (let i = 0; i < 2; i++) {
        const b = this.bodies[i];
        const o = this.bodies[1 - i];
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
    b0.tx = A.x;
    b0.ty = A.y;
    b1.tx = B.x;
    b1.ty = B.y;
    b0.tvx = A.vx;
    b0.tvy = A.vy;
    b1.tvx = B.vx;
    b1.tvy = B.vy;
    b0.presenceTarget = A.active ? 1 : 0;
    b1.presenceTarget = B.active ? 1 : 0;
    this.sizeTarget[0] = this.sizeTarget[1] = 1;
    relaxComp(b0);
    relaxComp(b1);
    const cp = this.fusion.contactProgress(s);
    this.purpleTarget[0] = this.purpleTarget[1] = st === 'CONTACT' ? 0.22 * cp : 0;

    if (st === 'ATTRACTING' || st === 'CONTACT') {
      const k = clamp01(1 - d / s.attractionRadius);
      const dx = b1.x - b0.x;
      const dy = b1.y - b0.y;
      const dl = Math.hypot(dx, dy) || 1;
      const ux = dx / dl;
      const uy = dy / dl;
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
  private release(): void {
    const s = this.settings;
    const [b0, b1] = this.bodies;
    const cx = (b0.x + b1.x) / 2;
    const cy = (b0.y + b1.y) / 2;
    const vx = (b0.vx + b1.vx) / 2;
    const vy = (b0.vy + b1.vy) / 2;
    const dx = cx - b0.x;
    const dy = cy - b0.y;
    b0.x = cx;
    b0.y = cy;
    b0.vx = vx;
    b0.vy = vy;
    for (let i = 0; i < b0.rx.length; i++) {
      b0.rx[i] += dx;
      b0.ry[i] += dy;
    }
    b0.sizeScale = this.sizeTarget[0] = s.purpleScale;
    b0.compression = 0.55;
    b0.radialImpulse(0.9 * s.fusionImpulse);
    b1.presence = b1.presenceTarget = 0;
    this.droplets.reparent(1, 0);
    this.looks[0].purpleMix = this.purpleTarget[0] = 1;
    this.looks[1].purpleMix = this.purpleTarget[1] = 1;
    this.looks[0].flash = 1.2;
    this.shock.x = cx;
    this.shock.y = cy;
    this.shock.t = 0;
    this.shock.strength = s.fusionImpulse;
    // Outward micro-droplets that later get pulled back in.
    const R = s.baseRadius * s.purpleScale;
    const n = s.fusionDroplets;
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2 + (this.rng() - 0.5) * 0.8;
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const sp = s.fusionImpulse * (0.3 + 0.35 * this.rng());
      const r = s.baseRadius * (s.dropletMinSize + (s.dropletMaxSize - s.dropletMinSize) * this.rng() * 0.7);
      this.droplets.spawn(0, cx + ux * R * 0.9, cy + uy * R * 0.9, vx + ux * sp, vy + uy * sp, r, DROPLET_POOL);
    }
  }

  /** Purple splits back into blue (A) and red (B); red flows out of the purple mass. */
  private split(): void {
    const [b0, b1] = this.bodies;
    b1.teleport(b0.x, b0.y);
    b1.vx = b0.vx;
    b1.vy = b0.vy;
    b1.presence = 0.3;
    b1.sizeScale = 0.8;
    this.looks[1].purpleMix = 1;
    this.purpleTarget[0] = this.purpleTarget[1] = 0;
    this.sizeTarget[0] = this.sizeTarget[1] = 1;
    b0.radialImpulse(0.5 * this.settings.fusionImpulse);
  }

  private physicsStep(dt: number): void {
    const s = this.settings;
    const t = this.simTime;
    const fusion = this.mode === 'fusion';
    for (let i = 0; i < 2; i++) {
      const b = this.bodies[i];
      if (b.presence > 0 || b.presenceTarget > 0) b.step(dt, s, t);
    }
    this.droplets.emit(dt, 0, this.bodies[0], s);
    if (fusion && this.fusion.state !== 'PURPLE') this.droplets.emit(dt, 1, this.bodies[1], s);
    this.droplets.update(dt, this.bodies, s);
  }

  private renderFrame(dt: number): void {
    const s = this.settings;
    this.blobs.clear();
    this.bodies[0].writeBlobs(this.blobs, s, 0);
    this.bodies[1].writeBlobs(this.blobs, s, 1);
    this.droplets.writeBlobs(this.blobs, this.bodies);

    const sh = this.shock;
    sh.t += dt;
    const k = clamp01(sh.t / SHOCK_TIME);
    const R = s.baseRadius * s.purpleScale;
    this.renderer.render(
      {
        cssW: this.cssW,
        cssH: this.cssH,
        worldScale: this.S,
        time: this.simTime,
        video: this.input === 'camera' && this.camera.ready ? this.camera.video : null,
        videoRect: this.rect,
        mirror: s.mirror,
        shock: { x: sh.x, y: sh.y, r: R * (1 + 7 * easeOutQuad(k)), strength: k < 1 ? (1 - k) ** 2 * sh.strength : 0 },
      },
      this.blobs,
      this.looks,
      s,
    );

    const ctx = this.octx;
    if (!ctx) return;
    const needOverlay = this.debug || (this.showHandles && this.mode === 'fusion' && this.input === 'mouse');
    if (!needOverlay && !this.overlayDirty) return;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.overlayDirty = needOverlay;
    if (!needOverlay) return;
    drawDebug({
      ctx,
      S: this.S,
      debug: this.debug,
      handles: this.showHandles && this.input === 'mouse',
      fusionMode: this.mode === 'fusion',
      anchors: this.anchors,
      bodies: this.bodies,
      droplets: this.droplets,
      hands: this.hands,
      handToScreen: (nx, ny) => videoToScreen(nx, ny, this.rect, s.mirror, this.cssW),
      settings: s,
      bodyCount: this.mode === 'fusion' ? 2 : 1,
    });
  }
}

const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
