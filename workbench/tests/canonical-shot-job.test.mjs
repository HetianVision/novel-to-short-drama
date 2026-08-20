import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCanonicalShotJobs } from '../lib/canonical-shot-job.mjs';
import { makeTempDir, writeJson } from './helpers.mjs';

async function makeFixture() {
  const projectRoot = await makeTempDir('canonical-shot-job-');
  const paths = {
    projectRoot,
    storyboardPath: join(projectRoot, 'storyboard', 'storyboard.json'),
    castPath: join(projectRoot, 'characters', 'cast.json'),
    artPath: join(projectRoot, 'art', 'art.json'),
    scriptPath: join(projectRoot, 'script', 'script.json'),
  };
  await Promise.all([
    mkdir(join(projectRoot, 'storyboard', 'E01-01'), { recursive: true }),
    mkdir(join(projectRoot, 'script'), { recursive: true }),
    mkdir(join(projectRoot, 'characters', 'images'), { recursive: true }),
    mkdir(join(projectRoot, 'art', 'images'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(projectRoot, 'storyboard', 'E01-01', 'f1.png'), 'png-1'),
    writeFile(join(projectRoot, 'storyboard', 'E01-01', 'f2.png'), 'png-2'),
    writeFile(join(projectRoot, 'characters', 'images', '沈知微-sheet.png'), 'character'),
    writeFile(join(projectRoot, 'art', 'images', '渡船船舱-sheet.png'), 'scene'),
    writeFile(join(projectRoot, 'art', 'images', '旧皮箱-sheet.png'), 'prop'),
  ]);
  await writeJson(paths.storyboardPath, {
    source: '渡口',
    episodes: [{
      ep: 1,
      segments: [{
        id: 'E01-01',
        sceneIndex: 1,
        cuts: [
          { beats: [1, 1], seconds: 3, size: 'medium', camera: 'Push In', characters: ['C01'], props: ['P01'], frame: 'medium shot of a woman', recipe: 'close-reveal' },
          { beats: [2, 2], seconds: 4, size: 'wide', camera: 'Static Shot', characters: ['C01'], props: ['P01'], frame: 'wide shot of the ferry' },
        ],
        h3Prompt: 'integrated_multimodal_description: raw H3 prompt should not be copied',
      }],
    }],
  });
  await writeJson(paths.scriptPath, {
    source: '渡口',
    episodes: [{
      ep: 1,
      targetSeconds: 7,
      scenes: [{
        sceneId: 'S01',
        lighting: '浓雾清晨',
        characters: ['C01'],
        props: ['P01'],
        flow: [
          { speaker: 'C01', line: '别碰它。', delivery: '低声', beatId: 1 },
          { action: '她抱紧皮箱。', beatId: 2 },
        ],
      }],
    }],
  });
  await writeJson(paths.castPath, {
    source: '渡口',
    style: 'realistic',
    characters: [{ name: '沈知微', oneLiner: '抱着旧皮箱的年轻女人。', image: { style: '半写实' } }],
  });
  await writeJson(paths.artPath, {
    source: '渡口',
    style: 'cold gray-green cinematic',
    scenes: [{ id: 'S01', name: '渡船船舱', summary: '雾中的木船船舱', image: { sheet: 'scene sheet' } }],
    props: [{ id: 'P01', name: '旧皮箱', summary: '关键物证', image: { sheet: 'prop sheet' } }],
  });
  return paths;
}

test('canonical job resolves storyboard C/P ids to reference assets', async () => {
  const fixture = await makeFixture();
  const [job] = await buildCanonicalShotJobs(fixture);

  assert.equal(job.projectId, fixture.projectRoot.split('/').pop());
  assert.equal(job.episodeId, 'E01');
  assert.equal(job.segmentId, 'E01-01');
  assert.equal(job.durationSeconds, 7);
  assert.equal(job.cuts[1].startSeconds, 3);
  assert.equal(job.cuts[1].endSeconds, 7);
  assert.deepEqual(job.cuts[0].dialogue, [{ speaker: 'C01', line: '别碰它。', delivery: '低声' }]);
  assert.ok(job.references.some((ref) => ref.kind === 'character' && ref.assetId === 'C01' && ref.name === '沈知微'));
  assert.ok(job.references.some((ref) => ref.kind === 'scene' && ref.assetId === 'S01'));
  assert.ok(job.references.some((ref) => ref.kind === 'prop' && ref.assetId === 'P01'));
  assert.equal(job.firstFramePath, 'storyboard/E01-01/f1.png');
  assert.equal(job.references.filter((ref) => ref.kind === 'frame').length, 2);
  assert.equal(job.missingReferences.length, 0);
});

test('canonical builder preserves missing local references as diagnostics', async () => {
  const fixture = await makeFixture();
  await writeJson(fixture.storyboardPath, {
    source: '渡口',
    episodes: [{ ep: 1, segments: [{ id: 'E01-01', sceneIndex: 1, cuts: [{ beats: [1, 1], seconds: 3, characters: ['C99'], props: ['P99'], frame: 'wide shot' }] }] }],
  });
  await rm(join(fixture.projectRoot, 'storyboard', 'E01-01', 'f1.png'));
  const [job] = await buildCanonicalShotJobs(fixture);
  assert.ok(job.missingReferences.some((ref) => ref.assetId === 'C99'));
  assert.ok(job.missingReferences.some((ref) => ref.assetId === 'P99'));
  assert.ok(job.missingReferences.some((ref) => ref.kind === 'frame'));
});
