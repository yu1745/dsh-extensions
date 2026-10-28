import test from 'node:test';
import assert from 'node:assert/strict';
import { makeV2WindowCandidate } from '../src/openai-v2-window-candidate.mjs';

const compaction = { type: 'compaction', encrypted_content: 'opaque', id: 'cmp_1' };
test('preserves every entire user input in order without mutating or truncating', () => {
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(100000) }] },
    { type: 'function_call', call_id: '1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: '1', output: 'result' },
    { role: 'user', type: 'message', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
  ];
  const before = structuredClone(input);
  const candidate = makeV2WindowCandidate(input, compaction);
  assert.equal(candidate.kind, 'candidate-only');
  assert.deepEqual(candidate.output, [input[0], input[3], compaction]);
  assert.deepEqual(input, before);
  candidate.output[0].content[0].text = 'changed';
  assert.deepEqual(input, before);
});
test('fails closed for unresolved window pointers, invalid output and unknown user items', () => {
  assert.throws(() => makeV2WindowCandidate([{ role: 'user', content: '<dsh-openai-window>{}' }], compaction), /Unresolved/);
  assert.throws(() => makeV2WindowCandidate([{ role: 'user', type: 'unknown', content: 'x' }], compaction), /Unsupported/);
  assert.throws(() => makeV2WindowCandidate([{ type: 'compaction_trigger' }], compaction), /trigger/);
  assert.throws(() => makeV2WindowCandidate([], { type: 'compaction_summary', encrypted_content: 'x' }), /Invalid/);
  assert.throws(() => makeV2WindowCandidate([], { type: 'compaction', encrypted_content: '' }), /Invalid/);
});
