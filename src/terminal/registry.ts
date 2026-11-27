// Keeps one xterm.js instance per pane alive for the whole pane lifetime.
// Components only attach/detach the host element (DOM re-parenting), so switching
// tabs never recreates terminals or loses scrollback.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import type { Pane } from "../types";
import { useWorkspace } from "../store/workspace";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  webgl?: WebglAddon;
  observer?: ResizeObserver;
  spawned: boolean;
  lastSize: string;
}

const SCROLLBACK = 15000;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** xterm theme from the current CSS tokens (set by the theming store). */
export function terminalTheme(): ITheme {
  const theme: ITheme = {
    background: cssVar("--term-bg"),
    foreground: cssVar("--term-fg"),
    cursor: cssVar("--term-cursor") || cssVar("--accent"),
    cursorAccent: cssVar("--term-bg"),
    selectionBackground: cssVar("--term-selection"),
  };
  for (const k of ANSI_KEYS) {
    const v = cssVar(`--ansi-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
    if (v) (theme as Record<string, string>)[k] = v;
  }
  return theme;
}

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
}

let termSettings: TerminalSettings = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  cursorStyle: "block",
  scrollback: SCROLLBACK,
};

class TerminalRegistry {
  private entries = new Map<string, Entry>();

  /** Create the xterm instance and spawn the PTY if not done yet. */
  ensure(pane: Pane, env: Record<string, string>): Entry {
    let entry = this.entries.get(pane.id);
    if (entry) return entry;

    const term = new Terminal({
      ...termSettings,
      allowProposedApi: true,
      macOptionIsMeta: false, // keep Option for special characters (e.g. Hungarian layout)
      macOptionClickForcesSelection: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    const host = document.createElement("div");
    host.className = "term-host";
    // xterm needs to be opened in an element that is in the DOM to measure; use an offscreen parking lot.
    parking().appendChild(host);
    term.open(host);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Shift+Enter → newline in Claude Code's input (ESC CR == Meta+Enter).
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
        void api.ptyWrite(pane.id, "\x1b\r");
        return false;
      }
      // Let app-level Cmd shortcuts through to the window handler (except copy/paste/select-all).
      if (ev.metaKey && !["c", "v", "a"].includes(ev.key.toLowerCase())) return false;
      return true;
    });

    term.onData((data) => {
      void api.ptyWrite(pane.id, data);
      useWorkspace.getState().markActivity(pane.id);
    });
    term.onTitleChange((title) => useWorkspace.getState().setPaneTitle(pane.id, title));
    term.onBell(() => useWorkspace.getState().markActivity(pane.id));

    entry = { term, fit, host, spawned: false, lastSize: "" };
    this.entries.set(pane.id, entry);
    this.spawn(pane, env, entry);
    return entry;
  }

  private spawn(pane: Pane, env: Record<string, string>, entry: Entry) {
    entry.spawned = true;
    const cols = entry.term.cols || 120;
    const rows = entry.term.rows || 30;
    api
      .ptySpawn(
        { paneId: pane.id, cwd: pane.cwd, cols, rows, env, startupCommand: pane.startupCommand ?? null },
        (data) => {
          entry.term.write(data);
          useWorkspace.getState().markActivity(pane.id);
        },
      )
      .catch((err) => entry.term.write(`\r\n\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`));
  }

  respawn(pane: Pane, env: Record<string, string>) {
    const entry = this.entries.get(pane.id);
    if (!entry) {
      this.ensure(pane, env);
      return;
    }
    entry.term.write("\r\n\x1b[2m── restarted ──\x1b[0m\r\n");
    this.spawn(pane, env, entry);
    this.fitNow(pane.id);
  }

  /** Move the terminal into a visible container. */
  attach(paneId: string, container: HTMLElement) {
    const entry = this.entries.get(paneId);
    if (!entry) return;
    container.appendChild(entry.host);
    if (!entry.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          entry.webgl = undefined;
        });
        entry.term.loadAddon(webgl);
        entry.webgl = webgl;
      } catch {
        /* fall back to DOM renderer */
      }
    }
    entry.observer?.disconnect();
    entry.observer = new ResizeObserver(() => this.fitNow(paneId));
    entry.observer.observe(container);
    requestAnimationFrame(() => this.fitNow(paneId));
  }

  /** Park the terminal offscreen; releases its WebGL context (browsers cap them at ~16). */
  detach(paneId: string) {
    const entry = this.entries.get(paneId);
    if (!entry) return;
    entry.observer?.disconnect();
    entry.observer = undefined;
    entry.webgl?.dispose();
    entry.webgl = undefined;
    parking().appendChild(entry.host);
  }

  fitNow(paneId: string) {
    const entry = this.entries.get(paneId);
    if (!entry || !entry.host.isConnected || entry.host.parentElement === parking()) return;
    if (entry.host.clientWidth < 20 || entry.host.clientHeight < 20) return;
    try {
      entry.fit.fit();
    } catch {
      return;
    }
    const size = `${entry.term.cols}x${entry.term.rows}`;
    if (size !== entry.lastSize) {
      entry.lastSize = size;
      void api.ptyResize(paneId, entry.term.cols, entry.term.rows);
    }
  }

  focus(paneId: string) {
    this.entries.get(paneId)?.term.focus();
  }

  clear(paneId: string) {
    this.entries.get(paneId)?.term.clear();
  }

  dispose(paneId: string) {
    const entry = this.entries.get(paneId);
    if (!entry) return;
    void api.ptyKill(paneId);
    entry.observer?.disconnect();
    entry.term.dispose();
    entry.host.remove();
    this.entries.delete(paneId);
  }

  applyTheme() {
    const theme = terminalTheme();
    for (const e of this.entries.values()) e.term.options.theme = theme;
  }

  /** Font/cursor options from settings.json; refits all visible terminals. */
  applySettings(next: TerminalSettings) {
    const changed = (Object.keys(next) as (keyof TerminalSettings)[]).some((k) => next[k] !== termSettings[k]);
    termSettings = next;
    if (!changed) return;
    for (const [id, e] of this.entries) {
      Object.assign(e.term.options, next);
      this.fitNow(id);
    }
  }
}

let parkingEl: HTMLDivElement | null = null;
function parking() {
  if (!parkingEl) {
    parkingEl = document.createElement("div");
    parkingEl.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:600px;visibility:hidden;pointer-events:none;";
    document.body.appendChild(parkingEl);
  }
  return parkingEl;
}

export const terminals = new TerminalRegistry();
