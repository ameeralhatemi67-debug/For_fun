# Tuning Guide

Every motion and render constant is live-tunable in the **Tune** panel (key `S`).
Values persist in `localStorage`. **Copy Settings JSON** exports all of them, and **Load Settings JSON** accepts a full or partial JSON (unknown keys are ignored, and out-of-range numbers are clamped).
Double-click a slider to reset that one value. Rows that differ from the defaults are highlighted.

**Units.** `u` = world unit = the shorter side of the viewport. On a landscape screen, 1 u is the full height. On a portrait phone, it's the full width. The base radius 0.075 u is therefore about 7.5% of the short side.

## Try these first

These are the highest-leverage knobs for the "zero-g liquid" feel, in order:

1. **`stiffness` / `damping`** (Physics). This is how tightly the mass follows the finger and how much it overshoots. The damping ratio is ≈ `damping / (2·√stiffness)`. The default 17.5 / 140 gives ≈ 0.74 (slight overshoot). Around 0.5 gets bouncy, and ≥ 1 gets syrupy.
2. **`trailingDrag`** (Physics). 0 means the mass catches up with a steadily moving finger (lag only while accelerating). 1 means it trails in proportion to speed. This is the main "has mass" vs "responsive" dial.
3. **`surfaceTension` + `settleStrength`** (Shape / Physics). These set the jelly-wobble frequency and how quickly it calms. Low tension with low settle gives a long wobbly jelly. High tension with high settle gives a tight mercury bead.
4. **`accelInfluence`** (Physics). This controls how far the surface swings opposite to acceleration (squash on stops, stretch on starts).
5. **`tailLength` + `velocityInfluence`** (Shape / Physics). These control the elongation and trailing tail during fast moves.
6. **`dropletSpeedThreshold` / `dropletAccelThreshold` / `dropletRate`** (Droplets). These set how easily droplets detach. Raise the thresholds if droplets appear during ordinary motion.
7. **`fingerAdhesion`** (Physics). This sets how much fast finger jiggle (above the mass's ~2 Hz resonance) still stirs the surface.
8. **Camera use:** **`smoothingMinCutoff`** (Tracking). Lower it if the resting mass shivers from landmark jitter. Raise it if the target feels late.

For the fusion feel: `attractionRadius`, `mergeRadius`, `minContactTime`, `compressionDuration`, and `fusionImpulse`.

## Presets

Presets are in `src/config/presets.ts`. Each one overrides only the listed keys on top of the defaults.

| preset | character |
|---|---|
| Default | Balanced: visible lag, slight overshoot, ~0.4 s settle |
| Soft jelly | Lower stiffness and tension, long wobble, longer tail |
| Heavy mercury | High tension and damping, heavier, fewer droplets |
| Wild droplets | Lower emission thresholds, more droplets that drift longer |
| One-hand fusion (small) | Smaller masses and radii, for index + middle finger on one hand |

## Measured behavior at defaults

These numbers come from `npm test` (headless physics, "motion report"). The finger does one eased sweep and then stops. Here, R = base radius.

| sweep | finger peak speed | max lag | overshoot after stop | settle | droplets |
|---|---|---|---|---|---|
| slow (0.6 u in 1.6 s) | 1.1 u/s | 0.9 R | 0.05 R | – | 0 |
| medium (0.8 u in 0.8 s) | 3.0 u/s | 2.2 R | 0.3 R | 0.4 s | 0 |
| fast (1.0 u in 0.5 s) | 5.9 u/s | 3.5 R | 1.0 R | 0.5 s | 3 |
| violent (1.1 u in 0.35 s) | 9.2 u/s | 3.9 R (hard tether) | 2.4 R | 0.7 s | 6 |

A gentle shake (0.03 u at 3.5 Hz) emits 0 droplets. An aggressive shake (0.11 u at 7 Hz) emits about 20 in 3 s.

## Default parameters

### Tracking

| key | default | range | what it changes |
|---|---|---|---|
| `mirror` | true | on/off | Mirror (selfie view) — Mirror camera image and tracking together. |
| `smoothingMinCutoff` | 2.5 | 0.1 – 10 | Smoothing min cutoff (Hz) — One-Euro filter. Lower = smoother but laggier when the finger is slow. |
| `smoothingBeta` | 8 | 0 – 30 | Smoothing speed response — One-Euro beta. Higher = less lag during fast motion (more jitter passes through). |
| `graceDuration` | 0.25 | 0 – 1 | Loss grace / prediction (s) — How long a lost fingertip keeps moving on its last velocity before being considered lost. |
| `fadeDuration` | 0.8 | 0.1 – 3 | Loss fade-out (s) |
| `reacquireTime` | 0.18 | 0.02 – 0.8 | Reacquire blend (s) — Target blends from the old position to the new one instead of teleporting. |
| `jumpThreshold` | 0.3 | 0.05 – 1 | Teleport guard distance (u) — A single-sample jump larger than this is blended like a reacquire. |
| `confidenceThreshold` | 0.5 | 0 – 1 | Confidence threshold |
| `trackerMaxFps` | 30 | 5 – 60 | Tracker max FPS |
| `anchorMode` | auto | auto / oneHand / twoHands | Anchor mode (fusion) — auto = two hands when two are seen (debounced), otherwise index+second finger of one hand. |
| `anchorBFinger` | middle | middle / thumb / pinky | One-hand anchor B finger |

### Physics

| key | default | range | what it changes |
|---|---|---|---|
| `stiffness` | 140 | 5 – 500 | Spring stiffness — Pull of the fingertip on the fluid center. Higher = tighter follow. |
| `damping` | 17.5 | 0 – 60 | Spring damping — Lower = more overshoot. Critical damping ≈ 2·√(stiffness/mass). |
| `trailingDrag` | 0.45 | 0 – 1 | Trailing drag — Share of damping against world motion: 0 = catches up with a steadily moving finger, 1 = trails proportional to speed. |
| `mass` | 1 | 0.2 – 5 | Mass — Divides both forces: heavier = slower, same bounciness. |
| `maxLag` | 2.8 | 0.5 – 10 | Max lag (radii) — Beyond this distance the tether stiffens strongly so the mass cannot fall far behind. |
| `velocityInfluence` | 0.12 | 0 – 0.6 | Velocity stretch — Elongates the core along its velocity. |
| `accelInfluence` | 0.3 | 0 – 2 | Acceleration influence — Extra inertial swing of the surface points (squash/stretch opposite acceleration). |
| `fingerAdhesion` | 8 | 0 – 40 | Finger adhesion (stir) — How much finger motion directly stirs the surface. Keeps fast shakes lively even though the core is heavy. |
| `settleStrength` | 0.3 | 0.02 – 1.5 | Settle strength (jelly damping ratio) — Damping of the surface wobble. Low = long jelly wobble, high = quickly calm. |

### Shape

| key | default | range | what it changes |
|---|---|---|---|
| `baseRadius` | 0.075 | 0.02 – 0.2 | Base radius (u) |
| `deformation` | 1 | 0 – 2.5 | Deformation strength — Visual multiplier on how far surface points are drawn from their rest shape. |
| `surfaceTension` | 0.62 | 0 – 1 | Surface tension — How hard the surface pulls back to a compact round shape (wobble frequency). |
| `secondaryCount` | 7 | 3 – 12 | Secondary blob points |
| `tailLength` | 0.85 | 0 – 2 | Tail length — 0 disables the trailing tail. |
| `maxStretch` | 2.6 | 1 – 5 | Max stretch (radii) — Hard limit against excessive goo. |
| `idleWobble` | 0.35 | 0 – 1 | Idle wobble amount |
| `idleWobbleSpeed` | 0.9 | 0 – 4 | Idle wobble speed |

### Droplets

| key | default | range | what it changes |
|---|---|---|---|
| `dropletsEnabled` | true | on/off | Droplets enabled |
| `dropletSpeedThreshold` | 1.7 | 0.2 – 8 | Emission speed threshold (u/s) |
| `dropletAccelThreshold` | 30 | 2 – 250 | Emission accel threshold (u/s²) |
| `dropletRate` | 16 | 0 – 80 | Emission rate — Droplets/second per unit of threshold excess. |
| `maxDroplets` | 14 | 0 – 32 | Max droplet count |
| `dropletMinSize` | 0.14 | 0.05 – 0.8 | Min droplet size (×radius) |
| `dropletMaxSize` | 0.32 | 0.05 – 0.9 | Max droplet size (×radius) |
| `dropletLifetime` | 3.5 | 0.3 – 10 | Droplet lifetime (s) |
| `dropletEjectSpeed` | 0.55 | 0 – 3 | Eject speed (u/s) |
| `dropletDrag` | 1.8 | 0 – 8 | Droplet drag |
| `dropletFreeTime` | 0.22 | 0 – 1.5 | Free-flight time (s) — Delay before a droplet starts being pulled back. |
| `dropletAttraction` | 10 | 0 – 60 | Attraction-back strength |
| `dropletMergeRadius` | 0.8 | 0.2 – 2 | Merge radius (×radius) |

### Fusion

| key | default | range | what it changes |
|---|---|---|---|
| `attractionRadius` | 0.46 | 0.1 – 1.5 | Attraction radius (u) |
| `attractionStrength` | 22 | 0 – 120 | Attraction strength — Pull between the two centers inside the attraction radius. |
| `reachStrength` | 34 | 0 – 120 | Reach / deformation strength — How strongly the facing surfaces stretch toward each other. |
| `mergeRadius` | 0.16 | 0.03 – 0.6 | Merge radius (u) |
| `hysteresis` | 0.18 | 0 – 0.6 | Threshold hysteresis — Exit thresholds are this fraction larger than entry thresholds. |
| `minContactTime` | 0.45 | 0 – 2 | Minimum contact time (s) |
| `compressionDuration` | 0.42 | 0.1 – 1.5 | Compression duration (s) |
| `fusionImpulse` | 1 | 0 – 3 | Fusion impulse |
| `fusionDroplets` | 8 | 0 – 16 | Fusion micro-droplets |
| `fusionCooldown` | 1.2 | 0 – 5 | Fusion cooldown (s) |
| `purpleScale` | 1.22 | 0.8 – 1.8 | Purple size (×radius) |
| `autoSplitAfter` | 0 | 0 – 30 | Auto-split after (s, 0 = never) |

### Rendering

| key | default | range | what it changes |
|---|---|---|---|
| `coreBrightness` | 1.1 | 0 – 3 | Core brightness |
| `edgeBrightness` | 1.15 | 0 – 3 | Edge brightness |
| `rimWidth` | 2.2 | 0.5 – 8 | Edge width (px) |
| `glowIntensity` | 0.4 | 0 – 2 | Glow intensity |
| `glowRadius` | 0.9 | 0.2 – 3 | Glow radius (×radius) |
| `turbulenceAmount` | 1 | 0 – 2 | Turbulence amount |
| `turbulenceSpeed` | 0.6 | 0 – 3 | Turbulence speed |
| `refraction` | 0.35 | 0 – 1 | Refraction / distortion |
| `bodyOpacity` | 0.84 | 0.3 – 1 | Body opacity |
| `backgroundDim` | 0.12 | 0 – 0.8 | Camera dim |
| `maxPixelRatio` | 1.5 | 0.5 – 2 | Max pixel ratio (quality) |
