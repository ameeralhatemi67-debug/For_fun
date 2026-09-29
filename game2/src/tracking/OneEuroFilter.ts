/**
 * 2D One-Euro filter (Casiez et al. 2012): heavy smoothing when the point is
 * slow (kills landmark jitter), light smoothing when it is fast (keeps latency low).
 * Uses the 2D speed so both axes share one adaptive cutoff.
 */
export class OneEuroFilter2D {
  x = 0;
  y = 0;
  private dx = 0;
  private dy = 0;
  private t = 0;
  private init = false;

  reset(x: number, y: number, t: number): void {
    this.x = x;
    this.y = y;
    this.dx = this.dy = 0;
    this.t = t;
    this.init = true;
  }

  filter(x: number, y: number, t: number, minCutoff: number, beta: number, dCutoff = 3): void {
    if (!this.init) {
      this.reset(x, y, t);
      return;
    }
    const dt = t - this.t;
    if (dt <= 1e-6) return;
    this.t = t;
    const ad = alpha(dt, dCutoff);
    this.dx += ((x - this.x) / dt - this.dx) * ad;
    this.dy += ((y - this.y) / dt - this.dy) * ad;
    const speed = Math.hypot(this.dx, this.dy);
    const a = alpha(dt, minCutoff + beta * speed);
    this.x += (x - this.x) * a;
    this.y += (y - this.y) * a;
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
