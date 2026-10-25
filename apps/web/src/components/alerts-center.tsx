import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertListSchema, SuccessSchema, type Alert } from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { openAlertSocket, type AlertSocketStatus } from '../lib/alerts-socket.js';
import { Button, ErrorNotice } from './forms.js';

const when = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Critical alerts for the doctor (FR-8). Live over the socket, with the REST list as the source of
 * truth on load and after every change. Only critical alerts exist, so they are always shown in full.
 */
export function AlertsCenter() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AlertSocketStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const doctorId = user?.role === 'doctor' ? user.id : undefined;
  const alerts = useQuery({
    queryKey: ['alerts', doctorId],
    queryFn: ({ signal }) => sessionClient.request('/api/alerts', AlertListSchema, { signal }),
    enabled: doctorId !== undefined,
  });

  useEffect(() => {
    if (doctorId === undefined) return;
    const key = ['alerts', doctorId];
    return openAlertSocket({
      // After a 4401 close the cached token may be expired or revoked: ask the server for a new one.
      getToken: (fresh) =>
        fresh
          ? sessionClient.refresh().then((response) => response.accessToken)
          : sessionClient.accessToken(),
      handlers: {
        onStatus: setStatus,
        onAlert: () => {
          void queryClient.invalidateQueries({ queryKey: key });
        },
      },
    });
  }, [doctorId, queryClient]);

  if (doctorId === undefined) return null;

  const acknowledge = async (alert: Alert) => {
    setError(null);
    try {
      await sessionClient.request(`/api/alerts/${alert.id}/ack`, SuccessSchema, {
        method: 'POST',
        body: {},
      });
      await queryClient.invalidateQueries({ queryKey: ['alerts', doctorId] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось подтвердить алерт');
    }
  };

  const open = alerts.data?.alerts ?? [];
  return (
    <section aria-label="Критичные алерты" className="mb-6 grid gap-3">
      <p role="status" className="text-xs text-slate-500">
        {status === 'online'
          ? 'Уведомления в реальном времени: на связи.'
          : status === 'connecting'
            ? 'Подключаем уведомления…'
            : 'Нет связи с уведомлениями, переподключаемся. Список ниже обновится при связи.'}
      </p>
      <ErrorNotice message={alerts.error?.message ?? error} />
      {open.map((alert) => (
        <article
          key={alert.id}
          role="alert"
          className="grid gap-2 rounded-md border-2 border-red-600 bg-red-50 p-4 text-sm text-red-950"
        >
          <p className="font-semibold">Критично: {alert.message}</p>
          <p>
            Пациент:{' '}
            <Link
              to="/patients/$patientId"
              params={{ patientId: alert.patientId }}
              className="font-medium underline"
            >
              {alert.patientName}
            </Link>
          </p>
          <p>{alert.suggestedAction}</p>
          <p className="text-xs text-red-900">
            {when.format(new Date(alert.createdAt))}
            {alert.escalatedFrom ? ' · передано вам как резервному врачу' : ''}
          </p>
          <div>
            <Button
              aria-label={`Принять алерт: ${alert.patientName}`}
              onClick={() => void acknowledge(alert)}
            >
              Принял(а) к сведению
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
