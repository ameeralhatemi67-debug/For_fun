# Zero-G Energy: Status

**Stage:** Checkpoints A–F are implemented and verified with Mouse and scripted input. Most of G (polish) is also in.
**Not yet verified:** real hand tracking with an actual hand in front of a webcam. The tracking pipeline, MediaPipe loading, detection calls and the camera compositing path were exercised with synthetic video, but not with a real hand.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 19 unit tests + printed motion report
npm run typecheck
npm run build        # outputs dist/, serve with: npm run preview
```

Camera access needs a secure context: `http://localhost` works, and so does HTTPS. To try it on a phone, run `npm run dev` (it listens on the LAN) and open it through an HTTPS tunnel. Plain `http://<LAN-IP>` will not get camera permission.

## Controls

| action | how |
|---|---|
| Purple Sandbox / Blue + Red | bottom bar, or keys `1` / `2` |
| Mouse Simulation | **Mouse** button (default input). The pointer is anchor A |
| Anchor B (fusion, mouse) | drag the red **B** handle, right-drag, or hold **Shift** while moving. On touch, the second finger is B |
| Camera | **Camera** button or `C`. If permission is denied it falls back to Mouse automatically |
| Scripted test motions | **Test motion…** dropdown (circle, fast sweep, abrupt stops, reversal, shake, tracking loss, fusion approach) |
| Tuning panel | **Tune** or `S` |
| Debug overlay | **Debug** or `D` |
| Mirror toggle | `M` (also in Tuning → Tracking) |
| Reset effect | **Reset** or `R` |
| Split purple back to blue + red | **Split** button (when purple) or `X` |
| Slow motion (0.25×) | `T` |
| Record WebM | **● Rec** or `V`. Records the composited canvas (camera + effect, no UI) |
| Showcase (hide all UI) | **Showcase** or `H`. Exit with `H`, `Esc` or double-click |

URL parameters (handy for repeatable tests): `?input=mouse|camera`, `?script=circle|sweep|stop|reverse|shake|loss|fusion`, `?mode=fusion`, `?debug=1`, `?panel=1`, `?intro=0`, `?slowmo=0.1`.

## Architecture

```
MouseInput / ScriptedMotion / (CameraController → HandTracker → HandIdentity → AnchorResolver)
        │  raw anchor samples (world units, any rate)
        ▼
AnchorFilter ×2   One-Euro smoothing · interpolation between samples · grace prediction · reacquire blend
        │  target + target velocity
        ▼
FluidBody ×2      core spring (+maxLag tether) · jelly ring with neighbour surface tension · tail chain
DropletSystem     fling / tail pinch / tension yank · drag · attraction back · merge
FusionStateMachine (pure)  IDLE → DUAL → ATTRACTING → CONTACT → FUSING → PURPLE → RECOVERING
        │  BlobBuffer (≤ 64 metaballs, preallocated)
        ▼
Renderer          one full-screen GLSL pass: mirrored camera + metaball liquid + refraction + rim + glow + shock ring
```

- `EffectController` wires these together. Physics and rendering never know where an anchor came from.
- The camera ↔ screen transform is defined once (`videoToScreen` / `coverRect`), and the shader uses its exact inverse. A unit test checks the round trip for mirrored and non-mirrored views.
- Physics runs in equal substeps of ≤ 1/240 s per frame, with frame `dt` clamped to 50 ms. The tracker is rate-limited separately (`trackerMaxFps`).

## What works

- **Purple Sandbox.** The mass lags, stretches along velocity and trails a tail on fast moves. It overshoots and wobble-settles on abrupt stops, and carries momentum through reversals. It stays compact on slow moves and idles with a subtle drift and wobble. Surface points are coupled to their neighbours (curvature tension), so deformation stays smooth instead of lumpy. The sloshing shell also pulls on the core, so the mass behaves as one body.
- **Droplets.** They are emitted only above the speed, acceleration or tether-tension thresholds, and the count is hard-bounded (≤ `maxDroplets`, pool of 32). Each droplet inherits velocity, flies free for a moment, then gets pulled back and merges with a small splash into the surface. The main body loses and regains a little volume as droplets leave and return.
- **Tracking robustness.** One-Euro smoothing is followed by interpolation between tracker samples. A 0.25 s grace period coasts on the last velocity, then the mass fades out. When the hand comes back, the target blends from the old position, and if the mass had fully faded it respawns in place instead of flying across. Single-sample identity jumps are blended the same way. Hand identity is kept by nearest-palm matching, not detector order.
- **Blue + Red fusion.** Each color uses the same physics. Inside the attraction radius the masses pull together and their facing surfaces reach toward each other. At contact, colors bleed across the neck and the masses tremble as the charge builds. The fusion runs as a staged compression (squeeze + flash), then a purple release with a pop, a shock ring and 8 micro-droplets that come back. Purple then flows to anchor A. Hysteresis, minimum contact time, cooldown and re-arm prevent flicker, and the `Split` button returns to blue + red.
- **Tuning.** All 64 parameters are in the panel, with Copy / Load JSON, Reset Defaults, 5 presets and localStorage persistence.
- **Debug overlay.** Shows raw fingertip (×), smoothed target (○), fluid center (●), velocity and acceleration vectors, surface/tail points, droplets, hand skeletons, fusion radii, FPS, tracker FPS, state, confidence, A–B distance, droplet count, speed and deformation.
- **Other.** Recording to WebM, showcase mode, slow-mo, a mobile bottom-sheet panel, and a privacy note.

## Verification done

- `npm test`: 19 tests covering spring lag/overshoot/settle, idle liveliness, stretch limit, droplet bounds and reabsorption, graded slow/medium/fast/violent sweeps, gentle vs aggressive shake, AnchorFilter grace/loss/reacquire/jump, fusion hysteresis/brief-crossing/hold/split/abort, settings sanitizing and JSON round-trip, shape calibration, and camera mapping inverse.
- Browser (via the deterministic `__zerog.advance(seconds)` debug hook): I visually inspected sweep, abrupt stops, circle, shake, tracking loss, fusion (scripted and mouse drag), the panel, the mobile 375×812 layout, the camera-denied fallback, and compositing with a synthetic video (cover crop and mirroring correct). MediaPipe WASM and model load (~1.4 s) and `detectForVideo` runs. MediaRecorder produces VP9 WebM data. No console errors.

## Known limitations / issues

- **No real-hand test yet.** Landmark jitter, the right `smoothingMinCutoff`, and whether index-tip placement feels right all still need a webcam session.
- MediaPipe runs on the main thread inside the render loop (rate-limited to 30 Hz). That's expected to cost a few ms per detection, and it isn't measured on real hardware. If frame drops show up, move it to a worker.
- The hand model (`hand_landmarker.task`, ~8 MB) is fetched from Google's model storage on first camera use, so it needs internet. The WASM runtime is served locally.
- The default fusion radii suit two hands or the mouse. For index + middle on one hand, use the **One-hand fusion (small)** preset.
- At violent speeds (> ~6 u/s) the tether saturates at 1.4 × `maxLag`, and the overshoot after a hard stop reaches about 2 R. That's intentional, but tunable.
- Saved settings override new defaults after an update. Press **Reset Defaults** to see the current tuned defaults.
- Droplet re-merge is metaball-based: a droplet shrinks as it slides into the core. There's no droplet–droplet merging.
- On bright camera backgrounds the additive glow is nearly invisible. The body and rim carry the look there.

## Manual acceptance test procedure

1. `npm run dev`, then open `http://localhost:5173` and click **Enable camera**. Allow the permission.
2. Press `D` to turn on the debug overlay. Check that the × (raw fingertip) sits on your index fingertip. If it's on the mirrored side, press `M`.
3. Run spec tests 1–13: hold still 5 s, slow left/right, fast sweep, abrupt stop, reversal, circle, gentle and aggressive shake, partly out of frame, hide the hand, bright and dim light, phone portrait.
4. Press `2` for fusion and run tests 14–20. For two hands, anchor mode `auto` switches to two-hand after 0.3 s. Use **Split** or `R` to repeat.
5. Record with **● Rec**, or screen-record in Showcase (`H`). Send the clip together with **Copy Settings JSON**.

## Next recommended work

1. A real-webcam tuning pass. Mainly `smoothingMinCutoff`, `stiffness`/`damping`, `trailingDrag`, the droplet thresholds, and the size of `baseRadius` relative to a fingertip.
2. Measure frame time with the camera on. If needed, move the HandLandmarker to a Web Worker (OffscreenCanvas + ImageBitmap).
3. Auto-scale the fusion radii by detected hand size, so one-hand and two-hand fusion work without switching presets.
4. Shader polish after motion sign-off: richer internal filaments, chromatic rim, and hand-occlusion hooks (spec §25).
