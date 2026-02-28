import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { authTokens, contributors } from '../db/schema.js';

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function createAuthToken(
  db: Db,
  contributorId: string,
  ttlDays = 365,
): Promise<string> {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const id = randomBytes(8).toString('hex');

  await db.insert(authTokens).values({
    id,
    contributorId,
    tokenHash: hash,
    expiresAt,
  });

  return raw;
}

export async function verifyAuthToken(
  db: Db,
  rawToken: string,
): Promise<{ contributorId: string } | null> {
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const row = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, hash))
    .get();

  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) return null;

  return { contributorId: row.contributorId };
}

export async function getContributorFromToken(db: Db, rawToken: string) {
  const verified = await verifyAuthToken(db, rawToken);
  if (!verified) return null;

  const contributor = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, verified.contributorId))
    .get();

  return contributor ?? null;
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
