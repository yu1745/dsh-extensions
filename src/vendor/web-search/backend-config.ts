import { settings, updateSettings } from '../../state.js';
export type WebSearchBackend = 'google'|'openai'|'deepseek'|'minimax'|'zai';
export const backends: WebSearchBackend[] = ['google','openai','deepseek','minimax','zai'];
let configured: WebSearchBackend | undefined;
export function configureBackend(backend?: WebSearchBackend) { configured = backend; }
export function getWebSearchBackend(): WebSearchBackend { const b = settings().webSearchBackend ?? configured ?? 'google'; if (!backends.includes(b)) throw new Error(`Unknown search backend: ${b}`); return b; }
export function setWebSearchBackend(backend: WebSearchBackend) { if (!backends.includes(backend)) throw new Error('Unknown backend'); updateSettings({webSearchBackend:backend}); }
