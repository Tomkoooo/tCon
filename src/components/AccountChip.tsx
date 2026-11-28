import { ask } from "@tauri-apps/plugin-dialog";
import { accountLabel, planLabel, useAccounts } from "../store/accounts";
import { useWorkspace } from "../store/workspace";
import type { Account, AuthStatus } from "../types";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./icons";
import { usageText } from "../accountRotation";
import { AUTO_SWITCH_SETTING, autoSwitchMode } from "../autoSwitch";
import { useTheming } from "../theming/store";

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
  const limits = useAccounts((s) => s.limits);
  const usage = useAccounts((s) => s.usage);
  useTheming((s) => s.settings[AUTO_SWITCH_SETTING]); // re-render the menu check
  const menu = useContextMenu();

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];
  const st = status[active.id];
  const loggedIn = !!st?.loggedIn;
  const plan = planLabel(st);
  const error = st && "error" in st ? st.error : null;
  const use = usageText(limits[active.id], usage[active.id]);

  const open = (e: React.MouseEvent) => {
    const acc = useAccounts.getState();
    const needProject = hasProject ? undefined : "Open a project first. The login runs in one of its terminals.";
    const org = accountOrg(st);

    const items: MenuItem[] = [
      {
        custom: (
          <div className="account-menu-head">
            <AccountAvatar account={active} status={st} size={30} />
            <div className="account-menu-id">
              <div className="account-menu-email">{loggedIn ? accountLabel(active, st) : "Not logged in"}</div>
              <div className="account-menu-sub">
                {[plan, loggedIn ? org ?? (active.configDir ? "Separate login" : "Default account") : accountLabel(active, st)].filter(Boolean).join(" · ")}
              </div>
              {use && <div className={`account-menu-usage${use.limited ? " limited" : ""}`} title={use.long}>{use.short}</div>}
            </div>
          </div>
        ),
      },
    ];

    if (showNudge) {
      items.push({
        custom: (
          <div className="account-nudge">
            <div className="account-nudge-text">Add another Claude account to switch between logins without signing in again.</div>
            <div className="row">
              <button
                className="btn primary small"
                onClick={() => {
                  menu.close();
                  openAccountSettings();
                }}
              >
                Add account
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
        const u = usageText(acc.limits[a.id], acc.usage[a.id]);
        items.push({
          label: accountLabel(a, s),
          hint: !s?.loggedIn ? "logged out" : u ? u.short : planLabel(s) ?? undefined,
          title: u?.long,
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
    if (accounts.length > 1) {
      const on = autoSwitchMode() === "everywhere";
      items.push({
        label: "Auto-Switch on Usage Limit",
        checked: on,
        title: "When a Claude session hits its usage limit, switch to the next account that isn't limited and continue there",
        action: () => void useTheming.getState().setSetting(AUTO_SWITCH_SETTING, on ? "off" : "everywhere"),
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
        title={error ?? (loggedIn ? `Claude Code account: ${accountLabel(active, st)}${accountOrg(st) ? `\n${accountOrg(st)}` : ""}${use ? `\n${use.long}` : ""}` : "Claude Code: not logged in")}
        onClick={open}
      >
        <span className="account-dot" />
        <span className="account-name">{st ? (loggedIn ? accountLabel(active, st) : "Not logged in") : "…"}</span>
        {loginsInFlight > 0 ? <span className="account-plan">Logging in…</span> : plan && <span className="account-plan">{plan}</span>}
        {use && loginsInFlight === 0 && <span className={`account-usage${use.limited ? " limited" : ""}`}>{use.short}</span>}
        {showNudge && <span className="account-nudge-dot" />}
        <Icon name="chevronDown" size={12} />
      </button>
      {menu.element}
    </>
  );
}
