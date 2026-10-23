import { useState, type SyntheticEvent } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { IdSchema, ScaleResultSchema, type ScaleResult } from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { useScaleCatalog } from '../lib/use-scale-catalog.js';
import { answersComplete, buildSubmission } from '../lib/scales.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';
import { Button, ErrorNotice } from '../components/forms.js';
import { EmergencyInstruction } from '../components/emergency-instruction.js';

export function ScaleFormPage() {
  const params = useParams({ strict: false }),
    { user, ready } = useSession(),
    queryClient = useQueryClient();
  const patientId = IdSchema.safeParse(params.patientId);
  const scaleId = typeof params.scaleId === 'string' ? params.scaleId : '';
  const catalog = useScaleCatalog();
  const [answers, setAnswers] = useState<Record<string, number | undefined>>({}),
    [functional, setFunctional] = useState<number | undefined>(undefined),
    [result, setResult] = useState<ScaleResult | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    // One id per form fill: a retry after a network error cannot store the answers twice.
    [submissionId] = useState(() => crypto.randomUUID());
  if (!ready) return <p role="status">Проверяем сессию…</p>;
  if (!user) return <ErrorNotice message="Для заполнения шкалы войдите в приложение." />;
  if (user.role !== 'patient')
    return <ErrorNotice message="Шкалы заполняет пациент. Врач видит результаты в карточке." />;
  if (!patientId.success) return <ErrorNotice message="Некорректный идентификатор пациента." />;
  if (catalog.isPending) return <p role="status">Загружаем шкалу…</p>;
  if (catalog.error) return <ErrorNotice message={catalog.error.message} />;
  const scale = catalog.data.scales.find((candidate) => candidate.id === scaleId);
  if (!scale) return <ErrorNotice message="Шкала не найдена." />;
  const complete = answersComplete(scale, answers);
  const setAnswer = (id: string, value: number) => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = buildSubmission(scale, answers, functional, submissionId);
      const saved = await sessionClient.request(
        `/api/patients/${patientId.data}/scales/${scale.id}/responses`,
        ScaleResultSchema,
        { method: 'POST', body },
      );
      setResult(saved);
      await queryClient.invalidateQueries({ queryKey: ['scales'] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Не удалось сохранить ответы');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
            {scale.title}
          </p>
          <h1 className="text-2xl font-semibold">Ответы сохранены</h1>
          <p className="text-sm text-slate-600">Ответ доступен вашему врачу в карточке.</p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-lg">
            Сумма баллов: <strong>{result.score}</strong> из {result.maxScore}
          </p>
          <p>Степень: {result.bandLabel}</p>
          <p className="text-sm text-slate-600">{scale.interpretationNote}</p>
          {result.safetySignal && <EmergencyInstruction emphasis />}
          <p className="text-xs text-slate-500">Источник шкалы: {scale.validationCitation}</p>
          <Link
            className="text-sm font-medium text-teal-800 underline"
            to="/patients/$patientId"
            params={{ patientId: patientId.data }}
          >
            Вернуться к карточке
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
          {scale.title}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Ответьте на вопросы</h1>
        <p className="mt-2 text-sm text-slate-700">{scale.stem}</p>
      </div>
      <form onSubmit={(event) => void submit(event)} className="grid gap-6">
        <fieldset disabled={busy} className="grid gap-6">
          {scale.items.map((item, index) => (
            <fieldset
              key={item.id}
              className="grid gap-3 rounded-md border border-slate-200 bg-white p-4"
            >
              <legend className="px-1 text-sm font-medium text-slate-900">
                {index + 1}. {item.text}
              </legend>
              <div className="grid gap-2 sm:grid-cols-4">
                {scale.answerOptions.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm has-[:checked]:border-teal-800 has-[:checked]:bg-teal-50"
                  >
                    <input
                      type="radio"
                      name={item.id}
                      value={option.value}
                      checked={answers[item.id] === option.value}
                      onChange={() => {
                        setAnswer(item.id, option.value);
                      }}
                      className="h-4 w-4 accent-teal-800"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {scale.functionalItem && (
            <fieldset className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
              <legend className="px-1 text-sm font-medium text-slate-900">
                Дополнительный вопрос (необязательный, в сумму баллов не входит)
              </legend>
              <p className="text-sm text-slate-800">{scale.functionalItem.text}</p>
              <div className="grid gap-2 sm:grid-cols-4">
                {scale.functionalItem.options.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm has-[:checked]:border-teal-800 has-[:checked]:bg-teal-50"
                  >
                    <input
                      type="radio"
                      name={scale.functionalItem?.id ?? 'functional'}
                      value={option.value}
                      checked={functional === option.value}
                      onChange={() => {
                        setFunctional(option.value);
                      }}
                      className="h-4 w-4 accent-teal-800"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <ErrorNotice message={error} />
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={!complete || busy}>
              {busy ? 'Сохраняем…' : 'Отправить ответы'}
            </Button>
            {!complete && (
              <p className="text-sm text-slate-600">Ответьте на все вопросы, чтобы отправить.</p>
            )}
          </div>
        </fieldset>
      </form>
    </div>
  );
}
