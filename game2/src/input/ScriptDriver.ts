import type { HandInput } from '../tracking/HandPipeline';
import { scriptFrame, TWO_HAND_SCRIPTS, type ScriptFrame, type ScriptHand, type ScriptName } from './ScriptedMotion';
import { SimHand } from './SyntheticHand';

/** Palm length (wrist → middle MCP) of the simulated hand, world units. */
export const SIM_PALM_SIZE = 0.13;

/**
 * Turns scripted virtual-hand frames into landmark hand inputs (ids 1 and 2),
 * with animated finger curls. Shared by the app and the headless tests.
 */
export class ScriptDriver {
  readonly hands = [new SimHand(), new SimHand()] as const;
  lastFrame: ScriptFrame | null = null;

  reset(): void {
    this.hands.forEach((h) => h.snap());
  }

  inputs(
    name: ScriptName,
    t: number,
    dt: number,
    now: number,
    viewW: number,
    viewH: number,
    fusion: boolean,
    ball: { alive: boolean; x: number; y: number; vx: number; vy: number },
  ): HandInput[] {
    const cx = viewW / 2;
    const cy = viewH / 2;
    const f = scriptFrame(name, t, cx, cy, { alive: ball.alive, x: ball.x - cx, y: ball.y - cy, vx: ball.vx, vy: ball.vy });
    this.lastFrame = f;
    const out: HandInput[] = [];
    const add = (sh: ScriptHand, hand: SimHand, id: number) => {
      hand.setPose(sh.pose);
      if (sh.press) hand.pressThumb(now, 0.03);
      hand.update(dt, now);
      if (!sh.on) return;
      const lm = hand.write({
        x: cx + sh.x,
        y: cy + sh.y,
        anchor: sh.anchor,
        roll: sh.roll,
        size: SIM_PALM_SIZE * sh.size,
        flip: id === 2,
      });
      out.push({ id, label: id === 1 ? 'Script A' : 'Script B', confidence: 1, lm });
    };
    add(f.a, this.hands[0], 1);
    if (fusion || TWO_HAND_SCRIPTS.includes(name)) add(f.b, this.hands[1], 2);
    return out;
  }
}
