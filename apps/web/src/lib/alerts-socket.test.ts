import { describe, expect, it, vi } from 'vitest';
import {
  openAlertSocket,
  parseServerMessage,
  reconnectDelayMs,
  socketUrl,
} from './alerts-socket.js';

const alert = {
  id: '0b8f6c2e-3d1a-4e5b-9c7d-2a1b3c4d5e6f',
  ruleId: 'phq9_item9_positive',
  severity: 'critical',
  patientId: '1f2e3d4c-5b6a-4789-8abc-def012345678',
  patientName: 'Иванова Анна',
  message: 'Ответ на пункт 9 PHQ-9 больше 0.',
  suggestedAction: 'Провести дополнительную оценку риска с пациентом.',
  status: 'sent',
  createdAt: '2026-10-25T06:00:00.000Z',
  acknowledgedAt: null,
  escalatedFrom: null,
};

describe('alert socket helpers (FR-8.1)', () => {
  it('uses wss on https and ws on http, always on the same host', () => {
    expect(socketUrl({ protocol: 'https:', host: 'app.example' })).toBe('wss://app.example/ws');
    expect(socketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });

  it('backs off from 1 s and never beyond 30 s', () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });

  it('accepts the two server messages and rejects everything else', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' });
    expect(parseServerMessage(JSON.stringify({ type: 'alert', alert }))).toMatchObject({
      type: 'alert',
      alert: { id: alert.id },
    });
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'other' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'alert', alert: { id: 'x' } }))).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('socket reconnection (FR-8.1, S-2)', () => {
  function fakeSocket() {
    return {
      onopen: null as (() => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onclose: null as ((event: CloseEvent) => void) | null,
      send: () => undefined,
      close: () => undefined,
    };
  }

  it('asks for a fresh token only after a 4401 close, never after an ordinary drop', async () => {
    vi.useFakeTimers();
    try {
      const sockets: ReturnType<typeof fakeSocket>[] = [];
      const asked: boolean[] = [];
      const stop = openAlertSocket({
        getToken: (fresh) => {
          asked.push(fresh);
          return Promise.resolve('token');
        },
        handlers: { onAlert: () => undefined, onStatus: () => undefined },
        url: 'ws://localhost/ws',
        createSocket: () => {
          const socket = fakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
      const socket = (index: number) => {
        const found = sockets.at(index);
        if (!found) throw new Error(`no socket ${String(index)}`);
        return found;
      };

      socket(0).onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      socket(0).onclose?.({ code: 4401 } as CloseEvent);
      await vi.advanceTimersByTimeAsync(1_000);
      socket(1).onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      socket(1).onclose?.({ code: 1006 } as CloseEvent);
      await vi.advanceTimersByTimeAsync(2_000);
      socket(2).onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(asked).toEqual([false, true, false]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
