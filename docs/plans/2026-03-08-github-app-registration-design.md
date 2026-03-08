# GitHub App Registration & Coordination Design

**Date:** 2026-03-08
**Status:** Approved

## Problem

Project owner registration has too much friction (multiple CLI commands, manual issue sync, hex project IDs). Contributors waste tokens on issues that are already in progress or closed on GitHub because the coordinator only learns about state changes when someone manually runs `tah project issue sync`.

## Solution

A GitHub App that drives all project registration and issue state changes via webhooks, eliminating manual steps and keeping the coordinator in real-time sync with GitHub.

---

## Registration Flow

**Before:** `tah project register owner/repo` → confirmation prompt → `tah project issue sync <hex-id>` → re-sync manually forever

**After:**
1. Project owner visits `github.com/apps/tokens-at-home` → Install → select repos
2. GitHub fires `installation` webhook to coordinator
3. Coordinator auto-registers the project (languages detected via GitHub API, config from `.tah.yml` if present)
4. Done — issues labeled `tah` flow automatically from that point on

### `.tah.yml` (optional, in repo root)

```yaml
label: tah                    # which label triggers issue sync (default: tah)
maxConcurrent: 3              # max simultaneous tasks (default: 3)
taskTypes: [code, tests, docs] # allowed task types (default: [code])
```

Languages are always auto-detected from GitHub's language API. Trust threshold is omitted — all contributors are eligible by default.

---

## Webhook Events

**Endpoint:** `POST /webhooks/github`
**Auth:** HMAC-SHA256 signature verification (`X-Hub-Signature-256`), no Bearer token
**Env var:** `GITHUB_WEBHOOK_SECRET`

| Event | Coordinator Action |
|---|---|
| `installation.created` | Auto-register all selected repos |
| `installation_repositories.added` | Register newly added repos |
| `installation.deleted` | Cancel all available issues, deactivate projects |
| `installation_repositories.removed` | Same, for individual repos |
| `issues.labeled` (label matches project label) | Add issue to coordinator |
| `issues.unlabeled` / `issues.closed` | Cancel issue immediately |
| `push` to default branch | Re-read `.tah.yml` if changed |

---

## Coordinator Changes

- **New file:** `packages/coordinator/src/routes/webhooks.ts`
- **New env var:** `GITHUB_WEBHOOK_SECRET`
- **Schema change:** Add `github_installation_id TEXT` column to `projects` table (nullable, for handling `installation.deleted` events)
- **New internal module:** thin GitHub API client with two calls:
  - `GET /repos/{owner}/{repo}/languages`
  - `GET /repos/{owner}/{repo}/contents/.tah.yml`
- Everything else (matching, task dispatch, contributor flow) unchanged

---

## CLI Changes

**Removed (with deprecation notice):**
- `tah project register` — replaced by GitHub App install
- `tah project issue sync` — replaced by webhooks

**Unchanged:**
- `tah project list`, `tah project pin/unpin`
- `tah project issue add` (manual one-offs still supported)
- `tah project issue cancel`
- All contributor and worker commands
- `tah start`

**New:**
- `tah project open` — opens `github.com/apps/tokens-at-home` in the browser

---

## How This Fixes Token Waste

When a GitHub issue is closed or de-labeled, the coordinator receives the webhook within seconds and sets the issue status to `cancelled`. Any worker polling for work will not receive it. Combined with the existing 3-failure cap on retries, this eliminates the main coordination problem.
