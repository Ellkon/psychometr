/**
 * Doctor's alert socket (FR-8.1): authenticates with the access token as its first message,
 * shows pushed alerts, confirms receipt, and reconnects with a capped backoff. A 4401 close
 * (token expired or session ended) refreshes the token before reconnecting; 4403 stops the loop.
 */
import {
  AlertSocketServerMessageSchema,
  type Alert,
  type AlertSocketServerMessage,
} from '@psychometr/shared';

export type AlertSocketStatus = 'connecting' | 'online' | 'offline';

export interface AlertSocketHandlers {
  onAlert(alert: Alert): void;
  onStatus(status: AlertSocketStatus): void;
}

export function socketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** 1 s, 2 s, 4 s, … capped at 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 5));
}

export function parseServerMessage(raw: unknown): AlertSocketServerMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const parsed = AlertSocketServerMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Opens the socket and keeps it open. Returns a function that stops it for good. */
export function openAlertSocket(options: {
  /** `fresh` is true after a 4401 close: the cached token may be expired or revoked. */
  getToken: (fresh: boolean) => Promise<string>;
  handlers: AlertSocketHandlers;
  url?: string;
  createSocket?: (url: string) => WebSocket;
}): () => void {
  const url = options.url ?? socketUrl(globalThis.location);
  const create = options.createSocket ?? ((target: string) => new WebSocket(target));
  let stopped = false;
  let attempt = 0;
  let current: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needFreshToken = false;

  const scheduleReconnect = () => {
    if (stopped) return;
    timer = setTimeout(connect, reconnectDelayMs(attempt));
    attempt += 1;
  };

  const connect = () => {
    if (stopped) return;
    options.handlers.onStatus('connecting');
    const socket = create(url);
    current = socket;
    socket.onopen = () => {
      const fresh = needFreshToken;
      needFreshToken = false;
      options.getToken(fresh).then(
        (token) => {
          socket.send(JSON.stringify({ type: 'auth', token }));
        },
        () => {
          socket.close(4401, 'no_session');
        },
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') {
        attempt = 0;
        options.handlers.onStatus('online');
        return;
      }
      options.handlers.onAlert(message.alert);
      socket.send(JSON.stringify({ type: 'received', alertId: message.alert.id }));
    };
    socket.onclose = (event: CloseEvent) => {
      options.handlers.onStatus('offline');
      if (event.code === 4403) {
        stopped = true;
        return;
      }
      if (event.code === 4401) needFreshToken = true;
      scheduleReconnect();
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    current?.close(1000, 'stopped');
  };
}
