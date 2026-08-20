import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonlLine } from '../lib/codex-events.mjs';

test('JSONL parser preserves Codex event type and thread id', () => {
  const event = parseJsonlLine('{"type":"thread.started","thread_id":"t1"}');
  assert.deepEqual(event, { type: 'thread.started', thread_id: 't1' });
});

test('blank lines are ignored and malformed lines become error events', () => {
  assert.equal(parseJsonlLine('   '), null);
  const event = parseJsonlLine('{not-json');
  assert.equal(event.type, 'error');
  assert.match(event.error, /JSON/i);
});
