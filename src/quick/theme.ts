// Apply the color theme the main window last resolved (cached in localStorage by
// theming/store.ts under "tcon.themeVars"). Dependency-free so it can run synchronously
// before anything else loads, in both windows (they share the origin's localStorage).
export const THEME_CACHE_KEY = "tcon.themeVars";

let applied: string[] = [];

/** Returns false when there's no cached theme yet. */
export function applyCachedVars(): boolean {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return false;
    const { vars, kind } = JSON.parse(raw) as { vars: Record<string, string>; kind: "dark" | "light" };
    const root = document.documentElement;
    for (const k of applied) if (!(k in vars)) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = kind;
    root.dataset.themeKind = kind;
    applied = Object.keys(vars);
    return true;
  } catch {
    return false;
  }
}
