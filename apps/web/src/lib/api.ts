import {
  ApiErrorSchema,
  AuthResponseSchema,
  SuccessSchema,
  type AuthResponse,
  type Principal,
} from '@psychometr/shared';
import type { ResponseSchema } from '@psychometr/shared';

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Snapshot {
  user: Principal | null;
  ready: boolean;
}
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}
export interface LogoutMarker {
  pending(): boolean;
  set(value: boolean): void;
}

function memoryMarker(): LogoutMarker {
  let pending = false;
  return {
    pending: () => pending,
    set: (value) => {
      pending = value;
    },
  };
}
async function withCookieLock<T>(work: () => Promise<T>): Promise<T> {
  const browser: { locks?: LockManager } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  if (browser?.locks) return browser.locks.request('compass-session-cookie', work);
  return work();
}

/** Tokens and profiles live only in memory. The marker stores one non-medical boolean. */
export class SessionClient {
  private token: string | undefined;
  private snapshot: Snapshot = { user: null, ready: false };
  private readonly listeners = new Set<() => void>();
  private refreshPromise: Promise<AuthResponse> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly marker: LogoutMarker = memoryMarker(),
    private readonly onIdentityChange: () => void = () => undefined,
  ) {}
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(user: Principal | null, ready = true): void {
    if (this.snapshot.user?.id !== user?.id) this.onIdentityChange();
    this.snapshot = { user, ready };
    for (const listener of this.listeners) listener();
  }
  resetLocal(): void {
    this.generation += 1;
    this.token = undefined;
    this.emit(null);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => withCookieLock(operation));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async raw<T>(
    path: string,
    schema: ResponseSchema<T>,
    options: RequestOptions = {},
    token?: string,
  ): Promise<T> {
    if (!path.startsWith('/api/')) throw new Error('Only same-origin API paths are allowed');
    const response = await this.fetcher.call(globalThis, path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiFailure(502, 'invalid_response', 'Получен некорректный ответ сервера');
    }
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(value);
      throw new ApiFailure(
        response.status,
        error.success ? error.data.error.code : 'request_failed',
        error.success ? error.data.error.message : 'Не удалось выполнить запрос',
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiFailure(502, 'invalid_response', 'Получен некорректный ответ сервера');
    return parsed.data;
  }
  publicRequest<T>(
    path: string,
    schema: ResponseSchema<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.raw(path, schema, options);
  }
  async request<T>(
    path: string,
    schema: ResponseSchema<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const generation = this.generation;
    if (!this.token) await this.refresh();
    let value: T;
    try {
      value = await this.raw(path, schema, options, this.token);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 401 || generation !== this.generation)
        throw error;
      await this.refresh();
      value = await this.raw(path, schema, options, this.token);
    }
    if (generation !== this.generation)
      throw new ApiFailure(401, 'session_changed', 'Сессия завершена');
    return value;
  }
  async signIn(
    path: '/api/auth/login' | '/api/auth/patient/login' | '/api/auth/invites/accept',
    body: unknown,
  ): Promise<void> {
    const generation = this.generation;
    await this.serialize(async () => {
      if (this.marker.pending()) {
        await this.raw('/api/auth/logout', SuccessSchema, { method: 'POST', body: {} });
        this.marker.set(false);
      }
      const response = await this.raw(path, AuthResponseSchema, { method: 'POST', body });
      if (generation === this.generation) {
        this.token = response.accessToken;
        this.emit(response.user);
      }
    });
  }
  /** Access token for the WebSocket handshake; refreshes once when the session has none. */
  async accessToken(): Promise<string> {
    if (!this.token) await this.refresh();
    if (!this.token) throw new ApiFailure(401, 'no_session', 'Сессия не активна');
    return this.token;
  }
  refresh(): Promise<AuthResponse> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.marker.pending())
      return Promise.reject(
        new ApiFailure(401, 'logout_pending', 'Для завершения выхода требуется соединение'),
      );
    const generation = this.generation;
    this.refreshPromise = this.serialize(async () => {
      try {
        const response = await this.raw('/api/auth/refresh', AuthResponseSchema, {
          method: 'POST',
          body: {},
        });
        if (generation !== this.generation)
          throw new ApiFailure(401, 'session_changed', 'Сессия завершена');
        this.token = response.accessToken;
        this.emit(response.user);
        return response;
      } catch (error) {
        if (generation === this.generation && error instanceof ApiFailure && error.status === 401) {
          if (this.snapshot.user) this.resetLocal();
          else this.emit(null);
        }
        throw error;
      }
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }
  async restore(): Promise<void> {
    try {
      if (this.marker.pending()) await this.logout();
      else await this.refresh();
    } catch {
      this.emit(null);
    }
  }
  async logout(): Promise<void> {
    this.marker.set(true);
    this.resetLocal();
    await this.serialize(async () => {
      await this.raw('/api/auth/logout', SuccessSchema, { method: 'POST', body: {} });
      this.marker.set(false);
    });
  }
}
