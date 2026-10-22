import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AuthResponseSchema, CreatedPatientSchema } from '@psychometr/shared';

// Only synthetic accounts in an isolated test deployment, never a clinical site.
test('doctor invitation, patient consent, PIN return and immediate revocation', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const email = process.env['ADMIN_EMAIL'],
    password = process.env['ADMIN_PASSWORD'];
  if (!email || !password || !baseURL)
    throw new Error('Supply synthetic ADMIN_EMAIL/ADMIN_PASSWORD and a running test stack');
  const origin = new URL(baseURL).origin;
  const adminResponse = await request.post('/api/auth/login', {
    data: { email, password },
    headers: { origin },
  });
  expect(adminResponse.status()).toBe(200);
  const admin = AuthResponseSchema.parse(await adminResponse.json());
  const doctorEmail = `${randomUUID()}@example.test`,
    doctorPassword = randomBytes(24).toString('base64url');
  const created = await request.post('/api/admin/practitioners', {
    data: { email: doctorEmail, password: doctorPassword },
    headers: { origin, authorization: `Bearer ${admin.accessToken}` },
  });
  expect(created.status()).toBe(201);
  CreatedPatientSchema.parse(await created.json());

  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(doctorEmail);
  await page.getByLabel('Пароль', { exact: true }).fill(doctorPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мои пациенты' })).toBeVisible();
  await page.getByLabel('Фамилия', { exact: true }).fill('Синтетический');
  await page.getByLabel('Имя', { exact: true }).fill('Сценарий');
  await page.getByRole('button', { name: 'Создать пациента', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Синтетический Сценарий' })).toBeVisible();
  await page.getByRole('button', { name: 'Создать новое приглашение' }).click();
  const inviteUrl = page.getByLabel('Одноразовая ссылка');
  await expect(inviteUrl).toBeVisible();
  const url = await inviteUrl.inputValue(),
    code = await page.getByLabel('Код приглашения', { exact: true }).inputValue();
  const token = new URL(url).pathname.split('/').at(-1);
  if (!token) throw new Error('Invitation token missing');

  const patientContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    const patient = await patientContext.newPage();
    const referrers: string[] = [];
    patientContext.on('request', (req) => {
      const referrer = req.headers()['referer'];
      if (referrer) referrers.push(referrer);
    });
    await patient.goto(url);
    await expect(patient).toHaveURL(`${origin}/invite`);
    expect(JSON.stringify(await patient.evaluate(() => history.state))).not.toContain(token);
    const personalCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await patient.getByLabel('Код из приглашения врача').fill(code);
    await patient.getByLabel('Личный код пациента', { exact: true }).fill(personalCode);
    await patient.getByLabel('Повторите личный код').fill(personalCode);
    await patient.getByRole('checkbox').check();
    await patient.getByRole('button', { name: 'Принять приглашение' }).click();
    await expect(patient.getByRole('heading', { name: 'Вы вошли по приглашению' })).toBeVisible();
    expect(referrers.some((referrer) => referrer.includes(token))).toBe(false);
    const cookies = await patientContext.cookies();
    for (const name of ['__Host-compass-refresh', '__Host-compass-device']) {
      const cookie = cookies.find((item) => item.name === name);
      expect(cookie?.secure).toBe(true);
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');
    }
    expect(await patient.evaluate(() => localStorage.length)).toBe(0);
    const response = patient.waitForResponse((res) =>
      /\/api\/patients\/[a-f0-9-]+$/.test(new URL(res.url()).pathname),
    );
    await patient.getByRole('link', { name: 'Мои данные' }).click();
    expect((await response).headers()['cache-control']).toContain('no-store');
    await expect(patient.getByRole('heading', { name: 'Синтетический Сценарий' })).toBeVisible();
    await patient.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('compass-outbox', 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('pending');
        };
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
        open.onerror = () => {
          reject(new Error('Test queue setup failed'));
        };
      });
    });
    await patient.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(
      patient.getByRole('heading', { name: 'Клинический компас', exact: true }),
    ).toBeVisible();
    expect(
      (await patient.evaluate(() => indexedDB.databases())).some(
        (db) => db.name === 'compass-outbox',
      ),
    ).toBe(false);
    await patient.getByRole('link', { name: 'Я уже входил(а) на этом устройстве' }).click();
    await patient.getByLabel('Личный шестизначный код').fill(personalCode);
    await patient.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(patient.getByRole('heading', { name: 'Вы вошли по приглашению' })).toBeVisible();
    await page.getByLabel('Подтверждаю отзыв всех сессий пациента').check();
    await page.getByRole('button', { name: 'Отозвать все сессии' }).click();
    await expect(page.getByRole('status')).toContainText('отозваны');
    await patient.reload();
    await expect(
      patient.getByRole('heading', { name: 'Клинический компас', exact: true }),
    ).toBeVisible();
    await patient.getByRole('link', { name: 'Я уже входил(а) на этом устройстве' }).click();
    await patient.getByLabel('Личный шестизначный код').fill(personalCode);
    await patient.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(patient.getByRole('alert')).toContainText('Неверные данные');
  } finally {
    await patientContext.close();
  }
});
