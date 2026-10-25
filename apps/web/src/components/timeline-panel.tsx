import { useQuery } from '@tanstack/react-query';
import {
  TimelineSchema,
  contactChannelLabel,
  contactReasonLabel,
  contactTimeLabel,
  type TimelineEvent,
} from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { doseStatusLabel, severityLabel } from '../lib/therapy.js';
import { ErrorNotice } from './forms.js';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { formatDateTime } from '../lib/dates.js';

const scaleTitle: Record<string, string> = { phq9: 'PHQ-9', gad7: 'GAD-7' };
const alertTitle = {
  rule: 'Алерт врачу',
  adverse_event: 'Уведомление о НЯ',
  contact_request: 'Уведомление: просьба связаться',
} as const;
const alertStatusLabel = {
  pending: 'ожидает отправки',
  sent: 'отправлен',
  delivered: 'доставлен',
  acknowledged: 'подтверждён',
} as const;

function describe(event: TimelineEvent): { title: string; detail: string; accent: boolean } {
  switch (event.kind) {
    case 'score':
      return {
        title: `${scaleTitle[event.scaleId] ?? event.scaleId}: ${String(event.score)} из ${String(event.maxScore)}`,
        detail: `${event.bandLabel}${event.safetySignal ? ' · пункт 9 больше 0' : ''}`,
        accent: event.safetySignal,
      };
    case 'medication_started':
      return { title: 'Назначение', detail: `${event.drugText}, ${event.doseText}`, accent: false };
    case 'medication_stopped':
      return {
        title: 'Назначение остановлено',
        detail: `${event.drugText}, ${event.doseText}`,
        accent: false,
      };
    case 'dose':
      return {
        title: `Доза: ${doseStatusLabel[event.status].toLowerCase()}`,
        detail: `${event.drugText} · по плану ${formatDateTime(event.scheduledFor)}`,
        accent: false,
      };
    case 'adverse_event':
      return {
        title: `Нежелательное явление (${severityLabel[event.severity].toLowerCase()})`,
        detail: event.description,
        accent: event.severity === 'severe',
      };
    case 'rule':
      return {
        title: 'Срабатывание правила',
        detail: event.message,
        accent: event.severity === 'critical',
      };
    case 'contact_request':
      return {
        title: 'Просьба связаться',
        detail: `${contactReasonLabel[event.reason]} · ${contactTimeLabel[event.preferredTime].toLowerCase()}${event.resolvedAt ? ` · закрыта ${formatDateTime(event.resolvedAt)}` : ' · ждёт контакта'}`,
        accent: event.resolvedAt === null,
      };
    case 'contact':
      return {
        title: `Контакт: ${contactChannelLabel[event.channel].toLowerCase()}`,
        detail: event.note,
        accent: false,
      };
    case 'alert':
      return {
        title: `${alertTitle[event.source]}${event.escalation ? ' (резервному врачу)' : ''}: ${alertStatusLabel[event.status]}`,
        detail: `${event.message}${event.acknowledgedAt ? ` · подтверждён ${formatDateTime(event.acknowledgedAt)}` : ''}`,
        accent: event.source === 'rule' && event.status !== 'acknowledged',
      };
  }
}

export function TimelinePanel({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const timeline = useQuery({
    queryKey: ['timeline', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/timeline`, TimelineSchema, { signal }),
    enabled: user?.role === 'doctor',
  });
  if (user?.role !== 'doctor') return null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Таймлайн</h2>
        <p className="text-sm text-slate-600">
          Баллы шкал, назначения, отметки доз, нежелательные явления, контакты, срабатывания правил
          и алерты — от новых к старым.
        </p>
      </CardHeader>
      <CardContent>
        {timeline.isPending ? (
          <p role="status">Загружаем таймлайн…</p>
        ) : timeline.error ? (
          <ErrorNotice message={timeline.error.message} />
        ) : timeline.data.events.length === 0 ? (
          <p className="text-sm text-slate-500">Событий пока нет.</p>
        ) : (
          <ol className="grid max-h-[32rem] gap-2 overflow-y-auto text-sm">
            {timeline.data.events.map((event, index) => {
              const { title, detail, accent } = describe(event);
              return (
                <li
                  key={`${event.at}-${String(index)}`}
                  className={`grid gap-0.5 rounded-md border p-3 ${accent ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}
                >
                  <span className="text-xs text-slate-500">{formatDateTime(event.at)}</span>
                  <span className="font-medium">{title}</span>
                  <span className="whitespace-pre-wrap text-slate-700">{detail}</span>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
