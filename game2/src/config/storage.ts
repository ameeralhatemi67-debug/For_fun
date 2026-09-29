import { DEFAULT_SETTINGS, PARAMS, sanitizeSettings, type Settings } from './schema';

const STORAGE_KEY = 'zerog.settings.v1';

export function loadStoredSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function storeSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode) — settings just won't persist */
  }
}

/** JSON with keys in schema order, plus a small header so exported files are self-describing. */
export function settingsToJson(s: Settings): string {
  const ordered: Record<string, unknown> = { _format: 'zerog-energy-settings', _version: 1 };
  for (const p of PARAMS) ordered[p.key] = s[p.key];
  return JSON.stringify(ordered, null, 2);
}

export function parseSettingsJson(text: string, base: Settings): { settings: Settings; applied: number } {
  const obj = JSON.parse(text) as Record<string, unknown>;
  const applied = PARAMS.filter((p) => obj[p.key] !== undefined).length;
  return { settings: sanitizeSettings(obj, base), applied };
}
