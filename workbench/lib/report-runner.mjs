import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function renderAggregateReport({ repoRoot, projectRoot, outputPath }) {
  await mkdir(dirname(outputPath), { recursive: true });
  await execFileAsync(
    process.execPath,
    [join(repoRoot, 'scripts', 'report.mjs'), '--from', projectRoot, '--out', outputPath],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  return outputPath;
}
