/**
 * Playwright configuration (key user journeys land in stages 2–6).
 * The smoke suite runs against a running stack (docker compose or `pnpm dev`).
 * Target is set via WEB_BASE_URL; CI points it at the compose stack.
 */
import { defineConfig, devices } from '@playwright/test';

if (process.env['E2E_ENV_FILE']) process.loadEnvFile(process.env['E2E_ENV_FILE']);

const baseURL = process.env['WEB_BASE_URL'] ?? 'https://localhost:8443';

export default defineConfig({
  testDir: './e2e',
  webServer: process.env['LOCAL_E2E']
    ? {
        command: 'pnpm --filter @psychometr/api exec tsx src/testing/browser-server.ts',
        url: 'https://localhost:8443/api/ready',
        ignoreHTTPSErrors: true,
        timeout: 60_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      }
    : undefined,
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    // The local/CI Caddy CA is private. Transport remains HTTPS and cookies Secure.
    ignoreHTTPSErrors: true,
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
      ? {
          executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],
          args: ['--no-sandbox'],
        }
      : {},
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
