import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CreatedPatientSchema, PatientListSchema } from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';
import { Button, ErrorNotice } from '../components/forms.js';
import { IdentityForm } from '../components/identity-form.js';

export function HomePage() {
  const session = useSession();
  if (!session.ready) return <p role="status">Проверяем сессию…</p>;
  if (session.user?.role === 'doctor') return <DoctorHome />;
  if (session.user?.role === 'admin')
    return (
      <Card>
        <CardHeader>
          <h1 className="text-2xl font-semibold">Рабочее место администратора</h1>
          <p className="text-slate-600">
            Учётные записи и привязки врачей — без доступа к персональным и клиническим данным
            пациентов.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <Link className="text-teal-800 underline" to="/admin">
              Врачи и привязки
            </Link>
            <Link className="text-teal-800 underline" to="/audit">
              Журнал действий
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  if (session.user?.role === 'patient' && session.user.patientId)
    return (
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
            Личный кабинет
          </p>
          <h1 className="text-2xl font-semibold">Добро пожаловать</h1>
          <p className="text-slate-600">
            Устройство привязано. При следующем входе на нём понадобится ваш личный код.
          </p>
        </CardHeader>
        <CardContent>
          <Link
            className="text-teal-800 underline"
            to="/patients/$patientId"
            params={{ patientId: session.user.patientId }}
          >
            Мои данные
          </Link>
          <p className="mt-5 text-sm text-slate-500">
            Назначенные врачом шкалы и история ваших результатов — в карточке «Мои данные».
          </p>
        </CardContent>
      </Card>
    );
  return (
    <div className="mx-auto max-w-3xl py-6">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">
        Защищённое пространство врача и пациента
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
        Клинический компас
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
        Сопровождение терапии с сохранением врачебного контроля. Доступ к данным получают только
        пациент и его лечащая команда.
      </p>
      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Врачу и администратору</h2>
            <p className="text-sm text-slate-600">Вход по рабочей почте и паролю.</p>
          </CardHeader>
          <CardContent>
            <Link
              to="/login"
              className="inline-block rounded-md bg-teal-800 px-4 py-2.5 text-sm font-medium text-white"
            >
              Войти специалисту
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Пациенту</h2>
            <p className="text-sm text-slate-600">
              Для первого входа откройте ссылку, которую передал врач.
            </p>
          </CardHeader>
          <CardContent>
            <Link to="/patient-login" className="text-sm font-medium text-teal-800 underline">
              Я уже входил(а) на этом устройстве
            </Link>
          </CardContent>
        </Card>
      </div>
      <p className="mt-7 text-sm text-slate-500">
        Разрабатываемый прототип. Пока используйте только синтетические данные.
      </p>
    </div>
  );
}
function DoctorHome() {
  const { user } = useSession(),
    navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const listing = useQuery({
    queryKey: ['patients', user?.id, offset],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients?offset=${String(offset)}&limit=20`, PatientListSchema, {
        signal,
      }),
  });
  return (
    <div className="grid gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
          Рабочее место врача
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Мои пациенты</h1>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Создать пациента</h2>
            <p className="text-sm text-slate-600">
              После создания можно выпустить одноразовое приглашение.
            </p>
          </CardHeader>
          <CardContent>
            <IdentityForm
              label="Создать пациента"
              submit={async (identity) => {
                const result = await sessionClient.request('/api/patients', CreatedPatientSchema, {
                  method: 'POST',
                  body: { identity },
                });
                await navigate({ to: '/patients/$patientId', params: { patientId: result.id } });
              }}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold">Назначенные пациенты</h2>
            <p className="text-sm text-slate-600">
              Показаны только ваши привязки. Персональные данные — внутри защищённой карточки.
            </p>
          </CardHeader>
          <CardContent>
            {listing.isPending ? (
              <p role="status">Загружаем список…</p>
            ) : listing.error ? (
              <ErrorNotice message={listing.error.message} />
            ) : (
              <>
                <ul className="divide-y divide-slate-100">
                  {listing.data.patients.map((patient) => (
                    <li key={patient.id}>
                      <Link
                        to="/patients/$patientId"
                        params={{ patientId: patient.id }}
                        className="flex items-center justify-between gap-2 py-4 text-teal-900"
                      >
                        <span className="font-medium">Пациент {patient.id.slice(0, 8)}</span>
                        <span className="text-xs text-slate-500">
                          {new Date(patient.createdAt).toLocaleDateString('ru-RU')}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {listing.data.patients.length === 0 && (
                  <p className="py-4 text-sm text-slate-500">Здесь пока нет пациентов.</p>
                )}
                <div className="mt-4 flex justify-between gap-3">
                  <Button
                    disabled={offset === 0}
                    onClick={() => {
                      setOffset(Math.max(0, offset - 20));
                    }}
                  >
                    Назад
                  </Button>
                  <Button
                    disabled={listing.data.patients.length < 20}
                    onClick={() => {
                      setOffset(offset + 20);
                    }}
                  >
                    Далее
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
