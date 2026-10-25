/**
 * Offline outbox for dose marks (FR-9). Every mark is written here first and then sent. A mark
 * that cannot be sent stays until the connection returns. The server keeps one mark per slot, so
 * a resend after a lost response stores nothing twice.
 * Only dose marks are queued: adverse events are sent online only (owner decision).
 * The database is `compass-outbox`; it is cleared on logout (clearPrivateState).
 */
import Dexie, { type Table } from 'dexie';
import { ApiFailure } from './api.js';

export const OUTBOX_DB_NAME = 'compass-outbox';

export interface DoseOutboxItem {
  /** Local queue key. The server needs none: one mark per slot makes a resend a no-op. */
  id: string;
  /** User who made the mark. Another user on this device never sends or sees it. */
  ownerId: string;
  patientId: string;
  medicationId: string;
  scheduledFor: string;
  status: 'taken' | 'skipped';
  queuedAt: string;
}

export type SendResult = 'sent' | 'rejected' | 'retry';

export interface OutboxStore {
  list(): Promise<DoseOutboxItem[]>;
  add(item: DoseOutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface FlushReport {
  sent: number;
  /** Refused by the server for good (course ended, date out of range): removed from the queue. */
  rejected: DoseOutboxItem[];
  /** Still queued, because the connection failed or the session needs a retry. */
  remaining: number;
}

class OutboxDatabase extends Dexie {
  items!: Table<DoseOutboxItem, string>;

  constructor() {
    super(OUTBOX_DB_NAME);
    this.version(1).stores({ items: 'id, queuedAt' });
  }
}

let database: OutboxDatabase | undefined;

function table(): Table<DoseOutboxItem, string> {
  database ??= new OutboxDatabase();
  return database.items;
}

export const indexedOutbox: OutboxStore = {
  list: () => table().orderBy('queuedAt').toArray(),
  add: async (item) => {
    await table().put(item);
  },
  remove: async (id) => {
    await table().delete(id);
  },
};

export async function enqueueDoseMark(
  store: OutboxStore,
  input: Omit<DoseOutboxItem, 'id' | 'queuedAt'>,
  now: Date = new Date(),
): Promise<DoseOutboxItem> {
  const item: DoseOutboxItem = {
    ...input,
    id: crypto.randomUUID(),
    queuedAt: now.toISOString(),
  };
  await store.add(item);
  return item;
}

/** Sends queued items in order. Stops at the first retryable failure, so order is kept. */
export async function flushOutbox(
  store: OutboxStore,
  ownerId: string,
  send: (item: DoseOutboxItem) => Promise<SendResult>,
): Promise<FlushReport> {
  const all = await store.list();
  // Marks left by another user (a session that ended without logout) would go out with this
  // user's token and be refused: drop them instead of sending them.
  for (const item of all) if (item.ownerId !== ownerId) await store.remove(item.id);
  const items = all.filter((item) => item.ownerId === ownerId);
  const report: FlushReport = { sent: 0, rejected: [], remaining: items.length };
  for (const item of items) {
    const result = await send(item);
    if (result === 'retry') return report;
    await store.remove(item.id);
    report.remaining -= 1;
    if (result === 'sent') report.sent += 1;
    else report.rejected.push(item);
  }
  return report;
}

/** 4xx from a live session means the server refused this mark for good; anything else may succeed later. */
export function classifySendError(error: unknown): SendResult {
  if (error instanceof ApiFailure) {
    if (error.status === 401 || error.status === 408 || error.status === 429) return 'retry';
    if (error.status >= 400 && error.status < 500) return 'rejected';
  }
  return 'retry';
}

/** Removes the whole local database (logout). Closes the open connection first. */
export async function clearOutboxDatabase(): Promise<void> {
  database?.close();
  database = undefined;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(OUTBOX_DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new Error('Не удалось очистить локальную очередь'));
    };
    request.onblocked = () => {
      reject(new Error('Закройте другие вкладки, чтобы очистить локальную очередь'));
    };
  });
}
