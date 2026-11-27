import { ask } from "@tauri-apps/plugin-dialog";
import { accountLabel, planLabel, useAccounts } from "../store/accounts";
import { useWorkspace } from "../store/workspace";
import type { Account, AuthStatus } from "../types";
import { useContextMenu, type MenuItem } from "./ContextMenu";

type Status = ReturnType<typeof useAccounts.getState>["status"][string];

export function accountOrg(st?: Status): string | null {
  return st && st.loggedIn && "orgName" in st ? (st as AuthStatus).orgName ?? null : null;
}

/** Round avatar with the account's initial; colored by login state. */
export function AccountAvatar({ account, status, size = 28 }: { account: Account; status?: Status; size?: number }) {
  const label = accountLabel(account, status);
  const initial = (status && "email" in status && status.email ? status.email : label).replace(/^~\/?\.?/, "").charAt(0).toUpperCase() || "?";
  return (
    <span className={`account-avatar${status?.loggedIn ? "" : " off"}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden>
      {initial}
    </span>
  );
}

export function openAccountSettings() {
  useWorkspace.getState().setModal({ kind: "profiles", section: "accounts" });
}

/** Global Claude account switcher in the window header. */
export function AccountChip() {
  const accounts = useAccounts((s) => s.accounts);
  const activeId = useAccounts((s) => s.activeId);
  const status = useAccounts((s) => s.status);
  const loginsInFlight = useAccounts((s) => Object.keys(s.logins).length);
  const showNudge = useAccounts((s) => !s.nudgeDismissed && s.accounts.length === 1);
  const hasProject = useWorkspace((s) => !!s.activeProjectId);
  const menu = useContextMenu();

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];
  const st = status[active.id];
  const loggedIn = !!st?.loggedIn;
  const plan = planLabel(st);
  const error = st && "error" in st ? st.error : null;

  const open = (e: React.MouseEvent) => {
    const acc = useAccounts.getState();
    const needProject = hasProject ? undefined : "Open a project first — the login runs in one of its terminals";
    const org = accountOrg(st);

    const items: MenuItem[] = [
      {
        custom: (
          <div className="account-menu-head">
            <AccountAvatar account={active} status={st} size={30} />
            <div className="account-menu-id">
              <div className="account-menu-email">{loggedIn ? accountLabel(active, st) : "Not logged in"}</div>
              <div className="account-menu-sub">
                {plan && <span className="ui-badge claude">{plan}</span>}
                <span>{loggedIn ? org ?? (active.configDir ? "Separate login" : "Default account") : accountLabel(active, st)}</span>
              </div>
            </div>
          </div>
        ),
      },
    ];

    if (showNudge) {
      items.push({
        custom: (
          <div className="account-nudge">
            <div className="account-nudge-title">Use more than one Claude account?</div>
            <div className="account-nudge-text">Add each account once. tCon keeps every login saved, so you switch with one click instead of logging in again.</div>
            <div className="row">
              <button
                className="btn primary small"
                onClick={() => {
                  menu.close();
                  openAccountSettings();
                }}
              >
                Set up accounts
              </button>
              <button
                className="btn ghost small"
                onClick={() => {
                  menu.close();
                  acc.dismissNudge();
                }}
              >
                Not now
              </button>
            </div>
          </div>
        ),
      });
    }

    if (accounts.length > 1) {
      items.push("sep", { header: "Switch account" });
      for (const a of accounts) {
        const s = acc.status[a.id];
        items.push({
          label: accountLabel(a, s),
          hint: s?.loggedIn ? planLabel(s) ?? undefined : "logged out",
          checked: a.id === activeId,
          action: () => void acc.setActive(a.id),
        });
      }
    }

    items.push(
      "sep",
      { label: "Add Account…", disabled: !hasProject, title: needProject, action: () => void acc.add() },
      {
        label: loggedIn ? "Log In Again…" : "Log In…",
        disabled: !hasProject,
        title: needProject,
        action: () => acc.login(active.id, loggedIn),
      },
    );
    if (loggedIn) {
      items.push({
        label: "Log Out",
        action: async () => {
          if (await ask(`Log out ${accountLabel(active, st)} from Claude Code?\n\nRunning sessions keep working until restarted.`, { title: "Log out", kind: "warning" }))
            await acc.logout(active.id);
        },
      });
    }
    items.push(
      "sep",
      { label: "Manage Accounts…", action: openAccountSettings },
      { label: "Refresh Status", action: () => void acc.refresh() },
    );
    menu.open(e, items, { anchor: "below-end", minWidth: 270 });
  };

  return (
    <>
      <button
        className={`account-chip${loggedIn ? "" : " warn"}`}
        title={error ?? (loggedIn ? `Claude Code account: ${accountLabel(active, st)}${accountOrg(st) ? `\n${accountOrg(st)}` : ""}` : "Claude Code: not logged in")}
        onClick={open}
      >
        <span className="account-dot" />
        <span className="account-name">{st ? (loggedIn ? accountLabel(active, st) : "Not logged in") : "…"}</span>
        {plan && <span className="account-plan">{plan}</span>}
        {loginsInFlight > 0 && <span className="account-plan">login…</span>}
        {showNudge && <span className="account-nudge-dot" title="Tip: switch between Claude accounts without logging in again" />}
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
      {menu.element}
    </>
  );
}
