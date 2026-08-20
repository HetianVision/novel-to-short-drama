import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './helpers.mjs';
import { runCodex } from '../lib/codex-runner.mjs';

test('runner captures stderr, JSONL events, thread id, and terminal exit code', async () => {
  const dir = await makeTempDir('codex-runner-');
  const fixture = join(dir, 'codex-fixture');
  await writeFile(fixture, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.error('fixture stderr');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture final' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', status: 'completed' }) + '\\n');
});
`, 'utf8');
  await chmod(fixture, 0o755);
  const events = [];
  const stderr = [];
  const result = await runCodex({
    codexBin: fixture,
    cwd: dir,
    prompt: 'fixture prompt',
    onEvent: (event) => events.push(event),
    onStderr: (chunk) => stderr.push(chunk),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, 'fixture-thread');
  assert.equal(result.finalMessage, 'fixture final');
  assert.equal(events.length, 3);
  assert.match(stderr.join(''), /fixture stderr/);
});
