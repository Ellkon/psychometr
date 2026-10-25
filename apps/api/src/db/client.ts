import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Logs only the SQLSTATE code: pg error messages can embed query fragments. */
export type IdleErrorHandler = (code: string | undefined) => void;

const writeIdleError: IdleErrorHandler = (code) => {
  process.stderr.write(JSON.stringify({ msg: 'database idle client error', code }) + '\n');
};

export function connectDatabase(
  connectionString: string,
  onIdleError: IdleErrorHandler = writeIdleError,
) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  // An idle client loses its connection on a server restart or an idle kill. pg then
  // emits 'error' on the pool and discards the client. Without a listener Node exits.
  pool.on('error', (error: Error & { code?: string }) => {
    onIdleError(error.code);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
