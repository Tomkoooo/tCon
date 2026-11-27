// Claude model preference. Global default lives in ~/.tcon/settings.json ("claude.model");
// a project can override it (Project.claudeModel). Aliases are passed straight to
// `claude --model`, so they always resolve to the newest model of that family.
import { useTheming } from "./theming/store";
import type { Pane, Project } from "./types";

export const MODEL_SETTING = "claude.model";

export const MODEL_PRESETS = [
  { value: "default", label: "Default", title: "Let Claude Code pick (your plan's default model)" },
  { value: "opus", label: "Opus", title: "--model opus — most capable" },
  { value: "sonnet", label: "Sonnet", title: "--model sonnet — fast and capable" },
  { value: "haiku", label: "Haiku", title: "--model haiku — fastest" },
] as const;

const PRESET_VALUES = new Set<string>(MODEL_PRESETS.map((m) => m.value));
export const isPresetModel = (m: string) => PRESET_VALUES.has(m);

/** "" / "default" / unset = no --model flag. */
export function normalizeModel(v: unknown): string {
  return typeof v === "string" && v.trim() && v.trim() !== "default" ? v.trim() : "default";
}

export function globalModel(): string {
  return normalizeModel(useTheming.getState().settings[MODEL_SETTING]);
}

/** Effective model for a project: its override, else the global default. */
export function projectModel(project: Pick<Project, "claudeModel"> | null | undefined): string {
  const o = project?.claudeModel;
  return o ? normalizeModel(o) : globalModel();
}

export function modelLabel(m: string): string {
  return MODEL_PRESETS.find((p) => p.value === m)?.label ?? m;
}

const shq = (s: string) => (/^[\w.:/@[\]-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Add `--model <x>` to a pane's `claude …` startup command (if it doesn't pick one itself). */
export function withClaudeModel(project: Project, pane: Pane): Pane {
  const cmd = pane.startupCommand?.trim();
  if (!pane.isClaude || pane.ephemeral || !cmd || !/^claude(\s|$)/.test(cmd) || /\s--model(\s|=)/.test(cmd)) return pane;
  // only interactive sessions (`claude`, `claude --continue`, `claude --resume …`), not `claude auth …` etc.
  if (/^claude\s+[a-z]/.test(cmd)) return pane;
  const model = projectModel(project);
  if (model === "default") return pane;
  return { ...pane, startupCommand: `${cmd} --model ${shq(model)}` };
}
