import { ask } from "@tauri-apps/plugin-dialog";
import { accountLabel, planLabel, useAccounts } from "../store/accounts";
import { useWorkspace } from "../store/workspace";
import { useContextMenu, type MenuItem } from "./ContextMenu";

/** Global Claude account switcher in the window header. */
export function AccountChip() {
  const accounts = useAccounts((s) => s.accounts);
  const activeId = useAccounts((s) => s.activeId);
  const status = useAccounts((s) => s.status);
  const loginsInFlight = useAccounts((s) => Object.keys(s.logins).length);
  const hasProject = useWorkspace((s) => !!s.activeProjectId);
  const menu = useContextMenu();

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];
  const st = status[active.id];
  const loggedIn = !!st?.loggedIn;
  const plan = planLabel(st);
  const error = st && "error" in st ? st.error : null;

  const open = (e: React.MouseEvent) => {
    const acc = useAccounts.getState();
    const noProject = hasProject ? "" : " (open a project first)";
    const items: MenuItem[] = accounts.map((a) => {
      const s = acc.status[a.id];
      const p = planLabel(s);
      return {
        label: `${a.id === activeId ? "✓" : " "} ${accountLabel(a, s)}${s?.loggedIn ? "" : " — logged out"}`,
        hint: p ?? undefined,
        action: () => void acc.setActive(a.id),
      };
    });
    items.push(
      "sep",
      { label: loggedIn ? `Log In Again…${noProject}` : `Log In…${noProject}`, action: () => acc.login(active.id, loggedIn) },
      ...(loggedIn
        ? [{
            label: "Log Out",
            action: async () => {
              if (await ask(`Log out ${accountLabel(active, st)} from Claude Code?\n\nRunning sessions keep working until restarted.`, { title: "Log out", kind: "warning" }))
                await acc.logout(active.id);
            },
          }]
        : []),
      { label: `Add Account…${noProject}`, action: () => void acc.add() },
      ...(active.configDir
        ? [{
            label: "Remove This Account",
            action: async () => {
              if (await ask(`Remove ${accountLabel(active, st)} from tCon? It will be logged out.`, { title: "Remove account", kind: "warning" }))
                await acc.remove(active.id);
            },
          }]
        : []),
      "sep",
      { label: "Refresh Status", action: () => void acc.refresh() },
    );
    menu.open(e, items);
  };

  return (
    <>
      <button
        className={`account-chip${loggedIn ? "" : " warn"}`}
        title={error ?? (loggedIn ? `Claude Code account: ${accountLabel(active, st)}${st && "orgName" in st && st.orgName ? `\n${st.orgName}` : ""}` : "Claude Code: not logged in")}
        onClick={open}
      >
        <span className="account-dot" />
        <span className="account-name">{st ? (loggedIn ? accountLabel(active, st) : "Not logged in") : "…"}</span>
        {plan && <span className="account-plan">{plan}</span>}
        {loginsInFlight > 0 && <span className="account-plan">login…</span>}
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
      {menu.element}
    </>
  );
}
