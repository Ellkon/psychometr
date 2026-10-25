import { z } from 'zod';
import { IdSchema } from './access.js';

/**
 * Contact between visits (FR-12). The patient asks the doctor to get in touch; the doctor records
 * every contact (call, message, visit). Choices only, no free text from the patient: nothing
 * urgent can hide in a message nobody reads in time. This is not an emergency channel (FR-5.4).
 * The primary doctor answers within CONTACT_RESPONSE_WORKING_DAYS; after that the request is
 * escalated to the reserve doctor like a critical alert (owner decision of 2026-10-25).
 */
/** The doctor gets in touch within this many working days; then the reserve doctor is told. */
export const CONTACT_RESPONSE_WORKING_DAYS = 3;
/** Working days are counted in Moscow time (UTC+3, no daylight saving). Holidays are not known. */
const CLINIC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `from` plus `days` working days at the same clock time: each step moves one calendar day and
 * counts only Monday to Friday. A request on Friday 15:00 is due on Wednesday 15:00.
 */
export function addWorkingDays(from: Date, days: number): Date {
  let at = from.getTime();
  let left = days;
  while (left > 0) {
    at += DAY_MS;
    const weekday = new Date(at + CLINIC_OFFSET_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return new Date(at);
}

export const ContactReasonSchema = z.enum(['medication', 'side_effect', 'worse', 'other']);
export type ContactReason = z.infer<typeof ContactReasonSchema>;
export const contactReasonLabel = {
  medication: 'Вопрос по препарату или схеме приёма',
  side_effect: 'Побочное действие',
  worse: 'Стало хуже',
  other: 'Другое',
} as const satisfies Record<ContactReason, string>;

export const ContactTimeSchema = z.enum(['morning', 'day', 'evening', 'any']);
export type ContactTime = z.infer<typeof ContactTimeSchema>;
export const contactTimeLabel = {
  morning: 'Утром',
  day: 'Днём',
  evening: 'Вечером',
  any: 'В любое время',
} as const satisfies Record<ContactTime, string>;

export const ContactChannelSchema = z.enum(['phone', 'message', 'visit']);
export type ContactChannel = z.infer<typeof ContactChannelSchema>;
export const contactChannelLabel = {
  phone: 'Звонок',
  message: 'Сообщение',
  visit: 'Очный приём',
} as const satisfies Record<ContactChannel, string>;

export const ContactRequestInputSchema = z
  .object({
    /** Client-generated per form fill: a retried send stores one request. */
    submissionId: IdSchema,
    reason: ContactReasonSchema,
    preferredTime: ContactTimeSchema,
  })
  .strict();
export type ContactRequestInput = z.infer<typeof ContactRequestInputSchema>;

export const ContactInputSchema = z
  .object({
    submissionId: IdSchema,
    channel: ContactChannelSchema,
    contactedAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(500),
  })
  .strict();
export type ContactInput = z.infer<typeof ContactInputSchema>;

/** `existing` is true when an open request already waited: the patient is told, not duplicated. */
export const ContactRequestCreatedSchema = z
  .object({ id: IdSchema, existing: z.boolean() })
  .strict();

export const ContactRequestSchema = z
  .object({
    id: IdSchema,
    reason: ContactReasonSchema,
    preferredTime: ContactTimeSchema,
    createdAt: z.iso.datetime({ offset: true }),
    /** The doctor promised to get in touch by then (CONTACT_RESPONSE_WORKING_DAYS). */
    dueAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type ContactRequest = z.infer<typeof ContactRequestSchema>;

export const ContactSchema = z
  .object({
    id: IdSchema,
    channel: ContactChannelSchema,
    contactedAt: z.iso.datetime({ offset: true }),
    /** The doctor's working note; null in the patient's view. */
    note: z.string().nullable(),
  })
  .strict();
export type Contact = z.infer<typeof ContactSchema>;

export const PatientContactsSchema = z
  .object({ requests: z.array(ContactRequestSchema), contacts: z.array(ContactSchema) })
  .strict();
export type PatientContacts = z.infer<typeof PatientContactsSchema>;
