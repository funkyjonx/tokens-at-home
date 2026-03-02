# Tokens at Home

> Folding@Home for LLM compute. Contribute your unused Claude Pro/Max capacity to open source.

Claude Pro and Max subscribers have a monthly usage allowance most don't fully use. Tokens at Home is a marketplace where contributors pledge that unused capacity to open source projects.

**As a contributor**, you choose projects and say how many tasks you want to do and how large. The coordinator matches you to fitting issues. Your machine does the work autonomously using Claude Code — you review the diff before anything becomes a PR.

**As a project owner**, you label GitHub issues with `tah` to make them available. You receive PRs like from any other contributor. Claude never has merge access.

---

## For contributors

### Prerequisites

- Claude Pro or Max subscription with `claude` CLI installed ([install guide](https://claude.ai/claude-code))
- `gh` CLI installed and authenticated ([install guide](https://cli.github.com))
- Node.js 22+, pnpm 9+

### Install

> **Early development** — `@tah/cli` is not yet published to npm. Install from source:

```bash
git clone https://github.com/funkyjonx/tokens-at-home.git
cd tokens-at-home
pnpm install && pnpm build
npm install -g ./packages/cli
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

# "I'll do 5 tasks for this project, any size"
tah contributor pledge <project-id> 5

# "I'll do 3 tasks, nothing bigger than medium"
tah contributor pledge <project-id> 3 --max-complexity medium
```

You can pledge to multiple projects. The coordinator matches you to issues that fit your complexity cap — you won't be assigned something larger than you've asked for.

### Start contributing

```bash
tah worker start
```

Keep this terminal open. The worker runs in the foreground, polls for tasks, and clones repos to `~/.tokens-at-home/work/`. When Claude finishes a task, you'll be shown the diff and asked to approve before any PR is submitted.

```
Task received: facebook/react#4821 — Fix useEffect cleanup on unmount

--- a/src/hooks/useEffect.js
+++ b/src/hooks/useEffect.js
@@ -42,6 +42,9 @@ function commitHookEffectListMount(...

Submit PR? [y/N]
```

### Contributor CLI

```
tah contributor register                      Register your profile
tah contributor profile                       Show your profile and trust score
tah contributor pledge <id> <n> [--max-complexity <c>]
                                              Pledge N tasks to a project
tah contributor pledges                       List your active pledges
tah contributor available                     Mark yourself available for tasks
tah contributor unavailable                   Pause task assignment

tah worker start                              Start the worker (foreground — keep terminal open)
```

### How capacity is used

When you pledge, you say how many tasks you want to complete (`maxTasks`) and the largest issue size you'll accept (`maxComplexity`: trivial, small, medium, or large). Once that many tasks are completed for that pledge, the pledge is exhausted and you'll stop receiving work from that project. To contribute more, create a new pledge.

When you want to pause:

```bash
tah contributor unavailable
# ... take a break ...
tah contributor available
```

### Safety

- **Your API key never leaves your machine.** The worker calls your local `claude` binary — it never touches your credentials.
- **Work is sandboxed.** Each task runs in `~/.tokens-at-home/work/<task-id>/`. Claude is restricted to git, npm, and file operations. No arbitrary shell access.
- **You review before anything is submitted.** The default `review_before_pr` mode shows you a diff and waits for your approval.
- **Kill switch.** `Ctrl-C` terminates the worker immediately.
- **Everything is logged.** Full session logs at `~/.tokens-at-home/logs/`.

---

## For project owners

### Register your project

```bash
# Install from source (see contributor install instructions above)
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

Complexity options: `trivial` (tiny, well-scoped), `small` (a few hours), `medium` (half a day), `large` (substantial change). Contributors choose which sizes they're willing to take on when they pledge.

### That's it

Contributors will be matched to your issues automatically. You'll receive PRs through GitHub as normal — review and merge (or close) like any other PR.

### Project CLI

```
tah project register <owner> <repo>             Register a repo (requires push access)
tah project list                                 List registered projects
tah project issue add <id> <n> [title]          Make an issue available
tah project issue sync <id>                      Sync all open labeled issues from GitHub
tah project issues <id>                          List issues and their status
```

---

## Roadmap

**Now**
- Manual task assignment and basic matching
- `code` task type (fix/implement issues)
- Human review before PR submission

**Coming soon**
- Trust scores — new contributors get small issues, earn larger ones via merged PRs
- More task types: `tests`, `docs`, `deps`, `review`
- GitHub webhook integration for real-time issue sync
- Token-budget awareness: once [anthropics/claude-code#21943](https://github.com/anthropics/claude-code/issues/21943) lands (programmatic access to Pro/Max usage data), optionally skip tasks whose `estimatedTokens` would exceed remaining quota

**Later**
- Web dashboard and contributor leaderboard
- Project discovery
- Container-based sandboxing

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, monorepo structure, and how to submit a PR.

Issues labelled [`good first issue`](https://github.com/funkyjonx/tokens-at-home/labels/good%20first%20issue) are a good place to start.

---

## License

MIT — see [LICENSE](LICENSE)
