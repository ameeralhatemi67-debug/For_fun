/**
 * Single source of truth for every tunable value.
 * The control panel, JSON import/export, localStorage persistence and the
 * defaults are all generated from this table.
 *
 * Units: "world units" (u) are fractions of the shorter viewport side,
 * so 1u = full height on a landscape screen, full width on a portrait phone.
 */

export type ParamGroup = 'Tracking' | 'Physics' | 'Shape' | 'Droplets' | 'Fusion' | 'Rendering';

interface BaseDef {
  key: string;
  label: string;
  group: ParamGroup;
  help?: string;
}
export interface NumberDef extends BaseDef {
  type: 'number' | 'int';
  min: number;
  max: number;
  step: number;
  default: number;
}
export interface BoolDef extends BaseDef {
  type: 'bool';
  default: boolean;
}
export interface SelectDef extends BaseDef {
  type: 'select';
  options: readonly string[];
  default: string;
}
export type ParamDef = NumberDef | BoolDef | SelectDef;

const n = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  help?: string,
): NumberDef & { key: K } => ({ type: 'number', group, key, label, min, max, step, default: def, help });
const i = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  min: number,
  max: number,
  def: number,
  help?: string,
): NumberDef & { key: K } => ({ type: 'int', group, key, label, min, max, step: 1, default: def, help });
const b = <K extends string>(group: ParamGroup, key: K, label: string, def: boolean, help?: string): BoolDef & { key: K } => ({
  type: 'bool',
  group,
  key,
  label,
  default: def,
  help,
});
const s = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  options: readonly string[],
  def: string,
  help?: string,
): SelectDef & { key: K } => ({ type: 'select', group, key, label, options, default: def, help });

export const PARAMS = [
  // ── Tracking ──────────────────────────────────────────────────────────────
  b('Tracking', 'mirror', 'Mirror (selfie view)', true, 'Mirror camera image and tracking together.'),
  n('Tracking', 'smoothingMinCutoff', 'Smoothing min cutoff (Hz)', 0.1, 10, 0.1, 2.5,
    'One-Euro filter. Lower = smoother but laggier when the finger is slow.'),
  n('Tracking', 'smoothingBeta', 'Smoothing speed response', 0, 30, 0.5, 8,
    'One-Euro beta. Higher = less lag during fast motion (more jitter passes through).'),
  n('Tracking', 'graceDuration', 'Loss grace / prediction (s)', 0, 1, 0.01, 0.25,
    'How long a lost fingertip keeps moving on its last velocity before being considered lost.'),
  n('Tracking', 'fadeDuration', 'Loss fade-out (s)', 0.1, 3, 0.05, 0.8),
  n('Tracking', 'reacquireTime', 'Reacquire blend (s)', 0.02, 0.8, 0.01, 0.18,
    'Target blends from the old position to the new one instead of teleporting.'),
  n('Tracking', 'jumpThreshold', 'Teleport guard distance (u)', 0.05, 1, 0.01, 0.3,
    'A single-sample jump larger than this is blended like a reacquire.'),
  n('Tracking', 'confidenceThreshold', 'Confidence threshold', 0, 1, 0.01, 0.5),
  n('Tracking', 'trackerMaxFps', 'Tracker max FPS', 5, 60, 1, 30),
  s('Tracking', 'anchorMode', 'Anchor mode (fusion)', ['auto', 'oneHand', 'twoHands'], 'auto',
    'auto = two hands when two are seen (debounced), otherwise index+second finger of one hand.'),
  s('Tracking', 'anchorBFinger', 'One-hand anchor B finger', ['middle', 'thumb', 'pinky'], 'middle'),

  // ── Main physics ──────────────────────────────────────────────────────────
  n('Physics', 'stiffness', 'Spring stiffness', 5, 500, 1, 140,
    'Pull of the fingertip on the fluid center. Higher = tighter follow.'),
  n('Physics', 'damping', 'Spring damping', 0, 60, 0.1, 17.5,
    'Lower = more overshoot. Critical damping ≈ 2·√(stiffness/mass).'),
  n('Physics', 'trailingDrag', 'Trailing drag', 0, 1, 0.01, 0.45,
    'Share of damping against world motion: 0 = catches up with a steadily moving finger, 1 = trails proportional to speed.'),
  n('Physics', 'mass', 'Mass', 0.2, 5, 0.05, 1, 'Divides both forces: heavier = slower, same bounciness.'),
  n('Physics', 'maxLag', 'Max lag (radii)', 0.5, 10, 0.1, 2.8,
    'Beyond this distance the tether stiffens strongly so the mass cannot fall far behind.'),
  n('Physics', 'velocityInfluence', 'Velocity stretch', 0, 0.6, 0.005, 0.12,
    'Elongates the core along its velocity.'),
  n('Physics', 'accelInfluence', 'Acceleration influence', 0, 2, 0.01, 0.3,
    'Extra inertial swing of the surface points (squash/stretch opposite acceleration).'),
  n('Physics', 'fingerAdhesion', 'Finger adhesion (stir)', 0, 40, 0.5, 8,
    'How much finger motion directly stirs the surface. Keeps fast shakes lively even though the core is heavy.'),
  n('Physics', 'settleStrength', 'Settle strength (jelly damping ratio)', 0.02, 1.5, 0.01, 0.3,
    'Damping of the surface wobble. Low = long jelly wobble, high = quickly calm.'),

  // ── Shape ─────────────────────────────────────────────────────────────────
  n('Shape', 'baseRadius', 'Base radius (u)', 0.02, 0.2, 0.001, 0.075),
  n('Shape', 'deformation', 'Deformation strength', 0, 2.5, 0.01, 1,
    'Visual multiplier on how far surface points are drawn from their rest shape.'),
  n('Shape', 'surfaceTension', 'Surface tension', 0, 1, 0.01, 0.62,
    'How hard the surface pulls back to a compact round shape (wobble frequency).'),
  i('Shape', 'secondaryCount', 'Secondary blob points', 3, 12, 7),
  n('Shape', 'tailLength', 'Tail length', 0, 2, 0.01, 0.85, '0 disables the trailing tail.'),
  n('Shape', 'maxStretch', 'Max stretch (radii)', 1, 5, 0.05, 2.6, 'Hard limit against excessive goo.'),
  n('Shape', 'idleWobble', 'Idle wobble amount', 0, 1, 0.01, 0.35),
  n('Shape', 'idleWobbleSpeed', 'Idle wobble speed', 0, 4, 0.01, 0.9),

  // ── Droplets ──────────────────────────────────────────────────────────────
  b('Droplets', 'dropletsEnabled', 'Droplets enabled', true),
  n('Droplets', 'dropletSpeedThreshold', 'Emission speed threshold (u/s)', 0.2, 8, 0.05, 1.7),
  n('Droplets', 'dropletAccelThreshold', 'Emission accel threshold (u/s²)', 2, 250, 1, 30),
  n('Droplets', 'dropletRate', 'Emission rate', 0, 80, 0.5, 16, 'Droplets/second per unit of threshold excess.'),
  i('Droplets', 'maxDroplets', 'Max droplet count', 0, 32, 14),
  n('Droplets', 'dropletMinSize', 'Min droplet size (×radius)', 0.05, 0.8, 0.01, 0.14),
  n('Droplets', 'dropletMaxSize', 'Max droplet size (×radius)', 0.05, 0.9, 0.01, 0.32),
  n('Droplets', 'dropletLifetime', 'Droplet lifetime (s)', 0.3, 10, 0.1, 3.5),
  n('Droplets', 'dropletEjectSpeed', 'Eject speed (u/s)', 0, 3, 0.01, 0.55),
  n('Droplets', 'dropletDrag', 'Droplet drag', 0, 8, 0.05, 1.8),
  n('Droplets', 'dropletFreeTime', 'Free-flight time (s)', 0, 1.5, 0.01, 0.22,
    'Delay before a droplet starts being pulled back.'),
  n('Droplets', 'dropletAttraction', 'Attraction-back strength', 0, 60, 0.5, 10),
  n('Droplets', 'dropletMergeRadius', 'Merge radius (×radius)', 0.2, 2, 0.01, 0.8),

  // ── Fusion ────────────────────────────────────────────────────────────────
  n('Fusion', 'attractionRadius', 'Attraction radius (u)', 0.1, 1.5, 0.01, 0.46),
  n('Fusion', 'attractionStrength', 'Attraction strength', 0, 120, 0.5, 22,
    'Pull between the two centers inside the attraction radius.'),
  n('Fusion', 'reachStrength', 'Reach / deformation strength', 0, 120, 0.5, 34,
    'How strongly the facing surfaces stretch toward each other.'),
  n('Fusion', 'mergeRadius', 'Merge radius (u)', 0.03, 0.6, 0.005, 0.16),
  n('Fusion', 'hysteresis', 'Threshold hysteresis', 0, 0.6, 0.01, 0.18,
    'Exit thresholds are this fraction larger than entry thresholds.'),
  n('Fusion', 'minContactTime', 'Minimum contact time (s)', 0, 2, 0.01, 0.45),
  n('Fusion', 'compressionDuration', 'Compression duration (s)', 0.1, 1.5, 0.01, 0.42),
  n('Fusion', 'fusionImpulse', 'Fusion impulse', 0, 3, 0.01, 1),
  i('Fusion', 'fusionDroplets', 'Fusion micro-droplets', 0, 16, 8),
  n('Fusion', 'fusionCooldown', 'Fusion cooldown (s)', 0, 5, 0.05, 1.2),
  n('Fusion', 'purpleScale', 'Purple size (×radius)', 0.8, 1.8, 0.01, 1.22),
  n('Fusion', 'autoSplitAfter', 'Auto-split after (s, 0 = never)', 0, 30, 0.5, 0),

  // ── Rendering ─────────────────────────────────────────────────────────────
  n('Rendering', 'coreBrightness', 'Core brightness', 0, 3, 0.01, 1.1),
  n('Rendering', 'edgeBrightness', 'Edge brightness', 0, 3, 0.01, 1.15),
  n('Rendering', 'rimWidth', 'Edge width (px)', 0.5, 8, 0.1, 2.2),
  n('Rendering', 'glowIntensity', 'Glow intensity', 0, 2, 0.01, 0.4),
  n('Rendering', 'glowRadius', 'Glow radius (×radius)', 0.2, 3, 0.01, 0.9),
  n('Rendering', 'turbulenceAmount', 'Turbulence amount', 0, 2, 0.01, 1),
  n('Rendering', 'turbulenceSpeed', 'Turbulence speed', 0, 3, 0.01, 0.6),
  n('Rendering', 'refraction', 'Refraction / distortion', 0, 1, 0.01, 0.35),
  n('Rendering', 'bodyOpacity', 'Body opacity', 0.3, 1, 0.01, 0.84),
  n('Rendering', 'backgroundDim', 'Camera dim', 0, 0.8, 0.01, 0.12),
  n('Rendering', 'maxPixelRatio', 'Max pixel ratio (quality)', 0.5, 2, 0.05, 1.5),
] as const satisfies readonly ParamDef[];

type DefOf<K extends string> = Extract<(typeof PARAMS)[number], { key: K }>;
type ValueOf<D> = D extends { type: 'bool' } ? boolean : D extends { type: 'select' } ? string : number;
export type ParamKey = (typeof PARAMS)[number]['key'];
export type Settings = { [K in ParamKey]: ValueOf<DefOf<K>> };

export const PARAM_GROUPS: ParamGroup[] = ['Tracking', 'Physics', 'Shape', 'Droplets', 'Fusion', 'Rendering'];

export const DEFAULT_SETTINGS: Settings = Object.freeze(
  Object.fromEntries(PARAMS.map((p) => [p.key, p.default])),
) as Settings;

/** Merge unknown input onto defaults, clamping numbers and ignoring unknown/invalid keys. */
export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const out = { ...base } as Record<string, unknown>;
  if (!input || typeof input !== 'object') return out as Settings;
  const src = input as Record<string, unknown>;
  for (const p of PARAMS as readonly ParamDef[]) {
    const v = src[p.key];
    if (v === undefined) continue;
    if (p.type === 'bool') {
      if (typeof v === 'boolean') out[p.key] = v;
    } else if (p.type === 'select') {
      if (typeof v === 'string' && p.options.includes(v)) out[p.key] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      let x = Math.min(p.max, Math.max(p.min, v));
      if (p.type === 'int') x = Math.round(x);
      out[p.key] = x;
    }
  }
  return out as Settings;
}
