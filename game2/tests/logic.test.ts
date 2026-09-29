import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PARAMS, sanitizeSettings, type Settings } from '../src/config/schema';
import { parseSettingsJson, settingsToJson } from '../src/config/storage';
import { FusionStateMachine } from '../src/effects/FusionStateMachine';
import { AnchorFilter } from '../src/tracking/AnchorFilter';
import {
  CENTER_SUPPORT,
  FIELD_THRESHOLD,
  RING_DIST,
  RING_SUPPORT,
  kernel,
  ringWeight,
  shapeCalibration,
} from '../src/physics/shape';

const S: Settings = { ...DEFAULT_SETTINGS };

describe('settings schema', () => {
  it('clamps, rounds ints and ignores junk', () => {
    const s = sanitizeSettings({ stiffness: 1e9, secondaryCount: 5.7, mirror: 'yes', anchorMode: 'bogus', nope: 1 });
    expect(s.stiffness).toBe(500);
    expect(s.secondaryCount).toBe(6);
    expect(s.mirror).toBe(DEFAULT_SETTINGS.mirror);
    expect(s.anchorMode).toBe(DEFAULT_SETTINGS.anchorMode);
    expect('nope' in s).toBe(false);
  });
  it('Copy/Load Settings JSON round-trips every value', () => {
    const tweaked = sanitizeSettings({ ...DEFAULT_SETTINGS, stiffness: 77, mirror: false, anchorMode: 'twoHands' });
    const { settings, applied } = parseSettingsJson(settingsToJson(tweaked), DEFAULT_SETTINGS);
    expect(settings).toEqual(tweaked);
    expect(applied).toBe(PARAMS.length);
    // Partial JSON only changes the given keys.
    const partial = parseSettingsJson('{"damping": 9}', tweaked).settings;
    expect(partial).toEqual({ ...tweaked, damping: 9 });
  });
  it('defaults are inside their own ranges', () => {
    for (const p of PARAMS) {
      if (p.type === 'number' || p.type === 'int') {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
  });
});

describe('shape calibration', () => {
  it('rest silhouette sits at radius 1 for any secondary-point count', () => {
    for (const n of [3, 7, 12]) {
      const c = shapeCalibration(n);
      const fieldAt = (r: number, th: number) => {
        let f = kernel(r, CENTER_SUPPORT * c);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const d = Math.hypot(r * Math.cos(th) - RING_DIST * c * Math.cos(a), r * Math.sin(th) - RING_DIST * c * Math.sin(a));
          f += kernel(d, RING_SUPPORT * c, ringWeight(n));
        }
        return f;
      };
      // Inside at 0.85, outside at 1.15, in every direction (n = 3 is visibly lobed).
      for (const th of [0, Math.PI / n, Math.PI / (2 * n)]) {
        expect(fieldAt(0.85, th)).toBeGreaterThan(FIELD_THRESHOLD);
        expect(fieldAt(1.15, th)).toBeLessThan(FIELD_THRESHOLD);
      }
    }
  });
});

describe('AnchorFilter', () => {
  it('predicts briefly, then goes lost, and reacquires without teleporting', () => {
    const a = new AnchorFilter();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      a.push(0.2 + i * 0.01, 0.5, 1, t, S);
      a.sample(t, S);
      t += 1 / 30;
    }
    expect(a.state).toBe('tracking');
    a.missing(t, S);
    a.sample(t, S);
    expect(a.state).toBe('predicting');
    const xPred = a.x;
    t += S.graceDuration + 0.05;
    a.missing(t, S);
    a.sample(t, S);
    expect(a.state).toBe('lost');
    expect(a.x).toBeGreaterThanOrEqual(xPred); // coasted forward
    const before = a.x;
    // Reappears far away: output must start where it was, then blend over.
    a.push(0.9, 0.2, 1, t, S);
    a.sample(t, S);
    expect(Math.abs(a.x - before)).toBeLessThan(1e-6);
    expect(a.reappeared).toBe(true);
    for (let i = 0; i < 60; i++) {
      t += 1 / 60;
      a.push(0.9, 0.2, 1, t, S);
      a.sample(t, S);
    }
    expect(Math.abs(a.x - 0.9)).toBeLessThan(0.01);
  });

  it('treats a single-sample identity jump as a blend', () => {
    const a = new AnchorFilter();
    let t = 0;
    for (let i = 0; i < 10; i++) {
      a.push(0.3, 0.3, 1, t, S);
      a.sample(t, S);
      t += 1 / 30;
    }
    const before = a.x;
    a.push(0.95, 0.3, 1, t, S);
    a.sample(t, S);
    expect(Math.abs(a.x - before)).toBeLessThan(1e-6);
  });
});

describe('FusionStateMachine', () => {
  const dt = 1 / 60;
  const step = (m: FusionStateMachine, d: number, secs: number, both = true) => {
    const seen = new Set<string>();
    for (let i = 0; i < Math.round(secs / dt); i++) {
      m.update(dt, d, both, S);
      seen.add(m.state);
    }
    return seen;
  };

  it('does not flicker around the attraction threshold', () => {
    const m = new FusionStateMachine();
    step(m, 1, 0.1);
    expect(m.state).toBe('DUAL');
    let changes = 0;
    let prev = m.state;
    for (let i = 0; i < 600; i++) {
      const jitter = (i % 2 ? 1 : -1) * S.attractionRadius * S.hysteresis * 0.4;
      m.update(dt, S.attractionRadius + jitter, true, S);
      if (m.state !== prev) changes++;
      prev = m.state;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('a brief crossing does not fuse; holding does, staged through CONTACT and FUSING', () => {
    const m = new FusionStateMachine();
    step(m, 1, 0.1);
    step(m, S.attractionRadius * 0.5, 0.2);
    expect(m.state).toBe('ATTRACTING');
    step(m, S.mergeRadius * 0.5, S.minContactTime * 0.5);
    expect(m.state).toBe('CONTACT');
    step(m, S.mergeRadius * 2, 0.1);
    expect(m.state).toBe('ATTRACTING'); // pulled apart before contact time completed
    const seen = step(m, S.mergeRadius * 0.5, S.minContactTime + S.compressionDuration + 0.2);
    expect(seen.has('CONTACT') && seen.has('FUSING')).toBe(true);
    expect(m.state).toBe('PURPLE');
  });

  it('split starts a cooldown and requires re-separation before fusing again', () => {
    const m = new FusionStateMachine();
    step(m, 1, 0.1);
    step(m, S.mergeRadius * 0.5, 2);
    expect(m.state).toBe('PURPLE');
    m.requestSplit();
    step(m, S.mergeRadius * 0.5, S.fusionCooldown + 1);
    expect(m.state).toBe('DUAL'); // still close together, but not re-armed
    step(m, S.attractionRadius * 2, 0.1);
    step(m, S.mergeRadius * 0.5, S.minContactTime + S.compressionDuration + 0.5);
    expect(m.state).toBe('PURPLE');
  });

  it('losing an anchor aborts an approaching fusion', () => {
    const m = new FusionStateMachine();
    step(m, 1, 0.1);
    step(m, S.mergeRadius * 0.5, 0.2);
    step(m, S.mergeRadius * 0.5, 0.05, false);
    expect(m.state).toBe('IDLE');
  });
});
