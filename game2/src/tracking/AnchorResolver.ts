import type { Settings } from '../config/schema';
import type { RawHand } from './HandTracker';

export const LM_THUMB_TIP = 4;
export const LM_INDEX_TIP = 8;
export const LM_MIDDLE_MCP = 9;
export const LM_MIDDLE_TIP = 12;
export const LM_PINKY_TIP = 20;

const FINGER_LM: Record<string, number> = { middle: LM_MIDDLE_TIP, thumb: LM_THUMB_TIP, pinky: LM_PINKY_TIP };

export interface IdentifiedHand extends RawHand {
  id: number;
}

interface Track {
  id: number;
  x: number;
  y: number;
  lastSeen: number;
}

/**
 * Keeps hand identity stable across frames: detector array order is not
 * trusted. Each detection is matched to the nearest existing track (palm
 * center); new tracks get increasing ids; the oldest visible track is primary.
 */
export class HandIdentity {
  private tracks: Track[] = [];
  private nextId = 1;

  assign(hands: RawHand[], t: number): IdentifiedHand[] {
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen < 0.6);
    const out: IdentifiedHand[] = [];
    const used = new Set<number>();
    // Pair candidates sorted by distance (greedy is optimal enough for ≤2 hands).
    const pairs: { h: number; tr: Track; d: number }[] = [];
    hands.forEach((hand, h) => {
      const p = hand.landmarks[LM_MIDDLE_MCP];
      for (const tr of this.tracks) pairs.push({ h, tr, d: Math.hypot(p.x - tr.x, p.y - tr.y) });
    });
    pairs.sort((a, b) => a.d - b.d);
    const assigned = new Map<number, Track>();
    for (const pr of pairs) {
      if (pr.d > 0.3 || assigned.has(pr.h) || used.has(pr.tr.id)) continue;
      assigned.set(pr.h, pr.tr);
      used.add(pr.tr.id);
    }
    hands.forEach((hand, h) => {
      const p = hand.landmarks[LM_MIDDLE_MCP];
      let tr = assigned.get(h);
      if (!tr) {
        tr = { id: this.nextId++, x: p.x, y: p.y, lastSeen: t };
        this.tracks.push(tr);
      }
      tr.x = p.x;
      tr.y = p.y;
      tr.lastSeen = t;
      out.push({ ...hand, id: tr.id });
    });
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  reset(): void {
    this.tracks = [];
  }
}

export interface ResolvedAnchor {
  /** Normalized video coords. */
  nx: number;
  ny: number;
  confidence: number;
}

/**
 * Picks which landmarks drive Anchor A and B.
 *   one hand : A = index tip, B = chosen second finger of the same hand
 *   two hands: A = index tip of primary hand, B = index tip of the other hand
 * `auto` switches to two-hand only after a second hand has been present for a
 * moment (debounced) to avoid B jumping between fingers and hands.
 */
export class AnchorResolver {
  twoHandMode = false;
  private twoSince = -1;
  private oneSince = -1;

  resolve(
    hands: IdentifiedHand[],
    s: Settings,
    t: number,
  ): { a: ResolvedAnchor | null; b: ResolvedAnchor | null } {
    const ok = hands.filter((h) => h.score >= s.confidenceThreshold);
    const n = ok.length;
    if (s.anchorMode === 'twoHands') this.twoHandMode = true;
    else if (s.anchorMode === 'oneHand') this.twoHandMode = false;
    else {
      if (n >= 2) {
        this.oneSince = -1;
        if (this.twoSince < 0) this.twoSince = t;
        if (t - this.twoSince > 0.3) this.twoHandMode = true;
      } else {
        this.twoSince = -1;
        if (this.oneSince < 0) this.oneSince = t;
        if (t - this.oneSince > 0.4) this.twoHandMode = false;
      }
    }
    if (n === 0) return { a: null, b: null };
    const pick = (h: IdentifiedHand, lm: number): ResolvedAnchor => ({
      nx: h.landmarks[lm].x,
      ny: h.landmarks[lm].y,
      confidence: h.score,
    });
    const primary = ok[0];
    const a = pick(primary, LM_INDEX_TIP);
    let b: ResolvedAnchor | null;
    if (this.twoHandMode) b = n >= 2 ? pick(ok[1], LM_INDEX_TIP) : null;
    else b = pick(primary, FINGER_LM[s.anchorBFinger] ?? LM_MIDDLE_TIP);
    return { a, b };
  }
}
