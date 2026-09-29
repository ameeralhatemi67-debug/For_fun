# Build Prompt — Zero-G Energy Web Prototype

You are the lead graphics/frontend engineer for an experimental browser-based AR-style visual effect.

The repository contains (or will contain) a specification file named:

`ZeroG_Energy_Web_Prototype_SPEC.md`

Treat that document as the source of truth for the product behavior, milestones, priorities, tuning system, and architecture.

Your task is to BUILD the working prototype, not merely plan it.

## Goal

Create a frontend-only website where a camera-tracked fingertip controls a floating energy mass that behaves like liquid water in zero gravity.

The most important behavior is the **Purple Sandbox**:

- track a fingertip,
- use the fingertip only as a target,
- simulate an independent fluid center using spring/inertia physics,
- make the purple mass lag, stretch, overshoot, wobble, settle, and shed small droplets during sufficiently aggressive motion,
- make it feel like it has mass rather than being a graphic glued to the finger.

After that foundation is genuinely working, implement the Blue + Red fusion interaction described in the spec.

## Preferred Stack

Use:
- Vite
- React
- TypeScript
- MediaPipe Tasks Vision / Hand Landmarker
- Three.js + WebGL custom shader(s) for the fluid/metaball effect

Do not add a backend.

Do not use a full scientific fluid solver.

Do not add unnecessary libraries when simple code is enough.

## Important Engineering Requirements

### 1. Build a Mouse Simulation Mode first or very early
Camera/hand tracking must not be required to test the renderer and physics.

Mouse/pointer input should be able to drive the same anchor interface as real hand tracking.

The physics and rendering layers must not know whether the anchor came from MediaPipe or the mouse.

### 2. Separate raw tracking from the fluid
Never do this conceptually:

`fluidPosition = fingertipPosition`

Use:
`raw landmark → smoothed target → physics body → renderer`

The fluid must visibly have inertia.

### 3. Prioritize motion before visual polish
A beautiful shader attached rigidly to the finger is a failure.

A simple-looking blob with excellent zero-gravity movement is a successful first milestone.

### 4. Build a serious live tuning panel
Expose the relevant tracking, spring, damping, deformation, surface-tension, droplet, fusion, and rendering values described in the specification.

Every important motion constant should be tunable without editing source code.

Add:
- Copy Settings JSON
- Load Settings JSON
- Reset Defaults
- localStorage persistence

This is essential because the tester will send videos plus parameter values for later iteration.

### 5. Add a useful debug mode
Display:
- raw fingertip
- smoothed target
- simulated fluid center
- velocity vector
- FPS
- tracker FPS
- effect state
- droplet count
- tracking confidence when available

Make debug visuals easy to hide.

### 6. Handle camera mirroring correctly
The rendered effect must align with the mirrored selfie-camera image.

Add a mirror toggle for diagnosis.

### 7. Make tracking loss graceful
Short losses should use prediction / last velocity for a brief grace period.
Longer losses should smoothly decay/fade.
Reacquisition should not teleport the effect.

### 8. Keep performance bounded
Do not create unlimited particles.
Avoid per-frame garbage where practical.
Use delta time correctly.
Clamp extreme frame deltas.
Rendering and hand-tracking may run at different rates.

## Work Order

Follow these checkpoints in order.

### Checkpoint A — Shell + Inputs
- project runs
- camera view works
- mouse simulation works
- responsive full-screen layout
- no console errors

### Checkpoint B — Tracking
- MediaPipe hand tracking works
- index fingertip target works
- raw vs smoothed position visible in debug
- mirror alignment verified

### Checkpoint C — Purple Physics
Implement the purple mass with:
- spring lag
- damping
- overshoot
- velocity-based stretch
- acceleration influence
- surface-tension-style recovery
- subtle idle wobble

STOP and inspect this behavior before adding fusion.

If the motion looks rigid, jittery, or like a sticker, improve it now.

### Checkpoint D — Droplets + Tuning
- high-energy motion can detach small droplets
- droplet count is bounded
- droplets inherit motion
- preferably attract/merge back into the main fluid
- tuning panel is complete enough to shape behavior
- settings JSON export/import works

### Checkpoint E — Blue + Red
- two stable anchors
- blue and red use the same fluid engine
- distance-based attraction
- deformation toward each other
- hysteresis around thresholds

### Checkpoint F — Fusion
Implement:
`DUAL → ATTRACTING → CONTACT → FUSING → PURPLE`

Fusion must be staged, not a simple color swap.

Use a short compression/pulse/impulse and transfer purple to the primary anchor.

### Checkpoint G — Polish
Only if the previous behavior is stable:
- improve shader
- procedural internal turbulence
- refined edge glow
- subtle refraction/distortion
- showcase mode
- optional recording

## Visual Direction

The energy should feel like:
- a luminous liquid droplet,
- suspended in zero gravity,
- with strong surface tension,
- slightly unstable/internal energy,
- responsive to acceleration.

Purple should use:
- dark violet body,
- purple/magenta core variation,
- occasional cool-blue variation,
- thin bright rim,
- internal procedural flow,
- restrained glow.

Avoid using giant blur as a substitute for a real silhouette.

Do not use copyrighted anime imagery, logos, footage, ripped shaders/assets, or audio.

## Testing

Use the manual motion tests in the specification.

Also use browser automation/screenshot inspection if your environment supports it.

Because automated browser testing cannot reliably provide a real hand, use Mouse Simulation Mode for repeatable tests.

Run:
- typecheck
- build
- any useful unit tests for pure physics/state logic

Test the live page for runtime and console errors.

## Files to Maintain

Create/update:

`STATUS.md`
- completed checkpoints
- what currently works
- what is incomplete
- known visual/technical issues
- exact test procedure
- next recommended work

`TUNING.md`
- current default parameters
- parameter explanations
- any useful presets

Do not flood these files with logs.

## Decision-Making Authority

You may make reasonable implementation decisions without asking me.

If a requested visual technique becomes unnecessarily complex, choose a simpler approximation that preserves the intended motion.

Do not stop merely because one detail is ambiguous. Use the specification's priorities to choose the most sensible interpretation.

## Final Deliverable for This Run

Leave the repository in a runnable state.

At the end, report:

1. what you implemented,
2. which checkpoint was reached,
3. how to run it,
4. how to enable camera permissions,
5. how to switch to Mouse Simulation Mode,
6. how to open the tuning/debug panel,
7. any known limitations,
8. the most important parameters I should experiment with first,
9. whether Blue + Red fusion is ready or whether Purple motion still deserves another tuning pass.

The goal is a prototype I can immediately open, play with, record, and send back for visual critique.
