# Contributor Task Budget — Design

## Problem

The worker (`tah start`) picks up issues indefinitely with no way for contributors to bound their commitment. Contributors need a way to say "do up to N tasks, then stop until I say so."

Additionally, `tah contributor register` is referenced in the onboarding page but does not exist — registration is buried inside `tah start`.

## Design

### 1. Data Model

Add `taskBudget INTEGER` (nullable) to the `contributors` table.

- `null` — unlimited (default)
- `0` — exhausted, no new tasks picked up
- positive integer — tasks remaining

Budget is decremented atomically inside the existing `/tasks/next` transaction when a new task is created, preventing races and negative values.

### 2. API Changes

**`GET /tasks/next`**

Currently returns `204` for both "no matching issues" and budget exhaustion — indistinguishable to the worker. New behavior:

- `204` — no matching issue found (unchanged)
- `200 { budgetExhausted: true }` — budget is `0` and no dispatched task is pending

**Schemas**

Add optional `taskBudget` field to `RegisterContributorSchema` and `UpdateContributorSchema`.

Add a `PATCH /contributors/me/budget` endpoint (or extend `PATCH /contributors/me`) to increment the budget server-side: `{ add: n }` → `taskBudget += n`.

### 3. Worker Changes

When the worker receives `{ budgetExhausted: true }`:

- Print: `"Task budget exhausted. Run 'tah contributor budget add <n>' to contribute more."`
- Continue polling (do not exit) — resumes automatically if the user tops up without restarting

The current in-progress task always completes; budget only gates new task pickup.

### 4. CLI Changes

**`tah contributor register`** (new)

Standalone registration extracted from `tah start`. Interactive prompts:
- GitHub username (auto-detected from git config if available)
- Languages
- Max concurrent tasks
- Max complexity
- Task budget (optional — skip to set unlimited)

If the user skips the budget prompt, prints at the end:
> No budget set — the worker will run until you stop it. Run `tah contributor budget add <n>` to set a limit.

Saves auth token and contributor ID to `~/.tokens-at-home/config.json`.

`tah start` is updated to: verify registration exists (error if not, redirect to `tah contributor register`), then launch the worker.

**`tah contributor budget add <n>`** (new)

Adds N tasks to the contributor's server-side budget. Prints the new total:
> Budget updated: 8 tasks remaining.

**`tah contributor update`** — no changes (budget is managed separately)

### 5. Onboarding Page

Update `/ui/onboarding` to match the real workflow:

1. `npm install -g @anthropic-ai/claude-code`
2. `claude login`
3. `npm install -g @tah/cli`
4. `tah contributor register`
5. `tah contributor budget add 5` (optional — set a task limit)
6. `tah start`
7. `tah project pin owner/repo` (optional — focus on specific projects)

## Out of Scope

- Automatic budget reset on a schedule
- Token-based budgets (may be added later)
- Budget visibility on the web dashboard
