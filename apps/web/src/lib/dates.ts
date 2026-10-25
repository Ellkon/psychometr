/**
 * One date style for the whole interface: the month as a word ("25 окт. 2026 г."), so day and
 * month are never confused. Date-only values ("2026-10-25") are calendar dates, not instants:
 * they are formatted in UTC, otherwise west of Greenwich they would show the previous day.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
const calendarFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** "25 окт. 2026 г." for a date-only string or an ISO timestamp. */
export function formatDate(value: string): string {
  return DATE_ONLY.test(value)
    ? calendarFormat.format(new Date(`${value}T00:00:00Z`))
    : dateFormat.format(new Date(value));
}

/** "25 окт. 2026 г., 14:30" in the viewer's time zone. */
export function formatDateTime(value: string): string {
  return dateTimeFormat.format(new Date(value));
}
