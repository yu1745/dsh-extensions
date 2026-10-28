import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { RemoteCompactionController } from '../src/openai-remote-controller.mjs';
import { makeRemotePrepare, verifyRemoteOutput, extraRemoteCheckpointTokens } from '../src/openai-remote-prepare.mjs';
import { replayRemoteCheckpoint } from '../src/openai-remote-checkpoint-prototype.mjs';

const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
for (const api of ['openai-codex-responses', 'openai-responses']) test(`${api}: offline remote transaction, reload and in-place replay`, async () => {
  const session = Session.create(`flow-${api}`), identity = { provider: api === 'openai-responses' ? 'openai' : 'openai-codex', model: 'gpt-test', backendId: 'account-endpoint-fingerprint' };
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  const original = session.append('user/message', user('task:' + 'x'.repeat(800)), { surfaceOp: 'append' }).seq;
  const agent = { id: session.id, session, options: identity }, signal = new AbortController().signal;
  const engine = { remoteServes: () => true, windowRange: () => ({ start: session.surface.nodes[1], end: session.surface.nodes.at(-1) }) };
  let fail = true, durable, calls = 0;
  const ctx = { sessions: { messageProjections: [], flush: async s => { durable = s.snapshotEvents(); return true; } }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 10000 }, defaultMaxTokens: 0 }) }, tokenMeter: { measure: () => ({ totalTokens: 9000, nodes: session.surface.nodes.map(seq => ({ seq, heuristicTokens: 1000 })) }) } };
  const fetch = async (_url, init) => {
    calls++;
    if (fail) return new Response('private failure body', { status: 503 });
    const request = JSON.parse(init.body), kept = request.input.filter(item => item.role === 'user');
    const compact = { type: 'compaction', encrypted_content: 'opaque-checkpoint' };
    if (api === 'openai-responses') return new Response(JSON.stringify({ object: 'response.compaction', output: [...kept, compact] }));
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: compact })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n\n`);
  };
  const prepare = makeRemotePrepare({ ctx, fetch, openLease: () => ({ signal: new AbortController().signal, check() {}, dispose() {} }), needsRecovery: () => false, transformAlphaInput: p => p, validateCapture: () => true,
    capture: async ({ options }) => ({ api, url: 'https://example.invalid/v1/responses', headers: { authorization: 'Bearer synthetic' }, payload: { model: identity.model, instructions: 'system', stream: true, input: options.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content.map(b => ({ type: 'input_text', text: b.text })) })) } }),
  });
  const controller = new RemoteCompactionController({ ctx, route: () => identity, identity: () => identity, isActive: () => true, needsRecovery: () => false, prepare, verifyCanonicalOutput: verifyRemoteOutput, extraTokens: () => extraRemoteCheckpointTokens(agent, identity), config: { thresholdRatio: 0.8, headroomTokens: 100 } });
  await assert.rejects(controller.compactIfNeeded(agent, 'pressure', signal, engine));
  assert.equal(session.surface.nodes[1], original, 'failure must retain the original context');
  fail = false;
  const result = await controller.compactIfNeeded(agent, 'pressure', signal, engine);
  assert.equal(result.durable, true); assert.equal(result.shadowedSeqs[0], original);
  const restored = Session.create(session.id, durable, session.header), marker = restored.eventAt(restored.surface.nodes.at(-1)).data.content[0].text;
  const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: marker }] }, { role: 'user', content: [{ type: 'input_text', text: 'later' }] }] };
  const replay = replayRemoteCheckpoint({ session: restored, identity, payload, verifyCanonicalOutput: verifyRemoteOutput });
  assert.equal(replay.input.at(-1).content[0].text, 'later');
  assert.equal(replay.input.at(-2).encrypted_content, 'opaque-checkpoint');
  assert.ok(!JSON.stringify(replay).includes('<dsh-remote-compaction-v1>'));
  assert.equal(calls, 2);
});
