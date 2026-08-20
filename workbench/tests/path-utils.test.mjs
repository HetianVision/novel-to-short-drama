import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeFileName, assertSafeId, resolveInside } from '../lib/path-utils.mjs';

test('accepts slug ids and rejects traversal or malformed ids', () => {
  assert.equal(assertSafeId('demo-project'), 'demo-project');
  assert.equal(assertSafeId('project-01'), 'project-01');
  assert.throws(() => assertSafeId(''), /safe id/i);
  assert.throws(() => assertSafeId('../escape'), /safe id/i);
  assert.throws(() => assertSafeId('/tmp/project'), /safe id/i);
  assert.throws(() => assertSafeId('Demo-project'), /safe id/i);
  assert.throws(() => assertSafeId('a--b'), /safe id/i);
});

test('resolveInside refuses paths outside the root', () => {
  assert.equal(resolveInside('/tmp/projects', 'demo', 'source'), '/tmp/projects/demo/source');
  assert.throws(() => resolveInside('/tmp/projects', '..', 'outside'), /path/i);
  assert.throws(() => resolveInside('/tmp/projects', '/etc/passwd'), /path/i);
});

test('source filenames cannot contain path separators', () => {
  assert.equal(assertSafeFileName('小说正文.txt'), '小说正文.txt');
  assert.throws(() => assertSafeFileName('../outside.txt'), /path/i);
  assert.throws(() => assertSafeFileName('nested/file.txt'), /path/i);
  assert.throws(() => assertSafeFileName('..'), /path/i);
});
