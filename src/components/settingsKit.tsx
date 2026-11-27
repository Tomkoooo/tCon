// Building blocks for the Settings view: search-aware rows grouped in sections.
// While a search is active every section renders and rows that don't match hide themselves;
// empty sections are hidden with CSS (:has), so there's no separate search index to maintain.
import { createContext, useContext } from "react";
import { useTheming } from "../theming/store";

export const SettingsSearch = createContext("");

export function matches(query: string, ...texts: (string | undefined)[]) {
  if (!query) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: React.ReactNode; children: React.ReactNode }) {
  const q = useContext(SettingsSearch);
  return (
    <section className="settings-section" data-section={id}>
      <h2 className="settings-section-title">{title}</h2>
      {description && !q && <p className="settings-section-desc">{description}</p>}
      {children}
    </section>
  );
}

/** Sub-heading inside a section (hidden while searching). */
export function SettingsGroup({ title }: { title: string }) {
  const q = useContext(SettingsSearch);
  return q ? null : <h3 className="settings-group-title">{title}</h3>;
}

/**
 * One setting: label + description on the left, control on the right
 * (or below, with `stacked`). `settingKey` is shown as a hint and is searchable.
 */
export function SettingRow({
  label, description, settingKey, keywords, children, stacked, modified, hideLabel,
}: {
  label: string;
  /** label is only used for search (the section title already says it) */
  hideLabel?: boolean;
  description?: React.ReactNode;
  settingKey?: string;
  keywords?: string;
  children: React.ReactNode;
  stacked?: boolean;
  modified?: boolean;
}) {
  const q = useContext(SettingsSearch);
  const settings = useTheming((s) => s.settings);
  if (!matches(q, label, typeof description === "string" ? description : undefined, settingKey, keywords)) return null;
  const isModified = modified ?? (settingKey ? settings[settingKey] !== undefined : false);
  return (
    <div className={`setting-row${stacked ? " stacked" : ""}${isModified ? " modified" : ""}`}>
      <div className="setting-text" hidden={hideLabel && !description}>
        <div className="setting-label" hidden={hideLabel}>
          {label}
          {settingKey && <code className="setting-key">{settingKey}</code>}
        </div>
        {description && <div className="setting-desc">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Typed accessors for settings.json values with defaults. */
export function useSetting<T extends string | number | boolean>(key: string, fallback: T): [T, (v: T) => void] {
  const raw = useTheming((s) => s.settings[key]);
  const setSetting = useTheming((s) => s.setSetting);
  const value = (typeof raw === typeof fallback ? raw : fallback) as T;
  return [value, (v: T) => void setSetting(key, v)];
}
