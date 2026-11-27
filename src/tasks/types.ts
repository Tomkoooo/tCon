// Task board types. Mirror src-tauri/src/tasks.rs (camelCase serde).

export type AgentState = "idle" | "queued" | "running" | "blocked" | "done" | "failed";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  title: string;
  /** column id: inbox | todo | in-progress | review | done */
  status: string;
  priority: Priority | string;
  labels: string[];
  created: string;
  updated: string;
  agent: AgentState | string;
  branch: string;
  commits: string[];
  /** tCon terminal pane running the agent ("" = none) */
  paneId: string;
  extra: [string, string][];
  /** body before the agent sections */
  description: string;
  /** "## Plan" / "## Progress log" / "## Verification" … */
  sections: string;
}

export interface Column { id: string; title: string }

export interface BoardSettings {
  askOnTodo: boolean;
  maxAgents: number;
  shared: boolean;
}

export interface Board {
  version: number;
  columns: Column[];
  order: Record<string, string[]>;
  nextId: number;
  settings: BoardSettings;
}

export interface BoardState {
  board: Board;
  tasks: Task[];
  /** effective order: column id → task ids */
  columns: Record<string, string[]>;
  initialized: boolean;
  errors: [string, string][];
}

export interface TaskPatch {
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  agent?: string;
  branch?: string;
  paneId?: string;
  description?: string;
  /** line appended to "## Progress log" */
  log?: string;
}

export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "none", label: "No priority" },
];
