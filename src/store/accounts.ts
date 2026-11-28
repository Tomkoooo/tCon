// Claude Code accounts. Each account is its own CLAUDE_CONFIG_DIR (= its own login in the
// keychain); the default account is plain ~/.claude. The active account is global: it applies
// to every new Claude session in every project.
import { create } from "zustand";
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Account, AuthStatus } from "../types";
import { findPane, profileEnv, useWorkspace } from "./workspace";
import { isSessionId, resumeCommand, sessionsApi } from "../claudeSessions";
import { isLimited, limitedUntil, limitWindow, pruneLimits, usageCurrent, type AccountLimit, type AccountUsage, type AccountUsageByWindow } from "../accountRotation";

export const DEFAULT_ACCOUNT: Account = { id: "default", configDir: null };

type StatusEntry = AuthStatus | { loggedIn: false; error: string };

interface AccountsState {
  accounts: Account[];
  activeId: string;
  status: Record<string, StatusEntry | undefined>;
  refreshing: boolean;
  /** login terminals in flight: paneId → account id */
  logins: Record<string, string>;
  /** accounts added in this session that should become active once logged in */
  pendingActivate: string | null;
  /** the one-time "add your other accounts" tip was dismissed (persisted) */
  nudgeDismissed: boolean;
  /** accounts that hit their usage limit (persisted until the reset) */
  limits: Record<string, AccountLimit>;
  /** latest usage warning per account and limit window (5-hour / weekly; persisted) */
  usage: Record<string, AccountUsageByWindow>;

  load(): Promise<void>;
  refresh(id?: string): Promise<void>;
  setActive(id: string, opts?: { promptRestart?: boolean }): Promise<void>;
  add(): Promise<void>;
  remove(id: string): Promise<void>;
  /** Open a terminal running the browser login for this account (relogin = log out first). */
  login(id: string, relogin?: boolean): boolean;
  logout(id: string): Promise<void>;
  onPaneExit(projectId: string, paneId: string, code: number | null): void;
  dismissNudge(): void;
  markLimited(id: string, resetAt: number | null, message: string): void;
  noteUsage(id: string, usage: AccountUsage): void;
  /** Forget limits / warnings whose reset has passed. */
  pruneLimits(): void;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Shell prefix that points `claude` at the account's config dir (or the default one). */
function envPrefix(a: Account) {
  return a.configDir ? `CLAUDE_CONFIG_DIR=${shq(a.configDir)}` : "env -u CLAUDE_CONFIG_DIR";
}

/** Env applied to every pane for the active account. */
export function accountEnv(): Record<string, string> {
  const { accounts, activeId } = useAccounts.getState();
  const a = accounts.find((x) => x.id === activeId);
  return a?.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {};
}

export function accountLabel(a: Account, st?: StatusEntry): string {
  if (st && "email" in st && st.email) return st.email;
  return a.configDir ? a.configDir.replace(/^\/Users\/[^/]+/, "~") : "Default account";
}

export function planLabel(st?: StatusEntry): string | null {
  if (!st || !st.loggedIn) return null;
  const s = st as AuthStatus;
  if (s.authMethod && s.authMethod !== "claude.ai") return s.authMethod;
  const plan = s.subscriptionType || s.planTier;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

function persist(accounts: Account[], activeId: string) {
  api.settingSet("claudeAccounts", JSON.stringify(accounts.filter((a) => a.id !== DEFAULT_ACCOUNT.id))).catch(() => {});
  api.settingSet("claudeActiveAccount", activeId).catch(() => {});
}

/** The account whose config dir this is (null/"" = the default account). */
export function accountForConfigDir(dir: string | null | undefined): Account | undefined {
  return useAccounts.getState().accounts.find((a) => (a.configDir ?? null) === (dir || null));
}

function persistLimits(limits: Record<string, AccountLimit>, usage: Record<string, AccountUsageByWindow>) {
  api.settingSet("claudeAccountLimits", JSON.stringify({ limits, usage })).catch(() => {});
}

let lastRefresh = 0;

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [DEFAULT_ACCOUNT],
  activeId: DEFAULT_ACCOUNT.id,
  status: {},
  refreshing: false,
  logins: {},
  pendingActivate: null,
  nudgeDismissed: true, // until loaded: never flash the tip
  limits: {},
  usage: {},

  async load() {
    try {
      const raw = await api.settingGet("claudeAccounts");
      const extra = raw ? (JSON.parse(raw) as Account[]).filter((a) => a.id && a.configDir) : [];
      const accounts = [DEFAULT_ACCOUNT, ...extra];
      const active = await api.settingGet("claudeActiveAccount");
      const dismissed = (await api.settingGet("accountsNudgeDismissed")) === "1";
      set({ accounts, activeId: accounts.some((a) => a.id === active) ? active! : DEFAULT_ACCOUNT.id, nudgeDismissed: dismissed || accounts.length > 1 });
      const saved = JSON.parse((await api.settingGet("claudeAccountLimits")) || "{}") as { limits?: Record<string, AccountLimit>; usage?: Record<string, AccountUsageByWindow> };
      set({ limits: saved.limits ?? {}, usage: saved.usage ?? {} });
      get().pruneLimits();
    } catch {
      /* backend not ready */
    }
    void get().refresh();
    window.addEventListener("focus", () => {
      if (Date.now() - lastRefresh > 30_000) void get().refresh();
    });
  },

  async refresh(id) {
    lastRefresh = Date.now();
    const targets = get().accounts.filter((a) => !id || a.id === id);
    set({ refreshing: true });
    await Promise.all(
      targets.map(async (a) => {
        let st: StatusEntry;
        try {
          st = await api.claudeAuthStatus(a.configDir);
        } catch (e) {
          st = { loggedIn: false, error: String(e) };
        }
        set((s) => ({ status: { ...s.status, [a.id]: st } }));
      }),
    );
    set({ refreshing: false });
  },

  async setActive(id, { promptRestart = true } = {}) {
    if (!get().accounts.some((a) => a.id === id) || get().activeId === id) return;
    const prevConfig = get().accounts.find((a) => a.id === get().activeId)?.configDir ?? null;
    set({ activeId: id });
    persist(get().accounts, id);
    if (promptRestart) await offerRestart(id, prevConfig);
  },

  async add() {
    const home = await api.homeDir();
    const id = crypto.randomUUID();
    const dir = `${home}/.claude-accounts/${id.slice(0, 8)}`;
    await api.accountPrepareDir(dir);
    const accounts = [...get().accounts, { id, configDir: dir }];
    set({ accounts, pendingActivate: id });
    get().dismissNudge();
    persist(accounts, get().activeId);
    if (!get().login(id)) {
      await message("Open a project first — the login runs in one of its terminals.", { title: "Add account", kind: "info" });
    }
  },

  async remove(id) {
    if (id === DEFAULT_ACCOUNT.id) return;
    const a = get().accounts.find((x) => x.id === id);
    if (a && get().status[id]?.loggedIn) await get().logout(id);
    const accounts = get().accounts.filter((x) => x.id !== id);
    const activeId = get().activeId === id ? DEFAULT_ACCOUNT.id : get().activeId;
    set((s) => {
      const status = { ...s.status };
      delete status[id];
      const limits = { ...s.limits };
      delete limits[id];
      return { accounts, activeId, status, limits };
    });
    persist(accounts, activeId);
    persistLimits(get().limits, get().usage);
  },

  login(id, relogin = false) {
    const a = get().accounts.find((x) => x.id === id);
    const ws = useWorkspace.getState();
    const projectId = ws.activeProjectId;
    if (!a || !projectId) return false;
    const pre = envPrefix(a);
    const cmd = `${relogin ? `${pre} claude auth logout; ` : ""}${pre} claude auth login && exit`;
    const paneId = ws.addTerminal(projectId, { claude: false, command: cmd, title: "Claude login", ephemeral: true });
    set((s) => ({ logins: { ...s.logins, [paneId]: id } }));
    return true;
  },

  async logout(id) {
    const a = get().accounts.find((x) => x.id === id);
    if (!a) return;
    try {
      await api.claudeAuthLogout(a.configDir);
    } finally {
      await get().refresh(id);
    }
  },

  dismissNudge() {
    if (!get().nudgeDismissed) set({ nudgeDismissed: true });
    api.settingSet("accountsNudgeDismissed", "1").catch(() => {});
  },

  markLimited(id, resetAt, message) {
    const window = limitWindow(message);
    const prev = get().limits[id];
    // A weekly limit outlasts a 5-hour one: keep whichever lifts later.
    const next: AccountLimit = { limitedAt: Date.now(), window, resetAt, message };
    const keepPrev = !!prev && isLimited(prev, Date.now()) && limitedUntil(prev) > limitedUntil(next);
    const limits = keepPrev ? get().limits : { ...get().limits, [id]: next };
    const usage = { ...get().usage, [id]: { ...get().usage[id], [window]: { percent: 100, resetAt, at: Date.now(), message } } };
    set({ limits, usage });
    persistLimits(limits, usage);
  },

  noteUsage(id, note) {
    const usage = { ...get().usage, [id]: { ...get().usage[id], [limitWindow(note.message)]: note } };
    set({ usage });
    persistLimits(get().limits, usage);
  },

  pruneLimits() {
    const now = Date.now();
    const limits = pruneLimits(get().limits, now);
    let dropped = Object.keys(limits).length !== Object.keys(get().limits).length;
    const usage: Record<string, AccountUsageByWindow> = {};
    for (const [id, byWindow] of Object.entries(get().usage)) {
      const kept = Object.fromEntries(Object.entries(byWindow ?? {}).filter(([, u]) => usageCurrent(u as AccountUsage, now))) as AccountUsageByWindow;
      if (Object.keys(kept).length !== Object.keys(byWindow ?? {}).length) dropped = true;
      if (Object.keys(kept).length) usage[id] = kept;
    }
    if (!dropped) return;
    set({ limits, usage });
    persistLimits(limits, usage);
  },

  onPaneExit(projectId, paneId, code) {
    const accountId = get().logins[paneId];
    if (!accountId) return;
    set((s) => {
      const logins = { ...s.logins };
      delete logins[paneId];
      return { logins };
    });
    void get().refresh(accountId).then(() => {
      const ok = code === 0 && get().status[accountId]?.loggedIn;
      if (ok && get().pendingActivate === accountId) {
        set({ pendingActivate: null });
        void get().setActive(accountId);
      }
    });
    if (code === 0) {
      // Successful login: close its terminal, unless it's the last thing in the project.
      const p = useWorkspace.getState().projects[projectId];
      const others = p ? Object.keys(p.panes).length > 1 || p.editorGroups.length > 0 : false;
      if (others) useWorkspace.getState().closePane(projectId, paneId);
    }
  },
}));

/** Move a pane's Claude session to the active account and restart it there. Sessions with a
 *  recorded id resume exactly (the transcript is copied into the new config dir first); the
 *  rest fall back to `claude --continue`, once per directory. `prompt` is sent as the first
 *  message of the resumed session. */
export async function restartOnActiveAccount(paneId: string, prevConfig: string | null, continued: Set<string>, prompt?: string) {
  const ws = useWorkspace.getState();
  const found = findPane(ws, paneId);
  if (!found) return;
  const pane = found[1];
  const newConfig = accountEnv().CLAUDE_CONFIG_DIR ?? null;
  if (isSessionId(pane.sessionId)) {
    const ok = await sessionsApi.copy(prevConfig, newConfig, pane.cwd, pane.sessionId).catch(() => false);
    if (ok) return ws.restartPane(paneId, resumeCommand(pane.sessionId) + (prompt ? ` ${shq(prompt)}` : ""));
  }
  const cmd = (continued.has(pane.cwd) ? "claude" : "claude --continue") + (prompt ? ` ${shq(prompt)}` : "");
  continued.add(pane.cwd);
  ws.restartPane(paneId, cmd);
}

/** Busy panes that move to the new account as soon as they're idle. */
const pendingSwitch = new Map<string, string | null>();
let pendingOff: (() => void) | null = null;
function switchWhenIdle(paneIds: string[], prevConfig: string | null) {
  paneIds.forEach((id) => pendingSwitch.set(id, prevConfig));
  if (pendingOff) return;
  pendingOff = useWorkspace.subscribe((s) => {
    for (const [id, prev] of [...pendingSwitch]) {
      const st = s.statuses[id]?.state;
      if (!findPane(s, id)) pendingSwitch.delete(id);
      else if (st !== "working" && st !== "blocked") {
        pendingSwitch.delete(id);
        void restartOnActiveAccount(id, prev, new Set());
      }
    }
    if (!pendingSwitch.size) {
      pendingOff?.();
      pendingOff = null;
    }
  });
}

async function offerRestart(accountId: string, prevConfig: string | null) {
  const ws = useWorkspace.getState();
  const candidates: string[] = [];
  const busy: string[] = [];
  for (const p of Object.values(ws.projects)) {
    for (const pane of Object.values(p.panes)) {
      if (pane.ephemeral || pane.exited || !pane.isClaude || !pane.startupCommand?.trim().startsWith("claude")) continue;
      // A project/pane profile with its own CLAUDE_CONFIG_DIR isn't affected by the global account.
      if (profileEnv(ws.profiles, pane.profileId ?? p.profileId).CLAUDE_CONFIG_DIR || p.env?.CLAUDE_CONFIG_DIR) continue;
      const state = ws.statuses[pane.id]?.state;
      if (state === "working" || state === "blocked") busy.push(pane.id);
      else candidates.push(pane.id);
    }
  }
  if (!candidates.length && !busy.length) return;
  const name = accountLabel(useAccounts.getState().accounts.find((a) => a.id === accountId)!, useAccounts.getState().status[accountId]);
  const total = candidates.length + busy.length;
  const parts = [
    `Running Claude sessions still use the previous account.`,
    `Move ${total} session${total > 1 ? "s" : ""} to ${name}? Each one continues its own conversation on the new account.`,
    busy.length ? `${busy.length} busy session${busy.length > 1 ? "s move" : " moves"} as soon as ${busy.length > 1 ? "they finish their" : "it finishes its"} current turn.` : "",
  ].filter(Boolean);
  const answer = await message(parts.join("\n\n"), { title: "Account switched", kind: "info", buttons: { ok: "Move sessions", cancel: "Later" } });
  if (answer !== "Ok" && answer !== "Move sessions") return;
  const continued = new Set<string>();
  for (const id of candidates) await restartOnActiveAccount(id, prevConfig, continued);
  if (busy.length) switchWhenIdle(busy, prevConfig);
}
