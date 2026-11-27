import ReactDOM from "react-dom/client";
import "./styles.css";
import { applyCachedVars } from "./quick/theme";

applyCachedVars(); // no flash of the default colors while the bundle loads

// The quick panel window (label `quick`, src-tauri/src/background.rs) loads this same bundle
// with ?view=quick and renders only the lightweight QuickPanel: no workbench, terminals or
// watchers. Both branches are dynamic imports so neither pulls in the other's code.
const isQuick =
  new URLSearchParams(window.location.search).get("view") === "quick" ||
  (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label === "quick";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (isQuick) {
  void import("./quick/QuickPanel").then(({ QuickPanel, applyQuickTheme }) => {
    applyQuickTheme();
    root.render(<QuickPanel />);
  });
} else {
  void Promise.all([import("./App"), import("./theming/store")]).then(([{ default: App }, { applyCachedTheme }]) => {
    applyCachedTheme();
    // No StrictMode: effects spawn PTYs and must run exactly once.
    root.render(<App />);
  });
}
