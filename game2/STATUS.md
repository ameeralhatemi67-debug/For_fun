# Zero-G Energy: Status

**Checkpoint v0.2 reached.** v0.2 is implemented on top of v0.1 and verified with tests plus mouse and scripted input in the browser. The design brief is `ZeroG_Energy_Interaction_SPEC_v0.2.md`; `ZeroG_Energy_Web_Prototype_SPEC.md` is the original v0.1 spec.

v0.2 adds:
- a finger gap
- spawn-in-place
- depth scale
- a stronger midrange liquid silhouette
- a gesture classifier (TRACK / PALM_PUSH / HANDGUN / NEUTRAL)
- palm push and two-hand volley
- handgun aim with thumb-trigger shots
- surface-based fusion contact with a colour-graded neck
- a downloadable settings JSON that is the repo's canonical defaults format

**Real-camera status:** there has been **no real-hand test**. See "Camera testing" below for what was exercised instead.

## Run

```bash
npm install
npm run dev              # http://localhost:5173
npm test                 # 63 tests + printed motion report
npm run typecheck
npm run build            # dist/, serve with: npm run preview
npm run apply-settings -- path/to/zerog-settings.json [--dry-run]   # make a tuned file the defaults
npm run tuning-table     # regenerate the parameter tables in TUNING.md
```

Camera access needs `http://localhost` or HTTPS. The hand model (~8 MB) is fetched from Google's model storage on first camera use. The WASM runtime is served locally.

## Controls

| action | how |
|---|---|
| Purple / Blue + Red | bottom bar, or `1` / `2` |
| Input | **Mouse** (default) · **Camera** (`C`) · **Test motion…** dropdown |
| Real hand (camera) | **Point** (ring + pinky curled) holds the liquid beyond the index tip · **open hand** releases it and becomes a paddle · **thumb up** while pointing = handgun, **drop the thumb** to fire · **fist / point again** recaptures a free ball |
| Mouse hand gesture | **Point / Palm / Gun** buttons, or `F` / `P` / `G`. The pointer is the fingertip (Point, Gun) or the palm center (Palm) |
| Second hand (mouse) | shown in fusion and in Palm mode: drag the **B** handle, right-drag, or Shift + move |
| Fire | Space (all inputs), or a left click in mouse Gun mode. In mouse mode it animates a real thumb press through the classifier |
| Depth (mouse) | mouse wheel = hand closer / farther · `B` or **Reset Depth Baseline** (Tune panel) |
| Tuning panel | **Tune** / `S` — Download / Copy / Load Settings JSON, Reset Defaults, presets |
| Debug overlay | **Debug** / `D` (never recorded) |
| Mirror | `M` · Reset `R` · Split purple `X` · Slow-mo `T` · Record `V` · Showcase `H` |

URL parameters: `?input=mouse|camera`, `?script=<name>`, `?mode=fusion`, `?gesture=palm|gun`, `?debug=1`, `?panel=1`, `?intro=0`, `?slowmo=0.1`.

Scripts:

| script | shows |
|---|---|
| `circle` | continuous circular motion |
| `medium` | medium-speed sweeps |
| `sweep` | fast sweeps |
| `stop` | abrupt stops |
| `reverse` | direction reversals |
| `shake` | gentle, then aggressive shaking |
| `loss` | brief and long tracking loss |
| `spawn` | condense in place, then respawn elsewhere |
| `depth` | growing/shrinking size, plus a one-frame detector spike |
| `palm` | release, push, bounce off B, recapture |
| `volley` | two palms rallying; a lost ball is re-served |
| `gun` | aim, thumb-fire at B's palm, fist recapture, reload |
| `fusion` | approach, neck, contact, purple, split |

## Architecture

```
Camera → HandTracker (MediaPipe) → HandIdentity ─┐
Mouse  → SimHand (synthetic 21 landmarks)        ├─▶ HandPipeline (per hand: GestureClassifier, finger dirs,
Script → ScriptDriver → SimHand                  ┘      aim, PalmTracker, depth estimator)
                                                          │ HandState[]
                                                          ▼
                              Simulation (DOM-free)
                                ├─ source assignment: sandbox owner hand / fusion A-B rules
                                ├─ offset anchor = tip + dir·(gap+1)·R ─▶ AnchorFilter ×2 (One-Euro + prediction)
                                ├─ body control: ANCHORED ⇄ FREE / SHOT ⇄ RECAPTURING, spawn / despawn
                                ├─ FluidBody ×2 · DropletSystem · PalmCollision
                                └─ FusionStateMachine (center distance → attraction, surface gap → contact) + neck
                                                          │ BlobBuffer (≤ 80 metaballs, palette mix + droplet tag)
                                                          ▼
                              Renderer: one GLSL pass (camera + liquid + A→purple→B gradient + glow + shock)
```

Everything goes through the same geometry and gesture code:
- Mouse and scripts synthesize real 21-point hands, so the classifier, palm collider and depth path are exercised without a webcam.
- Tests drive `Simulation` + `HandPipeline` headlessly (`tests/helpers/world.ts`) with the same scripts the app runs.
- `src/config/default-settings.json` is the single source of the default values. `schema.ts` holds labels and ranges, and fails loudly if a default is missing or invalid.

## What works (v0.2)

- **Finger gap.** The liquid sits beyond the index tip along the finger (PIP → TIP). When the finger is curled or foreshortened, the direction blends toward the hand's direction. It's smoothed and mirror-correct: the direction comes from the same screen transform as the render. `fingerGap` is the visible air gap in radii.
- **Spawn in place.**
  - A new ball appears exactly at the offset anchor as an invisible dot. It grows over `spawnGrowDuration` with a small inward pinch that rebounds, like liquid condensing. No fly-in from old or off-screen positions.
  - A brief loss (< grace) keeps predicting without respawning.
  - After a real loss, if the body has faded more than halfway, it condenses anew at the new position.
- **Faster control point.** `controlPrediction` shifts the anchor forward between tracker samples. The heavy body provides the lag.
- **Depth.**
  - Apparent palm size (3D landmark lengths) → median → ratio to baseline → strength → clamp → smoothing.
  - One radius is used for rendering, palm collisions, the finger gap and fusion.
  - A one-frame 2.5× detector spike moves the scale by < 1% (tested).
- **Liquid silhouette.**
  - Ring-dominant metaball layout (≈35% more visible response to surface deformation).
  - Rendered deformation ×1.4 with tanh saturation.
  - Attachment-tension lean toward the anchor, and an area-preserving core stretch.
  - A drawn core that partly follows a sloshing shell, plus filler blobs, so the drop never tears a donut hole (tested).
  - Measured rendered aspect: 1.14 slow, 1.46 medium, ≈3 fast.
- **Droplets.**
  - Torn liquid rather than orbs: irregular wobble, velocity-stretched, a trailing sliver, and a droplet tag that gives a thinner lens, less rim/glow and more translucency.
  - Free-flying balls shed far fewer droplets than ones being yanked on a tether. Hard palm hits tear one off.
- **Gestures.** A dedicated `GestureClassifier` implements the rules and priority in TUNING.md: Schmitt-trigger fingers, dwell/hysteresis stabilizer, gesture epoch and a thumb hammer trigger. It is tested on synthetic poses at several rolls, both handedness and several scales.
- **Palm push / volley.**
  - The open hand becomes a padded convex collider with velocity.
  - Hits depenetrate, bounce with restitution, transfer the palm's velocity, apply friction and steer along the push. The contact side squashes and the sides bulge.
  - A ball can go A → B → A (tested, and shown in the `palm` / `volley` scripts).
- **Recapture.** A magnetic capped spring with no tether clamp brings the ball back. It never jumps (≤ 3 u/s per frame in the test) and becomes ANCHORED at the finger.
- **Handgun.**
  - Aim along the index MCP → TIP. The debug overlay draws the aim ray.
  - The thumb press fires once from the ball's current position with `shotSpeed` (+ hand velocity).
  - Re-arm and cooldown apply. A thumb held folded for 0.5 s means "just pointing".
  - Shots collide with palms. Off-screen shots are removed after the delay; a gun hand then reloads a fresh ball in place.
- **Fusion.**
  - CONTACT is driven by the rendered surface gap (center distance − both surface extents along the axis). It was tested against the actual rendered field: contact starts when the liquids touch and never while they are visibly apart.
  - A dynamic metaball neck (Bezier bridge that bends with relative motion) carries a continuous blue → violet → red palette gradient and fades if the bodies separate.
  - Fusion droplets squirt out perpendicular to the collision axis, partly carried by the incoming momentum.
- **Look.** Thinner rim, weaker fresnel, flow-rippled broken highlight, more translucency and refraction, less glow. Internal flow has inertia (`flowInertia`): it lags on acceleration, sloshes after stops and swirls on impacts.
- **Settings.** Download / Copy / Load JSON (`schemaVersion: 2`), with file open in the Load dialog. Canonical defaults live in `default-settings.json`. `apply-settings` validates and rewrites them. localStorage stores only overrides.
- **Debug overlay.** Per-hand gesture (plus raw), ring/pinky states and extensions, thumb armed/folded + openness, palm collider polygon + velocity, finger direction, fingertip → offset-anchor gap, raw/smoothed anchor, body control state, effective radius, depth raw/scale, surface gap + fusion state, aim ray, last shot.
- All v0.1 features are preserved: camera, mouse, scripts, recording, tuning panel, presets, showcase, slow-mo, mirror, Blue/Red/Purple.

## Verification done

- `npm test`: **63 tests** in 6 files, all passing:
  - `gesture`: 12
  - `interaction`: 20 (spawn, gap, mirror, depth, free/palm/volley/recapture, shot, off-screen, fusion contact/neck)
  - `settings`: 8
  - `physics`: 8, including rendered-silhouette aspect and no-hole checks
  - `logic`: 12
  - `camera`: 3
- `npm run typecheck` and `npm run build`: clean.
- **Browser (in-app browser, mouse + scripts, deterministic `__zerog.advance()` + the dev-only `__filmstrip` grid capture).** I visually inspected:
  - spawn condensing at the finger gap
  - slow, medium, fast and violent sweeps
  - abrupt stops
  - depth grow/shrink
  - palm release
  - a palm hit with squash and a torn droplet
  - shot flight, and the shot hitting the palm
  - recapture (in the scripts)
  - fusion approach → neck gradient → contact → purple
  - the mouse Palm mode colliders, and a live mouse palm swipe hitting the ball
  - the mode bar and Tune panel
- **Camera testing.** I did not turn on your webcam: that needs your permission and a real hand. Instead:
  - I fed a synthetic canvas `MediaStream` into the camera path. MediaPipe loaded (≈3.4 s) and ran 40 real `detectForVideo` calls with no errors. The cover rect was correct. Zero hands were detected, as expected.
  - A unit test maps synthetic hands through the exact `videoToScreen` mirror transform and checks that the pointing direction and gap are mirror-correct.
- No console errors were seen in the new code; the only errors in the log are stale HMR messages from mid-refactor edits. Render cost here is ≈1.7 ms/frame at 1280×960.

## Known issues / limitations

- **No real-hand test yet.** These all need a webcam session:
  - `fingerOpenAbove` / `fingerClosedBelow` and `thumbTriggerThreshold` on real, noisy landmarks
  - how natural the thumb "hammer" feels
  - `smoothingMinCutoff`
  - the palm collider size relative to the ball
- The palm collider is the 2D silhouette of the hand. An off-center push deflects by geometry. `palmSteer` (default 0.8) bends a moving push toward the hand's motion; a static palm bounces purely by geometry.
- A thumb press is a pose change, so going from a thumb-up gun straight to "pointing with the thumb tucked" fires once. To stop aiming without firing, break the gun shape first (open the middle finger, or make a fist).
- A free ball stays until it leaves the view. There are no screen-edge walls, by design.
- Depth uses apparent palm size, so spreading or closing the fingers barely affects it, but a strongly tilted palm reads slightly smaller. The baseline is the first stable hand (use Reset Depth Baseline).
- The scripted palm/volley demos have simple "players" that line up with the ball; rallies end when a corner hit sends the ball away, then it is re-served.
- Dev only: editing `default-settings.json` while the page is open (HMR) can persist the old in-memory values as "overrides". Reload after changing defaults, or press Reset Defaults.
- MediaPipe runs on the main thread (rate-limited to 30 Hz). It has not been measured with a real camera on this machine.

## Manual acceptance procedure (camera)

1. `npm run dev`, open `http://localhost:5173`, click **Enable camera**, then press `D`.
2. **Point** with ring + pinky curled. The ball should condense beyond the index tip; check the gap. If it's on the wrong side, press `M`.
3. Move slowly, then at medium speed (visible lean and stretch), then fast (tail, droplets). Stop abruptly and reverse. Move the hand toward and away from the camera (size changes; `B` resets the baseline).
4. **Open the hand.** The ball stays where it is (FREE). Swipe the palm into it. With the second hand open, bat it back and forth. Point again to recapture it.
5. **Thumb up** while pointing (HANDGUN label and aim ray). Drop the thumb to fire at the other open palm. Make a fist to recapture. Tune `thumbTriggerThreshold` if presses are missed or fire too easily.
6. Press `2` for Blue + Red. Bring two index fingers (or index + middle on one hand) together: reach, then the violet neck, contact, and purple.
7. **Download Settings JSON** and send it with the clip. `npm run apply-settings -- file.json` makes it the defaults.

## Next recommended work

1. A real-webcam session focused on the gesture thresholds, thumb trigger and palm collider size. Then Download Settings JSON → `apply-settings`.
2. If the thumb trigger is unreliable on real landmarks, add an alternative trigger (a quick index "recoil" flick) and keep the thumb one.
3. Measure frame time with the camera. If needed, move MediaPipe to a Worker (OffscreenCanvas + ImageBitmap).
4. Auto-scale the fusion radii by hand size, so one-hand and two-hand fusion work without presets.
5. Shader polish after the motion sign-off: chromatic rim, richer filaments inside the neck, and hand-occlusion hooks.
