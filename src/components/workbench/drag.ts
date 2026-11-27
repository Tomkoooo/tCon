/** Pointer-drag helper for resizers. */
export function dragResize(e: React.PointerEvent, cursor: string, onMove: (ev: PointerEvent) => void) {
  e.preventDefault();
  const move = (ev: PointerEvent) => onMove(ev);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    document.body.classList.remove("resizing");
  };
  document.body.style.cursor = cursor;
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
