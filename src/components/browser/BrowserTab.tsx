// A built-in browser page as an editor tab: toolbar + a viewport the native webview is laid over
// (see browser/overlay.ts). The tab's path is the page URL, so it's restored with the workspace.
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../../store/workspace";
import type { EditorTab, Project } from "../../types";
import { browserApi, hostOf, normalizeUrl } from "../../browser/api";
import { attach, detach, isReady, isShown, retry } from "../../browser/overlay";
import { useBrowser } from "../../browser/store";
import { openInChrome } from "../../browser/actions";
import { useContextMenu } from "../ContextMenu";
import { writeText } from "../workbench/clipboard";
import { Icon } from "../icons";
import "./browser.css";

/** Favicon with a globe fallback (also used by the Browser view and the editor tab). */
export function PageIcon({ src, size = 14, className }: { src?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <Icon name="globe" size={size} className={className} />;
  return <img className={`br-favicon${className ? ` ${className}` : ""}`} src={src} width={size} height={size} alt="" onError={() => setFailed(true)} />;
}

/** Editor tab label parts for a browser tab. */
export function BrowserTabIcon({ tabId }: { tabId: string }) {
  const favicon = useBrowser((s) => s.pages[tabId]?.favicon);
  const loading = useBrowser((s) => !!s.pages[tabId]?.loading);
  return loading ? <span className="br-spinner ed-tab-icon" aria-label="Loading" /> : <PageIcon src={favicon} className="ed-tab-icon" />;
}
export function BrowserTabName({ tab }: { tab: EditorTab }) {
  const title = useBrowser((s) => s.pages[tab.id]?.title);
  return <>{title?.trim() || hostOf(tab.path)}</>;
}

export function BrowserTab({ project, tab }: { project: Project; tab: EditorTab }) {
  const page = useBrowser((s) => s.pages[tab.id]);
  const patchPage = useBrowser((s) => s.patchPage);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(tab.path);
  const [editing, setEditing] = useState(false);
  const menu = useContextMenu();
  const url = page?.url || tab.path;

  useEffect(() => {
    const el = viewport.current;
    if (el) attach(tab.id, el, tab.path);
    return () => detach(tab.id, el);
    // tab.path changes on every navigation; the webview follows by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    if (!editing) setDraft(url);
  }, [url, editing]);

  // pushState navigations fire no page-load event: poll the visible page's URL.
  useEffect(() => {
    const t = window.setInterval(async () => {
      if (!isShown(tab.id)) return;
      try {
        const now = await browserApi.url(tab.id);
        if (now && now !== useBrowser.getState().pages[tab.id]?.url && /^https?:/i.test(now)) {
          patchPage(tab.id, { url: now });
          useWorkspace.getState().setEditorTabPath(project.id, tab.id, now);
        }
      } catch {
        /* not created yet */
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [tab.id, project.id, patchPage]);

  const run = (action: "back" | "forward" | "reload" | "stop" | "devtools") => {
    if (isReady(tab.id)) void browserApi.action(tab.id, action).catch((err) => patchPage(tab.id, { error: String(err) }));
  };

  const go = (raw: string) => {
    const next = normalizeUrl(raw);
    if (!next) {
      patchPage(tab.id, { notice: `“${raw.trim()}” isn't a web address` });
      return;
    }
    setEditing(false);
    input.current?.blur();
    patchPage(tab.id, { url: next, error: null, notice: null, loading: true });
    useWorkspace.getState().setEditorTabPath(project.id, tab.id, next);
    if (retry(tab.id, next)) return;
    if (isReady(tab.id)) void browserApi.navigate(tab.id, next).catch((err) => patchPage(tab.id, { error: String(err), loading: false }));
  };

  const loading = !!page?.loading;
  const openMore = (e: React.MouseEvent) =>
    menu.open(
      e,
      [
        { label: "Open in Default Browser", action: () => void openUrl(url).catch(() => {}) },
        { label: "Open in tCon Chrome", title: "The managed Chrome profile, with extensions and Chrome DevTools", action: () => void openInChrome(url) },
        "sep",
        { label: "Copy URL", action: () => void writeText(url) },
        { label: "Developer Tools", hint: "Web Inspector", action: () => run("devtools") },
      ],
      { anchor: "below-end", minWidth: 220 },
    );

  return (
    <div className="br-tab">
      <div className={`br-toolbar${loading ? " loading" : ""}`}>
        <button className="icon-btn" title="Back" aria-label="Back" onClick={() => run("back")}>
          <Icon name="arrowLeft" />
        </button>
        <button className="icon-btn" title="Forward" aria-label="Forward" onClick={() => run("forward")}>
          <Icon name="arrowRight" />
        </button>
        <button className="icon-btn" title={loading ? "Stop" : "Reload"} aria-label={loading ? "Stop" : "Reload"} onClick={() => run(loading ? "stop" : "reload")}>
          <Icon name={loading ? "close" : "refresh"} />
        </button>
        <form
          className="br-address"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <PageIcon src={page?.favicon} size={14} className="br-address-icon" />
          <input
            ref={input}
            className="br-url"
            value={editing ? draft : url}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Address"
            data-esc-clear={editing ? "1" : undefined}
            onFocus={(e) => {
              setEditing(true);
              setDraft(url);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft(url);
                e.currentTarget.blur();
              }
            }}
          />
        </form>
        <button className="icon-btn" title="Developer Tools (Web Inspector)" aria-label="Developer Tools" onClick={() => run("devtools")}>
          <Icon name="inspect" />
        </button>
        <button className="icon-btn" title="Open in Default Browser" aria-label="Open in Default Browser" onClick={() => void openUrl(url).catch(() => {})}>
          <Icon name="external" />
        </button>
        <button className="icon-btn" title="More" aria-label="More" onClick={openMore}>
          <Icon name="more" />
        </button>
      </div>
      {page?.notice && (
        <div className="br-notice" role="status">
          <span>{page.notice}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => patchPage(tab.id, { notice: null })}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div className="br-viewport" ref={viewport}>
        {page?.error ? (
          <div className="br-placeholder error">
            <Icon name="globe" size={28} />
            <div>Couldn't open {hostOf(url)}</div>
            <div className="hint">{page.error}</div>
          </div>
        ) : (
          <div className="br-placeholder" aria-hidden>
            <PageIcon src={page?.favicon} size={20} />
            <div className="hint">{page?.title || hostOf(url)}</div>
          </div>
        )}
      </div>
      {menu.element}
    </div>
  );
}
