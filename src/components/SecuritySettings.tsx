// Settings → Security: where each account's Claude login lives and how well it is protected.
// Read-only checks plus a one-click chmod; tCon never reads or moves the secrets themselves.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { accountLabel, useAccounts } from "../store/accounts";
import { SettingRow, SettingsSection } from "./settingsKit";
import { Badge } from "./ui";

interface Issue {
  severity: "warn" | "info";
  kind: "plaintext-credentials" | "loose-dir" | "loose-file" | "external-symlink" | "shared-credentials" | "missing";
  message: string;
  paths: string[];
  count: number;
  fixable: boolean;
}
interface AccountAudit {
  configDir: string | null;
  path: string;
  exists: boolean;
  dirMode: string | null;
  keychain: { service: string; present: boolean } | null;
  credentialFiles: string[];
  issues: Issue[];
  scanned: number;
  truncated: boolean;
}
interface KeychainAcl {
  service: string;
  anyApplication: boolean;
  trustedApps: string[];
  requiresPassword: boolean;
  partitions: string[];
}

const SECURITY_DOC = "https://github.com/Tomkoooo/tCon/blob/main/SECURITY.md";
const isMac = navigator.userAgent.includes("Mac");

export function SecuritySection() {
  const accounts = useAccounts((s) => s.accounts);
  const status = useAccounts((s) => s.status);
  const [audits, setAudits] = useState<AccountAudit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [acls, setAcls] = useState<KeychainAcl[] | null>(null);
  const [aclBusy, setAclBusy] = useState(false);
  const dirs = accounts.map((a) => a.configDir);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setAudits(await invoke<AccountAudit[]>("security_audit", { configDirs: dirs }));
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };
  useEffect(() => void run(), [dirs.join("\n")]);

  const fix = async () => {
    setBusy(true);
    setError("");
    try {
      const n = await invoke<number>("security_fix_permissions", { configDirs: dirs });
      setNote(n ? `Tightened permissions on ${n} item${n === 1 ? "" : "s"}.` : "Nothing to change.");
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
    await run();
  };

  const inspectKeychain = async () => {
    setAclBusy(true);
    setError("");
    try {
      setAcls(await invoke<KeychainAcl[]>("security_keychain_acl"));
    } catch (e) {
      setError(String(e));
    }
    setAclBusy(false);
  };

  const fixable = audits?.some((a) => a.issues.some((i) => i.fixable)) ?? false;
  const labelFor = (a: AccountAudit) => {
    const acc = accounts.find((x) => x.configDir === a.configDir);
    return acc ? accountLabel(acc, status[acc.id]) : a.path;
  };

  return (
    <SettingsSection
      id="security"
      title="Security"
      description={
        <>
          tCon never stores your Claude logins. Claude Code keeps them {isMac ? "in the macOS Keychain" : "in each account's config folder"}, and
          any program running as you can ask for them the same way Claude Code does.{" "}
          <a href={SECURITY_DOC} onClick={(e) => { e.preventDefault(); void openUrl(SECURITY_DOC).catch(() => {}); }}>What tCon can and can't protect</a>
        </>
      }
    >
      <SettingRow label="Credential check" keywords="security credentials keychain permissions chmod token login secret plaintext symlink" stacked hideLabel modified={false}>
        <div className="account-cards">
          {error && <div className="settings-error">{error}</div>}
          {audits === null && !error && <p className="hint">Checking…</p>}
          {audits?.map((a) => (
            <div key={a.configDir ?? "default"} className="account-card" style={{ alignItems: "flex-start" }}>
              <div className="account-card-main">
                <div className="account-card-title">
                  <span className="account-card-name">{labelFor(a)}</span>
                  {a.keychain && (a.keychain.present ? <Badge tone="ok" title={a.keychain.service}>Login in Keychain</Badge> : <Badge title={a.keychain.service}>No Keychain login</Badge>)}
                  {a.credentialFiles.length > 0 && <Badge tone="warn">Plaintext login file</Badge>}
                  {a.exists && !a.issues.some((i) => i.severity === "warn") && <Badge tone="ok">No problems</Badge>}
                </div>
                <div className="account-card-sub">
                  <code title={a.path}>{a.path}</code>
                  {a.dirMode && (
                    <>
                      <span>·</span>
                      <span>mode {a.dirMode}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{a.scanned.toLocaleString()} items checked{a.truncated ? " (stopped early)" : ""}</span>
                </div>
                {a.issues.map((i) => (
                  <div key={i.kind} className="hint" style={{ marginTop: 4 }}>
                    <span className={`state-dot ${i.severity === "warn" ? "warn" : "ok"}`} /> {i.message}
                    {i.paths.length > 0 && (
                      <>
                        {" "}
                        <code>{i.paths.join(", ")}{i.count > i.paths.length ? ` and ${i.count - i.paths.length} more` : ""}</code>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="row account-actions">
            <button className="btn small" disabled={busy || !fixable} title="chmod go-rwx inside the account folders. Nothing is read, moved or deleted." onClick={() => void fix()}>
              Fix permissions
            </button>
            <button className="btn small ghost" disabled={busy} onClick={() => void run()}>
              {busy ? "Checking…" : "Check again"}
            </button>
            {note && <span className="hint">{note}</span>}
          </div>
          <p className="hint">Claude Code may create new files with looser permissions later; run the check again from time to time.</p>
        </div>
      </SettingRow>

      {isMac && (
        <SettingRow
          label="Keychain access"
          description="Shows which programs may read each Claude Code login from the Keychain without asking you. Reads access lists only; no secret is decrypted. Takes a few seconds."
          keywords="keychain acl access security always allow"
          stacked
          modified={false}
        >
          <div className="account-cards">
            <div className="row">
              <button className="btn small" disabled={aclBusy} onClick={() => void inspectKeychain()}>
                {aclBusy ? "Reading the Keychain…" : acls ? "Inspect again" : "Inspect Keychain access"}
              </button>
            </div>
            {acls?.length === 0 && <p className="hint">No Claude Code logins found in the login Keychain.</p>}
            {acls?.map((k) => (
              <div key={k.service} className="hint">
                <code>{k.service}</code>:{" "}
                {k.anyApplication
                  ? "any application may read it."
                  : k.trustedApps.length
                    ? <>readable{k.requiresPassword ? " after a password prompt" : " without a prompt"} by <code>{k.trustedApps.join(", ")}</code>.</>
                    : "every application has to ask you first."}
                {k.trustedApps.includes("/usr/bin/security") && !k.requiresPassword && (
                  <> That is how Claude Code reads it, and it means any program running as you can read it the same way by calling <code>security</code>.</>
                )}
              </div>
            ))}
            {acls && acls.length > 0 && (
              <p className="hint">
                tCon doesn't change these lists: Claude Code would stop working. If the Keychain ever asks whether an unfamiliar program may use “Claude Code-credentials”, choose Deny, never Always Allow.
              </p>
            )}
          </div>
        </SettingRow>
      )}
    </SettingsSection>
  );
}
