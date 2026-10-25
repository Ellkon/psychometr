import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PatientScalesSchema,
  SuccessSchema,
  type PatientScales,
  type ScaleDefinition,
} from '@psychometr/shared';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { sessionClient, useSession } from '../lib/session.js';
import { useScaleCatalog } from '../lib/use-scale-catalog.js';
import { DEFAULT_SCHEDULE, chartPoints, scheduleStatusLabel } from '../lib/scales.js';
import { AsyncForm, ErrorNotice, Field, text } from './forms.js';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { EmergencyInstruction } from './emergency-instruction.js';
import { formatDate, formatDateTime } from '../lib/dates.js';

type Schedule = PatientScales['schedules'][number];
type HistoryRow = PatientScales['history'][number];

export function ScalesPanel({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const scales = useQuery({
    queryKey: ['scales', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/scales`, PatientScalesSchema, { signal }),
    enabled: Boolean(user),
  });
  if (!user) return null;
  if (scales.isPending) return <p role="status">Загружаем шкалы…</p>;
  if (scales.error) return <ErrorNotice message={scales.error.message} />;
  const data = scales.data;
  if (user.role === 'patient') {
    return <PatientScalesView patientId={patientId} data={data} />;
  }
  if (user.role === 'doctor') {
    return <DoctorScalesView patientId={patientId} data={data} />;
  }
  return null;
}

function PatientScalesView({ patientId, data }: { patientId: string; data: PatientScales }) {
  const catalog = useScaleCatalog();
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Шкалы</h2>
          <p className="text-sm text-slate-600">
            Опросники, которые назначил ваш врач. Ответы видны вашему врачу.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3">
          {data.schedules.length === 0 && (
            <p className="text-sm text-slate-600">Врач пока не назначил шкалы.</p>
          )}
          {data.schedules.map((schedule) => (
            <div
              key={schedule.scaleId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3"
            >
              <div className="grid gap-1 text-sm">
                <p className="font-medium text-slate-900">{schedule.title}</p>
                <p className="text-slate-600">
                  {scheduleStatusLabel[schedule.status]} · срок до {formatDate(schedule.dueAt)}
                </p>
              </div>
              {schedule.active ? (
                <Link
                  className="inline-flex min-h-10 items-center rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white hover:bg-teal-900"
                  to="/patients/$patientId/scales/$scaleId"
                  params={{ patientId, scaleId: schedule.scaleId }}
                >
                  Заполнить
                </Link>
              ) : (
                <span className="text-sm text-slate-500">Приостановлено врачом</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Что означают шкалы</h2>
        </CardHeader>
        <CardContent className="grid gap-3">
          {catalog.isPending && <p role="status">Загружаем пояснения…</p>}
          {catalog.error && <ErrorNotice message={catalog.error.message} />}
          {catalog.data?.scales.map((scale) => (
            <details key={scale.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium text-slate-900">{scale.title}</summary>
              <div className="mt-3 grid gap-2 text-slate-700">
                <p>{scale.interpretationNote}</p>
                <ul className="list-disc pl-5">
                  {scale.cutoffs.map((band) => (
                    <li key={band.min}>
                      {band.min}–{band.max} баллов: {band.label}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-slate-500">Источник: {scale.validationCitation}</p>
              </div>
            </details>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Мои результаты</h2>
        </CardHeader>
        <CardContent>
          <HistoryTable rows={data.history} showSafety={false} />
        </CardContent>
      </Card>
      <section aria-label="Экстренная помощь" className="grid gap-2">
        <h2 className="text-lg font-semibold">Если вам сейчас тяжело</h2>
        <EmergencyInstruction />
      </section>
    </div>
  );
}

function DoctorScalesView({ patientId, data }: { patientId: string; data: PatientScales }) {
  const catalog = useScaleCatalog();
  if (catalog.isPending) return <p role="status">Загружаем каталог шкал…</p>;
  if (catalog.error) return <ErrorNotice message={catalog.error.message} />;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Шкалы: расписание</h2>
          <p className="text-sm text-slate-600">
            Пациент может заполнять назначенную шкалу в течение окна; пропущенные сроки отмечаются
            как просроченные.
          </p>
        </CardHeader>
        <CardContent className="grid gap-6">
          <ScheduleList schedules={data.schedules} />
          {catalog.data.scales.map((scale) => (
            <ScheduleForm
              key={scale.id}
              patientId={patientId}
              scale={scale}
              current={data.schedules.find((schedule) => schedule.scaleId === scale.id) ?? null}
            />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">История баллов</h2>
          <p className="text-sm text-slate-600">
            Пункты ответов не выводятся, только сумма, степень и отметка пункта 9.
          </p>
        </CardHeader>
        <CardContent className="grid gap-6">
          {catalog.data.scales.map((scale) => {
            const rows = data.history.filter((row) => row.scaleId === scale.id);
            if (rows.length === 0) return null;
            return <ScaleHistory key={scale.id} scale={scale} rows={rows} />;
          })}
          {data.history.length === 0 && (
            <p className="text-sm text-slate-600">Пациент ещё не отвечал на шкалы.</p>
          )}
          <HistoryTable rows={data.history} showSafety />
        </CardContent>
      </Card>
    </div>
  );
}

function ScheduleList({ schedules }: { schedules: Schedule[] }) {
  if (schedules.length === 0) {
    return <p className="text-sm text-slate-600">Расписание ещё не назначено.</p>;
  }
  return (
    <ul className="grid gap-2">
      {schedules.map((schedule) => (
        <li
          key={schedule.scaleId}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm ${
            schedule.status === 'overdue' ? 'border-red-300 bg-red-50' : 'border-slate-200'
          }`}
        >
          <span className="font-medium">{schedule.title}</span>
          <span>
            {scheduleStatusLabel[schedule.status]} · срок {formatDate(schedule.dueAt)}
            {' · '}
            каждые {schedule.intervalDays} дн., окно {schedule.windowDays} дн.
          </span>
          <span className="text-slate-600">
            Последний ответ:{' '}
            {schedule.lastAnsweredAt ? formatDateTime(schedule.lastAnsweredAt) : 'не было'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ScheduleForm({
  patientId,
  scale,
  current,
}: {
  patientId: string;
  scale: ScaleDefinition;
  current: Schedule | null;
}) {
  const initial = current ?? DEFAULT_SCHEDULE;
  const queryClient = useQueryClient();
  return (
    <section
      aria-label={`Расписание: ${scale.title}`}
      className="grid gap-3 rounded-md border border-slate-200 p-4"
    >
      <h3 className="font-medium">{scale.title}</h3>
      <AsyncForm
        submitLabel="Сохранить расписание"
        action={async (data) => {
          await sessionClient.request(
            `/api/patients/${patientId}/scales/${scale.id}/schedule`,
            SuccessSchema,
            {
              method: 'PUT',
              body: {
                intervalDays: Number(text(data, 'intervalDays')),
                windowDays: Number(text(data, 'windowDays')),
                active: data.get('active') === 'on',
              },
            },
          );
          await queryClient.invalidateQueries({ queryKey: ['scales'] });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Интервал, дней"
            name="intervalDays"
            type="number"
            min={1}
            max={365}
            required
            inputMode="numeric"
            defaultValue={initial.intervalDays}
          />
          <Field
            label="Окно заполнения, дней"
            name="windowDays"
            type="number"
            min={1}
            max={90}
            required
            inputMode="numeric"
            defaultValue={initial.windowDays}
          />
          <label className="flex items-center gap-2 pt-7 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              name="active"
              defaultChecked={initial.active}
              className="h-4 w-4 accent-teal-800"
            />
            Назначение активно
          </label>
        </div>
      </AsyncForm>
    </section>
  );
}

function ScaleHistory({ scale, rows }: { scale: ScaleDefinition; rows: HistoryRow[] }) {
  const points = chartPoints(rows, scale.id);
  const bands = scale.cutoffs.filter((band) => band.min > 0);
  return (
    <section aria-label={`График: ${scale.title}`} className="grid gap-3">
      <h3 className="font-medium">
        {scale.title} (максимум {scale.maxScore})
      </h3>
      <div role="img" aria-label={`Динамика баллов: ${scale.title}`} className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis domain={[0, scale.maxScore]} allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            {bands.map((band) => (
              <ReferenceLine key={band.min} y={band.min} stroke="#94a3b8" strokeDasharray="4 4" />
            ))}
            <Line
              type="linear"
              dataKey="score"
              name="Баллы"
              stroke="#115e59"
              strokeWidth={2}
              dot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-slate-600">
        Пунктирные линии — нижние границы степеней:{' '}
        {bands.map((band) => `${String(band.min)} — ${band.label}`).join('; ')}.
      </p>
    </section>
  );
}

function HistoryTable({ rows, showSafety }: { rows: HistoryRow[]; showSafety: boolean }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-600">Результатов пока нет.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-slate-600">
            <th scope="col" className="py-2 pr-3 font-medium">
              Дата
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Шкала
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Баллы
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Степень
            </th>
            {showSafety && (
              <th scope="col" className="py-2 font-medium">
                Пункт 9
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...rows]
            .sort((a, b) => Date.parse(b.answeredAt) - Date.parse(a.answeredAt))
            .map((row) => (
              <tr key={row.responseId} className="border-b border-slate-200">
                <td className="py-2 pr-3">{formatDateTime(row.answeredAt)}</td>
                <td className="py-2 pr-3">{row.scaleTitle}</td>
                <td className="py-2 pr-3">
                  {row.score} из {row.maxScore}
                </td>
                <td className="py-2 pr-3">{row.bandLabel}</td>
                {showSafety && (
                  <td className="py-2">
                    {row.safetySignal ? (
                      <span className="font-medium text-red-800">больше 0</span>
                    ) : (
                      '0'
                    )}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
