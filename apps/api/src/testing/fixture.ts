import { randomUUID } from 'node:crypto';
import { inject, onTestFinished } from 'vitest';
import {
  AuthResponseSchema,
  CreatedInviteSchema,
  CreatedPatientSchema,
  type ConsentDocument,
} from '@psychometr/shared';
import { buildApp } from '../app.js';
import { connectDatabase } from '../db/client.js';
import { practitioners, users } from '../db/schema.js';
import { hashCredential, newInviteCode, newOpaqueToken } from '../security/credentials.js';
import { testEnv } from './env.js';
import { DEVICE_COOKIE, REFRESH_COOKIE } from '../routes/access.js';

export const TEST_CONSENT: ConsentDocument = {
  version: 'synthetic-test-v1',
  text: 'Синтетический тестовый документ. Не использовать как согласие для реальных пациентов.',
};
export const TEST_IDENTITY = {
  firstName: 'Синтетический',
  lastName: 'Тестовый',
  middleName: null,
  phone: '+70000000000',
  birthDate: '2000-01-01',
  snils: null,
};

export async function fixture(withConsent = true) {
  const connection = connectDatabase(inject('databaseUrl'));
  const env = testEnv(inject('databaseUrl'));
  let clock = new Date();
  const app = await buildApp({
    env,
    db: connection.db,
    silent: true,
    consent: withConsent ? TEST_CONSENT : undefined,
    clock: () => clock,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await connection.pool.end();
  };
  onTestFinished(close);
  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    accessToken?: string,
    body?: unknown,
    cookies?: Record<string, string>,
    origin = env.PUBLIC_ORIGIN,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      ...(cookies ? { cookies } : {}),
    });
  const password = newOpaqueToken();
  const credentialHash = await hashCredential(password);
  const staff = async (role: 'doctor' | 'admin') => {
    const email = `${randomUUID()}@example.test`;
    const [user] = await connection.db
      .insert(users)
      .values({ email, role, credentialHash })
      .returning();
    if (!user) throw new Error('Test user insert failed');
    if (role === 'doctor') await connection.db.insert(practitioners).values({ userId: user.id });
    const response = await request('POST', '/api/auth/login', undefined, { email, password });
    const login = AuthResponseSchema.parse(response.json<unknown>());
    const refresh = response.cookies.find((item) => item.name === REFRESH_COOKIE)?.value;
    if (!refresh) throw new Error('No refresh cookie');
    return { ...login, email, password, refresh, raw: response };
  };
  const doctor = await staff('doctor'),
    otherDoctor = await staff('doctor'),
    admin = await staff('admin');
  const createPatient = async (token: string) => {
    const response = await request('POST', '/api/patients', token, { identity: TEST_IDENTITY });
    return CreatedPatientSchema.parse(response.json<unknown>()).id;
  };
  const patientId = await createPatient(doctor.accessToken),
    otherPatientId = await createPatient(otherDoctor.accessToken);
  const invite = async (id = patientId, doctorToken = doctor.accessToken) => {
    const response = await request('POST', `/api/patients/${id}/invites`, doctorToken, {});
    const invitation = CreatedInviteSchema.parse(response.json<unknown>());
    const token = new URL(invitation.url).pathname.split('/').at(-1);
    if (!token) throw new Error('No invite token');
    return { ...invitation, token };
  };
  const enroll = async (id = patientId, doctorToken = doctor.accessToken) => {
    const invitation = await invite(id, doctorToken),
      personalCode = newInviteCode();
    const response = await request('POST', '/api/auth/invites/accept', undefined, {
      token: invitation.token,
      code: invitation.code,
      personalCode,
      consentVersion: TEST_CONSENT.version,
      consentAccepted: true,
    });
    const login = AuthResponseSchema.parse(response.json<unknown>());
    const device = response.cookies.find((item) => item.name === DEVICE_COOKIE)?.value;
    const refresh = response.cookies.find((item) => item.name === REFRESH_COOKIE)?.value;
    if (!device || !refresh) throw new Error('Missing patient cookies');
    return { ...login, device, refresh, personalCode, invitation, raw: response };
  };
  return {
    app,
    db: connection.db,
    env,
    doctor,
    otherDoctor,
    admin,
    patientId,
    otherPatientId,
    invite,
    enroll,
    request,
    password,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    close,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
