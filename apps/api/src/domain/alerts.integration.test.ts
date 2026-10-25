import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import WebSocket, { type RawData } from 'ws';
import { AlertListSchema, RegistrySchema, TimelineSchema, type Alert } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { alerts, auditEvents, careTeam, sessions } from '../db/schema.js';
import { REFRESH_COOKIE } from '../routes/access.js';
import { IdentityVault } from '../security/identity.js';
import { AlertHub, AlertService } from './alerts.js';
import { loadScaleCatalog } from './scales.js';

/* Stage 6: critical alerts (FR-8), outbox states, escalation, WebSocket delivery. */
let f: Fixture;
let patient: string;
beforeEach(async () => {
  f = await fixture();
  // Real content rules: the item-9 alert must come from content/rules/safety.json.
  const assigned = await f.request(
    'PUT',
    `/api/patients/${f.patientId}/scales/phq9/schedule`,
    f.doctor.accessToken,
    { intervalDays: 14, windowDays: 7, active: true },
  );
  expect(assigned.statusCode).toBe(200);
  patient = (await f.enroll()).accessToken;
});

/** A separate service over the same database, for driving ticks at explicit times. */
function service(hub = new AlertHub()) {
  return new AlertService(
    f.db,
    new IdentityVault(Buffer.from(f.env.APP_ENCRYPTION_KEY, 'base64')),
    hub,
  );
}

async function submitItem9(item9: number) {
  const loaded = (await loadScaleCatalog()).scales.get('phq9');
  if (!loaded) throw new Error('missing phq9');
  const answers = Object.fromEntries(
    loaded.file.items.map((item) => [item.id, item.id === 'phq9_09' ? item9 : 0]),
  );
  return f.request('POST', `/api/patients/${f.patientId}/scales/phq9/responses`, patient, {
    submissionId: randomUUID(),
    answers,
    functionalAnswer: 0,
  });
}

async function listAs(token: string): Promise<Alert[]> {
  const response = await f.request('GET', '/api/alerts', token);
  expect(response.statusCode).toBe(200);
  return AlertListSchema.parse(response.json<unknown>()).alerts;
}

async function alertRows() {
  return f.db.select().from(alerts).where(eq(alerts.patientId, f.patientId));
}

async function auditCount(action: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, f.patientId)));
  return row?.n ?? 0;
}

function idOf(alert: { id: string } | undefined): string {
  if (!alert) throw new Error('alert missing');
  return alert.id;
}

/** Message of a database error, including the driver's wrapped cause (the trigger text lives there). */
async function dbError(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    if (!(error instanceof Error)) return String(error);
    const cause = (error as { cause?: unknown }).cause;
    return `${error.message} ${cause instanceof Error ? cause.message : ''}`;
  }
}

describe('creating critical alerts (FR-8.1 outbox in the same transaction)', () => {
  it('a positive item-9 answer creates one alert for the primary doctor only', async () => {
    expect((await submitItem9(1)).statusCode).toBe(201);

    const mine = await listAs(f.doctor.accessToken);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      ruleId: 'phq9_item9_positive',
      severity: 'critical',
      status: 'pending',
      patientId: f.patientId,
      acknowledgedAt: null,
      escalatedFrom: null,
    });
    expect(await listAs(f.otherDoctor.accessToken)).toHaveLength(0);
  });

  it('item 9 = 0 creates no alert', async () => {
    expect((await submitItem9(0)).statusCode).toBe(201);
    expect(await alertRows()).toHaveLength(0);
  });

  it('each positive answer is a new evaluation, so it creates its own alert', async () => {
    await submitItem9(1);
    await submitItem9(2);
    expect(await alertRows()).toHaveLength(2);
  });
});

describe('acknowledgement (only by the recipient)', () => {
  it('the recipient acknowledges once; a repeat is harmless and audited once', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    if (!alert) throw new Error('no alert');

    const first = await f.request('POST', `/api/alerts/${alert.id}/ack`, f.doctor.accessToken, {});
    expect(first.statusCode).toBe(200);
    const second = await f.request('POST', `/api/alerts/${alert.id}/ack`, f.doctor.accessToken, {});
    expect(second.statusCode).toBe(200);

    expect(await listAs(f.doctor.accessToken)).toHaveLength(0);
    expect(await auditCount('alert.acknowledged')).toBe(1);
  });

  it('another doctor gets 404 (existence is not revealed); the patient gets 403', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    if (!alert) throw new Error('no alert');

    const stranger = await f.request(
      'POST',
      `/api/alerts/${alert.id}/ack`,
      f.otherDoctor.accessToken,
      {},
    );
    expect(stranger.statusCode).toBe(404);
    const asPatient = await f.request('POST', `/api/alerts/${alert.id}/ack`, patient, {});
    expect(asPatient.statusCode).toBe(403);
    const anonymous = await f.request('POST', `/api/alerts/${alert.id}/ack`, undefined, {});
    expect(anonymous.statusCode).toBe(401);
  });

  it('the list is closed to the patient and to anonymous callers', async () => {
    expect((await f.request('GET', '/api/alerts', patient)).statusCode).toBe(403);
    expect((await f.request('GET', '/api/alerts')).statusCode).toBe(401);
  });
});

describe('escalation to a reserve doctor (FR-8.3)', () => {
  async function addReserve() {
    await f.db.insert(careTeam).values({
      patientId: f.patientId,
      practitionerId: f.otherDoctor.user.id,
    });
  }

  it('an unacknowledged alert is copied to the reserve after 30 minutes, once', async () => {
    await addReserve();
    await submitItem9(1);
    const [primary] = await listAs(f.doctor.accessToken);
    if (!primary) throw new Error('no alert');

    const svc = service();
    await svc.tick(new Date(Date.now() + 29 * 60_000));
    expect(await alertRows()).toHaveLength(1);
    await svc.tick(new Date(Date.now() + 31 * 60_000));
    await svc.tick(new Date(Date.now() + 90 * 60_000));

    const copy = await listAs(f.otherDoctor.accessToken);
    expect(copy).toHaveLength(1);
    expect(copy[0]).toMatchObject({ ruleId: 'phq9_item9_positive', escalatedFrom: primary.id });
    // The primary stays open: it was not acknowledged.
    expect(await listAs(f.doctor.accessToken)).toHaveLength(1);
    expect(await alertRows()).toHaveLength(2);

    const ack = await f.request(
      'POST',
      `/api/alerts/${idOf(copy[0])}/ack`,
      f.otherDoctor.accessToken,
      {},
    );
    expect(ack.statusCode).toBe(200);
  });

  it('an alert acknowledged before the timer is never escalated', async () => {
    await addReserve();
    await submitItem9(1);
    const [primary] = await listAs(f.doctor.accessToken);
    await f.request('POST', `/api/alerts/${idOf(primary)}/ack`, f.doctor.accessToken, {});

    await service().tick(new Date(Date.now() + 60 * 60_000));
    expect(await listAs(f.otherDoctor.accessToken)).toHaveLength(0);
    expect(await auditCount('alert.escalated')).toBe(0);
  });

  it('without a reserve the timer is cleared and the gap is audited once', async () => {
    await submitItem9(1);
    const svc = service();
    await svc.tick(new Date(Date.now() + 31 * 60_000));
    await svc.tick(new Date(Date.now() + 120 * 60_000));

    expect(await alertRows()).toHaveLength(1);
    expect(await auditCount('alert.escalation_unavailable')).toBe(1);
    expect(await listAs(f.doctor.accessToken)).toHaveLength(1);
  });
});

describe('delivery states and database guards (FR-8.2)', () => {
  it('pending → sent → delivered → acknowledged, each with its own timestamp', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    if (!alert) throw new Error('no alert');
    const hub = new AlertHub();
    const sent: string[] = [];
    hub.register(
      f.doctor.user.id,
      {
        send: (data: string) => sent.push(data),
        close: () => undefined,
      },
      () => Promise.resolve(true),
    );
    const svc = service(hub);

    expect(await svc.dispatch(new Date())).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(alert.id);
    expect(sent[0]).not.toContain(f.doctor.user.id);
    const afterSend = (await alertRows())[0];
    expect(afterSend?.status).toBe('sent');
    expect(afterSend?.sentAt).toBeInstanceOf(Date);

    await svc.markReceived(f.doctor.user.id, alert.id);
    const delivered = (await alertRows())[0];
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);

    await f.request('POST', `/api/alerts/${alert.id}/ack`, f.doctor.accessToken, {});
    const acknowledged = (await alertRows())[0];
    expect(acknowledged?.status).toBe('acknowledged');
    expect(acknowledged?.acknowledgedAt).toBeInstanceOf(Date);
    expect(acknowledged?.acknowledgedBy).toBe(f.doctor.user.id);
  });

  it('without a socket the alert waits as pending and goes out on connect', async () => {
    await submitItem9(1);
    const svc = service();
    expect(await svc.dispatch(new Date())).toBe(0);
    expect((await alertRows())[0]?.status).toBe('pending');

    const sent: string[] = [];
    expect(
      await svc.flushFor(f.doctor.user.id, { send: (d) => sent.push(d), close: () => undefined }),
    ).toBe(1);
    expect(sent).toHaveLength(1);
    expect((await alertRows())[0]?.status).toBe('sent');
  });

  it('a sent but unacknowledged alert is re-sent only after the retry delay', async () => {
    await submitItem9(1);
    const hub = new AlertHub();
    const sent: string[] = [];
    hub.register(f.doctor.user.id, { send: (d) => sent.push(d), close: () => undefined }, () =>
      Promise.resolve(true),
    );
    const svc = service(hub);
    const t0 = new Date();
    await svc.dispatch(t0);
    expect(await svc.dispatch(new Date(t0.getTime() + 5_000))).toBe(0);
    expect(await svc.dispatch(new Date(t0.getTime() + 31_000))).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('the database refuses a backward status change', async () => {
    await submitItem9(1);
    const [row] = await alertRows();
    if (!row) throw new Error('no alert');
    await f.db
      .update(alerts)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(alerts.id, row.id));
    await f.db
      .update(alerts)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(alerts.id, row.id));
    expect(
      await dbError(f.db.update(alerts).set({ status: 'pending' }).where(eq(alerts.id, row.id))),
    ).toMatch(/cannot move backwards/);
  });

  it('the database refuses changes to alert content and to set timestamps again', async () => {
    await submitItem9(1);
    const [row] = await alertRows();
    if (!row) throw new Error('no alert');
    // Two layers: the application role has no column grant on content (permission denied), and
    // the trigger would reject it as well for any role that does.
    expect(
      await dbError(f.db.update(alerts).set({ message: 'changed' }).where(eq(alerts.id, row.id))),
    ).toMatch(/permission denied|immutable/);
    await f.db
      .update(alerts)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(alerts.id, row.id));
    expect(
      await dbError(
        f.db
          .update(alerts)
          .set({ sentAt: new Date(0) })
          .where(eq(alerts.id, row.id)),
      ),
    ).toMatch(/timestamps are immutable/);
  });

  it('the database refuses deleting alerts', async () => {
    await submitItem9(1);
    await expect(f.db.delete(alerts).where(eq(alerts.patientId, f.patientId))).rejects.toThrow();
  });
});

describe('WebSocket delivery (FR-8.1)', () => {
  async function serve(): Promise<number> {
    await f.app.listen({ port: 0, host: '127.0.0.1' });
    const address = f.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  function text(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
  }

  /** Resolves with the next parsed message, or rejects if the socket closes first. */
  function nextMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      socket.once('message', (data: RawData) => {
        resolve(JSON.parse(text(data)) as unknown);
      });
      socket.once('close', (code: number) => {
        reject(new Error(`closed ${String(code)}`));
      });
    });
  }

  function closed(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      socket.once('close', (code: number) => {
        resolve(code);
      });
    });
  }

  function open(port: number, origin: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, { headers: { origin } });
      socket.once('open', () => {
        resolve(socket);
      });
      socket.once('error', reject);
    });
  }

  it('refuses a socket from another origin before the upgrade', async () => {
    const port = await serve();
    await expect(open(port, 'https://evil.example')).rejects.toThrow();
  });

  it('a socket that drops during authentication is never registered', async () => {
    const port = await serve();
    // More drops than the per-doctor cap: leaked entries would lock the doctor out.
    for (let i = 0; i < 12; i++) {
      const socket = await open(port, f.env.PUBLIC_ORIGIN);
      socket.send(JSON.stringify({ type: 'auth', token: f.doctor.accessToken }));
      socket.terminate();
    }
    // The server finishes the session checks after the clients are gone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(f.app.alerts.hub.connected(f.doctor.user.id)).toHaveLength(0);
    const socket = await open(port, f.env.PUBLIC_ORIGIN);
    try {
      socket.send(JSON.stringify({ type: 'auth', token: f.doctor.accessToken }));
      expect(await nextMessage(socket)).toEqual({ type: 'ready' });
    } finally {
      socket.close();
    }
  });

  it('a doctor authenticates by message, gets pending alerts and confirms receipt', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    if (!alert) throw new Error('no alert');
    const port = await serve();
    const socket = await open(port, f.env.PUBLIC_ORIGIN);
    try {
      socket.send(JSON.stringify({ type: 'auth', token: f.doctor.accessToken }));
      expect(await nextMessage(socket)).toEqual({ type: 'ready' });
      const pushed = (await nextMessage(socket)) as { type: string; alert: Alert };
      expect(pushed.type).toBe('alert');
      expect(pushed.alert.id).toBe(alert.id);

      socket.send(JSON.stringify({ type: 'received', alertId: alert.id }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await alertRows())[0]?.status).toBe('delivered');
    } finally {
      socket.close();
    }
  });

  it('a patient token is closed with 4403; a message before auth is closed with 4401', async () => {
    const port = await serve();
    const asPatient = await open(port, f.env.PUBLIC_ORIGIN);
    asPatient.send(JSON.stringify({ type: 'auth', token: patient }));
    expect(await closed(asPatient)).toBe(4403);

    const anonymous = await open(port, f.env.PUBLIC_ORIGIN);
    anonymous.send(JSON.stringify({ type: 'received', alertId: f.patientId }));
    expect(await closed(anonymous)).toBe(4401);
  });

  it('a bad token is closed with 4401', async () => {
    const port = await serve();
    const socket = await open(port, f.env.PUBLIC_ORIGIN);
    socket.send(JSON.stringify({ type: 'auth', token: 'not-a-token' }));
    expect(await closed(socket)).toBe(4401);
  });

  it('closes an open socket with 4401 once its session is revoked, and keeps a live one', async () => {
    await submitItem9(1);
    const port = await serve();
    const socket = await open(port, f.env.PUBLIC_ORIGIN);
    try {
      socket.send(JSON.stringify({ type: 'auth', token: f.doctor.accessToken }));
      expect(await nextMessage(socket)).toEqual({ type: 'ready' });
      f.advance(31_000);
      expect(await f.app.alerts.sweepSockets()).toBe(0);

      const closing = closed(socket);
      const logout = await f.request(
        'POST',
        '/api/auth/logout',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
      );
      expect(logout.statusCode).toBe(200);
      // Logout asks for an immediate re-check: no 30-second window with live alerts (audit F9).
      expect(await f.app.alerts.sweepSockets()).toBe(1);
      expect(await closing).toBe(4401);
    } finally {
      socket.close();
    }
  });

  it('socket authentication does not extend the session idle timeout', async () => {
    const idleOf = () =>
      f.db
        .select({ id: sessions.id, idle: sessions.idleExpiresAt })
        .from(sessions)
        .where(eq(sessions.userId, f.doctor.user.id));
    const before = await idleOf();
    expect(before.length).toBeGreaterThan(0);
    const port = await serve();
    const socket = await open(port, f.env.PUBLIC_ORIGIN);
    try {
      socket.send(JSON.stringify({ type: 'auth', token: f.doctor.accessToken }));
      expect(await nextMessage(socket)).toEqual({ type: 'ready' });
    } finally {
      socket.close();
    }
    expect(await idleOf()).toEqual(before);
  });
});

describe('care-team revocation stops alerts at once (S-2)', () => {
  it('a doctor removed from the care team loses the open alert: list, ack and delivery', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    expect(alert).toBeDefined();

    const removed = await f.request(
      'DELETE',
      `/api/admin/care-team/${f.patientId}/${f.doctor.user.id}`,
      f.admin.accessToken,
    );
    expect(removed.statusCode).toBe(200);

    expect(await listAs(f.doctor.accessToken)).toEqual([]);
    const ack = await f.request('POST', `/api/alerts/${idOf(alert)}/ack`, f.doctor.accessToken, {});
    expect(ack.statusCode).toBe(404);
    expect((await alertRows())[0]?.status).toBe('pending');

    const hub = new AlertHub();
    const sent: string[] = [];
    hub.register(
      f.doctor.user.id,
      { send: (data: string) => sent.push(data), close: () => undefined },
      () => Promise.resolve(true),
    );
    await service(hub).dispatch(new Date());
    expect(sent).toEqual([]);
  });
});

describe('parallel requests and retries', () => {
  it('twenty parallel acknowledgements of one alert succeed and are audited once', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        f.request('POST', `/api/alerts/${idOf(alert)}/ack`, f.doctor.accessToken, {}),
      ),
    );
    expect(results.map((result) => result.statusCode)).toEqual(Array(20).fill(200));
    expect(await auditCount('alert.acknowledged')).toBe(1);
  });

  it('ten parallel retries of one PHQ-9 submission raise exactly one alert', async () => {
    const loaded = (await loadScaleCatalog()).scales.get('phq9');
    if (!loaded) throw new Error('missing phq9');
    const body = {
      submissionId: randomUUID(),
      answers: Object.fromEntries(
        loaded.file.items.map((item) => [item.id, item.id === 'phq9_09' ? 2 : 0]),
      ),
      functionalAnswer: 0,
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        f.request('POST', `/api/patients/${f.patientId}/scales/phq9/responses`, patient, body),
      ),
    );
    expect(results.every((result) => result.statusCode < 300)).toBe(true);
    expect(await alertRows()).toHaveLength(1);
    expect(await auditCount('alert.created')).toBe(1);
  });

  it('parallel worker ticks deliver and escalate each alert once', async () => {
    await f.db.insert(careTeam).values({
      patientId: f.patientId,
      practitionerId: f.otherDoctor.user.id,
    });
    await submitItem9(1);
    const later = new Date(Date.now() + 31 * 60_000);
    await Promise.all(Array.from({ length: 5 }, () => service().escalate(later)));
    const rows = await alertRows();
    expect(rows.filter((row) => row.escalationOf !== null)).toHaveLength(1);
    expect(await auditCount('alert.escalated')).toBe(1);
  });
});

describe('registry and timeline show alerts (FR-7.1, FR-7.2)', () => {
  it('an open alert is counted in the registry and listed in the timeline until acknowledged', async () => {
    await submitItem9(1);
    const registry = await f.request('GET', '/api/registry', f.doctor.accessToken);
    expect(registry.statusCode).toBe(200);
    const row = RegistrySchema.parse(registry.json<unknown>()).patients.find(
      (item) => item.patientId === f.patientId,
    );
    expect(row?.openAlerts).toBe(1);

    const [alert] = await listAs(f.doctor.accessToken);
    await f.request('POST', `/api/alerts/${idOf(alert)}/ack`, f.doctor.accessToken, {});
    const after = RegistrySchema.parse(
      (await f.request('GET', '/api/registry', f.doctor.accessToken)).json<unknown>(),
    ).patients.find((item) => item.patientId === f.patientId);
    expect(after?.openAlerts).toBe(0);

    const timeline = TimelineSchema.parse(
      (
        await f.request('GET', `/api/patients/${f.patientId}/timeline`, f.doctor.accessToken)
      ).json<unknown>(),
    );
    expect(timeline.events.find((event) => event.kind === 'alert')).toMatchObject({
      ruleId: 'phq9_item9_positive',
      status: 'acknowledged',
      escalation: false,
    });
  });
});

describe('Prometheus metrics (NFR-3)', () => {
  it('exposes alert delivery timings and route patterns, never patient ids', async () => {
    await submitItem9(1);
    const [alert] = await listAs(f.doctor.accessToken);
    await f.request('POST', `/api/alerts/${idOf(alert)}/ack`, f.doctor.accessToken, {});
    await f.request('GET', `/api/patients/${f.patientId}/timeline`, f.doctor.accessToken);

    const response = await f.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('compass_alert_acknowledgement_seconds_count 1');
    expect(response.body).toContain('compass_alert_delivery_seconds');
    expect(response.body).toContain('route="/api/patients/:patientId/timeline"');
    expect(response.body).not.toContain(f.patientId);
  });
});

describe('only the answered scale re-runs its rules (audit F1)', () => {
  it('a GAD-7 answer after a positive PHQ-9 item 9 raises no further alert', async () => {
    const gad7 = await f.request(
      'PUT',
      `/api/patients/${f.patientId}/scales/gad7/schedule`,
      f.doctor.accessToken,
      { intervalDays: 14, windowDays: 7, active: true },
    );
    expect(gad7.statusCode).toBe(200);
    expect((await submitItem9(1)).statusCode).toBe(201);
    const loaded = (await loadScaleCatalog()).scales.get('gad7');
    if (!loaded) throw new Error('missing gad7');
    for (let i = 0; i < 2; i++) {
      const response = await f.request(
        'POST',
        `/api/patients/${f.patientId}/scales/gad7/responses`,
        patient,
        {
          submissionId: randomUUID(),
          answers: Object.fromEntries(loaded.file.items.map((item) => [item.id, 0])),
          functionalAnswer: null,
        },
      );
      expect(response.statusCode).toBe(201);
    }
    expect(await alertRows()).toHaveLength(1);
  });
});

describe('dispatcher robustness (audit F2, F3)', () => {
  it('a backlog for an offline doctor does not starve a connected one', async () => {
    await submitItem9(1);
    const [evaluation] = await f.db
      .select({ id: alerts.evaluationId })
      .from(alerts)
      .where(eq(alerts.patientId, f.patientId));
    if (!evaluation) throw new Error('no evaluation');
    const old = new Date(Date.now() - 3_600_000);
    await f.db.insert(alerts).values(
      Array.from({ length: 120 }, (_, i) => ({
        patientId: f.otherPatientId,
        recipientId: f.otherDoctor.user.id,
        evaluationId: evaluation.id,
        ruleId: 'phq9_item9_positive',
        severity: 'critical',
        message: 'm',
        suggestedAction: 's',
        status: 'pending' as const,
        idempotencyKey: `backlog-${randomUUID()}-${String(i)}`,
        createdAt: new Date(old.getTime() + i),
      })),
    );
    const hub = new AlertHub();
    const sent: string[] = [];
    hub.register(
      f.doctor.user.id,
      { send: (data: string) => sent.push(data), close: () => undefined },
      () => Promise.resolve(true),
    );
    expect(await service(hub).dispatch(new Date())).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('a row acknowledged after it was read is skipped, not a failed tick', async () => {
    await submitItem9(1);
    const [stale] = await alertRows();
    if (!stale) throw new Error('no alert');
    expect(
      (await f.request('POST', `/api/alerts/${stale.id}/ack`, f.doctor.accessToken, {})).statusCode,
    ).toBe(200);
    const sent: string[] = [];
    const internals = service() as unknown as {
      deliver(row: typeof stale, sockets: unknown[], now: Date): Promise<boolean>;
    };
    await expect(
      internals.deliver(
        stale,
        [{ send: (data: string) => sent.push(data), close: () => undefined }],
        new Date(),
      ),
    ).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect((await alertRows())[0]?.status).toBe('acknowledged');
  });
});

describe('removing a doctor reroutes open alerts at once (audit F5)', () => {
  it('the open alert of a removed doctor goes to the remaining doctor at the next tick', async () => {
    await f.db.insert(careTeam).values({
      patientId: f.patientId,
      practitionerId: f.otherDoctor.user.id,
    });
    await submitItem9(1);
    const removed = await f.request(
      'DELETE',
      `/api/admin/care-team/${f.patientId}/${f.doctor.user.id}`,
      f.admin.accessToken,
    );
    expect(removed.statusCode).toBe(200);
    expect(await service().escalate(new Date())).toBe(1);
    const reserve = await listAs(f.otherDoctor.accessToken);
    expect(reserve).toHaveLength(1);
    expect(reserve[0]?.escalatedFrom).not.toBeNull();
  });
});

describe('receipt confirmations are bound to the recipient (audit F10)', () => {
  it("another doctor cannot mark someone else's alert as delivered", async () => {
    await submitItem9(1);
    const hub = new AlertHub();
    hub.register(f.doctor.user.id, { send: () => undefined, close: () => undefined }, () =>
      Promise.resolve(true),
    );
    await service(hub).dispatch(new Date());
    const [row] = await alertRows();
    expect(row?.status).toBe('sent');
    await f.app.alerts.markReceived(f.otherDoctor.user.id, idOf(row));
    expect((await alertRows())[0]?.status).toBe('sent');
    await f.app.alerts.markReceived(f.doctor.user.id, idOf(row));
    expect((await alertRows())[0]?.status).toBe('delivered');
  });
});
