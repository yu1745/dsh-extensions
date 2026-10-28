import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { commitRemoteCheckpoint } from '../src/openai-remote-checkpoint-prototype.mjs';
import { makeRemotePrepare, verifyRemoteOutput, extraRemoteCheckpointTokens } from '../src/openai-remote-prepare.mjs';
const identity = { provider: 'openai-codex', model: 'gpt-test', backendId: 'test-id' };
const prior = [{ role: 'user', content: [{ type: 'input_text', text: 'old user' }] }, { type: 'compaction', encrypted_content: 'old-opaque' }];
const user = (text, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] });
const openLease = () => ({ signal: new AbortController().signal, check() {}, dispose() {} });
function setup(api = 'openai-codex-responses') {
  const session = Session.create('remote-prepare');
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  const a = session.append('user/message', user('task'), { surfaceOp: 'append' }).seq;
  let capturedOptions, sends = [];
  const fetch = async (url, init) => {
    sends.push({ url, init });
    if (api === 'openai-responses') return new Response(JSON.stringify({ object: 'response.compaction', output: prior }));
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'new-opaque' } })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n\n`);
  };
  const prepare = makeRemotePrepare({ openLease, ctx: { sessions: { messageProjections: [] } }, fetch,
    capture: async ({ options }) => { capturedOptions = options; return { api, url: 'https://example.invalid/v1/responses', headers: { authorization: 'Bearer fake' }, payload: { model: identity.model, instructions: 'system', stream: true, input: options.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content.map(b => ({ type: 'input_text', text: b.text })) })) } }; },
    validateCapture: () => true, transformAlphaInput: p => p, needsRecovery: () => false,
  });
  return { session, agent: { session }, a, prepare, capturedOptions: () => capturedOptions, sends: () => sends };
}
test('provider output validation rejects unknown user content instead of losing it', () => {
  assert.equal(verifyRemoteOutput([{ role: 'user', content: [{ type: 'unknown', data: 'secret' }] }, { type: 'compaction', encrypted_content: 'x' }], identity), false);
});
test('v2 path preserves all user inputs and sends exactly one compaction trigger', async () => {
  const h = setup(); const out = await h.prepare({ agent: h.agent, identity, start: h.a, end: h.a });
  assert.equal(h.capturedOptions().messages[0].role, 'system');
  assert.deepEqual(out, [{ role: 'user', content: [{ type: 'input_text', text: 'task' }] }, { type: 'compaction', encrypted_content: 'new-opaque' }]);
  assert.equal(verifyRemoteOutput(out, identity), true);
  assert.equal(JSON.parse(h.sends()[0].init.body).input.at(-1).type, 'compaction_trigger');
});
test('capture uses the actual routed request controls and a pending reasoning selection', async () => {
  const h = setup();
  h.session.append('request/header', { header: { config: { provider: identity.provider, model: identity.model, reasoningEffort: 'high', temperature: 0.4, maxTokens: 7777 } }, reason: 'initial' });
  await h.prepare({ agent: h.agent, identity, start: h.a, end: h.a });
  assert.equal(h.capturedOptions().reasoningEffort, 'high'); assert.equal(h.capturedOptions().temperature, 0.4); assert.equal(h.capturedOptions().maxTokens, 7777);
  h.agent.ctx = { get: () => ({ agents: { selectionFor: () => ({ current: { provider: identity.provider, model: identity.model, reasoningEffort: 'low' } }) } }) };
  await h.prepare({ agent: h.agent, identity, start: h.a, end: h.a });
  assert.equal(h.capturedOptions().reasoningEffort, 'low');
});
test('standard path forwards canonical output in order without dropping items', async () => {
  const h = setup('openai-responses'); const out = await h.prepare({ agent: h.agent, identity, start: h.a, end: h.a });
  assert.deepEqual(out, prior); assert.match(h.sends()[0].url, /responses\/compact$/);
});
test('recompaction expands the prior opaque checkpoint before sending', async () => {
  const h = setup();
  await commitRemoteCheckpoint({ session: h.session, start: h.a, end: h.a, identity, mode: 'automatic', prepare: async () => prior, verifyCanonicalOutput: verifyRemoteOutput, flush: async () => true });
  const marker = h.session.surface.nodes.at(-1);
  const out = await h.prepare({ agent: h.agent, identity, start: marker, end: marker });
  const body = JSON.parse(h.sends()[0].init.body);
  assert.deepEqual(body.input.slice(0, -1), prior);
  assert.ok(!JSON.stringify(body.input).includes('<dsh-remote-compaction-v1>'));
  assert.ok(extraRemoteCheckpointTokens(h.agent, identity) >= 0);
  assert.equal(out.at(-1).encrypted_content, 'new-opaque');
});
test('invalidated lease fails before fetch and during an in-flight request', async () => {
  const session = Session.create('lease'); const seq = session.append('user/message', user('task'), { surfaceOp: 'append' }).seq;
  for (const when of ['before-fetch', 'in-flight']) {
    const control = new AbortController(); let valid = true, sent = 0, disposed = false, begin;
    const started = new Promise(resolve => { begin = resolve; });
    const lease = () => ({ signal: control.signal, check() { if (!valid) throw new Error('stale lease'); }, dispose() { disposed = true; } });
    const prepare = makeRemotePrepare({ openLease: lease, ctx: { sessions: { messageProjections: [] } }, needsRecovery: () => false,
      capture: async () => ({ api: 'openai-codex-responses', url: 'https://example.invalid/responses', headers: {}, payload: { model: 'gpt-test', instructions: 'x', input: [] } }),
      validateCapture: () => true, transformAlphaInput: p => { if (when === 'before-fetch') valid = false; return p; },
      fetch: async () => { sent++; begin(); return new Promise(() => {}); } });
    const pending = prepare({ agent: { session }, identity, start: seq, end: seq });
    if (when === 'in-flight') { await started; valid = false; control.abort(); }
    await assert.rejects(pending);
    assert.equal(sent, when === 'before-fetch' ? 0 : 1); assert.equal(disposed, true);
  }
});
test('untrusted captured identity never sends remote compaction', async () => {
  const session = Session.create('wrong-id');
  const seq = session.append('user/message', user('task'), { surfaceOp: 'append' }).seq;
  let network = false;
  const prepare = makeRemotePrepare({ openLease, ctx: { sessions: { messageProjections: [] } }, capture: async () => ({ payload: { input: [] } }), validateCapture: () => false, transformAlphaInput: p => p, needsRecovery: () => false, fetch: async () => { network = true; } });
  await assert.rejects(prepare({ agent: { session }, identity, start: seq, end: seq }), e => e.code === 'prepare-capture-failed');
  assert.equal(network, false);
});
test('prior alpha history with opaque notes fails closed before serialization or network', async () => {
  const session = Session.create('recovery'); session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  const call = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'openai-codex', model: 'gpt-test' }, content: [{ type: 'tool-call', id: 'call', name: 'notes_write_file', arguments: '{}' }] }) }, { surfaceOp: 'append' }).seq;
  const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'call', content: [{ type: 'text', text: JSON.stringify({ encrypted_output: 'secret' }) }], isError: false }) }, { surfaceOp: 'append' }).seq;
  session.append('step/end', { turn: 1, step: 1 });
  const marker = session.append('user/message', user('<dsh-openai-window>' + JSON.stringify({ version: 1, windowId: 'w', sessionId: 's' }), { kind: 'compact-checkpoint', compactionId: 'old' }), { surfaceOp: { op: 'replace', startSeq: call, endSeq: result }, sourceEventSeqs: [call, result] }).seq;
  let attempted = false;
  const prepare = makeRemotePrepare({ openLease, ctx: { sessions: { messageProjections: [] } }, capture: async () => { attempted = true; }, validateCapture: () => true, transformAlphaInput: p => p, needsRecovery: () => true, fetch: async () => { attempted = true; } });
  await assert.rejects(prepare({ agent: { session }, identity, start: marker, end: marker }), e => e.code === 'prepare-input-failed');
  assert.equal(attempted, false); assert.deepEqual(session.surface.nodes, [marker]);
});
