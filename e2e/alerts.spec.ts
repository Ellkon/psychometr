import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PatientTherapySchema } from '@psychometr/shared';
import {
  PHQ9_ITEMS,
  accessTokenFor,
  createDoctor,
  enrollPatient,
  loginDoctor,
  originOf,
} from './support.js';

const scheduleEveryTwoWeeks = { intervalDays: 14, windowDays: 7, active: true };

test.describe('critical alerts and offline dose marks (FR-8, FR-9)', () => {
  test('a positive PHQ-9 item 9 reaches the doctor live, is acknowledged and leaves the list', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const origin = originOf(baseURL);
    await loginDoctor(page, await createDoctor(request, origin));
    const { patientId, patientContext } = await enrollPatient(page, browser, origin);
    try {
      // The socket is up before the answer arrives, so the alert must be pushed, not reloaded.
      await expect(page.getByText('Уведомления в реальном времени: на связи.')).toBeVisible({
        timeout: 20_000,
      });

      const doctorToken = await accessTokenFor(page.request, origin);
      const schedule = await page.request.put(`/api/patients/${patientId}/scales/phq9/schedule`, {
        data: scheduleEveryTwoWeeks,
        headers: { origin, authorization: `Bearer ${doctorToken}` },
      });
      expect(schedule.ok()).toBe(true);

      const patientToken = await accessTokenFor(patientContext.request, origin);
      const answers = Object.fromEntries(
        PHQ9_ITEMS.map((item) => [item, item === 'phq9_09' ? 1 : 0]),
      );
      const submitted = await patientContext.request.post(
        `/api/patients/${patientId}/scales/phq9/responses`,
        {
          data: { submissionId: randomUUID(), answers, functionalAnswer: 0 },
          headers: { origin, authorization: `Bearer ${patientToken}` },
        },
      );
      expect(submitted.ok()).toBe(true);

      const alert = page.getByRole('alert').filter({ hasText: 'Ответ на пункт 9 PHQ-9 больше 0' });
      await expect(alert).toBeVisible({ timeout: 20_000 });
      await alert.getByRole('button', { name: /Принять алерт/ }).click();
      await expect(alert).toHaveCount(0);
    } finally {
      await patientContext.close();
    }
  });

  test('a dose mark taken offline is shown as pending, sent once when the network returns', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const origin = originOf(baseURL);
    await loginDoctor(page, await createDoctor(request, origin));
    const { patientId, patientContext, patient } = await enrollPatient(page, browser, origin);
    try {
      // A dose in half an hour (UTC) is markable now: the window opens an hour before the dose,
      // and slots before the prescription do not exist.
      const due = new Date(Date.now() + 30 * 60_000);
      const doseTime = due.toISOString().slice(11, 16);
      const doctorToken = await accessTokenFor(page.request, origin);
      const prescribed = await page.request.post(`/api/patients/${patientId}/medications`, {
        data: {
          grlsRegNumber: null,
          drugText: 'Синтетический препарат',
          doseText: '1 таблетка',
          doseTimes: [doseTime],
          timeZone: 'UTC',
          startsOn: due.toISOString().slice(0, 10),
          endsOn: null,
        },
        headers: { origin, authorization: `Bearer ${doctorToken}` },
      });
      expect(prescribed.status()).toBe(201);

      await patient.getByRole('link', { name: 'Мои данные' }).click();
      const taken = patient.getByRole('button', { name: 'Принял(а)', exact: true });
      await expect(taken.first()).toBeEnabled({ timeout: 15_000 });

      await patientContext.setOffline(true);
      await taken.first().click();
      await expect(
        patient.getByRole('status').filter({ hasText: 'Не отправлено: 1' }),
      ).toBeVisible();
      await expect(patient.getByText(/ждёт связи/)).toBeVisible();

      await patientContext.setOffline(false);
      // The browser fires `online`; the outbox resends and the slot shows the stored mark.
      await expect(patient.getByText('Не отправлено')).toHaveCount(0, { timeout: 20_000 });
      await expect(patient.getByText('Принято', { exact: true }).first()).toBeVisible();

      // One stored mark for the slot, however many times the client attempted to send it.
      const patientToken = await accessTokenFor(patientContext.request, origin);
      const view = await patientContext.request.get(`/api/patients/${patientId}/therapy`, {
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(view.ok()).toBe(true);
      const therapy = PatientTherapySchema.parse(await view.json());
      const marked = therapy.medications.flatMap((medication) =>
        medication.slots.filter((slot) => slot.status !== null),
      );
      expect(marked).toHaveLength(1);
    } finally {
      await patientContext.close();
    }
  });
});
