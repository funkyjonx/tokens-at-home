# Tokens at Home

> Folding@Home for LLM compute. Contribute your unused Claude Pro/Max capacity to open source.

Claude Pro and Max subscribers have a monthly usage allowance most don't fully use. Tokens at Home is a marketplace where contributors pledge that unused capacity to open source projects.

**As a contributor**, you choose projects and set a budget. The coordinator matches you to issues that fit. Your machine does the work autonomously using Claude Code — you review the diff before anything becomes a PR.

**As a project owner**, you label GitHub issues with `tah` to make them available. You receive PRs like from any other contributor. Claude never has merge access.

---

## For contributors

### Prerequisites

- Claude Pro or Max subscription with `claude` CLI installed ([install guide](https://claude.ai/claude-code))
- `gh` CLI installed and authenticated ([install guide](https://cli.github.com))
- Node.js 22+, pnpm 9+

### Install

```bash
npm install -g @tah/cli
```

### Register

```bash
tah config coordinatorUrl https://tokens-at-home.fly.dev
tah contributor register --username your-github-username --languages typescript,python
# Saves your auth token to ~/.tokens-at-home/config.json
```

### Pledge capacity to a project

```bash
# Browse available projects
tah project list

# Pledge 80% of your remaining budget to a project
tah contributor pledge <project-id> 80
```

You can pledge to multiple projects with split budgets. The coordinator picks issues that fit your budget — you won't be assigned something you can't cover.

### Start contributing

```bash
tah daemon start
```

That's it. The daemon polls for tasks, clones repos to `~/.tokens-at-home/work/`, and runs Claude on each issue. By default you'll be shown the diff and asked to approve before any PR is submitted.

```
Task received: facebook/react#4821 — Fix useEffect cleanup on unmount

--- a/src/hooks/useEffect.js
+++ b/src/hooks/useEffect.js
@@ -42,6 +42,9 @@ function commitHookEffectListMount(...

Submit PR? [y/N]
```

### Contributor CLI

```
tah contributor register          Register your profile
tah contributor profile           Show your profile and trust score
tah contributor pledge <id> <pct> Pledge % of budget to a project
tah contributor pledges           List your active pledges
tah contributor available         Mark yourself available for tasks
tah contributor unavailable       Pause task assignment

tah daemon start                  Start the daemon in background
tah daemon stop                   Stop the daemon
tah daemon status                 Check if it's running
```

### How your capacity is used

There's no API to read your remaining Claude allowance, so you self-report by setting a budget percentage when you pledge. The coordinator tracks tokens consumed per task (from Claude's usage output) and deducts from your stated budget. When your budget runs low, set yourself unavailable until your cycle resets:

```bash
tah contributor unavailable
# ... billing cycle resets ...
tah contributor available
```

### Safety

- **Your API key never leaves your machine.** The daemon calls your local `claude` binary — it never touches your credentials.
- **Work is sandboxed.** Each task runs in `~/.tokens-at-home/work/<task-id>/`. Claude is restricted to git, npm, and file operations. No arbitrary shell access.
- **You review before anything is submitted.** The default `review_before_pr` mode shows you a diff and waits for your approval.
- **Kill switch.** `tah daemon stop` terminates immediately.
- **Everything is logged.** Full session logs at `~/.tokens-at-home/logs/`.

---

## For project owners

### Register your project

```bash
npm install -g @tah/cli

tah config coordinatorUrl https://tokens-at-home.fly.dev
tah contributor register --username your-github-username --languages typescript
tah project register <owner> <repo> --languages typescript
```

### Make issues available

Label GitHub issues with `tah`, then register them:

```bash
tah project issue add <project-id> <issue-number> "Fix the login bug" \
  --complexity small \
  --type code
```

Complexity options: `trivial` (~2k tokens), `small` (~8k), `medium` (~25k), `large` (~80k). This determines which contributors can be matched to the issue based on their budget.

### That's it

Contributors will be matched to your issues automatically. You'll receive PRs through GitHub as normal — review and merge (or close) like any other PR.

### Project CLI

```
tah project register <owner> <repo>             Register a repo
tah project list                                 List registered projects
tah project issue add <id> <n> <title>          Make an issue available
tah project issues <id>                          List issues and their status
```

---

## Roadmap

**Now**
- Manual task assignment and basic matching
- `code` task type (fix/implement issues)
- Human review before PR submission

**Coming soon**
- Automatic budget-aware matching
- Trust scores — new contributors get small issues, earn larger ones via merged PRs
- More task types: `tests`, `docs`, `deps`, `review`
- GitHub webhook integration for real-time issue sync

**Later**
- Web dashboard and contributor leaderboard
- Project discovery
- Container-based sandboxing

---

## License

MIT
