import { useEffect } from "react";

export function Modal({
  title, subtitle, onClose, children, actions, className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose(): void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** e.g. "wide" or "settings-modal" */
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // inputs marked data-esc-clear handle Escape themselves (clear/revert) first
        if ((e.target as HTMLElement | null)?.dataset?.escClear) return;
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="modal-head">
          <div className="modal-title">
            <span>{title}</span>
            {subtitle && <span className="modal-subtitle">{subtitle}</span>}
          </div>
          <span className="spacer" />
          {actions}
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
