import { CameraController, coverRect, videoToScreen, type CoverRect } from '../camera/CameraController';
import { DEFAULT_SETTINGS, type Settings } from '../config/schema';
import { MouseInput } from '../input/MouseInput';
import { ScriptDriver, SIM_PALM_SIZE } from '../input/ScriptDriver';
import type { ScriptName } from '../input/ScriptedMotion';
import { SimHand, type SimPose } from '../input/SyntheticHand';
import { BlobBuffer } from '../physics/blobBuffer';
import { drawDebug } from '../render/DebugDraw';
import { PALETTES, Renderer, type BodyLook } from '../render/Renderer';
import { HandIdentity } from '../tracking/HandIdentity';
import { HandPipeline, type HandInput } from '../tracking/HandPipeline';
import { HandTracker } from '../tracking/HandTracker';
import { newLandmarks } from '../tracking/handModel';
import { clamp, clamp01, expAlpha } from '../utils/math';
import type { FusionState } from './FusionStateMachine';
import { Simulation, type Mode } from './Simulation';

export type { Mode } from './Simulation';
export type InputSource = 'mouse' | 'camera' | 'script';
/** Gesture the mouse's simulated hand makes (camera mode uses real gestures). */
export type MouseGesture = 'TRACK' | 'PALM' | 'GUN';

export interface HandStat {
  id: number;
  gesture: string;
  raw: string;
  fingers: string;
  thumb: string;
  depth: string;
}

export interface EngineStats {
  fps: number;
  trackerFps: number;
  effectState: string;
  fusionState: FusionState | '-';
  anchorA: string;
  anchorB: string;
  confidence: number;
  distance: number;
  surfaceGap: number;
  neck: number;
  droplets: number;
  speed: number;
  deformation: number;
  aspect: number;
  handsMode: string;
  cameraStatus: string;
  trackerStatus: string;
  message: string;
  control: string;
  depthScale: number;
  hands: HandStat[];
  counters: string;
}

const MAX_STEP_DT = 1 / 240;
const MAX_SUBSTEPS = 16;
const SHOCK_TIME = 0.55;

/**
 * The engine shell: input sources → HandPipeline → Simulation → Renderer.
 * It owns the render loop; React only drives settings/mode and reads stats.
 */
export class EffectController {
  settings: Settings = { ...DEFAULT_SETTINGS };
  input: InputSource = 'mouse';
  script: ScriptName = 'circle';
  mouseGesture: MouseGesture = 'TRACK';
  debug = false;
  showHandles = true;
  /** Slow-motion factor for inspecting motion (1 = real time). Everything runs on this clock. */
  timeScale = 1;
  message = '';

  readonly sim = new Simulation();
  readonly pipeline = new HandPipeline();
  readonly renderer = new Renderer();
  readonly overlay = document.createElement('canvas');
  readonly camera = new CameraController();
  readonly tracker = new HandTracker();
  readonly mouse = new MouseInput();
  private identity = new HandIdentity();
  private simHands = [new SimHand(), new SimHand()] as const;
  private scriptDriver = new ScriptDriver();
  private blobs = new BlobBuffer();
  private looks: [BodyLook, BodyLook] = [newLook(), newLook()];

  private container: HTMLElement | null = null;
  private octx: CanvasRenderingContext2D | null = null;
  private resizeObs: ResizeObserver | null = null;
  private raf = 0;
  private lastTime = -1;
  /** Scaled clock (s) used by anchors, scripts and physics. */
  private clock = 0;
  private fps = 60;
  private scriptT0 = 0;
  private rect: CoverRect = { x: 0, y: 0, w: 1, h: 1 };
  private overlayDirty = true;
  private lastClicks = 0;
  private pendingFire = false;
  private mouseTilt = 0;
  private mousePrevX = -1;
  private gunRoll = Math.PI / 2;
  cssW = 1;
  cssH = 1;
  /** CSS px per world unit (= shorter viewport side). */
  S = 1;

  get mode(): Mode {
    return this.sim.mode;
  }
  get anchors() {
    return this.sim.anchors;
  }
  get bodies() {
    return this.sim.bodies;
  }
  get fusion() {
    return this.sim.fusion;
  }
  get droplets() {
    return this.sim.droplets;
  }

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
    this.sim.settings = s;
    if (prq) this.resize();
  }

  setMode(m: Mode): void {
    if (m === this.sim.mode) return;
    this.sim.setMode(m);
    this.resetEffect();
  }

  setScript(name: ScriptName): void {
    this.script = name;
    this.scriptT0 = this.clock;
    this.resetEffect();
  }

  setMouseGesture(g: MouseGesture): void {
    this.mouseGesture = g;
  }

  /** Space / click fallback: fire the handgun (thumb press for simulated hands). */
  fire(): void {
    this.pendingFire = true;
  }

  resetDepthBaseline(): void {
    this.pipeline.resetDepthBaseline();
    this.mouse.simDepth = 1;
  }

  async setInput(src: InputSource): Promise<void> {
    this.input = src;
    this.message = '';
    this.scriptT0 = this.clock;
    this.pipeline.reset();
    this.anchors[0].reset();
    this.anchors[1].reset();
    if (src === 'camera') {
      try {
        await this.camera.start();
        this.setMessage('Loading hand tracker…', 60);
        await this.tracker.init();
        this.setMessage('Point your index finger at the screen. Open your hand to push, thumb-up to aim.', 5);
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
    this.sim.reset();
    this.pipeline.reset();
    this.identity.reset();
    this.mouse.resetPlacement();
    this.simHands.forEach((h) => h.snap());
    this.scriptDriver.reset();
  }

  requestSplit(): void {
    this.sim.requestSplit();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.canvas;
  }

  getStats(): EngineStats {
    const sim = this.sim;
    const [A, B] = sim.anchors;
    const b0 = sim.bodies[0];
    const fusion = sim.mode === 'fusion';
    let effectState: string;
    if (fusion) effectState = sim.fusion.state;
    else if (!b0.alive) effectState = A.active ? 'POINT TO SPAWN' : 'IDLE';
    else if (b0.spawning) effectState = 'SPAWNING';
    else if (b0.control !== 'ANCHORED') effectState = b0.control;
    else if (A.state === 'predicting') effectState = 'PREDICTING';
    else if (A.state === 'lost') effectState = 'FADING';
    else effectState = 'TRACKING';
    const c = sim.counters;
    return {
      fps: this.fps,
      trackerFps: this.input === 'camera' ? this.tracker.fps : 0,
      effectState,
      fusionState: fusion ? sim.fusion.state : '-',
      anchorA: A.state,
      anchorB: fusion ? B.state : '-',
      confidence: A.confidence,
      distance: fusion ? sim.centerDistance : 0,
      surfaceGap: fusion ? sim.surfaceGap : NaN,
      neck: sim.neck,
      droplets: sim.droplets.activeCount,
      speed: b0.speed,
      deformation: b0.deformationAmount(this.settings),
      aspect: b0.aspectAmount(this.settings),
      handsMode: fusion ? (sim.twoHandMode ? 'two hands' : 'one hand') : '-',
      cameraStatus: this.camera.status,
      trackerStatus: this.tracker.status,
      message: performance.now() < this.messageUntil ? this.message : '',
      control: sim.bodies
        .slice(0, sim.bodyCount)
        .map((b) => (b.alive ? b.control : 'none'))
        .join(' / '),
      depthScale: b0.depthScale,
      hands: this.pipeline.hands.map((h) => {
        const r = h.reading;
        const fs = (k: number) => (r.open[k] ? 'open' : 'closed');
        return {
          id: h.id,
          gesture: h.visible ? h.gesture : `${h.gesture} (lost)`,
          raw: r.raw,
          fingers: `I ${fs(1)} M ${fs(2)} R ${fs(3)} P ${fs(4)}`,
          thumb: `${r.thumbArmed ? 'armed' : 'folded'} ${r.thumbOpen.toFixed(2)}`,
          depth: `${h.palmSize.toFixed(3)}u rel ${h.depthRel.toFixed(2)} → ×${h.depthScale.toFixed(2)}`,
        };
      }),
      counters: `spawn ${c.spawns} shot ${c.shots} hit ${c.palmHits} recap ${c.recaptures} fuse ${c.fusions}`,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  private resize(): void {
    if (!this.container) return;
    this.cssW = Math.max(1, this.container.clientWidth);
    this.cssH = Math.max(1, this.container.clientHeight);
    this.S = Math.min(this.cssW, this.cssH);
    this.sim.viewW = this.cssW / this.S;
    this.sim.viewH = this.cssH / this.S;
    this.renderer.resize(this.cssW, this.cssH, this.settings.maxPixelRatio);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(this.cssW * dpr);
    this.overlay.height = Math.round(this.cssH * dpr);
    this.overlay.style.width = `${this.cssW}px`;
    this.overlay.style.height = `${this.cssH}px`;
    this.octx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayDirty = true;
  }

  private frame = (ms: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.frozen) {
      // Keep presenting the frozen frame (the drawing buffer is not preserved).
      this.lastTime = ms / 1000;
      this.renderFrame(0);
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
    const now = this.clock;
    if (this.input === 'camera' && this.camera.ready) {
      this.rect = coverRect(this.camera.video.videoWidth, this.camera.video.videoHeight, this.cssW, this.cssH);
    }
    this.pipeline.beginTick();
    const inputs = this.collectHands(dt, now, ms);
    this.pipeline.update(inputs, now, this.settings);
    if (this.pendingFire && inputs !== null) {
      // Camera / script: developer fallback fires a hand that is in the handgun pose (if any).
      const h = this.pipeline.hands.find((hh) => hh.visible && hh.fresh && hh.gesture === 'HANDGUN');
      if (h) h.forceFire = true;
      this.pendingFire = false;
    }
    this.sim.update(dt, now, this.pipeline.hands, inputs !== null);

    // Split the frame into equal substeps no larger than MAX_STEP_DT. Unlike a fixed step
    // with a leftover accumulator this never aliases against 90/120/144 Hz displays.
    if (dt > 0) {
      const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / MAX_STEP_DT - 1e-6));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) this.sim.step(h, now - dt + h * (i + 1));
    }
    this.renderFrame(dt);
  }

  /** Hands for this tick (world landmarks), or null when no new tracker result arrived. */
  private collectHands(dt: number, now: number, ms: number): HandInput[] | null {
    const s = this.settings;
    const S = this.S;
    const fusion = this.sim.mode === 'fusion';
    if (this.input === 'mouse') {
      const m = this.mouse;
      const palm = this.mouseGesture === 'PALM';
      m.bEnabled = fusion || palm;
      m.ensurePlaced(this.cssW, this.cssH, S);
      m.bHandleX = m.bEnabled ? m.bX : -1e9;
      m.bHandleY = m.bEnabled ? m.bY : -1e9;
      const [ha, hb] = this.simHands;
      const pose: SimPose = this.mouseGesture;
      ha.setPose(pose);
      hb.setPose(palm ? 'PALM' : 'TRACK');
      if (this.pendingFire || m.clicks !== this.lastClicks) {
        if (m.clicks !== this.lastClicks && pose === 'GUN') ha.pressThumb(now);
        if (this.pendingFire && pose === 'GUN') ha.pressThumb(now);
        this.lastClicks = m.clicks;
        this.pendingFire = false;
      }
      ha.update(dt, now);
      hb.update(dt, now);
      // Virtual wrist lag: moving sideways tilts the pointing finger.
      const ax = m.aX / S;
      const ay = m.aY / S;
      const vx = this.mousePrevX < 0 || dt <= 0 ? 0 : (ax - this.mousePrevX) / dt;
      this.mousePrevX = ax;
      this.mouseTilt += (clamp(vx * 0.12, -0.55, 0.55) - this.mouseTilt) * expAlpha(dt, 0.12);
      let roll = this.mouseTilt;
      if (pose === 'GUN') {
        // Aim at hand B if present, else at the screen center.
        const tx = m.bEnabled ? m.bX / S : this.cssW / S / 2;
        const ty = m.bEnabled ? m.bY / S : this.cssH / S / 2;
        if (Math.hypot(tx - ax, ty - ay) > 0.12) this.gunRoll = Math.atan2(tx - ax, -(ty - ay));
        roll = this.gunRoll;
      }
      const out: HandInput[] = [];
      if (m.aInside) {
        const lm = ha.write({ x: ax, y: ay, anchor: palm ? 'palm' : 'indexTip', roll, size: SIM_PALM_SIZE * m.simDepth });
        out.push({ id: 1, label: 'Sim A', confidence: 1, lm });
      }
      if (m.bEnabled) {
        const lm = hb.write({ x: m.bX / S, y: m.bY / S, anchor: palm ? 'palm' : 'indexTip', roll: palm ? -0.2 : 0, size: SIM_PALM_SIZE, flip: true });
        out.push({ id: 2, label: 'Sim B', confidence: 1, lm });
      }
      return out;
    }
    if (this.input === 'script') {
      const f = this.scriptDriver.inputs(
        this.script,
        now - this.scriptT0,
        dt,
        now,
        this.cssW / S,
        this.cssH / S,
        fusion,
        this.sim.bodies[0],
      );
      if (this.scriptDriver.lastFrame?.split && this.sim.fusion.state === 'PURPLE') this.sim.requestSplit();
      return f;
    }
    if (this.camera.ready && this.tracker.status === 'ready') {
      const raw = this.tracker.detect(this.camera.video, ms, s.trackerMaxFps);
      if (!raw) return null;
      const hands = this.identity.assign(raw, now);
      const zScale = this.rect.w / S;
      return hands.map((h) => {
        const lm = newLandmarks();
        for (let i = 0; i < 21; i++) {
          const p = h.landmarks[i];
          const q = videoToScreen(p.x, p.y, this.rect, s.mirror, this.cssW);
          lm[i * 3] = q.x / S;
          lm[i * 3 + 1] = q.y / S;
          lm[i * 3 + 2] = p.z * zScale;
        }
        return { id: h.id, label: h.label, confidence: h.score, lm };
      });
    }
    return null;
  }

  private renderFrame(_dt: number): void {
    const s = this.settings;
    const sim = this.sim;
    sim.writeBlobs(this.blobs);
    for (let i = 0; i < 2; i++) {
      const L = sim.looks[i];
      const b = sim.bodies[i];
      const look = this.looks[i];
      look.base = PALETTES[L.base];
      look.purpleMix = L.purpleMix;
      look.flash = L.flash;
      look.energy = L.energy;
      look.flowX = b.flowX;
      look.flowY = b.flowY;
      look.radius = b.radius(s);
    }
    const sh = sim.shock;
    const k = clamp01(sh.t / SHOCK_TIME);
    const R = s.baseRadius * s.purpleScale;
    this.renderer.render(
      {
        cssW: this.cssW,
        cssH: this.cssH,
        worldScale: this.S,
        time: this.clock,
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
    const handles = this.showHandles && this.input === 'mouse' && this.mouse.bEnabled;
    const needOverlay = this.debug || handles;
    if (!needOverlay && !this.overlayDirty) return;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.overlayDirty = needOverlay;
    if (!needOverlay) return;
    drawDebug({
      ctx,
      S: this.S,
      debug: this.debug,
      handleB: handles ? { x: this.mouse.bX, y: this.mouse.bY } : null,
      sim,
      hands: this.pipeline.hands,
      now: this.clock,
      settings: s,
    });
  }
}

function newLook(): BodyLook {
  return { base: PALETTES.purple, purpleMix: 0, flash: 0, energy: 0, flowX: 0, flowY: 0, radius: 0.075 };
}

const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
