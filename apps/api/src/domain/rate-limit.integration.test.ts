import { describe, expect, it } from 'vitest';
import { fixture } from '../testing/fixture.js';

/* NAT: one clinic IP, many users. The global limit counts a verified user, not the IP. */
describe('global rate limit', () => {
  it('one user exhausting the limit does not throttle another user behind the same IP', async () => {
    const f = await fixture();
    let last = 0;
    for (let i = 0; i < 301; i++)
      last = (await f.request('GET', '/api/auth/me', f.doctor.accessToken)).statusCode;
    expect(last).toBe(429);
    expect((await f.request('GET', '/api/auth/me', f.otherDoctor.accessToken)).statusCode).toBe(
      200,
    );
  });

  it('a forged token is counted by IP, so it cannot open a fresh bucket', async () => {
    const f = await fixture();
    let last = 0;
    for (let i = 0; i < 301; i++)
      last = (await f.request('GET', '/api/auth/me', `forged.${String(i)}.token`)).statusCode;
    expect(last).toBe(429);
  });
});
