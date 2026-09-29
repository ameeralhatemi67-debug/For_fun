import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './schema';

/** Presets are partial overrides on top of the defaults. */
const PRESET_OVERRIDES: Record<string, Partial<Settings>> = {
  Default: {},
  'Soft jelly': {
    stiffness: 70,
    damping: 7.5,
    surfaceTension: 0.42,
    settleStrength: 0.16,
    accelInfluence: 0.8,
    tailLength: 1.1,
    idleWobble: 0.5,
  },
  'Heavy mercury': {
    stiffness: 160,
    damping: 22,
    mass: 1.6,
    surfaceTension: 0.9,
    settleStrength: 0.55,
    velocityInfluence: 0.06,
    tailLength: 0.45,
    dropletSpeedThreshold: 2.6,
    dropletAccelThreshold: 55,
    idleWobble: 0.18,
  },
  'Wild droplets': {
    dropletSpeedThreshold: 1.1,
    dropletAccelThreshold: 18,
    dropletRate: 30,
    maxDroplets: 24,
    dropletAttraction: 6,
    dropletLifetime: 5,
  },
  'One-hand fusion (small)': {
    anchorMode: 'oneHand',
    baseRadius: 0.045,
    attractionRadius: 0.24,
    mergeRadius: 0.075,
    minContactTime: 0.35,
  },
};

export const PRESET_NAMES = Object.keys(PRESET_OVERRIDES);

export function presetSettings(name: string): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(PRESET_OVERRIDES[name] ?? {}) });
}
