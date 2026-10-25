import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTACT_RESPONSE_WORKING_DAYS,
  ContactRequestCreatedSchema,
  CreatedSchema,
  PatientContactsSchema,
  contactChannelLabel,
  contactReasonLabel,
  contactTimeLabel,
  type PatientContacts,
} from '@psychometr/shared';
import { formatDateTime } from '../lib/dates.js';
import { sessionClient, useSession } from '../lib/session.js';
import { AsyncForm, ErrorNotice, text } from './forms.js';
import { Card, CardContent, CardHeader } from './ui/card.js';

const fieldClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-teal-700';

/** "2026-10-25T14:30" in the viewer's zone, for a datetime-local input. */
function localNow(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Contact between visits (FR-12). The patient asks the doctor to get in touch; the doctor
 * records each contact, which closes the open request.
 */
export function ContactsPanel({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const contacts = useQuery({
    queryKey: ['contacts', user?.id, patientId],
    queryFn: ({ signal }) =>
      sessionClient.request(`/api/patients/${patientId}/contacts`, PatientContactsSchema, {
        signal,
      }),
    enabled: user?.role === 'doctor' || user?.role === 'patient',
  });
  if (user?.role !== 'doctor' && user?.role !== 'patient') return null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-xl font-semibold">Связь с врачом</h2>
        <p className="text-sm text-slate-600">
          {user.role === 'patient'
            ? `Попросите врача связаться с вами между приёмами. Врач свяжется в течение ${String(CONTACT_RESPONSE_WORKING_DAYS)} рабочих дней.`
            : `Просьбы пациента связаться и записанные контакты. Срок ответа — ${String(CONTACT_RESPONSE_WORKING_DAYS)} рабочих дня, затем просьба уходит резервному врачу.`}
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        {contacts.isPending && <p role="status">Загружаем…</p>}
        <ErrorNotice message={contacts.error?.message ?? null} />
        {contacts.data &&
          (user.role === 'patient' ? (
            <PatientContactView patientId={patientId} data={contacts.data} />
          ) : (
            <DoctorContactView patientId={patientId} data={contacts.data} />
          ))}
      </CardContent>
    </Card>
  );
}

function PatientContactView({ patientId, data }: { patientId: string; data: PatientContacts }) {
  const queryClient = useQueryClient();
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const open = data.requests.find((request) => request.resolvedAt === null);
  const lastContact = data.contacts[0];
  return (
    <>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        Это не экстренная связь. Если вам сейчас тяжело, не ждите ответа врача: телефоны экстренной
        помощи — в разделе «Если вам сейчас тяжело».
      </p>
      {open ? (
        <p role="status" className="text-sm text-teal-800">
          Просьба отправлена {formatDateTime(open.createdAt)}: {contactReasonLabel[open.reason]}.
          Врач свяжется с вами до {formatDateTime(open.dueAt)}.
        </p>
      ) : (
        <AsyncForm
          submitLabel="Прошу связаться"
          action={async (form) => {
            await sessionClient.request(
              `/api/patients/${patientId}/contact-requests`,
              ContactRequestCreatedSchema,
              {
                method: 'POST',
                body: {
                  submissionId,
                  reason: text(form, 'reason'),
                  preferredTime: text(form, 'preferredTime'),
                },
              },
            );
            setSubmissionId(crypto.randomUUID());
            await queryClient.invalidateQueries({ queryKey: ['contacts'] });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span>Повод</span>
              <select name="reason" required defaultValue="medication" className={fieldClass}>
                {Object.entries(contactReasonLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span>Когда удобно</span>
              <select name="preferredTime" required defaultValue="any" className={fieldClass}>
                {Object.entries(contactTimeLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </AsyncForm>
      )}
      {lastContact && (
        <p className="text-sm text-slate-600">
          Последний контакт с врачом: {contactChannelLabel[lastContact.channel].toLowerCase()},{' '}
          {formatDateTime(lastContact.contactedAt)}.
        </p>
      )}
    </>
  );
}

function DoctorContactView({ patientId, data }: { patientId: string; data: PatientContacts }) {
  const queryClient = useQueryClient();
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const open = data.requests.find((request) => request.resolvedAt === null);
  return (
    <>
      {open ? (
        <p
          role="status"
          className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
        >
          Пациент просит связаться: {contactReasonLabel[open.reason]}. Удобное время:{' '}
          {contactTimeLabel[open.preferredTime].toLowerCase()}. Срок — до{' '}
          {formatDateTime(open.dueAt)}. Запись контакта ниже закроет просьбу.
        </p>
      ) : (
        <p className="text-sm text-slate-600">Открытых просьб связаться нет.</p>
      )}
      <section aria-label="Записать контакт" className="grid gap-3 rounded-md bg-slate-50 p-4">
        <h3 className="font-medium">Записать контакт</h3>
        <AsyncForm
          key={formKey}
          submitLabel="Записать контакт"
          action={async (form) => {
            await sessionClient.request(`/api/patients/${patientId}/contacts`, CreatedSchema, {
              method: 'POST',
              body: {
                submissionId,
                channel: text(form, 'channel'),
                contactedAt: new Date(text(form, 'contactedAt')).toISOString(),
                note: text(form, 'note').trim(),
              },
            });
            setSubmissionId(crypto.randomUUID());
            setFormKey((key) => key + 1);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['contacts'] }),
              queryClient.invalidateQueries({ queryKey: ['alerts'] }),
              queryClient.invalidateQueries({ queryKey: ['timeline'] }),
            ]);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span>Как связались</span>
              <select name="channel" required defaultValue="phone" className={fieldClass}>
                {Object.entries(contactChannelLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span>Когда</span>
              <input
                name="contactedAt"
                type="datetime-local"
                required
                max={localNow()}
                defaultValue={localNow()}
                className={fieldClass}
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span>Заметка (видна только врачам)</span>
            <textarea name="note" maxLength={500} rows={2} className={fieldClass} />
          </label>
        </AsyncForm>
      </section>
      {data.contacts.length > 0 && (
        <ul className="grid gap-2 text-sm">
          {data.contacts.map((contact) => (
            <li key={contact.id} className="border-b border-slate-100 pb-2">
              <span className="font-medium">{contactChannelLabel[contact.channel]}</span> ·{' '}
              {formatDateTime(contact.contactedAt)}
              {contact.note ? <span className="block text-slate-600">{contact.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
