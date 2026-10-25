/**
 * Contact between visits (FR-12). The patient asks the primary doctor to get in touch by picking
 * a reason and a convenient time; the doctor records each contact (call, message, visit). A
 * recorded contact resolves the open request and closes its notification. An unanswered request
 * is escalated to the reserve doctor after CONTACT_RESPONSE_WORKING_DAYS (alerts.ts).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  CONTACT_RESPONSE_WORKING_DAYS,
  addWorkingDays,
  type ContactInput,
  type ContactRequestInput,
  type PatientContacts,
  type Principal,
} from '@psychometr/shared';
import type { Database } from '../db/client.js';
import { contactRequests, contacts } from '../db/schema.js';
import type { AlertService } from './alerts.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { appendAudit } from './audit.js';
import { DomainError } from './errors.js';

const LIST_LIMIT = 50;
/** A contact may be recorded after the fact, but not long before the record or in the future. */
const MAX_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export class ContactService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly alerts?: AlertService,
  ) {}

  /** Patient only. One open request per patient: a repeat press returns the open one. */
  async request(
    user: Principal,
    patientId: string,
    input: ContactRequestInput,
  ): Promise<{ id: string; existing: boolean }> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'patient');
        // The patient row lock in `authorized` serializes these reads and the insert.
        const [open] = await tx
          .select({ id: contactRequests.id, submissionId: contactRequests.submissionId })
          .from(contactRequests)
          .where(and(eq(contactRequests.patientId, patientId), isNull(contactRequests.resolvedAt)));
        if (open) return { id: open.id, existing: open.submissionId !== input.submissionId };
        const [stored] = await tx
          .select({ id: contactRequests.id })
          .from(contactRequests)
          .where(
            and(
              eq(contactRequests.patientId, patientId),
              eq(contactRequests.submissionId, input.submissionId),
            ),
          );
        // A retry of a request that has been resolved since: nothing new to ask.
        if (stored) return { id: stored.id, existing: true };
        const now = this.now();
        const [row] = await tx
          .insert(contactRequests)
          .values({
            patientId,
            submissionId: input.submissionId,
            reason: input.reason,
            preferredTime: input.preferredTime,
            createdAt: now,
          })
          .returning({ id: contactRequests.id });
        if (!row) throw new Error('Contact request insert failed');
        await appendAudit(
          tx,
          { action: 'contact_request.created', actorId: user.id, resourceId: patientId },
          now,
        );
        await this.alerts?.raiseContactRequest(
          tx,
          patientId,
          row.id,
          input.reason,
          input.preferredTime,
          now,
        );
        return { id: row.id, existing: false };
      },
      patientId,
    );
  }

  /** Doctor of the care team only. Resolves the open request and closes its notifications. */
  async record(user: Principal, patientId: string, input: ContactInput): Promise<{ id: string }> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const contactedAt = new Date(input.contactedAt);
        if (contactedAt.getTime() > now.getTime() + CLOCK_SKEW_MS)
          throw new DomainError(400, 'invalid_date', 'Время контакта не может быть в будущем');
        if (contactedAt.getTime() < now.getTime() - MAX_BACKDATE_MS)
          throw new DomainError(400, 'invalid_date', 'Контакт старше 30 дней не записывается');
        const [stored] = await tx
          .select({ id: contacts.id, patientId: contacts.patientId })
          .from(contacts)
          .where(
            and(
              eq(contacts.practitionerId, user.id),
              eq(contacts.submissionId, input.submissionId),
            ),
          );
        if (stored) {
          if (stored.patientId !== patientId)
            throw new DomainError(409, 'submission_reused', 'Повторите отправку формы');
          return { id: stored.id };
        }
        const [row] = await tx
          .insert(contacts)
          .values({
            patientId,
            practitionerId: user.id,
            submissionId: input.submissionId,
            channel: input.channel,
            contactedAt,
            note: input.note,
            recordedAt: now,
          })
          .returning({ id: contacts.id });
        if (!row) throw new Error('Contact insert failed');
        const resolved = await tx
          .update(contactRequests)
          .set({ resolvedAt: now, contactId: row.id })
          .where(and(eq(contactRequests.patientId, patientId), isNull(contactRequests.resolvedAt)))
          .returning({ id: contactRequests.id });
        await appendAudit(
          tx,
          {
            action: 'contact.recorded',
            actorId: user.id,
            resourceId: patientId,
            detail: input.channel,
          },
          now,
        );
        await this.alerts?.acknowledgeContactRequests(
          tx,
          user,
          patientId,
          resolved.map((request) => request.id),
          now,
        );
        return { id: row.id };
      },
      patientId,
    );
  }

  /** Doctor and the patient. The doctor's working notes are not shown to the patient. */
  async list(user: Principal, patientId: string): Promise<PatientContacts> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        if (user.role !== 'doctor' && user.role !== 'patient') assertRole(user, 'doctor');
        const requests = await tx
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.patientId, patientId))
          .orderBy(desc(contactRequests.createdAt))
          .limit(LIST_LIMIT);
        const rows = await tx
          .select()
          .from(contacts)
          .where(eq(contacts.patientId, patientId))
          .orderBy(desc(contacts.contactedAt))
          .limit(LIST_LIMIT);
        await appendAudit(
          tx,
          { action: 'contacts.viewed', actorId: user.id, resourceId: patientId },
          this.now(),
        );
        return {
          requests: requests.map((request) => ({
            id: request.id,
            reason: request.reason,
            preferredTime: request.preferredTime,
            createdAt: request.createdAt.toISOString(),
            dueAt: addWorkingDays(request.createdAt, CONTACT_RESPONSE_WORKING_DAYS).toISOString(),
            resolvedAt: request.resolvedAt?.toISOString() ?? null,
          })),
          contacts: rows.map((contact) => ({
            id: contact.id,
            channel: contact.channel,
            contactedAt: contact.contactedAt.toISOString(),
            note: user.role === 'doctor' ? contact.note : null,
          })),
        };
      },
      patientId,
    );
  }
}
