// Claude Code accounts. Each account is its own CLAUDE_CONFIG_DIR (= its own login in the
// keychain); the default account is plain ~/.claude. The active account is global: it applies
// to every new Claude session in every project.
import { create } from "zustand";
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Account, AuthStatus } from "../types";
import { profileEnv, useWorkspace } from "./workspace";

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

  load(): Promise<void>;
  refresh(id?: string): Promise<void>;
  setActive(id: string, opts?: { promptRestart?: boolean }): Promise<void>;
  add(): Promise<void>;
  remove(id: string): Promise<void>;
  /** Open a terminal running the browser login for this account (relogin = log out first). */
  login(id: string, relogin?: boolean): boolean;
  logout(id: string): Promise<void>;
  onPaneExit(projectId: string, paneId: string, code: number | null): void;
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

let lastRefresh = 0;

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [DEFAULT_ACCOUNT],
  activeId: DEFAULT_ACCOUNT.id,
  status: {},
  refreshing: false,
  logins: {},
  pendingActivate: null,

  async load() {
    try {
      const raw = await api.settingGet("claudeAccounts");
      const extra = raw ? (JSON.parse(raw) as Account[]).filter((a) => a.id && a.configDir) : [];
      const accounts = [DEFAULT_ACCOUNT, ...extra];
      const active = await api.settingGet("claudeActiveAccount");
      set({ accounts, activeId: accounts.some((a) => a.id === active) ? active! : DEFAULT_ACCOUNT.id });
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
    set({ activeId: id });
    persist(get().accounts, id);
    if (promptRestart) await offerRestart(id);
  },

  async add() {
    const home = await api.homeDir();
    const id = crypto.randomUUID();
    const dir = `${home}/.claude-accounts/${id.slice(0, 8)}`;
    await api.accountPrepareDir(dir);
    const accounts = [...get().accounts, { id, configDir: dir }];
    set({ accounts, pendingActivate: id });
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
      return { accounts, activeId, status };
    });
    persist(accounts, activeId);
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

/** After switching: restart idle Claude sessions so they pick up the new login. */
async function offerRestart(accountId: string) {
  const ws = useWorkspace.getState();
  const candidates: { paneId: string; cwd: string }[] = [];
  let busy = 0;
  for (const p of Object.values(ws.projects)) {
    for (const pane of Object.values(p.panes)) {
      if (pane.ephemeral || pane.exited || !pane.isClaude || !pane.startupCommand?.trim().startsWith("claude")) continue;
      // A project/pane profile with its own CLAUDE_CONFIG_DIR isn't affected by the global account.
      if (profileEnv(ws.profiles, pane.profileId ?? p.profileId).CLAUDE_CONFIG_DIR) continue;
      const state = ws.statuses[pane.id]?.state;
      if (state === "working" || state === "blocked") busy++;
      else candidates.push({ paneId: pane.id, cwd: pane.cwd });
    }
  }
  if (!candidates.length && !busy) return;
  const name = accountLabel(useAccounts.getState().accounts.find((a) => a.id === accountId)!, useAccounts.getState().status[accountId]);
  const parts = [
    `Running Claude sessions still use the previous account.`,
    candidates.length ? `Restart ${candidates.length} idle session${candidates.length > 1 ? "s" : ""} on ${name}? Each resumes its last conversation (claude --continue).` : "",
    busy ? `${busy} busy session${busy > 1 ? "s are" : " is"} left alone — restart ${busy > 1 ? "them" : "it"} when finished.` : "",
  ].filter(Boolean);
  if (!candidates.length) {
    await message(parts.join("\n\n"), { title: "Account switched", kind: "info" });
    return;
  }
  const answer = await message(parts.join("\n\n"), { title: "Account switched", kind: "info", buttons: { ok: "Restart sessions", cancel: "Later" } });
  if (answer !== "Ok" && answer !== "Restart sessions") return;
  // `--continue` resumes the latest conversation per directory: only once per cwd.
  const continued = new Set<string>();
  for (const c of candidates) {
    const cmd = continued.has(c.cwd) ? "claude" : "claude --continue";
    continued.add(c.cwd);
    ws.restartPane(c.paneId, cmd);
  }
}
