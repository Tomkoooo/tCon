// Task board types. Mirror src-tauri/src/tasks.rs (camelCase serde).

export type AgentState = "idle" | "queued" | "planning" | "running" | "blocked" | "interrupted" | "limited" | "done" | "failed";
export type AgentMode = "work" | "plan";
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
  /** tasks that must reach Review/Done first */
  depends: string[];
  /** git worktree the agent works in ("" = main checkout) */
  worktree: string;
  /** Claude session id of the agent (resume) */
  session: string;
  extra: [string, string][];
  /** body before the agent sections */
  description: string;
  /** "## Plan" / "## Progress log" / "## Verification" … */
  sections: string;
}

export interface Column { id: string; title: string }

export type AutoPickup = "off" | "ask" | "auto";
export type PickupPosition = "end" | "front" | "priority";

export interface BoardSettings {
  /** what happens when a task enters Todo */
  autoPickup: AutoPickup;
  /** where it joins the run queue */
  pickupPosition: PickupPosition;
  /** new Inbox cards get a planning agent */
  inboxAutoPlan: boolean;
  maxAgents: number;
  runMode: "rolling" | "batch" | "parallel-safe";
  batchSize: number;
  /** queue stopped: running agents finish, none start */
  paused: boolean;
  /** each agent gets its own branch + git worktree */
  isolation: "none" | "worktree";
  worktreeSetup: string;
  linkNodeModules: boolean;
  /** interrupted agents (app closed, restart): resume automatically or ask */
  resumeInterrupted: "ask" | "auto";
  /** switch to the next Claude account when an agent hits a usage limit */
  autoSwitchAccount: boolean;
  shared: boolean;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  autoPickup: "off",
  pickupPosition: "end",
  inboxAutoPlan: false,
  maxAgents: 1,
  runMode: "rolling",
  batchSize: 2,
  paused: false,
  isolation: "none",
  worktreeSetup: "",
  linkNodeModules: true,
  resumeInterrupted: "ask",
  autoSwitchAccount: false,
  shared: false,
};

export interface Board {
  version: number;
  columns: Column[];
  order: Record<string, string[]>;
  nextId: number;
  settings: BoardSettings;
  /** task ids waiting for an agent, in start order */
  runQueue: string[];
  /** batch run mode: ids of the current batch */
  batch: string[];
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
  depends?: string[];
  worktree?: string;
  session?: string;
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

/** One operation of a multi-select action (task_bulk). */
export interface BulkOp {
  id: string;
  patch?: TaskPatch;
  /** move to the end of this column */
  column?: string;
  delete?: boolean;
}
