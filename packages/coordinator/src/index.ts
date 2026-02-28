import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getDb, initSchema } from './db/index.js';
import { projectRoutes } from './routes/projects.js';
import { contributorRoutes } from './routes/contributors.js';
import { taskRoutes, abandonStaleTasks } from './routes/tasks.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const db = getDb();
initSchema(db);

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.get('/health', (c) => c.json({ ok: true, version: '0.0.1' }));

app.route('/projects', projectRoutes(db));
app.route('/contributors', contributorRoutes(db));
app.route('/tasks', taskRoutes(db));

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
