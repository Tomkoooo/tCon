// Settings → Notifications: when tCon sends desktop notifications (src/notify.ts).
import { NOTIFY_BACKGROUND, NOTIFY_CLAUDE, NOTIFY_TASKS, desktopNotify, type ClaudeNotifyMode } from "../notify";
import { SettingRow, SettingsSection, useSetting } from "./settingsKit";
import { Segmented, Toggle } from "./ui";

export function NotificationsSection() {
  const [mode, setMode] = useSetting<string>(NOTIFY_CLAUDE, "all");
  const [background, setBackground] = useSetting<boolean>(NOTIFY_BACKGROUND, true);
  const [tasks, setTasks] = useSetting<boolean>(NOTIFY_TASKS, true);
  return (
    <SettingsSection
      id="notifications"
      title="Notifications"
      description="Desktop notifications when a Claude session changes state. Sessions that need you also pulse on their tab and terminal. Allow tCon in System Settings → Notifications."
    >
      <SettingRow label="Claude sessions" settingKey={NOTIFY_CLAUDE} keywords="notification push alert needs you done error blocked">
        <Segmented<ClaudeNotifyMode>
          ariaLabel="Claude session notifications"
          value={(["all", "attention", "off"].includes(mode) ? mode : "all") as ClaudeNotifyMode}
          onChange={setMode}
          options={[
            { value: "all", label: "All", title: "Needs you, done and error" },
            { value: "attention", label: "Needs you", title: "Only when a session needs you or failed" },
            { value: "off", label: "Off" },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Also when the session is visible"
        settingKey={NOTIFY_BACKGROUND}
        description="Notify for the terminal on screen too while tCon is in the background."
        keywords="notification focus background visible"
      >
        <Toggle checked={background} onChange={setBackground} />
      </SettingRow>
      <SettingRow
        label="Task agents"
        settingKey={NOTIFY_TASKS}
        description="When a task agent is blocked, finishes, hits a usage limit, or the run queue empties."
        keywords="notification task agent queue board"
      >
        <Toggle checked={tasks} onChange={setTasks} />
      </SettingRow>
      <SettingRow label="Test" keywords="notification test permission" modified={false}>
        <button className="btn small" onClick={() => void desktopNotify("tCon", "Notifications are working.")}>Send a test notification</button>
      </SettingRow>
    </SettingsSection>
  );
}
