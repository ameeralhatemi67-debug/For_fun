/** Records the composited WebGL canvas (camera + effect, no UI) to a local WebM download. */
export class CanvasRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  startedAt = 0;

  get recording(): boolean {
    return this.rec?.state === 'recording';
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  start(canvas: HTMLCanvasElement): void {
    if (this.recording) return;
    const stream = canvas.captureStream(60);
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.chunks = [];
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      const type = this.rec?.mimeType || 'video/webm';
      const blob = new Blob(this.chunks, { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      a.href = url;
      a.download = `zerog-energy-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      stream.getTracks().forEach((t) => t.stop());
    };
    this.rec.start(250);
    this.startedAt = performance.now();
  }

  stop(): void {
    if (this.recording) this.rec?.stop();
  }
}
