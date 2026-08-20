import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.mjs';
import { createTaskStore } from '../lib/task-store.mjs';

test('task records and event logs survive a store reload', async () => {
  const projectRoot = await makeTempDir('task-store-');
  const store = createTaskStore(projectRoot);
  await store.create({
    id: 'task-a', projectId: 'demo-project', type: 'outline', status: 'queued', options: {},
  });
  await store.appendEvent('task-a', { type: 'task.started' });
  await store.update('task-a', { status: 'succeeded', artifactIds: ['outline.json'] });

  const reloaded = createTaskStore(projectRoot);
  assert.equal((await reloaded.read('task-a')).status, 'succeeded');
  assert.deepEqual(await reloaded.readEvents('task-a'), [{ type: 'task.started' }]);
  assert.deepEqual((await reloaded.list()).map((task) => task.id), ['task-a']);
});

test('subscribers receive appended events after the durable write', async () => {
  const projectRoot = await makeTempDir('task-store-');
  const store = createTaskStore(projectRoot);
  await store.create({ id: 'task-a', projectId: 'demo-project', type: 'outline' });
  const events = [];
  const unsubscribe = store.subscribe('task-a', (event) => events.push(event));
  await store.appendEvent('task-a', { type: 'task.completed', status: 'succeeded' });
  unsubscribe();
  assert.deepEqual(events, [{ type: 'task.completed', status: 'succeeded' }]);
});
