import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCESS_DENIED_THRESHOLD,
  AUTH_FAILURE_THRESHOLD,
  SECURITY_WINDOW_MINUTES,
  SecuritySignalListSchema,
  SuccessSchema,
  type SecuritySignal,
} from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { Button, ErrorNotice } from './forms.js';
import { formatDateTime } from '../lib/dates.js';

const POLL_MS = 30_000;

const describe = (signal: SecuritySignal) =>
  signal.kind === 'access_denied_spike'
    ? `Всплеск отказов в доступе: ${String(signal.eventCount)} за ${String(SECURITY_WINDOW_MINUTES)} мин (порог ${String(ACCESS_DENIED_THRESHOLD)}).`
    : `Серия неверных паролей и кодов: ${String(signal.eventCount)} за ${String(SECURITY_WINDOW_MINUTES)} мин (порог ${String(AUTH_FAILURE_THRESHOLD)}).`;

/**
 * Runtime security signals for the administrator (NFR-2). Polled every 30 seconds; details are
 * in the audit log. Signals hold counts only, no personal or clinical data.
 */
export function SecuritySignals() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const adminId = user?.role === 'admin' ? user.id : undefined;
  const signals = useQuery({
    queryKey: ['security-signals', adminId],
    queryFn: ({ signal }) =>
      sessionClient.request('/api/admin/security-signals', SecuritySignalListSchema, { signal }),
    enabled: adminId !== undefined,
    refetchInterval: POLL_MS,
  });
  if (adminId === undefined) return null;
  const open = (signals.data?.signals ?? []).filter((signal) => signal.acknowledgedAt === null);

  const acknowledge = async (signal: SecuritySignal) => {
    setError(null);
    try {
      await sessionClient.request(`/api/admin/security-signals/${signal.id}/ack`, SuccessSchema, {
        method: 'POST',
        body: {},
      });
      await queryClient.invalidateQueries({ queryKey: ['security-signals', adminId] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось подтвердить сигнал');
    }
  };

  if (open.length === 0 && !signals.error && !error) return null;
  return (
    <section aria-label="Сигналы безопасности" className="mb-6 grid gap-3">
      <ErrorNotice message={signals.error?.message ?? error} />
      {open.map((signal) => (
        <article
          key={signal.id}
          role="alert"
          className="grid gap-2 rounded-md border-2 border-amber-600 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">Сигнал безопасности</p>
          <p>{describe(signal)}</p>
          <p className="text-xs">
            {formatDateTime(signal.createdAt)} · подробности в журнале аудита
          </p>
          <div>
            <Button
              aria-label={`Подтвердить сигнал от ${formatDateTime(signal.createdAt)}`}
              onClick={() => void acknowledge(signal)}
            >
              Принял(а) к сведению
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
