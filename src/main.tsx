import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyCachedTheme } from "./theming/store";

applyCachedTheme();

// No StrictMode: effects spawn PTYs and must run exactly once.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
