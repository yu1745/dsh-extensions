// Shared by Host and Client. This module performs no I/O.
export const OPENAI_CONTEXT_MODES = Object.freeze(['windows', 'remote']);
export const DEFAULT_OPENAI_CONTEXT_MODE = 'windows';
export const OPENAI_REMOTE_SPEEDS = Object.freeze(['standard', 'fast']);
export const DEFAULT_OPENAI_REMOTE_SPEED = 'standard';
export function isOpenaiContextMode(value) {
  return value === 'windows' || value === 'remote';
}
export function isOpenaiRemoteSpeed(value) {
  return value === 'standard' || value === 'fast';
}
export function settingSnapshot(descriptor) {
  const remoteSpeed = descriptor?.value?.remoteSpeed === undefined
    ? DEFAULT_OPENAI_REMOTE_SPEED : descriptor.value.remoteSpeed;
  if (!descriptor || !isOpenaiContextMode(descriptor.value?.mode) || !isOpenaiRemoteSpeed(remoteSpeed) ||
      !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0)
    throw new Error('OpenAI context setting is unavailable or invalid');
  return { mode: descriptor.value.mode, remoteSpeed, revision: descriptor.revision };
}
