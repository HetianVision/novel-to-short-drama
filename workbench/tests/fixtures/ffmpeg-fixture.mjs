#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const output = process.argv.at(-1);
if (!output || output.startsWith('-')) process.exit(2);
await writeFile(output, 'fixture-ffmpeg-output');
