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

export const GRAPH_COLORS = [
  "#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000",
  "#00d9cc", "#e138e8", "#85d900", "#dc5b23", "#6f24d6", "#ffcc00",
];

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
