# Zero-G Energy — Fluid Feel & Gesture Interaction Specification v0.2

## Status

This document is a focused v0.2 extension to the existing:

- `ZeroG_Energy_Web_Prototype_SPEC.md`
- current `game2` implementation
- current `STATUS.md`
- current `TUNING.md`

Do NOT rebuild the project from scratch.

Preserve the current architecture and working features unless this document explicitly replaces a behavior.

The current build already has:
- camera + mouse/script inputs,
- MediaPipe hand tracking,
- anchor smoothing,
- spring/inertia fluid bodies,
- metaball rendering,
- droplets and reabsorption,
- blue/red fusion state machine,
- recording,
- tuning controls,
- debug overlays,
- tests.

This pass is about improving the **physical illusion**, adding **gesture-driven interaction**, adding **depth response**, and making tuning export suitable for turning user-chosen values into future defaults.

---

# 1. Primary Goal

The current effect reads too often as a glowing marble following a fingertip.

The next version should feel like:

> a luminous zero-gravity liquid mass with its own inertia, shape, momentum, depth and interaction rules.

The user should be able to:
- control it with a fingertip,
- keep a configurable air gap between fingertip and liquid,
- see it spawn from the finger instead of entering from off-screen,
- switch into palm-push mode using hand gestures,
- volley the free liquid between two hands,
- use a handgun gesture to aim and shoot the liquid,
- see the effect grow/shrink slightly as the hand moves closer/farther from the camera,
- export all tuned settings as a JSON file that can later become the repo defaults.

Do not add unrelated filters in this pass.

---

# 2. Important Revision to the Finger Attachment Concept

The user explicitly wants visible space between the fingertip and the energy ball.

Therefore:

## Do NOT place the center of the ball directly on the fingertip.

The desired geometry is:

```text
finger direction →

index finger tip      clear gap        liquid
       ●  -------------------->          🟣
```

The liquid should sit *beyond* the fingertip along the finger's pointing direction.

Use the finger direction:

```text
index DIP (7) → index TIP (8)
```

or, if more stable:

```text
index PIP/MCP → index TIP
```

Normalize this direction in screen/world space.

Then:

```text
anchorTarget =
  fingertip
  + fingerDirection * fingerGap
```

Where `fingerGap` is tunable.

### Required slider
- `fingerGap`
  - controls visible separation between fingertip and the nearest/center attachment target
  - express in world units or base radii
  - recommended UI display in “× radius” if possible

Suggested initial range:
- 0.0 to 3.0 radii

Suggested default:
- around 0.7–1.0 radii

The exact default must be visually tuned.

---

# 3. Preserve Liquid Pull Without Covering the Finger

Previous fluid work benefits from a clear pull direction between target and body.

Even with an air gap, the liquid should deform according to the vector:

```text
anchorTarget - fluidCenter
```

This vector is the "attachment tension" direction.

Do NOT require a visible solid liquid bridge all the way to the fingertip.

The liquid may:
- bulge toward the anchor,
- stretch slightly toward the finger,
- form a short forward lobe,
- become asymmetric when lagging,

but preserve the requested visible air gap.

A visible neck may exist **inside the liquid body**, but it should stop before it reaches the fingertip.

Optional future parameter:
- `minVisibleFingerGap`

Use it only if helpful.

---

# 4. Spawn Behavior

## Current problem

A newly tracked ball can appear to fly in from an old/off-screen simulation position.

That is incorrect.

## Required behavior

When a hand/finger becomes newly available after a true absence:

1. Compute the correct offset anchor target.
2. Teleport/reset the fluid simulation to that target.
3. Start the body at effectively zero visual size / zero presence.
4. Grow smoothly from an invisible dot into its normal radius.

Conceptually:

```text
time 0:
finger     ·

time +:
finger     •

time ++:
finger     ●

time +++:
finger     🟣
```

The body must NOT travel in from outside the frame.

### Required slider
- `spawnGrowDuration`

Suggested range:
- 0.05 s to 2.5 s

Suggested default:
- 0.30–0.50 s

Use a visually pleasing easing curve such as:
- smoothstep,
- easeOutCubic,
- or easeOutBack with very restrained overshoot.

Do not make the spawn feel like a UI scale animation.
It should feel like energy/liquid condensing into existence.

### Important distinction

Brief tracking loss within the existing grace/prediction window:
- do NOT respawn.

Only a true lost → reacquired transition after the body has meaningfully faded/ended should use the spawn sequence.

---

# 5. Interaction State Model

The effect now needs a body interaction state separate from the fusion color state.

Suggested body control states:

```text
ANCHORED
FREE
SHOT
RECAPTURING
```

Possible future states are allowed, but keep this simple.

## ANCHORED
Normal fingertip spring behavior.

## FREE
The body is not tethered to a fingertip.
It moves according to its current velocity and collisions/impulses.

Used for palm-push play.

## SHOT
A special free state entered after handgun firing.
The body begins with a strong directed velocity.

It remains a liquid body:
- stretches along velocity,
- can wobble,
- can shed droplets,
- can collide with hands.

`SHOT` may internally reuse `FREE` physics with extra metadata.

## RECAPTURING
When switching back to fingertip mode, do not teleport a free ball.

Use a short smooth recapture:
- magnetic attraction / spring toward the new anchor,
- then transition to normal `ANCHORED`.

### Useful tunable values
- `recaptureStrength`
- `recaptureDamping`
- `recaptureDistance`
- `recaptureDuration` or threshold

Do not create an excessively complicated system if a simple strong spring is sufficient.

---

# 6. Gesture Classifier

Create a dedicated hand-gesture layer.

Do NOT scatter gesture logic across the effect controller.

Suggested module:

```text
tracking/GestureClassifier.ts
```

The classifier receives hand landmarks and produces stable semantic states.

Required semantic gestures:

```text
TRACK
PALM_PUSH
HANDGUN
NEUTRAL
```

Use normalized geometry and joint relationships, not hard-coded pixel distances.

Add temporal stabilization:
- entry dwell,
- exit dwell / hysteresis,
- re-arm rules where needed.

Suggested initial dwell:
- ~100–180 ms

Expose current detected gesture per hand in Debug mode.

---

# 7. Gesture Priority

Some poses overlap.

Use explicit priority:

```text
HANDGUN
  ↓
PALM_PUSH
  ↓
TRACK
  ↓
NEUTRAL
```

This prevents the handgun pose from being misread as ordinary tracking simply because ring + pinky are closed.

---

# 8. TRACK Gesture

The user's desired simple rule:

> When both ring finger and pinky finger are closed, use normal fingertip tracking.

Interpretation:

```text
ring = closed
pinky = closed
→ TRACK
```

Index should preferably be extended enough to provide a stable anchor.

Middle finger may be open or closed depending on whether it is being used for the second energy ball.

Use robust finger-state detection rather than only tip Y comparisons because hands rotate.

Possible approaches:
- joint angles,
- fingertip distance from palm,
- projection along each finger's local direction.

Keep thresholds normalized to palm size.

---

# 9. Ball Assignment in TRACK Mode

Preserve the current useful behavior.

## Two hands available

If two stable hands are detected:

```text
Hand A index → Ball A
Hand B index → Ball B
```

Maintain stable hand identity over time.

## Only one hand available

For dual Blue + Red mode:

```text
index finger  → Ball A
middle finger → Ball B
```

This is only active while the hand is in TRACK mode.

For Purple/single-ball mode:
- Purple remains on the primary/index anchor.

Keep the existing `anchorMode` controls if useful.

---

# 10. PALM_PUSH Gesture

The user's desired rule:

> When both ring and pinky fingers are open, the interaction becomes palm pushing.

Interpretation:

```text
ring = open
pinky = open
→ PALM_PUSH
```

This mode should turn the hand from an anchor into a moving physical collider.

The fluid becomes free/pushable rather than tied to the fingertip.

The intended experience:

```text
Hand A → pushes 🟣 → → → Hand B
                           │
                           bounce / hit
                           ↓
                 Hand B can push it back
```

This should feel like playing with a zero-gravity liquid ball between two hands.

---

# 11. Palm Collider

Do not require full hand segmentation for v0.2.

Approximate the palm using hand landmarks.

Recommended landmark set:

```text
0  wrist
5  index MCP
9  middle MCP
13 ring MCP
17 pinky MCP
```

Create either:
- an oriented convex palm polygon,
- a small set of capsules/circles,
- or another lightweight 2D collider.

Prefer a convex hull / polygon if stable.

Expand the collider slightly so the interaction feels forgiving.

The user should not need pixel-perfect contact.

### Palm velocity

Estimate palm translational velocity from a smoothed palm center.

When the hand hits the free liquid, transfer momentum based on:
- collision normal,
- palm velocity,
- body velocity,
- restitution,
- transfer strength.

Suggested parameters:
- `palmColliderPadding`
- `palmImpulseStrength`
- `palmRestitution`
- `palmFriction`
- `palmVelocityInfluence`

---

# 12. Palm Push Collision Behavior

The body should behave like a soft energetic water ball, not a hard billiard ball.

On collision:

1. prevent deep penetration,
2. push the center out of the palm collider,
3. add velocity away from the palm,
4. add some of the palm's velocity,
5. deform/squash the fluid surface at the impact side,
6. generate an opposite-side stretch,
7. optionally shed a tiny droplet only for high-energy impact.

If it hits a stationary hand:

```text
🟣 → → → | palm
          ↓
     compression
          ↓
       bounce
```

The collision should visibly squash for a short time.

Consider adding a surface impulse to the nearest ring points.

---

# 13. Two-Hand Volley

When both hands are in PALM_PUSH mode:

- Purple or another free ball can travel between them.
- Either palm can collide with it.
- Hand identity does not determine ownership.
- The ball should not snap to a hand merely because that hand exists.

Example:

```text
Hand A  →  🟣  →  Hand B

Hand B  ←  🟣  ←  Hand A
```

This is intentionally playful.

Preserve momentum.

Avoid artificial auto-centering while in FREE/PALM_PUSH mode.

---

# 14. Returning from PALM_PUSH to TRACK

When the user closes ring + pinky again:

- classify as TRACK,
- transition the relevant ball from `FREE` to `RECAPTURING`,
- smoothly pull it toward the finger's offset anchor,
- once close enough, return to `ANCHORED`.

Do not teleport.

The recapture itself should feel like magnetic energy.

If two balls exist:
- use stable ball-to-hand assignment,
- in one-hand dual mode recapture A to index and B to middle.

---

# 15. Z / Depth Response

The user wants the apparent distance to the camera to affect ball size.

Closer hand:
- ball grows somewhat.

Farther hand:
- ball shrinks somewhat.

Do NOT make size changes extreme.

This should enhance depth perception, not dominate the effect.

---

# 16. Depth Estimation Strategy

Single-camera hand Z is noisy.

Use a robust combined approach.

### Primary signal
Apparent hand/palm size in the video.

For example:
- wrist → middle MCP distance,
- MCP hull size,
- palm bounding-box diagonal.

### Secondary signal
MediaPipe landmark Z if available and stable.

The current `RawHand` only keeps x/y.
Extend it to preserve `z`.

Suggested normalized depth scale:

```text
relativePalmScale = currentPalmSize / baselinePalmSize
depthScaleTarget = 1 + depthScaleStrength * (relativePalmScale - 1)
```

Optionally combine a smoothed normalized Z correction.

Clamp the result.

### Required tunables
- `depthScaleEnabled`
- `depthScaleStrength`
- `depthMinScale`
- `depthMaxScale`
- `depthSmoothing`

Suggested initial bounds:
- min scale ≈ 0.75
- max scale ≈ 1.35

Do not let temporary tracking spikes abruptly resize the ball.

---

# 17. Depth Baseline

When a stable hand is first tracked:
- record a baseline palm size.

Allow gradual baseline adaptation only if necessary.

Optional debug action:
- `Reset Depth Baseline`

This is useful because webcams, phones and camera fields-of-view differ.

---

# 18. Depth and Physics Radius

Be careful about changing physical radius every frame.

Preferred approach:
- derive a smoothed `depthScale`,
- use it for visual/effective body radius,
- ensure collision and fusion calculations use the same effective radius.

Do not let rendering size and collision size disagree.

---

# 19. HANDGUN Gesture

The user wants a hand-gun pose that still behaves like normal index tracking until fired.

Suggested stable handgun pose:

```text
index  = extended
middle = closed
ring   = closed
pinky  = closed
thumb  = extended / armed
```

Because ring + pinky are closed, this overlaps TRACK.
Therefore HANDGUN has higher classifier priority.

Before firing:
- the ball follows the index finger using the normal offset/inertia system.

It should feel like charging/aiming the shot.

---

# 20. Shot Direction

Determine aim direction from the index finger geometry, preferably:

```text
index MCP (5) → index TIP (8)
```

or:

```text
index PIP (6) → index TIP (8)
```

Use the more stable option after testing.

Convert it into screen/world direction using the same camera mirror transform as rendering.

Normalize it.

The shot begins from the ball's CURRENT position.

Do not teleport the ball onto the ray origin.

---

# 21. Shot Trigger

A handgun pose by itself is only the aiming state.

We need a deliberate firing event.

Recommended gesture trigger:

### Thumb trigger
While HANDGUN pose is stable:
- thumb is initially extended/armed,
- user quickly folds/presses the thumb inward,
- crossing a normalized thumb-flex threshold triggers one shot.

Then:
- require the thumb to extend again before another shot,
- add a short cooldown.

This imitates a simple hammer/trigger action and avoids firing continuously.

If thumb-trigger reliability is poor, keep a development fallback:
- Space key or mouse click while in HANDGUN mode.

But the final intended control is the thumb gesture.

### Suggested tunables
- `shotSpeed`
- `shotHandVelocityInfluence`
- `shotCooldown`
- `gunGestureDwell`
- `thumbTriggerThreshold`

---

# 22. Shot Behavior

When fired:

```text
ANCHORED / HANDGUN_AIM
        ↓ trigger
SHOT
```

Apply:

```text
body.velocity =
aimDirection * shotSpeed
+ handVelocity * shotHandVelocityInfluence
```

The liquid should:
- stretch in the flight direction,
- trail behind,
- wobble,
- possibly shed small droplets,
- collide with PALM_PUSH hands,
- preserve zero-gravity motion.

Do not turn it into a simple projectile sprite.

---

# 23. Shot Lifetime / Bounds

A shot may leave the camera frame.

Do not allow hidden simulation to run forever.

Use a generous off-screen margin.

If the ball remains outside that margin for some duration:
- fade/end it,
- mark it available for a fresh spawn on the next TRACK/HANDGUN reacquire.

Suggested tunables:
- `freeBoundsMargin`
- `offscreenDespawnDelay`

---

# 24. Fluid Feel Improvements From v0.1 Review

These are required priorities in this pass.

## A. More deformation during normal movement

The current mass stays too spherical during ordinary movement.

Increase the useful midrange.

Slow motion:
- mostly round.

Medium:
- clearly asymmetric and subtly stretched.

Fast:
- pronounced lag/stretch/tail.

Violent:
- tear-off droplets.

Do not wait until extreme speed before shape change becomes visible.

---

# 25. Use Attachment Tension in Shape

The current core elongation is largely velocity-driven.

Add significant influence from:

```text
anchorTarget - bodyCenter
```

This is especially important in ANCHORED mode.

The liquid should visibly lean/stretch toward the invisible control point.

Suggested tunable:
- `tetherDeformInfluence`

This should coexist with:
- velocity influence,
- acceleration influence,
- surface-point dynamics.

---

# 26. Reduce Central Metaball Dominance

The current large central metaball hides some ring/surface deformation.

Adjust the metaball composition so:
- outer surface points influence the silhouette more,
- the center still preserves continuity,
- the body remains stable,
- deformation actually appears in the rendered iso-surface.

Possible changes:
- slightly smaller center support,
- altered center weight,
- slightly stronger ring weights,
- more anisotropic center only when needed.

Do not destabilize the resting shape.

Add or update calibration as needed.

---

# 27. Volume-Preserving Stretch

When the core is stretched along movement/tension direction:
- reduce perpendicular thickness.

A stretched liquid should not gain obvious area/volume.

If current ellipse transform uses:

```text
parallel / stretch
perpendicular * sqrt(stretch)
```

verify the area/field behavior visually and mathematically.

The silhouette should feel like:
- same liquid amount,
- different shape.

---

# 28. Surface-Based Fusion Trigger

Current fusion logic is based primarily on anchor/finger distance.

Change the visually meaningful contact logic to use the liquid bodies.

Preferred metric:

```text
centerDistance
-
(effectiveRadiusA + effectiveRadiusB)
```

or a better estimated iso-surface gap.

Use:
- anchors for user intent / broad attraction gating if useful,
- body/surface proximity for CONTACT and merge confirmation.

Goal:

> If the user sees the two fluids touch, the state machine should also believe they are touching.

Do not let visible overlap persist for seconds without logical contact.

---

# 29. Fusion Attraction Neck

Before fusion, Blue and Red should visibly reach toward each other.

Desired progression:

```text
🔵        🔴

🔵>      <🔴

 🔵>----<🔴

  blue → violet → red bridge

     fusion
        🟣
```

Use extra/bridge metaballs if needed.

The bridge must be dynamic:
- follows current body positions,
- increases with attraction/contact progress,
- disappears if they separate before fusion.

Do not create a fixed straight line graphic.

---

# 30. Continuous Fusion Color Mixing

Current body identity/color weighting can be improved.

Allow bridge/metaball samples to have a continuous mix value:

```text
0.0 = blue
0.5 = purple
1.0 = red
```

Or another clear representation.

Then the neck can render as a smooth gradient:
- blue,
- violet,
- magenta,
- red.

This is preferable to abruptly coloring whole bodies purple.

---

# 31. Droplet Visual Redesign

The droplet physics are good, but visually small droplets currently read too much like mini glowing magic balls.

For small droplets:
- reduce rim brightness,
- reduce glow,
- increase transparency/refraction slightly,
- allow mild irregularity/wobble,
- keep some velocity stretch.

They should read as:
> pieces of liquid torn from the main body.

Not:
> separate particle sprites.

---

# 32. Fusion Droplet Direction

Current fusion micro-droplets are emitted around a broad radial ring.

Make the burst less uniformly radial.

Bias some droplets by:
- incoming body velocities,
- collision axis,
- local surface tear directions.

Keep a small radial component for impact.

The result should look like fluid being ripped/compressed, not a perfect particle explosion.

---

# 33. Reduce “Glass Marble” Bias

Keep the magical energy identity, but make the shader more liquid-first.

Target:
- clearer moving silhouette,
- slightly softer/thinner rim,
- restrained outer glow,
- stronger refraction/translucency,
- visible internal flow,
- less perfect spherical highlight.

Do not remove all glow.
Do not turn it into ordinary transparent water.

The intended look is:
> luminous supernatural liquid.

---

# 34. Physics-Reactive Internal Turbulence

Optional after silhouette work is complete.

The current internal noise mostly moves with time.

Add subtle directional response to:
- velocity,
- acceleration,
- impact impulse.

Example:
- fast rightward motion biases flow rightward,
- sudden stop lets internal flow continue briefly,
- palm impact creates a short swirl/compression disturbance.

Keep this secondary to silhouette quality.

---

# 35. Faster Control Point, Heavy Main Body

The tracker currently benefits from smoothing, but a full-sample interpolation delay plus spring lag can feel overly delayed.

Split the visual hierarchy:

```text
raw hand
  ↓
stable but responsive control point
  ↓
offset anchor
  ↓
heavy fluid body
```

The offset anchor should be responsive.
The body should provide most of the visible lag.

Do not simply remove smoothing and reintroduce jitter.

Consider:
- mild prediction,
- lower-latency control-point filter,
- preserving stronger damping only in the liquid body.

---

# 36. Settings Export as a Real JSON File

The current app supports Copy/Load JSON.

Add:

- `Download Settings JSON`

Clicking it should download a file such as:

```text
zerog-settings.json
```

Suggested format:

```json
{
  "schemaVersion": 2,
  "settings": {
    "...": "all tunable values"
  }
}
```

Optional metadata:
- preset name,
- app version,
- exportedAt.

Do NOT put non-reproducible random state in this file.

---

# 37. Make Exported JSON Directly Usable as Repo Defaults

Refactor defaults so one exported file can become the source of truth.

Preferred architecture:

```text
src/config/default-settings.json
        ↓
sanitize/validate
        ↓
DEFAULT_SETTINGS
```

The downloaded JSON's `settings` object should match this schema.

Then a future coding agent can:
1. receive the user's exported JSON,
2. replace/update `src/config/default-settings.json`,
3. run tests/typecheck/build,
4. commit those values as the new defaults.

If moving all defaults to JSON creates unnecessary TypeScript friction, use an equivalent clean method, but keep the user's exported schema directly compatible with the source defaults.

---

# 38. Optional Developer Script for Applying Defaults

Nice to have:

```text
npm run apply-settings -- path/to/zerog-settings.json
```

The script should:
- validate the file,
- extract `settings`,
- sanitize/clamp,
- write the canonical default settings JSON,
- fail clearly on incompatible schema version.

Do not let this feature delay the interaction work.

---

# 39. New Tuning Controls

Add these settings or equivalent:

## Spawn / Anchor
- `fingerGap`
- `spawnGrowDuration`
- `tetherDeformInfluence`

## Depth
- `depthScaleEnabled`
- `depthScaleStrength`
- `depthMinScale`
- `depthMaxScale`
- `depthSmoothing`

## Palm interaction
- `palmColliderPadding`
- `palmImpulseStrength`
- `palmRestitution`
- `palmFriction`
- `palmVelocityInfluence`

## Recapture
- `recaptureStrength`
- `recaptureDamping`
- `recaptureDistance`

## Shot
- `shotSpeed`
- `shotHandVelocityInfluence`
- `shotCooldown`
- `gunGestureDwell`
- `thumbTriggerThreshold`
- `offscreenDespawnDelay`
- `freeBoundsMargin`

## Gesture stability
- `gestureEnterDwell`
- `gestureExitDwell`

Do not expose meaningless micro-parameters unless they genuinely help tuning.

---

# 40. Debug Overlay Additions

Add:

- per-hand gesture label,
- ring open/closed state,
- pinky open/closed state,
- handgun armed/trigger state,
- palm center,
- palm collider polygon/capsules,
- palm velocity vector,
- current body control state (`ANCHORED/FREE/SHOT/RECAPTURING`),
- depth raw signal,
- smoothed depth scale,
- offset anchor target,
- finger direction vector,
- fusion surface-gap value,
- shot aim ray when in HANDGUN mode.

Make each debug layer visually distinct but simple.

---

# 41. Mouse / Script Test Support

Real gestures are hard to automate.

Extend mouse/script testing so all new physics can be tested without a camera.

Required developer/test controls:
- simulate TRACK,
- simulate PALM_PUSH,
- move a palm collider,
- launch a shot,
- test recapture,
- test depth scaling using a synthetic slider/script,
- test spawn,
- test two-hand volley,
- test surface-based fusion.

Automated tests should exercise the physics/state logic independently from MediaPipe.

---

# 42. Required New Tests

Add tests for at least:

## Spawn
- first acquisition spawns in place,
- starts near zero size/presence,
- reaches full size after `spawnGrowDuration`,
- no off-screen fly-in.

## Finger gap
- offset target is in finger direction,
- gap scales correctly,
- mirror transform does not reverse the intended direction incorrectly.

## Gesture classifier
- TRACK pose,
- PALM_PUSH pose,
- HANDGUN pose,
- priority resolution,
- dwell/hysteresis,
- no rapid flicker around thresholds.

## Free/palm physics
- anchored → free transition preserves velocity,
- palm collision transfers momentum,
- ball can bounce from two palms,
- free mode has no hidden spring pulling it back.

## Recapture
- no teleport,
- reaches the new anchor smoothly.

## Depth
- larger palm signal increases body scale,
- clamp works,
- smoothing rejects spikes.

## Shot
- shot direction matches index direction,
- firing preserves current body position,
- shot speed is applied,
- cooldown/re-arm works,
- off-screen cleanup works.

## Fusion
- CONTACT reflects body/surface gap,
- visible body contact can trigger contact even if anchor positions differ.

## Settings
- export JSON round-trip,
- downloaded schema matches canonical defaults structure.

---

# 43. Recommended Work Order

Do not implement everything at once.

## Phase 1 — Anchor quality
1. finger gap
2. correct spawn-in-place
3. spawn grow duration
4. faster control point / heavy body hierarchy
5. depth scale

Verify before gestures.

## Phase 2 — Fluid feel
1. tether-direction deformation
2. reduce central metaball dominance
3. improve medium-speed deformation
4. volume-preserving stretch
5. droplet rendering improvements
6. reduce marble/glow bias

Verify Purple Sandbox for at least 20 seconds of movement.

## Phase 3 — Gesture classifier
1. robust finger open/closed model
2. TRACK
3. PALM_PUSH
4. HANDGUN
5. dwell/hysteresis
6. debug labels

Do not connect gestures to complex physics until classification is stable.

## Phase 4 — Palm play
1. FREE state
2. palm collider
3. collision impulse
4. impact deformation
5. two-hand volley
6. recapture

## Phase 5 — Handgun
1. aim
2. thumb trigger
3. SHOT state
4. shot liquid motion
5. palm collision after shot
6. off-screen cleanup

## Phase 6 — Fusion upgrade
1. surface/body contact metric
2. attraction neck
3. continuous color mixing
4. less-radial fusion droplets

## Phase 7 — JSON defaults workflow
1. download JSON
2. canonical default-settings JSON
3. validation/round-trip
4. optional apply-settings script

---

# 44. Acceptance Experience

A good v0.2 should allow this sequence:

### A. Spawn
User raises one hand in TRACK pose.

Purple:
- appears at the configured distance beyond the index tip,
- starts as a tiny invisible/near-zero dot,
- grows smoothly into a ball,
- never flies in from off-screen.

### B. Normal tracking
User moves the finger.

Purple:
- follows with inertia,
- visibly deforms at medium speed,
- maintains the user-selected gap,
- changes size subtly as the hand moves closer/farther.

### C. Palm play
User opens ring + pinky.

Purple:
- releases from the finger,
- becomes free,
- can be physically pushed by the palm.

Second hand opens:
- receives/collides with the ball,
- can hit it back.

### D. Recapture
User returns to TRACK.

Purple:
- is pulled back smoothly,
- reconnects to the offset index target,
- does not teleport.

### E. Handgun
User forms the handgun pose.

Purple:
- tracks the index in aiming mode.

User performs thumb trigger:
- Purple launches from its current location,
- travels along the pointing direction,
- visibly stretches from speed,
- can hit/push off the other hand.

### F. Fusion
Blue and Red:
- visibly attract,
- their surfaces stretch toward each other,
- bridge colors blend blue → violet → red,
- contact logic matches visible contact,
- they fuse into Purple.

---

# 45. Non-Goals for v0.2

Do not spend this pass on:
- new unrelated filters,
- accounts/backend,
- multiplayer,
- AR world anchors,
- full hand segmentation,
- perfect hand occlusion,
- scientific fluid simulation,
- mobile app packaging,
- elaborate sound design,
- production analytics.

The purpose of v0.2 is:
> make this one energy-liquid toy feel excellent.
