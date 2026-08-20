import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { eventFinalMessage, eventThreadId, parseJsonlLine } from './codex-events.mjs';

export function runCodex({
  codexBin = 'codex',
  cwd,
  prompt,
  signal,
  onEvent = () => {},
  onStderr = () => {},
}) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, '-'];
    const child = spawn(codexBin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let threadId = null;
    let finalMessage = null;
    let spawnError = null;
    let aborted = Boolean(signal?.aborted);
    const callbackPromises = [];

    const abort = () => {
      aborted = true;
      if (!child.killed) child.kill('SIGTERM');
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });

    child.on('error', (error) => { spawnError = error; });
    child.stderr.on('data', (chunk) => onStderr(String(chunk)));
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      const event = parseJsonlLine(line);
      if (!event) return;
      threadId ||= eventThreadId(event);
      finalMessage = eventFinalMessage(event) ?? finalMessage;
      try {
        const result = onEvent(event);
        if (result && typeof result.then === 'function') callbackPromises.push(result);
      } catch (error) {
        callbackPromises.push(Promise.reject(error));
      }
    });

    child.on('close', async (code, closeSignal) => {
      reader.close();
      if (signal) signal.removeEventListener('abort', abort);
      await Promise.allSettled(callbackPromises);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        exitCode: code ?? (aborted ? 143 : 1),
        signal: closeSignal,
        threadId,
        finalMessage,
      });
    });

    if (aborted) abort();
    else {
      child.stdin.write(String(prompt ?? ''), 'utf8');
      child.stdin.end();
    }
  });
}
