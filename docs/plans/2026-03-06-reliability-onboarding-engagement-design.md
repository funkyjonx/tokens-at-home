# Design: Reliability, Onboarding, and Engagement

**Date**: 2026-03-06
**Status**: Approved

## Goals

1. Make the worker loop bulletproof — no ghosts, no silent failures
2. Reduce onboarding to a single command for both contributors and projects
3. Make contribution feel meaningful and visible

## Section 1: Data Model

### Removed

- `pledges` table
- `generic_pledges` table
- `Contributor.trustScore` (kept internally for matching, never exposed to users)
- `Contributor.autonomy` (folds into a single worker config flag)
- `Contributor.cycleResetDate`

### Simplified Contributor

The contributor record collapses to what a person actually needs to configure:

```
githubUsername, languages, maxConcurrent, maxComplexity, available
```

Matching is based on `languages` and `maxComplexity`. No per-project pledges. By default a contributor works on any project that matches their languages — they can optionally pin specific projects.

### Added: task_events table

Append-only log of phase transitions:

```
id, taskId, phase, tokensUsed, elapsedMs, createdAt
```

Every phase transition (`cloning`, `working`, `review`, `submitting`, `completed`, `failed`) is a row. Ghost detection becomes "no event for this task in the last N minutes" — exact and auditable, not probabilistic.

## Section 2: Onboarding Flow

### `tah start` — single entry point

Detects if registered, registers if not, then starts the worker. Replaces the current multi-step flow of register → pledge → pledge-any → configure → start.

```
$ tah start

  Tokens at Home — donate your Claude capacity to open source

  GitHub username: clay
  Languages you work in (comma-separated): typescript, python
  Max concurrent tasks [1]: 1
  Max complexity (trivial/small/medium/large) [small]: medium

  Registered. Starting worker...
  Watching for tasks — you'll contribute to any matching open source project.
  To limit to specific projects: tah project pin <owner/repo>

  [waiting] No tasks yet. Polling every 30s.
```

Once a task arrives:

```
  [->] prettier/prettier#14821 — Fix whitespace in JSX template literals
       complexity: small  |  est. 8k tokens

  [1/4] Cloning...          4s
  [2/4] Running Claude...   2m 31s  ·  12,431 tokens
  [3/4] Submitting PR...
  [ok]  Done -> github.com/prettier/prettier/pull/5679
        14,221 tokens donated  ·  your total: 28,442

  [waiting] Watching for next task...
```

### CLI commands removed

- `tah contributor pledge`
- `tah contributor pledge-any`
- `tah contributor watchlist`
- `tah contributor register` (absorbed into `tah start`)

### CLI commands added

- `tah project pin <owner/repo>` — opt into specific projects
- `tah project unpin <owner/repo>` — remove a pin
- `tah status` — show current task state with live phase and elapsed time

### Project onboarding

```
$ tah project add prettier/prettier

  Project registered.
  Syncing open issues labeled "tah" or "tokens-at-home"...
  Found 12 issues. Estimated complexity assigned automatically.

  Contributors matching TypeScript will be notified.
```

Label detection is automatic. Project maintainers add a `tah` label to issues they want worked — nothing else required.

## Section 3: Task Lifecycle & Ghost Detection

### Per-phase timeouts

Each phase has a hard timeout. When exceeded, the coordinator auto-abandons the task and returns the issue to `available` so another contributor can pick it up.

| Phase       | Timeout |
|-------------|---------|
| dispatched  | 2 min   |
| cloning     | 3 min   |
| working     | 45 min  |
| review      | 24 hr   |
| submitting  | 5 min   |

The coordinator's 60s sweep checks `phaseStartedAt` age against the phase limit, not heartbeat age.

### Phase events replace heartbeats

The worker sends phase progress events instead of bare heartbeats:

```typescript
// On phase transition
POST /tasks/:id/progress
{ phase: 'cloning' }
{ phase: 'working', tokensUsed: 0 }

// Every 60s while working
POST /tasks/:id/progress
{ phase: 'working', tokensUsed: 12431, elapsedMs: 151000 }
```

Each call resets the phase clock. Events are stored in `task_events`.

### Worker-side resilience

- **Execution timeout**: the `claude` CLI process is killed after 40 minutes (5 minutes before the coordinator's working timeout), producing a clean failure rather than a coordinator-side abandon.
- **Cleanup guarantee**: work directory cleanup moves to an unconditional `finally` block keyed on task ID, not on `result` state — eliminating the current leak when execution crashes before the result is assigned.

### Failure UX

```
  [2/4] Running Claude...   46m 12s  ·  [timeout]

  Task timed out in 'working' phase after 45m.
  Issue returned to queue — another contributor will pick it up.
  Partial log saved to ~/.tah/logs/task-abc123.log

  [waiting] Watching for next task...
```

No silent failure. No stuck state.

## Section 4: Engagement Layer

### Token counter as core metric

Every completed task shows the running total and leaderboard rank inline in the worker output:

```
  [ok] Done -> github.com/prettier/prettier/pull/5679
       14,221 tokens donated  ·  your total: 28,442  ·  rank: #47 all time
```

### `tah stats` command

```
$ tah stats

  clay — contributing since Jan 2025

  All time          This month
  ---------         ----------
  31 tasks          8 tasks
  142,883 tokens    38,221 tokens
  94% success       100% success
  Rank #31          Rank #12 (up)

  Top projects:  prettier/prettier (12)  ·  sindresorhus/got (7)  ·  vitejs/vite (5)
  Best streak:   9 days  ·  Current: 3 days
```

`tah stats <username>` works without auth for public profiles.

### Milestones in the terminal

Milestone notifications appear inline in worker output at natural moments:

```
  Milestone: 10 tasks completed — you've crossed the threshold for trusted
  contributor status. Projects can now assign you medium complexity issues.
```

### Web dashboard additions

- **Live task feed**: the `task_events` table powers a real-time view of what's happening across the platform. Makes the platform feel alive to visitors.
- **Contributor profile pages**: `/ui/contributors/:username` shows public stats, top projects, recent PRs. Prominently links to the contributor's GitHub profile (avatar + username as a clickable link to `github.com/:username`).

### PR attribution

Every PR submitted by the system includes:

```
Contributed by [@clay](https://tokens-at-home.fly.dev/ui/contributors/clay) via Tokens at Home
31 tasks · 142,883 tokens donated to open source
```

The contributor profile link lets project maintainers discover the platform. The profile page links prominently back to the contributor's GitHub profile — one click from the PR to GitHub.

## What Gets Thrown Away

- The pledge/generic-pledge model entirely
- Trust score as a user-facing concept
- Watchlist (superseded by `tah project pin`)
- `tah contributor register` as a standalone command
- Bare heartbeat endpoint (replaced by phase progress events)
