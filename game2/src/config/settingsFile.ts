/**
 * Settings file format, shared by the app (Copy / Download / Load) and by
 * `scripts/apply-settings.ts`. DOM-free on purpose.
 *
 *   {
 *     "schemaVersion": 2,
 *     "app": "zerog-energy", "exportedAt": "...", "preset": "...",   ← optional metadata
 *     "settings": { ...every tunable value, schema order... }
 *   }
 *
 * The `settings` object has exactly the shape of `src/config/default-settings.json`'s
 * `settings`, so an exported file can become the canonical defaults unchanged.
 */
import { PARAMS, SETTINGS_SCHEMA_VERSION, sanitizeSettings, type Settings } from './schema.ts';

export const SETTINGS_APP_ID = 'zerog-energy';

export interface SettingsFileMeta {
  exportedAt?: string;
  preset?: string;
  appVersion?: string;
}

/** Settings as a plain object with keys in schema order (stable diffs). */
export function orderedSettings(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of PARAMS) out[p.key] = s[p.key];
  return out;
}

/** The downloadable / copyable settings file. */
export function settingsFileJson(s: Settings, meta: SettingsFileMeta = {}): string {
  const file: Record<string, unknown> = { schemaVersion: SETTINGS_SCHEMA_VERSION, app: SETTINGS_APP_ID };
  if (meta.appVersion) file.appVersion = meta.appVersion;
  if (meta.exportedAt) file.exportedAt = meta.exportedAt;
  if (meta.preset) file.preset = meta.preset;
  file.settings = orderedSettings(s);
  return JSON.stringify(file, null, 2) + '\n';
}

/** Exactly what `src/config/default-settings.json` should contain for these settings. */
export function canonicalDefaultsJson(s: Settings): string {
  return JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, settings: orderedSettings(s) }, null, 2) + '\n';
}

export class SettingsFileError extends Error {}

/**
 * Accepts a v2 file (`{schemaVersion: 2, settings: {...}}`), a v1 export
 * (flat object with `_format`/`_version`) or any plain partial object of keys.
 * Unknown keys are ignored and numbers are clamped. Throws on newer schemas.
 */
export function parseSettingsFile(
  input: string | unknown,
  base: Settings,
): { settings: Settings; applied: number; ignored: string[]; schemaVersion: number } {
  const obj = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new SettingsFileError('Settings JSON must be an object.');
  const o = obj as Record<string, unknown>;
  let schemaVersion = 1;
  let values: Record<string, unknown> = o;
  if ('schemaVersion' in o) {
    if (typeof o.schemaVersion !== 'number') throw new SettingsFileError('schemaVersion must be a number.');
    schemaVersion = o.schemaVersion;
    if (schemaVersion > SETTINGS_SCHEMA_VERSION)
      throw new SettingsFileError(
        `Settings schemaVersion ${schemaVersion} is newer than this app supports (${SETTINGS_SCHEMA_VERSION}).`,
      );
    if (schemaVersion >= 2) {
      if (!o.settings || typeof o.settings !== 'object' || Array.isArray(o.settings))
        throw new SettingsFileError('schemaVersion 2 files need a "settings" object.');
      values = o.settings as Record<string, unknown>;
    }
  }
  const known = new Set<string>(PARAMS.map((p) => p.key));
  const meta = new Set(['_format', '_version']);
  const ignored = Object.keys(values).filter((k) => !known.has(k) && !meta.has(k));
  const applied = PARAMS.filter((p) => values[p.key] !== undefined).length;
  return { settings: sanitizeSettings(values, base), applied, ignored, schemaVersion };
}
