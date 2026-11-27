# Security

## Reporting a vulnerability

Please report security problems privately through GitHub:
**[Report a vulnerability](https://github.com/Tomkoooo/tCon/security/advisories/new)**
(Security tab → Advisories → "Report a vulnerability"). Don't open a public issue.

Include what you found, how to reproduce it, and which tCon version and OS you use.
You should get an answer within a week. Fixes ship in the next release, and the advisory
is published once users can update.

Only the latest release gets security fixes.

## Where your Claude logins live

**tCon does not store Claude tokens.** Claude Code stores them, and tCon only points each
terminal at an account's config directory (`CLAUDE_CONFIG_DIR`).

| | Where Claude Code keeps the login | Encrypted at rest |
|---|---|---|
| macOS, default account | login Keychain, item `Claude Code-credentials` | yes |
| macOS, extra accounts | login Keychain, item `Claude Code-credentials-<8 hex chars>` (a hash of the config dir) | yes |
| Linux | `<config dir>/.credentials.json` | no, plaintext (should be mode 0600) |

Extra accounts live in `~/.claude-accounts/<id>`. They share settings, `CLAUDE.md`,
skills, plugins and project history with `~/.claude` through symlinks. Credential files
are never shared between accounts.

### What the Keychain does and doesn't protect

The Keychain encrypts the login on disk. Another user on the Mac, a stolen disk or a
backup can't read it. But its access list lets `/usr/bin/security`, an Apple tool, read
the item **without asking you**, because that is how Claude Code reads its own login.
So **any program running as your user** can run `security find-generic-password -s
"Claude Code-credentials" -w` and get the token. That includes an npm `postinstall`
script, a malicious VS Code extension, or any binary you run. It could also just run
`claude` itself.

No app can fix this from the outside. "Only tCon can decrypt it" isn't possible, because
Claude Code is a separate program that has to read the token too. Encrypting the token
again with a key inside tCon would only move the problem: anything that can run as you
can also ask tCon, or Claude Code, for it. tCon doesn't change the Keychain access lists
on Claude Code's items either, because Claude Code would stop working.

Settings → Security shows the access list of each Claude item (read-only: nothing is
decrypted).

## Threat model

### What tCon protects against

- **Other local users and loose file permissions.** Settings → Security checks every
  account folder. It flags plaintext credential files, folders looser than 0700, files
  looser than 0600, and symlinks that point outside `~/.claude`. **Fix permissions** runs
  `chmod go-rwx` on them. It never reads, moves or deletes anything. New account folders
  are created with 0700.
- **Logins leaking between accounts.** Account folders are only created under
  `~/.claude-accounts/`. Credential files are never symlinked or shared.
- **Secrets in terminal environments.** tCon never puts tokens into a terminal's
  environment. The project "Environment" field rejects names containing KEY, TOKEN,
  SECRET, PASSWORD or CREDENTIAL, and the backend drops them again. Variables from tCon's
  own launch or build (`TAURI_*`, `npm_*`, Apple signing variables) are removed from every
  shell and from every `git`/`claude` process tCon starts.
- **Web content taking over the app.**
  - A strict Content Security Policy allows scripts only from the app bundle (no inline
    scripts, no `eval`) and network connections only to Tauri's IPC.
  - Markdown preview renders with raw HTML disabled.
  - IPC is limited to the `main` webview at the app's own origin. tCon's own commands go
    through Tauri's permission system too (`src-tauri/build.rs`). Remote pages and child
    webviews, such as the built-in browser, get no IPC at all.
  - The quick panel window (the global shortcut's task inbox) has its own capability
    (`capabilities/quick.json`): it can read a task board, add tasks, list projects and hide
    itself, nothing else. No terminals, files, git or settings.
  - Links open only as `http(s)://` or `mailto:`. tCon never asks the OS to "open" a local
    file, because that could launch an app or script. It only reveals files in Finder.
- **Casual secret access from the UI.** The file tree and editor refuse `~/.ssh`,
  `~/.gnupg`, `~/Library/Keychains`, other accounts' private folders and Claude Code
  credential files.
- **Tampering with the tCon app (macOS).** Signed release builds use the **hardened
  runtime** (`hardenedRuntime` in `tauri.conf.json`). macOS then refuses `DYLD_INSERT_LIBRARIES` and other DYLD
  injection, unsigned code and libraries, debugger attachment, and changes to the signed
  code. No entitlements weaken this. This only applies to builds signed with a Developer
  ID, which the release workflow does when the signing secrets are configured. The web
  inspector is off in the main window of release builds.
- **Supply chain of tCon itself.**
  - CI installs dependencies with `--ignore-scripts`, and so does the repo's `.npmrc`.
  - Third-party GitHub Actions are pinned to commit SHAs.
  - Workflow tokens are read-only, except the job that publishes releases.
  - `npm audit` (high and critical) and `cargo audit` run on every push and weekly.
- **Tampered updates.** Auto-updates are signed with tCon's updater key (minisign). The app
  verifies each download against the public key built into it before installing, and fetches
  them in Rust over HTTPS from GitHub releases, so the UI's CSP stays closed to the network.

### What tCon cannot protect against

- **Code that runs as you.** A terminal app runs shells, so anything you run in tCon can
  do what you can: read the Keychain through `security`, run `claude`, read
  `~/.claude`. That includes `npm install` of a bad package, a `curl | sh`, or a
  compromised dependency of the project you're working on. The editor guards above only
  stop the UI from opening those files. They don't stop a program you run in a terminal.
- **A compromised tCon frontend.** If someone found a way to run script in tCon's main
  window, they could open a terminal through IPC. The CSP and the IPC limits exist to
  stop that from happening, not to contain it afterwards.
- **Linux credential files.** Claude Code keeps the login in plaintext on Linux. tCon can
  only make sure the file is 0600.
- **Malware with root or with your login password**, and anyone with physical access to
  your unlocked machine.

## Practical advice

1. **Keep untrusted code away from your main account.** Run unfamiliar repositories,
   `npm install` of unknown packages, and scripts from the internet as a separate macOS
   user, in a VM, or in a container (Docker or a devcontainer). A separate macOS user
   has its own login Keychain, so your Claude logins are out of reach.
2. **Turn off npm install scripts globally:** `npm config set ignore-scripts true`. Most
   packages work without them. When one really needs its script, run
   `npm rebuild <package>` for it after checking what it does.
3. **Use a separate tCon account for experiments.** Settings → Accounts → Add account
   creates a separate login. Log out of it (or remove it) when you're done, so Claude
   Code removes its saved login.
4. **Be careful with Keychain prompts.** If macOS asks whether some program may access
   "Claude Code-credentials", choose **Deny** unless you know exactly why it's asking.
   Never choose **Always Allow** for a program you don't recognise. That adds it to the
   item's access list permanently. To undo it, open Keychain Access, find the item, and
   remove the program under Access Control.
5. **Run Settings → Security now and then** and press **Fix permissions** if it reports
   anything. Claude Code may create new files with default permissions.
6. **Don't put API keys in project environment variables.** Sign in through Settings →
   Accounts instead. If you need `ANTHROPIC_API_KEY`, keep it in your shell profile or a
   secret manager, not in tCon.
7. **Install tCon only from the GitHub releases page.** Check that it's signed:
   `codesign -dv --verbose=2 /Applications/tCon.app`.
