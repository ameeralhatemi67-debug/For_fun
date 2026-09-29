/** Rect (CSS px) that the video occupies when drawn with object-fit: cover. */
export interface CoverRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function coverRect(videoW: number, videoH: number, viewW: number, viewH: number): CoverRect {
  if (videoW <= 0 || videoH <= 0) return { x: 0, y: 0, w: viewW, h: viewH };
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/**
 * THE one transform from normalized video coords (0..1, as the tracker reports
 * them) to on-screen CSS px. The shader uses the inverse of the same rect and
 * mirror flag to draw the camera, so tracking and render always agree.
 */
export function videoToScreen(
  nx: number,
  ny: number,
  rect: CoverRect,
  mirror: boolean,
  viewW: number,
): { x: number; y: number } {
  let x = rect.x + nx * rect.w;
  if (mirror) x = viewW - x;
  return { x, y: rect.y + ny * rect.h };
}

export type CameraStatus = 'off' | 'starting' | 'on' | 'error';

export class CameraController {
  readonly video: HTMLVideoElement;
  status: CameraStatus = 'off';
  error = '';
  private stream: MediaStream | null = null;

  constructor() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    this.video = v;
  }

  get ready(): boolean {
    return this.status === 'on' && this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  async start(): Promise<void> {
    if (this.status === 'on' || this.status === 'starting') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status = 'error';
      this.error = window.isSecureContext
        ? 'This browser has no camera API.'
        : 'Camera needs a secure context (https:// or http://localhost).';
      throw new Error(this.error);
    }
    this.status = 'starting';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.status = 'on';
      this.error = '';
    } catch (e) {
      this.status = 'error';
      const err = e as DOMException;
      this.error =
        err?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow it in the address-bar camera icon and retry.'
          : err?.name === 'NotFoundError'
            ? 'No camera found.'
            : `Camera error: ${err?.message ?? String(e)}`;
      this.stop(false);
      throw new Error(this.error);
    }
  }

  stop(resetStatus = true): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (resetStatus) this.status = 'off';
  }
}
