window.__ModuleLoader__.load({
  id: '@local/dsh-task-bell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dictionaries = {
      zh: { title: '任务完成通知', description: '任务结束时发送系统通知，支持关闭应用窗口后接收。', enable: '允许通知', test: '测试通知', denied: '通知已被阻止，请在浏览器的网站权限中允许通知。', dismissed: '尚未允许通知，请重试。', unsupported: '当前浏览器不支持系统通知，请使用支持通知的 HTTPS 浏览器。', ready: '系统通知已开启。', failed: '通知失败：{message}', done: 'DSH · 任务已完成', error: 'DSH · 任务异常结束', blocked: 'DSH · 任务需要关注', body: '会话 {id} · 点击查看结果', testTitle: 'DSH · 通知测试', testBody: '任务结束后会通过系统通知提醒你。', tested: '测试通知已发送。', reconnect: '通知连接已断开，正在重连…', soundHint: '提示音由系统通知设置决定。', limit: '需要联网并允许 Edge 后台通知；DSH 服务需保持运行。', pushReady: '后台推送已开启，关闭应用窗口后也可接收。', pushNeeded: '尚未开启后台推送，目前仅网页打开时接收。', setupPush: '开启后台推送', busy: '处理中…', unsubscribed: '通知已关闭。' },
      en: { title: 'Task notifications', description: 'Send system notifications when tasks end, even after closing the app window.', enable: 'Allow notifications', test: 'Test notification', denied: 'Notifications are blocked. Allow them in the browser site permissions.', dismissed: 'Notification permission was not granted. Please retry.', unsupported: 'Use an HTTPS browser that supports system notifications.', ready: 'System notifications enabled.', failed: 'Notification failed: {message}', done: 'DSH · Task completed', error: 'DSH · Task ended with an error', blocked: 'DSH · Task needs attention', body: 'Session {id} · Click to view results', testTitle: 'DSH · Notification test', testBody: 'Finished tasks will send system notifications.', tested: 'Test notification sent.', reconnect: 'Notification connection lost. Reconnecting…', soundHint: 'Sound follows your system notification settings.', limit: 'Requires network access, Edge background notifications and a running DSH server.', pushReady: 'Background push is enabled, including after closing the app window.', pushNeeded: 'Background push is not enabled. This page must stay open.', setupPush: 'Enable background push', busy: 'Working…', unsubscribed: 'Notifications disabled.' }
    };
    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        for (const [language, dict] of Object.entries(dictionaries)) ctx.locale.register('taskBell', language, dict);
        const t = ctx.locale.bind('taskBell');
        const key = 'dsh-task-bell.preferences.v1';
        let preferences = { enabled: false };
        try { preferences = { ...preferences, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch {}
        let state = { ...preferences, message: '', connected: false, pushActive: false, busy: false };
        let registrationPromise;
        let operationRevision = 0;
        let restoring = false;
        const subscribers = new Set();
        let source, disposed = false;
        const patch = change => { state = { ...state, ...change }; for (const fn of subscribers) fn(); };
        const fail = error => patch({ message: t('failed', { message: String(error?.message || error) }) });
        const save = change => {
          preferences = { ...preferences, ...change };
          try { localStorage.setItem(key, JSON.stringify(preferences)); } catch {}
          patch(preferences);
        };
        const subscribe = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
        const snapshot = () => state;
        function registration() {
          if (!registrationPromise) registrationPromise = (async () => {
            if (!navigator.serviceWorker || !window.isSecureContext) throw new Error(t('unsupported'));
            const workerUrl = new URL('dsh-task-bell/worker.js', new URL('.', location.href));
            const reg = await navigator.serviceWorker.register(workerUrl, { scope: new URL('.', workerUrl).pathname });
            await reg.update();
            const worker = reg.installing || reg.waiting;
            if (worker && worker.state !== 'activated') await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => finish(new Error('Service worker activation timed out')), 15000);
              function finish(error) { clearTimeout(timeout); worker.removeEventListener('statechange', changed); error ? reject(error) : resolve(); }
              function changed() {
                if (worker.state === 'activated') finish();
                else if (worker.state === 'redundant') finish(new Error('Service worker activation failed'));
              }
              worker.addEventListener('statechange', changed); changed();
            });
            if (!reg.active) throw new Error('Service worker is not active');
            return reg;
          })().catch(error => { registrationPromise = undefined; throw error; });
          return registrationPromise;
        }
        async function api(action, payload = {}) {
          const response = await fetch(new URL('dsh-task-bell/push', new URL('.', location.href)), {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DSH-Task-Bell': '1' },
            body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(25000),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
          return value;
        }
        async function show(title, body, item) {
          if (disposed || !state.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
          const reg = await registration();
          if (disposed || !state.enabled) return false;
          const url = new URL(location.href);
          if (item.sessionId) url.searchParams.set('taskBellSession', item.sessionId);
          return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => finish(new Error('Notification worker did not respond; refresh this page')), 10000);
            function finish(error, shown) { clearTimeout(timeout); channel.port1.close(); error ? reject(error) : resolve(shown); }
            channel.port1.onmessage = event => event.data?.ok ? finish(null, event.data.shown) : finish(new Error(event.data?.error || 'Notification failed'));
            try { reg.active.postMessage({ type: 'task-bell:notify', event: { ...item, title, body, url: url.href } }, [channel.port2]); }
            catch (error) { finish(error); }
          });
        }
        async function setupPush() {
          const reg = await registration();
          if (!reg.pushManager) throw new Error(t('unsupported'));
          const response = await fetch(new URL('dsh-task-bell/push-key', new URL('.', location.href)), { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`Push setup failed: HTTP ${response.status}`);
          const { publicKey } = await response.json();
          const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4));
          const applicationServerKey = Uint8Array.from(raw, character => character.charCodeAt(0));
          let subscription = await reg.pushManager.getSubscription();
          if (subscription && subscription.options.applicationServerKey) {
            const old = new Uint8Array(subscription.options.applicationServerKey);
            if (old.length !== applicationServerKey.length || old.some((byte, index) => byte !== applicationServerKey[index])) { await subscription.unsubscribe(); subscription = null; }
          }
          subscription ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
          const locale = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
          await api('subscribe', { subscription: subscription.toJSON(), url: location.href, locale });
          if (disposed) return;
          save({ enabled: true });
          patch({ pushActive: true, message: t('pushReady') });
          connect();
        }
        async function disable() {
          if (state.busy) return;
          operationRevision++;
          patch({ busy: true });
          try {
            const reg = await registration();
            const subscription = await reg.pushManager?.getSubscription();
            if (subscription) {
              await api('unsubscribe', { endpoint: subscription.endpoint });
              await subscription.unsubscribe();
            }
            save({ enabled: false }); patch({ pushActive: false, message: t('unsubscribed') }); connect();
          } catch (error) { fail(error); }
          finally { patch({ busy: false }); }
        }
        async function restorePush() {
          if (disposed || state.busy || restoring) return;
          restoring = true;
          const revision = operationRevision;
          try {
            const reg = await registration();
            const subscription = await reg.pushManager?.getSubscription();
            if (disposed || state.busy || revision !== operationRevision) return;
            if (!subscription) { patch({ pushActive: false }); return; }
            const status = await api('status', { endpoint: subscription.endpoint });
            if (disposed || state.busy || revision !== operationRevision) return;
            patch({ pushActive: status.active, message: status.active ? t('pushReady') : state.enabled ? t('pushNeeded') : '' });
            if (status.active && !state.enabled) { save({ enabled: true }); connect(); }
            if (status.lastDelivery?.ok === false) fail(new Error(status.lastDelivery.error));
          } catch (error) { if (!disposed && revision === operationRevision && state.enabled) fail(error); }
          finally { restoring = false; }
        }
        async function once(item, kind, action) {
          const run = async () => {
            if (disposed || !state.enabled) return;
            const seenKey = `dsh-task-bell.last.${kind}.${item.sessionId}`;
            try { if (localStorage.getItem(seenKey) === item.id) return; } catch {}
            if (await action()) {
              try { localStorage.setItem(seenKey, item.id); } catch {}
            }
          };
          if (navigator.locks) await navigator.locks.request('dsh-task-bell-' + kind, run);
          else await run(); // Native notification tags also coalesce on browsers without Web Locks.
        }
        async function deliver(item) {
          if (disposed || !state.enabled || Date.now() - item.time > 120000) return;
          const title = t(item.reason === 'completed' ? 'done' : item.reason === 'error' ? 'error' : 'blocked');
          await once(item, 'notification', () => show(title, t('body', { id: item.sessionId.slice(0, 12) }), item));
        }
        function connect() {
          source?.close(); source = undefined;
          patch({ connected: false });
          if (!state.enabled || disposed) return;
          source = new EventSource(new URL('dsh-task-bell/events', new URL('.', location.href)));
          source.onopen = () => patch({ connected: true });
          source.onerror = () => patch({ connected: false });
          source.onmessage = event => { try { deliver(JSON.parse(event.data)).catch(fail); } catch (error) { fail(error); } };
        }
        async function enable() {
          if (state.busy) return;
          if (!('Notification' in window) || !window.isSecureContext) { fail(new Error(t('unsupported'))); return; }
          // Keep permission request in the click gesture, before any await.
          const permission = Notification.requestPermission();
          operationRevision++;
          patch({ busy: true });
          try {
            const result = await permission;
            if (disposed) return;
            if (result !== 'granted') { patch({ message: t(result === 'denied' ? 'denied' : 'dismissed') }); return; }
            save({ enabled: true }); connect();
            await setupPush();
          } catch (error) { fail(error); }
          finally { patch({ busy: false }); }
        }
        async function test() {
          if (state.busy) return;
          if (!state.pushActive || !state.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') await enable();
          if (disposed || !state.enabled || !state.pushActive) return;
          patch({ busy: true });
          try {
            const subscription = await (await registration()).pushManager.getSubscription();
            if (!subscription) throw new Error(t('pushNeeded'));
            await api('test', { endpoint: subscription.endpoint });
            patch({ message: t('tested') });
          } catch (error) { fail(error); }
          finally { patch({ busy: false }); }
        }
        const styles = `
          .taskBell-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-family:inherit;color:var(--dsw-alias-label-primary);min-width:0}
          .taskBell-copy{flex:1;min-width:0}.taskBell-title{font-size:14px;line-height:20px;font-weight:400}
          .taskBell-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
          .taskBell-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
          .taskBell-button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:6px 8px;border-radius:6px;cursor:pointer}
          .taskBell-button:disabled,.taskBell-switch:disabled{cursor:default;opacity:.5}.taskBell-button:hover{background:var(--dsw-alias-bg-layer-2)}
          .taskBell-switch{appearance:none;position:relative;flex:none;width:32px;height:20px;border:0;border-radius:12px;background:var(--dsw-alias-state-idle-primary);padding:2px;cursor:pointer;transition:background .15s}
          .taskBell-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
          .taskBell-switch::after{content:'';display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
          .taskBell-switch[aria-checked=true]::after{transform:translateX(12px)}
          .taskBell-button:focus-visible,.taskBell-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
          @media(max-width:480px){.taskBell-row{gap:12px;flex-wrap:wrap}.taskBell-copy{flex-basis:calc(100% - 48px)}.taskBell-actions{margin-left:auto}}
        `;
        function Controls() {
          const value = React.useSyncExternalStore(subscribe, snapshot);
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getLocale());
          const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
          const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
          const active = value.enabled && granted;
          const toggle = () => value.enabled ? disable() : enable();
          const status = denied && value.enabled ? t('denied') : value.message || (value.pushActive ? t('pushReady') : value.enabled ? t('pushNeeded') : '');
          return h('div', { className: 'taskBell-row' },
            h('style', null, styles),
            h('div', { className: 'taskBell-copy' },
              h('div', { className: 'taskBell-title' }, t('title')),
              h('div', { className: 'taskBell-description' }, t('description')),
              h('div', { className: 'taskBell-description' }, t('soundHint')),
              h('div', { className: 'taskBell-description' }, t('limit')),
              status && h('div', { className: 'taskBell-description', role: 'status' }, status)),
            h('div', { className: 'taskBell-actions' },
              h('button', { type: 'button', className: 'taskBell-button', disabled: value.busy, onClick: () => test().catch(fail) }, t('test')),
              value.enabled && !value.pushActive && h('button', { type: 'button', className: 'taskBell-button', disabled: value.busy, onClick: () => enable().catch(fail) }, t('setupPush')),
              h('button', { type: 'button', className: 'taskBell-switch', role: 'switch', 'aria-checked': active, 'aria-label': t('title'), disabled: value.busy, onClick: () => toggle().catch(fail) })));
        }
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'task-bell', order: 80 }, Controls));
        ctx.effect(() => {
          const onStorage = event => {
            if (event.key !== key) return;
            try {
              operationRevision++;
              preferences = { ...preferences, ...JSON.parse(event.newValue || '{}') };
              patch({ ...preferences, pushActive: false, message: '' }); connect();
              if (preferences.enabled) void restorePush();
            } catch {}
          };
          const onResume = () => { if (document.visibilityState === 'visible') void restorePush(); };
          const statusTimer = setInterval(() => { if (state.enabled) void restorePush(); }, 60000);
          const onMessage = event => {
            if (event.origin !== location.origin) return;
            if (event.data?.type === 'task-bell:client-info') {
              event.ports?.[0]?.postMessage({ type: 'task-bell:client-info:ack', standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true });
              return;
            }
            if (event.data?.type !== 'task-bell:open-session') return;
            if (typeof event.data.sessionId !== 'string') return;
            try {
              if (event.data.sessionId) ctx.uiWorkspace.openSession(event.data.sessionId);
              event.ports?.[0]?.postMessage({ type: 'task-bell:open-session:ack' });
            } catch { /* Worker navigates to the complete session URL if routing fails. */ }
          };
          window.addEventListener('storage', onStorage);
          window.addEventListener('focus', onResume);
          document.addEventListener('visibilitychange', onResume);
          navigator.serviceWorker?.addEventListener('message', onMessage);
          const url = new URL(location.href);
          if (url.searchParams.get('taskBellSession')) {
            ctx.uiWorkspace.openSession(url.searchParams.get('taskBellSession'));
            url.searchParams.delete('taskBellSession'); history.replaceState(history.state, '', url);
          }
          connect();
          void restorePush();
          return () => {
            disposed = true; source?.close();
            clearInterval(statusTimer);
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('focus', onResume);
            document.removeEventListener('visibilitychange', onResume);
            navigator.serviceWorker?.removeEventListener('message', onMessage);
          };
        });
      }
    };
  }
});
