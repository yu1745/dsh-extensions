import { commitRemoteCheckpoint, replayRemoteCheckpoint, CheckpointError } from './openai-remote-checkpoint-prototype.mjs';

/** Orchestrates remote compaction once the caller has selected remote mode.
 * Authentication, exact payload capture and canonical-output validation remain
 * caller-provided boundaries. This module never falls back to a text summary.
 */
export class RemoteCompactionController {
  constructor({ ctx, route, identity, initializeIdentity, isActive, needsRecovery, prepare, verifyCanonicalOutput, extraTokens, config }) {
    if (!ctx?.llm || !ctx?.tokenMeter || !ctx?.sessions || typeof route !== 'function' ||
        typeof identity !== 'function' || typeof isActive !== 'function' || typeof needsRecovery !== 'function' || typeof prepare !== 'function' ||
        typeof verifyCanonicalOutput !== 'function' || typeof extraTokens !== 'function')
      throw new Error('Remote compaction dependencies unavailable');
    Object.assign(this, { ctx, route, identity, initializeIdentity, isActive, needsRecovery, prepare, verifyCanonicalOutput, extraTokens, config });
    this.uncertainDurability = new WeakSet();
  }
  replay(agent, payload, identity) {
    return replayRemoteCheckpoint({ session: agent.session, payload, identity, verifyCanonicalOutput: this.verifyCanonicalOutput });
  }
  // After a post-replacement error, the caller must run this before another
  // model request. A successful real SessionStore flush re-establishes the
  // durability barrier; no model request should use an unflushed checkpoint.
  async ensureDurable(agent, force = false) {
    if (!force && !this.uncertainDurability.has(agent)) return;
    if (await this.ctx.sessions.flush(agent.session) !== true) throw new Error('Remote checkpoint durability unavailable');
    this.uncertainDurability.delete(agent);
  }
  async resolveIdentity(agent, signal, engine) {
    signal?.throwIfAborted();
    if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) throw new Error('Remote compaction engine is no longer active');
    if (!this.identity(agent) && this.initializeIdentity) await this.initializeIdentity(agent, signal, engine);
    signal?.throwIfAborted();
    if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) throw new Error('Remote compaction engine is no longer active');
    const identity = this.identity(agent);
    if (!identity) throw new Error('Remote compaction identity unavailable');
    return identity;
  }
  async compactIfNeeded(agent, trigger, signal, engine) {
    signal.throwIfAborted();
    await this.ensureDurable(agent);
    signal.throwIfAborted();
    if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) return null;
    if (!['pressure', 'context-overflow'].includes(trigger)) throw new Error('Unknown compaction trigger');
    const selected = { ...this.route(agent) };
    if (!selected?.provider || !selected?.model) throw new Error('Remote compaction route unavailable');
    // An already rolled alpha window must be recovered before the next model
    // request, even when the visible recovery pointer appears very small.
    if (trigger === 'pressure' && !this.needsRecovery(agent)) {
      const info = await this.ctx.llm.resolveModelInfo(selected.provider, selected.model, signal);
      signal.throwIfAborted();
      if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) return null;
      const window = info?.context?.contextWindow;
      if (!Number.isSafeInteger(window) || window <= 0) throw new Error('Remote compaction context capacity unavailable');
      const reserved = agent.options?.maxTokens ?? agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
      const threshold = Math.max(0, Math.min(Math.floor(window * this.config.thresholdRatio), window - reserved - this.config.headroomTokens));
      // A resumed checkpoint needs authenticated identity even when no new
      // ordinary model request has populated the in-memory transport cache.
      await this.resolveIdentity(agent, signal, engine);
      if (JSON.stringify(this.route(agent)) !== JSON.stringify(selected)) throw new Error('Remote compaction route changed');
      const extra = this.extraTokens(agent);
      if (!Number.isSafeInteger(extra) || extra < 0) throw new Error('Remote checkpoint token estimate unavailable');
      if (this.ctx.tokenMeter.measure(agent.session).totalTokens + extra < threshold) return null;
    }
    const range = engine.windowRange(agent.session);
    if (!range) return null;
    return this.commit(agent, range.start, range.end, signal, engine, 'automatic');
  }
  // The engine reserves runMaintenance before calling this method.
  async compactNow(agent, signal, sourceCommandId, engine) {
    signal.throwIfAborted();
    await this.ensureDurable(agent);
    signal.throwIfAborted();
    if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) throw new Error('Remote compaction engine is no longer active');
    const range = engine.windowRange(agent.session);
    if (!range) return null;
    return this.commit(agent, range.start, range.end, signal, engine, 'manual', sourceCommandId);
  }
  async compactRegion(agent, start, end, signal, engine) {
    signal?.throwIfAborted();
    await this.ensureDurable(agent);
    signal?.throwIfAborted();
    if (!engine.remoteServes(agent) || !this.isActive(agent, engine)) throw new Error('Remote compaction engine is no longer active');
    const range = engine.windowRange(agent.session);
    if (!range || range.start !== start || range.end !== end) throw new Error('Remote compaction requires the whole balanced window');
    return this.commit(agent, start, end, signal, engine, 'automatic');
  }
  async commit(agent, start, end, signal, engine, mode, sourceCommandId) {
    const session = agent.session, initialRoute = { ...this.route(agent) };
    const nodes = [...session.surface.nodes];
    const contentGeneration = session.surface.contentGeneration;
    const replaceGeneration = session.surface.replaceGeneration;
    const identity = await this.resolveIdentity(agent, signal, engine);
    const afterIdentity = this.route(agent);
    if (agent.session !== session || afterIdentity?.provider !== initialRoute.provider || afterIdentity?.model !== initialRoute.model)
      throw new Error('Remote compaction route or session changed');
    const first = nodes.indexOf(start), last = nodes.indexOf(end);
    if (first < 0 || last < first) throw new Error('Remote compaction range unavailable');
    const seqs = new Set(nodes.slice(first, last + 1));
    const measurement = this.ctx.tokenMeter.measure(agent.session);
    const shadowedTokenCount = measurement.nodes.filter((node) => seqs.has(node.seq)).reduce((n, node) => n + node.heuristicTokens, 0);
    const selected = this.route(agent);
    if (!selected?.provider || !selected?.model || selected.provider !== identity.provider || selected.model !== identity.model)
      throw new Error('Remote compaction route changed');
    const info = await this.ctx.llm.resolveModelInfo(selected.provider, selected.model, signal);
    signal?.throwIfAborted();
    if (agent.session !== session || !engine.remoteServes(agent) || !this.isActive(agent, engine) || JSON.stringify(this.identity(agent)) !== JSON.stringify(identity))
      throw new Error('Remote compaction route or engine changed');
    if (agent.session !== session || contentGeneration !== agent.session.surface.contentGeneration || replaceGeneration !== agent.session.surface.replaceGeneration ||
        JSON.stringify(nodes) !== JSON.stringify([...agent.session.surface.nodes]))
      throw new Error('Remote compaction surface changed');
    const capacity = info?.context?.contextWindow;
    const reserved = agent.options?.maxTokens ?? agent.session.requestHeader()?.config.maxTokens ?? info?.defaultMaxTokens ?? 0;
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isSafeInteger(reserved) || reserved < 0)
      throw new Error('Remote compaction context capacity unavailable');
    const available = capacity - reserved - this.config.headroomTokens;
    const outside = Math.max(0, measurement.totalTokens - shadowedTokenCount);
    if (available <= outside) throw new Error('Remote compaction has no safe context budget');
    const extra = this.extraTokens(agent);
    if (!Number.isSafeInteger(extra) || extra < 0) throw new Error('Remote checkpoint token estimate unavailable');
    try {
      return await commitRemoteCheckpoint({ session, start, end, identity, signal, mode, sourceCommandId, shadowedTokenCount,
      verifyCanonicalOutput: this.verifyCanonicalOutput,
      prepare: async (abort) => {
        const output = await this.prepare({ agent, identity, start, end, signal: abort });
        abort?.throwIfAborted();
        if (agent.session !== session || !engine.remoteServes(agent) || !this.isActive(agent, engine) || JSON.stringify(this.identity(agent)) !== JSON.stringify(identity))
          throw new Error('Remote compaction route or engine changed');
        // Use a conservative byte heuristic; an opaque provider checkpoint does
        // not expose its real token count. Refuse an obviously non-shrinking
        // replacement instead of hiding the original history.
        const encoded = JSON.stringify(output);
        if (typeof encoded !== 'string') throw new Error('Remote compaction output is invalid');
        const bytes = Buffer.byteLength(encoded, 'utf8');
        if (Math.ceil(bytes / 4) >= shadowedTokenCount + extra)
          throw new CheckpointError('output-not-smaller');
        // A byte upper-bound is deliberately stricter than the token heuristic;
        // reject candidates that might not fit with system/envelope and headroom.
        if (bytes + outside >= available)
          throw new CheckpointError('output-over-budget');
        return output;
      },
      flush: async (s) => {
        if (await this.ctx.sessions.flush(s) !== true) throw new Error('Session durability unavailable');
      },
      });
    } catch (error) {
      if (error?.replaced === true) this.uncertainDurability.add(agent);
      throw error;
    }
  }
}
