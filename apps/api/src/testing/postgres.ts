import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import EmbeddedPostgres from 'embedded-postgres';
import { connectDatabase } from '../db/client.js';

export async function startTestDatabase() {
  const root = await mkdtemp(join(tmpdir(), 'compass-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: join(root, 'data'),
    user: 'postgres',
    password: randomBytes(32).toString('hex'),
    persistent: false,
    initdbFlags: ['--auth-local=trust'],
    // Only a Unix socket in a private temporary directory, no TCP or public port.
    postgresFlags: ['-c', 'listen_addresses=', '-k', root],
    onLog: () => undefined,
    onError: () => undefined,
  });
  const oldMask = process.umask(0o077);
  try {
    await server.initialise();
  } finally {
    process.umask(oldMask);
  }
  await server.start();
  const url = (user: string) =>
    `postgresql://${user}@localhost/postgres?host=${encodeURIComponent(root)}`;
  const admin = connectDatabase(url('postgres'));
  try {
    await admin.db.execute(sql`create role migrator login nosuperuser nocreatedb nocreaterole`);
    await admin.db.execute(sql`create role app login nosuperuser nocreatedb nocreaterole`);
    await admin.db.execute(sql`revoke create on schema public from public`);
    await admin.db.execute(sql`grant usage, create on schema public to migrator`);
    await admin.db.execute(sql`grant create on database postgres to migrator`);
    await admin.db.execute(sql`grant usage on schema public to app`);
    const migrator = connectDatabase(url('migrator'));
    try {
      await migrate(migrator.db, {
        migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
      });
    } finally {
      await migrator.pool.end();
    }
  } catch (error) {
    await server.stop();
    throw error;
  } finally {
    await admin.pool.end();
  }
  return {
    databaseUrl: url('app'),
    adminUrl: url('postgres'),
    close: async () => {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
