/**
 * Playwright configuration (key user journeys land in stages 2–6).
 * The smoke suite runs against a running stack (docker compose or `pnpm dev`).
 * Target is set via WEB_BASE_URL; CI points it at the compose stack.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['WEB_BASE_URL'] ?? 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
