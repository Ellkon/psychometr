import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { AuthResponseSchema } from '@psychometr/shared';

// Only synthetic accounts in the isolated browser-test stack, never a clinical site.

export interface Credentials {
  email: string;
  password: string;
}

export interface EnrolledPatient {
  patientId: string;
  patientContext: BrowserContext;
  patient: Page;
}

export function adminCredentials(): Credentials {
  const email = process.env['ADMIN_EMAIL'];
  const password = process.env['ADMIN_PASSWORD'];
  if (!email || !password) {
    throw new Error('Supply synthetic ADMIN_EMAIL/ADMIN_PASSWORD and a running test stack');
  }
  return { email, password };
}

/** Origin that mutations must carry; equals PUBLIC_ORIGIN of the test stack. */
export function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not set');
  return new URL(baseURL).origin;
}

/** Creates a synthetic doctor through the administrator API. */
export async function createDoctor(
  request: APIRequestContext,
  origin: string,
): Promise<Credentials> {
  const login = await request.post('/api/auth/login', {
    data: adminCredentials(),
    headers: { origin },
  });
  expect(login.status()).toBe(200);
  const admin = AuthResponseSchema.parse(await login.json());
  const doctor = {
    email: `${randomUUID()}@example.test`,
    password: randomBytes(24).toString('base64url'),
  };
  const created = await request.post('/api/admin/practitioners', {
    data: doctor,
    headers: { origin, authorization: `Bearer ${admin.accessToken}` },
  });
  expect(created.status()).toBe(201);
  return doctor;
}

export async function loginDoctor(page: Page, doctor: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(doctor.email);
  await page.getByLabel('Пароль', { exact: true }).fill(doctor.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мои пациенты' })).toBeVisible();
}

/**
 * The doctor creates a synthetic patient and an invitation through the UI; the patient accepts it
 * in a separate browser context, exactly as a real patient would.
 */
export async function enrollPatient(
  page: Page,
  browser: Browser,
  baseURL: string,
): Promise<EnrolledPatient> {
  await page.getByLabel('Фамилия', { exact: true }).fill('Синтетический');
  await page.getByLabel('Имя', { exact: true }).fill('Сценарий');
  await page.getByRole('button', { name: 'Создать пациента', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Синтетический Сценарий' })).toBeVisible();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  const patientId = new URL(page.url()).pathname.split('/').at(-1);
  if (!patientId) throw new Error('Patient id missing from the URL');

  await page.getByRole('button', { name: 'Создать новое приглашение' }).click();
  const inviteUrl = page.getByLabel('Одноразовая ссылка');
  await expect(inviteUrl).toBeVisible();
  const url = await inviteUrl.inputValue();
  const code = await page.getByLabel('Код приглашения', { exact: true }).inputValue();

  const patientContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const patient = await patientContext.newPage();
  await patient.goto(url);
  const personalCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await patient.getByLabel('Код из приглашения врача').fill(code);
  await patient.getByLabel('Личный код пациента', { exact: true }).fill(personalCode);
  await patient.getByLabel('Повторите личный код').fill(personalCode);
  await patient.getByRole('checkbox').check();
  await patient.getByRole('button', { name: 'Принять приглашение' }).click();
  await expect(patient.getByRole('heading', { name: 'Добро пожаловать' })).toBeVisible();
  return { patientId, patientContext, patient };
}

/**
 * Access token for the session that owns this request context. Its cookies are the page's
 * cookies, so the token belongs to the same signed-in user as the page.
 */
export async function accessTokenFor(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.post('/api/auth/refresh', { data: {}, headers: { origin } });
  expect(response.status()).toBe(200);
  return AuthResponseSchema.parse(await response.json()).accessToken;
}

/** PHQ-9 item identifiers, verbatim from content/scales/phq9.ru.json. */
export const PHQ9_ITEMS = Array.from(
  { length: 9 },
  (_, index) => `phq9_${String(index + 1).padStart(2, '0')}`,
);
