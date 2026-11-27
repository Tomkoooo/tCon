// Short texts for the commit graph rows: the subject and the ref badges are cut so that every
// badge stays readable in a narrow sidebar. The full texts are in the tooltip / hover card.

/** Subject length on rows that carry ref badges (rows without badges get more room). */
export const SUBJECT_WITH_REFS = 20;
export const SUBJECT_PLAIN = 40;
/** Longest badge label. */
export const REF_MAX = 16;

/** Cut a commit subject at a word boundary when one is close, else hard, and add "…". */
export function shortSubject(summary: string, max = SUBJECT_PLAIN): string {
  const s = summary.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.:;(-]+$/, "")}…`;
}

/** Shorten a branch / tag / remote label in the middle so both its start and its end stay
 *  visible: `origin/feature/login-redirect-loop` → `origin/fe…rect-loop`. */
export function shortRef(label: string, max = REF_MAX): string {
  if (label.length <= max) return label;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${label.slice(0, head)}…${label.slice(label.length - (keep - head))}`;
}
