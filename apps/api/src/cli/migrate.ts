import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connectDatabase } from '../db/client.js';

const connectionString = process.env['MIGRATION_DATABASE_URL'];
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');
const { db, pool } = connectDatabase(connectionString);
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
} finally {
  await pool.end();
}
