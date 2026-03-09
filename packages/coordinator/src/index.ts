import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { getDb, initSchema } from './db/index.js';
import { projectRoutes } from './routes/projects.js';
import { contributorRoutes } from './routes/contributors.js';
import { taskRoutes, abandonStaleTasks } from './routes/tasks.js';
import { eventRoutes } from './routes/events.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { uiRoutes, landingRoute } from './routes/ui.js';
import { webhookRoutes } from './routes/webhooks.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const db = getDb();
initSchema();

const app = new Hono();

app.use(trimTrailingSlash());
app.use('*', logger());
app.use('*', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'Request body too large (max 512 KB)' }, 413) }));
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.get('/health', (c) => c.json({ ok: true, version: '0.0.1' }));

app.route('/projects', projectRoutes(db));
app.route('/contributors', contributorRoutes(db));
app.route('/tasks', taskRoutes(db));
app.route('/events', eventRoutes(db));
app.route('/leaderboard', leaderboardRoutes(db));
app.route('/ui', uiRoutes(db));
app.route('/', landingRoute(db));

const webhookSecret = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
if (!webhookSecret) {
  console.warn('[coordinator] GITHUB_WEBHOOK_SECRET not set — webhook endpoint will reject all requests');
}
app.route('/webhooks/github', webhookRoutes(db, webhookSecret));

// Heartbeat sweep: abandon stale tasks every 60s
setInterval(async () => {
  const abandoned = await abandonStaleTasks(db);
  if (abandoned > 0) {
    console.log(`[sweep] Abandoned ${abandoned} stale task(s)`);
  }
}, 60_000);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`TAH Coordinator listening on http://0.0.0.0:${PORT}`);
});
