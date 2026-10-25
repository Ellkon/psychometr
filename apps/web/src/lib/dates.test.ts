import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './dates.js';

describe('date formatting', () => {
  it('writes the month as a word', () => {
    expect(formatDate('2026-10-25')).toMatch(/^25 окт\.? 2026/);
    expect(formatDateTime('2026-10-25T09:30:00Z')).toMatch(/окт\.? 2026/);
  });

  it('keeps a date-only value on its calendar day in any time zone', () => {
    expect(formatDate('2026-01-01')).toMatch(/^1 янв\.? 2026/);
  });
});
