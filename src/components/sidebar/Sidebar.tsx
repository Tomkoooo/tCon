import { useEffect, useState } from "react";
import type { GitStatus } from "../../types";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import "./sidebar.css";

export type SidebarTab = "files" | "git";

export interface SidebarProps {
  root: string;
  gitStatus?: GitStatus | null;
  tab: SidebarTab;
  onTabChange(tab: SidebarTab): void;
  onOpenFile(path: string): void;
  onOpenDiff?(file: string | null, staged: boolean): void;
}

export function Sidebar({ root, gitStatus, tab, onTabChange, onOpenFile, onOpenDiff }: SidebarProps) {
  // Keep a tab mounted once it has been shown so its state (expanded folders,
  // loaded log) survives tab switches.
  const [mounted, setMounted] = useState<Record<SidebarTab, boolean>>({ files: tab === "files", git: tab === "git" });
  useEffect(() => {
    setMounted((m) => (m[tab] ? m : { ...m, [tab]: true }));
  }, [tab]);

  const changeCount = gitStatus?.isRepo ? gitStatus.files.length : 0;

  return (
    <div className="sb-root">
      <div className="sb-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "files"}
          className={`sb-tab${tab === "files" ? " sb-tab-active" : ""}`}
          onClick={() => onTabChange("files")}
        >
          Files
        </button>
        <button
          role="tab"
          aria-selected={tab === "git"}
          className={`sb-tab${tab === "git" ? " sb-tab-active" : ""}`}
          onClick={() => onTabChange("git")}
        >
          Git
          {changeCount > 0 && <span className="sb-count">{changeCount}</span>}
        </button>
      </div>
      <div className="sb-content">
        {(mounted.files || tab === "files") && (
          <div className="sb-pane" hidden={tab !== "files"}>
            <FileTree root={root} gitStatus={gitStatus} onOpenFile={onOpenFile} />
          </div>
        )}
        {(mounted.git || tab === "git") && (
          <div className="sb-pane" hidden={tab !== "git"}>
            <GitPanel root={root} gitStatus={gitStatus} onOpenDiff={onOpenDiff} />
          </div>
        )}
      </div>
    </div>
  );
}
