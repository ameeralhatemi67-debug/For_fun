import type { RawHand } from './HandTracker';

/** Middle-finger MCP: a stable palm point for identity matching. */
const LM_MIDDLE_MCP = 9;

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
