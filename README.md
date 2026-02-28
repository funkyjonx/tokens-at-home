# Tokens at Home

> Folding@Home for LLM compute. Contributors pledge their unused Claude Pro/Max capacity to open source projects.

Claude Pro and Max subscribers have a monthly usage allowance most don't fully use. Tokens at Home is a marketplace where contributors pledge that unused capacity to open source projects — like Folding@Home, but for LLM compute.

**Contributors** don't pick individual issues. They choose projects and set a budget. The coordinator matches them to issues that fit. Their machine does the work autonomously using Claude Code; they review the diff before it becomes a PR.

**Projects** label GitHub issues with `tah` to make them available. They receive PRs like any other contributor. Claude never has merge access.

---

## How it works

```
Contributor                    Coordinator                    Project
    |                              |                              |
    |-- "I pledge 80% to react" ->|                              |
    |                              |-- "contributor has ~80k      |
    |                              |    tokens available" ------->|
    |                              |                              |
    |                              |<-- "assign issue #4821 ------|
    |                              |     (est: 8k tokens)"        |
    |                              |                              |
    |<-- task: react/#4821 --------|                              |
    |                              |                              |
    | [clone, run claude -p, diff] |                              |
    |                              |                              |
    |-- PR submitted --------------|-----------> GitHub PR ------>|
```

1. Contributor registers, pledges a % of their budget to a project
2. Coordinator matches issues to contributors based on language overlap, budget, and trust
3. Contributor's daemon clones the repo, runs `claude -p` with tool restrictions
4. Contributor reviews the diff (configurable — can auto-submit)
5. `gh pr create` opens a PR. Maintainers review and merge as normal.

API keys never leave the contributor's machine. The daemon invokes their local `claude` CLI directly.

---

## Packages

This is a pnpm monorepo with four packages:

| Package | Description |
|---------|-------------|
| [`@tah/shared`](packages/shared) | Types, Zod schemas, prompt templates |
| [`@tah/coordinator`](packages/coordinator) | Hono HTTP server — registration, matching, task lifecycle |
| [`@tah/daemon`](packages/daemon) | Long-running process — polls for tasks, runs Claude, creates PRs |
| [`@tah/cli`](packages/cli) | `tah` CLI for project owners and contributors |

---

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 9+
- `claude` CLI installed and authenticated (`claude --version`)
- `gh` CLI installed and authenticated (`gh auth status`)

### Install

```bash
git clone https://github.com/funkyjonx/tokens-at-home
cd tokens-at-home
pnpm install
pnpm build
```

### Run the coordinator

```bash
cd packages/coordinator
pnpm dev
# Listening on http://localhost:3000
```

The coordinator creates `tah.db` (SQLite) on first run. No migrations needed.

### Register as a contributor

```bash
# Point the CLI at your coordinator
tah config coordinatorUrl http://localhost:3000

# Register (saves auth token to ~/.tokens-at-home/config.json)
tah contributor register --username yourname --languages typescript,python
```

### Register a project

```bash
tah project register <owner> <repo> --languages typescript
```

Then label GitHub issues with `tah` to make them available, and register them:

```bash
tah project issue add <project-id> <issue-number> "Fix the login bug" --complexity small
```

### Assign a task (MVP — manual)

```bash
tah task assign <issue-id> <contributor-id>
```

### Start the daemon

```bash
tah daemon start
# Daemon started (PID 12345)
# Logs: ~/.tokens-at-home/logs/
```

The daemon polls for tasks every 30 seconds, clones the repo, runs Claude, and prompts you to review the diff before opening a PR.

---

## CLI reference

```
tah project register <owner> <repo>        Register a GitHub repo as a project
tah project issue add <id> <n> <title>     Make an issue available
tah project issues <id>                    List issues for a project

tah contributor register                   Register as a contributor
tah contributor pledge <project-id> <pct>  Pledge % of budget to a project
tah contributor available                  Mark yourself available
tah contributor profile                    Show your profile

tah task assign <issue-id> <contrib-id>    Manually assign (MVP)
tah task list                              List all tasks

tah daemon start                           Start daemon in background
tah daemon stop                            Stop daemon
tah daemon status                          Check if daemon is running
```

---

## Sandbox & safety

**Contributor protection**
- API keys never leave your machine — the daemon calls your local `claude` binary
- Work is isolated to `~/.tokens-at-home/work/<task-id>/`
- Claude Code is restricted to `Bash(git *), Bash(npm *), Read, Edit, Write, Glob, Grep` — no arbitrary shell
- All sessions logged to `~/.tokens-at-home/logs/`
- `review_before_pr` mode (default) shows you the diff before any PR is created
- Kill switch: `tah daemon stop`

**Project protection**
- All work submitted as PRs — maintainers review before merge
- Trust scores (Phase 2): new contributors get trivial/small issues only
- Projects choose eligible issues via labels

---

## Architecture

### Coordination protocol

Polling, not WebSockets. The daemon calls `GET /tasks/next` every 30s. Simple and resilient.

```
Daemon                         Coordinator
  |-- GET /tasks/next ---------->|  (every 30s)
  |<-- 200 {task} or 204 --------|
  |                               |
  |-- POST /tasks/:id/heartbeat ->|  (every 60s while working)
  |-- POST /tasks/:id/complete -->|  (PR URL + tokens used)
  |-- POST /tasks/:id/fail ------>|  (error details)
```

Five missed heartbeats → task abandoned, issue returned to the pool.

### Prompt assembly

Each task type gets a different prompt template (`packages/shared/src/prompts.ts`) and a different set of allowed tools. The prompt instructs Claude to stage changes but not commit — the daemon handles git commit and `gh pr create`.

### Database

SQLite for MVP (zero ops). Drizzle ORM makes the PostgreSQL migration straightforward when needed.

---

## Roadmap

**Phase 1 (current) — MVP**
- [x] Project and contributor registration
- [x] Manual task assignment
- [x] Daemon: clone → claude -p → review → PR
- [x] Task lifecycle (heartbeat, complete, fail)

**Phase 2 — Marketplace**
- [ ] Automatic budget-aware matching
- [ ] Pledge system with split budgets
- [ ] Trust scores from merged PRs
- [ ] GitHub webhook integration
- [ ] All 5 task types (code, tests, docs, deps, review)

**Phase 3 — Community**
- [ ] Web dashboard and leaderboard
- [ ] Project discovery
- [ ] Container-based sandboxing
- [ ] Notification system

---

## Contributing

```bash
pnpm test        # run all tests (47 passing)
pnpm typecheck   # TypeScript checks across all packages
pnpm build       # build all packages
```

Tests are in each package under `src/**/*.test.ts`. The coordinator integration tests run against an in-memory SQLite database — no setup needed.

---

## License

MIT
