import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const defaultExec = promisify(execFile);

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function concatLine(path) {
  return `file '${path.replaceAll("'", "'\\''")}'`;
}

async function invoke(execFileImpl, bin, args, options) {
  if (execFileImpl === execFile) return defaultExec(bin, args, options);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error, result = {}) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolvePromise(result);
    };
    const callback = (error, stdout, stderr) => finish(error, { stdout, stderr });
    try {
      const result = execFileImpl(bin, args, options, callback);
      if (result && typeof result.then === 'function') result.then((value) => finish(null, value ?? {}), finish);
      else if (execFileImpl.length < 4 && result !== undefined) finish(null, result);
    } catch (error) {
      finish(error);
    }
  });
}

export async function renderEpisode({ segmentPaths = [], outputPath, ffmpegBin = 'ffmpeg', execFileImpl = execFile } = {}) {
  if (!outputPath) throw new TypeError('outputPath is required');
  if (!Array.isArray(segmentPaths) || !segmentPaths.length) throw new Error('At least one segment is required');
  const resolvedSegments = segmentPaths.map((path) => resolve(path));
  const missing = [];
  for (const path of resolvedSegments) if (!(await isFile(path))) missing.push(path);
  if (missing.length) throw new Error(`Missing video segment(s): ${missing.join(', ')}`);

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  const concatPath = `${destination}.${process.pid}.${randomUUID()}.concat.txt`;
  await writeFile(concatPath, `${resolvedSegments.map(concatLine).join('\n')}\n`, 'utf8', { flag: 'wx' });
  try {
    await invoke(execFileImpl, ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', destination], { cwd: dirname(destination) });
    if (!(await isFile(destination))) throw new Error(`ffmpeg completed without creating ${destination}`);
    return destination;
  } catch (error) {
    const detail = [error?.stderr, error?.stdout].filter(Boolean).join('\n').slice(0, 4000);
    throw new Error(`Episode render failed: ${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ''}`);
  } finally {
    await rm(concatPath, { force: true });
  }
}
