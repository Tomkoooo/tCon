// Browser actions used by commands, the Browser view and the editor tab toolbar.
import { useWorkspace } from "../store/workspace";
import type { Project } from "../types";
import { browserApi, normalizeUrl, type BrowserEngine } from "./api";
import { chromePath, chromePort, defaultEngine, useBrowser } from "./store";

function activeProject(): Project | null {
  const s = useWorkspace.getState();
  return s.activeProjectId ? s.projects[s.activeProjectId] : null;
}

export function showBrowserView(projectId?: string) {
  const ws = useWorkspace.getState();
  const p = projectId ? ws.projects[projectId] : activeProject();
  if (p) ws.updateProject(p.id, { sidebarOpen: true, sidebarTab: "browser" });
}

export function toggleBrowserView() {
  const p = activeProject();
  if (!p) return;
  const on = p.sidebarOpen && p.sidebarTab === "browser";
  useWorkspace.getState().updateProject(p.id, on ? { sidebarOpen: false } : { sidebarOpen: true, sidebarTab: "browser" });
}

/** "Browser: Open URL…": the Browser view's address box. */
export function promptOpenUrl() {
  showBrowserView();
  useBrowser.getState().requestUrlInput();
}

function report(err: unknown) {
  useBrowser.getState().setNotice(String(err), true);
  showBrowserView();
}

/** Launch the tCon Chrome profile (if needed) and open `url` in it. */
export async function openInChrome(url: string | null) {
  const st = useBrowser.getState();
  st.setChromeBusy(true);
  st.setNotice(null);
  try {
    const status = await browserApi.chromeLaunch(chromePath(), chromePort(), url);
    useBrowser.setState({ chrome: status });
    await st.refreshChrome(true);
  } catch (err) {
    report(err);
  } finally {
    st.setChromeBusy(false);
  }
}

/** Open a URL (or "localhost:3000", "5173"…) in the given or default engine. Returns false if it isn't a URL. */
export function openBrowser(input: string, engine: BrowserEngine = defaultEngine(), projectId?: string): boolean {
  const url = normalizeUrl(input);
  if (!url) {
    useBrowser.getState().setNotice(`“${input.trim()}” isn't a web address.`, true);
    return false;
  }
  if (engine === "chrome") {
    void openInChrome(url);
    return true;
  }
  const p = projectId ? useWorkspace.getState().projects[projectId] : activeProject();
  if (!p) return false;
  useWorkspace.getState().openEditor(p.id, url, { kind: "browser" });
  return true;
}

/** The project's configured dev URL, else the newest one a terminal printed. */
export function projectDevUrl(project: Project): string | null {
  return project.browserUrl || useBrowser.getState().devServers[project.id]?.[0]?.url || null;
}

export function openDevServer(engine?: BrowserEngine) {
  const p = activeProject();
  if (!p) return;
  const url = projectDevUrl(p);
  if (!url) {
    useBrowser.getState().setNotice("No dev server yet. Start one in a terminal (npm run dev…) or set its URL in Project Settings.", false);
    showBrowserView(p.id);
    return;
  }
  openBrowser(url, engine);
}
