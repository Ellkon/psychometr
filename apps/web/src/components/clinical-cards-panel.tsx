import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PatientCardsSchema,
  SuccessSchema,
  type ClinicalCard,
  type TaskDecisionInput,
} from '@psychometr/shared';
import { sessionClient } from '../lib/session.js';
import { FACT_LABEL, formatFact } from '../lib/cards.js';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { Button, ErrorNotice } from './forms.js';

const SEVERITY_LABEL: Record<ClinicalCard['severity'], string> = {
  info: 'Информация',
  warning: 'Требует внимания',
  critical: 'Критично',
};

const STATUS_LABEL: Record<ClinicalCard['status'], string> = {
  requested: 'Ожидает решения врача',
  accepted: 'Принято врачом',
  rejected: 'Отклонено врачом',
};

export function ClinicalCardsPanel({ patientId }: { patientId: string }) {
  const listing = useQuery({
    queryKey: ['cards', patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/cards`, PatientCardsSchema, { signal }),
  });
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Клинические карточки</h2>
        <p className="text-sm text-slate-600">
          Подсказки системы не назначают лечение. Решение принимает врач, оно фиксируется в журнале.
        </p>
      </CardHeader>
      <CardContent>
        <ErrorNotice message={listing.error?.message ?? null} />
        {listing.isPending && <p role="status">Загружаем карточки…</p>}
        {listing.data && (
          <div className="grid gap-5">
            <section
              aria-label="Маршрутизация"
              className="grid gap-2 rounded-md bg-slate-50 p-4 text-sm"
            >
              <h3 className="font-medium">Направление к специалисту</h3>
              {listing.data.routing.status === 'pending_clinical_agreement' ? (
                <p>
                  Правила направления ожидают клинического согласования порогов. Пока система не
                  формирует рекомендацию о направлении, решение принимает врач.
                </p>
              ) : (
                <p>Активных правил направления: {listing.data.routing.activeRules}.</p>
              )}
            </section>

            <section aria-label="Уточнить данные" className="grid gap-2 text-sm">
              <h3 className="font-medium">Данные, которых нет в системе</h3>
              <p className="text-slate-600">
                Эти сведения не хранятся и не считаются отсутствующими. Уточните их перед решением:
              </p>
              <ul className="list-inside list-disc">
                {listing.data.clarifications.map((item) => (
                  <li key={item.key}>{item.label}</li>
                ))}
              </ul>
            </section>

            {listing.data.cards.length === 0 && (
              <p className="text-sm text-slate-600">Срабатываний правил пока нет.</p>
            )}
            {listing.data.cards.map((card) => (
              <CardView key={card.taskId} card={card} patientId={patientId} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CardView({ card, patientId }: { card: ClinicalCard; patientId: string }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: TaskDecisionInput['decision']) => {
    const trimmed = comment.trim();
    if (decision === 'rejected' && trimmed === '') {
      setError('При отклонении укажите комментарий.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sessionClient.request(
        `/api/patients/${patientId}/tasks/${card.taskId}/decision`,
        SuccessSchema,
        {
          method: 'POST',
          body: decision === 'rejected' ? { decision, comment: trimmed } : { decision },
        },
      );
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['cards', patientId] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Не удалось сохранить решение');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      aria-label={`Карточка: ${card.message}`}
      className="grid gap-3 rounded-md border border-slate-200 p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{SEVERITY_LABEL[card.severity]}</span>
        <span className="text-slate-600">{STATUS_LABEL[card.status]}</span>
      </div>
      <p>{card.message}</p>
      <p>
        <span className="text-slate-500">Предлагаемое действие: </span>
        {card.suggestedAction}
      </p>
      <p className="text-xs text-slate-500">
        Источник: {card.sourceId}, {card.sourceLocation}. Версия правила {card.ruleVersion}.
        Срабатывание: {new Date(card.triggeredAt).toLocaleString('ru-RU')}.
      </p>
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        {Object.entries(card.facts).map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="text-slate-500">{FACT_LABEL.get(key) ?? key}:</dt>
            <dd>{formatFact(value)}</dd>
          </div>
        ))}
      </dl>
      {card.status === 'requested' ? (
        <div className="grid gap-3">
          <label className="grid gap-1">
            <span className="text-slate-700">Комментарий (обязателен при отклонении)</span>
            <textarea
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
              }}
              maxLength={1000}
              rows={2}
              disabled={busy}
              className="rounded-md border border-slate-300 p-2"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                void decide('accepted');
              }}
            >
              Принять
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                void decide('rejected');
              }}
            >
              Отклонить
            </Button>
          </div>
          <ErrorNotice message={error} />
        </div>
      ) : (
        card.comment && <p className="text-slate-700">Комментарий врача: {card.comment}</p>
      )}
    </article>
  );
}
