import type { HandLandmarker as HandLandmarkerType } from '@mediapipe/tasks-vision';

export interface RawHand {
  /** 21 landmarks in normalized *video* coords (0..1, not mirrored). */
  landmarks: { x: number; y: number }[];
  /** Handedness classification score, used as tracking confidence. */
  score: number;
  label: string;
}

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error';

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe-wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/**
 * Thin wrapper around MediaPipe Hand Landmarker (VIDEO mode). Knows nothing
 * about anchors, physics or rendering. MediaPipe is loaded lazily so mouse
 * mode never pays for it.
 */
export class HandTracker {
  status: TrackerStatus = 'idle';
  error = '';
  /** Detections per second actually achieved. */
  fps = 0;
  private landmarker: HandLandmarkerType | null = null;
  private lastVideoTime = -1;
  private lastDetectMs = 0;
  private fpsCount = 0;
  private fpsWindowStart = 0;
  private lastTimestamp = 0;

  async init(): Promise<void> {
    if (this.status === 'ready' || this.status === 'loading') return;
    this.status = 'loading';
    try {
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      const make = (delegate: 'GPU' | 'CPU') =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      try {
        this.landmarker = await make('GPU');
      } catch {
        this.landmarker = await make('CPU');
      }
      this.status = 'ready';
    } catch (e) {
      this.status = 'error';
      this.error = `Hand tracker failed to load: ${(e as Error)?.message ?? e}`;
      throw e;
    }
  }

  /**
   * Runs detection if a new video frame is available and the rate limit allows.
   * Returns null when nothing new was processed.
   */
  detect(video: HTMLVideoElement, nowMs: number, maxFps: number): RawHand[] | null {
    if (!this.landmarker || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    if (nowMs - this.lastDetectMs < 1000 / maxFps - 2) return null;
    this.lastVideoTime = video.currentTime;
    this.lastDetectMs = nowMs;
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(nowMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const res = this.landmarker.detectForVideo(video, ts);

    this.fpsCount++;
    if (nowMs - this.fpsWindowStart >= 1000) {
      this.fps = (this.fpsCount * 1000) / (nowMs - this.fpsWindowStart);
      this.fpsCount = 0;
      this.fpsWindowStart = nowMs;
    }

    const hands: RawHand[] = [];
    for (let h = 0; h < res.landmarks.length; h++) {
      const cat = res.handedness?.[h]?.[0];
      hands.push({
        landmarks: res.landmarks[h].map((p) => ({ x: p.x, y: p.y })),
        score: cat?.score ?? 1,
        label: cat?.categoryName ?? '?',
      });
    }
    return hands;
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.status = 'idle';
  }
}
