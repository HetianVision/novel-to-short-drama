#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  try {
    const outputMatch = prompt.match(/writable project output directory is exactly (.+)\./);
    const skillMatch = prompt.match(/executing the ([a-z-]+) stage/);
    const rootMatch = prompt.match(/read-only Skill instructions at (.+)[\\/]SKILL\.md/);
    if (!outputMatch || !skillMatch || !rootMatch) process.exit(2);
    const outputDir = outputMatch[1].trim();
    const skillName = skillMatch[1];
    const skillRoot = rootMatch[1];
    const kind = skillName.replace('novel-', '');
    const jsonName = kind === 'characters' ? 'cast.json' : `${kind}.json`;
    const exampleName = kind === 'characters' ? '渡口-cast.json' : `渡口-${kind}.json`;
    await mkdir(outputDir, { recursive: true });
    await copyFile(join(skillRoot, 'examples', exampleName), join(outputDir, jsonName));
    await writeFile(join(outputDir, kind === 'characters' ? 'report.html' : `${kind}-report.html`), `<html><body>${skillName}</body></html>\n`, 'utf8');
    process.stderr.write(`fixture completed ${skillName}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `fixture-${kind}` })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `wrote ${jsonName}` } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', status: 'completed' })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
});
