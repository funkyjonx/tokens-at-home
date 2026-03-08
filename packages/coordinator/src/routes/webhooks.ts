import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Db } from '../db/index.js';

export function webhookRoutes(db: Db, secret: string) {
  const app = new Hono();

  app.post('/', async (c) => {
    const rawBody = await c.req.text();

    // Verify HMAC-SHA256 signature
    if (!verifySignature(rawBody, c.req.header('X-Hub-Signature-256') ?? '', secret)) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    const event = c.req.header('X-GitHub-Event') ?? '';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    switch (event) {
      case 'ping':
        return c.json({ ok: true });
      default:
        return c.json({ ok: true, event, note: 'unhandled' });
    }
  });

  return app;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
