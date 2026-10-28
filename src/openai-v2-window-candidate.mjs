// Codex v2 returns one opaque item rather than the canonical output array of
// /responses/compact. This helper builds a *candidate* following the local
// Codex implementation's retained-user-message + compaction convention. It is
// deliberately not a commit or proof that a server will accept the candidate.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve every complete user message in order: never silently truncate it. */
export function makeV2WindowCandidate(input, compaction) {
  if (!Array.isArray(input) || !object(compaction) || compaction.type !== 'compaction' ||
      typeof compaction.encrypted_content !== 'string' || !compaction.encrypted_content.length)
    throw new Error('Invalid v2 compaction result');
  const kept = [];
  for (const item of input) {
    if (!object(item)) throw new Error('Invalid v2 input item');
    if (item.type === 'compaction_trigger') throw new Error('Unexpected trigger in v2 input');
    if (item.role !== 'user') continue;
    if (item.type !== undefined && item.type !== 'message')
      throw new Error('Unsupported user item in v2 input');
    if (typeof item.content !== 'string' && !Array.isArray(item.content))
      throw new Error('Invalid user message in v2 input');
    const text = JSON.stringify(item.content);
    // Recovery pointers have to be resolved against their source events before
    // compaction. Carrying a pointer into the new candidate loses the history.
    if (text.includes('<dsh-openai-window>') || text.includes('<dsh-remote-compaction-v1>'))
      throw new Error('Unresolved prior checkpoint in v2 input');
    kept.push(item);
  }
  const output = structuredClone([...kept, compaction]);
  return { kind: 'candidate-only', output };
}
