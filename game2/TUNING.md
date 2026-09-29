# Tuning Guide (v0.2)

Every motion, gesture, interaction and render constant is live-tunable in the **Tune** panel (key `S`).

- **Download Settings JSON** saves `zerog-settings.json` (`{"schemaVersion": 2, "settings": {…}}`). Send it with a clip.
- **Copy / Load Settings JSON** still work. Load accepts a v2 file, a v0.1 flat export or any partial object. You can also open a file from the dialog. Unknown keys are ignored and numbers are clamped.
- Only the values you changed persist in `localStorage` (`zerog.settings.v2`). New repo defaults still reach every setting you never touched.
- Double-click a slider to reset that one value. Highlighted rows differ from the defaults.

**Making a tuned file the repo defaults.** The `settings` object of a downloaded file has exactly the shape of `src/config/default-settings.json`. Either replace that file's `settings`, or run:

```bash
npm run apply-settings -- path/to/zerog-settings.json          # add --dry-run to preview
```

The script validates the file (it rejects a newer `schemaVersion`), clamps values to their slider ranges, keeps current defaults for keys the file lacks, prints the diff and rewrites the canonical JSON. Then run `npm test && npm run typecheck && npm run build`. The tables at the bottom come from `npm run tuning-table`.

**Units.** `u` (world unit) = the shorter side of the viewport. **× radius** = multiples of the current *effective* radius, which is `baseRadius × size (purple) × depth scale`. Rendering, palm collisions, fusion contact and the finger gap all use this same radius.

## Try these first

In order, for the "zero-g liquid" feel:

1. **`fingerGap`** (Anchor). This is the air gap between the fingertip and the near liquid surface, in radii. 0.8 is a clear gap. Below 0.3 the liquid touches the finger.
2. **`stiffness` / `damping`** (Physics). These set how tightly the mass follows and how much it overshoots. The damping ratio is ≈ `damping / (2·√stiffness)` (0.74 at the defaults).
3. **`deformation`** (Shape, default 1.4). This visually amplifies surface displacement. It saturates smoothly, so violent motion cannot tear the drop apart. It's the main midrange "looks liquid" dial.
4. **`tetherDeformInfluence`** (Anchor, default 0.9). This sets how strongly the liquid leans and stretches toward the point it is pulled to. It gives the teardrop shape during ordinary motion.
5. **`surfaceTension` + `settleStrength`** (Shape / Physics). These control the wobble frequency and how fast it calms.
6. **`palmRestitution` / `palmSteer` / `palmVelocityInfluence`** (Interaction). These shape the volley feel: bounciness, how much a push goes where the hand moves, and how much of the hand's speed is transferred.
7. **`shotSpeed` / `thumbTriggerThreshold`** (Interaction / Gestures). These set the handgun feel and how deliberate the thumb press must be.
8. **`depthScaleStrength` + `depthSmoothing`** (Depth). These set how much hand distance changes the size, and how calmly.
9. **Camera:** `smoothingMinCutoff` (resting jitter) and `fingerOpenAbove` / `fingerClosedBelow` (gesture reliability on your hands).
10. **Fusion:** `attractionRadius`, `reachStrength`, `contactGap`, `neckStrength`, `minContactTime`.

## Gestures (what the classifier does)

Per hand, from 21 landmarks, all rotation-invariant (no screen-axis tests):

- **Finger extension** (0 = fist, 1 = straight) averages two cues:
  - straightness: tip–base distance divided by the summed segment lengths;
  - reach: tip–wrist distance divided by PIP–wrist distance.
- A finger is **open** once its extension goes above `fingerOpenAbove` (0.62). It stays open until it drops below `fingerClosedBelow` (0.42). The band between is hysteresis.
- **Thumb** openness is the distance of the thumb tip from the index finger's MCP→PIP segment, in palm sizes. It is ≈0.8 extended (hammer up) and ≈0.25 pressed onto the side of the index.

| gesture | rule | priority |
|---|---|---|
| `HANDGUN` | index open, middle + ring + pinky closed, thumb **armed** (openness > `thumbTriggerThreshold` × 1.35) | 1 |
| `PALM_PUSH` | ring open + pinky open | 2 |
| `TRACK` | ring closed + pinky closed (index/middle free) | 3 |
| `NEUTRAL` | anything else | 4 |

Stability rules:
- A new gesture must persist for `gestureEnterDwell` (the gun uses `gunGestureDwell`; NEUTRAL uses 2 × enter dwell, at least 0.2 s).
- The old gesture must also be absent for `gestureExitDwell` before the switch happens.

Firing:
- The gun fires once when the thumb goes from armed to below `thumbTriggerThreshold` while HANDGUN is stable.
- The thumb must rise above the threshold × 1.35 again to re-arm. `shotCooldown` also applies.
- A thumb kept folded longer than 0.5 s ends the gun pose and the hand becomes `TRACK`.
- Space (camera/scripts), or Space/click (mouse Gun mode), is the developer fallback.

What each gesture does to the liquid:
- `TRACK` and `HANDGUN` anchor it to the fingertip. They are also the only gestures that spawn a new ball.
- `PALM_PUSH` releases it (it becomes FREE) and turns the hand into a collider.
- `NEUTRAL` changes nothing.
- A free ball is recaptured by a hand that newly enters `TRACK`/`HANDGUN`. The hand that released or shot it must change gesture first. That is why a gun hand does not suck its own shot back; make a fist (or thumbs-up fist) to recapture.

## Palm push and shot, in numbers

- **Palm collider** = convex hull of wrist, thumb CMC and the four MCPs, plus the PIP joints of open fingers (`palmIncludeFingers`). It is padded by `palmColliderPadding` × radius. It's extrapolated between tracker samples along the smoothed palm velocity.
- **Contact:** depenetrate, then reflect the approach speed relative to the palm. The impulse is (1 + `palmRestitution`) × `palmImpulseStrength` along the contact normal, bent toward the palm's own motion by `palmSteer`. The palm's velocity is added (× `palmVelocityInfluence`). `palmFriction` of the sliding speed is removed. The facing surface is flattened, the sides bulge and the internal flow swirls. Impacts faster than 1.6 u/s tear a droplet off.
- **Free ball:** no tether, only `freeDrag`. Once it's more than `freeBoundsMargin` off-screen for `offscreenDespawnDelay`, it is removed. A hand still pointing (or aiming) then condenses a fresh one ("reload").
- **Shot:** velocity = aim × `shotSpeed` + hand velocity × `shotHandVelocityInfluence`, launched from the ball's current position. The aim is the smoothed index MCP → TIP direction.
- **Recapture:** a spring of `recaptureStrength` / `recaptureDamping`, with the pull capped at 0.35 u and no tether clamp, so it never teleports. The ball becomes anchored again within `recaptureDistance` radii.

## Depth

The primary signal is apparent palm size: the mean of the 3D landmark lengths wrist→index/middle/pinky MCP plus the index-to-pinky MCP width. Using 3D lengths makes it fairly rotation-robust. MediaPipe's landmark z is wrist-relative, not an absolute distance, so it is only used for these 3D lengths.

The signal is median-filtered over 5 samples (spike rejection) and divided by a baseline, which is the first stable hand and can be reset with **Reset Depth Baseline** / `B`. Then:

`scale = clamp(1 + depthScaleStrength·(size/baseline − 1), depthMinScale, depthMaxScale)`

That is smoothed with `depthSmoothing`. A free ball keeps its last depth scale.

## Measured behaviour at the defaults

From `npm test` (headless). R = base radius. "Rendered aspect" is the length/width of the actual rendered metaball silhouette.

| sweep | finger peak | max lag | overshoot | settle | droplets | rendered aspect |
|---|---|---|---|---|---|---|
| slow (0.6 u / 1.6 s) | 1.1 u/s | 0.84 R | 0.05 R | – | 0 | 1.14 (round) |
| medium (0.8 u / 0.8 s) | 3.0 u/s | 2.2 R | 0.35 R | 0.42 s | 0 | 1.46 (visibly stretched) |
| fast (1.0 u / 0.5 s) | 5.9 u/s | 3.5 R | 1.0 R | 0.47 s | 3 | ≈3 incl. tail |
| violent (1.1 u / 0.35 s) | 9.2 u/s | 3.9 R | 2.4 R | 0.77 s | 6 | ≈4 incl. tail |

A gentle shake emits 0 droplets. An aggressive shake emits about 23 in 3 s. No sweep tears a hole into the drawn liquid (tested).

Fusion with two hands approaching at 0.12 u/s:
- attraction starts at ≈6 R between the anchors;
- visible surface contact (CONTACT) comes at ≈3.6 R anchor distance / 3 R body distance;
- FUSING follows after `minContactTime`, then PURPLE.

## Presets

Presets live in `src/config/presets.ts` and override only the keys they list: Default, Soft jelly, Heavy mercury, Wild droplets, One-hand fusion (small).

## Default parameters

### Tracking

| key | default | range | what it changes |
|---|---|---|---|
| `mirror` | on | on/off | Mirror (selfie view) — Mirror camera image and tracking together. |
| `smoothingMinCutoff` | 2.5 | 0.1 – 10 | Smoothing min cutoff (Hz) — One-Euro filter. Lower = smoother but laggier when the finger is slow. |
| `smoothingBeta` | 8 | 0 – 30 | Smoothing speed response — One-Euro beta. Higher = less lag during fast motion (more jitter passes through). |
| `controlPrediction` | 0.6 | 0 – 1 | Control-point prediction — How far the anchor extrapolates between tracker samples. 0 = interpolate (one sample late), 1 = full dead-reckoning. The heavy body supplies the visible lag. |
| `graceDuration` | 0.25 | 0 – 1 | Loss grace / prediction (s) — How long a lost fingertip keeps moving on its last velocity before being considered lost. |
| `fadeDuration` | 0.8 | 0.1 – 3 | Loss fade-out (s) |
| `reacquireTime` | 0.18 | 0.02 – 0.8 | Reacquire blend (s) — Target blends from the old position to the new one instead of teleporting. |
| `jumpThreshold` | 0.3 | 0.05 – 1 | Teleport guard distance (u) — A single-sample jump larger than this is blended like a reacquire. |
| `confidenceThreshold` | 0.5 | 0 – 1 | Confidence threshold |
| `trackerMaxFps` | 30 | 5 – 60 | Tracker max FPS |
| `anchorMode` | auto | auto / oneHand / twoHands | Anchor mode (fusion) — auto = two hands when two are seen (debounced), otherwise index+second finger of one hand. |
| `anchorBFinger` | middle | middle / thumb / pinky | One-hand anchor B finger |

### Anchor

| key | default | range | what it changes |
|---|---|---|---|
| `fingerGap` | 0.8 | 0 – 3 | Finger gap (× radius) — Air gap between the fingertip and the near surface of the liquid, along the finger direction. |
| `fingerDirSmoothing` | 0.08 | 0 – 0.4 | Finger direction smoothing (s) — Time constant of the pointing-direction filter. Higher = steadier offset, slower to turn. |
| `spawnGrowDuration` | 0.4 | 0.05 – 2.5 | Spawn grow duration (s) — A new body condenses in place from an invisible dot over this time. |
| `tetherDeformInfluence` | 0.9 | 0 – 2 | Tether deformation — How strongly the liquid leans/stretches toward its (offset) anchor when it lags behind. |

### Depth

| key | default | range | what it changes |
|---|---|---|---|
| `depthScaleEnabled` | on | on/off | Depth scaling — Closer hand → bigger liquid, farther → smaller. |
| `depthScaleStrength` | 0.7 | 0 – 2 | Depth scale strength — scale = 1 + strength·(palmSize/baseline − 1), before clamping. |
| `depthMinScale` | 0.75 | 0.4 – 1 | Depth min scale |
| `depthMaxScale` | 1.35 | 1 – 2.5 | Depth max scale |
| `depthSmoothing` | 0.25 | 0.02 – 2 | Depth smoothing (s) — Time constant of the depth scale (after median spike rejection). |

### Gestures

| key | default | range | what it changes |
|---|---|---|---|
| `fingerOpenAbove` | 0.62 | 0.3 – 0.95 | Finger open above — Normalized extension (0 = fist, 1 = straight) above which a finger counts as open. |
| `fingerClosedBelow` | 0.42 | 0.05 – 0.7 | Finger closed below — Extension below which a finger counts as closed. The gap between both thresholds is hysteresis. |
| `gestureEnterDwell` | 0.12 | 0 – 0.6 | Gesture enter dwell (s) — A new pose must be seen this long before it becomes the active gesture. |
| `gestureExitDwell` | 0.1 | 0 – 0.6 | Gesture exit dwell (s) — The active gesture survives mismatching frames for this long (hysteresis against flicker). |
| `gunGestureDwell` | 0.15 | 0 – 0.6 | Handgun dwell (s) — Enter dwell for the handgun pose. |
| `thumbTriggerThreshold` | 0.45 | 0.1 – 1 | Thumb trigger threshold — Thumb-tip distance from the index base (× palm size). Folding below fires; must extend 1.35× above to re-arm. |

### Physics

| key | default | range | what it changes |
|---|---|---|---|
| `stiffness` | 140 | 5 – 500 | Spring stiffness — Pull of the anchor on the fluid center. Higher = tighter follow. |
| `damping` | 17.5 | 0 – 60 | Spring damping — Lower = more overshoot. Critical damping ≈ 2·√(stiffness/mass). |
| `trailingDrag` | 0.45 | 0 – 1 | Trailing drag — Share of damping against world motion: 0 = catches up with a steadily moving finger, 1 = trails proportional to speed. |
| `mass` | 1 | 0.2 – 5 | Mass — Divides both forces: heavier = slower, same bounciness. |
| `maxLag` | 2.8 | 0.5 – 10 | Max lag (radii) — Beyond this distance the tether stiffens strongly so the mass cannot fall far behind. |
| `velocityInfluence` | 0.25 | 0 – 0.8 | Velocity stretch — Elongates the core along its velocity (saturating, area-preserving). |
| `accelInfluence` | 0.45 | 0 – 2 | Acceleration influence — Extra inertial swing of the surface points (squash/stretch opposite acceleration). |
| `fingerAdhesion` | 8 | 0 – 40 | Finger adhesion (stir) — How much anchor motion directly stirs the surface. Keeps fast shakes lively even though the core is heavy. |
| `settleStrength` | 0.3 | 0.02 – 1.5 | Settle strength (jelly damping ratio) — Damping of the surface wobble. Low = long jelly wobble, high = quickly calm. |

### Shape

| key | default | range | what it changes |
|---|---|---|---|
| `baseRadius` | 0.075 | 0.02 – 0.2 | Base radius (u) |
| `deformation` | 1.4 | 0 – 2.5 | Deformation strength — Visual multiplier on how far surface points are drawn from their rest shape. |
| `surfaceTension` | 0.55 | 0 – 1 | Surface tension — How hard the surface pulls back to a compact round shape (wobble frequency). |
| `secondaryCount` | 8 | 6 – 12 | Secondary blob points — Surface points. Fewer than 6 reads lobed with the ring-dominant v0.2 layout. |
| `tailLength` | 0.85 | 0 – 2 | Tail length — 0 disables the trailing tail. |
| `maxStretch` | 2.6 | 1 – 5 | Max stretch (radii) — Hard limit against excessive goo. |
| `idleWobble` | 0.35 | 0 – 1 | Idle wobble amount |
| `idleWobbleSpeed` | 0.9 | 0 – 4 | Idle wobble speed |

### Droplets

| key | default | range | what it changes |
|---|---|---|---|
| `dropletsEnabled` | on | on/off | Droplets enabled |
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

### Interaction

| key | default | range | what it changes |
|---|---|---|---|
| `freeDrag` | 0.35 | 0 – 3 | Free drag (1/s) — Air drag of a free/shot ball. 0 = perfect zero-g drift. |
| `palmColliderPadding` | 0.3 | 0 – 1.5 | Palm collider padding (× radius) — Expands the palm collider so contact feels forgiving. |
| `palmIncludeFingers` | on | on/off | Palm collider includes open fingers — Adds the PIP joints of open fingers to the palm polygon (whole open hand pushes). |
| `palmImpulseStrength` | 1 | 0 – 3 | Palm impulse strength — Multiplier on the bounce impulse (1 = physical). |
| `palmRestitution` | 0.6 | 0 – 1.2 | Palm restitution — Bounciness of the palm hit (0 = dead stop, 1 = elastic). |
| `palmFriction` | 0.25 | 0 – 1 | Palm friction — Share of the tangential sliding speed removed on impact. |
| `palmVelocityInfluence` | 1 | 0 – 2 | Palm velocity influence — How much of the palm’s own velocity is transferred on contact. |
| `palmSteer` | 0.8 | 0 – 2 | Palm push steering — A palm moving into the ball bends the bounce toward its own motion. 0 = pure contact normal. |
| `recaptureStrength` | 60 | 5 – 400 | Recapture strength — Magnetic spring pulling a free ball back to the finger anchor. |
| `recaptureDamping` | 9 | 0 – 60 | Recapture damping |
| `recaptureDistance` | 1.2 | 0.1 – 4 | Recapture done distance (× radius) — Within this distance the recaptured ball becomes normally anchored again. |
| `shotSpeed` | 3.2 | 0.3 – 8 | Shot speed (u/s) |
| `shotHandVelocityInfluence` | 0.5 | 0 – 2 | Shot hand-velocity influence — Share of the hand’s own velocity added to the shot. |
| `shotCooldown` | 0.45 | 0 – 3 | Shot cooldown (s) |
| `freeBoundsMargin` | 0.25 | 0 – 1.5 | Off-screen margin (u) — A free/shot ball this far outside the view counts as off-screen. |
| `offscreenDespawnDelay` | 0.6 | 0 – 5 | Off-screen despawn delay (s) |

### Fusion

| key | default | range | what it changes |
|---|---|---|---|
| `attractionRadius` | 0.46 | 0.1 – 1.5 | Attraction radius (u) — Body-center distance at which blue and red start to attract. |
| `attractionStrength` | 12 | 0 – 120 | Attraction strength — Pull between the two centers inside the attraction radius. |
| `reachStrength` | 10 | 0 – 120 | Reach / deformation strength — How strongly the facing surfaces stretch toward each other. |
| `contactGap` | 0.15 | -0.5 – 1 | Contact surface gap (× radius) — CONTACT starts when the visible liquid surfaces are closer than this (negative = must overlap). |
| `neckStrength` | 1 | 0 – 2 | Attraction neck strength — Visibility of the blue→violet→red liquid bridge before and during contact. |
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
| `edgeBrightness` | 0.9 | 0 – 3 | Edge brightness |
| `rimWidth` | 1.8 | 0.5 – 8 | Edge width (px) |
| `glowIntensity` | 0.3 | 0 – 2 | Glow intensity |
| `glowRadius` | 0.9 | 0.2 – 3 | Glow radius (×radius) |
| `turbulenceAmount` | 1 | 0 – 2 | Turbulence amount |
| `turbulenceSpeed` | 0.6 | 0 – 3 | Turbulence speed |
| `flowInertia` | 0.7 | 0 – 1.5 | Internal flow inertia — Internal pattern lags on acceleration and keeps sloshing after stops/impacts. |
| `refraction` | 0.5 | 0 – 1 | Refraction / distortion |
| `bodyOpacity` | 0.8 | 0.3 – 1 | Body opacity |
| `backgroundDim` | 0.12 | 0 – 0.8 | Camera dim |
| `maxPixelRatio` | 1.5 | 0.5 – 2 | Max pixel ratio (quality) |

