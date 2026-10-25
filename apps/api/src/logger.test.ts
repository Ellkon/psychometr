import { Writable } from 'node:stream';
import { pino } from 'pino';
import { expect, it } from 'vitest';
import { buildLoggerOptions } from './logger.js';
import { newOpaqueToken } from './security/credentials.js';

it('never serializes raw URLs, credentials, identity, clinical payloads or error details', () => {
  const records: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      records.push(chunk.toString());
      done();
    },
  });
  const logger = pino(buildLoggerOptions('info'), destination);
  const secret = newOpaqueToken();
  logger.info(
    {
      req: {
        method: 'GET',
        id: 'request-id',
        url: `/i/${secret}?password=${secret}`,
        headers: { cookie: secret, authorization: secret },
        body: { personalCode: secret },
      },
      identity: { firstName: secret },
      answers: [secret],
      credentialHash: secret,
      personalCode: secret,
      payload: { clinical: secret },
      nested: { inner: { email: secret } },
      err: new Error(secret),
    },
    'safe message',
  );
  const encoded = records.join('');
  expect(encoded).not.toContain(secret);
  expect(encoded).toContain('safe message');
  expect(encoded).toContain('unmatched');
  expect(encoded).toContain('[REDACTED]');
});
