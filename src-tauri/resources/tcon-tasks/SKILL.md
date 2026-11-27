---
name: tcon-tasks
description: Work the per-project task board kept in .tcon/tasks/*.md (the tCon kanban). Use when the user asks to list, pick, plan, implement or update a "task", "todo", "card" or "ticket" (ids like T-12), when a prompt references .tcon/tasks/, or when a repo has a .tcon/ folder and the user asks what to work on next.
---

# tCon task protocol

Projects opened in tCon keep a kanban board as plain files in the project root:

- `.tcon/tasks/<ID>.md`: one task per file (ids look like `T-12`).
- `.tcon/board.json`: column order and board settings. Don't edit it by hand. A task's column comes from its `status`.
- `.tcon/PROTOCOL.md`: a copy of this protocol.

The tCon app watches these files and updates its board live, so every edit you make is visible to the user right away.

## Task file format

```markdown
---
id: T-12
title: Fix login redirect loop
status: todo            # inbox | todo | in-progress | review | done
priority: high          # none | low | medium | high | urgent
labels: [bug, auth]
created: 2026-11-27T10:00:00Z
updated: 2026-11-27T10:00:00Z
agent: idle             # idle | queued | planning | running | blocked | done | failed
branch:
commits: []
pane:                   # tCon terminal pane id (managed by tCon, leave as is)
---

Free-form description / meeting notes from the user.

## Plan

## Progress log
- 2026-11-27 10:00 — Created

## Verification
```

Rules for editing:

- Keep the frontmatter valid: one `key: value` per line, lists as `[a, b]`, quote values that contain `:` or `#`. Keep keys you don't know about.
- Always set `updated:` to the current UTC time (ISO 8601) when you change a task.
- Never rewrite or shorten the user's description. Append to the agent sections instead.
- Progress log lines are `- YYYY-MM-DD HH:MM — message` (local time), newest last.
- Edit the file in place with your normal file tools. Don't delete or rename task files unless the user asks.

## Finding work

1. List `.tcon/tasks/*.md` and read their frontmatter.
2. Open tasks are those with `status` other than `done`. `todo` tasks are ready to work on, `inbox` tasks are untriaged notes (ask before working on them).
3. Prefer higher `priority`, then the oldest `created`. Skip tasks whose `agent` is `running`, `planning` or `queued` (another session owns them).
4. When the user asks what to do next, show a short list (id, title, status, priority) and ask which one to take.

## Working a task

Do these stages in order. Update the task file at every stage so the board shows where you are.

1. **Claim.** Set `status: in-progress`, `agent: running`, add a log line `Started`. Record the current git branch in `branch:`.
2. **Understand.** Read the task and its description carefully, then inspect the relevant code. If the request is ambiguous or you need a decision, go to "Blocked" below instead of guessing.
3. **Plan.** Write a short, concrete plan (numbered steps, files to touch, how you'll verify) under `## Plan`. Log `Plan written`. If `## Plan` already holds a triage plan (see below), follow it and only add to it; don't rewrite it.
4. **Implement.** Make the changes. Log notable milestones (one line each, not a diary).
5. **Verify.** Run the project's checks: the test suite, typecheck, linter and build as applicable (look at package.json scripts, Cargo.toml, Makefile, CI config). Write what you ran and the results under `## Verification`. Fix failures before going on. If something can't be verified automatically, say so there.
6. **Commit.** Stage only the files you changed for this task and commit with a message that starts with the task id, e.g. `T-12: Fix login redirect loop`. Don't push unless the task or the user asks. Append the short commit hash to `commits:`.
7. **Hand off.** Set `status: review`, `agent: done`, log `Done — ready for review` with a one-line summary. Leave `done` to the user unless they told you to close it.

## Triage (plan only)

When you're asked to plan or triage tasks (not to implement them), for each task:

1. Set `agent: planning` while you work on it. Don't change `status` yet.
2. Read the task and inspect the relevant code. Don't edit any code and don't commit.
3. Write `## Plan`: numbered steps, the files to touch, and how to verify. End the plan with these lines (they drive tCon's run queue):
   - `Files: src/a.ts, src-tauri/src/b.rs` (the files you expect to change)
   - `Parallel-safe: yes` or `Parallel-safe: no — <reason>` (can it run next to other agents?)
   - `Depends: T-3, T-5` (only if it needs other tasks done first; also set `depends: [T-3, T-5]` in the frontmatter)
4. Set `priority` and `labels` if they are empty.
5. Set `status: todo`, `agent: idle`, and log `Triaged — plan written`.

If a task is too unclear to plan, leave it in `inbox`, set `agent: idle`, and log `Triage — needs info: <question>`.

### Blocked

If you need input from the user (unclear requirement, risky/destructive change, missing credentials, failing checks you can't fix):

- Set `agent: blocked` and keep `status: in-progress`.
- Log `Blocked — <your question>` and also add the question under `## Plan`.
- Ask the question in the conversation and wait. When you get an answer, set `agent: running`, log it, and continue.

### Failure

If you have to give up, set `agent: failed`, log why, and leave the working tree in a clean, explainable state (don't leave half-applied changes uncommitted without saying so in the log).

## Creating tasks

When the user asks you to note a task, create `.tcon/tasks/T-<n>.md` with the next free number (one higher than the highest existing id), `status: inbox` (or `todo` if they want it done), `agent: idle`, the timestamps, and the empty `## Plan`, `## Progress log` (with a `Created` line) and `## Verification` sections.
