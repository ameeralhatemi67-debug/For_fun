/**
 * Every tunable value: label, group, range and help text.
 *
 * The *values* of the defaults live in `default-settings.json` (same shape as
 * a downloaded settings file), so a user's exported JSON can become the repo
 * defaults by replacing that file (or `npm run apply-settings -- file.json`).
 * The control panel, JSON import/export and localStorage persistence are all
 * generated from this table.
 *
 * Units: "world units" (u) are fractions of the shorter viewport side,
 * so 1u = full height on a landscape screen, full width on a portrait phone.
 * "× radius" values are multiples of the current effective body radius.
 *
 * NOTE: imported by `scripts/apply-settings.ts` through Node's type stripping,
 * so keep this file free of non-erasable TypeScript (enums, namespaces…).
 */
import defaultsFile from './default-settings.json' with { type: 'json' };

export const SETTINGS_SCHEMA_VERSION = 2;

export type ParamGroup =
  | 'Tracking'
  | 'Anchor'
  | 'Depth'
  | 'Gestures'
  | 'Physics'
  | 'Shape'
  | 'Droplets'
  | 'Interaction'
  | 'Fusion'
  | 'Rendering';

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

const RAW_DEFAULTS = (defaultsFile as { settings: Record<string, unknown> }).settings;

function rawDefault(key: string): unknown {
  if (!(key in RAW_DEFAULTS)) throw new Error(`src/config/default-settings.json is missing "${key}"`);
  return RAW_DEFAULTS[key];
}
function numDefault(key: string, min: number, max: number, int: boolean): number {
  const v = rawDefault(key);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`default for "${key}" must be a number`);
  const x = Math.min(max, Math.max(min, v));
  return int ? Math.round(x) : x;
}

const n = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  min: number,
  max: number,
  step: number,
  help?: string,
): NumberDef & { key: K } => ({ type: 'number', group, key, label, min, max, step, default: numDefault(key, min, max, false), help });
const i = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  min: number,
  max: number,
  help?: string,
): NumberDef & { key: K } => ({ type: 'int', group, key, label, min, max, step: 1, default: numDefault(key, min, max, true), help });
const b = <K extends string>(group: ParamGroup, key: K, label: string, help?: string): BoolDef & { key: K } => {
  const v = rawDefault(key);
  if (typeof v !== 'boolean') throw new Error(`default for "${key}" must be a boolean`);
  return { type: 'bool', group, key, label, default: v, help };
};
const s = <K extends string>(
  group: ParamGroup,
  key: K,
  label: string,
  options: readonly string[],
  help?: string,
): SelectDef & { key: K } => {
  const v = rawDefault(key);
  if (typeof v !== 'string' || !options.includes(v)) throw new Error(`default for "${key}" must be one of ${options.join('/')}`);
  return { type: 'select', group, key, label, options, default: v, help };
};

export const PARAMS = [
  // ── Tracking ──────────────────────────────────────────────────────────────
  b('Tracking', 'mirror', 'Mirror (selfie view)', 'Mirror camera image and tracking together.'),
  n('Tracking', 'smoothingMinCutoff', 'Smoothing min cutoff (Hz)', 0.1, 10, 0.1,
    'One-Euro filter. Lower = smoother but laggier when the finger is slow.'),
  n('Tracking', 'smoothingBeta', 'Smoothing speed response', 0, 30, 0.5,
    'One-Euro beta. Higher = less lag during fast motion (more jitter passes through).'),
  n('Tracking', 'controlPrediction', 'Control-point prediction', 0, 1, 0.01,
    'How far the anchor extrapolates between tracker samples. 0 = interpolate (one sample late), 1 = full dead-reckoning. The heavy body supplies the visible lag.'),
  n('Tracking', 'graceDuration', 'Loss grace / prediction (s)', 0, 1, 0.01,
    'How long a lost fingertip keeps moving on its last velocity before being considered lost.'),
  n('Tracking', 'fadeDuration', 'Loss fade-out (s)', 0.1, 3, 0.05),
  n('Tracking', 'reacquireTime', 'Reacquire blend (s)', 0.02, 0.8, 0.01,
    'Target blends from the old position to the new one instead of teleporting.'),
  n('Tracking', 'jumpThreshold', 'Teleport guard distance (u)', 0.05, 1, 0.01,
    'A single-sample jump larger than this is blended like a reacquire.'),
  n('Tracking', 'confidenceThreshold', 'Confidence threshold', 0, 1, 0.01),
  n('Tracking', 'trackerMaxFps', 'Tracker max FPS', 5, 60, 1),
  s('Tracking', 'anchorMode', 'Anchor mode (fusion)', ['auto', 'oneHand', 'twoHands'],
    'auto = two hands when two are seen (debounced), otherwise index+second finger of one hand.'),
  s('Tracking', 'anchorBFinger', 'One-hand anchor B finger', ['middle', 'thumb', 'pinky']),

  // ── Anchor / spawn ────────────────────────────────────────────────────────
  n('Anchor', 'fingerGap', 'Finger gap (× radius)', 0, 3, 0.01,
    'Air gap between the fingertip and the near surface of the liquid, along the finger direction.'),
  n('Anchor', 'fingerDirSmoothing', 'Finger direction smoothing (s)', 0, 0.4, 0.005,
    'Time constant of the pointing-direction filter. Higher = steadier offset, slower to turn.'),
  n('Anchor', 'spawnGrowDuration', 'Spawn grow duration (s)', 0.05, 2.5, 0.01,
    'A new body condenses in place from an invisible dot over this time.'),
  n('Anchor', 'tetherDeformInfluence', 'Tether deformation', 0, 2, 0.01,
    'How strongly the liquid leans/stretches toward its (offset) anchor when it lags behind.'),

  // ── Depth ─────────────────────────────────────────────────────────────────
  b('Depth', 'depthScaleEnabled', 'Depth scaling', 'Closer hand → bigger liquid, farther → smaller.'),
  n('Depth', 'depthScaleStrength', 'Depth scale strength', 0, 2, 0.01,
    'scale = 1 + strength·(palmSize/baseline − 1), before clamping.'),
  n('Depth', 'depthMinScale', 'Depth min scale', 0.4, 1, 0.01),
  n('Depth', 'depthMaxScale', 'Depth max scale', 1, 2.5, 0.01),
  n('Depth', 'depthSmoothing', 'Depth smoothing (s)', 0.02, 2, 0.01,
    'Time constant of the depth scale (after median spike rejection).'),

  // ── Gestures ──────────────────────────────────────────────────────────────
  n('Gestures', 'fingerOpenAbove', 'Finger open above', 0.3, 0.95, 0.01,
    'Normalized extension (0 = fist, 1 = straight) above which a finger counts as open.'),
  n('Gestures', 'fingerClosedBelow', 'Finger closed below', 0.05, 0.7, 0.01,
    'Extension below which a finger counts as closed. The gap between both thresholds is hysteresis.'),
  n('Gestures', 'gestureEnterDwell', 'Gesture enter dwell (s)', 0, 0.6, 0.01,
    'A new pose must be seen this long before it becomes the active gesture.'),
  n('Gestures', 'gestureExitDwell', 'Gesture exit dwell (s)', 0, 0.6, 0.01,
    'The active gesture survives mismatching frames for this long (hysteresis against flicker).'),
  n('Gestures', 'gunGestureDwell', 'Handgun dwell (s)', 0, 0.6, 0.01, 'Enter dwell for the handgun pose.'),
  n('Gestures', 'thumbTriggerThreshold', 'Thumb trigger threshold', 0.1, 1, 0.01,
    'Thumb-tip distance from the index base (× palm size). Folding below fires; must extend 1.35× above to re-arm.'),

  // ── Main physics ──────────────────────────────────────────────────────────
  n('Physics', 'stiffness', 'Spring stiffness', 5, 500, 1,
    'Pull of the anchor on the fluid center. Higher = tighter follow.'),
  n('Physics', 'damping', 'Spring damping', 0, 60, 0.1,
    'Lower = more overshoot. Critical damping ≈ 2·√(stiffness/mass).'),
  n('Physics', 'trailingDrag', 'Trailing drag', 0, 1, 0.01,
    'Share of damping against world motion: 0 = catches up with a steadily moving finger, 1 = trails proportional to speed.'),
  n('Physics', 'mass', 'Mass', 0.2, 5, 0.05, 'Divides both forces: heavier = slower, same bounciness.'),
  n('Physics', 'maxLag', 'Max lag (radii)', 0.5, 10, 0.1,
    'Beyond this distance the tether stiffens strongly so the mass cannot fall far behind.'),
  n('Physics', 'velocityInfluence', 'Velocity stretch', 0, 0.8, 0.005,
    'Elongates the core along its velocity (saturating, area-preserving).'),
  n('Physics', 'accelInfluence', 'Acceleration influence', 0, 2, 0.01,
    'Extra inertial swing of the surface points (squash/stretch opposite acceleration).'),
  n('Physics', 'fingerAdhesion', 'Finger adhesion (stir)', 0, 40, 0.5,
    'How much anchor motion directly stirs the surface. Keeps fast shakes lively even though the core is heavy.'),
  n('Physics', 'settleStrength', 'Settle strength (jelly damping ratio)', 0.02, 1.5, 0.01,
    'Damping of the surface wobble. Low = long jelly wobble, high = quickly calm.'),

  // ── Shape ─────────────────────────────────────────────────────────────────
  n('Shape', 'baseRadius', 'Base radius (u)', 0.02, 0.2, 0.001),
  n('Shape', 'deformation', 'Deformation strength', 0, 2.5, 0.01,
    'Visual multiplier on how far surface points are drawn from their rest shape.'),
  n('Shape', 'surfaceTension', 'Surface tension', 0, 1, 0.01,
    'How hard the surface pulls back to a compact round shape (wobble frequency).'),
  i('Shape', 'secondaryCount', 'Secondary blob points', 6, 12,
    'Surface points. Fewer than 6 reads lobed with the ring-dominant v0.2 layout.'),
  n('Shape', 'tailLength', 'Tail length', 0, 2, 0.01, '0 disables the trailing tail.'),
  n('Shape', 'maxStretch', 'Max stretch (radii)', 1, 5, 0.05, 'Hard limit against excessive goo.'),
  n('Shape', 'idleWobble', 'Idle wobble amount', 0, 1, 0.01),
  n('Shape', 'idleWobbleSpeed', 'Idle wobble speed', 0, 4, 0.01),

  // ── Droplets ──────────────────────────────────────────────────────────────
  b('Droplets', 'dropletsEnabled', 'Droplets enabled'),
  n('Droplets', 'dropletSpeedThreshold', 'Emission speed threshold (u/s)', 0.2, 8, 0.05),
  n('Droplets', 'dropletAccelThreshold', 'Emission accel threshold (u/s²)', 2, 250, 1),
  n('Droplets', 'dropletRate', 'Emission rate', 0, 80, 0.5, 'Droplets/second per unit of threshold excess.'),
  i('Droplets', 'maxDroplets', 'Max droplet count', 0, 32),
  n('Droplets', 'dropletMinSize', 'Min droplet size (×radius)', 0.05, 0.8, 0.01),
  n('Droplets', 'dropletMaxSize', 'Max droplet size (×radius)', 0.05, 0.9, 0.01),
  n('Droplets', 'dropletLifetime', 'Droplet lifetime (s)', 0.3, 10, 0.1),
  n('Droplets', 'dropletEjectSpeed', 'Eject speed (u/s)', 0, 3, 0.01),
  n('Droplets', 'dropletDrag', 'Droplet drag', 0, 8, 0.05),
  n('Droplets', 'dropletFreeTime', 'Free-flight time (s)', 0, 1.5, 0.01,
    'Delay before a droplet starts being pulled back.'),
  n('Droplets', 'dropletAttraction', 'Attraction-back strength', 0, 60, 0.5),
  n('Droplets', 'dropletMergeRadius', 'Merge radius (×radius)', 0.2, 2, 0.01),

  // ── Interaction: free ball, palm push, recapture, shot ────────────────────
  n('Interaction', 'freeDrag', 'Free drag (1/s)', 0, 3, 0.01,
    'Air drag of a free/shot ball. 0 = perfect zero-g drift.'),
  n('Interaction', 'palmColliderPadding', 'Palm collider padding (× radius)', 0, 1.5, 0.01,
    'Expands the palm collider so contact feels forgiving.'),
  b('Interaction', 'palmIncludeFingers', 'Palm collider includes open fingers',
    'Adds the PIP joints of open fingers to the palm polygon (whole open hand pushes).'),
  n('Interaction', 'palmImpulseStrength', 'Palm impulse strength', 0, 3, 0.01,
    'Multiplier on the bounce impulse (1 = physical).'),
  n('Interaction', 'palmRestitution', 'Palm restitution', 0, 1.2, 0.01,
    'Bounciness of the palm hit (0 = dead stop, 1 = elastic).'),
  n('Interaction', 'palmFriction', 'Palm friction', 0, 1, 0.01,
    'Share of the tangential sliding speed removed on impact.'),
  n('Interaction', 'palmVelocityInfluence', 'Palm velocity influence', 0, 2, 0.01,
    'How much of the palm’s own velocity is transferred on contact.'),
  n('Interaction', 'palmSteer', 'Palm push steering', 0, 2, 0.01,
    'A palm moving into the ball bends the bounce toward its own motion. 0 = pure contact normal.'),
  n('Interaction', 'recaptureStrength', 'Recapture strength', 5, 400, 1,
    'Magnetic spring pulling a free ball back to the finger anchor.'),
  n('Interaction', 'recaptureDamping', 'Recapture damping', 0, 60, 0.1),
  n('Interaction', 'recaptureDistance', 'Recapture done distance (× radius)', 0.1, 4, 0.01,
    'Within this distance the recaptured ball becomes normally anchored again.'),
  n('Interaction', 'shotSpeed', 'Shot speed (u/s)', 0.3, 8, 0.05),
  n('Interaction', 'shotHandVelocityInfluence', 'Shot hand-velocity influence', 0, 2, 0.01,
    'Share of the hand’s own velocity added to the shot.'),
  n('Interaction', 'shotCooldown', 'Shot cooldown (s)', 0, 3, 0.01),
  n('Interaction', 'freeBoundsMargin', 'Off-screen margin (u)', 0, 1.5, 0.01,
    'A free/shot ball this far outside the view counts as off-screen.'),
  n('Interaction', 'offscreenDespawnDelay', 'Off-screen despawn delay (s)', 0, 5, 0.05),

  // ── Fusion ────────────────────────────────────────────────────────────────
  n('Fusion', 'attractionRadius', 'Attraction radius (u)', 0.1, 1.5, 0.01,
    'Body-center distance at which blue and red start to attract.'),
  n('Fusion', 'attractionStrength', 'Attraction strength', 0, 120, 0.5,
    'Pull between the two centers inside the attraction radius.'),
  n('Fusion', 'reachStrength', 'Reach / deformation strength', 0, 120, 0.5,
    'How strongly the facing surfaces stretch toward each other.'),
  n('Fusion', 'contactGap', 'Contact surface gap (× radius)', -0.5, 1, 0.01,
    'CONTACT starts when the visible liquid surfaces are closer than this (negative = must overlap).'),
  n('Fusion', 'neckStrength', 'Attraction neck strength', 0, 2, 0.01,
    'Visibility of the blue→violet→red liquid bridge before and during contact.'),
  n('Fusion', 'hysteresis', 'Threshold hysteresis', 0, 0.6, 0.01,
    'Exit thresholds are this fraction larger than entry thresholds.'),
  n('Fusion', 'minContactTime', 'Minimum contact time (s)', 0, 2, 0.01),
  n('Fusion', 'compressionDuration', 'Compression duration (s)', 0.1, 1.5, 0.01),
  n('Fusion', 'fusionImpulse', 'Fusion impulse', 0, 3, 0.01),
  i('Fusion', 'fusionDroplets', 'Fusion micro-droplets', 0, 16),
  n('Fusion', 'fusionCooldown', 'Fusion cooldown (s)', 0, 5, 0.05),
  n('Fusion', 'purpleScale', 'Purple size (×radius)', 0.8, 1.8, 0.01),
  n('Fusion', 'autoSplitAfter', 'Auto-split after (s, 0 = never)', 0, 30, 0.5),

  // ── Rendering ─────────────────────────────────────────────────────────────
  n('Rendering', 'coreBrightness', 'Core brightness', 0, 3, 0.01),
  n('Rendering', 'edgeBrightness', 'Edge brightness', 0, 3, 0.01),
  n('Rendering', 'rimWidth', 'Edge width (px)', 0.5, 8, 0.1),
  n('Rendering', 'glowIntensity', 'Glow intensity', 0, 2, 0.01),
  n('Rendering', 'glowRadius', 'Glow radius (×radius)', 0.2, 3, 0.01),
  n('Rendering', 'turbulenceAmount', 'Turbulence amount', 0, 2, 0.01),
  n('Rendering', 'turbulenceSpeed', 'Turbulence speed', 0, 3, 0.01),
  n('Rendering', 'flowInertia', 'Internal flow inertia', 0, 1.5, 0.01,
    'Internal pattern lags on acceleration and keeps sloshing after stops/impacts.'),
  n('Rendering', 'refraction', 'Refraction / distortion', 0, 1, 0.01),
  n('Rendering', 'bodyOpacity', 'Body opacity', 0.3, 1, 0.01),
  n('Rendering', 'backgroundDim', 'Camera dim', 0, 0.8, 0.01),
  n('Rendering', 'maxPixelRatio', 'Max pixel ratio (quality)', 0.5, 2, 0.05),
] as const satisfies readonly ParamDef[];

type DefOf<K extends string> = Extract<(typeof PARAMS)[number], { key: K }>;
type ValueOf<D> = D extends { type: 'bool' } ? boolean : D extends { type: 'select' } ? string : number;
export type ParamKey = (typeof PARAMS)[number]['key'];
export type Settings = { [K in ParamKey]: ValueOf<DefOf<K>> };

export const PARAM_GROUPS: ParamGroup[] = [
  'Tracking',
  'Anchor',
  'Depth',
  'Gestures',
  'Physics',
  'Shape',
  'Droplets',
  'Interaction',
  'Fusion',
  'Rendering',
];

export const DEFAULT_SETTINGS: Settings = Object.freeze(
  Object.fromEntries(PARAMS.map((p) => [p.key, p.default])),
) as Settings;

/** Keys in `default-settings.json` that the schema does not know (should be empty). */
export const UNKNOWN_DEFAULT_KEYS = Object.keys(RAW_DEFAULTS).filter((k) => !PARAMS.some((p) => p.key === k));

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
