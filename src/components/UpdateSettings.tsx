// Settings → Updates: current version, manual check, auto-check and channel.
import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AUTO_CHECK_SETTING, CHANNEL_SETTING, RELEASES_URL, releaseNotesUrl, useUpdater } from "../updater";
import { SettingRow, SettingsSection, useSetting } from "./settingsKit";
import { Segmented, Toggle } from "./ui";
import { UpdateProgress } from "./UpdateNotice";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function UpdatesSection() {
  const [autoCheck, setAutoCheck] = useSetting<boolean>(AUTO_CHECK_SETTING, true);
  const [, setChannel] = useSetting<string>(CHANNEL_SETTING, "stable"); // only "stable" exists for now
  const current = useUpdater((s) => s.current);
  const phase = useUpdater((s) => s.phase);
  const available = useUpdater((s) => s.available);
  const error = useUpdater((s) => s.error);
  const lastChecked = useUpdater((s) => s.lastChecked);
  const { checkNow, install } = useUpdater.getState();
  useEffect(() => void useUpdater.getState().loadVersion(), []);

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const status =
    phase === "checking" ? "Checking…"
    : phase === "available" && available ? `tCon ${available.version} is available.`
    : phase === "upToDate" ? "You're up to date."
    : phase === "error" ? `Last check failed: ${error}`
    : null;

  return (
    <SettingsSection id="updates" title="Updates" description="tCon updates itself from its GitHub releases. Updates are signed and verified before they're installed.">
      <SettingRow
        label="Version"
        keywords="version about update check release notes changelog"
        modified={false}
        description={
          <span className="upd-settings-status">
            <span>
              tCon <code>{current ?? "…"}</code>
              {lastChecked && ` · checked ${ago(lastChecked)}`}
            </span>
            {status && <span>{status}</span>}
            {(phase === "downloading" || phase === "installing") && <UpdateProgress />}
          </span>
        }
      >
        <div className="row wrap">
          {phase === "available" && available ? (
            <>
              <button className="btn primary" onClick={() => void install()}>Install &amp; restart</button>
              <button className="btn ghost" onClick={() => void openUrl(releaseNotesUrl(available.version)).catch(() => {})}>Release notes</button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => void checkNow(true)}>
              {phase === "checking" ? "Checking…" : "Check for Updates…"}
            </button>
          )}
          {phase !== "available" && (
            <button className="btn ghost" onClick={() => void openUrl(current ? releaseNotesUrl(current) : RELEASES_URL).catch(() => {})}>Release notes</button>
          )}
        </div>
      </SettingRow>
      <SettingRow
        label="Check automatically"
        settingKey={AUTO_CHECK_SETTING}
        keywords="update auto check background startup"
        description="Look for a new version shortly after launch and every 6 hours. You choose when to install."
      >
        <Toggle checked={autoCheck} onChange={setAutoCheck} />
      </SettingRow>
      <SettingRow
        label="Channel"
        settingKey={CHANNEL_SETTING}
        keywords="update channel stable alpha beta prerelease"
        description="While tCon is below 1.0, alpha builds are published on the stable channel, so you get them automatically."
      >
        <Segmented
          ariaLabel="Update channel"
          value="stable"
          onChange={setChannel}
          options={[{ value: "stable", label: "Stable", title: "Every published release (alphas included before 1.0)" }]}
        />
      </SettingRow>
    </SettingsSection>
  );
}
