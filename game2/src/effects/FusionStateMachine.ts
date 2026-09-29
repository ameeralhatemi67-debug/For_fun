import type { Settings } from '../config/schema';
import { clamp01 } from '../utils/math';

export type FusionState = 'IDLE' | 'DUAL' | 'ATTRACTING' | 'CONTACT' | 'FUSING' | 'PURPLE' | 'RECOVERING';
export type FusionEvent = 'none' | 'fuseStart' | 'release' | 'split';

/**
 * Pure fusion logic (no rendering, no physics) so it can be unit-tested.
 *
 *   IDLE → DUAL → ATTRACTING → CONTACT → FUSING → PURPLE → (split) RECOVERING → DUAL
 *
 * Entry thresholds are the configured radii; exit thresholds are larger by
 * `hysteresis` so jitter around a boundary cannot flicker the state. After a
 * split the pair must separate beyond the attraction exit radius (re-arm) and
 * the cooldown must elapse before a new fusion can start.
 */
export class FusionStateMachine {
  state: FusionState = 'IDLE';
  stateTime = 0;
  contactTime = 0;
  cooldown = 0;
  armed = true;
  private splitRequested = false;

  reset(): void {
    this.state = 'IDLE';
    this.stateTime = 0;
    this.contactTime = 0;
    this.cooldown = 0;
    this.armed = true;
    this.splitRequested = false;
  }

  requestSplit(): void {
    this.splitRequested = true;
  }

  contactProgress(s: Settings): number {
    if (this.state === 'CONTACT') return clamp01(this.contactTime / Math.max(1e-3, s.minContactTime));
    return this.state === 'FUSING' || this.state === 'PURPLE' ? 1 : 0;
  }

  fuseProgress(s: Settings): number {
    if (this.state === 'FUSING') return clamp01(this.stateTime / s.compressionDuration);
    return this.state === 'PURPLE' ? 1 : 0;
  }

  private go(next: FusionState): void {
    this.state = next;
    this.stateTime = 0;
  }

  update(dt: number, distance: number, bothActive: boolean, s: Settings): FusionEvent {
    const attractExit = s.attractionRadius * (1 + s.hysteresis);
    const mergeExit = s.mergeRadius * (1 + s.hysteresis);
    this.stateTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (bothActive && distance > attractExit) this.armed = true;
    const split = this.splitRequested;
    this.splitRequested = false;

    switch (this.state) {
      case 'IDLE':
        if (bothActive) this.go('DUAL');
        break;
      case 'DUAL':
        if (!bothActive) this.go('IDLE');
        else if (this.armed && this.cooldown <= 0 && distance < s.attractionRadius) this.go('ATTRACTING');
        break;
      case 'ATTRACTING':
        if (!bothActive) this.go('IDLE');
        else if (distance > attractExit) this.go('DUAL');
        else if (distance < s.mergeRadius) {
          this.contactTime = 0;
          this.go('CONTACT');
        }
        break;
      case 'CONTACT':
        if (!bothActive) this.go('IDLE');
        else if (distance > mergeExit) this.go('ATTRACTING');
        else {
          this.contactTime += dt;
          if (this.contactTime >= s.minContactTime) {
            this.go('FUSING');
            return 'fuseStart';
          }
        }
        break;
      case 'FUSING':
        if (this.stateTime >= s.compressionDuration) {
          this.go('PURPLE');
          return 'release';
        }
        break;
      case 'PURPLE':
        if (split || (s.autoSplitAfter > 0 && this.stateTime >= s.autoSplitAfter)) {
          this.go('RECOVERING');
          this.cooldown = s.fusionCooldown;
          this.armed = false;
          return 'split';
        }
        break;
      case 'RECOVERING':
        if (this.stateTime >= 0.5 && this.cooldown <= 0) this.go(bothActive ? 'DUAL' : 'IDLE');
        break;
    }
    return 'none';
  }
}
