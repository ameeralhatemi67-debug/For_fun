/**
 * Mouse / touch "fake hand". Produces the same kind of anchor samples as the
 * camera tracker (positions in CSS px + presence), nothing more.
 *
 *   Mouse move over the stage   → Anchor A
 *   Shift + move / right-drag   → Anchor B
 *   Drag the red B handle       → Anchor B
 *   Touch: 1st finger → A, 2nd finger → B
 *   Pointer leaves the window   → A is "lost" (tests loss/fade behavior)
 */
export class MouseInput {
  aX = 0;
  aY = 0;
  aInside = true;
  bX = 0;
  bY = 0;
  bPlaced = false;
  /** Set by the engine: where B's handle is drawn (CSS px), for hit-testing. */
  bHandleX = -1e9;
  bHandleY = -1e9;
  fusionMode = false;

  private stage: HTMLElement | null = null;
  private roles = new Map<number, 'A' | 'B'>();
  private shift = false;
  private placedA = false;

  attach(stage: HTMLElement): void {
    this.stage = stage;
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('pointerout', this.onOut);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    stage.addEventListener('contextmenu', this.onContext);
  }

  detach(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('pointerout', this.onOut);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.stage?.removeEventListener('contextmenu', this.onContext);
    this.stage = null;
  }

  /** Default positions before the user touches anything. */
  ensurePlaced(w: number, h: number, s: number): void {
    if (!this.placedA) {
      this.aX = w / 2 - (this.fusionMode ? 0.3 * s : 0);
      this.aY = h / 2;
      this.placedA = true;
    }
    if (!this.bPlaced) {
      this.bX = w / 2 + 0.3 * s;
      this.bY = h / 2;
      this.bPlaced = true;
    }
  }

  resetPlacement(): void {
    this.placedA = false;
    this.bPlaced = false;
  }

  private onStage(e: PointerEvent): boolean {
    return !!this.stage && e.target instanceof Node && this.stage.contains(e.target);
  }

  private onMove = (e: PointerEvent) => {
    const role = this.roles.get(e.pointerId);
    if (role === 'B' || (role === undefined && e.pointerType === 'mouse' && this.shift)) {
      if (role === 'B' || this.onStage(e)) this.setB(e.clientX, e.clientY);
      return;
    }
    if (role === 'A' || (e.pointerType === 'mouse' && this.onStage(e))) {
      this.aX = e.clientX;
      this.aY = e.clientY;
      this.aInside = true;
      this.placedA = true;
    }
  };

  private onDown = (e: PointerEvent) => {
    if (!this.onStage(e)) return;
    const nearB = Math.hypot(e.clientX - this.bHandleX, e.clientY - this.bHandleY) < 44;
    let role: 'A' | 'B' = 'A';
    if (this.fusionMode) {
      if (nearB || e.button === 2) role = 'B';
      else if (e.pointerType !== 'mouse' && [...this.roles.values()].includes('A')) role = 'B';
    }
    this.roles.set(e.pointerId, role);
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    if (role === 'B') this.setB(e.clientX, e.clientY);
    else {
      this.aX = e.clientX;
      this.aY = e.clientY;
      this.aInside = true;
      this.placedA = true;
    }
  };

  private onUp = (e: PointerEvent) => {
    this.roles.delete(e.pointerId);
  };

  private onOut = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.relatedTarget === null && !this.roles.size) this.aInside = false;
  };

  private onKey = (e: KeyboardEvent) => {
    this.shift = e.shiftKey;
  };

  private onBlur = () => {
    this.shift = false;
    this.roles.clear();
  };

  private onContext = (e: Event) => e.preventDefault();

  private setB(x: number, y: number): void {
    this.bX = x;
    this.bY = y;
    this.bPlaced = true;
  }
}
