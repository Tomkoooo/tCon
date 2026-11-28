// Settings (⌘,). Kept under its historic file/export name; the old "launch profiles" editor is
// gone — Claude accounts (store/accounts.ts) replace it. Legacy profiles still apply their env
// and are listed under Advanced so they can be cleaned up.
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { accountLabel, planLabel, useAccounts } from "../store/accounts";
import { useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { MODEL_PRESETS, MODEL_SETTING, isPresetModel, normalizeModel } from "../claudeModel";
import type { Account } from "../types";
import { Modal } from "./Modal";
import { AccountAvatar, accountOrg } from "./AccountChip";
import { AppearanceSection, KeybindingsSection, TerminalSection, openConfigInEditor } from "./AppearanceSettings";
import { SecuritySection } from "./SecuritySettings";
import { BackgroundSection } from "./BackgroundSettings";
import { SettingRow, SettingsGroup, SettingsSearch, SettingsSection, useSetting } from "./settingsKit";
import { usageText } from "../accountRotation";
import { AUTO_SWITCH_SETTING } from "../autoSwitch";
import { BrowserSection } from "./browser/BrowserSettings";
import { UpdatesSection } from "./UpdateSettings";
import { NotificationsSection } from "./NotificationSettings";
import { Badge, CommitInput, Segmented } from "./ui";
import { Icon } from "./icons";

const SECTIONS = [
  { id: "accounts", label: "Accounts", icon: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5.5 6c.4-2.6 2.7-4.5 5.5-4.5s5.1 1.9 5.5 4.5" },
  { id: "claude", label: "Claude", icon: "M8 1.5l1.6 4.1 4.4.3-3.4 2.8 1.1 4.3L8 10.6 4.3 13l1.1-4.3L2 5.9l4.4-.3z" },
  { id: "notifications", label: "Notifications", icon: "M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0" },
  { id: "appearance", label: "Appearance", icon: "M8 1.5a6.5 6.5 0 1 0 0 13c.8 0 1.2-.5 1.2-1.1 0-.8-.6-1-.6-1.7 0-.6.5-1 1.1-1H11a3.5 3.5 0 0 0 3.5-3.5C14.5 4 11.6 1.5 8 1.5z" },
  { id: "terminal", label: "Terminal", icon: "M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3.5" },
  { id: "browser", label: "Browser", icon: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c1.8 1.8 2.7 4 2.7 6.5S9.8 12.7 8 14.5C6.2 12.7 5.3 10.5 5.3 8S6.2 3.3 8 1.5z" },
  { id: "background", label: "Quick panel & background", icon: "M2.5 3.5h11v9h-11zM5 6.5h6M5 9.5h3.5" },
  { id: "keyboard", label: "Keyboard Shortcuts", icon: "M1.5 4h13v8h-13zM4 6.5h1m2 0h1m2 0h1M4 9.5h8" },
  { id: "security", label: "Security", icon: "M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4zM5.8 8l1.6 1.6 2.9-3" },
  { id: "updates", label: "Updates", icon: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" },
  { id: "advanced", label: "Advanced", icon: "M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M5 10.5v3" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export function ProfilesModal() {
  const setModal = useWorkspace((s) => s.setModal);
  const initial = useWorkspace((s) => (s.modal?.kind === "profiles" ? s.modal.section : undefined));
  const [section, setSection] = useState<SectionId>(SECTIONS.some((s) => s.id === initial) ? (initial as SectionId) : "accounts");
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initial && SECTIONS.some((s) => s.id === initial)) setSection(initial as SectionId);
  }, [initial]);
  useEffect(() => contentRef.current?.scrollTo({ top: 0 }), [section, query]);

  const q = query.trim();
  const show = (id: SectionId) => !!q || section === id;

  return (
    <Modal
      title="Settings"
      className="settings-modal"
      onClose={() => setModal(null)}
      actions={
        <button className="btn small ghost" onClick={() => openConfigInEditor("settings.json")}>
          Open settings.json
        </button>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <input
            ref={searchRef}
            className="ui-input settings-search"
            placeholder="Search settings"
            value={query}
            autoFocus
            data-esc-clear={query ? "1" : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item${!q && section === s.id ? " on" : ""}`}
              onClick={() => {
                setQuery("");
                setSection(s.id);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={s.icon} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
              <span className="settings-nav-label">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className={`settings-content${q ? " searching" : ""}`} ref={contentRef}>
          <SettingsSearch.Provider value={q}>
            {show("accounts") && <AccountsSection />}
            {show("claude") && <ClaudeSection />}
            {show("notifications") && <NotificationsSection />}
            {show("appearance") && <AppearanceSection />}
            {show("terminal") && <TerminalSection />}
            {show("browser") && <BrowserSection />}
            {show("background") && <BackgroundSection />}
            {show("keyboard") && <KeybindingsSection />}
            {show("security") && <SecuritySection />}
            {show("updates") && <UpdatesSection />}
            {show("advanced") && <AdvancedSection />}
          </SettingsSearch.Provider>
          {q && <div className="settings-empty">No settings match “{q}”</div>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Accounts

function AccountsSection() {
  const accounts = useAccounts((s) => s.accounts);
  const refreshing = useAccounts((s) => s.refreshing);
  const hasProject = useWorkspace((s) => !!s.activeProjectId);
  const add = async () => {
    useWorkspace.getState().setModal(null); // show the login terminal
    await useAccounts.getState().add();
  };

  return (
    <SettingsSection
      id="accounts"
      title="Accounts"
      description="Each account keeps its own saved login. New Claude sessions in every project use the active account."
    >
      <SettingRow label="Claude accounts" keywords="account login logout switch email plan subscription claude config dir profile" stacked hideLabel modified={false}>
        <div className="account-cards">
          {accounts.length === 1 && (
            <div className="onboard-card">
              <div className="onboard-text">
                <span className="onboard-title">Add another account</span>
                <span className="hint">{hasProject ? "Sign in once, then switch without logging in again." : "Open a project first. The login runs in one of its terminals."}</span>
              </div>
              <button className="btn small" disabled={!hasProject} onClick={add}>Add account</button>
            </div>
          )}
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} hasProject={hasProject} />
          ))}
          <div className="row account-actions">
            {accounts.length > 1 && (
              <button className="btn small" disabled={!hasProject} title={hasProject ? undefined : "Open a project first"} onClick={add}>
                <Icon name="plus" size={14} />
                Add account
              </button>
            )}
            <button className="btn small ghost" disabled={refreshing} onClick={() => void useAccounts.getState().refresh()}>
              {refreshing ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
          <p className="hint">Running sessions keep their account. After a switch, tCon offers to restart idle ones on the new account.</p>
        </div>
      </SettingRow>
      <AutoSwitchRow />
    </SettingsSection>
  );
}

function AutoSwitchRow() {
  const [mode, setMode] = useSetting<string>(AUTO_SWITCH_SETTING, "off");
  return (
    <SettingRow
      label="Switch accounts on usage limit"
      settingKey={AUTO_SWITCH_SETTING}
      keywords="auto switch rotate usage limit weekly 5-hour reset quota"
      description="When a Claude session hits its 5-hour or weekly limit, switch to the next account that isn't limited and continue there. If every account is limited, tCon stops and switches to the first one that resets. A board's run queue can turn this on for its own agents only."
    >
      <Segmented<string>
        ariaLabel="Switch accounts on usage limit"
        value={mode === "everywhere" ? "everywhere" : "off"}
        onChange={setMode}
        options={[
          { value: "off", label: "Off", title: "Only boards that opt in switch accounts" },
          { value: "everywhere", label: "All sessions" },
        ]}
      />
    </SettingRow>
  );
}

function AccountCard({ account, hasProject }: { account: Account; hasProject: boolean }) {
  const st = useAccounts((s) => s.status[account.id]);
  const activeId = useAccounts((s) => s.activeId);
  const loggingIn = useAccounts((s) => Object.values(s.logins).includes(account.id));
  const use = usageText(useAccounts((s) => s.limits[account.id]), useAccounts((s) => s.usage[account.id]));
  const acc = useAccounts.getState;
  const active = account.id === activeId;
  const loggedIn = !!st?.loggedIn;
  const plan = planLabel(st);
  const org = accountOrg(st);
  const error = st && "error" in st ? st.error : null;
  const name = accountLabel(account, st);
  const dir = account.configDir ? account.configDir.replace(/^\/Users\/[^/]+/, "~") : "~/.claude";

  const login = (relogin: boolean) => {
    useWorkspace.getState().setModal(null);
    acc().login(account.id, relogin);
  };

  return (
    <div className={`account-card${active ? " active" : ""}`}>
      <AccountAvatar account={account} status={st} size={34} />
      <div className="account-card-main">
        <div className="account-card-title">
          <span className="account-card-name">{loggedIn ? name : account.configDir ? "Not logged in" : "Default account"}</span>
          {active && <Badge tone="accent">Active</Badge>}
        </div>
        <div className="account-card-sub">
          <span className={`state-dot ${loggedIn ? "ok" : "warn"}`} />
          {st === undefined ? "Checking…" : loggingIn ? "Logging in…" : loggedIn ? [plan, org ?? "Logged in"].filter(Boolean).join(" · ") : error ? "Status unavailable" : "Logged out"}
          <span>·</span>
          <code title={account.configDir ?? "~/.claude"}>{dir}</code>
        </div>
        {use && <div className={`account-card-usage${use.limited ? " limited" : ""}`} title={use.long}>{use.limited ? use.short : use.long}</div>}
        {error && <div className="settings-error">{error}</div>}
      </div>
      <div className="account-card-actions">
        {!active && (
          <button className={`btn small${loggedIn ? " primary" : ""}`} onClick={() => void acc().setActive(account.id)} title="Use this account for new Claude sessions">
            Switch
          </button>
        )}
        {!loggedIn ? (
          <button className="btn small" disabled={!hasProject || loggingIn} title={hasProject ? undefined : "Open a project first"} onClick={() => login(false)}>
            Log in
          </button>
        ) : (
          <button
            className="btn small ghost"
            onClick={async () => {
              if (await ask(`Log out ${name} from Claude Code?\n\nRunning sessions keep working until restarted.`, { title: "Log out", kind: "warning" })) await acc().logout(account.id);
            }}
          >
            Log out
          </button>
        )}
        {account.configDir && (
          <button
            className="btn small ghost danger"
            title="Remove this account from tCon (logs it out)"
            onClick={async () => {
              if (await ask(`Remove ${name} from tCon? It will be logged out.`, { title: "Remove account", kind: "warning" })) await acc().remove(account.id);
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Claude

export function ModelPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const preset = isPresetModel(value);
  const [custom, setCustom] = useState(!preset);
  useEffect(() => setCustom(!isPresetModel(value)), [value]);
  return (
    <div className="model-picker">
      <Segmented
        ariaLabel="Claude model"
        value={custom ? "custom" : value}
        onChange={(v) => {
          if (v === "custom") setCustom(true);
          else {
            setCustom(false);
            onChange(v);
          }
        }}
        options={[...MODEL_PRESETS.map((m) => ({ value: m.value as string, label: m.label, title: m.title })), { value: "custom", label: "Custom…", title: "Any model name or ID accepted by claude --model" }]}
      />
      {custom && (
        <CommitInput
          mono
          width={240}
          value={preset ? "" : value}
          placeholder="e.g. opusplan or a full model ID"
          onCommit={(v) => onChange(v.trim() || "default")}
        />
      )}
    </div>
  );
}

function ClaudeSection() {
  const raw = useTheming((s) => s.settings[MODEL_SETTING]);
  const setSetting = useTheming((s) => s.setSetting);
  const overrides = useWorkspace((s) => Object.values(s.projects).filter((p) => p.claudeModel).length);
  return (
    <SettingsSection id="claude" title="Claude" description="Defaults for new Claude Code sessions started by tCon.">
      <SettingRow
        label="Default model"
        settingKey={MODEL_SETTING}
        keywords="model opus sonnet haiku --model"
        stacked
        description={
          <>
            Passed as <code>--model</code> when a new session starts. Aliases always resolve to the latest model of that family.
            {overrides > 0 && ` ${overrides} project${overrides > 1 ? "s override" : " overrides"} this in Project Settings.`}
          </>
        }
      >
        <ModelPicker value={normalizeModel(raw)} onChange={(v) => void setSetting(MODEL_SETTING, v)} />
      </SettingRow>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------- Advanced

function AdvancedSection() {
  const dir = useTheming((s) => s.dir);
  const rescan = useTheming((s) => s.rescan);
  const errs = [useTheming((s) => s.settingsError), useTheming((s) => s.keybindingsError)].filter(Boolean) as string[];
  const profiles = useWorkspace((s) => s.profiles);
  const projects = useWorkspace((s) => s.projects);
  const [scanning, setScanning] = useState(false);

  return (
    <SettingsSection id="advanced" title="Advanced">
      {errs.map((e) => (
        <div key={e} className="settings-error">{e}</div>
      ))}
      <SettingRow label="Configuration files" description={<>Stored in <code>{dir ? dir.replace(/^\/Users\/[^/]+/, "~") : "~/.tcon"}</code>. Edits apply on save.</>} keywords="settings.json keybindings.json custom.css json config folder" stacked modified={false}>
        <div className="row wrap">
          <button className="btn" onClick={() => openConfigInEditor("settings.json")}>settings.json</button>
          <button className="btn" onClick={() => openConfigInEditor("keybindings.json")}>keybindings.json</button>
          <button className="btn" onClick={() => openConfigInEditor("custom.css")}>custom.css</button>
          <button className="btn ghost" onClick={() => dir && void revealItemInDir(dir).catch(() => {})}>Reveal folder</button>
        </div>
      </SettingRow>
      <SettingRow label="Rescan themes" description="Look for newly installed color and icon themes." keywords="themes extensions reload" modified={false}>
        <button
          className="btn"
          disabled={scanning}
          onClick={async () => {
            setScanning(true);
            await rescan();
            setScanning(false);
          }}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </SettingRow>
      {profiles.length > 0 && (
        <>
          <SettingsGroup title="Legacy launch profiles" />
          <SettingRow
            label="Launch profiles"
            keywords="profiles environment env legacy CLAUDE_CONFIG_DIR"
            stacked
            modified={false}
            description="Replaced by Accounts. Projects using a profile still get its variables; move them to Project Settings → Environment, then delete the profile."
          >
            <div className="legacy-list">
              {profiles.map((p) => {
                const used = Object.values(projects).filter((x) => x.profileId === p.id).length;
                return (
                  <div key={p.id} className="legacy-item">
                    <span className="swatch" style={{ background: p.color, width: 10, height: 10 }} />
                    <span className="legacy-name">{p.name}</span>
                    <code className="legacy-env">{Object.keys(p.env).join(", ") || "no variables"}</code>
                    <span className="hint">{used ? `used by ${used} project${used > 1 ? "s" : ""}` : "unused"}</span>
                    <button
                      className="btn small ghost danger"
                      onClick={async () => {
                        if (used && !(await ask(`${used} open project${used > 1 ? "s use" : " uses"} "${p.name}". Its environment variables will no longer be applied to new terminals. Delete it?`, { title: "Delete profile", kind: "warning" }))) return;
                        await api.profileDelete(p.id);
                        await useWorkspace.getState().loadProfiles();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}
