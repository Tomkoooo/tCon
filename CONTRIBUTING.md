# Contributing to tCon

Thanks for your interest in improving tCon! This guide covers local setup and how changes get merged.

## Development setup

Prerequisites:

- [Node.js](https://nodejs.org/) 22
- [Rust](https://rustup.rs/) stable
- The [Tauri 2 system dependencies](https://tauri.app/start/prerequisites/) for your OS
  (on Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev`)

```sh
npm i
npm run tauri dev
```

The React/TypeScript frontend lives in `src/`, the Rust backend in `src-tauri/`.

## Checks

Run these before opening a pull request (CI runs them too):

```sh
npx tsc --noEmit
npm run build
cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets
```

## Pull request workflow

1. Fork the repository and create a branch from `main` (e.g. `feat/terminal-search`, `fix/git-graph-colors`).
2. Keep each PR focused on one change; open an issue first for larger features.
3. Make sure the checks above pass and fill in the PR template.
4. A maintainer reviews the PR; once approved it is merged into `main`.

Releases are cut automatically from `main` when the version in `src-tauri/tauri.conf.json`,
`package.json` and `src-tauri/Cargo.toml` is bumped.

## Commit style

Write short, imperative commit subjects that describe the change, for example:

```
Git graph: color commits by sync state
Fix terminal resize when the panel moves
```

- Subject line under ~72 characters, no trailing period.
- Use an optional `Area:` prefix when it helps (`Git graph:`, `Terminal:`, `Themes:`).
- Add a body explaining *why* when the change is not obvious.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
