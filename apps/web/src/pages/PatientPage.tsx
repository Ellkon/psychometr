import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CreatedInviteSchema,
  IdSchema,
  InviteListSchema,
  PatientRecordSchema,
  SuccessSchema,
  type CreatedInvite,
} from '@psychometr/shared';
import { sessionClient, useSession } from '../lib/session.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';
import { AsyncForm, Button, ErrorNotice, Field } from '../components/forms.js';
import { IdentityForm } from '../components/identity-form.js';
import { ScalesPanel } from '../components/scales-panel.js';
import { ContactsPanel } from '../components/contacts-panel.js';
import { ClinicalCardsPanel } from '../components/clinical-cards-panel.js';
import { TherapyPanel } from '../components/therapy-panel.js';
import { TimelinePanel } from '../components/timeline-panel.js';
import { formatDateTime } from '../lib/dates.js';

const inviteStatus = (status: string) => {
  switch (status) {
    case 'pending':
      return 'Ожидает входа';
    case 'used':
      return 'Использовано';
    case 'expired':
      return 'Истекло';
    case 'blocked':
      return 'Заблокировано';
    default:
      return 'Отозвано';
  }
};
export function PatientPage() {
  const params = useParams({ strict: false }),
    { user, ready } = useSession();
  const parsed = IdSchema.safeParse(params.patientId);
  const id = parsed.success ? parsed.data : undefined;
  const patient = useQuery({
    queryKey: ['patient', user?.id, id],
    queryFn: ({ signal }) => {
      if (!id) throw new Error('Некорректный идентификатор');
      return sessionClient.request(`/api/patients/${id}`, PatientRecordSchema, { signal });
    },
    enabled: Boolean(id && user),
  });
  if (!ready) return <p>Проверяем сессию…</p>;
  if (!user) return <ErrorNotice message="Для просмотра карточки войдите в приложение." />;
  if (!id) return <ErrorNotice message="Некорректный идентификатор пациента." />;
  if (patient.isPending) return <p role="status">Загружаем карточку…</p>;
  if (patient.error) return <ErrorNotice message={patient.error.message} />;
  const identity = patient.data.identity;
  return (
    <div className="grid gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
          Защищённая карточка
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          {identity.lastName} {identity.firstName} {identity.middleName}
        </h1>
        <p className="mt-2 break-all font-mono text-xs text-slate-500">
          Идентификатор пациента: {id}
        </p>
      </div>
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Персональные данные</h2>
          <p className="text-sm text-slate-600">
            Просмотр и изменения записываются в журнал аудита.
          </p>
        </CardHeader>
        <CardContent>
          {user.role === 'doctor' ? (
            <IdentityForm
              key={patient.dataUpdatedAt}
              label="Сохранить данные"
              initial={identity}
              submit={async (value) => {
                await sessionClient.request(`/api/patients/${id}/identity`, SuccessSchema, {
                  method: 'PATCH',
                  body: value,
                });
                await patient.refetch();
              }}
            />
          ) : (
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-slate-500">Дата рождения</dt>
                <dd>{identity.birthDate ?? 'Не указана'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Телефон</dt>
                <dd>{identity.phone ?? 'Не указан'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">СНИЛС</dt>
                <dd>{identity.snils ?? 'Не указан'}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
      {(user.role === 'doctor' || user.role === 'patient') && <TherapyPanel patientId={id} />}
      {(user.role === 'doctor' || user.role === 'patient') && <ScalesPanel patientId={id} />}
      {(user.role === 'doctor' || user.role === 'patient') && <ContactsPanel patientId={id} />}
      {user.role === 'doctor' && <ClinicalCardsPanel patientId={id} />}
      {user.role === 'doctor' && <TimelinePanel patientId={id} />}
      {user.role === 'doctor' && <Invitations key={id} patientId={id} />}
    </div>
  );
}
function Invitations({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const [created, setCreated] = useState<CreatedInvite | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const listing = useQuery({
    queryKey: ['invites', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/invites`, InviteListSchema, { signal }),
  });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Приглашение пациента</h2>
          <p className="text-sm text-slate-600">
            Действует 72 часа и только один раз. Новое приглашение отменяет предыдущее
            неиспользованное.
          </p>
        </CardHeader>
        <CardContent>
          <AsyncForm
            submitLabel="Создать новое приглашение"
            action={async () => {
              setCreated(
                await sessionClient.request(
                  `/api/patients/${patientId}/invites`,
                  CreatedInviteSchema,
                  { method: 'POST', body: {} },
                ),
              );
              await listing.refetch();
            }}
          >
            {null}
          </AsyncForm>
          {created && (
            <div className="mt-5 grid gap-4 rounded-md border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-950">
                Сохраните сейчас: повторно показать код невозможно.
              </p>
              <Field label="Одноразовая ссылка" name="inviteUrl" readOnly value={created.url} />
              <Field label="Код приглашения" name="inviteCode" readOnly value={created.code} />
              <p className="text-sm text-amber-950">
                Передайте ссылку и код разными каналами. Не добавляйте медицинские сведения в
                сообщение.
              </p>
              <Button
                onClick={() => {
                  setCreated(null);
                }}
              >
                Я сохранил(а), скрыть данные
              </Button>
            </div>
          )}
          <ErrorNotice message={listing.error?.message ?? null} />
          <ul className="mt-5 grid gap-2 text-sm">
            {listing.data?.invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap justify-between gap-2 rounded-md bg-slate-50 p-3"
              >
                <span>{inviteStatus(invite.status)}</span>
                <span className="text-slate-500">До {formatDateTime(invite.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Устройства и сессии</h2>
          <p className="text-sm text-slate-600">
            Отзыв немедленно закрывает доступ на всех устройствах пациента. Для повторного входа
            потребуется новое приглашение.
          </p>
        </CardHeader>
        <CardContent>
          <AsyncForm
            submitLabel="Отозвать все сессии"
            action={async () => {
              await sessionClient.request(
                `/api/patients/${patientId}/sessions/revoke`,
                SuccessSchema,
                { method: 'POST', body: {} },
              );
              setCreated(null);
              setNotice('Сессии, привязки устройств и неиспользованные приглашения отозваны.');
              await listing.refetch();
            }}
          >
            <label className="flex gap-2 text-sm">
              <input type="checkbox" required className="h-4 w-4 accent-teal-800" />
              Подтверждаю отзыв всех сессий пациента
            </label>
          </AsyncForm>
          {notice && (
            <p role="status" className="mt-3 text-sm text-teal-800">
              {notice}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
