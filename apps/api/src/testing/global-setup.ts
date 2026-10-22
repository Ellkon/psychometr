import type { TestProject } from 'vitest/node';
import { startTestDatabase } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    adminUrl: string;
  }
}
export default async function setup(project: TestProject) {
  const database = await startTestDatabase();
  project.provide('databaseUrl', database.databaseUrl);
  project.provide('adminUrl', database.adminUrl);
  return database.close;
}
