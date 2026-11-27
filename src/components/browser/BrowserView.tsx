// Sidebar "Browser" view: address box, detected dev servers, and every open page of both engines
// (built-in tabs of this project, tabs of the tCon Chrome profile via CDP).
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import type { EditorTab, Project } from "../../types";
import { browserApi, hostOf, type BrowserEngine, type ChromeTab } from "../../browser/api";
import { chromePort, defaultEngine, ENGINE_SETTING, useBrowser } from "../../browser/store";
import { openBrowser, openInChrome } from "../../browser/actions";
import { closeEditors } from "../editor/editorActions";
import { useContextMenu } from "../ContextMenu";
import { writeText } from "../workbench/clipboard";
import { useTheming } from "../../theming/store";
import { Icon } from "../icons";
import { Select } from "../ui";
import { BrowserTabName, PageIcon } from "./BrowserTab";
import "./browser.css";

const COLLAPSE_KEY = "tcon.browser.collapsed";
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "") ?? {};
  } catch {
    return {};
  }
}

function Section({ id, title, count, actions, collapsed, onToggle, children }: {
  id: string; title: string; count?: number; actions?: React.ReactNode; collapsed: boolean; onToggle(id: string): void; children: React.ReactNode;
}) {
  return (
    <div className="sb-section">
      <div className="sb-section-header" role="button" tabIndex={0} aria-expanded={!collapsed} onClick={() => onToggle(id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle(id))}>
        <Icon name="chevronRight" size={14} className={`sb-chevron${collapsed ? "" : " sb-open"}`} />
        <span className="sb-section-title">{title}</span>
        {count !== undefined && count > 0 && <span className="sb-count">{count}</span>}
        <span className="sb-spacer" />
        {actions && <span className="sb-section-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {!collapsed && <div className="sb-section-body">{children}</div>}
    </div>
  );
}

export function BrowserTitleActions() {
  return (
    <span className="br-title-actions">
      <button className="sb-icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void useBrowser.getState().refreshChrome()}>
        <Icon name="refresh" />
      </button>
      <button
        className="sb-icon-btn"
        title="Browser Settings"
        aria-label="Browser Settings"
        onClick={() => useWorkspace.getState().setModal({ kind: "profiles", section: "browser" })}
      >
        <Icon name="gear" />
      </button>
    </span>
  );
}

export function BrowserView() {
  const project = useWorkspace((s) => (s.activeProjectId ? s.projects[s.activeProjectId] : null));
  const visible = !!project && project.sidebarOpen && project.sidebarTab === "browser";
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  // Live Chrome tabs while the view is visible.
  useEffect(() => {
    if (!visible) return;
    const st = useBrowser.getState();
    void st.refreshChrome();
    let n = 0;
    const t = window.setInterval(() => void st.refreshChrome(++n % 5 !== 0), 2000);
    return () => window.clearInterval(t);
  }, [visible]);

  if (!project) return null;
  return (
    <div className="br-view">
      <AddressBox />
      <Notice />
      <div className="br-sections">
        <DevServers project={project} collapsed={!!collapsed.dev} onToggle={toggle} />
        <BuiltinPages project={project} collapsed={!!collapsed.builtin} onToggle={toggle} />
        <ChromePages collapsed={!!collapsed.chrome} onToggle={toggle} />
      </div>
    </div>
  );
}

function AddressBox() {
  const tick = useBrowser((s) => s.urlInputTick);
  const engineSetting = useTheming((s) => s.settings[ENGINE_SETTING]);
  const [engine, setEngine] = useState<BrowserEngine>(defaultEngine());
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setEngine(defaultEngine()), [engineSetting]);
  useEffect(() => {
    if (tick) requestAnimationFrame(() => ref.current?.focus());
  }, [tick]);
  return (
    <form
      className="br-open"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && openBrowser(value, engine)) setValue("");
      }}
    >
      <input
        ref={ref}
        className="ui-input br-open-input"
        placeholder="Open URL or port (5173)"
        aria-label="Open URL"
        value={value}
        spellCheck={false}
        data-esc-clear={value ? "1" : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && value && (e.stopPropagation(), setValue(""))}
      />
      <Select value={engine} onChange={(v) => setEngine(v as BrowserEngine)} ariaLabel="Engine" title="Where to open it" className="br-engine">
        <option value="builtin">Built-in</option>
        <option value="chrome">Chrome</option>
      </Select>
    </form>
  );
}

function Notice() {
  const notice = useBrowser((s) => s.notice);
  if (!notice) return null;
  return (
    <div className={`br-view-notice${notice.error ? " error" : ""}`} role={notice.error ? "alert" : "status"}>
      <span>{notice.text}</span>
      <button className="sb-icon-btn" aria-label="Dismiss" onClick={() => useBrowser.getState().setNotice(null)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

function DevServers({ project, collapsed, onToggle }: { project: Project; collapsed: boolean; onToggle(id: string): void }) {
  const detected = useBrowser((s) => s.devServers[project.id]);
  const panes = project.panes;
  const menu = useContextMenu();
  const rows = useMemo(() => {
    const list: { url: string; source: string }[] = [];
    if (project.browserUrl) list.push({ url: project.browserUrl, source: "project" });
    for (const d of detected ?? []) if (!list.some((x) => x.url === d.url)) list.push({ url: d.url, source: panes[d.paneId]?.title ?? "terminal" });
    return list;
  }, [project.browserUrl, detected, panes]);

  return (
    <Section id="dev" title="Dev Servers" count={rows.length} collapsed={collapsed} onToggle={onToggle}>
      {rows.length === 0 && (
        <div className="sb-empty">
          Start a dev server in a terminal (<code>npm run dev</code>…); its local URL shows up here. You can also set one in Project Settings.
        </div>
      )}
      {rows.map((r) => (
        <div
          key={r.url}
          className="sb-row br-row"
          title={`${r.url}\nClick: open in ${defaultEngine() === "chrome" ? "Chrome" : "the built-in browser"}`}
          onClick={() => openBrowser(r.url)}
          onContextMenu={(e) =>
            menu.open(e, [
              { label: "Open in Built-in Browser", action: () => openBrowser(r.url, "builtin") },
              { label: "Open in tCon Chrome", action: () => openBrowser(r.url, "chrome") },
              "sep",
              { label: "Copy URL", action: () => void writeText(r.url) },
            ])
          }
        >
          <Icon name="globe" size={14} className="br-row-icon" />
          <span className="sb-name">{hostOf(r.url)}{r.url.replace(/^https?:\/\/[^/]+/, "")}</span>
          <span className="sb-desc">{r.source === "project" ? "project" : r.source}</span>
          <span className="br-row-actions" onClick={(e) => e.stopPropagation()}>
            <button className="sb-icon-btn" title="Open in built-in browser" aria-label="Open in built-in browser" onClick={() => openBrowser(r.url, "builtin")}>
              <Icon name="splitRight" size={14} />
            </button>
            <button className="sb-icon-btn" title="Open in tCon Chrome" aria-label="Open in tCon Chrome" onClick={() => openBrowser(r.url, "chrome")}>
              <Icon name="external" size={14} />
            </button>
          </span>
        </div>
      ))}
      {menu.element}
    </Section>
  );
}

function BuiltinPages({ project, collapsed, onToggle }: { project: Project; collapsed: boolean; onToggle(id: string): void }) {
  const tabs = useMemo(() => {
    const out: { tab: EditorTab; groupId: string; active: boolean }[] = [];
    for (const g of project.editorGroups) for (const t of g.tabs) if (t.kind === "browser") out.push({ tab: t, groupId: g.id, active: g.activeTabId === t.id });
    return out;
  }, [project.editorGroups]);
  const pages = useBrowser((s) => s.pages);
  const st = useWorkspace.getState();

  return (
    <Section
      id="builtin"
      title="Built-in"
      count={tabs.length}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <button className="sb-icon-btn" title="New page" aria-label="New built-in page" onClick={() => useBrowser.getState().requestUrlInput()}>
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {tabs.length === 0 && <div className="sb-empty">Pages open as editor tabs. Sessions (cookies, logins) persist across restarts.</div>}
      {tabs.map(({ tab, groupId, active }) => {
        const page = pages[tab.id];
        return (
          <div
            key={tab.id}
            className={`sb-row br-row${active ? " sb-current" : ""}`}
            title={page?.url || tab.path}
            onClick={() => st.setActiveEditorTab(project.id, groupId, tab.id)}
          >
            {page?.loading ? <span className="br-spinner br-row-icon" aria-label="Loading" /> : <PageIcon src={page?.favicon} className="br-row-icon" />}
            <span className="sb-name"><BrowserTabName tab={tab} /></span>
            <span className="sb-desc">{hostOf(page?.url || tab.path)}</span>
            <span className="br-row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="sb-icon-btn" title="Close" aria-label="Close page" onClick={() => void closeEditors(project.id, [tab.id])}>
                <Icon name="close" size={14} />
              </button>
            </span>
          </div>
        );
      })}
    </Section>
  );
}

function ChromePages({ collapsed, onToggle }: { collapsed: boolean; onToggle(id: string): void }) {
  const chrome = useBrowser((s) => s.chrome);
  const tabs = useBrowser((s) => s.chromeTabs);
  const busy = useBrowser((s) => s.chromeBusy);
  const [claude, setClaude] = useState(false);
  const act = (p: Promise<unknown>) => p.catch((err) => useBrowser.getState().setNotice(String(err), true)).finally(() => void useBrowser.getState().refreshChrome(true));

  const title = chrome?.binary ? `Chrome · ${chrome.binary.name}` : "Chrome";
  return (
    <Section
      id="chrome"
      title={title}
      count={tabs.length}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        chrome?.running && (
          <button className="sb-icon-btn" title="New tab" aria-label="New Chrome tab" onClick={() => void openInChrome("about:blank")}>
            <Icon name="plus" size={14} />
          </button>
        )
      }
    >
      {!chrome ? (
        <div className="sb-empty">Checking…</div>
      ) : !chrome.binary ? (
        <div className="sb-empty">No Chrome, Chromium, Brave or Edge found. Set the path in Settings → Browser.</div>
      ) : !chrome.running ? (
        <div className="br-chrome-off">
          <div className="sb-empty">
            Your {chrome.binary.name} in a separate tCon profile: real DevTools, extensions (Claude in Chrome) and logins that persist.
          </div>
          <div className="row br-chrome-actions">
            <button className="btn small" disabled={busy} onClick={() => void openInChrome(null)}>
              {busy ? "Starting…" : `Launch ${chrome.binary.name}`}
            </button>
            {!chrome.profileExists && (
              <button className="btn small ghost" onClick={() => useWorkspace.getState().setModal({ kind: "profiles", section: "browser" })}>
                Import a profile…
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {tabs.length === 0 && <div className="sb-empty">No open tabs.</div>}
          {tabs.map((t: ChromeTab) => (
            <div key={t.id} className="sb-row br-row" title={`${t.url}\nClick to show this tab in ${chrome.binary?.name ?? "Chrome"}`} onClick={() => void act(browserApi.chromeActivate(t.id))}>
              <PageIcon src={t.faviconUrl} className="br-row-icon" />
              <span className="sb-name">{t.title || hostOf(t.url)}</span>
              <span className="sb-desc">{hostOf(t.url)}</span>
              <span className="br-row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="sb-icon-btn" title="Close tab" aria-label="Close tab" onClick={() => void act(browserApi.chromeClose(t.id))}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            </div>
          ))}
          <div className="sb-row br-row br-claude-toggle" role="button" aria-expanded={claude} onClick={() => setClaude((v) => !v)}>
            <Icon name="chevronRight" size={14} className={`sb-chevron${claude ? " sb-open" : ""}`} />
            <span className="sb-name">Use with Claude</span>
            <span className="sb-desc">127.0.0.1:{chrome.port}</span>
          </div>
          {claude && <ClaudeHelper />}
        </>
      )}
    </Section>
  );
}

function CopyRow({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="br-copy">
      <div className="br-copy-head">
        <span>{label}</span>
        <button
          className="sb-icon-btn"
          title="Copy"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void writeText(text);
            setDone(true);
            window.setTimeout(() => setDone(false), 1200);
          }}
        >
          <Icon name={done ? "check" : "copy"} size={14} />
        </button>
      </div>
      <pre className="br-code">{text}</pre>
    </div>
  );
}

/** Endpoint + copyable MCP config; never edits the user's Claude config. */
export function ClaudeHelper() {
  const chrome = useBrowser((s) => s.chrome);
  const port = chrome?.port ?? chromePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const add = `claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browser-url=${endpoint}`;
  const json = JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", `--browser-url=${endpoint}`] } } }, null, 2);
  const hosts = chrome?.nativeHosts ?? [];
  const linked = chrome?.nativeHostsLinked ?? [];
  const missing = hosts.filter((h) => !linked.includes(h));

  return (
    <div className="br-claude">
      <CopyRow label="DevTools endpoint" text={endpoint} />
      <CopyRow label="Add as MCP server (Claude Code)" text={add} />
      <CopyRow label=".mcp.json" text={json} />
      <div className="br-claude-note">
        <b>Claude in Chrome:</b>{" "}
        {hosts.length === 0
          ? "install the extension in this profile, and run claude --chrome once so Claude Code registers its connector; then press Relink."
          : missing.length
            ? "Claude Code's connector isn't linked into this profile yet."
            : "Claude Code's connector is linked into this profile. Install the extension here once, then use claude --chrome."}
        {hosts.length > 0 && missing.length > 0 && " "}
        <button
          className="btn small ghost"
          onClick={() =>
            void browserApi
              .chromeLinkNativeHosts()
              .then(() => useBrowser.getState().refreshChrome())
              .catch((err) => useBrowser.getState().setNotice(String(err), true))
          }
        >
          Relink
        </button>
      </div>
      <div className="br-claude-note warn">
        Any program on this computer can control a browser whose debugging port is open, which is why this is a separate profile. Don't sign in to accounts here that
        you wouldn't trust local tools with.
      </div>
    </div>
  );
}
