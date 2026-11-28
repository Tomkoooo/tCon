// Which Claude account to switch to when one hits its usage limit. Pure functions (no
// stores, no Tauri) so they can be unit tested: tests/accountRotation.test.ts.
// Times are milliseconds since the epoch.

/** Which limit a message is about: the rolling 5-hour session limit or the weekly one. */
export type UsageWindow = "session" | "weekly";

export function limitWindow(message: string): UsageWindow {
  return /week/i.test(message) ? "weekly" : "session";
}

/** An account that hit its usage limit. */
export interface AccountLimit {
  limitedAt: number;
  window?: UsageWindow;
  /** when the limit resets, if Claude said */
  resetAt: number | null;
  message: string;
}

/** The latest usage warning Claude printed for an account ("used 85% of your weekly limit"). */
export interface AccountUsage {
  /** percent used; null for "Approaching usage limit" */
  percent: number | null;
  resetAt: number | null;
  at: number;
  message: string;
}

/** Usage warnings of one account, per limit window. */
export type AccountUsageByWindow = Partial<Record<UsageWindow, AccountUsage>>;

/** A limit without a reset time blocks the account for this long. */
export const NO_RESET_COOLDOWN = 60 * 60 * 1000;
/** A usage warning without a reset time is shown for this long. */
export const USAGE_TTL = 5 * 60 * 60 * 1000;

export function limitedUntil(l: AccountLimit): number {
  return l.resetAt ?? l.limitedAt + NO_RESET_COOLDOWN;
}

export function isLimited(l: AccountLimit | undefined, now: number): boolean {
  return !!l && limitedUntil(l) > now;
}

export function usageCurrent(u: AccountUsage | undefined, now: number): boolean {
  return !!u && (u.resetAt ? u.resetAt > now : now - u.at < USAGE_TTL);
}

/**
 * The next account after `from` (in list order, wrapping around) that can be used and isn't
 * limited. Returns null when we'd come back around to `from`: every other account is limited
 * or logged out, so switching again would only loop.
 */
export function nextAccount(
  order: string[],
  from: string,
  usable: (id: string) => boolean,
  limits: Record<string, AccountLimit | undefined>,
  now: number,
): string | null {
  const start = order.indexOf(from);
  for (let i = 1; i < order.length; i++) {
    const id = order[(Math.max(start, 0) + i) % order.length];
    if (id !== from && usable(id) && !isLimited(limits[id], now)) return id;
  }
  if (start < 0 && order.length && usable(order[0]) && !isLimited(limits[order[0]], now)) return order[0];
  return null;
}

/** Among usable, limited accounts: the one whose limit lifts first. */
export function earliestReset(
  order: string[],
  usable: (id: string) => boolean,
  limits: Record<string, AccountLimit | undefined>,
  now: number,
): { id: string; at: number } | null {
  let best: { id: string; at: number } | null = null;
  for (const id of order) {
    const l = limits[id];
    if (!usable(id) || !isLimited(l, now)) continue;
    const at = limitedUntil(l!);
    if (!best || at < best.at) best = { id, at };
  }
  return best;
}

/** Drop records whose limit has lifted. */
export function pruneLimits(limits: Record<string, AccountLimit>, now: number): Record<string, AccountLimit> {
  return Object.fromEntries(Object.entries(limits).filter(([, l]) => isLimited(l, now)));
}

/** "15:00", or "Mon 15:00" when it isn't today. */
export function formatReset(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

const WINDOW_LABEL: Record<UsageWindow, string> = { session: "5h", weekly: "Week" };

/** Short usage line for an account: "Limited · resets 15:00", "5h 85% · Week 40%". */
export function usageText(limit: AccountLimit | undefined, usage: AccountUsageByWindow | undefined, now: number = Date.now()): { short: string; long: string; limited: boolean } | null {
  if (limit && isLimited(limit, now)) {
    const at = limitedUntil(limit);
    const when = limit.resetAt ? `resets ${formatReset(at, now)}` : `retry after ${formatReset(at, now)}`;
    const which = limit.window === "weekly" ? "Weekly limit" : "Limited";
    return { short: `${which} · ${when}`, long: `${limit.window === "weekly" ? "Weekly usage" : "Usage"} limit reached, ${when}\n${limit.message}`, limited: true };
  }
  const parts: string[] = [];
  const lines: string[] = [];
  for (const w of ["session", "weekly"] as UsageWindow[]) {
    const u = usage?.[w];
    if (!u || !usageCurrent(u, now)) continue;
    parts.push(`${WINDOW_LABEL[w]} ${u.percent !== null ? `${u.percent}%` : "near limit"}`);
    lines.push(`${w === "weekly" ? "Weekly" : "5-hour"}: ${u.percent !== null ? `${u.percent}% used` : "near the limit"}${u.resetAt ? `, resets ${formatReset(u.resetAt, now)}` : ""}`);
  }
  return parts.length ? { short: parts.join(" · "), long: lines.join("\n"), limited: false } : null;
}
