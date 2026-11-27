// Shell-safe file paths for dropping / pasting files into a terminal, the way macOS
// Terminal and iTerm do it: backslash-escape anything that isn't plainly safe.

export function quotePath(p: string): string {
  return p.replace(/([^A-Za-z0-9_\-.,:/@+=%~])/g, "\\$1");
}

/** Paths joined with spaces, plus a trailing space so the next word doesn't stick to them. */
export function pathsForTerminal(paths: string[]): string {
  const list = paths.filter(Boolean).map(quotePath);
  return list.length ? `${list.join(" ")} ` : "";
}

/** `file:///Users/me/My%20File.png` → `/Users/me/My File.png` (null if not a local file URL). */
export function fileUrlToPath(url: string): string | null {
  const m = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(url.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
