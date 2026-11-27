// Lane layout for a commit graph (VS Code "Git Graph" style).
//
// Input: commits in topological order, newest first (as returned by `git log`).
// Output: one GraphRow per commit with the lane of its node and the line
// segments to draw inside that row. Coordinates: x is a lane index, y is a
// fraction of the row height (0 = top edge, 0.5 = node centre, 1 = bottom edge).
// Segments drawn in consecutive rows join up at the row boundaries.

import type { GitCommit } from "../../types";

export interface GraphSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** index into GRAPH_COLORS (modulo its length) */
  color: number;
}

export interface GraphRow {
  commit: GitCommit;
  /** lane of the commit node */
  lane: number;
  /** colour index of the node */
  color: number;
  segments: GraphSegment[];
  /** number of lanes this row uses (max of lanes above and below the node) */
  width: number;
  isMerge: boolean;
}

/** Lane colours: theme tokens (VS Code's scmGraph.* colours) with fallbacks. Blue, yellow, pink, green, purple, teal. */
export const GRAPH_COLORS = [
  "var(--graph-1, #59a4f9)", "var(--graph-2, #ffb000)", "var(--graph-3, #dc267f)",
  "var(--graph-4, #3fb950)", "var(--graph-5, #b66dff)", "var(--graph-6, #40b0a6)",
];

export const graphColor = (c: number) => GRAPH_COLORS[((c % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];

export interface GraphGeometry {
  /** width of one lane, px */
  laneW: number;
  /** row height, px */
  rowH: number;
  /** left padding before lane 0, px */
  pad: number;
}

/** x of a lane's centre line. */
export const laneX = (lane: number, g: GraphGeometry) => g.pad + lane * g.laneW + g.laneW / 2;

/**
 * SVG path for one segment. Straight when it stays in its lane; otherwise a cubic bezier whose
 * control points sit at the vertical midpoint, so it leaves and enters both lanes vertically
 * and joins the straight lines of the neighbouring rows without a kink.
 */
export function segmentPath(s: GraphSegment, g: GraphGeometry): string {
  const x1 = laneX(s.x1, g), x2 = laneX(s.x2, g);
  const y1 = s.y1 * g.rowH, y2 = s.y2 * g.rowH;
  if (s.x1 === s.x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

export function computeGraph(commits: GitCommit[]): GraphRow[] {
  // lanes[j] = id of the commit lane j is waiting for (null = free slot)
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const allocLane = (avoid: number): number => {
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === null && j !== avoid) return j;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const segments: GraphSegment[] = [];
    const before = lanes.slice();

    // Lanes converging on this commit.
    const incoming: number[] = [];
    for (let j = 0; j < before.length; j++) if (before[j] === commit.id) incoming.push(j);

    let lane: number;
    if (incoming.length > 0) {
      lane = incoming[0];
    } else {
      // Branch tip (nothing above points at it): start a new lane.
      lane = allocLane(-1);
      laneColor[lane] = nextColor++;
    }
    const color = laneColor[lane];

    // Top half: incoming edges into the node, pass-through for others.
    for (let j = 0; j < before.length; j++) {
      const id = before[j];
      if (id === null) continue;
      if (id === commit.id) {
        segments.push({ x1: j, y1: 0, x2: lane, y2: 0.5, color: laneColor[j] });
      }
    }
    // All incoming lanes are consumed by this commit.
    for (const j of incoming) lanes[j] = null;

    // Bottom half: edges to parents.
    const parents = commit.parents;
    if (parents.length > 0) {
      const p0 = parents[0];
      lanes[lane] = p0;
      segments.push({ x1: lane, y1: 0.5, x2: lane, y2: 1, color });
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k];
        let target = lanes.indexOf(p);
        if (target === -1) {
          target = allocLane(lane);
          lanes[target] = p;
          laneColor[target] = nextColor++;
        }
        segments.push({ x1: lane, y1: 0.5, x2: target, y2: 1, color: laneColor[target] });
      }
    } else {
      lanes[lane] = null;
    }

    // Pass-through lanes: occupied both above and below without touching the node.
    for (let j = 0; j < before.length; j++) {
      const id = before[j];
      if (id === null || id === commit.id) continue;
      if (lanes[j] === id) segments.push({ x1: j, y1: 0, x2: j, y2: 1, color: laneColor[j] });
    }

    // Trim trailing free lanes so the graph doesn't grow forever.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let width = Math.max(lane + 1, lanes.length);
    for (let j = before.length - 1; j >= 0; j--) {
      if (before[j] !== null) { width = Math.max(width, j + 1); break; }
    }

    rows.push({ commit, lane, color, segments, width, isMerge: parents.length > 1 });
  }
  return rows;
}
