import { isOpenaiContextMode, isOpenaiRemoteSpeed, settingSnapshot } from './openai-context-setting-shared.mjs';

export function createSettingsSubscription(scope, namespace) {
  if (!scope?.remote || typeof scope.remote.$on !== 'function' || typeof scope.on !== 'function')
    throw new Error('Settings notifications are unavailable');
  return notify => {
    const offSettings = scope.remote.$on('settings/document-updated', ns => { if (ns === namespace) notify(); });
    const offConnection = scope.on('connection/reset', notify);
    return () => { offSettings(); offConnection(); };
  };
}

function unwrap(response) {
  if (!response?.ok) throw new Error(response?.error?.message || 'Settings operation failed');
  return response.value;
}
/** Adapter for the inspected settingsController Remote. No direct profile writes. */
export function createOpenaiContextSettingsClient(remote, namespace) {
  if (!remote || typeof remote.describe !== 'function' || typeof remote.update !== 'function' || typeof namespace !== 'string' || !namespace)
    throw new Error('Settings service is unavailable');
  return {
    async read() {
      const view = unwrap(await remote.describe());
      const matches = Array.isArray(view?.namespaces) ? view.namespaces.filter(row => row.ns === namespace) : [];
      if (matches.length !== 1) throw new Error('OpenAI context settings namespace is unavailable or ambiguous');
      return { ...settingSnapshot(matches[0]), writable: view.writable === true };
    },
    async save(value, expectedRevision) {
      // Legacy save(mode, revision) only changes mode; do not reset a saved
      // remote speed. The settings UI saves both fields in one fenced patch.
      const patch = typeof value === 'string' ? { mode: value }
        : { mode: value?.mode, remoteSpeed: value?.remoteSpeed };
      if (!isOpenaiContextMode(patch.mode) ||
          (typeof value !== 'string' && !isOpenaiRemoteSpeed(patch.remoteSpeed)) ||
          !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error('Invalid OpenAI context setting or revision');
      const row = unwrap(await remote.update(namespace, patch, expectedRevision));
      if (row?.ns !== namespace) throw new Error('Unexpected OpenAI context settings response');
      return { ...settingSnapshot(row), writable: true };
    },
  };
}
