// Every Claude pane remembers its own conversation: tCon starts `claude` with a SessionStart
// hook (via --settings) that records the session id per pane (src-tauri/src/sessions.rs).
// On restore each pane runs `claude --resume <its id>`; on an account switch the transcript is
// copied into the new account's config dir first.
import { invoke } from "@tauri-apps/api/core";
import type { Pane } from "./types";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const HOOK = `[ -n "$TCON_PANE_ID" ] && mkdir -p "$HOME/.tcon/sessions" && cat > "$HOME/.tcon/sessions/$TCON_PANE_ID.json"`;
export const SESSION_SETTINGS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: HOOK }] }] } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s: string | undefined | null): s is string => !!s && UUID.test(s);

/** An interactive `claude …` command (not `claude auth …`, `claude mcp …`). */
export function isInteractiveClaude(cmd: string | undefined): boolean {
  const c = cmd?.trim() ?? "";
  return /^claude(\s|$)/.test(c) && !/^claude\s+[a-z]/.test(c);
}

/** Add the session-recording hook to a Claude pane's command. */
export function withSessionTracking(pane: Pane): Pane {
  const cmd = pane.startupCommand?.trim();
  if (!pane.isClaude || !isInteractiveClaude(cmd) || /\s--settings(\s|=)/.test(cmd!)) return pane;
  return { ...pane, startupCommand: `${cmd} --settings ${shq(SESSION_SETTINGS)}` };
}

/** Command to bring a Claude pane back after a restart. */
export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

export const sessionsApi = {
  forPanes: (paneIds: string[]) => invoke<Record<string, string>>("claude_pane_sessions", { paneIds }),
  forget: (paneIds: string[]) => invoke<void>("claude_forget_panes", { paneIds }),
  copy: (fromConfig: string | null, toConfig: string | null, cwd: string, sessionId: string) =>
    invoke<boolean>("claude_copy_session", { fromConfig, toConfig, cwd, sessionId }),
};
