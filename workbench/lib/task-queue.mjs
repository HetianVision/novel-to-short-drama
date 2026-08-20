export class TaskQueue {
  constructor({ runTask, maxConcurrent = 1, onState = () => {} }) {
    if (typeof runTask !== 'function') throw new TypeError('runTask must be a function');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be positive');
    this.runTask = runTask;
    this.maxConcurrent = maxConcurrent;
    this.onState = onState;
    this.pending = [];
    this.entries = new Map();
    this.active = 0;
    this.draining = false;
    this.idleWaiters = [];
  }

  emit(entry, type) {
    try {
      this.onState({
        type,
        task: entry.task,
        status: entry.status,
        result: entry.result ?? null,
      });
    } catch {
      // Observers must not be able to stop the queue.
    }
  }

  enqueue(task) {
    if (!task || typeof task.id !== 'string') throw new TypeError('Queued task needs an id');
    const existing = this.entries.get(task.id);
    if (existing) return existing.promise;

    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      task,
      status: 'queued',
      result: null,
      promise,
      resolve: resolvePromise,
      controller: new AbortController(),
      cancelRequested: false,
    };
    this.entries.set(task.id, entry);
    this.pending.push(entry);
    this.emit(entry, 'task.queued');
    void this.drain();
    return promise;
  }

  get(taskId) {
    const entry = this.entries.get(taskId);
    if (!entry) return null;
    return {
      id: entry.task.id,
      task: entry.task,
      status: entry.status,
      result: entry.result,
    };
  }

  cancel(taskId) {
    const entry = this.entries.get(taskId);
    if (!entry || ['succeeded', 'failed', 'partial', 'cancelled'].includes(entry.status)) return false;
    entry.cancelRequested = true;
    if (entry.status === 'queued') {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
      entry.status = 'cancelled';
      entry.result = { status: 'cancelled', taskId };
      this.emit(entry, 'task.cancelled');
      entry.resolve(entry.result);
      this.resolveIdle();
    } else {
      entry.controller.abort();
    }
    return true;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.maxConcurrent && this.pending.length) {
        const entry = this.pending.shift();
        if (entry.cancelRequested) continue;
        this.active += 1;
        entry.status = 'running';
        this.emit(entry, 'task.started');
        void this.runEntry(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  async runEntry(entry) {
    try {
      const result = await this.runTask(entry.task, { signal: entry.controller.signal });
      entry.result = result ?? { status: 'succeeded', taskId: entry.task.id };
      entry.status = entry.cancelRequested ? 'cancelled' : (entry.result.status ?? 'succeeded');
    } catch (error) {
      entry.result = {
        status: entry.cancelRequested || error?.name === 'AbortError' ? 'cancelled' : 'failed',
        taskId: entry.task.id,
        error: error instanceof Error ? error.message : String(error),
      };
      entry.status = entry.result.status;
    } finally {
      this.active -= 1;
      this.emit(entry, `task.${entry.status}`);
      entry.resolve(entry.result);
      await this.drain();
      this.resolveIdle();
    }
  }

  whenIdle() {
    if (!this.active && !this.pending.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  resolveIdle() {
    if (this.active || this.pending.length) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
