import { z } from 'zod';

const KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine(
    (value) =>
      Buffer.from(value, 'base64').length === 32 &&
      Buffer.from(value, 'base64').toString('base64') === value,
    'Expected a base64-encoded 32-byte key',
  );
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1),
    APP_ENCRYPTION_KEY: KeySchema,
    JWT_ACCESS_SECRET: KeySchema,
    PUBLIC_ORIGIN: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    }, 'Expected an HTTPS origin without path'),
    // Optional only so operators can bootstrap accounts before a legal text exists.
    // Invitation redemption is fail-closed while either value is missing.
    CONSENT_VERSION: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).max(100).optional(),
    ),
    CONSENT_TEXT_PATH: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    TRUST_PROXY: z.enum(['none', 'one-hop']).default('none'),
  })
  .refine((value) => value.APP_ENCRYPTION_KEY !== value.JWT_ACCESS_SECRET, {
    message: 'Use independent encryption and signing keys',
  })
  .refine((value) => Boolean(value.CONSENT_VERSION) === Boolean(value.CONSENT_TEXT_PATH), {
    message: 'Consent path and version must be supplied together',
  });

export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Never include zod input values or secret-bearing error messages.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'configuration')),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
