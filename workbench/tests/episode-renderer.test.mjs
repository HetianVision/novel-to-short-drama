import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEpisode } from '../lib/episode-renderer.mjs';
import { makeTempDir } from './helpers.mjs';

const ffmpegFixture = fileURLToPath(new URL('./fixtures/ffmpeg-fixture.mjs', import.meta.url));

test('episode renderer rejects a missing segment before invoking ffmpeg', async () => {
  const root = await makeTempDir('episode-renderer-missing-');
  let invoked = false;
  await assert.rejects(
    renderEpisode({
      segmentPaths: [join(root, 'E01-01.mp4'), join(root, 'missing.mp4')],
      outputPath: join(root, 'E01.mp4'),
      execFileImpl: () => { invoked = true; },
    }),
    /missing/i,
  );
  assert.equal(invoked, false);
});

test('episode renderer builds a concat list and invokes ffmpeg once', async () => {
  const root = await makeTempDir('episode-renderer-ok-');
  const first = join(root, 'E01-01.mp4');
  const second = join(root, 'E01-02.mp4');
  const output = join(root, 'video', 'E01.mp4');
  await writeFile(first, 'one');
  await writeFile(second, 'two');
  let invocation;
  const execFileImpl = async (bin, args) => {
    invocation = { bin, args };
    const concatPath = args[args.indexOf('-i') + 1];
    const concat = await readFile(concatPath, 'utf8');
    assert.match(concat, /file '/);
    await mkdir(join(root, 'video'), { recursive: true });
    await writeFile(output, 'assembled');
  };
  const result = await renderEpisode({ segmentPaths: [first, second], outputPath: output, ffmpegBin: 'ffmpeg-fixture', execFileImpl });
  assert.equal(result, output);
  assert.equal(invocation.bin, 'ffmpeg-fixture');
  assert.deepEqual(invocation.args.slice(0, 5), ['-y', '-f', 'concat', '-safe', '0']);
  assert.equal(await readFile(output, 'utf8'), 'assembled');
});

test('episode renderer can use the deterministic ffmpeg fixture', async () => {
  const root = await makeTempDir('episode-renderer-fixture-');
  const segment = join(root, 'E01-01.mp4');
  const output = join(root, 'E01.mp4');
  await writeFile(segment, 'one');
  await renderEpisode({ segmentPaths: [segment], outputPath: output, ffmpegBin: ffmpegFixture });
  assert.equal(await readFile(output, 'utf8'), 'fixture-ffmpeg-output');
});
