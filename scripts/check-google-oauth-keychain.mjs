import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OAuthKeychainStore, executeCommand } from '@afk/runtime/infrastructure/providers';

const service = `capability.google-oauth.verification.${randomUUID()}`;
const value = JSON.stringify({ probe: 'synthetic'.repeat(2048) });
const store = new OAuthKeychainStore(request => {
  assert(!request.args.some(argument => argument.includes(value) || argument.includes(Buffer.from(value).toString('base64url'))));
  return executeCommand({ ...request, args: request.args.map(argument => argument === 'capability.google-oauth' ? service : argument) });
});

try {
  assert.equal(await store.read(), undefined);
  await store.write(value);
  assert.equal(await store.read(), value);
  await store.write(`${value} `);
  assert.equal(await store.read(), `${value} `);
  await store.remove();
  assert.equal(await store.read(), undefined);
  console.log(JSON.stringify({ passed: true, nativeKeychain: true, bytes: value.length, credentialsInArguments: false }));
} finally { await store.remove(); }
