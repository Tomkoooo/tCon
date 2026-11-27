// Non-blocking update notice (top right). State and logic live in src/updater.ts.
import { openUrl } from "@tauri-apps/plugin-opener";
import { releaseNotesUrl, useUpdater } from "../updater";
import { Icon } from "./icons";
import "./UpdateNotice.css";

export const formatBytes = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** "Install & restart" progress, shared by the notice and Settings → Updates. */
export function UpdateProgress() {
  const downloaded = useUpdater((s) => s.downloaded);
  const total = useUpdater((s) => s.total);
  const phase = useUpdater((s) => s.phase);
  const pct = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  return (
    <div className="upd-progress">
      <div className="upd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={`upd-bar-fill${pct === null ? " indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <span className="upd-progress-text">
        {phase === "installing" ? "Installing, tCon will restart…" : total ? `${formatBytes(downloaded)} of ${formatBytes(total)}` : downloaded ? formatBytes(downloaded) : "Starting download…"}
      </span>
    </div>
  );
}

export function UpdateNotice() {
  const open = useUpdater((s) => s.noticeOpen);
  const phase = useUpdater((s) => s.phase);
  const available = useUpdater((s) => s.available);
  const error = useUpdater((s) => s.error);
  const manual = useUpdater((s) => s.manual);
  const current = useUpdater((s) => s.current);
  const { install, dismiss, checkNow } = useUpdater.getState();
  if (!open) return null;
  if ((phase === "upToDate" || phase === "error" || phase === "checking") && !manual) return null;

  let title: string;
  let sub: React.ReactNode = null;
  let actions: React.ReactNode = null;
  switch (phase) {
    case "checking":
      title = "Checking for updates…";
      break;
    case "upToDate":
      title = "tCon is up to date";
      sub = current ? `Version ${current}` : null;
      actions = <button className="btn small ghost" onClick={dismiss}>OK</button>;
      break;
    case "error":
      title = available ? "Update failed" : "Couldn't check for updates";
      sub = <span title={error ?? undefined}>{error}</span>;
      actions = (
        <>
          <button className="btn small" onClick={() => void checkNow(true)}>Retry</button>
          <button className="btn small ghost" onClick={dismiss}>Close</button>
        </>
      );
      break;
    case "downloading":
    case "installing":
      title = `Updating to tCon ${available?.version ?? ""}`;
      sub = <UpdateProgress />;
      break;
    default:
      if (!available) return null;
      title = `tCon ${available.version} is available`;
      sub = (
        <>
          {current ? `You have ${current}. ` : ""}
          <button className="link-btn" onClick={() => void openUrl(releaseNotesUrl(available.version)).catch(() => {})}>
            Release notes
          </button>
        </>
      );
      actions = (
        <>
          <button className="btn small primary" onClick={() => void install()}>Install &amp; restart</button>
          <button className="btn small ghost" onClick={dismiss}>Later</button>
        </>
      );
  }

  return (
    <div className="upd-notice" role="status" aria-live="polite">
      <span className="upd-icon"><Icon name={phase === "error" ? "close" : phase === "upToDate" ? "check" : "arrowDown"} size={14} /></span>
      <div className="upd-body">
        <div className="upd-title">{title}</div>
        {sub && <div className="upd-sub">{sub}</div>}
      </div>
      {actions && <div className="upd-actions">{actions}</div>}
    </div>
  );
}
