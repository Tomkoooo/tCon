// Settings → Browser: default engine, the Chrome binary / port / profile, session import and
// clearing the built-in engine's data.
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { browserApi, type ChromeFamily, type ImportSource } from "../../browser/api";
import { CHROME_PATH_SETTING, CHROME_PORT_SETTING, DEFAULT_CHROME_PORT, ENGINE_SETTING, useBrowser } from "../../browser/store";
import { SettingRow, SettingsGroup, SettingsSection, useSetting } from "../settingsKit";
import { CommitInput, Segmented, Select } from "../ui";
import "./browser.css";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
const CUSTOM = "__custom__";

export function BrowserSection() {
  const [engine, setEngine] = useSetting<string>(ENGINE_SETTING, "builtin");
  const [path, setPath] = useSetting<string>(CHROME_PATH_SETTING, "");
  const [port, setPort] = useSetting<number>(CHROME_PORT_SETTING, DEFAULT_CHROME_PORT);
  const chrome = useBrowser((s) => s.chrome);
  const info = useBrowser((s) => s.info);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    void useBrowser.getState().refreshChrome();
    void useBrowser.getState().loadInfo();
  }, [path]);

  const detected = chrome?.detected ?? [];
  const isCustom = custom || (!!path && !detected.some((b) => b.path === path));

  return (
    <SettingsSection
      id="browser"
      title="Browser"
      description="Open your dev servers next to the code. The built-in engine shows pages as editor tabs; the Chrome engine drives your installed Chrome on a separate tCon profile, with extensions and Chrome DevTools."
    >
      <SettingRow label="Default engine" settingKey={ENGINE_SETTING} keywords="browser chrome webkit built-in open url dev server">
        <Segmented
          value={engine === "chrome" ? "chrome" : "builtin"}
          onChange={setEngine}
          ariaLabel="Default engine"
          options={[
            { value: "builtin", label: "Built-in", title: "Editor tab (WebKit on macOS)" },
            { value: "chrome", label: "Chrome", title: "Your Chrome on the tCon profile, in its own window" },
          ]}
        />
      </SettingRow>

      <SettingsGroup title="Chrome engine" />
      <SettingRow
        label="Browser"
        settingKey={CHROME_PATH_SETTING}
        keywords="chrome chromium brave edge binary path executable"
        description={chrome?.binary ? <code>{tilde(chrome.binary.path)}</code> : path ? "Not found at this path." : "No Chromium-family browser detected."}
        stacked={isCustom}
      >
        <div className="row wrap">
          <Select
            value={isCustom ? CUSTOM : path}
            ariaLabel="Chrome binary"
            onChange={(v) => {
              if (v === CUSTOM) return setCustom(true);
              setCustom(false);
              setPath(v);
            }}
          >
            <option value="">Auto{detected[0] ? ` (${detected[0].name})` : ""}</option>
            {detected.map((b) => (
              <option key={b.path} value={b.path}>{b.name}</option>
            ))}
            <option value={CUSTOM}>Custom path…</option>
          </Select>
          {isCustom && <CommitInput value={path} onCommit={(v) => setPath(v.trim())} placeholder="/Applications/…/Contents/MacOS/…" mono width={360} />}
        </div>
      </SettingRow>
      <SettingRow
        label="Debugging port"
        settingKey={CHROME_PORT_SETTING}
        keywords="cdp remote debugging port mcp devtools"
        description="Bound to 127.0.0.1 only. Kept stable so an MCP config pointing at it keeps working; a free port is used if it's taken."
      >
        <CommitInput type="number" min={1024} max={65535} value={String(port)} onCommit={(v) => setPort(Number(v) || DEFAULT_CHROME_PORT)} width={100} />
      </SettingRow>
      <SettingRow
        label="Profile"
        keywords="chrome profile user data dir folder"
        modified={false}
        description={
          <>
            <code>{chrome ? tilde(chrome.profileDir) : "~/.tcon/browser/chrome-profile"}</code>. Any local program can control a browser with an open debugging
            port, so tCon never uses your main profile.
          </>
        }
      >
        <button className="btn" disabled={!chrome?.profileExists} onClick={() => chrome && void revealItemInDir(chrome.profileDir).catch(() => {})}>
          Reveal
        </button>
      </SettingRow>
      <ImportRow binaryFamily={chrome?.binary?.family ?? null} binaryName={chrome?.binary?.name ?? null} running={!!chrome?.running} />

      <SettingsGroup title="Built-in engine" />
      <SettingRow
        label="Clear browsing data"
        keywords="cookies storage cache logins reset built-in webkit"
        modified={false}
        description={
          info && !info.isolatedStore
            ? "On macOS 13 and older the built-in browser shares tCon's own WebKit storage, so it can't be cleared separately."
            : "Signs you out of every site in the built-in browser and deletes its cookies, storage and cache. The Chrome profile isn't affected."
        }
      >
        <button
          className="btn danger"
          disabled={!!info && !info.isolatedStore}
          onClick={async () => {
            if (!(await ask("Delete all cookies, site storage and cache of the built-in browser?", { title: "Clear browsing data", kind: "warning" }))) return;
            try {
              await browserApi.clearData();
              useBrowser.getState().setNotice("Built-in browsing data cleared.");
            } catch (err) {
              useBrowser.getState().setNotice(String(err), true);
            }
          }}
        >
          Clear…
        </button>
      </SettingRow>
    </SettingsSection>
  );
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.ceil(n / 1e3)} KB`);

function ImportRow({ binaryFamily, binaryName, running }: { binaryFamily: ChromeFamily | null; binaryName: string | null; running: boolean }) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    void browserApi.importSources().then(setSources).catch(() => setSources([]));
  }, []);

  const run = async (s: ImportSource) => {
    const profile = pick[s.userDataDir] ?? s.profiles[0]?.dir;
    if (!profile) return;
    const name = s.profiles.find((p) => p.dir === profile)?.name ?? profile;
    const warn = [
      `Copy ${s.browser} profile “${name}” (cookies, logins, storage, extensions, bookmarks) into the tCon Chrome profile?`,
      "The current tCon profile is kept as a backup folder next to it.",
      s.running ? `\n${s.browser} is running: quit it first, or the copied databases may be inconsistent.` : "",
      binaryFamily && s.family !== binaryFamily
        ? `\nCookies and saved passwords are encrypted with ${s.browser}'s key and won't open in ${binaryName}. Bookmarks, history and extensions carry over; pick ${s.browser} as the Chrome engine browser for a full import.`
        : "",
    ].join("\n");
    if (!(await ask(warn, { title: "Import browser profile", kind: s.running ? "warning" : "info" }))) return;
    setBusy(s.userDataDir);
    setResult(null);
    try {
      const r = await browserApi.import(s.userDataDir, profile);
      setResult({ text: `Imported ${r.files.toLocaleString()} files (${fmtBytes(r.bytes)}).${r.backup ? ` Previous profile: ${tilde(r.backup)}` : ""}`, error: false });
      void useBrowser.getState().refreshChrome();
    } catch (err) {
      setResult({ text: String(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingRow
      label="Import sessions"
      keywords="import cookies logins sessions profile chrome brave edge firefox safari"
      stacked
      modified={false}
      description={`Copies a browser profile into the tCon Chrome profile.${running ? " Quit the tCon Chrome window first." : ""} The built-in engine keeps its own sessions and has no import.`}
    >
      <div className="legacy-list">
        {sources === null && <div className="legacy-item hint">Looking for browsers…</div>}
        {sources?.length === 0 && <div className="legacy-item hint">No browsers found.</div>}
        {sources?.map((s) => (
          <div key={s.userDataDir} className="legacy-item br-import-item">
            <span className="legacy-name">{s.browser}</span>
            {s.supported ? (
              <>
                {s.profiles.length > 1 ? (
                  <Select value={pick[s.userDataDir] ?? s.profiles[0].dir} onChange={(v) => setPick((p) => ({ ...p, [s.userDataDir]: v }))} ariaLabel={`${s.browser} profile`}>
                    {s.profiles.map((p) => (
                      <option key={p.dir} value={p.dir}>{p.name}{p.user ? ` (${p.user})` : ""}</option>
                    ))}
                  </Select>
                ) : (
                  <span className="hint">{s.profiles[0]?.name}{s.profiles[0]?.user ? ` (${s.profiles[0].user})` : ""}</span>
                )}
                <span className="hint br-import-state">
                  {s.running ? "running" : binaryFamily && s.family !== binaryFamily ? "no cookies/passwords" : ""}
                </span>
                <button className="btn small" disabled={!!busy || running} onClick={() => void run(s)}>
                  {busy === s.userDataDir ? "Importing…" : "Import"}
                </button>
              </>
            ) : (
              <span className="hint br-import-reason">Not supported: {s.reason}</span>
            )}
          </div>
        ))}
      </div>
      {result && <div className={result.error ? "settings-error" : "hint"}>{result.text}</div>}
    </SettingRow>
  );
}
