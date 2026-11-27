// Content of the Help page (tab kind "help"). Keep it short, specific and in sentence case.
// `command` ids must exist in src/commands.ts; their current shortcut is shown next to the item.
// The "Keyboard shortcuts" section is not listed here: HelpView generates it from the live bindings.

export interface HelpAction {
  label: string;
  /** run a command from COMMANDS */
  command?: string;
  args?: unknown;
  /** open Settings at this section id (see ProfilesModal SECTIONS) */
  settings?: string;
  /** open a URL in the browser */
  url?: string;
}

export interface HelpItem {
  title: string;
  /** one line: how to do it */
  how: string;
  /** commands whose shortcut is shown on the item */
  commands?: string[];
  action?: HelpAction;
}

export interface HelpSection {
  id: string;
  title: string;
  intro?: string;
  items: HelpItem[];
}

export const SHORTCUTS_SECTION_ID = "shortcuts";

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Getting started",
    intro: "tCon runs Claude Code sessions next to an editor, git and a task board. Each open folder is a project tab.",
    items: [
      { title: "Requirements", how: "Install Claude Code (the claude command) and git, and make sure both are on your shell's PATH." },
      { title: "Open a project", how: "Pick a folder (or create one). It opens as a tab with its own terminals, editors and layout.", commands: ["tcon.newProject"], action: { label: "Open project", command: "tcon.newProject" } },
      { title: "Start Claude", how: "Start a Claude Code terminal in the current project.", commands: ["terminal.newClaude"], action: { label: "New Claude terminal", command: "terminal.newClaude" } },
      { title: "Sign in", how: "The first Claude session asks you to log in. Add more accounts later in Settings → Accounts.", action: { label: "Accounts", settings: "accounts" } },
      { title: "Run any command", how: "Every command has a keyboard shortcut you can change; see Keyboard shortcuts below." },
      { title: "Open this page", how: "Press the ? at the bottom of the activity bar, or use Help → tCon Help in the menu bar.", commands: ["tcon.help"] },
    ],
  },
  {
    id: "projects",
    title: "Projects & terminals",
    items: [
      { title: "Switch projects", how: "Click a tab, or jump by number. Tabs and layouts are restored on relaunch.", commands: ["tcon.selectProject", "tcon.previousProject", "tcon.nextProject"] },
      { title: "Project settings", how: "Right-click a project tab → Project Settings… for name, colour, account, Claude model, dev server URL and environment variables." },
      { title: "Rename or close a project", how: "Right-click its tab → Rename… or Close Project. Closing asks first if sessions are still running." },
      { title: "New terminal", how: "Open a plain shell terminal in the project.", commands: ["terminal.new"], action: { label: "New terminal", command: "terminal.new" } },
      { title: "Split a terminal", how: "Split the focused terminal side by side or stacked; move between splits with the arrow shortcuts.", commands: ["terminal.splitRight", "terminal.splitDown", "tcon.focusNextPane"] },
      { title: "Terminal panel", how: "Show, hide or maximize the panel. Use the Layout button at the bottom of the activity bar to dock it bottom, top, left or right.", commands: ["workbench.action.togglePanel", "workbench.action.toggleMaximizedPanel"] },
      { title: "Clear or close", how: "Clear the focused terminal, or close whatever has focus (editor or terminal).", commands: ["terminal.clear", "tcon.close"] },
      { title: "Terminal look", how: "Font, size, line height, cursor and scrollback are in Settings → Terminal.", action: { label: "Terminal settings", settings: "terminal" } },
      { title: "Per-project environment", how: "Add KEY=value lines in Project Settings → Environment variables. They apply to new terminals." },
    ],
  },
  {
    id: "claude",
    title: "Claude sessions & status",
    items: [
      { title: "Session status", how: "Claude tabs show working, needs you, done or error. The same state appears in the status bar and on the Dock badge." },
      { title: "Jump to the session that needs you", how: "Goes to a blocked session first, then to unseen done or error ones.", commands: ["tcon.jumpToAttention"], action: { label: "Jump now", command: "tcon.jumpToAttention" } },
      { title: "Notifications", how: "When a Claude session needs you, finishes or fails out of view, tCon sends a desktop notification, and the session's tab and terminal pulse until you answer. Choose which events notify in Settings → Notifications. Allow tCon in System Settings → Notifications." },
      { title: "Choose a model", how: "Set the default Claude model in Settings → Claude, or override it per project in Project Settings.", action: { label: "Claude settings", settings: "claude" } },
      { title: "How status works", how: "Claude Code writes a status escape sequence (OSC 7501) to its terminal. tCon reads and strips it; no plugin or API key is needed." },
    ],
  },
  {
    id: "accounts",
    title: "Accounts",
    items: [
      { title: "Add an account", how: "Settings → Accounts → Add account. The login runs in a terminal of the current project.", commands: ["tcon.manageAccounts"], action: { label: "Manage accounts", command: "tcon.manageAccounts" } },
      { title: "Switch accounts", how: "Click the account chip in the tab bar and pick another account, or use Switch in Settings → Accounts. New sessions use it; tCon offers to restart idle ones." },
      { title: "Per-project account", how: "Pin a project to one account in Project Settings." },
      { title: "What is shared", how: "settings.json, CLAUDE.md, commands, agents, skills, plugins and project history are shared. Only the login is separate." },
      { title: "Where logins live", how: "Each account has its own CLAUDE_CONFIG_DIR under ~/.claude-accounts/. The default account uses ~/.claude." },
    ],
  },
  {
    id: "editor",
    title: "Editor",
    items: [
      { title: "Open a file", how: "Click a file in the Explorer for a preview tab; double-click or edit it to keep it open.", commands: ["workbench.view.explorer"], action: { label: "Show Explorer", command: "workbench.view.explorer" } },
      { title: "Split the editor", how: "Move the active tab to a new group on the right, or drag a tab onto the right edge. Up to 4 groups.", commands: ["workbench.action.splitEditor"] },
      { title: "Switch tabs", how: "Cycle through editor and terminal tabs.", commands: ["workbench.action.nextTab", "workbench.action.previousTab"] },
      { title: "Markdown", how: "Markdown files have edit, split and preview modes in the editor header." },
      { title: "Outside changes", how: "When Claude or another tool rewrites an open file, tCon reloads it, or asks first if you have unsaved edits.", commands: ["tcon.refresh"] },
      { title: "Fonts", how: "Editor font family, size and line height are in Settings → Appearance.", action: { label: "Appearance", settings: "appearance" } },
    ],
  },
  {
    id: "git",
    title: "Git",
    items: [
      { title: "Source Control", how: "Open the git view from the activity bar.", commands: ["workbench.view.scm"], action: { label: "Show Source Control", command: "workbench.view.scm" } },
      { title: "Stage and commit", how: "Hover a file for stage, unstage, discard and open. Type a message and press ⌘↵; ⇧⌘↵ commits and pushes. The arrow next to Commit has Amend." },
      { title: "View a diff", how: "Click a changed file, or the diff icon on Changes for the whole working tree." },
      { title: "Branches", how: "Click the branch name for the switcher, new branch, stash and pop stash. Double-click a branch in Branches to check it out." },
      { title: "Sync", how: "Fetch, pull and push from the header or the Graph toolbar. A branch without upstream shows Publish." },
      { title: "Commit graph", how: "The current commit is a hollow circle and merges are rings. Auto shows the current branch and its upstream; switch to All branches in the Graph header." },
      { title: "Commit details", how: "Hover a commit for author, full message, stats and actions; right-click for the same actions as a menu. Double-click opens its changes." },
      { title: "Sync colours", how: "A thin left bar marks commits to push (orange), to pull (blue, dashed dot) and only on unpushed branches (purple)." },
      { title: "Open on GitHub", how: "Shown in the commit card when the remote is on GitHub, GitLab or Bitbucket." },
    ],
  },
  {
    id: "tasks",
    title: "Tasks & agents",
    items: [
      { title: "Quick-add a task", how: "Type a line and press Enter. Good for capturing issues during a meeting.", commands: ["tasks.quickAdd"], action: { label: "Add task", command: "tasks.quickAdd" } },
      { title: "Task board", how: "Inbox → Todo → In Progress → Review → Done, with drag and drop.", commands: ["tasks.openBoard", "tasks.showView"], action: { label: "Open board", command: "tasks.openBoard" } },
      { title: "Let Claude work on a task", how: "Open a task and press Start Claude on this task. The agent plans, implements, verifies, commits and moves the card." },
      { title: "Agent state", how: "Cards show Working, Needs you, Blocked or Failed, plus the plan, progress log, checks and commits." },
      { title: "Auto-pickup", how: "In the Tasks view menu, turn on Ask to Start Claude on New Todo Tasks and choose how many agents may run at once." },
      { title: "Share the board", how: "Tasks are Markdown files in .tcon/tasks/, kept out of git by default. Board menu → Share Board via Git to commit them." },
      { title: "Use tasks from any Claude session", how: "Board menu → Install tCon Task Skill adds the tcon-tasks skill to Claude Code." },
    ],
  },
  {
    id: "browser",
    title: "Browser",
    items: [
      { title: "Open a URL", how: "Type a URL, localhost:3000 or just a port number.", commands: ["browser.openUrl"], action: { label: "Open URL", command: "browser.openUrl" } },
      { title: "Open the dev server", how: "Opens the project's dev server URL, or the latest local URL a terminal printed.", commands: ["browser.openDevServer"], action: { label: "Open dev server", command: "browser.openDevServer" } },
      { title: "Built-in pages", how: "Open as editor tabs with back, forward, address bar and Web Inspector. Cookies and logins persist." },
      { title: "tCon Chrome", how: "Real Chrome on its own persistent profile, with DevTools and extensions. Choose the engine in Settings → Browser.", action: { label: "Browser settings", settings: "browser" } },
      { title: "Import sessions", how: "Settings → Browser → Import sessions copies logins from Chrome, Brave, Edge or Chromium." },
      { title: "Clear browsing data", how: "Settings → Browser → Clear browsing data deletes cookies, storage and cache of the built-in browser." },
      { title: "Use with Claude", how: "The Browser view's Use with Claude helper gives the chrome-devtools-mcp setup for the tCon Chrome profile.", commands: ["browser.showView"] },
    ],
  },
  {
    id: "customize",
    title: "Customization",
    intro: "Config lives in ~/.tcon/. Every file reloads live when you save it, in tCon or any other editor.",
    items: [
      { title: "Color theme", how: "tCon finds themes installed in VS Code, Cursor, VSCodium and Windsurf, plus any in ~/.tcon/themes. Pick one in Settings → Appearance.", action: { label: "Appearance", settings: "appearance" } },
      { title: "Light, dark or system", how: "Follow system appearance switches between your light and dark theme automatically." },
      { title: "Rescan themes", how: "Run after installing a theme in VS Code.", commands: ["workbench.action.reloadThemes"], action: { label: "Rescan", command: "workbench.action.reloadThemes" } },
      { title: "settings.json", how: "Keys: workbench.colorTheme, workbench.preferredDarkColorTheme, workbench.preferredLightColorTheme, window.autoDetectColorScheme, workbench.iconTheme, workbench.colorCustomizations, editor.tokenColorCustomizations, workbench.fontSize, editor.fontFamily, editor.fontSize, editor.lineHeight, terminal.integrated.* (fontFamily, fontSize, lineHeight, cursorBlink, cursorStyle, scrollback), claude.model, browser.defaultEngine, browser.chromePath, browser.chromeDebugPort, tcon.customCss, app.icon.", commands: ["tcon.openSettingsJson"], action: { label: "Open settings.json", command: "tcon.openSettingsJson" } },
      { title: "keybindings.json", how: "VS Code syntax: [{ \"key\": \"cmd+e\", \"command\": \"terminal.new\" }]. Prefix a command with - to remove a default; when supports editorFocus, terminalFocus, !, && and ||.", commands: ["tcon.openKeybindingsJson"], action: { label: "Open keybindings.json", command: "tcon.openKeybindingsJson" } },
      { title: "custom.css", how: "Set \"tcon.customCss\": true and put CSS in ~/.tcon/custom.css. Theme tokens like --accent and --sidebar-bg can be overridden there." },
      { title: "Color overrides", how: "workbench.colorCustomizations accepts VS Code color ids, globally or per theme in a \"[Theme Name]\" block. tcon.<token> keys set tCon-only tokens." },
      { title: "App icon", how: "Settings → Appearance → App icon: Default, Classic, Light, Graphite, or your own image.", action: { label: "Appearance", settings: "appearance" } },
    ],
  },
  {
    id: "security",
    title: "Security",
    items: [
      { title: "Credential check", how: "Settings → Security audits each account: Keychain or plaintext login, file permissions and shared credential files. Fix permissions in one click.", action: { label: "Security", settings: "security" } },
      { title: "Keychain access", how: "Shows which programs can read each Claude login from the Keychain without asking. No secret is decrypted." },
      { title: "What can call tCon", how: "Only tCon's own UI can call its internal commands. Browser pages can't, and file commands refuse credential and ~/.ssh paths." },
      { title: "Threat model", how: "SECURITY.md in the repository describes what tCon protects against and what it doesn't.", action: { label: "Open SECURITY.md", url: "https://github.com/Tomkoooo/tCon/blob/main/SECURITY.md" } },
    ],
  },
  {
    id: "updates",
    title: "Updates & versions",
    items: [
      { title: "Auto-updates", how: "tCon checks GitHub releases shortly after launch and every 6 hours, and shows a notice when a new version is out. Downloads are signature-checked before they install.", action: { label: "Update settings", settings: "updates" } },
      { title: "Check for updates", how: "Look for a new version now. Also in the tCon menu and Settings → Updates.", commands: ["tcon.checkForUpdates"], action: { label: "Check for updates", command: "tcon.checkForUpdates" } },
      { title: "Versions", how: "Before 1.0 every release is an alpha (0.1.0-alpha.1, …) and is delivered as a normal update." },
      { title: "Release notes", how: "Each version is a GitHub release with its changes.", action: { label: "Open releases", url: "https://github.com/Tomkoooo/tCon/releases" } },
    ],
  },
  { id: SHORTCUTS_SECTION_ID, title: "Keyboard shortcuts", items: [] },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    items: [
      { title: "claude: command not found", how: "Terminals start a login shell. Make sure the shell profile (~/.zprofile or ~/.zshrc) adds Claude Code's install folder to PATH, then open a new terminal." },
      { title: "Login doesn't stick", how: "Each account has its own login. Check Settings → Accounts; press Log in on any account that shows signed out.", action: { label: "Accounts", settings: "accounts" } },
      { title: "Keychain prompts", how: "macOS asks when a new program reads a Claude login. Choose Always Allow for claude; Settings → Security → Keychain access shows who has access.", action: { label: "Security", settings: "security" } },
      { title: "Permission errors", how: "Settings → Security → Credential check fixes loose permissions on account folders." },
      { title: "Notifications don't show", how: "Allow tCon in System Settings → Notifications." },
      { title: "tCon Chrome won't start", how: "Set the Chrome path in Settings → Browser, or pick another debugging port if it's in use. Quit other Chrome windows using the tCon profile.", action: { label: "Browser settings", settings: "browser" } },
      { title: "Git view is empty", how: "The project folder must be inside a git repository. Refresh files and git status after changing it outside tCon.", commands: ["tcon.refresh"], action: { label: "Refresh", command: "tcon.refresh" } },
      { title: "A config file has an error", how: "Settings shows the parse error for settings.json or keybindings.json; tCon keeps the last good version until you fix it." },
    ],
  },
];
