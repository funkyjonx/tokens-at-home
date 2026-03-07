# Design: Contributor Flow Pressure Test — Issue List

**Date**: 2026-03-07
**Status**: Approved
**Method**: Code audit + targeted live calls against https://tokens-at-home.fly.dev

---

## Critical (breaks user flow)

### 1. No error handling in `tah start` registration
`packages/cli/src/commands/start.ts:88`

`api.post()` has no try/catch. A 409 (duplicate username), 400 (validation error), or network
failure throws an unhandled exception and prints a stack trace. User sees no recovery path.

Fix: wrap the registration block in try/catch; handle 409 ("Username already taken — to recover
your token, contact support"), 400 (show validation message), and generic errors.

### 2. Zombie CLI commands in `tah contributor`
`packages/cli/src/commands/contributor.ts`

Still exposes: `register`, `pledge`, `pledges`, `pledge-any`, `watch`, `unwatch`, `watchlist`.
These call removed server endpoints or duplicate `tah start`. Running `tah contributor --help`
shows 9 subcommands, most meaningless to new users.

Fix: remove all seven. Keep only `profile`, `available`, `unavailable`, `search`.

### 3. `requireAuth` error message is outdated
`packages/cli/src/config.ts:35`

Says "Run `tah contributor register` first". The correct command is now `tah start`.

Fix: update message to "Not registered. Run `tah start` to get started."

### 4. Live coordinator is stale
Confirmed via live calls:

- `GET /contributors/:username/stats` → 404 plain text (route not deployed)
- `GET /contributors/me/pledges` → 401 (endpoint still live on server)
- `GET /contributors/me/watchlist` → 401 (endpoint still live on server)

Fix: deploy latest coordinator to fly.dev.

---

## Medium (confusing/misleading)

### 5. `tah contributor profile` exposes removed concepts
`packages/cli/src/commands/contributor.ts:112-114`

Displays `trustScore`, `autonomy`, and `cycleResetDate: null`. Design explicitly removed
trustScore as a user-facing concept. Server's `deserializeContributor` also still returns it.

Fix: remove `trustScore`, `autonomy`, `cycleResetDate` from both CLI output and
`deserializeContributor` in the coordinator.

### 6. `tah project pin/unpin` lacks `requireAuth` guard
`packages/cli/src/commands/project.ts:362,377`

No `requireAuth(config)` before the API call. Unauthenticated users get a raw 401 from the
server rather than a local, friendly error.

Fix: add `requireAuth(config)` before the API client call in both `pin` and `unpin` actions.

### 7. No way to update contributor profile after registration
Once registered, `tah start` bypasses the registration prompts. There is no `tah contributor
update` command and no PATCH endpoint. Changing languages or maxComplexity requires manually
editing `~/.tokens-at-home/config.json`.

Fix: add `PUT /contributors/me` endpoint accepting partial updates (`languages`, `maxConcurrent`,
`maxComplexity`). Add `tah contributor update` command with the same interactive prompts as
registration.

### 8. Revoked token has no recovery path
If a token is revoked (`DELETE /me`) and the user runs `tah start`, config has `authToken` set so
registration is skipped. The worker starts, immediately fails `setAvailable(true)` with 401, and
exits with "Set available failed: 401". No helpful message, no recovery instructions.

Fix: in `tah start`, when config has a token, verify it with `GET /contributors/me` before
launching the worker. On 401, clear config and re-run the registration flow with a message:
"Your session has expired. Let's re-register."

### 9. `tah contributor register` sends stale `autonomy` field
`packages/cli/src/commands/contributor.ts:36,86`

Sends `autonomy: opts.autonomy` to the server. The schema strips it silently. The CLI then
prints a note about `review_before_pr` — a concept that no longer exists.

Fix: covered by issue #2 (remove `register` command entirely).

---

## Minor

### 10. `getGithubUsername()` duplicated
`packages/cli/src/commands/start.ts:15`, `packages/cli/src/commands/contributor.ts:8`

Identical function defined in two files.

Fix: extract to a shared utility in `packages/cli/src/utils.ts`.

### 11. `CliConfig` has stale `autonomy` field
`packages/cli/src/config.ts:16`

Fix: remove `autonomy` from the `CliConfig` interface.

### 12. Invalid maxComplexity silently coerced to 'medium'
`packages/cli/src/commands/start.ts:82`

Typing an invalid value (e.g. "big", "large ") silently becomes `'medium'` with no feedback.

Fix: re-prompt with "Invalid value. Choose: trivial, small, medium, large [medium]:" if input
is non-empty and not in the valid set.

### 13. Worker empty-poll hint jumps to `tah project pin`
`packages/worker/src/index.ts:74`

After 5 empty polls, suggests `tah project pin <owner/repo>`. For a new user, no tasks means
supply is low — pinning won't help.

Fix: change message to "Waiting for tasks... No matching tasks available yet." Drop the pin
suggestion from the polling loop; it's more appropriate as a one-time onboarding hint.

---

## Prioritized Fix Order

1. Deploy coordinator (unblocks live stats, clears stale endpoints) — #4
2. Error handling in `tah start` — #1
3. Remove zombie commands — #2
4. Fix `requireAuth` message — #3
5. Token verification before worker launch — #8
6. Add `requireAuth` to pin/unpin — #6
7. Strip removed concepts from profile — #5
8. `tah contributor update` command + PATCH endpoint — #7
9. Minor cleanup (#9–#13)
