import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../lib/task-queue.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('queue runs only one task at a time', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = new TaskQueue({ maxConcurrent: 1, runTask: async (task) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
    return { status: 'succeeded', id: task.id };
  }});
  const results = await Promise.all([queue.enqueue({ id: 'a' }), queue.enqueue({ id: 'b' })]);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((result) => result.status), ['succeeded', 'succeeded']);
});

test('queued task can be cancelled before it starts', async () => {
  let started = 0;
  const queue = new TaskQueue({ maxConcurrent: 1, runTask: async () => {
    started += 1;
    await delay(20);
    return { status: 'succeeded' };
  }});
  const first = queue.enqueue({ id: 'a' });
  const second = queue.enqueue({ id: 'b' });
  assert.equal(queue.cancel('b'), true);
  const results = await Promise.all([first, second]);
  assert.equal(started, 1);
  assert.equal(results[1].status, 'cancelled');
});

test('running task receives abort signal when cancelled', async () => {
  const queue = new TaskQueue({ runTask: async (_task, { signal }) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    resolve();
  }});
  const resultPromise = queue.enqueue({ id: 'running' });
  await delay(5);
  assert.equal(queue.cancel('running'), true);
  assert.equal((await resultPromise).status, 'cancelled');
});
