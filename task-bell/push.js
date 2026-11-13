import webpush from 'web-push';
import { createHash, randomUUID } from 'node:crypto';

const RECORD = 'task-bell/web-push-v1';
const idOf = endpoint => createHash('sha256').update(endpoint).digest('hex');
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw invalid('Invalid push subscription');
  const endpoint = new URL(value.endpoint);
  const host = endpoint.hostname;
  const allowed = host.endsWith('.notify.windows.com') || host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'push.services.mozilla.com' || host === 'web.push.apple.com';
  if (!allowed || endpoint.protocol !== 'https:' || (endpoint.port && endpoint.port !== '443') || endpoint.username || endpoint.password || endpoint.hash) throw invalid('Unsupported push service');
  for (const [key, length] of [['p256dh', 65], ['auth', 16]]) {
    const text = value.keys?.[key];
    if (typeof text !== 'string' || !/^[\w-]+={0,2}$/.test(text) || Buffer.from(text, 'base64url').length !== length) throw invalid('Invalid push encryption key');
  }
  if (Buffer.from(value.keys.p256dh, 'base64url')[0] !== 4) throw invalid('Invalid push public key');
  return { endpoint: endpoint.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export function notificationFor(item, device) {
  const zh = device.locale !== 'en';
  const title = item.test ? (zh ? 'DSH · 推送测试' : 'DSH · Push test') : item.reason === 'completed' ? (zh ? 'DSH · 任务已完成' : 'DSH · Task completed') : (zh ? 'DSH · 任务需要关注' : 'DSH · Task needs attention');
  const url = new URL(device.url);
  if (item.sessionId) url.searchParams.set('taskBellSession', item.sessionId);
  return { ...item, title, body: item.test ? (zh ? '这条通知通过 Web Push 送达，关闭网页后也可接收。' : 'Delivered via Web Push. Notifications also work after closing this page.') : (zh ? `会话 ${item.sessionId.slice(0, 12)} · 点击查看结果` : `Session ${item.sessionId.slice(0, 12)} · Click to view results`), url: url.href };
}

export function createPushService(credentials, options = {}) {
  const send = options.send || ((subscription, payload, config) => webpush.sendNotification(subscription, payload, config));
  const now = options.now || Date.now;
  let disposed = false;
  const pending = new Set();
  const read = async () => {
    const record = await credentials.readRecord(RECORD);
    if (record?.kind !== 'grant' || record.payload?.version !== 1) throw new Error('Push credentials are unavailable');
    return record.payload;
  };
  const change = async mutate => {
    const record = await credentials.modifyRecord(RECORD, async current => {
      const state = current?.kind === 'grant' && current.payload?.version === 1 ? current.payload : { version: 1, vapid: webpush.generateVAPIDKeys(), devices: {} };
      return { kind: 'grant', payload: await mutate(state) };
    });
    return record.payload;
  };
  const initial = change(state => state);
  const updateDevice = (id, revision, mutation) => change(state => {
    const current = state.devices[id];
    if (!current || current.revision !== revision) return state;
    const devices = { ...state.devices };
    const next = mutation(current);
    if (next) devices[id] = next; else delete devices[id];
    return { ...state, devices };
  });
  async function sendOne(id, device, item) {
    if (disposed) return { ok: false, error: 'Push plugin is stopping' };
    const state = await read();
    // A disable or resubscribe after the event snapshot must take effect before sending.
    if (state.devices[id]?.revision !== device.revision) return { ok: false, error: 'Subscription changed' };
    let failure;
    for (let attempt = 0; attempt < 2 && !disposed; attempt++) {
      try {
        await send(device.subscription, JSON.stringify(notificationFor(item, device)), {
          TTL: item.test ? 60 : 300, urgency: 'high', timeout: 10000,
          vapidDetails: { subject: new URL(device.url).origin, ...state.vapid },
        });
        await updateDevice(id, device.revision, current => ({ ...current, lastDelivery: { time: now(), ok: true } }));
        return { ok: true };
      } catch (error) {
        const status = Number(error.statusCode || 0);
        failure = { ok: false, error: status ? `Push service returned HTTP ${status}` : 'Cannot reach the browser push service', status };
        if (status === 404 || status === 410) {
          await updateDevice(id, device.revision, () => null);
          return { ...failure, expired: true };
        }
        if (attempt > 0 || (status && status !== 429 && status < 500)) break;
      }
    }
    await updateDevice(id, device.revision, current => ({ ...current, lastDelivery: { time: now(), ...failure } }));
    return failure;
  }
  function tracked(operation) {
    const task = operation();
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  return {
    async publicKey() { await initial; return (await read()).vapid.publicKey; },
    async subscribe(subscription, url, locale, origin) {
      await initial;
      const value = validateSubscription(subscription);
      const target = new URL(url);
      if (target.origin !== origin || target.protocol !== 'https:' || target.username || target.password) throw invalid('The app URL must use this HTTPS origin');
      target.search = ''; target.hash = '';
      const id = idOf(value.endpoint);
      await change(state => {
        if (!state.devices[id] && Object.keys(state.devices).length >= 32) throw invalid('Too many push subscriptions');
        return { ...state, devices: { ...state.devices, [id]: { subscription: value, url: target.href, locale: locale === 'en' ? 'en' : 'zh', revision: randomUUID(), updatedAt: now() } } };
      });
      return { active: true };
    },
    async unsubscribe(endpoint) {
      await initial;
      const id = idOf(String(endpoint));
      await change(state => { const devices = { ...state.devices }; delete devices[id]; return { ...state, devices }; });
      return { active: false };
    },
    async status(endpoint) {
      await initial;
      const device = (await read()).devices[idOf(String(endpoint))];
      return { active: !!device, lastDelivery: device?.lastDelivery || null };
    },
    test(endpoint) { return tracked(async () => {
      await initial;
      const id = idOf(String(endpoint)), device = (await read()).devices[id];
      if (!device) throw invalid('Enable push notifications on this browser first');
      return sendOne(id, device, { id: randomUUID(), test: true, sessionId: '', time: now() });
    }); },
    publish(item) { return tracked(async () => {
      await initial;
      const devices = Object.entries((await read()).devices);
      const outcomes = [];
      for (let offset = 0; offset < devices.length && !disposed; offset += 4) {
        outcomes.push(...await Promise.all(devices.slice(offset, offset + 4).map(([id, device]) => sendOne(id, device, item))));
      }
      return outcomes;
    }); },
    async close() { disposed = true; await Promise.allSettled([...pending, initial]); },
  };
}
