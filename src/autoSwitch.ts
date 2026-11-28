// Automatic account switching on Claude usage limits (setting `claude.accountAutoSwitch`, or a
// board's "Switch accounts on usage limit" for its run queue). When a session hits its limit,
// tCon records it on that session's account and switches the active account to the next one
// that isn't limited. If every account is limited (we came back around), it stops and
// switches to the account whose limit resets first, at that time.
import { listen } from "@tauri-apps/api/event";
import { earliestReset, formatReset, isLimited, nextAccount } from "./accountRotation";
import { notifyTask } from "./notify";
import { accountEnv, accountForConfigDir, accountLabel, restartOnActiveAccount, useAccounts } from "./store/accounts";
import { findPane, paneConfigDir, useWorkspace } from "./store/workspace";
import { useTheming } from "./theming/store";

export const AUTO_SWITCH_SETTING = "claude.accountAutoSwitch";
export type AutoSwitchMode = "off" | "everywhere";

export function autoSwitchMode(): AutoSwitchMode {
  return useTheming.getState().settings[AUTO_SWITCH_SETTING] === "everywhere" ? "everywhere" : "off";
}

export type LimitOutcome =
  /** auto-switch is off for this session (the limit is still recorded) */
  | { kind: "off" }
  /** the session's account isn't one of tCon's accounts (e.g. a project env override) */
  | { kind: "foreign" }
  /** switched the active account to `to` */
  | { kind: "switched"; to: string; prevConfig: string | null }
  /** the active account is already a different, usable one: just move the session to it */
  | { kind: "move"; prevConfig: string | null }
  /** every account is limited; a switch is scheduled for the first reset (if any is known) */
  | { kind: "exhausted"; nextAt: number | null };

const usable = (id: string) => {
  const s = useAccounts.getState();
  return id === s.activeId || !!s.status[id]?.loggedIn;
};
const nameOf = (id: string) => {
  const s = useAccounts.getState();
  const a = s.accounts.find((x) => x.id === id);
  return a ? accountLabel(a, s.status[id]) : id;
};

/** Config dir a pane runs with (what it was started with; the active account as a fallback). */
function paneDir(paneId: string): string | null {
  const d = paneConfigDir(paneId);
  return d === undefined ? accountEnv().CLAUDE_CONFIG_DIR ?? null : d;
}

let wakeTimer: number | undefined;

/** Switch at the first reset once every account was limited. */
function scheduleWake(at: number) {
  window.clearTimeout(wakeTimer);
  wakeTimer = window.setTimeout(() => void wake(), Math.max(10_000, at - Date.now() + 30_000));
}

async function wake() {
  wakeTimer = undefined;
  const acc = useAccounts.getState();
  acc.pruneLimits();
  const now = Date.now();
  const order = acc.accounts.map((a) => a.id);
  if (!isLimited(acc.limits[acc.activeId], now)) return; // the active one reset; agents resume on their own timer
  const to = nextAccount(order, acc.activeId, usable, acc.limits, now);
  if (to) {
    await acc.setActive(to, { promptRestart: false });
    void notifyTask("Claude account switched", `${nameOf(to)}'s usage limit has reset. Limited agents continue there.`);
    return;
  }
  const next = earliestReset(order, usable, acc.limits, now);
  if (next) scheduleWake(next.at);
}

/**
 * A pane printed Claude's usage-limit message. Records it on the pane's account and, when
 * auto-switch applies (`everywhere`, or `boardOptIn` for a task agent), switches accounts.
 * Task agents are moved by the agent runtime (it watches account switches); for other
 * sessions pass `restartPane` and the session is resumed on the new account here.
 */
export async function handleLimit(paneId: string, message: string, resetAtSec: number | null, opts: { boardOptIn?: boolean; restartPane?: boolean } = {}): Promise<LimitOutcome> {
  const acc = useAccounts.getState();
  const prevConfig = paneDir(paneId);
  const account = accountForConfigDir(prevConfig);
  if (!account) return { kind: "foreign" };
  acc.markLimited(account.id, resetAtSec ? resetAtSec * 1000 : null, message);
  if (autoSwitchMode() !== "everywhere" && !opts.boardOptIn) return { kind: "off" };

  const now = Date.now();
  const order = acc.accounts.map((a) => a.id);
  const limits = useAccounts.getState().limits;
  const active = useAccounts.getState().activeId;
  let outcome: LimitOutcome;
  if (active !== account.id && usable(active) && !isLimited(limits[active], now)) {
    outcome = { kind: "move", prevConfig };
  } else {
    const to = nextAccount(order, active, usable, limits, now);
    if (to) {
      await useAccounts.getState().setActive(to, { promptRestart: false });
      void notifyTask("Claude account switched", `${nameOf(account.id)} hit its usage limit. New sessions and limited agents now use ${nameOf(to)}.`);
      outcome = { kind: "switched", to, prevConfig };
    } else {
      const next = earliestReset(order, usable, limits, now);
      if (next) scheduleWake(next.at);
      void notifyTask(
        "Every Claude account is limited",
        next ? `tCon switches to ${nameOf(next.id)} when its limit resets (${formatReset(next.at)}).` : "No reset time is known yet. Switch accounts by hand when one is free again.",
      );
      return { kind: "exhausted", nextAt: next?.at ?? null };
    }
  }
  if (opts.restartPane && findPane(useWorkspace.getState(), paneId)) {
    await restartOnActiveAccount(paneId, prevConfig, new Set(), "Continue where you left off.");
  }
  return outcome;
}

let installed = false;
/** Record usage warnings per account and resume a pending wake-up after a restart. Call once. */
export function installAutoSwitch(): () => void {
  if (installed) return () => {};
  installed = true;
  const off = listen<{ paneId: string; usage: { message: string; percent: number | null; resetAt: number | null } }>("pane-usage", ({ payload }) => {
    const account = accountForConfigDir(paneDir(payload.paneId));
    if (!account) return;
    const { message, percent, resetAt } = payload.usage;
    useAccounts.getState().noteUsage(account.id, { message, percent, resetAt: resetAt ? resetAt * 1000 : null, at: Date.now() });
  });
  // Every account limited when tCon was last closed: pick the wake-up up again.
  const resume = window.setTimeout(() => {
    const acc = useAccounts.getState();
    if (autoSwitchMode() !== "everywhere" || !isLimited(acc.limits[acc.activeId], Date.now())) return;
    const next = earliestReset(acc.accounts.map((a) => a.id), usable, acc.limits, Date.now());
    if (next) scheduleWake(next.at);
  }, 5000);
  // Expired limits drop off the chip and the account list.
  const prune = window.setInterval(() => useAccounts.getState().pruneLimits(), 60_000);
  return () => {
    installed = false;
    void off.then((f) => f());
    window.clearTimeout(resume);
    window.clearInterval(prune);
    window.clearTimeout(wakeTimer);
  };
}
