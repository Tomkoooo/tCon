// Fuzzy matching for the pickers (quick open, project switcher): the query's characters must
// appear in order; matches at word starts, after a path separator, consecutive runs and in the
// file name score higher. Pure functions (unit-tested in tests/fuzzy.test.ts).

export interface FuzzyMatch {
  score: number;
  /** indices of matched characters in the candidate */
  positions: number[];
}

const isSep = (c: string) => c === "/" || c === "\\" || c === "_" || c === "-" || c === "." || c === " ";

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const c = candidate.toLowerCase();
  const nameStart = candidate.lastIndexOf("/") + 1;
  // Prefer matching inside the file name: try from the name first, then from the start.
  const tryFrom = (start: number): FuzzyMatch | null => {
    const positions: number[] = [];
    let ci = start;
    for (const ch of q) {
      const at = c.indexOf(ch, ci);
      if (at < 0) return null;
      positions.push(at);
      ci = at + 1;
    }
    let score = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      score += 1;
      if (p === 0 || isSep(candidate[p - 1]) || (candidate[p - 1] === candidate[p - 1].toLowerCase() && candidate[p] !== candidate[p].toLowerCase())) score += 4;
      if (i > 0 && positions[i - 1] === p - 1) score += 3;
      if (p >= nameStart) score += 2;
    }
    score -= candidate.length * 0.02;
    if (c.slice(nameStart).startsWith(q)) score += 10;
    return { score, positions };
  };
  const a = nameStart > 0 ? tryFrom(nameStart) : null;
  const b = tryFrom(0);
  if (a && b) return a.score >= b.score ? a : b;
  return a ?? b;
}

/** Best `limit` candidates for the query, best first. */
export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 200): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, key(item));
    if (m) out.push({ item, match: m });
  }
  out.sort((x, y) => y.match.score - x.match.score);
  return out.slice(0, limit);
}
