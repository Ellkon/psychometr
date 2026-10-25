import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { startTestDatabase } from '../testing/postgres.js';
import { connectDatabase } from './client.js';

/* Stage 7: a server-side termination of an idle pooled connection must not crash the process. */
let database: Awaited<ReturnType<typeof startTestDatabase>>;
beforeEach(async () => {
  database = await startTestDatabase();
});
afterEach(async () => {
  await database.close();
});

describe('database pool', () => {
  it('survives a server-side termination of idle connections and reports only the code', async () => {
    const seen: (string | undefined)[] = [];
    const { db, pool } = connectDatabase(database.databaseUrl, (code) => {
      seen.push(code);
    });
    // A single administrative session, outside the pool under test.
    const admin = new pg.Client({ connectionString: database.adminUrl });
    await admin.connect();
    try {
      // Two concurrent queries leave two idle clients in the pool.
      await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);
      const terminated = await admin.query<{ count: number }>(
        `select count(*) filter (where pg_terminate_backend(pid))::int as count
         from pg_stat_activity
         where datname = current_database() and usename = 'app' and pid <> pg_backend_pid()`,
      );
      const killed = terminated.rows[0]?.count ?? 0;
      expect(killed).toBeGreaterThanOrEqual(2);
      // Wait for every dead client: a client that is still in the pool can be handed out.
      await vi.waitFor(
        () => {
          expect(seen).toHaveLength(killed);
        },
        { timeout: 5_000 },
      );
      // The pool discards the dead clients and opens new ones.
      const rows = await db.execute(sql`select 1 as ok`);
      expect(rows.rows).toMatchObject([{ ok: 1 }]);
      expect(seen.every((code) => code === '57P01')).toBe(true);
    } finally {
      await pool.end();
      await admin.end();
    }
  });
});
