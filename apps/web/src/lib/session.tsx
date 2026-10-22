import { PrincipalSchema } from '@psychometr/shared';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { QueryClient } from '@tanstack/react-query';
import { SessionClient, type LogoutMarker } from './api.js';

const LOGOUT_MARKER = 'compass.logout-pending';
let fallbackPending = false;
const marker: LogoutMarker = {
  pending: () => {
    try {
      return fallbackPending || localStorage.getItem(LOGOUT_MARKER) === '1';
    } catch {
      return fallbackPending;
    }
  },
  set: (value) => {
    fallbackPending = value;
    try {
      if (value) localStorage.setItem(LOGOUT_MARKER, '1');
      else localStorage.removeItem(LOGOUT_MARKER);
    } catch {
      /* Storage may be disabled. Keep the in-memory guard. */
    }
  },
};
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false, gcTime: 0 },
  },
});
export const sessionClient = new SessionClient(fetch, marker, () => {
  queryClient.clear();
});

export async function clearPrivateState(): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
  await clearOutbox();
}
async function clearOutbox(): Promise<void> {
  // Stage 6 will use this single database for the unsent outbox only.
  if (typeof indexedDB !== 'undefined')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('compass-outbox');
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
const Context = createContext<{ logout: () => Promise<void>; privacyError: string | null } | null>(
  null,
);
export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(sessionClient.subscribe, sessionClient.getSnapshot);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const actor = useRef<string | null>(null);
  const restore = useRef<Promise<void> | null>(null);
  const clear = async () => {
    try {
      await clearPrivateState();
      setPrivacyError(null);
    } catch (error) {
      setPrivacyError(error instanceof Error ? error.message : 'Ошибка очистки данных');
    }
  };
  const logout = async () => {
    channel.current?.postMessage('logout');
    const remote = sessionClient.logout().then(
      () => true,
      () => false,
    );
    await clear();
    if (!(await remote))
      setPrivacyError(
        'Данные на этом устройстве скрыты. Для завершения выхода на сервере восстановите соединение.',
      );
  };
  useEffect(() => {
    restore.current ??= sessionClient.restore();
    void restore.current;
    const bus =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('compass-session');
    channel.current = bus;
    const clearOtherTab = () => {
      sessionClient.resetLocal();
      void clear();
    };
    if (bus)
      bus.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === 'logout') clearOtherTab();
      };
    const storage = (event: StorageEvent) => {
      if (event.key === LOGOUT_MARKER && event.newValue === '1') clearOtherTab();
    };
    window.addEventListener('storage', storage);
    return () => {
      bus?.close();
      window.removeEventListener('storage', storage);
    };
  }, []);
  useEffect(() => {
    if (actor.current !== null && actor.current !== (session.user?.id ?? null))
      void clearOutbox().catch(() => {
        setPrivacyError('Не удалось очистить очередь. Закройте другие вкладки.');
      });
    actor.current = session.user?.id ?? null;
  }, [session.user?.id]);
  useEffect(() => {
    if (!session.user) return;
    const idleMs = 15 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void logout();
      }, idleMs);
    };
    const checkVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivity >= idleMs)
        void logout();
    };
    let lastActivity = Date.now();
    let lastPing = Date.now();
    const activity = () => {
      if (Date.now() - lastActivity >= idleMs) {
        void logout();
        return;
      }
      lastActivity = Date.now();
      reset();
      // Only actual user activity keeps server-side idle expiry alive.
      if (Date.now() - lastPing > 60_000) {
        lastPing = Date.now();
        void sessionClient.request('/api/auth/me', PrincipalSchema).catch(() => undefined);
      }
    };
    reset();
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', checkVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', checkVisibility);
    };
  }, [session.user?.id]);
  return <Context.Provider value={{ logout, privacyError }}>{children}</Context.Provider>;
}
export function useSession() {
  const context = useContext(Context);
  const session = useSyncExternalStore(sessionClient.subscribe, sessionClient.getSnapshot);
  if (!context) throw new Error('SessionProvider is required');
  return { ...session, ...context };
}
