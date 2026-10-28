import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { buildWindowRecoveryView } from '../src/openai-window-recovery.mjs';

test('missing message projection fails closed; supplied projection is applied on a detached copy', () => {
  const session = Session.create('projection');
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before' }] }), { surfaceOp: 'append' });
  const events = [...session.snapshotEvents(), { type: 'image/offload', seq: 1, time: Date.now(), data: {} }];
  const before = JSON.stringify(events);
  assert.throws(() => buildWindowRecoveryView({ events }), /requires a message projection/);
  const projection = { type: 'image/offload', project(_event, { events: copy }) {
    const original = copy[0].data;
    return new Map([[0, { ...original, content: [{ type: 'text', text: 'projected' }] }]]);
  } };
  const view = buildWindowRecoveryView({ events, projections: [projection] });
  assert.equal(view.entries[0].message.content[0].text, 'projected');
  assert.equal(JSON.stringify(events), before);
});
