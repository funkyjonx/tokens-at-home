# Contributor Flow Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 13 issues found during the contributor flow pressure test, from critical UX breaks to minor cleanup.

**Architecture:** Changes span three packages: `packages/coordinator` (API routes + tests), `packages/cli` (commands + config), and `packages/worker` (poll message). Coordinator changes follow TDD against the in-memory test DB in `api.test.ts`. CLI changes are mostly deletion + small additions; no interactive CLI tests needed — verify manually.

**Tech Stack:** Hono, Drizzle ORM, better-sqlite3, vitest, commander.js, TypeScript

---

## Reference: Issue List

Full issue details in `docs/plans/2026-03-07-contributor-flow-issues.md`.

Short IDs used below: #1 error handling, #2 zombie cmds, #3 requireAuth msg, #4 deploy, #5 profile exposes removed fields, #6 pin/unpin auth, #7 no update command, #8 revoked token, #9 stale autonomy (covered by #2), #10 duplicate fn, #11 stale config field, #12 maxComplexity coercion, #13 worker poll msg.

---

## Task 1: Fix `requireAuth` message and remove stale `autonomy` from CliConfig

**Files:**
- Modify: `packages/cli/src/config.ts`

**Step 1: Update the `requireAuth` error message and remove the `autonomy` field**

In `packages/cli/src/config.ts`:

```typescript
export interface CliConfig {
  coordinatorUrl: string;
  contributorId?: string;
  authToken?: string;
  pollIntervalMs?: number;
  workDir?: string;
  logDir?: string;
  githubUsername?: string;
}

// ...

export function requireAuth(config: CliConfig): asserts config is CliConfig & { authToken: string; contributorId: string } {
  if (!config.authToken || !config.contributorId) {
    console.error('Not registered. Run `tah start` to get started.');
    process.exit(1);
  }
}
```

Remove the `autonomy` field from the interface. Any existing configs with `autonomy` in JSON will just have the extra key ignored on read — no migration needed.

**Step 2: Check for any remaining references to `config.autonomy` or `CliConfig.autonomy`**

Run:
```bash
grep -rn "autonomy" packages/cli/src/
```

Fix any remaining references by removing them.

**Step 3: Commit**

```bash
git add packages/cli/src/config.ts
git commit -m "fix(cli): update requireAuth message to tah start, remove stale autonomy field"
```

---

## Task 2: Remove zombie commands from `tah contributor`

**Files:**
- Modify: `packages/cli/src/commands/contributor.ts`

The following commands must be deleted entirely: `register`, `pledge`, `pledges`, `pledge-any`, `watch`, `unwatch`, `watchlist`.

Keep: `profile`, `available`, `unavailable`, `search`.

Also remove the now-unused imports: `GenericPledge`, `Pledge`, `WatchlistEntry` from the type import at the top, and remove the `getGithubUsername` function (will be extracted in Task 8). Also remove the `createInterface`/`execSync` imports if nothing else uses them.

**Step 1: Delete the seven zombie command blocks**

In `packages/cli/src/commands/contributor.ts`, delete the entire `.command('register')`, `.command('pledge')`, `.command('pledges')`, `.command('pledge-any')`, `.command('watch')`, `.command('unwatch')`, and `.command('watchlist')` blocks including their `.action()` handlers.

**Step 2: Clean up imports**

Update the type import line. Remove: `GenericPledge`, `Pledge`, `WatchlistEntry`, `Project`.
Keep: `Contributor`, `PublicContributor`, `Task`.

Remove the `getGithubUsername` function definition (will be shared util in Task 8, but for now just delete it since no kept commands use it).

Remove unused imports: `createInterface` from `readline`, `execSync` from `child_process`.

**Step 3: Build to confirm no compile errors**

```bash
cd packages/cli && pnpm build
```

Expected: clean build, no errors.

**Step 4: Verify help output**

```bash
node dist/index.js contributor --help
```

Expected: shows only `profile`, `available`, `unavailable`, `search`.

**Step 5: Commit**

```bash
git add packages/cli/src/commands/contributor.ts
git commit -m "fix(cli): remove zombie contributor subcommands (register, pledge, watch, etc.)"
```

---

## Task 3: Error handling in `tah start` registration

**Files:**
- Modify: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/api.ts` (check error format)

**Step 1: Check how `TahApiClient.post` surfaces errors**

Read `packages/cli/src/api.ts` and find what error is thrown on non-2xx responses. Look for the error message format (e.g., does it include the status code?).

**Step 2: Wrap the registration block in try/catch**

In `packages/cli/src/commands/start.ts`, wrap the `api.post(...)` call and `saveConfig(...)` in a try/catch:

```typescript
let result: { contributor: Contributor; token: string };
try {
  result = await api.post<{ contributor: Contributor; token: string }>('/contributors', {
    githubUsername: username,
    languages,
    maxConcurrent,
    maxComplexity,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('(409)')) {
    console.error(`\n  Username "${username}" is already registered.`);
    console.error('  If this is you, your config may be missing. Contact support to recover your token.');
  } else if (msg.includes('(400)')) {
    console.error(`\n  Registration failed: ${msg}`);
  } else {
    console.error(`\n  Could not reach coordinator: ${msg}`);
    console.error(`  Check your internet connection or try again.`);
  }
  rl.close();
  process.exit(1);
}

saveConfig({ ... });
```

Note: `rl` must be closed before `process.exit(1)` in the catch block to avoid hanging the terminal. Make sure `rl.close()` is called before every `process.exit(1)` in the registration flow.

**Step 3: Build and verify**

```bash
cd packages/cli && pnpm build
```

**Step 4: Manual smoke test — 409 path**

If you have a test username already registered in the live coordinator:
```bash
node dist/index.js start
# Enter the already-registered username
```
Expected: clean error message, no stack trace.

**Step 5: Commit**

```bash
git add packages/cli/src/commands/start.ts
git commit -m "fix(cli): handle registration errors gracefully in tah start"
```

---

## Task 4: Verify token before launching worker (revoked token recovery)

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

**Step 1: Add token verification before spawning worker**

In `packages/cli/src/commands/start.ts`, replace the "already registered" early-return block:

```typescript
// Before:
if (config.authToken && config.contributorId) {
  console.log('Config found. Starting worker...');
  // spawn worker...
}

// After:
if (config.authToken && config.contributorId) {
  const api = new TahApiClient(coordinatorUrl, config.authToken);
  try {
    await api.get('/contributors/me');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('(401)')) {
      console.log('\n  Your session has expired. Let\'s re-register.\n');
      // Clear the stale token and fall through to registration
      saveConfig({ ...config, authToken: undefined, contributorId: undefined, githubUsername: undefined });
      // Re-load to reflect cleared state — re-run the registration flow below
      // by not returning here
    } else {
      console.error(`  Could not reach coordinator: ${msg}`);
      process.exit(1);
    }
  }
  // If we reach here and config still has token (401 case cleared it above), launch worker
  const freshConfig = loadConfig();
  if (freshConfig.authToken && freshConfig.contributorId) {
    console.log('Config found. Starting worker...');
    const workerBin = findWorkerBin();
    const child = spawn(process.execPath, [workerBin], { stdio: 'inherit', env: { ...process.env } });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    process.exit(child.exitCode ?? 1);
    return;
  }
  // Else fall through to registration (token was cleared)
}
```

**Step 2: Build**

```bash
cd packages/cli && pnpm build
```

**Step 3: Commit**

```bash
git add packages/cli/src/commands/start.ts
git commit -m "fix(cli): verify token before launching worker, re-register on 401"
```

---

## Task 5: Add `requireAuth` guard to `tah project pin` and `tah project unpin`

**Files:**
- Modify: `packages/cli/src/commands/project.ts`

**Step 1: Add `requireAuth` to pin and unpin actions**

In `packages/cli/src/commands/project.ts`, in both the `pin` and `unpin` action handlers, add `requireAuth(config)` immediately after `const config = loadConfig()`:

```typescript
// pin action:
const config = loadConfig();
requireAuth(config);  // ADD THIS
const api = new TahApiClient(config.coordinatorUrl, config.authToken);

// unpin action:
const config = loadConfig();
requireAuth(config);  // ADD THIS
const api = new TahApiClient(config.coordinatorUrl, config.authToken);
```

**Step 2: Build**

```bash
cd packages/cli && pnpm build
```

**Step 3: Commit**

```bash
git add packages/cli/src/commands/project.ts
git commit -m "fix(cli): add requireAuth guard to tah project pin/unpin"
```

---

## Task 6: Strip removed concepts from coordinator `GET /contributors/me` response

**Files:**
- Modify: `packages/coordinator/src/routes/contributors.ts`
- Modify: `packages/coordinator/src/routes/api.test.ts`

**Step 1: Write a failing test**

In `packages/coordinator/src/routes/api.test.ts`, add inside `describe('GET /contributors/me')`:

```typescript
it('does not expose trustScore, autonomy, or cycleResetDate', async () => {
  const res = await app.request('/contributors/me', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body).not.toHaveProperty('trustScore');
  expect(body).not.toHaveProperty('autonomy');
  expect(body).not.toHaveProperty('cycleResetDate');
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/coordinator && pnpm test --reporter=verbose 2>&1 | grep -A5 "does not expose"
```

Expected: FAIL — `trustScore` is present in the response.

**Step 3: Fix `deserializeContributor` to omit the removed fields**

In `packages/coordinator/src/routes/contributors.ts`, update `deserializeContributor`:

```typescript
function deserializeContributor(c: typeof contributors.$inferSelect) {
  const { trustScore, ...rest } = c;
  void trustScore; // intentionally omitted from public response
  return {
    ...rest,
    languages: JSON.parse(c.languages) as string[],
    available: Boolean(c.available),
  };
}
```

Note: `autonomy` and `cycleResetDate` are likely not in the DB schema (they were removed), so they won't appear in `c`. Confirm by checking `packages/coordinator/src/db/schema.ts` — if they are present, destructure them out the same way. If not, `trustScore` alone is the fix.

**Step 4: Run the test to verify it passes**

```bash
cd packages/coordinator && pnpm test --reporter=verbose 2>&1 | grep -A5 "does not expose"
```

Expected: PASS.

**Step 5: Update the CLI profile command to remove the removed fields from output**

In `packages/cli/src/commands/contributor.ts`, update the `profile` action to remove the lines printing `trustScore`, `autonomy`, and `cycleResetDate`. The profile display should only show:

```typescript
console.log(`GitHub: ${contributor.githubUsername}`);
console.log(`Languages: ${contributor.languages.join(', ')}`);
console.log(`Available: ${contributor.available}`);
console.log(`Max concurrent: ${contributor.maxConcurrent}`);
console.log(`Max complexity: ${contributor.maxComplexity}`);
```

**Step 6: Build both packages**

```bash
pnpm build
```

**Step 7: Commit**

```bash
git add packages/coordinator/src/routes/contributors.ts packages/coordinator/src/routes/api.test.ts packages/cli/src/commands/contributor.ts
git commit -m "fix: strip trustScore and other removed fields from contributor profile response"
```

---

## Task 7: Fix invalid maxComplexity coercion in `tah start`

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

**Step 1: Replace the silent coercion with a validation loop**

In `packages/cli/src/commands/start.ts`, replace:

```typescript
const maxComplexityRaw = await prompt(rl, '  Max complexity (trivial/small/medium/large) [medium]: ');
const maxComplexity = (['trivial', 'small', 'medium', 'large'].includes(maxComplexityRaw)
  ? maxComplexityRaw : 'medium') as IssueComplexity;
```

With:

```typescript
const validComplexities = ['trivial', 'small', 'medium', 'large'];
let maxComplexity: IssueComplexity = 'medium';
while (true) {
  const raw = await prompt(rl, '  Max complexity (trivial/small/medium/large) [medium]: ');
  if (!raw) break; // accept default
  if (validComplexities.includes(raw)) {
    maxComplexity = raw as IssueComplexity;
    break;
  }
  console.log(`  Invalid value "${raw}". Choose: trivial, small, medium, large`);
}
```

**Step 2: Build**

```bash
cd packages/cli && pnpm build
```

**Step 3: Commit**

```bash
git add packages/cli/src/commands/start.ts
git commit -m "fix(cli): re-prompt on invalid maxComplexity input in tah start"
```

---

## Task 8: Extract `getGithubUsername()` to a shared CLI utility

**Files:**
- Create: `packages/cli/src/utils.ts`
- Modify: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/commands/contributor.ts`

**Step 1: Create `packages/cli/src/utils.ts`**

```typescript
import { execSync } from 'child_process';

export function getGithubUsername(): string | null {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
```

**Step 2: Update `start.ts` to import from utils**

Remove the `getGithubUsername` function definition from `start.ts` and add:
```typescript
import { getGithubUsername } from '../utils.js';
```

**Step 3: Update `contributor.ts` to import from utils**

Remove the `getGithubUsername` function definition from `contributor.ts` (if it still exists after Task 2) and add the import.

**Step 4: Build**

```bash
cd packages/cli && pnpm build
```

Expected: clean build.

**Step 5: Commit**

```bash
git add packages/cli/src/utils.ts packages/cli/src/commands/start.ts packages/cli/src/commands/contributor.ts
git commit -m "refactor(cli): extract getGithubUsername to shared utils"
```

---

## Task 9: Add `PATCH /contributors/me` endpoint and `tah contributor update` command

**Files:**
- Modify: `packages/coordinator/src/routes/contributors.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/coordinator/src/routes/api.test.ts`
- Modify: `packages/cli/src/commands/contributor.ts`

### 9a: Add schema and coordinator endpoint

**Step 1: Add `UpdateContributorSchema` to `packages/shared/src/schemas.ts`**

After `RegisterContributorSchema`:

```typescript
export const UpdateContributorSchema = z.object({
  languages: languageList.optional(),
  maxConcurrent: z.number().int().min(1).max(5).optional(),
  maxComplexity: IssueComplexitySchema.optional(),
});
export type UpdateContributorInput = z.infer<typeof UpdateContributorSchema>;
```

**Step 2: Export it from `packages/shared/src/index.ts`**

Add `UpdateContributorSchema` and `UpdateContributorInput` to the exports.

**Step 3: Write failing tests**

In `packages/coordinator/src/routes/api.test.ts`, add a new describe block after `GET /contributors/me`:

```typescript
describe('PATCH /contributors/me', () => {
  it('updates languages', async () => {
    const res = await app.request('/contributors/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ languages: ['python', 'rust'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { githubUsername: string; languages: string[] };
    expect(body.languages).toEqual(['python', 'rust']);
  });

  it('updates maxComplexity', async () => {
    const res = await app.request('/contributors/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ maxComplexity: 'large' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { maxComplexity: string };
    expect(body.maxComplexity).toBe('large');
  });

  it('rejects invalid data', async () => {
    const res = await app.request('/contributors/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ maxConcurrent: 99 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const res = await app.request('/contributors/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ languages: ['go'] }),
    });
    expect(res.status).toBe(401);
  });
});
```

**Step 4: Run tests to verify they fail**

```bash
cd packages/coordinator && pnpm test --reporter=verbose 2>&1 | grep -A3 "PATCH /contributors"
```

Expected: FAIL — 404/405 (route doesn't exist).

**Step 5: Add `PATCH /me` route to coordinator**

In `packages/coordinator/src/routes/contributors.ts`, add after the `PUT /me/available` handler:

```typescript
import { UpdateContributorSchema } from '@tah/shared';

// PATCH /me — update mutable profile fields
app.patch('/me', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const contributor = await getContributorFromToken(db, token);
  if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json();
  const parsed = UpdateContributorSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const updates: Record<string, unknown> = {};
  if (parsed.data.languages !== undefined) updates['languages'] = JSON.stringify(parsed.data.languages);
  if (parsed.data.maxConcurrent !== undefined) updates['maxConcurrent'] = parsed.data.maxConcurrent;
  if (parsed.data.maxComplexity !== undefined) updates['maxComplexity'] = parsed.data.maxComplexity;

  if (Object.keys(updates).length === 0) return c.json(deserializeContributor(contributor));

  await db.update(contributors).set(updates).where(eq(contributors.id, contributor.id));
  const updated = await db.select().from(contributors).where(eq(contributors.id, contributor.id)).get();
  return c.json(deserializeContributor(updated!));
});
```

Also add `UpdateContributorSchema` to the import from `@tah/shared` at the top of `contributors.ts`.

**Step 6: Run tests to verify they pass**

```bash
cd packages/coordinator && pnpm test --reporter=verbose 2>&1 | grep -A3 "PATCH /contributors"
```

Expected: all 4 tests PASS.

### 9b: Add `tah contributor update` CLI command

**Step 7: Add `update` subcommand to `packages/cli/src/commands/contributor.ts`**

Add after the `profile` command:

```typescript
cmd
  .command('update')
  .description('Update your contributor profile (languages, concurrency, complexity)')
  .action(async () => {
    const config = loadConfig();
    requireAuth(config);
    const api = new TahApiClient(config.coordinatorUrl, config.authToken);

    // Show current profile first
    const current = await api.get<Contributor>('/contributors/me');
    console.log(`\n  Current profile for @${current.githubUsername}:`);
    console.log(`  Languages:    ${current.languages.join(', ')}`);
    console.log(`  Concurrent:   ${current.maxConcurrent}`);
    console.log(`  Complexity:   ${current.maxComplexity}`);
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const p = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));

    const langsRaw = await p(`  Languages [${current.languages.join(',')}]: `);
    const languages = langsRaw
      ? langsRaw.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
      : undefined;

    const concurrentRaw = await p(`  Max concurrent [${current.maxConcurrent}]: `);
    const maxConcurrent = concurrentRaw ? (parseInt(concurrentRaw, 10) || undefined) : undefined;

    const validComplexities = ['trivial', 'small', 'medium', 'large'];
    let maxComplexity: string | undefined;
    while (true) {
      const raw = await p(`  Max complexity [${current.maxComplexity}]: `);
      if (!raw) break;
      if (validComplexities.includes(raw)) { maxComplexity = raw; break; }
      console.log(`  Invalid. Choose: trivial, small, medium, large`);
    }

    rl.close();

    const updates: Record<string, unknown> = {};
    if (languages) updates['languages'] = languages;
    if (maxConcurrent) updates['maxConcurrent'] = maxConcurrent;
    if (maxComplexity) updates['maxComplexity'] = maxComplexity;

    if (Object.keys(updates).length === 0) {
      console.log('\n  No changes made.');
      return;
    }

    await api.patch('/contributors/me', updates);
    console.log('\n  Profile updated.');
  });
```

Also add `createInterface` import back to `contributor.ts` if it was removed in Task 2, and add `api.patch` method to `TahApiClient` in `packages/cli/src/api.ts` if it doesn't exist.

**Step 8: Check that `TahApiClient` has a `patch` method**

Look at `packages/cli/src/api.ts`. If no `patch` method exists, add:

```typescript
async patch<T>(path: string, body: unknown): Promise<T> {
  return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
```

(Or whatever pattern the existing `put` method uses.)

**Step 9: Build**

```bash
pnpm build
```

**Step 10: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/index.ts \
  packages/coordinator/src/routes/contributors.ts packages/coordinator/src/routes/api.test.ts \
  packages/cli/src/commands/contributor.ts packages/cli/src/api.ts
git commit -m "feat: add PATCH /contributors/me endpoint and tah contributor update command"
```

---

## Task 10: Fix worker empty-poll message

**Files:**
- Modify: `packages/worker/src/index.ts`

**Step 1: Update the empty-poll log message**

Find the line at approximately `packages/worker/src/index.ts:74`:

```typescript
console.log(`[worker] Waiting for tasks... (${emptyPolls} polls — pin projects with \`tah project pin <owner/repo>\`)`);
```

Replace with:

```typescript
console.log(`[worker] Waiting for tasks... (${emptyPolls} polls)`);
```

**Step 2: Build**

```bash
cd packages/worker && pnpm build
```

**Step 3: Commit**

```bash
git add packages/worker/src/index.ts
git commit -m "fix(worker): remove misleading pin suggestion from empty-poll message"
```

---

## Task 11: Deploy coordinator to fly.dev

This is a manual deployment step, not a code change.

**Step 1: Confirm tests pass**

```bash
pnpm test
```

Expected: all tests pass.

**Step 2: Deploy**

```bash
fly deploy --app tokens-at-home
```

Or if using the `fly.toml` in the coordinator package:

```bash
cd packages/coordinator && fly deploy
```

**Step 3: Verify live endpoints**

```bash
# Stats endpoint should now work
curl https://tokens-at-home.fly.dev/contributors/clay/stats

# Pledge endpoint should be gone
curl -o /dev/null -w "%{http_code}" https://tokens-at-home.fly.dev/contributors/me/pledges
# Expected: 404
```

---

## Final Verification

After all tasks:

```bash
# Full test suite
pnpm test

# CLI smoke test
node packages/cli/dist/index.js contributor --help
# Expected: profile, available, unavailable, search, update — no zombie commands

node packages/cli/dist/index.js --help
# Verify all top-level commands look clean
```
