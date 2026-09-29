import { DEFAULT_SETTINGS, PARAMS, sanitizeSettings, type Settings } from './schema';

/**
 * Only the values that differ from the defaults are persisted, so updating the
 * canonical defaults in the repo still reaches every setting the user never touched.
 */
const STORAGE_KEY = 'zerog.settings.v2';

export function loadStoredSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function settingsOverrides(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const p of PARAMS) if (s[p.key] !== DEFAULT_SETTINGS[p.key]) out[p.key] = s[p.key];
  return out as Partial<Settings>;
}

export function storeSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsOverrides(s)));
  } catch {
    /* storage unavailable (private mode) — settings just won't persist */
  }
}
