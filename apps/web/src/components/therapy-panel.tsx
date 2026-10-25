import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreatedSchema,
  DrugCatalogSchema,
  PatientTherapySchema,
  SuccessSchema,
  type AdverseEvent,
  type Medication,
  type PatientTherapy,
} from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import {
  adherenceLabel,
  doseStatusLabel,
  drugOptions,
  markableSlots,
  parseDoseTimes,
  severityLabel,
} from '../lib/therapy.js';
import {
  classifySendError,
  enqueueDoseMark,
  flushOutbox,
  indexedOutbox,
  type DoseOutboxItem,
} from '../lib/outbox.js';
import { AsyncForm, Button, ErrorNotice, Field, text } from './forms.js';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { formatDate } from '../lib/dates.js';

const slotFormat = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const today = () => new Date().toLocaleDateString('sv-SE');
const fieldClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-teal-700';

export function useTherapy(patientId: string) {
  const { user } = useSession();
  return useQuery({
    queryKey: ['therapy', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/therapy`, PatientTherapySchema, {
        signal,
      }),
    enabled: Boolean(user),
  });
}

export function TherapyPanel({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const therapy = useTherapy(patientId);
  if (!user || (user.role !== 'doctor' && user.role !== 'patient')) return null;
  if (therapy.isPending) return <p role="status">Загружаем терапию…</p>;
  if (therapy.error) return <ErrorNotice message={therapy.error.message} />;
  return user.role === 'doctor' ? (
    <DoctorTherapy patientId={patientId} data={therapy.data} />
  ) : (
    <PatientTherapyView patientId={patientId} data={therapy.data} />
  );
}

function DoctorTherapy({ patientId, data }: { patientId: string; data: PatientTherapy }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Терапия и дневник доз</h2>
        <p className="text-sm text-slate-600">
          Здесь фиксируется назначение, которое вы уже сделали. Система не подбирает препарат и
          дозу. Доля доз — самоотчёт пациента.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        {data.medications.length === 0 ? (
          <p className="text-sm text-slate-500">Назначений пока нет.</p>
        ) : (
          <ul className="grid gap-3">
            {data.medications.map((medication) => (
              <MedicationItem key={medication.id} patientId={patientId} medication={medication} />
            ))}
          </ul>
        )}
        <PrescriptionForm patientId={patientId} />
        <AdverseEventList events={data.adverseEvents} medications={data.medications} />
      </CardContent>
    </Card>
  );
}

function MedicationItem({ patientId, medication }: { patientId: string; medication: Medication }) {
  const queryClient = useQueryClient();
  return (
    <li className="grid gap-2 rounded-md border border-slate-200 p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {medication.drugText}, {medication.doseText}
        </p>
        <span className="text-xs text-slate-500">
          {medication.status === 'active' ? 'Действует' : 'Остановлено'} · с{' '}
          {formatDate(medication.startsOn)}
          {medication.endsOn ? ` по ${formatDate(medication.endsOn)}` : ''}
        </span>
      </div>
      <p className="text-slate-600">
        Время приёма: {medication.doseTimes.join(', ')} ({medication.timeZone})
        {medication.grlsRegNumber ? ` · ГРЛС ${medication.grlsRegNumber}` : ''}
      </p>
      <p>{adherenceLabel(medication)}</p>
      {medication.missedInRow > 0 && (
        <p className="text-amber-800">Не отмечено как принятые подряд: {medication.missedInRow}</p>
      )}
      {medication.status === 'active' && (
        <AsyncForm
          submitLabel="Остановить назначение"
          action={async () => {
            await sessionClient.request(
              `/api/patients/${patientId}/medications/${medication.id}/stop`,
              SuccessSchema,
              { method: 'POST', body: {} },
            );
            await queryClient.invalidateQueries({ queryKey: ['therapy'] });
          }}
        >
          <label className="flex gap-2 text-sm">
            <input type="checkbox" required className="h-4 w-4 accent-teal-800" />
            Подтверждаю остановку. Изменение схемы оформляется новым назначением.
          </label>
        </AsyncForm>
      )}
    </li>
  );
}

function PrescriptionForm({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const drugs = useQuery({
    queryKey: ['drugs'],
    queryFn: ({ signal }) => sessionClient.request('/api/drugs', DrugCatalogSchema, { signal }),
    staleTime: Infinity,
  });
  const options = drugs.data ? drugOptions(drugs.data) : [];
  const [drug, setDrug] = useState('');
  const [dose, setDose] = useState('');
  const selected = options.find((option) => option.label === drug);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section aria-label="Новое назначение" className="grid gap-3 rounded-md bg-slate-50 p-4">
      <h3 className="font-medium">Новое назначение</h3>
      <AsyncForm
        submitLabel="Записать назначение"
        action={async (data) => {
          const endsOn = text(data, 'endsOn');
          await sessionClient.request(`/api/patients/${patientId}/medications`, CreatedSchema, {
            method: 'POST',
            body: {
              grlsRegNumber: selected?.regNumber ?? null,
              drugText: drug.trim(),
              doseText: dose.trim(),
              doseTimes: parseDoseTimes(text(data, 'doseTimes')),
              timeZone,
              startsOn: text(data, 'startsOn'),
              endsOn: endsOn === '' ? null : endsOn,
            },
          });
          setDrug('');
          setDose('');
          await queryClient.invalidateQueries({ queryKey: ['therapy'] });
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          <span>Препарат: выберите из списка ГРЛС или введите текстом</span>
          <input
            name="drug"
            list={`drugs-${patientId}`}
            required
            maxLength={300}
            value={drug}
            onClick={(event) => {
              // Open the list on click, with the featured product (АВИАНДР®) on top.
              try {
                event.currentTarget.showPicker();
              } catch {
                // Older browsers: the list opens on typing or the down arrow.
              }
            }}
            onChange={(event) => {
              setDrug(event.target.value);
              // Picking a product form fills its strength; the doctor can change it.
              const picked = options.find((option) => option.label === event.target.value);
              if (picked?.strength) setDose(picked.strength);
            }}
            className={fieldClass}
            autoComplete="off"
          />
          <datalist id={`drugs-${patientId}`}>
            {options.map((option) => (
              <option key={option.label} value={option.label} />
            ))}
          </datalist>
          <span className="text-xs font-normal text-slate-500">
            {selected
              ? `Из ГРЛС, рег. № ${selected.regNumber}`
              : drugs.data
                ? `Справочник ГРЛС от ${formatDate(drugs.data.exportDate)}; без выбора — свободный текст`
                : 'Справочник ГРЛС загружается…'}
          </span>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          <span>Доза на приём</span>
          <input
            name="doseText"
            required
            maxLength={100}
            value={dose}
            onChange={(event) => {
              setDose(event.target.value);
            }}
            className={fieldClass}
            autoComplete="off"
          />
          {selected?.strength && (
            <span className="text-xs font-normal text-slate-500">
              Подставлена дозировка формы выпуска. Проверьте дозу на приём.
            </span>
          )}
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Время приёма (ЧЧ:ММ через запятую)"
            name="doseTimes"
            required
            defaultValue="08:00"
            maxLength={60}
          />
          <Field label="Начало" name="startsOn" type="date" required defaultValue={today()} />
          <Field label="Окончание (если известно)" name="endsOn" type="date" />
        </div>
        <p className="text-xs text-slate-500">Часовой пояс: {timeZone}</p>
      </AsyncForm>
    </section>
  );
}

function AdverseEventList({
  events,
  medications,
}: {
  events: readonly AdverseEvent[];
  medications: readonly Medication[];
}) {
  const drugName = new Map(medications.map((medication) => [medication.id, medication.drugText]));
  return (
    <section aria-label="Нежелательные явления" className="grid gap-2">
      <h3 className="font-medium">Нежелательные явления со слов пациента</h3>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">Пациент не сообщал о нежелательных явлениях.</p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-slate-200 p-3">
              <p className="font-medium">
                {severityLabel[event.severity]} · с {formatDate(event.startedOn)}
                {event.medicationRequestId
                  ? ` · ${drugName.get(event.medicationRequestId) ?? 'назначение'}`
                  : ''}
              </p>
              <p className="whitespace-pre-wrap text-slate-700">{event.description}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type DoseStatus = 'taken' | 'skipped';

/**
 * Dose marks go through the device outbox (FR-9): written to IndexedDB first, then sent. A mark
 * survives a dropped connection and is resent when the browser is back online; the server keeps
 * one mark per slot, so a resend never stores a duplicate.
 */
function useDoseOutbox(patientId: string) {
  const { user } = useSession();
  const ownerId = user?.id ?? '';
  const queryClient = useQueryClient();
  const [queued, setQueued] = useState<DoseOutboxItem[]>([]);
  const [refused, setRefused] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // One flush at a time: an `online` event during a send must not send the same mark twice.
  const flushing = useRef<Promise<void> | null>(null);

  const reload = useCallback(async () => {
    setQueued((await indexedOutbox.list()).filter((item) => item.ownerId === ownerId));
  }, [ownerId]);
  const flush = useCallback((): Promise<void> => {
    flushing.current ??= (async () => {
      try {
        const report = await flushOutbox(indexedOutbox, ownerId, async (item) => {
          try {
            await sessionClient.request(
              `/api/patients/${item.patientId}/medications/${item.medicationId}/doses`,
              SuccessSchema,
              { method: 'POST', body: { scheduledFor: item.scheduledFor, status: item.status } },
            );
            return 'sent';
          } catch (caught) {
            return classifySendError(caught);
          }
        });
        if (report.rejected.length > 0) setRefused((count) => count + report.rejected.length);
        if (report.sent > 0 || report.rejected.length > 0)
          await queryClient.invalidateQueries({ queryKey: ['therapy'] });
        await reload();
      } finally {
        flushing.current = null;
      }
    })();
    return flushing.current;
  }, [ownerId, queryClient, reload]);

  useEffect(() => {
    flush().catch(() => {
      setError('Не удалось прочитать очередь на этом устройстве');
    });
    const onOnline = () => {
      void flush().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
    };
  }, [flush]);

  const mark = async (medicationId: string, scheduledFor: string, status: DoseStatus) => {
    setError(null);
    try {
      await enqueueDoseMark(indexedOutbox, {
        ownerId,
        patientId,
        medicationId,
        scheduledFor,
        status,
      });
    } catch {
      setError('Не удалось сохранить отметку на этом устройстве');
      return;
    }
    await reload();
    await flush().catch(() => undefined);
  };
  return { queued, refused, error, mark };
}

function PatientTherapyView({ patientId, data }: { patientId: string; data: PatientTherapy }) {
  const active = data.medications.filter((medication) => medication.status === 'active');
  const outbox = useDoseOutbox(patientId);
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Приём препаратов</h2>
        <p className="text-sm text-slate-600">
          Отметьте каждую дозу: «Принял(а)» или «Пропустил(а)». Отметка доступна за час до приёма и
          в течение двух суток после.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        {active.length === 0 ? (
          <p className="text-sm text-slate-500">Врач пока не внёс назначений.</p>
        ) : (
          <ul className="grid gap-4">
            {active.map((medication) => (
              <DoseItem
                key={medication.id}
                medication={medication}
                queued={outbox.queued}
                onMark={outbox.mark}
              />
            ))}
          </ul>
        )}
        {outbox.queued.length > 0 && (
          <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-950">
            Не отправлено: {String(outbox.queued.length)}. Отметки сохранены на этом устройстве и
            отправятся, когда появится связь.
          </p>
        )}
        {outbox.refused > 0 && (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          >
            Сервер не принял отметок: {String(outbox.refused)}. Время отметки прошло или доза уже
            отмечена иначе.
          </p>
        )}
        <ErrorNotice message={outbox.error} />
        <AdverseEventForm patientId={patientId} medications={active} />
      </CardContent>
    </Card>
  );
}

function DoseItem({
  medication,
  queued,
  onMark,
}: {
  medication: Medication;
  queued: readonly DoseOutboxItem[];
  onMark: (medicationId: string, scheduledFor: string, status: DoseStatus) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const markable = new Set(markableSlots(medication.slots, now).map((slot) => slot.scheduledFor));
  const waiting = new Map(
    queued
      .filter((item) => item.medicationId === medication.id)
      .map((item) => [item.scheduledFor, item.status]),
  );
  const mark = async (scheduledFor: string, status: DoseStatus) => {
    setBusy(true);
    try {
      await onMark(medication.id, scheduledFor, status);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="grid gap-3 rounded-md border border-slate-200 p-4">
      <p className="font-medium">
        {medication.drugText}, {medication.doseText}
      </p>
      <ul className="grid gap-2 text-sm">
        {medication.slots.map((slot) => (
          <li key={slot.scheduledFor} className="flex flex-wrap items-center justify-between gap-2">
            <span>{slotFormat.format(new Date(slot.scheduledFor))}</span>
            {slot.status ? (
              <span className={slot.status === 'taken' ? 'text-teal-800' : 'text-slate-500'}>
                {doseStatusLabel[slot.status]}
              </span>
            ) : waiting.has(slot.scheduledFor) ? (
              <span className="text-amber-800">
                {doseStatusLabel[waiting.get(slot.scheduledFor) ?? 'taken']}: ждёт связи
              </span>
            ) : markable.has(slot.scheduledFor) ? (
              <span className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() => {
                    void mark(slot.scheduledFor, 'taken');
                  }}
                >
                  Принял(а)
                </Button>
                <Button
                  disabled={busy}
                  className="bg-slate-600 hover:bg-slate-700"
                  onClick={() => {
                    void mark(slot.scheduledFor, 'skipped');
                  }}
                >
                  Пропустил(а)
                </Button>
              </span>
            ) : (
              <span className="text-slate-400">
                {Date.parse(slot.scheduledFor) > now ? 'Позже' : 'Не отмечено'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

function AdverseEventForm({
  patientId,
  medications,
}: {
  patientId: string;
  medications: readonly Medication[];
}) {
  const queryClient = useQueryClient();
  // One id per form fill: a retry after a network error cannot store the report twice.
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [sent, setSent] = useState(false);
  return (
    <section aria-label="Сообщить о нежелательном явлении" className="grid gap-3">
      <h3 className="font-medium">Сообщить врачу о нежелательном явлении</h3>
      <p className="text-sm text-slate-600">
        Опишите своими словами, что беспокоит. Врач увидит запись в карточке. Если состояние
        тяжёлое, не ждите ответа врача: телефоны экстренной помощи — в разделе «Если вам сейчас
        тяжело».
      </p>
      <AsyncForm
        submitLabel="Отправить врачу"
        action={async (data) => {
          const medication = text(data, 'medicationRequestId');
          await sessionClient.request(`/api/patients/${patientId}/adverse-events`, CreatedSchema, {
            method: 'POST',
            body: {
              submissionId,
              description: text(data, 'description').trim(),
              severity: text(data, 'severity'),
              startedOn: text(data, 'startedOn'),
              medicationRequestId: medication === '' ? null : medication,
            },
          });
          setSubmissionId(crypto.randomUUID());
          setSent(true);
          await queryClient.invalidateQueries({ queryKey: ['therapy'] });
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          <span>Что происходит</span>
          <textarea
            name="description"
            required
            maxLength={1000}
            rows={3}
            className={fieldClass}
            onChange={() => {
              setSent(false);
            }}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span>Насколько сильно</span>
            <select name="severity" required defaultValue="mild" className={fieldClass}>
              {Object.entries(severityLabel).map(([severity, label]) => (
                <option key={severity} value={severity}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="С какого дня"
            name="startedOn"
            type="date"
            required
            max={today()}
            defaultValue={today()}
          />
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span>Связано с препаратом</span>
            <select name="medicationRequestId" defaultValue="" className={fieldClass}>
              <option value="">Не знаю</option>
              {medications.map((medication) => (
                <option key={medication.id} value={medication.id}>
                  {medication.drugText}
                </option>
              ))}
            </select>
          </label>
        </div>
      </AsyncForm>
      {sent && (
        <p role="status" className="text-sm text-teal-800">
          Сообщение отправлено врачу.
        </p>
      )}
    </section>
  );
}
