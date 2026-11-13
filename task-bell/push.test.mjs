import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { createPushService, validateSubscription } from './push.js';
const require = createRequire(import.meta.url);
const pushRequire = createRequire(require.resolve('web-push'));
const ece = pushRequire('http_ece');

export function memoryCredentials() {
  const values = new Map(); let queue = Promise.resolve();
  return {
    async readRecord(key) { return structuredClone(values.get(key)); },
    modifyRecord(key, mutate) {
      const result = queue.then(async () => {
        const value = await mutate(structuredClone(values.get(key)));
        if (value !== undefined) values.set(key, structuredClone(value));
        return structuredClone(values.get(key));
      }); queue = result.catch(() => {}); return result;
    },
  };
}
const app = 'https://example.ts.net:18742/';
function subscription() {
  const dh = createECDH('prime256v1'); dh.generateKeys();
  const auth = randomBytes(16);
  return { dh, auth, value: { endpoint: `https://wns2-test.notify.windows.com/w/?token=${randomBytes(8).toString('hex')}`, keys: { p256dh: dh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
const item = { id: 'event-1', sessionId: 'session-one', reason: 'completed', time: Date.now() };

test('rejects arbitrary URLs and malformed encryption keys', () => {
  const { value } = subscription();
  for (const endpoint of ['http://wns2-test.notify.windows.com/w/', 'https://127.0.0.1/', 'https://notify.windows.com.evil.test/', 'https://wns2-test.notify.windows.com:8443/w/']) {
    assert.throws(() => validateSubscription({ ...value, endpoint }));
  }
  assert.throws(() => validateSubscription({ ...value, keys: { p256dh: 'abc', auth: 'abc' } }));
});

test('VAPID and subscription survive service restart; actual web-push encryption decrypts correctly', async () => {
  const credentials = memoryCredentials(), device = subscription();
  const first = createPushService(credentials);
  const publicKey = await first.publicKey();
  await first.subscribe(device.value, app + '?token=must-not-persist#ignored', 'zh', new URL(app).origin);
  await first.close();
  let captured;
  const second = createPushService(credentials, { send: async (sub, payload, options) => {
    const request = webpush.generateRequestDetails(sub, payload, options);
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.match(request.headers.Authorization, /^vapid /);
    const decoded = ece.decrypt(request.body, { version: 'aes128gcm', privateKey: device.dh, authSecret: device.auth });
    captured = JSON.parse(decoded.toString());
  }});
  assert.equal(await second.publicKey(), publicKey);
  assert.equal((await second.status(device.value.endpoint)).active, true);
  assert.deepEqual(await second.publish(item), [{ ok: true }]);
  assert.equal(captured.id, item.id);
  assert.equal(captured.title, 'DSH · 任务已完成');
  const target = new URL(captured.url);
  assert.equal(target.searchParams.get('taskBellSession'), 'session-one');
  assert.equal(target.searchParams.has('token'), false);
  assert.equal(target.hash, '');
  assert.equal((await second.status(device.value.endpoint)).lastDelivery.ok, true);
  await second.close();
});

test('expired subscriptions are removed and transient failures retry', async () => {
  const credentials = memoryCredentials(), device = subscription(); let attempts = 0;
  const push = createPushService(credentials, { send: async () => { attempts++; throw { statusCode: 503 }; } });
  await push.subscribe(device.value, app, 'en', new URL(app).origin);
  const results = await push.publish(item);
  assert.equal(attempts, 2); assert.equal(results[0].ok, false);
  assert.equal((await push.status(device.value.endpoint)).lastDelivery.status, 503);
  await push.close();
  const expired = createPushService(credentials, { send: async () => { throw { statusCode: 410 }; } });
  assert.equal((await expired.publish(item))[0].expired, true);
  assert.equal((await expired.status(device.value.endpoint)).active, false);
  await expired.close();
});

test('unsubscribe persists, test targets only one browser, and URL must match origin', async () => {
  const credentials = memoryCredentials(), a = subscription(), b = subscription(); const sends = [];
  const push = createPushService(credentials, { send: async (sub, payload) => sends.push([sub.endpoint, JSON.parse(payload)]) });
  await assert.rejects(push.subscribe(a.value, 'https://other.example/', 'zh', new URL(app).origin));
  await push.subscribe(a.value, app, 'zh', new URL(app).origin);
  await push.subscribe(b.value, app, 'en', new URL(app).origin);
  await push.test(a.value.endpoint);
  assert.equal(sends.length, 1); assert.equal(sends[0][0], a.value.endpoint);
  assert.equal(sends[0][1].sessionId, '');
  await push.unsubscribe(a.value.endpoint);
  await push.publish(item);
  assert.equal(sends.length, 2); assert.equal(sends[1][0], b.value.endpoint);
  await push.close();
});
