# Changelog

All notable changes to tCon are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tCon uses
[Semantic Versioning](https://semver.org/) with `-alpha.N`, `-beta.N` and `-rc.N` prereleases.
Each release's section becomes its GitHub release notes.

## [Unreleased]

### Added
- Notifications settings: choose whether Claude sessions notify for every state change, only when they need you, or never; optionally also for the visible session while tCon is in the background; and whether task agents notify.
- A Claude session that needs you now pulses on its terminal, its terminal tab and its project tab until you answer.
- Quick panel: drag it by its top edge, project bar or footer to move it. It reopens where you left it; double-click the handle to centre it again.

### Changed
- Git graph: rows with branch or tag badges show a 20-character subject, and long badge names are shortened in the middle (`origin/fe…rect-loop`), so every badge fits. Hover for the full names.

### Fixed
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

[Unreleased]: https://github.com/Tomkoooo/tCon/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/Tomkoooo/tCon/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Tomkoooo/tCon/releases/tag/v0.1.0-alpha.1
