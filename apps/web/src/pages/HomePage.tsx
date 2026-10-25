import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CreatedPatientSchema, RegistrySchema, type RegistryRow } from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';
import { Button, ErrorNotice } from '../components/forms.js';
import { IdentityForm } from '../components/identity-form.js';
import { useTherapy } from '../components/therapy-panel.js';
import { dosesToMark } from '../lib/therapy.js';

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
          <DoseReminder patientId={session.user.patientId} />
          <p className="mt-5 text-sm text-slate-500">
            Назначенные врачом шкалы, приём препаратов и история ваших результатов — в карточке «Мои
            данные».
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
    </div>
  );
}
/** In-app reminder only: out-of-app channels carry no medical text (AGENTS.md). */
function DoseReminder({ patientId }: { patientId: string }) {
  const therapy = useTherapy(patientId);
  if (!therapy.data) return null;
  const count = dosesToMark(therapy.data.medications, Date.now());
  if (count === 0) return null;
  return (
    <p role="status" className="mt-5 rounded-md bg-amber-50 p-3 text-sm text-amber-950">
      Отметьте приём препаратов: {count}{' '}
      <Link className="underline" to="/patients/$patientId" params={{ patientId }}>
        перейти к отметке
      </Link>
    </p>
  );
}

function DoctorHome() {
  const { user } = useSession(),
    navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const registry = useQuery({
    queryKey: ['registry', user?.id, offset],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/registry?offset=${String(offset)}&limit=20`, RegistrySchema, {
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
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Реестр</h2>
          <p className="text-sm text-slate-600">
            Только ваши пациенты. Флаги — это факты из данных пациента, а не рекомендации. «Новое» —
            есть данные, которые вы ещё не открывали.
          </p>
        </CardHeader>
        <CardContent>
          {registry.isPending ? (
            <p role="status">Загружаем реестр…</p>
          ) : registry.error ? (
            <ErrorNotice message={registry.error.message} />
          ) : (
            <>
              {registry.data.patients.length === 0 ? (
                <p className="py-4 text-sm text-slate-500">Здесь пока нет пациентов.</p>
              ) : (
                <RegistryTable rows={registry.data.patients} />
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
                  disabled={registry.data.patients.length < 20}
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
      <Card className="max-w-2xl">
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
    </div>
  );
}

const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function ScoreCell({ row, scaleId }: { row: RegistryRow; scaleId: string }) {
  const score = row.scores.find((item) => item.scaleId === scaleId);
  if (!score) return <span className="text-slate-400">—</span>;
  const delta =
    score.delta === null || score.delta === 0
      ? ''
      : ` (${score.delta > 0 ? '+' : ''}${String(score.delta)})`;
  return (
    <span title={`${score.bandLabel}, ${shortDate.format(new Date(score.answeredAt))}`}>
      {score.score}
      {delta}
    </span>
  );
}

function RegistryTable({ rows }: { rows: readonly RegistryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs text-slate-500">
          <tr>
            <th className="py-2 pr-3 font-medium">Пациент</th>
            <th className="py-2 pr-3 font-medium">PHQ-9</th>
            <th className="py-2 pr-3 font-medium">GAD-7</th>
            <th className="py-2 pr-3 font-medium">Без контакта</th>
            <th className="py-2 pr-3 font-medium">Шкалы</th>
            <th className="py-2 pr-3 font-medium">Дозы</th>
            <th className="py-2 pr-3 font-medium">Флаги</th>
            <th className="py-2 font-medium">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.patientId}>
              <td className="py-3 pr-3">
                <Link
                  to="/patients/$patientId"
                  params={{ patientId: row.patientId }}
                  className="font-medium text-teal-900 underline"
                >
                  Пациент {row.patientId.slice(0, 8)}
                </Link>
              </td>
              <td className="py-3 pr-3">
                <ScoreCell row={row} scaleId="phq9" />
              </td>
              <td className="py-3 pr-3">
                <ScoreCell row={row} scaleId="gad7" />
              </td>
              <td className="py-3 pr-3">
                {row.weeksWithoutContact === null
                  ? 'Нет данных'
                  : `${String(row.weeksWithoutContact)} нед.`}
              </td>
              <td className="py-3 pr-3">
                {row.dueScales > 0 ? `Не заполнено: ${String(row.dueScales)}` : '—'}
              </td>
              <td className="py-3 pr-3">
                {row.activeMedications === 0
                  ? '—'
                  : row.missedDosesInRow > 0
                    ? `Подряд не отмечено: ${String(row.missedDosesInRow)}`
                    : 'Отмечаются'}
              </td>
              <td className="grid gap-1 py-3 pr-3">
                {row.safetySignal && <span className="text-red-800">Пункт 9 больше 0</span>}
                {row.adverseEventsSinceReview > 0 && (
                  <span className="text-amber-800">Новые НЯ: {row.adverseEventsSinceReview}</span>
                )}
              </td>
              <td className="py-3">
                {row.reviewed ? (
                  <span className="text-slate-500">Просмотрено</span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                    Новое
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
