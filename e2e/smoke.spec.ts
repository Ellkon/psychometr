/**
 * Smoke e2e: the web shell loads and the API is reachable through the proxy.
 * Key journeys (invite login, PHQ-9, alert confirmation) land in stages 2–6.
 */
import { expect, test } from '@playwright/test';

test('web shell shows the app title', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Клинический компас' })).toBeVisible();
});

test('api health is reachable through the reverse proxy', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { status: string };
  expect(body.status).toBe('ok');
});
