import type { PaneStatus } from "../types";

const LABEL: Record<string, string> = {
  idle: "Idle — waiting for input",
  working: "Working",
  blocked: "Needs you",
  done: "Done",
  error: "Error",
  exited: "Exited",
  unknown: "Unknown",
};

export function statusLabel(st?: PaneStatus | null) {
  if (!st) return "";
  let s = LABEL[st.state] ?? st.state;
  if (st.state === "blocked" && st.kind) s += ` (${st.kind})`;
  if (st.msg) s += ` — ${st.msg}`;
  return s;
}

export function StatusDot({ status }: { status?: PaneStatus | null }) {
  if (!status) return <span className="status-dot none" />;
  return <span className={`status-dot ${status.state}${status.seen ? " seen" : ""}`} title={statusLabel(status)} />;
}
