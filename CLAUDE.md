# tCon: rules for AI agents

tCon is a Tauri 2 desktop app: React + TypeScript + Vite in `src/`, Rust in `src-tauri/`.
`AGENTS.md` is a symlink to this file. Human contributors: see CONTRIBUTING.md.

## Before you commit

- Run `npx tsc --noEmit` and `cd src-tauri && cargo test` (CI also runs `npm run build` and `cargo clippy --all-targets`).
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for every user-facing change
  (Added / Changed / Fixed / Removed / Security). Write it for users, not for reviewers. Skip pure refactors.
- Commit only your own files, with an explicit pathspec (`git add path/…`, never `-A` or `-a`).
  Other agents may have uncommitted work in the same tree; stage only your hunks of shared files.
- Never commit secrets: no keys, tokens, `.env` files, or the updater private key (`~/.tauri/tcon-updater.key`).

## Commit messages

- Short imperative subject, under ~72 chars, no trailing period, optional `Area:` prefix:
  `Git graph: color commits by sync state`, `Fix terminal resize when the panel moves`.
- Add a body explaining *why* when it isn't obvious.

## Versions

SemVer, kept identical in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`. Never edit them by hand; use the script.

- Below 1.0 every release is an alpha: `0.MINOR.PATCH-alpha.N`, then `-beta.N`, `-rc.N`, then the plain version.
- Bump `alpha` (`-alpha.N+1`) for the next build of the same feature set, `patch` for fixes,
  `minor` for new features or breaking changes (pre-1.0). `major` only for 1.0 and later breaking changes.
- `npm run version:bump -- <x.y.z[-alpha.N]|major|minor|patch|alpha|beta|rc|release>` updates all
  five files and moves the Unreleased notes into a new CHANGELOG section. `npm run version:check` verifies they agree.

## Releasing

1. `npm run version:bump -- alpha` (or another part), then edit the new CHANGELOG section.
2. Commit as `Release v<version>` and push to `main`.
3. `.github/workflows/release.yml` builds macOS + Linux into a draft release, writes the
   updater manifest `latest.json` and publishes it with that CHANGELOG section as notes.
   A version that already has a release is skipped.

0.x versions, alphas included, are published as normal GitHub releases so the auto-updater
(which reads `releases/latest`) picks them up. From 1.0, prerelease versions become GitHub prereleases.
Updater bundles are signed with the `TAURI_SIGNING_PRIVATE_KEY` repository secret; the public
key is in `tauri.conf.json` → `plugins.updater.pubkey`. Don't change the key: installed apps would reject updates.

## Code conventions

- **Frontend → backend:** every Tauri call goes through the typed wrappers in `src/api.ts`.
  Rust commands are registered in `generate_handler!` in `src-tauri/src/lib.rs`; `build.rs` turns
  that list into the `app-commands` permission automatically.
- **State:** zustand stores (`src/store/`, `src/theming/store.ts`, feature folders like `src/tasks/`, `src/browser/`).
- **Settings:** user settings live in `~/.tcon/settings.json` (VS Code style keys like `update.autoCheck`).
  Read/write them with `useSetting` from `src/components/settingsKit.tsx`; build settings UI from its
  `SettingsSection` / `SettingRow` and add sections in `src/components/ProfilesModal.tsx`.
- **Commands and shortcuts:** add commands to `COMMANDS` and default keys to `DEFAULT_KEYBINDINGS` in `src/commands.ts`.
- **Look and feel:** colors are CSS tokens (`src/styles.css` `:root`, mapped from VS Code themes in
  `src/theming/tokens.ts`); never hard-code colors. Use the spacing/radius/type scale variables
  (`--sp-*`, `--radius*`, `--fs-*`). Icons: `<Icon name="…" />` from `src/components/icons.tsx` only.
  Form controls: `src/components/ui.tsx` (`Toggle`, `Segmented`, `Select`, `CommitInput`, `Badge`).
- **Shared files** (`lib.rs`, `Cargo.toml`, `tauri.conf.json`, capabilities, `ProfilesModal.tsx`,
  `App.tsx`, `commands.ts`): keep edits small and additive, re-read right before editing, and put
  feature code in its own module.

## Security rules

- Keep the strict CSP in `tauri.conf.json`: no inline scripts, no `eval`, no new `connect-src` hosts.
  Do network work in Rust instead.
- IPC is for the `main` webview only. `capabilities/default.json` targets `"webviews": ["main"]`;
  child webviews (`browser-*`) must never get permissions. A new window gets its own capability
  file with only what it needs. Plugin permissions are listed explicitly there.
- Never put tokens or secrets into terminal or child-process environments, and don't read
  credentials (`~/.ssh`, Keychain, Claude credential files) from the UI. See SECURITY.md.
- Open links only as `http(s)://` / `mailto:`; never ask the OS to open local files.
- npm install scripts stay off (`.npmrc`); GitHub Actions stay pinned to commit SHAs.

## Git worktrees

When your branch is merged, remove its worktree (`git worktree remove <path>`, `git branch -d <branch>`,
`git worktree prune`). Each one carries its own `node_modules` and `target/`.
