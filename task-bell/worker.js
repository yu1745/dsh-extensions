const DATABASE = 'dsh-task-bell-events';
const STORE = 'shown';
const ROUTE_ACK_TIMEOUT = 800;
let notificationQueue = Promise.resolve();
let databasePromise;

function database() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = self.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Notification database is blocked'));
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

async function storedEvent(id, write = false) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, write ? 'readwrite' : 'readonly');
    const store = transaction.objectStore(STORE);
    const request = write ? store.put(true, id) : store.get(id);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || new Error('Notification database transaction aborted'));
  });
}

function appURL(value) {
  const url = new URL(value, self.location.origin);
  if (url.origin !== self.location.origin || url.protocol !== 'https:') {
    throw new Error('Notification URL must use same-origin HTTPS');
  }
  return url;
}

// Both delivery paths must use this queue. Commit IDs only after successful display,
// so failed notifications can retry and closed notifications remain deduplicated.
function notify(item) {
  const pending = notificationQueue.then(async () => {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' ||
        typeof item.url !== 'string' || !item.url || typeof item.sessionId !== 'string') {
      throw new Error('Invalid notification payload');
    }
    const url = appURL(item.url);
    if (await storedEvent(item.id)) return false;
    await self.registration.showNotification(item.title, {
      body: item.body,
      tag: item.id,
      data: { sessionId: item.sessionId, url: url.href },
      silent: false,
    });
    await storedEvent(item.id, true);
    return true;
  });
  notificationQueue = pending.catch(() => {});
  return pending;
}

function standaloneClient(page) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let timer;
    const finish = standalone => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(standalone);
    };
    channel.port1.onmessage = event => {
      if (event.data?.type === 'task-bell:client-info:ack') finish(event.data.standalone === true);
    };
    timer = setTimeout(() => finish(false), 150);
    try {
      page.postMessage({ type: 'task-bell:client-info' }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

function routeSession(page, data, url) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let timer;
    const finish = acknowledged => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(acknowledged);
    };
    channel.port1.onmessage = event => {
      if (event.data?.type === 'task-bell:open-session:ack') finish(true);
    };
    timer = setTimeout(() => finish(false), ROUTE_ACK_TIMEOUT);
    try {
      page.postMessage({ type: 'task-bell:open-session', sessionId: data.sessionId, url: url.href }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  event.waitUntil(Promise.resolve().then(() => notify(event.data?.json())));
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'task-bell:notify') return;
  const port = event.ports?.[0];
  event.waitUntil(notify(event.data.event).then(
    shown => port?.postMessage({ ok: true, shown }),
    error => port?.postMessage({ ok: false, error: String(error?.message || error) }),
  ));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (!data || typeof data.url !== 'string' || !data.url) return;
    let url;
    try { url = appURL(data.url); } catch { return; }
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const candidates = pages.filter(client => {
      try {
        const current = new URL(client.url);
        return current.origin === url.origin && current.pathname === url.pathname;
      } catch { return false; }
    });
    const standalone = new Map();
    if (candidates.length > 1) {
      await Promise.all(candidates.map(async client => standalone.set(client, await standaloneClient(client))));
    }
    candidates.sort((a, b) =>
      Number(Boolean(standalone.get(b))) - Number(Boolean(standalone.get(a))) ||
      Number(Boolean(b.focused)) - Number(Boolean(a.focused)) ||
      Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible'));
    const page = candidates[0];
    if (!page) {
      await self.clients.openWindow(url.href);
      return;
    }
    // Invoke focus before any navigation or ACK wait: Edge can lose the click's
    // transient user activation while awaiting navigation (including PWA windows).
    let focused;
    try { focused = await page.focus(); } catch { /* Reopen a stale/unfocusable PWA client below. */ }
    if (!focused) {
      await self.clients.openWindow(url.href);
      return;
    }
    if (await routeSession(page, data, url)) return;
    try {
      if (await page.navigate(url.href)) return;
    } catch { /* A stale client must not swallow the notification click. */ }
    await self.clients.openWindow(url.href);
  })());
});
