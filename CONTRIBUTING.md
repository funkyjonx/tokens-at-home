# Contributing to Tokens at Home

Thanks for your interest in contributing! This guide covers everything you need to go from zero to a passing PR.

## Prerequisites

- Node.js 22+
- pnpm 9+ (`npm install -g pnpm`)
- `claude` CLI installed and authenticated ([install guide](https://claude.ai/claude-code)) — needed to run the worker locally
- `gh` CLI installed and authenticated ([install guide](https://cli.github.com)) — needed to test PR submission

## Setup

```bash
git clone https://github.com/funkyjonx/tokens-at-home.git
cd tokens-at-home
pnpm install
pnpm build
```

## Monorepo structure

```
packages/
  cli/          # The `tah` CLI — commands contributors and project owners run
  worker/       # The worker process — polls for tasks, runs Claude, submits PRs
  coordinator/  # The server — matches contributors to issues, stores state
  shared/       # Zod schemas and types shared across all packages
```

Each package is independently buildable and testable. Changes to `shared/` usually require rebuilding the others.

## Development workflow

Run all tests:

```bash
pnpm test
```

Build everything:

```bash
pnpm build
```

Type-check without building:

```bash
pnpm typecheck
```

Work on a single package:

```bash
pnpm --filter @tah/cli test --watch
pnpm --filter @tah/coordinator dev
```

After building the CLI, you can run it directly:

```bash
node packages/cli/dist/index.js --help
```

## Running the coordinator locally

The coordinator is a standard Node HTTP server. It stores state in-memory (no database needed for local dev):

```bash
pnpm --filter @tah/coordinator dev
# Listening on http://localhost:3000
```

Then point your CLI at it:

```bash
tah config coordinatorUrl http://localhost:3000
```

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b my-fix`
2. Make your changes
3. Run `pnpm test` and `pnpm typecheck` — both must pass
4. Push and open a PR against `master`

Keep PRs focused. One issue per PR makes review faster. If you're fixing a bug, include a test that would have caught it.

## Finding something to work on

Issues labelled [`good first issue`](https://github.com/funkyjonx/tokens-at-home/labels/good%20first%20issue) are well-scoped and have enough context to get started without needing deep knowledge of the whole system.

Issues labelled [`help wanted`](https://github.com/funkyjonx/tokens-at-home/labels/help%20wanted) are ready for a contributor to pick up.

If you want to work on something not yet filed, open an issue first so we can discuss the approach before you invest time in the code.
