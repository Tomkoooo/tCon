// Small, theme-aware form controls shared by Settings, New Project and Project Settings.
// Everything is styled from the theme tokens in styles.css, so it follows any color theme.
import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** Native <select> (keyboard + optgroups for free) with consistent styling and a chevron. */
export function Select({
  value, onChange, children, className, title, disabled, ariaLabel,
}: {
  value: string;
  onChange(v: string): void;
  children: React.ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <span className={`ui-select${className ? ` ${className}` : ""}`} title={title}>
      <select value={value} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <Icon name="chevronDown" size={12} />
    </span>
  );
}

export interface SegmentOption<T extends string> { value: T; label: React.ReactNode; title?: string }

/** Segmented control for 2–5 mutually exclusive options. */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: SegmentOption<T>[]; onChange(v: T): void; ariaLabel?: string }) {
  return (
    <div className="ui-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={`ui-toggle${disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-toggle-track" aria-hidden><span className="ui-toggle-thumb" /></span>
      {label && <span className="ui-toggle-label">{label}</span>}
    </label>
  );
}

/** Text input that commits on blur / Enter (avoids writing settings.json on every keystroke). */
export function CommitInput({
  value, onCommit, placeholder, mono, width, type = "text", min, max, step,
}: {
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  mono?: boolean;
  width?: number;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className={`ui-input${mono ? " mono" : ""}`}
      type={type}
      min={min}
      max={max}
      step={step}
      value={draft}
      placeholder={placeholder}
      data-esc-clear={draft !== value ? "1" : undefined}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== value) {
          e.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

/** Color swatches + custom color picker. */
export function ColorPicker({ value, onChange, palette }: { value?: string; onChange(c: string): void; palette: string[] }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color">
      {palette.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} className={`swatch${c === value ? " selected" : ""}`} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className="swatch-custom" title="Custom color">
        <input type="color" value={value ?? "#6aa7ff"} onChange={(e) => onChange(e.target.value)} />
        <span style={{ background: value && !palette.includes(value) ? value : undefined }}><Icon name="plus" size={12} /></span>
      </label>
    </div>
  );
}

export function Badge({ children, tone = "neutral", title }: { children: React.ReactNode; tone?: "neutral" | "accent" | "claude" | "ok" | "warn"; title?: string }) {
  return <span className={`ui-badge ${tone}`} title={title}>{children}</span>;
}

/** Labelled form field (label above control) used in the modals. */
export function Field({ label, hint, children, grow }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; grow?: boolean }) {
  return (
    <div className="field" style={grow ? { flex: 1, minWidth: 0 } : undefined}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
