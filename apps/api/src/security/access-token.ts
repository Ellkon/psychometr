import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

const ClaimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  exp: z.number().int(),
  iat: z.number().int(),
});
export const ACCESS_SECONDS = 900;
export class AccessTokens {
  constructor(
    private readonly key: Uint8Array,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async sign(userId: string, sessionId: string): Promise<string> {
    const issued = Math.floor(this.clock().getTime() / 1000);
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('clinical-compass')
      .setAudience('clinical-compass-web')
      .setSubject(userId)
      .setIssuedAt(issued)
      .setExpirationTime(issued + ACCESS_SECONDS)
      .sign(this.key);
  }
  async verify(value: string) {
    const { payload } = await jwtVerify(value, this.key, {
      algorithms: ['HS256'],
      issuer: 'clinical-compass',
      audience: 'clinical-compass-web',
      typ: 'JWT',
      requiredClaims: ['sub', 'sid', 'exp', 'iat'],
      maxTokenAge: ACCESS_SECONDS,
      currentDate: this.clock(),
    });
    return ClaimsSchema.parse(payload);
  }
}
