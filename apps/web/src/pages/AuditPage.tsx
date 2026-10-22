import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuditListSchema, AuditVerificationSchema, type AuditAction } from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { AsyncForm, Button, ErrorNotice } from '../components/forms.js';

const labels = new Map<AuditAction, string>([
  ['staff.created', 'Создание сотрудника'],
  ['auth.login', 'Вход'],
  ['auth.failed', 'Неудачный вход'],
  ['auth.locked', 'Блокировка входа'],
  ['auth.refresh', 'Обновление сессии'],
  ['auth.refresh_reused', 'Повторное использование токена'],
  ['auth.logout', 'Выход'],
  ['auth.denied', 'Вход отклонён'],
  ['patient.created', 'Создание пациента'],
  ['patient.viewed', 'Просмотр пациента'],
  ['patient.identity_updated', 'Изменение персональных данных'],
  ['invite.created', 'Создание приглашения'],
  ['invite.revoked', 'Отзыв приглашения'],
  ['invite.failed', 'Ошибка проверки приглашения'],
  ['invite.blocked', 'Блокировка приглашения'],
  ['invite.expired', 'Истечение приглашения'],
  ['invite.accepted', 'Приглашение принято'],
  ['consent.accepted', 'Согласие принято'],
  ['sessions.revoked', 'Отзыв сессий'],
  ['care_team.changed', 'Изменение лечащей команды'],
  ['access.denied', 'Отказ в доступе'],
  ['audit.viewed', 'Просмотр журнала'],
]);
export function AuditPage() {
  const { user } = useSession(),
    [offset, setOffset] = useState(0),
    [verification, setVerification] = useState<string | null>(null);
  const audit = useQuery({
    queryKey: ['audit', user?.id, offset],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/admin/audit?offset=${String(offset)}&limit=20`, AuditListSchema, {
        signal,
      }),
    enabled: user?.role === 'admin',
  });
  if (user?.role !== 'admin')
    return <ErrorNotice message="Журнал доступен только администратору." />;
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-semibold">Журнал действий</h1>
        <p className="mt-2 text-slate-600">
          Без ФИО, ответов, паролей и кодов. Записи нельзя изменять или удалять.
        </p>
      </div>
      <div className="max-w-sm">
        <AsyncForm
          submitLabel="Проверить целостность журнала"
          action={async () => {
            const result = await sessionClient.request(
              '/api/admin/audit/verify',
              AuditVerificationSchema,
            );
            setVerification(
              result.valid
                ? `Цепочка целая. Проверено записей: ${String(result.checked)}.`
                : 'Обнаружено нарушение целостности. Требуется проверка безопасности.',
            );
          }}
        >
          {null}
        </AsyncForm>
        {verification && (
          <p role="status" className="mt-3 text-sm">
            {verification}
          </p>
        )}
      </div>
      <ErrorNotice message={audit.error?.message ?? null} />
      {audit.isPending ? (
        <p>Загружаем журнал…</p>
      ) : audit.data ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-3">№</th>
                  <th className="p-3">Время</th>
                  <th className="p-3">Действие</th>
                  <th className="p-3">Автор, UUID</th>
                  <th className="p-3">Объект, UUID</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((event) => (
                  <tr key={event.sequence} className="border-t border-slate-100">
                    <td className="p-3">{event.sequence}</td>
                    <td className="whitespace-nowrap p-3">
                      {new Date(event.occurredAt).toLocaleString('ru-RU')}
                    </td>
                    <td className="p-3">{labels.get(event.action)}</td>
                    <td className="break-all p-3 font-mono text-xs">
                      {event.actorId ?? 'Не определён'}
                    </td>
                    <td className="break-all p-3 font-mono text-xs">{event.resourceId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <Button
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 20));
              }}
            >
              Назад
            </Button>
            <Button
              disabled={audit.data.events.length < 20}
              onClick={() => {
                setOffset(offset + 20);
              }}
            >
              Далее
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
