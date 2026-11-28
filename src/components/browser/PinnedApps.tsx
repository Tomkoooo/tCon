// Pinned web apps in the activity bar (see browser/pins.ts).
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Project } from "../../types";
import { isPinActive, movePin, editPin, openPin, removePin, usePinnedApps, type PinnedApp } from "../../browser/pins";
import { useContextMenu } from "../ContextMenu";
import { Icon } from "../icons";
import { PageIcon } from "./BrowserTab";

export function PinnedApps({ project }: { project: Project }) {
  const pins = usePinnedApps(project.rootPath);
  const menu = useContextMenu();
  if (!pins.length) return null;

  const openMenu = (e: React.MouseEvent, pin: PinnedApp, i: number) => {
    e.preventDefault();
    menu.open(e, [
      { header: pin.name },
      { label: "Open", action: () => openPin(project.id, pin) },
      { label: "Open in Default Browser", action: () => void openUrl(pin.url).catch(() => {}) },
      "sep",
      { label: "Edit…", action: () => editPin(pin, project.rootPath) },
      { label: "Move Up", disabled: i === 0, action: () => void movePin(pin.id, -1, project.rootPath) },
      { label: "Move Down", disabled: i === pins.length - 1, action: () => void movePin(pin.id, 1, project.rootPath) },
      "sep",
      { label: "Unpin", danger: true, action: () => void removePin(pin.id) },
    ]);
  };

  return (
    <div className="ab-pins">
      {pins.map((pin, i) => (
        <button
          key={pin.id}
          className={`ab-btn ab-pin${isPinActive(project, pin) ? " on" : ""}`}
          style={pin.color ? ({ "--pin-color": pin.color } as React.CSSProperties) : undefined}
          title={`${pin.name}\n${pin.url}`}
          aria-label={pin.name}
          onClick={() => openPin(project.id, pin)}
          onContextMenu={(e) => openMenu(e, pin, i)}
        >
          <span className="ab-pin-icon">{pin.icon === "favicon" ? <PageIcon src={pin.favicon} size={18} /> : <Icon name={pin.icon} size={18} />}</span>
        </button>
      ))}
      {menu.element}
    </div>
  );
}
