import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

let sequence = 0;
async function load(pathname) {
  const calls = [];
  const window = {
    location: { pathname },
    history: { replaceState: (...args) => calls.push(args) },
  };
  globalThis.window = window;
  try {
    // Import only our own checked-in bootstrap, with a fresh module instance.
    await import(
      new URL(`../apps/web/public/invite-bootstrap.js?case=${sequence++}`, import.meta.url).href
    );
    return { window, calls };
  } finally {
    delete globalThis.window;
  }
}
test('clears the URL and history state synchronously, exposing a token only once', async () => {
  const token = randomBytes(32).toString('base64url');
  const { window, calls } = await load(`/i/${token}`);
  assert.deepEqual(calls, [[null, '', '/invite']]);
  assert.equal(window.takeCompassInvite(), token);
  assert.equal(window.takeCompassInvite(), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(window, 'takeCompassInvite').writable, false);
});
test('also strips invalid invite paths without accepting malformed tokens', async () => {
  const { window, calls } = await load('/i/not-a-valid-token');
  assert.deepEqual(calls, [[null, '', '/invite']]);
  assert.equal(window.takeCompassInvite(), undefined);
});
test('ordinary navigation does not change browser history', async () => {
  const { window, calls } = await load('/login');
  assert.deepEqual(calls, []);
  assert.equal(window.takeCompassInvite(), undefined);
});
