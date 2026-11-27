import { useEffect, useState } from "react";
import { useWorkspace } from "./store/workspace";

const query = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Effective dark mode: app theme setting, falling back to the OS scheme. */
export function useIsDark(): boolean {
  const theme = useWorkspace((s) => s.theme);
  const [sysDark, setSysDark] = useState(() => query().matches);
  useEffect(() => {
    const mq = query();
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme === "system" ? sysDark : theme === "dark";
}
