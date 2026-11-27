import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";

export type MenuItem =
  | "sep"
  | {
      label: string;
      hint?: string;
      action(): void;
      /** shows a check mark column for every item in the menu */
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      title?: string;
    }
  | { header: string }
  | { custom: React.ReactNode };

export interface MenuOpenOpts {
  /** position under the event's currentTarget instead of at the pointer */
  anchor?: "below-start" | "below-end";
  minWidth?: number;
}

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[]; minWidth?: number; alignEnd?: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback((e: React.MouseEvent, items: MenuItem[], opts?: MenuOpenOpts) => {
    e.preventDefault();
    e.stopPropagation();
    if (opts?.anchor) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const end = opts.anchor === "below-end";
      setState({ x: end ? r.right : r.left, y: r.bottom + 4, items, minWidth: opts.minWidth, alignEnd: end });
    } else {
      setState({ x: e.clientX, y: e.clientY, items, minWidth: opts?.minWidth });
    }
  }, []);
  const close = useCallback(() => setState(null), []);

  // keep the menu inside the window once its real size is known
  useLayoutEffect(() => {
    const el = ref.current;
    if (!state || !el) return;
    const r = el.getBoundingClientRect();
    let left = state.alignEnd ? state.x - r.width : state.x;
    left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(state.y, window.innerHeight - r.height - 4));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", close);
    };
  }, [state, close]);

  const checks = state?.items.some((i) => typeof i === "object" && "label" in i && i.checked !== undefined);

  const element = state ? (
    <div
      ref={ref}
      className={`ctx-menu${checks ? " has-checks" : ""}`}
      role="menu"
      style={{ left: state.x, top: state.y, minWidth: state.minWidth, visibility: "hidden" }}
    >
      {state.items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : "custom" in item ? (
          <div key={i}>{item.custom}</div>
        ) : "header" in item ? (
          <div key={i} className="ctx-header">{item.header}</div>
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={item.disabled}
            title={item.title}
            className={`ctx-item${item.disabled ? " disabled" : ""}${item.danger ? " danger" : ""}`}
            onClick={() => {
              if (item.disabled) return;
              close();
              item.action();
            }}
          >
            {checks && <span className="ctx-check">{item.checked && <Icon name="check" size={12} />}</span>}
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="kbd-hint">{item.hint}</span>}
          </div>
        ),
      )}
    </div>
  ) : null;

  return useMemo(() => ({ open, close, element }), [open, close, element]);
}
