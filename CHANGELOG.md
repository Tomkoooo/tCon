# Changelog

All notable changes to tCon are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tCon uses
[Semantic Versioning](https://semver.org/) with `-alpha.N`, `-beta.N` and `-rc.N` prereleases.
Each release's section becomes its GitHub release notes.

## [Unreleased]

### Added
- **Pinned web apps**: pin any built-in browser page to the activity bar with its own icon (database, server, dashboard, the site's icon…) and color, for every project or just one. Handy for a self-hosted database viewer such as MongoDB Compass web, Adminer, pgweb or CloudBeaver: one click opens it next to your code, or brings back its open tab, and the built-in browser keeps you logged in. Pin from a browser tab's More menu or **Browser: Pin Page to Sidebar…**; right-click a pin to edit, reorder or unpin it. Pins are saved in `settings.json` under `browser.pinnedApps`.
- Tasks: add single tasks to the run queue while agents work. The Queue panel has an **Add a task to the queue…** picker for any open task, and while the board's agents are busy the card menu offers **Add to Agent Queue** and the task drawer **Add to queue**, so a task waits its turn instead of starting in a free slot. Remove a task with the ✕ in the Queue panel or **Remove from Agent Queue**.
- **Bookmark folders** in the tab bar: group projects under a name such as "SIRONIC". Click a folder to see its projects; picking one brings it to the first tab, opening it first if it isn't open. Add a project from its tab's right-click menu (**Add to "…"** / **Add to New Folder…**), by dropping its tab onto a folder, or with **Add "…"** in the folder's dropdown. Right-click or double-click a folder to rename or delete it. Folders are saved in `settings.json` under `projects.folders`.
- **Switch accounts on usage limit**: when a Claude session hits its 5-hour or weekly limit, tCon can switch to your next Claude account that isn't limited and continue the session (or the task agent) there. It never goes in circles: when every account is limited it stops and switches to the account whose limit resets first, at that time. Turn it on for all sessions from the account chip or Settings → Accounts (`claude.accountAutoSwitch`), or for one board's agents in its Run queue panel.
- Usage per account: the account chip, its switch menu and Settings → Accounts show the 5-hour and weekly usage Claude Code reports (for example "5h 85% · Week 40%") and, once an account is limited, when its limit resets. tCon only sees what Claude Code prints in the terminal, so the numbers appear once Claude warns about them.

### Fixed
- Drag and drop works again in the tab bars: drag a project tab, a terminal tab or an editor tab to reorder it (a line shows where it will land, Esc cancels). Editor tabs can still be dragged into another group or to the right edge of a group to split, and project tabs onto a bookmark folder.
- Task agents and planners with a long prompt (long task titles, several tasks at once) no longer get stuck at the shell's `quote>` prompt without starting Claude. Long startup commands are now handed to the shell through a short-lived private script instead of being typed in, which the macOS terminal cut off after 1024 bytes.

## [0.2.0-alpha.1] - 2026-11-27

### Added
- **Go to File** (⌘P): fuzzy-find any file in the project by name and open it. It respects `.gitignore` and skips `node_modules` and build folders.
- **Find in Files** (⇧⌘F): search the project's text, with match case, whole word and regex toggles. Picking a result opens the file at that line.
- **Switch Project** (⌘O): one list of open and recently used projects. ↵ switches to an open project or reopens a closed one, ⌘↵ opens it with Claude.
- **Tasks: Import Notes…** (command palette and board menu): paste meeting notes or a memo and Claude splits them into Inbox cards, keeping each item's original text. Send everything to the active project or let Claude distribute the items over your open projects (it asks when unsure), and optionally plan them right after.
- Task agents survive interruptions. Each agent runs with its own Claude session id; when tCon closes or the Mac restarts, the card shows **Interrupted** and tCon offers to resume it where it stopped (or resumes automatically, Queue panel setting). An agent that exits with an error is resumed up to 3 times with growing pauses before it's marked failed.
- Usage limits: when Claude reports a usage limit in an agent's terminal, the card shows **Usage limit**, the board's queue stops so new agents don't fail too, and the agent continues a minute after the reset time, or right away when you switch to another account (its conversation is copied to that account).
- Tasks: **Worktree per task** isolation (Queue panel). Each agent works on its own branch `tcon/T-n` in a git worktree under `~/.tcon/worktrees/`, so parallel agents don't mix changes or commits. Optional setup command (e.g. `npm ci`) and shared `node_modules`. In the task drawer: **Merge** into the current branch, **Open PR** (GitHub CLI) and **Remove worktree** (refuses unmerged or dirty worktrees unless you confirm).
- Live agent status: the status bar shows how many task agents are running, planning, need you or are queued, across every project; click it for each agent's task, phase (Planning, Implementing, Verifying…), time and what Claude is doing, with Open terminal / Stop buttons and Stop all / Resume all. Boards show a strip of their active agents, and cards show the phase. Agents that get blocked, fail or finish send a desktop notification while tCon is in the background.
- Tasks: select several cards (⌘/Ctrl-click, ⇧-click for a range, ⌘A or the column checkbox for a whole column) on the board or in the Tasks sidebar, then plan them with Claude, start Claude, add them to the queue, set their priority, move or delete them at once. **Tasks: Plan Inbox with Claude** plans every Inbox card.
- Tasks: a **run queue** per board (Queue button in the board header). Reorder it by dragging, see why each task waits and which tasks start together, and pick a run mode: **Rolling** (keep the agent limit busy), **Batches** (start N, wait for all, then the next N) or **Parallel-safe** (start tasks together whose plans touch different files; tasks without a plan run alone). Tasks wait for their `depends:` tasks to reach Review or Done.
- Tasks: **Stop after current** lets running agents finish while no new ones start; then **Resume**, or **Next only** to start exactly one. **Stop all now** stops every agent of the board. Also in the command palette, for one board or all of them.
- Tasks: **Plan with Claude** (card menu and task drawer) starts a planning agent that reads the task and the code, writes a plan with the files it will touch, whether it can run in parallel and what it depends on, sets priority and labels, and moves the card to Todo, without changing any code. Several cards are split across up to the board's agent limit.
- The `tcon-tasks` skill has a new Triage (plan only) section; installed copies of the skill are updated automatically when tCon updates.
- Notifications settings: choose whether Claude sessions notify for every state change, only when they need you, or never; optionally also for the visible session while tCon is in the background; and whether task agents notify.
- A Claude session that needs you now pulses on its terminal, its terminal tab and its project tab until you answer.
- Quick panel: drag it by its top edge, project bar or footer to move it. It reopens where you left it; double-click the handle to centre it again.

### Changed
- Tasks: auto-pickup has three modes for tasks entering Todo: do nothing, ask, or queue them automatically, and you choose whether they join the queue at the end, the front or by priority. Boards that had "Auto-pickup" on keep asking. New Inbox cards can optionally get a planning agent right away.
- Git graph: rows with branch or tag badges show a 20-character subject, and long badge names are shortened in the middle (`origin/fe…rect-loop`), so every badge fits. Hover for the full names.

### Fixed
- Claude sessions: every Claude terminal now resumes its own conversation after a restart (`claude --resume <its session>`), not just one per project. When you switch accounts, each session's conversation is copied to the new account and continues there; busy sessions move as soon as they finish their turn. Before, `--continue` on the new account found no conversation.
- Terminals: dropping files from Finder onto a terminal now inserts their paths (Claude Code attaches dropped images), and pasting files copied in Finder (⌘C, ⌘V) inserts their full paths instead of just the file names.
- Tasks: `#label` and `!priority` in a task title now work in the Tasks sidebar box and the board's inline add too, not only in the quick panel.
- Board: adding several cards in a row (⇧↵) no longer scrolls the column to the new card, so the input stays in view.

## [0.1.0-alpha.2] - 2026-11-27

### Changed
- Git graph: each row is only as wide as the lanes it draws, so commit messages and branch badges sit right next to the graph, as in VS Code.
- Git graph: rows show a shortened commit subject so branch badges stay readable; hover a commit for the full message.

### Fixed
- macOS: the app bundle is now signed (ad-hoc when no Developer ID is configured). The alpha.1 download only had a linker signature on the executable, so Apple Silicon Macs reported the app as damaged and refused to open it.

## [0.1.0-alpha.1] - 2026-11-27

The first public alpha. macOS (Apple Silicon and Intel) and Linux.

### Added

- **Workspace:** projects open as tabs, each with its own terminals, editors, layout and color, restored on relaunch.
- **VS Code-style workbench:** editor groups and splits, preview and pinned tabs, a terminal panel at the bottom or side that can be maximized, Material file icons.
- **Terminals:** tabs with horizontal and vertical splits, GPU rendering, links, and one-key Claude Code sessions (⇧⌘C).
- **Claude session status:** every session shows whether it's working, needs you, is done or hit an error, on its tab, in the status bar and on the Dock badge, with a notification when a hidden session needs you. ⌘J jumps to it.
- **Claude accounts:** add several Claude Code accounts, each with its own login, and switch between them in one click. tCon offers to restart idle sessions on the new account.
- **Claude model preference:** a default model (Opus, Sonnet, Haiku or any model ID), overridable per project.
- **Editor:** CodeMirror 6 with syntax highlighting for common languages, and Markdown edit / split / preview.
- **File watching:** files rewritten outside tCon (by Claude, a formatter or another editor) reload automatically, or ask first when you have unsaved edits. Refresh on focus and with ⇧⌘R.
- **Git:** stage, unstage, discard, commit, amend, commit & push, fetch, pull, publish and stash; branches and worktrees; diffs; git decorations in the file tree.
- **Git graph:** commits colored by sync state (to push, to pull, only on an unpushed branch).
- **Task board:** a kanban board per workspace (Inbox, Todo, In Progress, Review, Done) stored as Markdown in `.tcon/tasks/`, with quick capture (⇧⌘A).
- **Task agents:** "Let Claude work on this" starts a Claude Code agent that plans, implements, verifies and commits, and updates the card live. Optional auto-pickup with a concurrency limit, and a `tcon-tasks` skill for any Claude session.
- **Browser:** built-in browser tabs next to your code with persistent logins and Web Inspector, or a managed Chrome profile with DevTools and extensions. Dev servers are detected from terminal output; sessions can be imported from Chrome, Brave, Edge or Chromium.
- **Theming:** your installed VS Code color and icon themes, light/dark/system, and `settings.json`, `keybindings.json` and `custom.css` in `~/.tcon/`, all reloaded live.
- **Settings:** a searchable settings view with Accounts, Claude, Appearance, Terminal, Browser, Keyboard Shortcuts, Security, Updates and Advanced sections.
- **App icon:** the tCon logo, with built-in variants (Classic, Light, Graphite) or your own image.
- **Security:** Settings → Security audits where each account's login is stored and fixes loose file permissions. Strict Content Security Policy, internal commands callable only from tCon's own window, and file commands that refuse credential and `~/.ssh` paths.
- **Auto-update:** tCon checks GitHub for signed updates on launch and every 6 hours, shows a notice with the release notes, and installs and restarts when you choose. "Check for Updates…" is in the app menu and in Settings → Updates.
- **Releases and CI:** signed updater bundles, typecheck, build, tests, clippy, `npm audit` and `cargo audit` on every push.

[Unreleased]: https://github.com/Tomkoooo/tCon/compare/v0.2.0-alpha.1...HEAD
[0.2.0-alpha.1]: https://github.com/Tomkoooo/tCon/compare/v0.1.0-alpha.2...v0.2.0-alpha.1
[0.1.0-alpha.2]: https://github.com/Tomkoooo/tCon/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Tomkoooo/tCon/releases/tag/v0.1.0-alpha.1
