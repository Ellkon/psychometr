import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreatedSchema,
  DIAGNOSIS_TEXT_MAX,
  Icd10SearchResultSchema,
  PatientDiagnosesSchema,
  SuccessSchema,
  parseDiagnosisEntry,
  type Diagnosis,
} from '@psychometr/shared';
import { formatDate } from '../lib/dates.js';
import { sessionClient, useSession } from '../lib/session.js';
import { AsyncForm, Button, ErrorNotice } from './forms.js';
import { Card, CardContent, CardHeader } from './ui/card.js';

const SEARCH_DELAY_MS = 250;

const fieldClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-teal-700';

/**
 * Diagnoses in the patient's card (FR-7.4). The doctor types a diagnosis or picks an ICD-10
 * entry; the code is optional. A diagnosis is not edited: it is removed and recorded anew.
 */
export function DiagnosesPanel({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const diagnoses = useQuery({
    queryKey: ['diagnoses', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/diagnoses`, PatientDiagnosesSchema, {
        signal,
      }),
    enabled: user?.role === 'doctor',
  });
  if (user?.role !== 'doctor') return null;
  const current = diagnoses.data?.diagnoses.filter((row) => row.removedAt === null) ?? [];
  const removed = diagnoses.data?.diagnoses.filter((row) => row.removedAt !== null) ?? [];
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Диагноз</h2>
        <p className="text-sm text-slate-600">
          Диагноз устанавливает врач. Пациент его в приложении не видит.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        {diagnoses.isPending && <p role="status">Загружаем…</p>}
        <ErrorNotice message={diagnoses.error?.message ?? null} />
        {diagnoses.data &&
          (current.length === 0 ? (
            <p className="text-sm text-slate-600">Диагноз не записан.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {current.map((row) => (
                <CurrentDiagnosis key={row.id} patientId={patientId} diagnosis={row} />
              ))}
            </ul>
          ))}
        <DiagnosisForm patientId={patientId} />
        {removed.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">
              Снятые диагнозы ({removed.length})
            </summary>
            <ul className="mt-2 grid gap-1 text-slate-500">
              {removed.map((row) => (
                <li key={row.id}>
                  <span className="line-through">{label(row)}</span> · с {formatDate(row.createdAt)}{' '}
                  по {formatDate(row.removedAt ?? row.createdAt)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function label(row: Diagnosis): string {
  return row.code && row.code !== row.text ? `${row.code} ${row.text}` : row.text;
}

function CurrentDiagnosis({ patientId, diagnosis }: { patientId: string; diagnosis: Diagnosis }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <li className="grid gap-2 border-b border-slate-100 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {diagnosis.code && <span className="font-mono font-semibold">{diagnosis.code} </span>}
          {diagnosis.text !== diagnosis.code && diagnosis.text}
          <span className="block text-xs text-slate-500">
            Записан {formatDate(diagnosis.createdAt)}
          </span>
        </span>
        <Button
          className="bg-slate-600 hover:bg-slate-700"
          disabled={busy}
          aria-label={`Снять диагноз ${label(diagnosis)}`}
          onClick={() => {
            if (!window.confirm(`Снять диагноз «${label(diagnosis)}»?`)) return;
            setBusy(true);
            setError(null);
            void sessionClient
              .request(
                `/api/patients/${patientId}/diagnoses/${diagnosis.id}/remove`,
                SuccessSchema,
                { method: 'POST', body: {} },
              )
              .then(() => queryClient.invalidateQueries({ queryKey: ['diagnoses'] }))
              .catch((problem: unknown) => {
                setError(problem instanceof Error ? problem.message : 'Не удалось снять диагноз');
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {busy ? 'Подождите…' : 'Снять'}
        </Button>
      </div>
      <ErrorNotice message={error} />
    </li>
  );
}

function DiagnosisForm({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [entry, setEntry] = useState('');
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const parsed = parseDiagnosisEntry(entry);
  // A picked suggestion ("F41.1 Генерализованное…") is looked up by its code alone.
  const query = (parsed.code ?? entry.trim()).slice(0, 100);
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);
  const icd10 = useQuery({
    queryKey: ['icd10', debounced],
    queryFn: ({ signal }) =>
      sessionClient.request(
        `/api/icd10?q=${encodeURIComponent(debounced)}`,
        Icd10SearchResultSchema,
        { signal },
      ),
    enabled: debounced.length >= 2,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const known = icd10.data?.entries.find((item) => item.code === parsed.code);
  return (
    <section aria-label="Добавить диагноз" className="grid gap-3 rounded-md bg-slate-50 p-4">
      <AsyncForm
        submitLabel="Записать диагноз"
        action={async () => {
          // A bare code from the catalog gets its name; free text is stored as typed.
          const text = parsed.text === parsed.code && known ? known.name : parsed.text;
          await sessionClient.request(`/api/patients/${patientId}/diagnoses`, CreatedSchema, {
            method: 'POST',
            body: { submissionId, code: parsed.code, text },
          });
          setEntry('');
          setSubmissionId(crypto.randomUUID());
          await queryClient.invalidateQueries({ queryKey: ['diagnoses'] });
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          <span>Диагноз: код или название по МКБ-10, либо своя формулировка</span>
          <input
            name="diagnosis"
            list={`icd10-${patientId}`}
            required
            maxLength={DIAGNOSIS_TEXT_MAX + 10}
            value={entry}
            onChange={(event) => {
              setEntry(event.target.value);
            }}
            placeholder="Например, F41.1 или «генерализ тревож»"
            className={fieldClass}
            autoComplete="off"
          />
          <datalist id={`icd10-${patientId}`}>
            {icd10.data?.entries.map((item) => (
              <option key={item.code} value={`${item.code} ${item.name}`} />
            ))}
          </datalist>
          <span className="text-xs font-normal text-slate-500">
            {parsed.code
              ? known
                ? `МКБ-10: ${known.code} ${known.name}`
                : icd10.isFetching || debounced !== query
                  ? 'Ищем код в МКБ-10…'
                  : `Кода ${parsed.code} нет в МКБ-10`
              : icd10.error
                ? 'Поиск по МКБ-10 недоступен; диагноз можно записать текстом'
                : 'Без кода МКБ-10 диагноз запишется свободным текстом'}
          </span>
        </label>
      </AsyncForm>
    </section>
  );
}
