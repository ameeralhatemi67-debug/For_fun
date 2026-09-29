# Opus Implementation Prompt — Zero-G Energy v0.2

You are continuing an existing working project in:

`For_fun/game2`

Do NOT rebuild it from scratch.

First read, in this order:

1. `ZeroG_Energy_Web_Prototype_SPEC.md`
2. `STATUS.md`
3. `TUNING.md`
4. `ZeroG_Energy_Interaction_SPEC_v0.2.md`
5. the current source and tests

Treat `ZeroG_Energy_Interaction_SPEC_v0.2.md` as the authoritative change request for this run when it overrides older behavior.

The current prototype already works. Your task is to evolve it into v0.2 while preserving the good architecture and working features.

---

## Core Objective

The current build proves the architecture, but the fluid still often reads as a glowing marble.

This run should make the experience feel like a playful zero-gravity liquid object with:

- a configurable gap beyond the fingertip,
- correct spawn-in-place growth,
- depth-responsive scale,
- stronger midrange liquid deformation,
- palm-push/free-ball interaction,
- two-hand volleying,
- handgun aiming + thumb-trigger shooting,
- surface-based fusion behavior,
- improved fusion neck/color mixing,
- and downloadable settings JSON that can directly become future repo defaults.

Do not add another filter.

---

# Working Style

You have authority to make reasonable implementation decisions without asking me.

Spend the run on implementation, browser verification, tuning, and tests.

Do not stop after writing a plan.

Do not claim visual quality you did not inspect.

Preserve:
- camera mode,
- mouse mode,
- scripted motions,
- recording,
- tuning panel,
- debug mode,
- Blue/Red/Purple system,
- existing useful tests.

Refactor where necessary, but avoid unrelated cleanup.

---

# Required Implementation Order

## 1. Finger offset + spawn first

Implement and verify:

### Finger gap
The liquid must sit beyond the fingertip along the finger's pointing direction.

Add a live slider:
- `fingerGap`

Use hand geometry such as index DIP/PIP/MCP → index TIP.

Mouse/script mode must emulate a useful pointing direction.

### Spawn
A genuinely new/reacquired body must:
- spawn at the correct current anchor location,
- start effectively invisible/tiny,
- grow to normal size,
- never fly in from off-screen.

Add:
- `spawnGrowDuration`

Brief tracking loss must continue using existing prediction and must not trigger a new spawn.

Verify these visually before continuing.

---

## 2. Add depth response

Extend hand data to retain Z if useful.

Prefer apparent palm size as the robust primary depth signal and normalized landmark Z only as a secondary signal.

Add:
- `depthScaleEnabled`
- `depthScaleStrength`
- `depthMinScale`
- `depthMaxScale`
- `depthSmoothing`

Closer hand should make the liquid moderately larger.
Farther hand should make it moderately smaller.

Use the same effective radius for rendering, collisions and fusion calculations.

Add debug readouts.

Do not allow depth jitter to make the body pulse.

---

## 3. Improve the liquid silhouette

Before adding gesture physics, improve Purple Sandbox.

Required changes:

- deformation must become visible at medium movement speeds,
- use `(offsetAnchorTarget - fluidCenter)` as a major deformation input,
- reduce the visual dominance of the central metaball,
- let the ring/surface points affect the silhouette more strongly,
- preserve apparent liquid volume while stretching,
- keep a clear air gap from the finger,
- make droplets look more like torn liquid and less like tiny glowing orbs,
- slightly reduce the "glass marble" bias of the rim/glow.

Do not solve this by merely increasing blur/glow.

Use the existing lightweight metaball/spring architecture.
Do not add a scientific fluid solver.

Run the scripted sweep/stop/reverse/circle/shake tests and visually inspect them.

---

## 4. Build a dedicated gesture classifier

Create a clean gesture module rather than embedding gesture conditions throughout `EffectController`.

Required semantic states per hand:

- `TRACK`
- `PALM_PUSH`
- `HANDGUN`
- `NEUTRAL`

Priority:
`HANDGUN > PALM_PUSH > TRACK > NEUTRAL`

Rules:

### TRACK
ring closed + pinky closed

### PALM_PUSH
ring open + pinky open

### HANDGUN
index extended,
middle closed,
ring closed,
pinky closed,
thumb extended/armed

Use normalized joint geometry / angles.
Do not rely on one screen-axis comparison.

Add entry/exit dwell/hysteresis so poses do not flicker.

Expose classifier state and useful finger-state diagnostics in Debug.

Add unit tests using synthetic landmark poses where practical.

---

## 5. Implement control states

Add a body-level control state such as:

- `ANCHORED`
- `FREE`
- `SHOT`
- `RECAPTURING`

Keep this separate from the Blue/Red fusion state machine.

### TRACK
Ball is ANCHORED to fingertip offset.

### PALM_PUSH
Release the ball into FREE state.

### Returning to TRACK
Use RECAPTURING.
Do not teleport.
Magnetically/spring-pull the body back to the finger anchor, then switch to ANCHORED.

Preserve current velocity across transitions where physically sensible.

---

## 6. Implement palm physics

Build a lightweight palm collider from landmarks around:

- wrist 0
- MCP 5
- MCP 9
- MCP 13
- MCP 17

Use a stable convex polygon, capsules, or another robust 2D approximation.

Track palm center + palm velocity.

When a FREE/SHOT liquid hits a PALM_PUSH hand:

- resolve penetration,
- transfer palm velocity,
- bounce with tunable restitution,
- preserve some tangential motion,
- add local fluid deformation/squash,
- optionally emit a small droplet at high impact.

Add tunables:
- `palmColliderPadding`
- `palmImpulseStrength`
- `palmRestitution`
- `palmFriction`
- `palmVelocityInfluence`

The ball must be able to move from Hand A to Hand B and be hit back.

Do not auto-attach the ball to an open palm.

Extend mouse/script mode to emulate moving palm colliders so this can be tested without a webcam.

---

## 7. Implement handgun aiming and firing

While HANDGUN is stable:

- before firing, the ball behaves like normal fingertip tracking at the configured gap,
- show an aim ray in Debug only.

Aim direction:
prefer index MCP/PIP → index TIP.

### Trigger
Use thumb motion:
- gun pose starts armed with thumb extended,
- folding/pressing thumb inward past a stable normalized threshold fires one shot,
- require thumb to extend again to re-arm,
- enforce cooldown.

Keep Space/click as a developer fallback if useful.

Add:
- `shotSpeed`
- `shotHandVelocityInfluence`
- `shotCooldown`
- `gunGestureDwell`
- `thumbTriggerThreshold`

On fire:
- keep the body at its CURRENT location,
- preserve/add appropriate current momentum,
- apply strong velocity along the aim direction,
- switch to SHOT/free physics,
- retain liquid deformation/droplets,
- allow the shot to collide with PALM_PUSH hands.

If it remains off-screen beyond a margin/delay, fade/end it cleanly.

---

## 8. Upgrade fusion contact and visuals

The current fusion state machine is structurally good.
Keep it.

Change what drives contact.

Use effective body/surface proximity for CONTACT/merge rather than only fingertip anchor distance.

The user's visual experience must match the logic:
if the liquid surfaces visibly touch, logical contact should occur.

Add a dynamic attraction neck/bridge between Blue and Red during late attraction/contact.

The neck should:
- be made from the same metaball field,
- react to current body positions,
- disappear if the bodies separate,
- smoothly blend blue → violet/purple → red.

Refactor blob color ownership if needed so bridge elements can carry continuous mix values rather than binary body identity.

Improve fusion droplets:
- less perfectly radial,
- biased partly by incoming velocities/collision axis.

Do not replace the existing hysteresis/contact-time/cooldown system unless necessary.

---

## 9. Settings JSON workflow

Keep Copy/Load JSON.

Add:
- `Download Settings JSON`

The file should contain a stable schema such as:

```json
{
  "schemaVersion": 2,
  "settings": { "...": "..." }
}
```

Refactor the repo so that the exported `settings` object can become the canonical source defaults with minimal manual work.

Preferred:
`src/config/default-settings.json`

Then `DEFAULT_SETTINGS` should be validated/sanitized from that data.

If practical, add:

`npm run apply-settings -- path/to/zerog-settings.json`

This should validate and update the canonical defaults.

Do not spend disproportionate time on this if the interaction work needs tuning.

---

# Ball Assignment Rules

Preserve these rules:

## Purple / one ball
Primary index anchor.

## Blue + Red with two hands
- Hand A index → Ball A
- Hand B index → Ball B

## Blue + Red with one hand
- index → Ball A
- middle → Ball B

Only use fingertip anchoring while the hand is in TRACK/HANDGUN aim mode.

In PALM_PUSH mode, the hand is a collider, not an anchor.

Maintain stable hand identity.

---

# New Debug Information

Add:

- current semantic gesture per hand,
- ring state,
- pinky state,
- thumb armed/trigger state,
- body control state,
- finger direction,
- offset anchor target,
- palm collider,
- palm velocity,
- depth raw value,
- smoothed depth scale,
- surface-gap value used by fusion,
- handgun aim ray.

Keep Debug hideable for recording.

---

# Testing Requirements

Update automated tests.

At minimum verify:

### Anchor/spawn
- offset direction,
- configurable gap,
- spawn in place,
- spawn growth timing,
- no off-screen fly-in.

### Gestures
- TRACK,
- PALM_PUSH,
- HANDGUN,
- priority,
- dwell/hysteresis.

### Depth
- close hand grows,
- far hand shrinks,
- clamp,
- smoothing.

### Free/palm
- release preserves motion,
- no hidden tether in FREE,
- palm collision transfers momentum,
- two-hand volley possible,
- recapture does not teleport.

### Shot
- aim direction,
- current-position launch,
- shot velocity,
- thumb re-arm,
- cooldown,
- off-screen cleanup.

### Fusion
- body/surface contact metric,
- visible contact state consistency.

### Settings
- JSON download schema / round trip,
- canonical default compatibility.

Run:
- tests,
- typecheck,
- production build.

---

# Browser Verification

Actually inspect the page.

Use camera if available.
If camera cannot be tested in your environment, use mouse/script modes to verify physics and document the limitation precisely.

Required scripted/manual scenarios:

1. Purple spawn.
2. Slow fingertip tracking.
3. Medium sweep.
4. Fast sweep.
5. Abrupt stop.
6. Reversal.
7. Depth grow/shrink.
8. Release into palm mode.
9. Push free ball.
10. Ball hits opposite palm.
11. Volley back.
12. Recapture.
13. Handgun aim.
14. Thumb/click shot.
15. Shot hits palm.
16. Blue/Red approach.
17. Visible liquid contact.
18. Attraction neck.
19. Fusion.
20. Settings JSON download and reload.

Inspect for console errors.

---

# Tuning Philosophy

Do not aggressively tune every parameter at once.

Focus in this order:

1. finger gap + spawn,
2. normal Purple motion,
3. medium-speed deformation,
4. depth stability,
5. gesture reliability,
6. palm collision feel,
7. shooting feel,
8. fusion contact/neck,
9. shader polish.

The highest-value test remains:

> Is simply moving one Purple liquid ball around for 20 seconds fun to watch?

If not, keep improving that before declaring the pass complete.

---

# Documentation

Update:

`STATUS.md`
- v0.2 checkpoint reached
- what works
- what remains
- real-camera testing status
- known issues
- exact controls
- next recommended work

`TUNING.md`
- all new controls
- recommended first knobs
- gesture thresholds
- palm/shot parameters
- depth parameters
- current default values

Do not overwrite the old spec.
Keep the v0.2 spec as a separate historical/design document.

---

# Final Report

At the end of the run report:

1. what was implemented,
2. files/modules added or significantly changed,
3. tests/build results,
4. browser scenarios verified,
5. whether real hand gestures were tested or only simulated,
6. current gesture rules,
7. how palm push works,
8. how handgun firing works,
9. how depth scale is calculated,
10. how to download the settings JSON,
11. which 5–10 sliders I should tune first,
12. remaining visual issues you can still see,
13. whether you believe the Purple fluid feel is ready for the next critique video.

Leave the repo runnable and clean.
