// Help page (editor tab kind "help"): everything tCon can do and how. Table of contents on the left,
// searchable content on the right. The shortcut list is built from the live effective keybindings.
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { COMMAND_MAP, COMMANDS, effectiveBindings, keyLabel, type Keybinding } from "../../commands";
import { useTheming } from "../../theming/store";
import { useWorkspace } from "../../store/workspace";
import { Icon } from "../icons";
import { useUpdater } from "../../updater";
import { HELP_SECTIONS, SHORTCUTS_SECTION_ID, type HelpAction, type HelpItem } from "./helpContent";
import "./help.css";

function runAction(a: HelpAction) {
  if (a.command) COMMAND_MAP.get(a.command)?.run(a.args);
  else if (a.settings) useWorkspace.getState().setModal({ kind: "profiles", section: a.settings });
  else if (a.url) void openUrl(a.url).catch(() => window.open(a.url, "_blank"));
}

interface ShortcutRow {
  command: string;
  title: string;
  args?: unknown;
  keys: { label: string; when?: string }[];
}

/** Title for a binding with args, e.g. tcon.selectProject + 3 → "Go to project 3". */
function bindingTitle(command: string, title: string, args: unknown): string {
  if (command === "tcon.selectProject") return typeof args === "number" && args < 0 ? "Go to last project" : `Go to project ${typeof args === "number" ? args : 1}`;
  return title;
}

function shortcutRows(bindings: Keybinding[]): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const c of COMMANDS) {
    const list = bindings.filter((b) => b.command === c.id);
    if (c.id === "tcon.selectProject" && list.length) {
      // one row per project slot instead of a single "Go to Project N" row
      for (const b of list) rows.push({ command: c.id, title: bindingTitle(c.id, c.title, b.args), args: b.args, keys: [{ label: keyLabel(b.key), when: b.when }] });
      continue;
    }
    rows.push({ command: c.id, title: c.title, keys: list.map((b) => ({ label: keyLabel(b.key), when: b.when })) });
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase();

function Kbd({ k }: { k: string }) {
  return <kbd className="help-kbd">{k}</kbd>;
}

export function HelpView() {
  const userBindings = useTheming((s) => s.keybindings);
  const bindings = useMemo(() => effectiveBindings(userBindings), [userBindings]);
  const keysOf = (command: string) => bindings.filter((b) => b.command === command).map((b) => keyLabel(b.key));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(HELP_SECTIONS[0].id);
  const mainRef = useRef<HTMLDivElement>(null);
  const q = norm(query.trim());

  const itemMatches = (it: HelpItem) =>
    !q || norm(`${it.title} ${it.how} ${(it.commands ?? []).map((c) => `${c} ${keysOf(c).join(" ")}`).join(" ")}`).includes(q);
  const shortcuts = useMemo(() => shortcutRows(bindings), [bindings]);
  const shownShortcuts = shortcuts.filter((r) => !q || norm(`${r.title} ${r.command} ${r.keys.map((k) => `${k.label} ${k.when ?? ""}`).join(" ")}`).includes(q));

  const sections = HELP_SECTIONS.map((s) => {
    if (s.id === SHORTCUTS_SECTION_ID) return { ...s, visible: shownShortcuts.length > 0 || (!!q && norm(s.title).includes(q)) };
    const sectionHit = !!q && norm(s.title).includes(q);
    const items = sectionHit ? s.items : s.items.filter(itemMatches);
    return { ...s, items, visible: items.length > 0 };
  });
  const anyVisible = sections.some((s) => s.visible);

  // Highlight the section at the top of the scroll area.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => {
      const bar = main.querySelector<HTMLElement>(".help-search")?.offsetHeight ?? 0;
      const top = main.getBoundingClientRect().top + bar + 24;
      let current = main.querySelector<HTMLElement>("[data-help-section]")?.dataset.helpSection ?? HELP_SECTIONS[0].id;
      for (const el of main.querySelectorAll<HTMLElement>("[data-help-section]")) {
        if (el.getBoundingClientRect().top <= top) current = el.dataset.helpSection!;
      }
      setActive(current);
    };
    onScroll();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, [q]);

  const goTo = (id: string) => {
    const el = mainRef.current?.querySelector<HTMLElement>(`[data-help-section="${id}"]`);
    const main = mainRef.current;
    const bar = main?.querySelector<HTMLElement>(".help-search")?.offsetHeight ?? 0;
    if (el && main) main.scrollTo({ top: el.offsetTop - bar - 4, behavior: "smooth" });
    setActive(id);
  };

  return (
    <div className="help-root">
      <nav className="help-toc" aria-label="Help sections">
        <div className="help-toc-title">Help</div>
        {sections.map((s) => (
          <button key={s.id} className={`help-toc-item${active === s.id ? " on" : ""}${s.visible ? "" : " dim"}`} disabled={!s.visible} onClick={() => goTo(s.id)}>
            {s.title}
          </button>
        ))}
        <HelpVersion />
      </nav>
      <div className="help-main" ref={mainRef}>
        <div className="help-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search features, settings and shortcuts"
            aria-label="Search help"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}><Icon name="close" size={14} /></button>}
        </div>
        <div className="help-content">
          {!anyVisible && <p className="help-empty">Nothing matches “{query}”.</p>}
          {sections.map((s) =>
            !s.visible ? null : (
              <section key={s.id} className="help-section" data-help-section={s.id} aria-labelledby={`help-${s.id}`}>
                <h2 id={`help-${s.id}`}>{s.title}</h2>
                {s.intro && !q && <p className="help-intro">{s.intro}</p>}
                {s.id === SHORTCUTS_SECTION_ID ? (
                  <>
                    <p className="help-intro">
                      Your current bindings: defaults plus ~/.tcon/keybindings.json.
                      <button className="help-link" onClick={() => runAction({ label: "", command: "tcon.openKeybindingsJson" })}>Edit keybindings.json</button>
                      <button className="help-link" onClick={() => runAction({ label: "", settings: "keyboard" })}>Keyboard Shortcuts settings</button>
                    </p>
                    <table className="help-keys">
                      <tbody>
                        {shownShortcuts.map((r, i) => (
                          <tr key={`${r.command}-${i}`}>
                            <td className="help-keys-title">
                              {r.title}
                              <span className="help-cmd">{r.command}</span>
                            </td>
                            <td className="help-keys-keys">
                              {r.keys.length === 0 && <span className="help-dim">Not bound</span>}
                              {r.keys.map((k, j) => (
                                <span key={j} className="help-key-combo" title={k.when ? `when ${k.when}` : undefined}>
                                  <Kbd k={k.label} />
                                  {k.when && <span className="help-when">{k.when}</span>}
                                </span>
                              ))}
                            </td>
                            <td className="help-keys-run">
                              <button className="help-run" title={`Run ${r.title}`} aria-label={`Run ${r.title}`} onClick={() => COMMAND_MAP.get(r.command)?.run(r.args)}>
                                <Icon name="arrowRight" size={12} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <dl className="help-items">
                    {s.items.map((it) => (
                      <div key={it.title} className="help-item">
                        <dt>
                          <span>{it.title}</span>
                          {(it.commands ?? []).flatMap((c) => keysOf(c).slice(0, 1)).map((k, i) => <Kbd key={i} k={k} />)}
                        </dt>
                        <dd>
                          <span>{it.how}</span>
                          {it.action && (
                            <button className="help-action" onClick={() => runAction(it.action!)}>
                              {it.action.label}
                              <Icon name={it.action.url ? "external" : "arrowRight"} size={12} />
                            </button>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** Running version + update state, at the bottom of the table of contents. */
function HelpVersion() {
  const current = useUpdater((s) => s.current);
  const available = useUpdater((s) => s.available);
  useEffect(() => void useUpdater.getState().loadVersion(), []);
  return (
    <div className="help-version">
      <span>tCon {current ?? ""}</span>
      <button className="help-link" onClick={() => useWorkspace.getState().setModal({ kind: "profiles", section: "updates" })}>
        {available ? `${available.version} available` : "Check for updates"}
      </button>
    </div>
  );
}
