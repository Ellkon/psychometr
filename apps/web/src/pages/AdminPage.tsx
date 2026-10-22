import { useQuery } from '@tanstack/react-query';
import {
  AssignPractitionerSchema,
  CreatePractitionerSchema,
  CreatedPatientSchema,
  IdSchema,
  PractitionerListSchema,
  SuccessSchema,
} from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { AsyncForm, ErrorNotice, Field, text } from '../components/forms.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';
import { useState } from 'react';

export function AdminPage() {
  const { user } = useSession(),
    [notice, setNotice] = useState<string | null>(null);
  const doctors = useQuery({
    queryKey: ['practitioners', user?.id],
    queryFn: ({ signal }) =>
      sessionClient.request('/api/admin/practitioners', PractitionerListSchema, { signal }),
    enabled: user?.role === 'admin',
  });
  if (user?.role !== 'admin')
    return <ErrorNotice message="Этот экран доступен только администратору." />;
  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-semibold">Врачи и привязки</h1>
      <p className="text-slate-600">
        Администратор управляет доступом по идентификаторам, не просматривая карточки пациентов.
      </p>
      {notice && (
        <p role="status" className="rounded-md bg-teal-50 p-3 text-sm text-teal-900">
          {notice}
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Учётная запись врача</h2>
          </CardHeader>
          <CardContent>
            <AsyncForm
              submitLabel="Создать врача"
              action={async (data) => {
                const parsed = CreatePractitionerSchema.safeParse({
                  email: text(data, 'email'),
                  password: text(data, 'password'),
                });
                if (!parsed.success)
                  throw new Error('Укажите корректную почту и пароль от 12 до 128 символов');
                await sessionClient.request('/api/admin/practitioners', CreatedPatientSchema, {
                  method: 'POST',
                  body: parsed.data,
                });
                setNotice('Учётная запись врача создана.');
                await doctors.refetch();
              }}
            >
              <Field label="Почта врача" name="email" type="email" required maxLength={254} />
              <Field
                label="Первоначальный пароль"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </AsyncForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Связать врача и пациента</h2>
          </CardHeader>
          <CardContent>
            <ErrorNotice message={doctors.error?.message ?? null} />
            <AsyncForm
              submitLabel="Сохранить привязку"
              action={async (data) => {
                const patientId = IdSchema.safeParse(text(data, 'patientId')),
                  doctor = AssignPractitionerSchema.safeParse({
                    practitionerId: text(data, 'practitionerId'),
                  });
                if (!patientId.success || !doctor.success)
                  throw new Error('Проверьте UUID пациента и выберите врача');
                const action = text(data, 'action');
                if (action === 'add')
                  await sessionClient.request(
                    `/api/admin/care-team/${patientId.data}`,
                    SuccessSchema,
                    { method: 'POST', body: doctor.data },
                  );
                else if (action === 'remove')
                  await sessionClient.request(
                    `/api/admin/care-team/${patientId.data}/${doctor.data.practitionerId}`,
                    SuccessSchema,
                    { method: 'DELETE' },
                  );
                else throw new Error('Выберите действие');
                setNotice('Привязка обновлена. Изменение записано в журнал.');
              }}
            >
              <Field label="UUID пациента" name="patientId" required />
              <label className="grid gap-2 text-sm font-medium">
                Врач
                <select
                  name="practitionerId"
                  required
                  className="h-10 rounded-md border border-slate-300 bg-white px-3"
                >
                  <option value="">Выберите врача</option>
                  {doctors.data?.practitioners.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Действие
                <select
                  name="action"
                  className="h-10 rounded-md border border-slate-300 bg-white px-3"
                >
                  <option value="add">Добавить в лечащую команду</option>
                  <option value="remove">Убрать из лечащей команды</option>
                </select>
              </label>
            </AsyncForm>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
