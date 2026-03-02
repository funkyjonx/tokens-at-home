# UX Issues TODO

Issues found during a UX audit, grouped by severity. The 4 blockers have been fixed. The remaining issues are documented here for future work.

## Annoying (9 issues)

These degrade usability but won't make the tool appear broken.

1. **`tah contributor register` asks for username separately** (`packages/cli/src/commands/contributor.ts`)
   Could detect GitHub username automatically from `gh api user --jq .login`.

2. **Worker polls silently for extended periods** (`packages/worker/src/index.ts`)
   After several empty polls, no indication of what to do. Should suggest `tah contributor pledge` more prominently after the first poll with no results.

3. **`tah project add` has no confirmation** (`packages/cli/src/commands/project.ts`)
   Submits immediately; no summary of what will be submitted. Should print a summary and prompt `y/N` before sending.

4. **No `tah worker stop` command** (`packages/cli/src/commands/worker.ts`)
   Users must Ctrl-C. There's no way to stop a running worker gracefully from another terminal.

5. **`tah contributor pledges` output is not formatted** (`packages/cli/src/commands/contributor.ts`)
   Pledges are printed as raw JSON. Should be formatted as a table with project name, max tasks, and remaining count.

6. **Config path is hardcoded to `~/.tokens-at-home/config.json`** (`packages/cli/src/config.ts`)
   No `--config` flag or `TAH_CONFIG` environment variable to override the config path.

7. **`tah task list` shows all tasks, not just current contributor's** (`packages/cli/src/commands/task.ts`)
   Should default to filtering by the authenticated contributor's ID.

8. **Worker does not log which config file it loaded** (`packages/worker/src/index.ts`)
   Hard to debug when running with a non-default config. Should log the resolved config path at startup.

9. **No `--json` output flag on any read commands** (`packages/cli/src/commands/`)
   Power users and scripts can't get structured output from `tah project list`, `tah contributor profile`, etc.

## Minor (7 issues)

Small rough edges that are unlikely to cause confusion.

1. **`version` in `package.json` does not match `program.version()`** (`packages/cli/package.json`, `packages/cli/src/index.ts`)
   Should read the version dynamically from `package.json` instead of hardcoding `'0.0.1'`.

2. **Help text for `tah worker start` doesn't mention log location** (`packages/cli/src/commands/worker.ts`)
   Users don't know where to look for task logs after a failure.

3. **`tah config show` reveals the auth token in plaintext** (`packages/cli/src/commands/config.ts`)
   Should mask the token (e.g. `sk-***...abc`) to avoid accidental exposure in screenshots/logs.

4. **`--coordinator-url` flag is not available globally** (`packages/cli/src/index.ts`)
   Must be configured in the config file; can't override per-command with a flag for quick testing.

5. **Worker work directory is not configurable at runtime** (`packages/worker/src/index.ts`)
   `workDir` can only be set in the config file; no `--work-dir` CLI flag for one-off overrides.

6. **`tah contributor deregister` is missing** (`packages/cli/src/commands/contributor.ts`)
   No way to remove a contributor account from the coordinator.

7. **Exit code on successful `tah worker start` exit is 0, but non-zero on worker errors** (`packages/cli/src/commands/worker.ts`)
   Fixed as part of blocker 3 (exit code propagation), but the behavior should be tested in CI.
