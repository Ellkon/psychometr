/**
 * Drizzle Kit configuration (stage 1: plumbing only).
 * Schema lives in src/db/schema.ts and is filled in stage 2 (auth, RBAC,
 * patient data model). Applied migrations are never edited (AGENTS.md).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/psychometr',
  },
  strict: true,
  verbose: true,
});
