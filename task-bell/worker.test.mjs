import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const origin = 'https://dsh.example';
const item = { id: 'event-1', sessionId: 'session-1', reason: 'done', time: 123, title: 'Done', body: 'Task complete', url: `${origin}/?taskBellSession=session-1` };

// A small asynchronous IndexedDB double: transaction completion follows request
// completion, and records can survive construction of another worker context.
function indexedDB(records) {
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          createObjectStore() {},
          transaction(_store, mode) {
            const transaction = {
              objectStore() {
                return {
                  get(key) { return operation(() => records.get(key)); },
                  put(value, key) {
                    assert.equal(mode, 'readwrite');
                    return operation(() => { records.set(key, value); return key; });
                  },
                };
              },
            };
            function operation(run) {
              const result = {};
              queueMicrotask(() => {
                result.result = run();
                transaction.oncomplete?.();
              });
              return result;
            }
            return transaction;
          },
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

class Channel {
  constructor() {
    this.port1 = { close() {} };
    this.port2 = {
      close() {},
      postMessage: data => this.port1.onmessage?.({ data }),
    };
  }
}

function worker({ pages = [], records = new Map(), show, open } = {}) {
  const listeners = new Map();
  const calls = [];
  const self = {
    location: { origin, pathname: '/dsh-task-bell/worker.js' },
    indexedDB: indexedDB(records),
    skipWaiting: async () => {},
    addEventListener: (name, handler) => listeners.set(name, handler),
    registration: {
      async showNotification(title, options) {
        calls.push(['show', title, options]);
        await show?.(title, options);
      },
    },
    clients: {
      async claim() {},
      async matchAll(options) { calls.push(['matchAll', options]); return pages; },
      async openWindow(url) { calls.push(['open', url]); return open?.(url); },
    },
  };
  vm.runInNewContext(source, {
    self, URL, MessageChannel: Channel,
    setTimeout(callback, delay) { calls.push(['timeout', delay]); return setTimeout(callback, 0); },
    clearTimeout,
  });
  async function dispatch(type, event) {
    let lifetime;
    listeners.get(type)({ ...event, waitUntil(promise) { lifetime = promise; } });
    assert.ok(lifetime, `${type} must extend worker lifetime`);
    await lifetime;
  }
  return {
    calls, records,
    push: (payload = item) => dispatch('push', { data: { json: () => payload } }),
    async notify(payload = item) {
      let response;
      await dispatch('message', { data: { type: 'task-bell:notify', event: payload }, ports: [{ postMessage: value => { response = value; } }] });
      return response;
    },
    click: (data = item) => dispatch('notificationclick', { notification: { data, close() { calls.push(['close']); } } }),
  };
}

function page(calls, { url = `${origin}/?existing=query`, ack = true, infoAck = true, standalone = false, focused = false, visibilityState = 'visible', navigate } = {}) {
  const client = {
    url, focused, visibilityState,
    async focus() { calls.push('focus'); return client; },
    postMessage(message, ports) {
      if (message.type === 'task-bell:client-info') {
        if (infoAck) ports[0].postMessage({ type: 'task-bell:client-info:ack', standalone });
        return;
      }
      calls.push(['message', message]);
      if (ack) ports[0].postMessage({ type: 'task-bell:open-session:ack' });
    },
    async navigate(target) { calls.push(['navigate', target]); return navigate ? navigate(target) : client; },
  };
  return client;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('push displays full payload with sound and records its ID', async () => {
  const runtime = worker();
  await runtime.push();
  assert.deepEqual(plain(runtime.calls[0]), ['show', item.title, {
    body: item.body, tag: item.id, data: { sessionId: item.sessionId, url: item.url }, silent: false,
  }]);
  assert.equal(runtime.records.get(item.id), true);
});

test('push and SSE messages share serialized persistent deduplication', async () => {
  const runtime = worker();
  const [, reply] = await Promise.all([runtime.push(), runtime.notify()]);
  assert.equal(reply.ok, true);
  assert.equal(typeof reply.shown, 'boolean', 'either delivery may reach the shared queue first');
  assert.equal(runtime.calls.filter(call => call[0] === 'show').length, 1);
  const restarted = worker({ records: runtime.records });
  await restarted.push();
  assert.equal(restarted.calls.length, 0, 'closed notifications stay deduplicated after worker restart');
});

test('SSE-first delivery deduplicates a subsequent push and acknowledges display', async () => {
  const runtime = worker();
  assert.deepEqual(plain(await runtime.notify()), { ok: true, shown: true });
  await runtime.push();
  assert.equal(runtime.calls.filter(call => call[0] === 'show').length, 1);
});

test('failed display does not consume the ID or break subsequent deliveries', async () => {
  let attempts = 0;
  const runtime = worker({ show() { if (++attempts === 1) throw new Error('display failed'); } });
  assert.deepEqual(plain(await runtime.notify()), { ok: false, error: 'display failed' });
  assert.equal(runtime.records.has(item.id), false);
  await runtime.push();
  assert.equal(attempts, 2);
  assert.equal(runtime.records.get(item.id), true);
});

test('test pushes may use an empty session ID to focus the app without selecting a session', async () => {
  const runtime = worker();
  await runtime.push({ ...item, sessionId: '' });
  const notification = runtime.calls.find(call => call[0] === 'show');
  assert.equal(notification[2].data.sessionId, '');
  assert.equal(runtime.records.get(item.id), true);
});

test('focus rejection or null result opens the full URL without waiting for route ACK', async t => {
  for (const failure of ['reject', 'null']) await t.test(failure, async () => {
    const calls = [];
    const client = page(calls);
    client.focus = async () => {
      calls.push('focus');
      if (failure === 'reject') throw new Error('unfocusable PWA');
      return null;
    };
    const runtime = worker({ pages: [client] });
    await runtime.click();
    assert.deepEqual(calls, ['focus']);
    assert.deepEqual(plain(runtime.calls.at(-1)), ['open', item.url]);
    assert.equal(runtime.calls.some(call => call[0] === 'timeout'), false);
  });
});

test('malformed push and foreign notification URLs are rejected', async () => {
  const runtime = worker();
  await assert.rejects(runtime.push(null), /Invalid notification payload/);
  await assert.rejects(runtime.push({ ...item, url: 'https://foreign.example/' }), /same-origin HTTPS/);
  assert.equal(runtime.calls.length, 0);
});

test('click focuses an existing uncontrolled app before routing and accepts ACK', async () => {
  const calls = [];
  const runtime = worker({ pages: [page(calls)] });
  await runtime.click();
  assert.equal(calls[0], 'focus');
  assert.deepEqual(plain(calls[1]), ['message', { type: 'task-bell:open-session', sessionId: item.sessionId, url: item.url }]);
  assert.deepEqual(plain(runtime.calls.find(call => call[0] === 'matchAll')), ['matchAll', { type: 'window', includeUncontrolled: true }]);
  assert.equal(calls.some(call => call[0] === 'navigate'), false);
  assert.equal(runtime.calls.some(call => call[0] === 'open'), false);
});

test('click chooses a focused existing PWA over other matching pages', async () => {
  const hidden = [], visible = [], focused = [];
  const runtime = worker({ pages: [
    page(hidden, { visibilityState: 'hidden' }), page(visible),
    page(focused, { focused: true, visibilityState: 'hidden' }),
  ] });
  await runtime.click();
  assert.equal(focused[0], 'focus');
  assert.equal(hidden.length + visible.length, 0);
});

test('click prefers a background standalone PWA over a focused visible browser tab', async () => {
  const tabCalls = [], pwaCalls = [];
  const runtime = worker({ pages: [
    page(tabCalls, { focused: true, visibilityState: 'visible' }),
    page(pwaCalls, { standalone: true, focused: false, visibilityState: 'hidden' }),
  ] });
  await runtime.click();
  assert.equal(pwaCalls[0], 'focus');
  assert.equal(tabCalls.length, 0);
  assert.equal(runtime.calls.filter(call => call[0] === 'timeout' && call[1] === 150).length, 2);
});

test('multiple unresponsive client-info probes start concurrently and fall back to focus preference', async () => {
  const calls = [];
  let probes = 0;
  const clients = [page([], { visibilityState: 'hidden' }), page(calls, { focused: true })];
  for (const client of clients) {
    const original = client.postMessage;
    client.postMessage = (message, ports) => {
      if (message.type === 'task-bell:client-info') {
        probes++;
        return; // Older page without the client-info protocol.
      }
      original(message, ports);
    };
    const focus = client.focus;
    client.focus = () => {
      assert.equal(probes, 2, 'both probes must be sent before waiting for replies');
      return focus();
    };
  }
  const runtime = worker({ pages: clients });
  await runtime.click();
  assert.equal(calls[0], 'focus');
  assert.equal(runtime.calls.filter(call => call[0] === 'timeout' && call[1] === 150).length, 2);
});

test('a single matching client skips display mode probes', async () => {
  const client = page([]);
  const original = client.postMessage;
  client.postMessage = (message, ports) => {
    assert.notEqual(message.type, 'task-bell:client-info');
    original(message, ports);
  };
  const runtime = worker({ pages: [client] });
  await runtime.click();
  assert.equal(runtime.calls.some(call => call[0] === 'timeout' && call[1] === 150), false);
});

test('click prefers a visible page when no candidate is focused', async () => {
  const hidden = [], visible = [];
  const runtime = worker({ pages: [page(hidden, { visibilityState: 'hidden' }), page(visible)] });
  await runtime.click();
  assert.equal(visible[0], 'focus');
  assert.equal(hidden.length, 0);
});

test('without a matching window click opens full URL directly', async () => {
  const calls = [];
  const runtime = worker({ pages: [page(calls, { url: `${origin}/other` }), page(calls, { url: 'https://foreign.example/' })] });
  await runtime.click();
  assert.deepEqual(plain(runtime.calls.at(-1)), ['open', item.url]);
  assert.equal(calls.length, 0);
});

test('without an ACK click navigates after focus using the complete URL', async () => {
  const calls = [];
  const runtime = worker({ pages: [page(calls, { ack: false })] });
  await runtime.click();
  assert.equal(calls[0], 'focus');
  assert.deepEqual(calls.at(-1), ['navigate', item.url]);
  assert.deepEqual(runtime.calls.find(call => call[0] === 'timeout'), ['timeout', 800]);
});

test('navigation rejection or null result falls back to openWindow', async t => {
  for (const failure of ['reject', 'null']) await t.test(failure, async () => {
    const calls = [];
    const runtime = worker({ pages: [page(calls, { ack: false, navigate() {
      if (failure === 'reject') throw new Error('closed window');
      return null;
    } })] });
    await runtime.click();
    assert.equal(calls[0], 'focus');
    assert.deepEqual(plain(runtime.calls.at(-1)), ['open', item.url]);
  });
});

test('invalid click URL never opens or focuses a client', async () => {
  const runtime = worker();
  await runtime.click({ ...item, url: 'https://foreign.example/' });
  assert.deepEqual(plain(runtime.calls), [['close']]);
});
