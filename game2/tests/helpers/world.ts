import { DEFAULT_SETTINGS, type Settings } from '../../src/config/schema';
import { Simulation, type Mode } from '../../src/effects/Simulation';
import { ScriptDriver, SIM_PALM_SIZE } from '../../src/input/ScriptDriver';
import type { ScriptName } from '../../src/input/ScriptedMotion';
import { SimHand, type SimPose } from '../../src/input/SyntheticHand';
import { HandPipeline, type HandInput } from '../../src/tracking/HandPipeline';

export interface SimHandSpec {
  id: number;
  pose: SimPose;
  x: number;
  y: number;
  anchor?: 'indexTip' | 'palm';
  roll?: number;
  size?: number;
  flip?: boolean;
  press?: boolean;
}

/** Headless engine: HandPipeline → Simulation with the app's substepping, no DOM. */
export class World {
  readonly sim = new Simulation();
  readonly pipe = new HandPipeline();
  readonly driver = new ScriptDriver();
  readonly simHands = new Map<number, SimHand>();
  t = 0;
  scriptT0 = 0;
  readonly viewW = 4 / 3;
  readonly viewH = 1;

  constructor(settings: Partial<Settings> = {}, mode: Mode = 'sandbox') {
    this.sim.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.sim.setMode(mode);
    this.sim.viewW = this.viewW;
    this.sim.viewH = this.viewH;
  }

  get s(): Settings {
    return this.sim.settings;
  }
  get body() {
    return this.sim.bodies[0];
  }

  /** One frame with the given hand inputs (null = no new tracker result). */
  tick(dt: number, inputs: HandInput[] | null): void {
    this.t += dt;
    this.pipe.beginTick();
    this.pipe.update(inputs, this.t, this.s);
    this.sim.update(dt, this.t, this.pipe.hands, inputs !== null);
    const steps = Math.max(1, Math.ceil(dt / (1 / 240) - 1e-6));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.sim.step(h, this.t - dt + h * (i + 1));
  }

  /** Frame with synthetic hands (animated curls, like mouse mode). */
  tickHands(dt: number, specs: SimHandSpec[]): void {
    const inputs: HandInput[] = [];
    for (const sp of specs) {
      let hand = this.simHands.get(sp.id);
      if (!hand) {
        hand = new SimHand();
        hand.setPose(sp.pose);
        hand.snap();
        this.simHands.set(sp.id, hand);
      }
      hand.setPose(sp.pose);
      if (sp.press) hand.pressThumb(this.t + dt, 0.03);
      hand.update(dt, this.t + dt);
      const lm = hand.write({
        x: sp.x,
        y: sp.y,
        anchor: sp.anchor ?? 'indexTip',
        roll: sp.roll ?? 0,
        size: SIM_PALM_SIZE * (sp.size ?? 1),
        flip: sp.flip,
      });
      inputs.push({ id: sp.id, label: `T${sp.id}`, confidence: 1, lm: Float64Array.from(lm) });
    }
    this.tick(dt, inputs);
  }

  /** Run hands for `seconds` at 60 Hz; `specs(t)` gives the hands at time t (relative to the start). */
  run(seconds: number, specs: (t: number) => SimHandSpec[], onFrame?: (w: World, t: number) => void): void {
    const t0 = this.t;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) {
      this.tickHands(1 / 60, specs(this.t - t0));
      onFrame?.(this, this.t - t0);
    }
  }

  startScript(): void {
    this.scriptT0 = this.t;
    this.driver.reset();
  }

  /** Run one of the app's scripted motions for `seconds`. */
  runScript(name: ScriptName, seconds: number, onFrame?: (w: World, t: number) => void): void {
    const n = Math.round(seconds * 60);
    const dt = 1 / 60;
    for (let i = 0; i < n; i++) {
      const now = this.t + dt;
      const inputs = this.driver.inputs(name, now - this.scriptT0, dt, now, this.viewW, this.viewH, this.sim.mode === 'fusion', this.body);
      if (this.driver.lastFrame?.split && this.sim.fusion.state === 'PURPLE') this.sim.requestSplit();
      this.tick(dt, inputs);
      onFrame?.(this, now - this.scriptT0);
    }
  }
}
