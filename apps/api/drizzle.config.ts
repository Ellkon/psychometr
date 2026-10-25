/**
 * Drizzle Kit configuration for versioned PostgreSQL migrations.
 * Schema lives in src/db/schema.ts (auth, RBAC, patient data model).
 * Applied migrations are never edited (AGENTS.md).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgresql://localhost:5432/psychometr',
  },
  strict: true,
  verbose: true,
});
