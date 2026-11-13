import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createECDH, randomBytes } from 'node:crypto';
import { apply } from './index.js';
const routes = new Map(), listeners = new Map(), cleanup = [];
let credential;
const ctx = {
  credentials: { async readRecord() { return credential; }, async modifyRecord(_key, mutate) { credential = await mutate(credential); return credential; } },
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
  connection: { admit(req) { return req.headers.authorization === 'test-owner' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }; } },
  effect(fn) { cleanup.push(fn()); }, on(name, fn) { listeners.set(name, fn); }
};
class Response extends EventEmitter {
  chunks = []; writableLength = 0;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); }
  end(chunk) { if (chunk) this.write(chunk); this.emit('close'); }
  destroy() { this.emit('close'); }
}
await apply(ctx);
const events = routes.get('/dsh-task-bell/events');
const unauthorized = new Response();
await events.handler({ method: 'GET', headers: {} }, unauthorized);
assert.equal(unauthorized.status, 401);
const response = new Response();
await events.handler({ method: 'GET', headers: { authorization: 'test-owner' } }, response);
assert.equal(response.status, 200);
const publish = listeners.get('session/event');
const event = (reason, seq = 1) => ({ type: 'turn/end', seq, time: Date.now(), data: { turn: 1, reason: { kind: reason } } });
const root = { id: 'root-session', header: {} };
publish(root, event('completed'));
assert.match(response.chunks.join(''), /"reason":"completed"/);
const count = response.chunks.length;
publish({ id: 'child', header: { origin: 'subagent' } }, event('completed'));
publish(root, event('aborted'));
publish(root, event('interrupted'));
assert.equal(response.chunks.length, count);
const id = response.chunks.at(-1).match(/^id: (.+)/)[1];
publish(root, event('error', 2));
const replay = new Response();
await events.handler({ method: 'GET', headers: { authorization: 'test-owner', 'last-event-id': id } }, replay);
assert.match(replay.chunks.join(''), /"reason":"error"/);
assert.doesNotMatch(replay.chunks.join(''), /"reason":"completed"/);
const fresh = new Response();
await events.handler({ method: 'GET', headers: { authorization: 'test-owner' } }, fresh);
assert.equal(fresh.chunks.length, 1);
const sw = new Response();
await routes.get('/dsh-task-bell/worker.js').handler({ method: 'GET', headers: { authorization: 'test-owner' } }, sw);
assert.equal(sw.status, 200); assert.match(sw.chunks.join(''), /notificationclick/);
const key = new Response();
await routes.get('/dsh-task-bell/push-key').handler({ method: 'GET', headers: { authorization: 'test-owner' } }, key);
assert.equal(key.status, 200); assert.equal(JSON.parse(key.chunks.join('')).publicKey.length, 87);
const csrf = new Response();
await routes.get('/dsh-task-bell/push').handler({ method: 'POST', headers: { authorization: 'test-owner' } }, csrf);
assert.equal(csrf.status, 403);
const post = async value => {
  const request = Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]);
  request.method = 'POST';
  request.headers = { authorization: 'test-owner', origin: 'https://example.ts.net', 'content-type': 'application/json', 'x-dsh-task-bell': '1' };
  const result = new Response();
  await routes.get('/dsh-task-bell/push').handler(request, result);
  return result;
};
const invalidJson = await post('{'); assert.equal(invalidJson.status, 400);
const privateEndpoint = await post({ action: 'subscribe', subscription: { endpoint: 'https://127.0.0.1/' }, url: 'https://example.ts.net/', locale: 'zh' });
assert.equal(privateEndpoint.status, 400);
const deviceKey = createECDH('prime256v1'); deviceKey.generateKeys();
const subscription = { endpoint: 'https://wns2-test.notify.windows.com/w/?token=test', keys: { p256dh: deviceKey.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
assert.equal((await post({ action: 'subscribe', subscription, url: 'https://example.ts.net/', locale: 'zh' })).status, 200);
const active = await post({ action: 'status', endpoint: subscription.endpoint });
assert.equal(JSON.parse(active.chunks.join('')).active, true);
assert.equal((await post({ action: 'unsubscribe', endpoint: subscription.endpoint })).status, 200);
const inactive = await post({ action: 'status', endpoint: subscription.endpoint });
assert.equal(JSON.parse(inactive.chunks.join('')).active, false);
for (const dispose of cleanup.reverse()) await dispose?.();
assert.equal(routes.size, 0);
console.log('PASS: authenticated routes, completion/error events, child/cancel filtering, reconnect replay, fresh connection, worker delivery, cleanup');
