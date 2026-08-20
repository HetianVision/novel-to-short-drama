import { assetUrl, validateProviderInput } from './provider-config.mjs';

function configParts(config) {
  if (!config?.promptProfile || !config?.referencePolicy || !config?.requestPolicy) {
    throw new TypeError('Seedance compiler needs a loaded provider config');
  }
  return config;
}

function cameraLabel(camera, profile) {
  return profile.cameraMap?.[camera] ?? camera ?? '固定机位';
}

function cutLine(cut, profile) {
  const dialogue = (cut.dialogue ?? []).map((item) => `角色${item.speaker ?? 'VO'}说：“${item.line}”`).join('；');
  return `${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}秒：${cameraLabel(cut.camera, profile)}；${cut.frame || `${cut.size || 'medium'} shot`}${dialogue ? `；${dialogue}` : ''}。`;
}

function buildPrompt(job, profile) {
  return [
    `为${job.durationSeconds}秒、${job.ratio || '16:9'}画幅生成一段连续的电影感短剧视频。`,
    `整体风格：${job.style || '写实电影感'}。保持首帧中的人物身份、服装、道具、场景和光线一致。`,
    ...(job.cuts ?? []).map((cut) => cutLine(cut, profile)),
    job.sound?.soundscape ? `声音：${job.sound.soundscape}。` : '',
    job.sound?.music && job.sound.music !== 'N/A' ? `音乐：${job.sound.music}。` : '',
    '镜头之间要有明确但自然的动作连续性；不生成字幕、标题、贴纸或水印。',
  ].filter(Boolean).join('\n').replace(/integrated_multimodal_description:|overall_soundscape:|non_diegetic_music:|<\/?d>/gi, '').trim();
}

function validDuration(requestPolicy, value) {
  const duration = Number(value);
  if (!Number.isInteger(duration)) throw new Error(`Seedance duration must be an integer, got ${value}`);
  if (duration < Number(requestPolicy.durationMin) || duration > Number(requestPolicy.durationMax)) {
    throw new Error(`Seedance duration must be between ${requestPolicy.durationMin}s and ${requestPolicy.durationMax}s`);
  }
  return duration;
}

function orderedReferences(job, policy) {
  const accepted = new Set(policy.acceptedKinds ?? []);
  const priority = policy.priority ?? [...accepted];
  const rank = new Map(priority.map((kind, index) => [kind, index]));
  return (job.references ?? [])
    .filter((item) => item.exists !== false && accepted.has(item.kind))
    .sort((a, b) => (rank.get(a.kind) ?? 999) - (rank.get(b.kind) ?? 999))
    .slice(0, Number(policy.maxImages ?? 4));
}

export function compileSeedance(job, config, options = {}) {
  const { promptProfile, referencePolicy, requestPolicy } = configParts(config);
  const duration = validDuration(requestPolicy, options.duration ?? job.durationSeconds);
  const ratio = options.ratio ?? job.ratio ?? requestPolicy.defaultRatio;
  if (!requestPolicy.ratios.includes(ratio)) throw new Error(`Seedance ratio is unsupported: ${ratio}`);
  const resolution = options.resolution ?? requestPolicy.defaultResolution;
  if (!requestPolicy.resolutions.includes(resolution)) throw new Error(`Seedance resolution is unsupported: ${resolution}`);
  const prompt = buildPrompt({ ...job, durationSeconds: duration, ratio }, promptProfile);
  const references = orderedReferences(job, referencePolicy);
  const content = [
    { type: 'text', text: prompt },
    ...references.map((reference) => ({
      type: 'image_url',
      image_url: { url: assetUrl(reference) },
      role: referencePolicy.imageRole ?? 'reference_image',
      assetId: reference.assetId,
    })),
  ];
  const apiPayload = {
    model: options.model ?? requestPolicy.defaultModel,
    content: content.map(({ assetId, ...item }) => item),
    duration,
    ratio,
    resolution,
    watermark: requestPolicy.watermark === true,
  };
  const input = {
    provider: 'seedance',
    model: apiPayload.model,
    content,
    duration,
    ratio,
    resolution,
    imageMode: referencePolicy.mode,
    references: references.map((reference) => ({ ...reference })),
    apiPayload,
  };
  validateProviderInput('seedance', input);
  return input;
}

export { validateProviderInput };
