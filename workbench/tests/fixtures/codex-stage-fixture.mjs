#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const outputDir = prompt.match(/writable project output directory is exactly (.+)\./)?.[1]?.trim();
  const skillName = prompt.match(/executing the ([a-z-]+) stage/)?.[1];
  const skillRoot = prompt.match(/read-only Skill instructions at (.+)[\\/]SKILL\.md/)?.[1];
  if (!outputDir || !skillName || !skillRoot) process.exit(2);
  const kind = skillName.replace('novel-', '');
  const jsonName = kind === 'characters' ? 'cast.json' : `${kind}.json`;
  const exampleName = kind === 'characters' ? '渡口-cast.json' : `渡口-${kind}.json`;
  const source = join(skillRoot, 'examples', exampleName);
  await mkdir(outputDir, { recursive: true });
  await copyFile(source, join(outputDir, jsonName));
  await writeFile(join(outputDir, kind === 'characters' ? 'report.html' : `${kind}-report.html`), `<html><body>${skillName}</body></html>\n`, 'utf8');
  process.stderr.write(`fixture completed ${skillName}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `fixture-${kind}` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `wrote ${jsonName}` } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', status: 'completed' })}\n`);
});
