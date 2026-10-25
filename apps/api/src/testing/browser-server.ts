// Test-only HTTPS adapter for environments without Docker. Production uses Caddy.
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CreatePractitionerSchema } from '@psychometr/shared';
import { startTestDatabase } from './postgres.js';
import { testEnv } from './env.js';
import { connectDatabase } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashCredential } from '../security/credentials.js';
import { appendAudit } from '../domain/audit.js';
import { buildApp } from '../app.js';

const credentials = CreatePractitionerSchema.parse({
  email: process.env['ADMIN_EMAIL'],
  password: process.env['ADMIN_PASSWORD'],
});
const database = await startTestDatabase();
const connection = connectDatabase(database.databaseUrl);
await connection.db.transaction(async (tx) => {
  const [admin] = await tx
    .insert(users)
    .values({
      role: 'admin',
      email: credentials.email,
      credentialHash: await hashCredential(credentials.password),
    })
    .returning();
  if (!admin) throw new Error('Test bootstrap failed');
  await appendAudit(tx, { action: 'staff.created', resourceId: admin.id });
});
const env = { ...testEnv(database.databaseUrl), PUBLIC_ORIGIN: 'https://localhost:8443' };
const app = await buildApp({
  env,
  db: connection.db,
  silent: true,
  consent: {
    version: 'browser-synthetic-v1',
    text: 'СИНТЕТИЧЕСКИЙ ТЕКСТ ДЛЯ БРАУЗЕРНОГО ТЕСТА. Не использовать для реальных пациентов.',
  },
});
const directory = await mkdtemp(join(tmpdir(), 'compass-tls-'));
await promisify(execFile)('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '1',
  '-keyout',
  join(directory, 'key.pem'),
  '-out',
  join(directory, 'cert.pem'),
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
]);
const dist = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
const files = new Map<string, { body: Buffer; type: string }>();
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);
// Preload a fixed allowlist: HTTP paths never reach the filesystem API.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed build-output directory, not request input.
for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const path = join(file.parentPath, file.name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Files enumerated only from the build output, no HTTP input.
  const body = await readFile(path);
  files.set(`/${path.slice(dist.length).replace(/\\/g, '/')}`, {
    body,
    type: types.get(extname(file.name)) ?? 'application/octet-stream',
  });
}
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Private test-only certificate generated above.
const key = await readFile(join(directory, 'key.pem'));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Private test-only certificate generated above.
const cert = await readFile(join(directory, 'cert.pem'));
const server = createServer({ key, cert }, (request, response) => {
  const serve = async () => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    const url = request.url ?? '/';
    if (url.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of request) {
        const chunk: unknown = value;
        if (!(chunk instanceof Uint8Array)) throw new Error('Unexpected HTTP chunk');
        size += chunk.byteLength;
        if (size > 65_536) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const result = await app.inject({
        method: request.method ?? 'GET',
        url,
        headers: request.headers,
        ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.rawPayload);
    } else {
      const file = files.get(new URL(url, env.PUBLIC_ORIGIN).pathname) ?? files.get('/index.html');
      if (!file) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader('Content-Type', file.type);
      response.end(file.body);
    }
  };
  void serve().catch(() => {
    response.writeHead(500);
    response.end('Test adapter failed');
  });
});
// WebSocket alerts (FR-8.1): upgrades are piped to the app's own loopback listener, as Caddy does.
await app.listen({ port: 0, host: '127.0.0.1' });
const internal = app.server.address();
if (!internal || typeof internal === 'string') throw new Error('Internal listener missing');
const internalPort = internal.port;
server.on('upgrade', (request, socket, head) => {
  const upstream = connect(internalPort, '127.0.0.1');
  upstream.once('connect', () => {
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
    const raw = request.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      // eslint-disable-next-line security/detect-object-injection -- loop counter over rawHeaders
      lines.push(`${raw[index] ?? ''}: ${raw[index + 1] ?? ''}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => {
    socket.destroy();
  });
  socket.on('error', () => {
    upstream.destroy();
  });
});
await new Promise<void>((resolve) => {
  server.listen(8443, '0.0.0.0', resolve);
});
console.log('Synthetic HTTPS browser-test stack is ready.');
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await app.close();
  await connection.pool.end();
  await database.close();
  await rm(directory, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void stop().then(() => process.exit(0));
});
