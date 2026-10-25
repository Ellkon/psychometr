import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AcceptInviteSchema,
  AuthResponse,
  ConsentDocument,
  Principal,
} from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import {
  consents,
  patientDevices,
  patientInvites,
  patients,
  refreshTokens,
  sessions,
  users,
} from '../db/schema.js';
import {
  digest,
  hashCredential,
  newOpaqueToken,
  verifyCredential,
} from '../security/credentials.js';
import type { AccessTokens } from '../security/access-token.js';
import type { IdentityVault } from '../security/identity.js';
import { appendAudit } from './audit.js';
import { assertCanAccessPatient, lockPatient } from './access.js';
import {
  DomainError,
  invalidCredentials,
  invalidInvite,
  unauthorized,
  unwrap,
  type Outcome,
} from './errors.js';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const IDLE_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
export interface LoginResult {
  response: AuthResponse;
  refresh: string;
  device?: string;
}
type UserRow = typeof users.$inferSelect;
export interface AuthOptions {
  db: Database;
  tokens: AccessTokens;
  vault: IdentityVault;
  consent?: ConsentDocument;
  clock?: () => Date;
}

export class AuthService {
  private readonly now: () => Date;
  private constructor(
    private readonly options: AuthOptions,
    private readonly dummyHash: string,
  ) {
    this.now = options.clock ?? (() => new Date());
  }
  static async create(options: AuthOptions): Promise<AuthService> {
    return new AuthService(options, await hashCredential(newOpaqueToken()));
  }
  get consent(): ConsentDocument {
    if (!this.options.consent)
      throw new DomainError(
        503,
        'consent_unavailable',
        'Утверждённый текст согласия ещё не подключён. Обратитесь к врачу',
      );
    return this.options.consent;
  }
  private async principal(tx: Transaction, user: UserRow): Promise<Principal> {
    if (user.role !== 'patient') return { id: user.id, role: user.role, patientId: null };
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.userId, user.id));
    if (!patient) throw unauthorized();
    return { id: user.id, role: user.role, patientId: patient.id };
  }
  private async issue(tx: Transaction, user: UserRow, deviceId?: string): Promise<LoginResult> {
    const now = this.now();
    const [session] = await tx
      .insert(sessions)
      .values({
        userId: user.id,
        deviceId,
        expiresAt: new Date(now.getTime() + SESSION_MS),
        idleExpiresAt: new Date(now.getTime() + IDLE_MS),
      })
      .returning();
    if (!session) throw new Error('Session insert failed');
    const refresh = newOpaqueToken();
    await tx.insert(refreshTokens).values({ tokenHash: digest(refresh), sessionId: session.id });
    const principal = await this.principal(tx, user);
    return {
      response: {
        accessToken: await this.options.tokens.sign(user.id, session.id),
        expiresIn: 900,
        user: principal,
      },
      refresh,
    };
  }
  private async failed(tx: Transaction, user?: UserRow): Promise<Outcome<LoginResult>> {
    const now = this.now();
    if (user) {
      const attempts = (user.lockedUntil && user.lockedUntil <= now ? 0 : user.failedAttempts) + 1;
      const locked = attempts >= MAX_ATTEMPTS;
      await tx
        .update(users)
        .set({
          failedAttempts: Math.min(attempts, MAX_ATTEMPTS),
          lockedUntil: locked ? new Date(now.getTime() + LOCK_MS) : null,
        })
        .where(eq(users.id, user.id));
      await appendAudit(
        tx,
        { action: locked ? 'auth.locked' : 'auth.failed', actorId: user.id },
        now,
      );
    } else await appendAudit(tx, { action: 'auth.failed' }, now);
    return { error: invalidCredentials() };
  }
  async staffLogin(email: string, password: string): Promise<LoginResult> {
    const result = await this.options.db.transaction(async (tx): Promise<Outcome<LoginResult>> => {
      const [user] = await tx.select().from(users).where(eq(users.email, email)).for('update');
      const valid = await verifyCredential(user?.credentialHash ?? this.dummyHash, password);
      if (user?.lockedUntil && user.lockedUntil > this.now()) {
        await appendAudit(tx, { action: 'auth.failed', actorId: user.id }, this.now());
        return { error: invalidCredentials() };
      }
      if (!user || !valid || !user.active || user.role === 'patient') return this.failed(tx, user);
      await tx
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      const login = await this.issue(tx, user);
      await appendAudit(tx, { action: 'auth.login', actorId: user.id }, this.now());
      return { value: login };
    });
    return unwrap(result);
  }
  async acceptInvite(input: z.infer<typeof AcceptInviteSchema>, ip: string): Promise<LoginResult> {
    const consent = this.consent;
    if (input.consentVersion !== consent.version)
      throw new DomainError(
        409,
        'consent_changed',
        'Текст согласия изменился. Прочитайте актуальную версию',
      );
    const result = await this.options.db.transaction(async (tx): Promise<Outcome<LoginResult>> => {
      const [pointer] = await tx
        .select()
        .from(patientInvites)
        .where(eq(patientInvites.tokenHash, digest(input.token)));
      if (!pointer) {
        await verifyCredential(this.dummyHash, input.code);
        await appendAudit(tx, { action: 'invite.failed' }, this.now());
        return { error: invalidInvite() };
      }
      await lockPatient(tx, pointer.patientId);
      // Shared lock ordering: patient advisory lock -> user -> invite/session.
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, pointer.userId))
        .for('update');
      const [invite] = await tx
        .select()
        .from(patientInvites)
        .where(eq(patientInvites.id, pointer.id))
        .for('update');
      const now = this.now();
      if (
        !invite ||
        !user ||
        !user.active ||
        user.role !== 'patient' ||
        invite.status !== 'pending'
      ) {
        await appendAudit(tx, { action: 'invite.failed', resourceId: pointer.patientId }, now);
        return { error: invalidInvite() };
      }
      if (invite.expiresAt <= now) {
        await tx
          .update(patientInvites)
          .set({ status: 'expired' })
          .where(eq(patientInvites.id, invite.id));
        await appendAudit(tx, { action: 'invite.expired', resourceId: invite.patientId }, now);
        return { error: invalidInvite() };
      }
      if (!(await verifyCredential(invite.codeHash, input.code))) {
        const attempts = Math.min(invite.attempts + 1, MAX_ATTEMPTS);
        await tx
          .update(patientInvites)
          .set({ attempts, status: attempts >= MAX_ATTEMPTS ? 'blocked' : 'pending' })
          .where(eq(patientInvites.id, invite.id));
        await appendAudit(
          tx,
          {
            action: attempts >= MAX_ATTEMPTS ? 'invite.blocked' : 'invite.failed',
            resourceId: invite.patientId,
          },
          now,
        );
        return { error: invalidInvite() };
      }
      const principal: Principal = { id: user.id, role: 'patient', patientId: invite.patientId };
      // This principal is authenticated by the verified, single-use capability.
      await assertCanAccessPatient(principal, invite.patientId, tx);
      if (
        user.credentialHash &&
        !(await verifyCredential(user.credentialHash, input.personalCode))
      ) {
        // Binding another device never silently changes the patient's personal code.
        const attempts = Math.min(invite.attempts + 1, MAX_ATTEMPTS);
        await tx
          .update(patientInvites)
          .set({ attempts, status: attempts >= MAX_ATTEMPTS ? 'blocked' : 'pending' })
          .where(eq(patientInvites.id, invite.id));
        await appendAudit(
          tx,
          {
            action: attempts >= MAX_ATTEMPTS ? 'invite.blocked' : 'invite.failed',
            resourceId: invite.patientId,
          },
          now,
        );
        return { error: invalidInvite() };
      }
      if (!user.credentialHash)
        await tx
          .update(users)
          .set({
            credentialHash: await hashCredential(input.personalCode),
            failedAttempts: 0,
            lockedUntil: null,
          })
          .where(eq(users.id, user.id));
      const device = newOpaqueToken();
      const [binding] = await tx
        .insert(patientDevices)
        .values({
          userId: user.id,
          secretHash: digest(device),
          expiresAt: new Date(now.getTime() + SESSION_MS),
        })
        .returning();
      if (!binding) throw new Error('Device insert failed');
      const encryptedIp = this.options.vault.encryptConsentIp(
        invite.patientId,
        consent.version,
        ip,
      );
      await tx
        .insert(consents)
        .values({
          patientId: invite.patientId,
          version: consent.version,
          textHash: digest(consent.text),
          acceptedAt: now,
          ipCiphertext: encryptedIp.ciphertext,
          ipNonce: encryptedIp.nonce,
          ipAuthTag: encryptedIp.authTag,
        })
        .onConflictDoNothing();
      await tx
        .update(patientInvites)
        .set({ status: 'used', usedAt: now })
        .where(eq(patientInvites.id, invite.id));
      const login = await this.issue(tx, user, binding.id);
      await appendAudit(
        tx,
        { action: 'consent.accepted', actorId: user.id, resourceId: invite.patientId },
        now,
      );
      await appendAudit(
        tx,
        { action: 'invite.accepted', actorId: user.id, resourceId: invite.patientId },
        now,
      );
      await appendAudit(tx, { action: 'auth.login', actorId: user.id }, now);
      return { value: { ...login, device } };
    });
    return unwrap(result);
  }
  async patientLogin(deviceSecret: string, personalCode: string): Promise<LoginResult> {
    const result = await this.options.db.transaction(async (tx): Promise<Outcome<LoginResult>> => {
      const [pointer] = await tx
        .select()
        .from(patientDevices)
        .where(eq(patientDevices.secretHash, digest(deviceSecret)));
      if (!pointer) {
        await verifyCredential(this.dummyHash, personalCode);
        return this.failed(tx);
      }
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, pointer.userId))
        .for('update');
      const [device] = await tx
        .select()
        .from(patientDevices)
        .where(eq(patientDevices.id, pointer.id))
        .for('update');
      const now = this.now();
      const valid = await verifyCredential(user?.credentialHash ?? this.dummyHash, personalCode);
      if (user?.lockedUntil && user.lockedUntil > now) {
        await appendAudit(tx, { action: 'auth.failed', actorId: user.id }, now);
        return { error: invalidCredentials() };
      }
      if (
        !user ||
        !device ||
        !user.active ||
        user.role !== 'patient' ||
        !valid ||
        device.revokedAt ||
        device.expiresAt <= now
      )
        return this.failed(tx, user);
      await tx
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.deviceId, device.id), isNull(sessions.revokedAt)));
      const newDeviceSecret = newOpaqueToken();
      await tx
        .update(patientDevices)
        .set({
          secretHash: digest(newDeviceSecret),
          expiresAt: new Date(now.getTime() + SESSION_MS),
        })
        .where(eq(patientDevices.id, device.id));
      const login = await this.issue(tx, user, device.id);
      await appendAudit(tx, { action: 'auth.login', actorId: user.id }, now);
      return { value: { ...login, device: newDeviceSecret } };
    });
    return unwrap(result);
  }
  async refresh(secret: string): Promise<LoginResult> {
    const result = await this.options.db.transaction(async (tx): Promise<Outcome<LoginResult>> => {
      const [pointer] = await tx
        .select({ userId: sessions.userId, sessionId: sessions.id })
        .from(refreshTokens)
        .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
        .where(eq(refreshTokens.tokenHash, digest(secret)));
      if (!pointer) {
        await appendAudit(tx, { action: 'auth.denied' }, this.now());
        return { error: unauthorized() };
      }
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, pointer.userId))
        .for('update');
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, pointer.sessionId))
        .for('update');
      const [token] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, digest(secret)))
        .for('update');
      const now = this.now();
      if (!token || !user || !session) return { error: unauthorized() };
      if (token.usedAt) {
        await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));
        await appendAudit(tx, { action: 'auth.refresh_reused', actorId: user.id }, now);
        return { error: unauthorized() };
      }
      if (
        !user.active ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.idleExpiresAt <= now
      ) {
        await appendAudit(tx, { action: 'auth.denied', actorId: user.id }, now);
        return { error: unauthorized() };
      }
      const refresh = newOpaqueToken();
      await tx
        .update(refreshTokens)
        .set({ usedAt: now })
        .where(eq(refreshTokens.tokenHash, token.tokenHash));
      await tx.insert(refreshTokens).values({ tokenHash: digest(refresh), sessionId: session.id });
      // Refresh is not activity and must never extend the idle timeout or absolute TTL.
      const principal = await this.principal(tx, user);
      await appendAudit(tx, { action: 'auth.refresh', actorId: user.id }, now);
      return {
        value: {
          refresh,
          response: {
            accessToken: await this.options.tokens.sign(user.id, session.id),
            expiresIn: 900,
            user: principal,
          },
        },
      };
    });
    return unwrap(result);
  }
  async authenticate(token: string): Promise<Principal> {
    let claims;
    try {
      claims = await this.options.tokens.verify(token);
    } catch {
      await this.options.db.transaction((tx) =>
        appendAudit(tx, { action: 'auth.denied' }, this.now()),
      );
      throw unauthorized();
    }
    const result = await this.options.db.transaction(async (tx): Promise<Outcome<Principal>> => {
      const [user] = await tx.select().from(users).where(eq(users.id, claims.sub)).for('update');
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, claims.sid))
        .for('update');
      const now = this.now();
      if (
        !user ||
        !session ||
        session.userId !== user.id ||
        !user.active ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.idleExpiresAt <= now
      ) {
        await appendAudit(tx, { action: 'auth.denied' }, now);
        return { error: unauthorized() };
      }
      await tx
        .update(sessions)
        .set({
          idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_MS, session.expiresAt.getTime())),
        })
        .where(eq(sessions.id, session.id));
      return { value: await this.principal(tx, user) };
    });
    return unwrap(result);
  }
  /**
   * Read-only session check for long-lived sockets (alerts). Unlike authenticate(), it never
   * extends the idle timeout: a socket is not user activity, so reconnects cannot keep a session
   * alive. Returns null when the token is invalid, the session is revoked, expired or idle, or the
   * user is deactivated. Does not write audit records, so periodic checks stay quiet.
   */
  async socketPrincipal(token: string): Promise<Principal | null> {
    let claims;
    try {
      claims = await this.options.tokens.verify(token);
    } catch {
      return null;
    }
    return this.options.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, claims.sub));
      const [session] = await tx.select().from(sessions).where(eq(sessions.id, claims.sid));
      const now = this.now();
      if (
        !user ||
        !session ||
        session.userId !== user.id ||
        !user.active ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.idleExpiresAt <= now
      )
        return null;
      try {
        return await this.principal(tx, user);
      } catch {
        return null;
      }
    });
  }
  async logout(secret?: string): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      if (!secret) return;
      const [pointer] = await tx
        .select({ userId: sessions.userId, id: sessions.id })
        .from(refreshTokens)
        .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
        .where(eq(refreshTokens.tokenHash, digest(secret)));
      if (!pointer) return;
      await tx.select().from(users).where(eq(users.id, pointer.userId)).for('update');
      await tx.update(sessions).set({ revokedAt: this.now() }).where(eq(sessions.id, pointer.id));
      await appendAudit(tx, { action: 'auth.logout', actorId: pointer.userId }, this.now());
    });
  }
  async deny(): Promise<void> {
    await this.options.db.transaction((tx) =>
      appendAudit(tx, { action: 'auth.denied' }, this.now()),
    );
  }
}
