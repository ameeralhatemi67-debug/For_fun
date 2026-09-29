import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import defaultsFile from '../src/config/default-settings.json';
import { presetSettings, PRESET_NAMES } from '../src/config/presets';
import { DEFAULT_SETTINGS, PARAMS, SETTINGS_SCHEMA_VERSION, UNKNOWN_DEFAULT_KEYS, sanitizeSettings } from '../src/config/schema';
import { canonicalDefaultsJson, parseSettingsFile, settingsFileJson } from '../src/config/settingsFile';
import { settingsOverrides } from '../src/config/storage';

describe('canonical defaults (src/config/default-settings.json)', () => {
  it('contains every schema key with a valid in-range value and nothing else', () => {
    expect(UNKNOWN_DEFAULT_KEYS).toEqual([]);
    const raw = (defaultsFile as { settings: Record<string, unknown> }).settings;
    for (const p of PARAMS) {
      const v = raw[p.key];
      expect(v, p.key).not.toBeUndefined();
      if (p.type === 'bool') expect(typeof v).toBe('boolean');
      else if (p.type === 'select') expect(p.options).toContain(v);
      else {
        expect(typeof v).toBe('number');
        expect(v as number).toBeGreaterThanOrEqual(p.min);
        expect(v as number).toBeLessThanOrEqual(p.max);
        if (p.type === 'int') expect(Number.isInteger(v)).toBe(true);
      }
      expect(DEFAULT_SETTINGS[p.key]).toBe(v);
    }
    expect((defaultsFile as { schemaVersion: number }).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('is byte-identical to what apply-settings would write for the current defaults', () => {
    const text = readFileSync(resolve(__dirname, '../src/config/default-settings.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(text).toBe(canonicalDefaultsJson(DEFAULT_SETTINGS));
  });
});

describe('settings file (Copy / Download / Load)', () => {
  it('has a stable v2 schema whose settings object matches the canonical defaults shape', () => {
    const file = JSON.parse(settingsFileJson(DEFAULT_SETTINGS, { exportedAt: '2026-01-01T00:00:00Z', appVersion: '0.2.0' }));
    expect(file.schemaVersion).toBe(2);
    expect(file.app).toBe('zerog-energy');
    expect(Object.keys(file.settings)).toEqual(PARAMS.map((p) => p.key));
    // An exported file's settings can replace default-settings.json's settings as-is.
    expect(file.settings).toEqual((defaultsFile as { settings: unknown }).settings);
  });

  it('round-trips every value, including after tuning', () => {
    const tuned = sanitizeSettings({ ...DEFAULT_SETTINGS, fingerGap: 1.7, palmRestitution: 0.33, depthScaleEnabled: false, anchorMode: 'twoHands' });
    const { settings, applied, ignored } = parseSettingsFile(settingsFileJson(tuned), DEFAULT_SETTINGS);
    expect(settings).toEqual(tuned);
    expect(applied).toBe(PARAMS.length);
    expect(ignored).toEqual([]);
  });

  it('accepts v1 flat exports and partial objects, clamps and ignores junk', () => {
    const v1 = parseSettingsFile({ _format: 'zerog-energy-settings', _version: 1, stiffness: 99, mergeRadius: 0.2 }, DEFAULT_SETTINGS);
    expect(v1.settings.stiffness).toBe(99);
    expect(v1.ignored).toEqual(['mergeRadius']);
    const partial = parseSettingsFile('{"schemaVersion": 2, "settings": {"shotSpeed": 1000}}', DEFAULT_SETTINGS);
    expect(partial.settings).toEqual({ ...DEFAULT_SETTINGS, shotSpeed: 8 });
  });

  it('rejects newer schemas and malformed v2 files clearly', () => {
    expect(() => parseSettingsFile('{"schemaVersion": 3, "settings": {}}', DEFAULT_SETTINGS)).toThrow(/newer/);
    expect(() => parseSettingsFile('{"schemaVersion": 2}', DEFAULT_SETTINGS)).toThrow(/settings/);
    expect(() => parseSettingsFile('[1,2]', DEFAULT_SETTINGS)).toThrow();
  });

  it('localStorage keeps only overrides, so new repo defaults still reach untouched settings', () => {
    expect(settingsOverrides(DEFAULT_SETTINGS)).toEqual({});
    expect(settingsOverrides({ ...DEFAULT_SETTINGS, fingerGap: 2 })).toEqual({ fingerGap: 2 });
  });

  it('presets only reference known settings', () => {
    for (const n of PRESET_NAMES) expect(Object.keys(presetSettings(n))).toEqual(Object.keys(DEFAULT_SETTINGS));
  });
});
