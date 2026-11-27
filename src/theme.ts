import { useTheming } from "./theming/store";

/** Is the active color theme dark? */
export function useIsDark(): boolean {
  return useTheming((s) => s.kind) === "dark";
}
