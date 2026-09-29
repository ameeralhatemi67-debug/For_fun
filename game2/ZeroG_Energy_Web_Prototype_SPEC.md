# Zero-G Energy Web Prototype — Product & Technical Specification v0.1

## 1. Purpose

Build a browser-based interactive camera effect that makes colored energy behave like a small mass of liquid suspended in zero gravity and physically tethered to a user's fingertip.

The prototype is inspired by the visual idea of combining a blue energy mass and a red energy mass into a purple one, but it must be an original implementation. Do not use copyrighted footage, character art, logos, anime frames, ripped visual assets, or copied audio.

The purpose of this first website is not to ship a production app. It is to create a fast, highly tunable visual prototype that can be tested on a webcam/phone, screen-recorded, reviewed, and iterated on.

The most important success criterion is **motion quality**.

If the fluid motion does not feel convincing, adding more effects is not progress.

---

## 2. Core Experience

The camera fills the viewport.

A tracked fingertip acts as an invisible anchor for a floating energy-fluid mass.

The mass must NOT be rigidly glued to the fingertip.

Instead, it should behave like a zero-gravity water droplet connected to the fingertip by an invisible elastic tether:

- it lags slightly behind fast finger movement,
- stretches in the direction opposite acceleration,
- overshoots slightly after abrupt stops,
- wobbles and settles,
- prefers to return to a compact rounded shape,
- can shed small droplets during high-speed movement,
- and may later pull those droplets back into itself.

The final experience should feel playful and tactile.

---

# 3. Prototype Modes

Build the project in stages.

## Mode A — Purple Sandbox

This is the highest-priority mode and must work well before the fusion sequence is considered finished.

A purple zero-gravity liquid mass follows one tracked fingertip.

Required behavior:

1. Detect a hand.
2. Track a chosen fingertip.
3. Convert the fingertip location into a stable screen-space target.
4. Feed the target into a spring/inertia simulation.
5. Render a deformable purple fluid mass at the simulated position.
6. Deform the fluid based on acceleration and velocity.
7. Allow small droplets to separate during sufficiently aggressive movement.
8. Let detached droplets either:
   - slowly fade, or preferably
   - get gently attracted back and merge with the main mass.
9. Add subtle idle motion so the mass does not look frozen when the finger is still.

This mode is the foundation of the whole project.

---

## Mode B — Blue + Red Fusion

Once Mode A feels good:

- Blue energy is assigned to Anchor A.
- Red energy is assigned to Anchor B.
- Each mass uses the same fluid/inertia system.
- When they are far apart, they behave independently.
- When they enter an attraction radius, each mass begins stretching toward the other.
- Attraction should gradually increase as distance decreases.
- Use hysteresis so the state does not flicker at threshold boundaries.
- When they cross a merge threshold, trigger a fusion event.
- The two fluid fields collapse/merge into a purple mass.
- Purple becomes attached to the primary anchor, normally Anchor A.
- Give the fusion a short stylized impulse:
  - compression,
  - bright core pulse,
  - outward micro-droplets,
  - optional circular distortion/shock ring.
- After fusion, return to the normal Purple Sandbox physics.

Do NOT make the merge a simple instant color swap.

The user should visually feel:
**approach → attraction → deformation → contact → compression → purple release.**

---

# 4. Finger / Anchor Assignment

Make anchor logic explicit and easy to change.

Preferred behavior:

### One-hand mode
- Anchor A = index fingertip.
- Anchor B = middle fingertip.

### Optional two-hand mode
If two hands are confidently tracked:
- Anchor A = index fingertip of one hand.
- Anchor B = index fingertip of the other hand.

Do not rely only on array order because detector ordering can change.

Create a small tracking layer that attempts to preserve stable hand identity over time.

Expose anchor selection in the debug panel if practical.

For MediaPipe-style landmark numbering:
- index fingertip = landmark 8
- middle fingertip = landmark 12

---

# 5. Recommended Technical Stack

Prefer a simple frontend-only architecture.

## Application
- Vite
- React
- TypeScript

## Hand tracking
Prefer:
- MediaPipe Tasks Vision / Hand Landmarker for browser-based landmark tracking

Avoid writing custom computer-vision code.

## Rendering
Prefer:
- Three.js
- WebGL
- custom ShaderMaterial / GLSL for the energy-fluid surface

The effect is visually 2D/2.5D over a camera feed; do not build an unnecessary full 3D world.

## State
Use plain React state, refs, or a tiny local state layer.
Do not introduce a large state-management library unless genuinely needed.

## Backend
None.

No authentication.
No database.
No cloud service.
No API server.

Everything should run locally in the browser.

---

# 6. Rendering Architecture

Use a layered mental model:

Camera video
↓
hand tracking / landmark layer
↓
physics simulation
↓
fluid/metaball render
↓
glow / distortion / particles
↓
UI

Prefer rendering the final camera and effect into one composited canvas if it remains practical, because that makes recording easier.

A direct video background plus transparent WebGL overlay is acceptable for the first milestone if it is substantially more reliable.

---

# 7. Fluid Representation

Do NOT implement a scientifically accurate fluid solver.

Do NOT use a heavy Navier–Stokes, FLIP, or full SPH simulation for this prototype.

The goal is perceptual fluidity, not physical accuracy.

Use a lightweight approximation such as:

- metaballs,
- signed-distance fields,
- connected blob particles,
- spring-connected sub-particles,
- or a hybrid of those.

A good starting model is:

- one central simulated mass,
- several attached secondary mass points,
- a short position/velocity history,
- detached droplet particles,
- a shader that blends these into one continuous-looking surface.

The surface should naturally look round at rest and elongated while moving.

---

# 8. Main Physics Model

The tracked fingertip is a target, not the actual orb position.

At a conceptual level:

```text
target = tracked fingertip
error = target - fluidCenter

springForce = error * stiffness
dampingForce = -velocity * damping

acceleration = springForce + dampingForce
velocity += acceleration * dt
fluidCenter += velocity * dt
```

Use a frame-rate-independent timestep.

Clamp extreme `dt` values after tab switching or dropped frames.

Expose important values as live tuning controls.

---

# 9. Motion Characteristics

## Slow movement
The fluid remains mostly compact and closely follows the finger.

## Medium movement
The mass should slightly lag and elongate.

## Fast movement
The mass should:
- lag more,
- stretch,
- develop a trailing tail,
- possibly shed small droplets.

## Abrupt stop
The mass should overshoot slightly and then settle.

## Direction reversal
The existing momentum should briefly carry the mass in its previous direction before the spring pulls it back.

## Stationary finger
The mass should not be perfectly static.

Add subtle, low-frequency internal wobble/noise.

The result should feel alive, not noisy.

---

# 10. Surface Tension Approximation

The liquid should always have a tendency to become compact again.

Possible approaches:

- springs pulling secondary blob points toward the center,
- positional constraints,
- metaball attraction,
- distance-restoring forces,
- a shape-restoring term derived from speed/acceleration.

Do not let a high-speed stretch permanently deform the blob.

The settle motion is part of the visual appeal.

---

# 11. Droplet Shedding

Small detached pieces should appear only under meaningful motion.

Possible trigger inputs:
- speed,
- acceleration,
- jerk / change in acceleration,
- current deformation amount.

Avoid a simple constant particle emitter.

A droplet should inherit:
- current fluid velocity,
- some tangential/random offset,
- a fraction of the main fluid color/brightness.

Keep the count bounded.

Preferred behavior:
- detached droplets remain visible briefly,
- wobble,
- slow,
- then gently get re-attracted to the main mass,
- visually merge when close enough.

If reliable re-merging is too expensive for the first implementation, fading droplets is acceptable as a temporary fallback, but document it.

---

# 12. Purple Visual Design

The purple mass should read as luminous, energetic fluid rather than a flat circle.

Suggested layers:

1. dark violet/deep-purple body,
2. brighter purple/magenta inner region,
3. occasional cool blue variation,
4. bright but thin luminous edge,
5. animated internal procedural turbulence,
6. subtle bloom/glow,
7. small amount of camera-background distortion or refraction around the surface if practical.

Avoid:
- giant blurry glow hiding the shape,
- a perfectly circular gradient,
- excessive lightning,
- noisy particles everywhere,
- a cartoon outline that never changes with the fluid.

The silhouette and motion matter more than glow.

---

# 13. Blue and Red Visual Design

Blue and Red should use the same underlying physics.

They can have slightly different personalities later, but do not create separate physics systems initially.

Possible later personality tuning:

### Blue
- slightly calmer,
- denser,
- cool internal flow.

### Red
- slightly more active/aggressive,
- stronger pulsation,
- warmer internal turbulence.

This differentiation is optional for the prototype.

---

# 14. Fusion State Machine

Implement fusion as explicit states.

Suggested states:

```text
IDLE
DUAL
ATTRACTING
CONTACT
FUSING
PURPLE
RECOVERING
```

Example transitions:

```text
DUAL
  ↓ distance < attractionThreshold
ATTRACTING
  ↓ distance < mergeThreshold for minimumStableTime
CONTACT
  ↓
FUSING
  ↓ fusion animation completed
PURPLE
```

Add:
- hysteresis,
- cooldown,
- minimum contact duration,
- confidence checks.

This prevents accidental rapid state switching due to tracking jitter.

---

# 15. Tracking Stability

Raw hand landmarks must not be used blindly.

Implement:

- smoothing,
- velocity estimation,
- confidence-aware behavior,
- short prediction during brief tracking loss,
- reconnecting without sudden teleportation.

If tracking disappears for a very short time:
- continue from last known position/velocity for a small grace period.

If tracking remains lost:
- smoothly decay/fade the effect rather than instantly deleting it.

When tracking returns:
- reacquire smoothly.

Do not allow the fluid to jump across the screen because a landmark briefly changed identity.

---

# 16. Camera Mirroring

Selfie camera behavior must feel natural.

The displayed camera will likely be mirrored.

Make sure tracking coordinates and render coordinates use the same transform.

Provide a debug toggle:
- Mirrored
- Non-mirrored

This will help diagnose alignment problems.

---

# 17. Development Fallback: Mouse Simulation Mode

This is required.

The project must be usable even when:
- camera permission is unavailable,
- hand tracking fails,
- the coding agent is running automated browser tests,
- or the developer is tuning physics without a hand in front of a webcam.

Mouse mode:

- mouse / pointer position = Anchor A,
- optionally hold a key or use a second pointer control for Anchor B,
- allow dragging two on-screen anchor handles in fusion mode.

The exact UX can be simple.

The purpose is to make physics and rendering independently testable.

---

# 18. Debug / Tuning Panel

This is a core feature, not an afterthought.

Create a collapsible desktop/mobile-friendly panel.

At minimum expose:

## Tracking
- landmark smoothing
- prediction/grace duration
- tracking confidence threshold
- mirror toggle

## Main fluid physics
- stiffness
- damping
- mass / responsiveness if used
- max lag
- velocity influence
- acceleration influence
- settle strength

## Shape
- base radius
- deformation strength
- tail length
- number of secondary blob points
- surface tension
- idle wobble amount
- idle wobble speed

## Droplets
- enable/disable
- emission speed threshold
- acceleration threshold
- max droplet count
- min/max droplet size
- droplet lifetime
- attraction-back strength
- merge radius

## Fusion
- attraction radius
- attraction strength
- merge radius
- minimum contact time
- compression duration
- fusion impulse
- fusion cooldown

## Rendering
- core brightness
- edge brightness
- glow intensity
- glow radius
- turbulence amount
- turbulence speed
- refraction/distortion strength if implemented

The panel should show numeric values beside sliders.

---

# 19. Preset Export / Import

This is extremely important for iteration.

Add buttons:

- Copy Settings JSON
- Load Settings JSON
- Reset Defaults

Persist the latest settings in `localStorage`.

The copied JSON should contain all tunable physics/render values.

This allows a tester to send the exact settings alongside a video.

Example:

```json
{
  "springStiffness": 18,
  "damping": 7.5,
  "deformation": 0.72,
  "surfaceTension": 0.84,
  "dropletThreshold": 1.9
}
```

Use clear property names.

---

# 20. Debug Overlay

When debug mode is enabled, optionally show:

- detected hand landmarks,
- chosen fingertip anchor,
- raw target position,
- smoothed target position,
- simulated fluid center,
- velocity vector,
- FPS,
- approximate tracking FPS,
- tracking confidence,
- current effect state,
- current anchor distance,
- number of active droplets.

This overlay must be removable for clean recording.

---

# 21. UI / UX

Keep UI intentionally minimal.

## Main view
- full-screen camera
- fluid effect
- small status indicator

## Controls
Possible bottom controls:

- Purple Sandbox
- Fusion
- Settings
- Debug
- Record (optional later)

Provide a “Showcase Mode” that hides all developer UI.

Keyboard shortcuts on desktop are welcome, for example:
- D = debug
- S = settings
- M = mirror
- R = reset effect

Document shortcuts.

---

# 22. Performance Goals

Primary target:
- modern desktop browser

Secondary target:
- modern mobile browser

Aim for:
- 60 FPS rendering when possible,
- at least visually smooth 30+ FPS under normal load.

Hand tracking does not need to execute at render-frame frequency if that harms performance.

Separate:
- render loop,
- physics loop,
- tracking updates.

The renderer should interpolate from the latest tracked target.

Avoid allocating large arrays or objects every frame.

Bound all particle counts.

Add basic adaptive quality if needed:
- reduced glow,
- fewer droplets,
- fewer metaballs.

Do not over-engineer adaptive quality before measuring.

---

# 23. Privacy

All camera processing should remain local in the browser.

Do not upload camera frames.

Display a short note:
“Camera processing runs locally in your browser.”

No analytics are necessary.

---

# 24. Mobile Considerations

Design for portrait orientation first.

Handle:
- camera permission,
- front-camera selection,
- viewport resizing,
- device pixel ratio,
- orientation changes.

Keep controls reachable with a thumb.

Do not let the tuning panel permanently cover most of the camera on mobile.

Remember that camera access generally requires a secure context such as HTTPS or localhost.

---

# 25. Occlusion — NOT Required Yet

Correct hand/effect occlusion would improve realism, but it is not part of the first core milestone.

Do not block the project on hand segmentation/depth.

Create an architecture that could later add:

```text
camera
→ hand mask / depth
→ energy layer
→ selected foreground hand pixels
```

But leave this for a later iteration unless the base effect is already excellent.

---

# 26. Sound — NOT Required Yet

Do not prioritize sound in the first prototype.

Later we may add:
- subtle energy hum,
- fluid tension sound,
- fusion transient,
- purple idle tone.

No copyrighted anime audio should be used.

---

# 27. Recording — Nice to Have

If practical after the core effect is stable, add a record button using browser recording APIs.

Preferred:
- capture the final composited visual,
- start/stop recording,
- download or save a WebM locally.

Do not allow recording work to delay the core motion system.

Screen recording externally is an acceptable first-test workflow.

---

# 28. Suggested Code Organization

One possible structure:

```text
src/
  app/
    App.tsx

  camera/
    CameraController.ts
    cameraTypes.ts

  tracking/
    HandTracker.ts
    LandmarkSmoother.ts
    AnchorResolver.ts
    trackingTypes.ts

  physics/
    SpringBody.ts
    FluidBody.ts
    DropletSystem.ts
    physicsTypes.ts

  effects/
    EffectController.ts
    EffectStateMachine.ts
    presets.ts

  render/
    Renderer.ts
    FluidMaterial.ts
    shaders/
      fluid.vert
      fluid.frag

  ui/
    ControlPanel.tsx
    DebugOverlay.tsx
    ModeBar.tsx

  config/
    defaults.ts
    schema.ts

  utils/
    math.ts
    timing.ts
```

This is a suggestion, not a requirement.

Keep boundaries clear:
tracking should not own rendering;
rendering should not own hand tracking;
physics should be testable without camera input.

---

# 29. Required Milestones

## Milestone 0 — Project Shell
- app runs
- camera permission works
- camera fills viewport
- mouse simulation mode works
- no console errors

## Milestone 1 — Tracking
- hand landmarks work
- chosen fingertip is stable
- debug overlay shows raw/smoothed positions
- camera mirroring is correct

## Milestone 2 — Purple Core
- purple body follows simulated position rather than raw fingertip
- visible inertia
- smooth settling
- deformation from velocity/acceleration
- subtle idle wobble

This is the first major quality checkpoint.

## Milestone 3 — Fluid Personality
- controlled tail/stretch
- droplet shedding
- bounded particle count
- return/reabsorption or documented fade fallback
- tuning controls complete
- settings export/import works

This is the second major quality checkpoint.

## Milestone 4 — Blue + Red
- two anchors
- independent blue/red fluid masses
- stable distance calculation
- attraction behavior
- no threshold flicker

## Milestone 5 — Fusion
- staged merge
- purple result
- primary-anchor transfer
- short visual impact
- stable reset/retry behavior

## Milestone 6 — Polish
Only after all previous milestones are stable:
- better internal turbulence
- refraction
- optional recording
- performance tuning
- showcase mode

---

# 30. Acceptance Tests

The implementation is not “done” because it compiles.

Manually test these motions:

1. Hold the finger still for 5 seconds.
2. Move it slowly left/right.
3. Sweep quickly across the camera.
4. Stop abruptly after a fast sweep.
5. Reverse direction suddenly.
6. Draw a circle.
7. Shake the finger gently.
8. Shake the finger aggressively.
9. Move partly out of frame and return.
10. Temporarily hide the hand.
11. Test bright lighting.
12. Test dimmer indoor lighting.
13. Test portrait mobile layout if available.

For fusion:
14. Slowly bring Blue and Red together.
15. Move them close but not close enough to merge.
16. Cross the threshold briefly.
17. Hold them together.
18. Pull them apart before contact time completes.
19. Perform fusion and then rapidly move the primary finger.
20. Reset and repeat.

Look specifically for:
- jitter,
- teleports,
- delayed/stuck tracking,
- unnatural rigid attachment,
- excessive goo stretching,
- particles exploding,
- frame drops,
- merge flicker,
- mismatch between camera and effect coordinates.

---

# 31. Quality Philosophy

Prioritize in this order:

1. tracking stability,
2. fluid motion,
3. silhouette/deformation,
4. fusion interaction,
5. shader beauty,
6. secondary particles,
7. UI polish.

A simple but beautifully moving blob is better than an elaborate effect that feels fake.

The effect should not simply follow the hand.
It should appear to have its own mass.

---

# 32. Out of Scope for v0.1

Do not add:

- accounts,
- cloud sync,
- backend,
- social network features,
- production analytics,
- complex filter marketplace,
- multiple unrelated effects,
- full 3D fluid solver,
- AR world tracking,
- hand depth reconstruction,
- full hand occlusion,
- copyrighted assets,
- copied anime audio.

This prototype is for validating one interaction extremely well.

---

# 33. Agent Working Rules

If you are the coding agent implementing this specification:

1. Inspect the repository first.
2. Preserve working existing code when possible.
3. Work milestone by milestone.
4. Do not hide broken behavior behind visual polish.
5. Prefer the simplest architecture that keeps physics/tracking/rendering separable.
6. Run typecheck/build after meaningful changes.
7. Test the actual page in a browser.
8. If webcam automation is impossible, use Mouse Simulation Mode for repeatable testing.
9. Fix console/runtime errors before progressing.
10. Maintain a concise `STATUS.md` containing:
    - completed milestone,
    - current behavior,
    - known limitations,
    - tuning defaults,
    - next recommended change.
11. Maintain a `TUNING.md` containing the current default parameter set and brief notes about what each parameter visually changes.
12. Do not claim visual quality you did not actually inspect.
13. If you have browser/screenshot tooling, inspect the result directly.
14. Stop adding features if the core fluid motion is not convincing.

---

# 34. Definition of a Successful First Session

A successful first coding session does NOT require the whole final fusion effect.

It is successful if we can open the webpage, allow camera access, hold up a hand, and see a purple zero-gravity-looking fluid mass attached to the intended fingertip that:

- visibly has inertia,
- deforms during movement,
- settles naturally,
- feels responsive,
- can be tuned live,
- and can be tested again using the same exported settings.

Once that feels good, Blue + Red fusion becomes the next layer rather than a distraction.
