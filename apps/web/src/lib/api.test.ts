import { describe, expect, it, vi } from 'vitest';
import { SuccessSchema } from '@psychometr/shared';
import { SessionClient, type LogoutMarker } from './api.js';

const user = { id: crypto.randomUUID(), role: 'doctor', patientId: null };
const login = () => Response.json({ accessToken: 'synthetic-access-token', expiresIn: 900, user });
const denied = () =>
  Response.json({ error: { code: 'unauthorized', message: 'Войдите' } }, { status: 401 });

describe('in-memory session transport', () => {
  it('coalesces refresh requests and uses only same-origin, non-cached transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(login()));
    const client = new SessionClient(fetcher);
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(client.getSnapshot().user).toEqual(user);
    await expect(client.publicRequest('https://attacker.test', SuccessSchema)).rejects.toThrow(
      'same-origin',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('blocks automatic restoration after offline logout until server logout succeeds', async () => {
    let pending = false;
    const marker: LogoutMarker = {
      pending: () => pending,
      set: (value) => {
        pending = value;
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const client = new SessionClient(fetcher, marker);
    await expect(client.logout()).rejects.toThrow('offline');
    expect(pending).toBe(true);
    expect(client.getSnapshot().user).toBeNull();
    await expect(client.refresh()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(Response.json({ ok: true }));
    await client.logout();
    expect(pending).toBe(false);
  });
  it('does not resurrect a session when a refresh finishes after logout', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new SessionClient(fetcher);
    const refresh = client.refresh();
    const logout = client.logout();
    release(login());
    await expect(refresh).rejects.toThrow('Сессия завершена');
    await logout;
    expect(client.getSnapshot().user).toBeNull();
  });
  it('drops responses from the old session after logout', async () => {
    let release: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(login())
      .mockReturnValueOnce(response)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new SessionClient(fetcher);
    await client.refresh();
    const request = client.request('/api/protected', SuccessSchema);
    await client.logout();
    release(Response.json({ ok: true }));
    await expect(request).rejects.toThrow('Сессия завершена');
  });
  it('does not log out solely because a network request failed', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(login())
      .mockRejectedValueOnce(new Error('offline'));
    const client = new SessionClient(fetcher);
    await client.refresh();
    await expect(client.refresh()).rejects.toThrow('offline');
    expect(client.getSnapshot().user).toEqual(user);
  });
  it('clears the identity on server revocation and rejects unvalidated responses', async () => {
    const boundary = vi.fn<() => void>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(denied());
    const client = new SessionClient(fetcher, undefined, boundary);
    await client.refresh();
    await expect(client.refresh()).rejects.toThrow();
    expect(client.getSnapshot().user).toBeNull();
    expect(boundary).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(Response.json({ accessToken: 'not-a-contract' }));
    await expect(client.refresh()).rejects.toThrow('некорректный ответ');
  });
});

it('a failed anonymous restore does not invalidate a login queued behind it', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(denied())
    .mockResolvedValueOnce(login());
  const client = new SessionClient(fetcher);
  const restore = client.restore();
  const signIn = client.signIn('/api/auth/login', {
    email: 'test@example.test',
    password: 'synthetic-test-only',
  });
  await Promise.all([restore, signIn]);
  expect(client.getSnapshot().user).toEqual(user);
});
