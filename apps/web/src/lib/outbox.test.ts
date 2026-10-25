import { describe, expect, it } from 'vitest';
import { ApiFailure } from './api.js';
import {
  classifySendError,
  enqueueDoseMark,
  flushOutbox,
  type DoseOutboxItem,
  type OutboxStore,
} from './outbox.js';

function memoryStore(): OutboxStore & { items: DoseOutboxItem[] } {
  const items: DoseOutboxItem[] = [];
  return {
    items,
    list: () => Promise.resolve([...items].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))),
    add: (item) => {
      items.push(item);
      return Promise.resolve();
    },
    remove: (id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) items.splice(index, 1);
      return Promise.resolve();
    },
  };
}

const mark = (slot: number) => ({
  ownerId: 'u',
  patientId: 'p',
  medicationId: 'm',
  scheduledFor: `2026-10-25T0${String(slot)}:00:00.000Z`,
  status: 'taken' as const,
});
const slotOf = (item: { scheduledFor: string }) => Number(item.scheduledFor.slice(12, 13));

describe('dose outbox (FR-9)', () => {
  it('enqueues with a fresh local key and a queue time', async () => {
    const store = memoryStore();
    const item = await enqueueDoseMark(store, mark(1), new Date('2026-10-25T06:00:00Z'));
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.queuedAt).toBe('2026-10-25T06:00:00.000Z');
    expect(store.items).toHaveLength(1);
  });

  it('sends in queue order and removes what was sent', async () => {
    const store = memoryStore();
    await enqueueDoseMark(store, mark(1), new Date('2026-10-25T06:00:00Z'));
    await enqueueDoseMark(store, mark(2), new Date('2026-10-25T07:00:00Z'));
    const order: number[] = [];
    const report = await flushOutbox(store, 'u', (item) => {
      order.push(slotOf(item));
      return Promise.resolve('sent' as const);
    });
    expect(order).toEqual([1, 2]);
    expect(report).toEqual({ sent: 2, rejected: [], remaining: 0 });
    expect(store.items).toHaveLength(0);
  });

  it('stops at the first retryable failure and keeps the rest in order', async () => {
    const store = memoryStore();
    await enqueueDoseMark(store, mark(1), new Date('2026-10-25T06:00:00Z'));
    await enqueueDoseMark(store, mark(2), new Date('2026-10-25T07:00:00Z'));
    const report = await flushOutbox(store, 'u', () => Promise.resolve('retry' as const));
    expect(report).toEqual({ sent: 0, rejected: [], remaining: 2 });
    expect(store.items).toHaveLength(2);
  });

  it('drops a refused mark, reports it, and carries on with the next one', async () => {
    const store = memoryStore();
    await enqueueDoseMark(store, mark(1), new Date('2026-10-25T06:00:00Z'));
    await enqueueDoseMark(store, mark(2), new Date('2026-10-25T07:00:00Z'));
    const results: Record<number, 'rejected' | 'sent'> = { 1: 'rejected', 2: 'sent' };
    const report = await flushOutbox(store, 'u', (item) =>
      Promise.resolve(results[slotOf(item)] ?? ('retry' as const)),
    );
    expect(report.sent).toBe(1);
    expect(report.rejected.map(slotOf)).toEqual([1]);
    expect(report.remaining).toBe(0);
    expect(store.items).toHaveLength(0);
  });

  it('classifies errors: a live 4xx is final, network and 5xx are retried later', () => {
    expect(classifySendError(new ApiFailure(400, 'invalid_slot', 'x'))).toBe('rejected');
    expect(classifySendError(new ApiFailure(401, 'unauthorized', 'x'))).toBe('retry');
    expect(classifySendError(new ApiFailure(429, 'rate_limited', 'x'))).toBe('retry');
    expect(classifySendError(new ApiFailure(503, 'unavailable', 'x'))).toBe('retry');
    expect(classifySendError(new TypeError('Failed to fetch'))).toBe('retry');
  });
});

describe('outbox owner', () => {
  it("drops marks of another user instead of sending them with this user's token", async () => {
    const store = memoryStore();
    await enqueueDoseMark(store, { ...mark(1), ownerId: 'someone-else' });
    await enqueueDoseMark(store, mark(2));
    const sent: number[] = [];
    const report = await flushOutbox(store, 'u', (item) => {
      sent.push(slotOf(item));
      return Promise.resolve('sent' as const);
    });
    expect(sent).toEqual([2]);
    expect(report.sent).toBe(1);
    expect(store.items).toHaveLength(0);
  });
});
