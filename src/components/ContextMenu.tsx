import { useCallback, useEffect, useMemo, useState } from "react";

export type MenuItem =
  | "sep"
  | { label: string; hint?: string; action(): void }
  | { custom: React.ReactNode };

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const open = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 40 - items.length * 26), items });
  }, []);
  const close = useCallback(() => setState(null), []);

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

  const element = state ? (
    <div className="ctx-menu" style={{ left: state.x, top: Math.max(4, state.y) }}>
      {state.items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : "custom" in item ? (
          <div key={i}>{item.custom}</div>
        ) : (
          <div
            key={i}
            className="ctx-item"
            onClick={() => {
              close();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="kbd-hint">{item.hint}</span>}
          </div>
        ),
      )}
    </div>
  ) : null;

  return useMemo(() => ({ open, close, element }), [open, close, element]);
}
