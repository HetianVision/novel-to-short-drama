import { assetUrl, validateProviderInput } from './provider-config.mjs';

function configParts(config) {
  if (!config?.promptProfile || !config?.referencePolicy || !config?.requestPolicy) {
    throw new TypeError('MiniMax compiler needs a loaded provider config');
  }
  return config;
}

function cameraLabel(camera, profile) {
  return profile.cameraMap?.[camera] ?? camera ?? '[固定]';
}

function referenceName(job, kind, assetId) {
  return job.references?.find((item) => item.kind === kind && String(item.assetId) === String(assetId))?.name ?? assetId;
}

function cutLine(cut, profile) {
  const camera = cameraLabel(cut.camera, profile);
  const visual = cut.frame || `${cut.size || 'medium'} shot`;
  const dialogue = (cut.dialogue ?? []).map((item) => `角色${item.speaker ?? 'VO'}以${item.delivery || '自然'}语气说“${item.line}”`).join('；');
  return `${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}秒 ${camera}，${visual}${dialogue ? `；${dialogue}` : ''}。`;
}

function buildPrompt(job, profile) {
  const pictureLines = (job.framePaths ?? []).map((path, index) => `Picture ${index + 1} = ${path}`).join('；');
  const lines = [
    `Picture 1 is the first frame for ${job.segmentId}.`,
    pictureLines,
    `连续生成一段${job.durationSeconds}秒的${job.style || '电影感写实'}短剧镜头，保持人物、场景、道具和光线连续。`,
    ...(job.cuts ?? []).map((cut) => cutLine(cut, profile)),
    job.sound?.soundscape ? `环境声：${job.sound.soundscape}。` : '',
    job.sound?.music && job.sound.music !== 'N/A' ? `配乐：${job.sound.music}。` : '',
    '不要添加字幕、标题、贴纸或水印；动作自然，镜头衔接连贯。',
  ].filter(Boolean);
  return lines.join('\n').replace(/integrated_multimodal_description:|overall_soundscape:|non_diegetic_music:|<\/?d>/gi, '').trim();
}

function selectDuration(requestPolicy, requested) {
  const values = [...(requestPolicy.durationValues ?? [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) throw new Error('MiniMax durationValues is empty');
  const target = Number(requested);
  if (!Number.isFinite(target) || target <= 0) return Number(requestPolicy.defaultDuration ?? values[0]);
  return values.find((value) => value >= target) ?? (() => { throw new Error(`MiniMax duration ${target}s exceeds ${values.at(-1)}s`); })();
}

function shortenPrompt(prompt, maxChars) {
  if (prompt.length <= maxChars) return prompt;
  const suffix = '\n保持以上镜头顺序和连续性。';
  return `${prompt.slice(0, Math.max(0, maxChars - suffix.length)).trim()}${suffix}`;
}

export function compileMiniMaxH3(job, config, options = {}) {
  const { promptProfile, referencePolicy, requestPolicy } = configParts(config);
  if (!job?.firstFramePath) throw new Error('MiniMax H3 compilation requires a first storyboard frame');
  const firstReference = job.references?.find((item) => item.kind === 'frame' && item.path === job.firstFramePath);
  const firstUrl = assetUrl(firstReference ?? { path: job.firstFramePath, assetId: 'first-frame' });
  const prompt = shortenPrompt(buildPrompt(job, promptProfile), Number(promptProfile.maxPromptChars ?? 2000));
  const duration = selectDuration(requestPolicy, options.duration ?? job.durationSeconds);
  const resolution = options.resolution ?? requestPolicy.defaultResolution;
  if (!requestPolicy.resolutions.includes(resolution)) throw new Error(`MiniMax resolution is unsupported: ${resolution}`);
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: firstUrl }, role: referencePolicy.firstFrameRole ?? 'first_frame' },
  ];
  const apiPayload = {
    model: options.model ?? requestPolicy.defaultModel,
    prompt,
    first_frame_image: firstUrl,
    duration,
    resolution,
    prompt_optimizer: requestPolicy.promptOptimizer === true,
  };
  if (referencePolicy.includeLastFrame && job.lastFramePath) {
    const lastReference = job.references?.find((item) => item.kind === 'frame' && item.path === job.lastFramePath);
    const lastUrl = assetUrl(lastReference ?? { path: job.lastFramePath, assetId: 'last-frame' });
    content.push({ type: 'image_url', image_url: { url: lastUrl }, role: referencePolicy.lastFrameRole ?? 'last_frame' });
    apiPayload.last_frame_image = lastUrl;
  }
  const input = {
    provider: 'minimax-h3',
    model: apiPayload.model,
    content,
    duration,
    resolution,
    imageMode: referencePolicy.mode,
    referenceAudit: (job.references ?? []).filter((item) => ['character', 'scene', 'prop'].includes(item.kind)).map((item) => ({ ...item })),
    apiPayload,
  };
  validateProviderInput('minimax-h3', input);
  return input;
}

export { validateProviderInput };
