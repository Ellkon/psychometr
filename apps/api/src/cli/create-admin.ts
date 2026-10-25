import { eq, sql } from 'drizzle-orm';
import { CreatePractitionerSchema } from '@psychometr/shared';
import { connectDatabase } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashCredential } from '../security/credentials.js';
import { appendAudit } from '../domain/audit.js';

const credentials = CreatePractitionerSchema.safeParse({
  email: process.env['ADMIN_EMAIL'],
  password: process.env['ADMIN_PASSWORD'],
});
if (!credentials.success || !process.env['DATABASE_URL'])
  throw new Error(
    'Supply DATABASE_URL, ADMIN_EMAIL and a password of 12–128 characters through the environment',
  );
const { db, pool } = connectDatabase(process.env['DATABASE_URL']);
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(51982732)`);
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    if (existing.length) throw new Error('An administrator already exists; bootstrap is disabled');
    const [user] = await tx
      .insert(users)
      .values({
        role: 'admin',
        email: credentials.data.email,
        credentialHash: await hashCredential(credentials.data.password),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('Administrator insert failed');
    await appendAudit(tx, { action: 'staff.created', resourceId: user.id });
  });
  console.log('Administrator created. No credentials are printed or stored outside the database.');
} catch {
  console.error(
    'Administrator bootstrap failed. Check configuration or whether an administrator already exists.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
