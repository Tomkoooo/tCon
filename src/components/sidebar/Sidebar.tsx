import { useEffect, useState } from "react";
import type { GitStatus } from "../../types";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { refreshWorkspace } from "../../refresh";
import { TasksSection, TasksTitleActions, TasksView } from "../tasks/TasksView";
import { Icon } from "../icons";
import "./sidebar.css";

export type SidebarTab = "files" | "git" | "tasks";

export interface SidebarProps {
  root: string;
  gitStatus?: GitStatus | null;
  tab: SidebarTab;
  onOpenFile(path: string, preview: boolean): void;
  onOpenDiff?(file: string | null, staged: boolean): void;
}

export function Sidebar({ root, gitStatus, tab, onOpenFile, onOpenDiff }: SidebarProps) {
  // Keep a tab mounted once it has been shown so its state (expanded folders,
  // loaded log) survives tab switches.
  const [mounted, setMounted] = useState<Record<SidebarTab, boolean>>({ files: tab === "files", git: tab === "git", tasks: tab === "tasks" });
  useEffect(() => {
    setMounted((m) => (m[tab] ? m : { ...m, [tab]: true }));
  }, [tab]);

  const changeCount = gitStatus?.isRepo ? gitStatus.files.length : 0;

  return (
    <div className="sb-root">
      <div className="sb-title">
        {tab === "files" ? "Explorer" : tab === "tasks" ? "Tasks" : "Source Control"}
        {tab === "git" && changeCount > 0 && <span className="sb-count">{changeCount}</span>}
        {tab === "git" && (
          <button className="sb-icon-btn" style={{ marginLeft: "auto" }} title="Refresh" aria-label="Refresh" onClick={() => refreshWorkspace(root)}>
            <Icon name="refresh" />
          </button>
        )}
        {tab === "tasks" && <TasksTitleActions root={root} />}
      </div>
      <div className="sb-content">
        {(mounted.files || tab === "files") && (
          <div className="sb-pane" hidden={tab !== "files"}>
            <FileTree root={root} gitStatus={gitStatus} onOpenFile={onOpenFile} />
          </div>
        )}
        {(mounted.git || tab === "git") && (
          <div className="sb-pane" hidden={tab !== "git"}>
            <GitPanel root={root} gitStatus={gitStatus} onOpenDiff={onOpenDiff} onOpenFile={(p) => onOpenFile(p, false)} />
            <TasksSection root={root} />
          </div>
        )}
        {(mounted.tasks || tab === "tasks") && (
          <div className="sb-pane" hidden={tab !== "tasks"}>
            <TasksView root={root} />
          </div>
        )}
      </div>
    </div>
  );
}
