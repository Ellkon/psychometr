import { describe, expect, it } from 'vitest';
import { AlertHub, pickReserve } from './alerts.js';

describe('reserve recipient (FR-8.3)', () => {
  it('takes the next care-team member in assignment order', () => {
    expect(pickReserve(['a', 'b', 'c'], 'a')).toBe('b');
  });

  it('never picks the current recipient, and returns null when there is nobody else', () => {
    expect(pickReserve(['a'], 'a')).toBeNull();
    expect(pickReserve(['b', 'a'], 'a')).toBe('b');
  });
});

describe('socket registry', () => {
  const socket = () => ({ send: () => undefined, close: () => undefined });
  const live = () => Promise.resolve(true);

  it('caps the number of sockets per doctor', () => {
    const hub = new AlertHub();
    for (let i = 0; i < 10; i++) expect(hub.register('doctor', socket(), live)).toBe(true);
    expect(hub.register('doctor', socket(), live)).toBe(false);
    expect(hub.connected('doctor')).toHaveLength(10);
  });

  it('forgets a socket on unregister and keeps other doctors apart', () => {
    const hub = new AlertHub();
    const mine = socket();
    hub.register('doctor', mine, live);
    hub.register('other', socket(), live);
    hub.unregister('doctor', mine);
    expect(hub.connected('doctor')).toHaveLength(0);
    expect(hub.connected('other')).toHaveLength(1);
  });
});
