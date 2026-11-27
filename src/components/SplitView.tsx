import { Fragment, useRef } from "react";
import type { LayoutNode } from "../types";

interface Props {
  node: LayoutNode;
  renderLeaf(node: Exclude<LayoutNode, { type: "split" }>): React.ReactNode;
  onResize(splitId: string, sizes: number[]): void;
}

export function SplitView({ node, renderLeaf, onResize }: Props) {
  if (node.type !== "split") return <>{renderLeaf(node)}</>;
  return <Split node={node} renderLeaf={renderLeaf} onResize={onResize} />;
}

function Split({ node, renderLeaf, onResize }: Props & { node: Extract<LayoutNode, { type: "split" }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const horizontal = node.direction === "row";

  const startDrag = (index: number, e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const startPos = horizontal ? e.clientX : e.clientY;
    const start = [...node.sizes];
    const pair = start[index] + start[index + 1];
    const min = Math.min(8, pair / 2);
    const move = (ev: PointerEvent) => {
      const delta = (((horizontal ? ev.clientX : ev.clientY) - startPos) / total) * 100;
      const a = Math.max(min, Math.min(pair - min, start[index] + delta));
      const sizes = [...start];
      sizes[index] = a;
      sizes[index + 1] = pair - a;
      onResize(node.id, sizes);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className={`split ${node.direction}`} ref={ref}>
      {node.children.map((child, i) => (
        <Fragment key={child.type === "split" ? child.id : child.paneId}>
          {i > 0 && <div className="split-divider" onPointerDown={(e) => startDrag(i - 1, e)} />}
          <div className="split-child" style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}>
            <SplitView node={child} renderLeaf={renderLeaf} onResize={onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
