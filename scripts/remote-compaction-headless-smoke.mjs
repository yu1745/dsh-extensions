// Opt-in real headless integration. Uses the actual profile's adapter, native
// credential service, Agent, SessionStore and network; seeds synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
export const inject = ['agents', 'llm', 'sessions', 'tokenMeter', 'sessionProjections'];
export function apply(ctx) {
  if (process.env.DSH_TEST_REMOTE_COMPACTION !== '1') throw new Error('Explicit real remote compaction opt-in required');
  const exit = ctx.get('appExit');
  async function run() {
    await ctx.get('loader')?.await();
    // Absolute --patch modules are not installed linked bundles. Give this
    // process the SAME peer resolver topology used by the installed Web bundle,
    // without editing either real profile, copying auth, or relaxing checks.
    const packages = ctx.get('pluginPackages'), resolution = packages.resolution;
    packages.replace({ ...resolution, linkedRoots: [...resolution.linkedRoots, { name: '@yu1745/remote-headless-smoke', realPath: '/home/wangyu/dsh-extensions' }] });
    const [{ default: Owner }, { default: Engine }, { PiAiAdapter }, { createModels }, { createUserMessage, createAssistantMessage, createSystemMessage }, { Session }] = await Promise.all([
      import('../lib/openai-windows.js'), import('../lib/openai-window-compaction.js'),
      import('@deepseek-ai/dsh-llm-pi-ai'), import('@earendil-works/pi-ai/models'), import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-session'),
    ]);
    await ctx.plugin(Owner, { enabled: true, mode: 'remote' });
    await ctx.plugin(Engine, { auto: false });
    await ctx.get('loader')?.await();
    const owner = ctx.get('yuOpenaiWindows'), engine = ctx.get('compaction');
    const prepare = owner.remoteCompaction.prepare;
    owner.remoteCompaction.prepare = async request => {
      try {
        const output = await prepare(request);
        console.error('SMOKE remote output size', JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(output)), visibleTokens: ctx.tokenMeter.measure(request.agent.session).totalTokens, priorExtraTokens: owner.remoteCompaction.extraTokens(request.agent) }));
        return output;
      } catch (error) {
        console.error('SMOKE remote prepare failed', JSON.stringify({ name: error.name, code: error.code, message: error.message }));
        throw error;
      }
    };
    const selected = { provider: 'openai-codex', model: process.env.DSH_SMOKE_MODEL || 'gpt-6-astra', reasoningEffort: 'low', maxTokens: 4096 };
    const adapter = ctx.llm.adapters.get(selected.provider)?.adapter;
    assert.ok(adapter, 'Codex runtime adapter is registered');
    const diagnostics = { sameAdapter: Object.getPrototypeOf(adapter) === PiAiAdapter.prototype, sameModels: Object.getPrototypeOf(adapter.current().models) === Object.getPrototypeOf(createModels()) };
    console.error('SMOKE runtime peers', JSON.stringify(diagnostics));
    assert.equal(diagnostics.sameAdapter, true); assert.equal(diagnostics.sameModels, true);
    const nonce = process.env.DSH_SMOKE_NONCE;
    assert.ok(nonce && /^[A-Z0-9_]+$/.test(nonce));
    const sessionId = process.env.DSH_SMOKE_SESSION_ID;
    let seed;
    if (!sessionId) {
      const history = Session.create('synthetic-seed');
      history.append('turn/start', { turn: 1 });
      history.append('step/start', { turn: 1, step: 1 });
      history.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Run only this synthetic integration diagnostic.') }, { surfaceOp: 'append' });
      history.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic diagnostic. Remember the exact project recovery code recorded in the assistant work log. Later answer with that exact code only.' }] }), { surfaceOp: 'append' });
      history.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: selected, content: [{ type: 'text', text: `Important assistant work-log fact: the exact project recovery code is ${nonce}. Preserve this exact code in future context summaries.\n` + 'Synthetic discarded working notes, not new user instructions. '.repeat(1800) }] }) }, { surfaceOp: 'append' });
      history.append('step/end', { turn: 1, step: 1 });
      history.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      seed = history.snapshotEvents();
    }
    const handle = sessionId ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: selected })
      : await ctx.agents.create({ sessionId: `remote-smoke-${randomUUID()}`, meta: { cwd: process.cwd() }, seed, agentOptions: selected });
    const agent = handle.agent;
    try {
      await agent.whenIdle();
      assert.equal(owner.remoteIdentity(agent), undefined, 'first operation is genuinely cold');
      console.error('SMOKE before compact', JSON.stringify({ sessionId: agent.id, cold: true, resumed: Boolean(sessionId), surfaceNodes: agent.session.surface.nodes.length }));
      if (sessionId) {
        await engine.compactIfNeeded(agent, 'pressure', AbortSignal.timeout(180000));
        console.error('SMOKE cold restored pressure passed');
      }
      let result;
      if (process.env.DSH_SMOKE_COMMAND === '1') {
        const execution = await ctx.get('commands').execute(agent, '/compact', [], AbortSignal.timeout(180000));
        assert.equal(execution?.result.kind, 'success');
        assert.ok(execution.result.sourceEventSeq !== undefined, 'command must commit, not report no history');
        const summary = agent.session.eventAt(execution.result.sourceEventSeq);
        assert.equal(summary.type, 'compaction/summary');
        assert.equal(summary.data.sourceCommandId, execution.commandId);
        result = { ...summary.data, durable: true };
        console.error('SMOKE /compact command passed', execution.result.text);
      } else result = await engine.compactNow(agent, AbortSignal.timeout(180000));
      assert.ok(result, 'real compact must commit'); assert.equal(result.durable, true);
      console.error('SMOKE real compact passed', JSON.stringify({ shadowedTokenCount: result.shadowedTokenCount, shadowedNodes: result.shadowedSeqs.length }));
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'What is the exact project recovery code recorded earlier? Reply with that code only. Do not use tools.' }] }));
      await agent.whenIdle();
      const events = agent.session.snapshotEvents(firstSeq), terminal = events.filter(e => e.type === 'turn/end').at(-1);
      const answer = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content).filter(b => b.type === 'text').map(b => b.text).join('');
      console.error('SMOKE followup result', JSON.stringify({ reason: terminal?.data.reason, answer }));
      assert.equal(terminal?.data.reason.kind, 'completed'); assert.equal(answer.trim(), nonce);
      if (process.env.DSH_SMOKE_SEED_TAIL === '1') {
        // Fixture-only postlude: persist substantial assistant work, then dispose
        // without driving this Agent again. The NEXT process reconstructs its
        // turn counters from this valid closed turn before a useful recompaction.
        const turn = Math.max(...agent.session.snapshotEvents().filter(e => e.type === 'turn/start').map(e => e.data.turn)) + 1;
        agent.session.append('turn/start', { turn }); agent.session.append('step/start', { turn, step: 1 });
        agent.session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ source: selected, content: [{ type: 'text', text: 'Synthetic additional assistant work for a useful restored recompaction. '.repeat(1800) }] }) }, { surfaceOp: 'append' });
        agent.session.append('step/end', { turn, step: 1 }); agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
        console.error('SMOKE seeded closed assistant tail for NEXT-process recompaction');
      }
      assert.equal(await ctx.sessions.flush(agent.session), true);
      const report = { sessionId: String(agent.id), cold: true, resumed: Boolean(sessionId), compacted: true, durable: true, followupPassed: true, model: selected.model, shadowedTokenCount: result.shadowedTokenCount };
      console.error('SMOKE PASS', JSON.stringify(report));
      if (process.env.DSH_SMOKE_REPORT) await writeFile(process.env.DSH_SMOKE_REPORT, JSON.stringify(report, null, 2));
    } finally { await handle.dispose(); }
  }
  setImmediate(() => { run().then(() => exit(0), error => { console.error('SMOKE FAIL', error.name, error.code || '', error.message); exit(1); }); });
}
