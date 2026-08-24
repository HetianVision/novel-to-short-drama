import { STAGE_KEYS, defaultStage, parseHash, workflowHash } from './router.mjs';

const STAGES = [
  { key: 'outline', label: '生成大纲', shortLabel: '大纲', skill: 'novel-outline', note: '结构与分集', mark: '01', icon: 'document-text' },
  { key: 'characters', label: '生成角色', shortLabel: '角色', skill: 'novel-characters', note: '人物与形象', mark: '02', icon: 'folder-2' },
  { key: 'art', label: '生成美术', shortLabel: '美术', skill: 'novel-art', note: '场景与道具', mark: '03', icon: 'gallery' },
  { key: 'script', label: '生成剧本', shortLabel: '剧本', skill: 'novel-script', note: '场次与节拍', mark: '04', icon: 'document-text' },
  { key: 'storyboard', label: '生成分镜', shortLabel: '分镜', skill: 'novel-storyboard', note: '段、切与首帧', mark: '05', icon: 'gallery' },
  { key: 'video', label: '成片', shortLabel: '成片', skill: 'Seedance / MiniMax H3', note: '视频模型最终任务', mark: '06', icon: 'video-play' },
];

const IMAGE_STAGE_COPY = Object.freeze({
  characters: { label: '生成角色设定图', note: '角色页内可选出图，作为后续视频参考资产。' },
  art: { label: '生成场景/道具设定图', note: '美术页内可选出图，保持场景与道具的视觉统一。' },
  storyboard: { label: '生成分镜图', note: '分镜页内可选出图，生成首帧与子分镜参考。' },
});

const SKILL_CATALOG = [
  { key: 'novel-outline', label: '大纲', description: '从小说提炼主题、冲突、分集与叙事骨架。', output: 'outline-report.html' },
  { key: 'novel-characters', label: '角色', description: '建立人物关系、人物弧光与视觉角色设定。', output: 'report.html' },
  { key: 'novel-art', label: '美术', description: '整理场景、道具、时代与视觉统一性。', output: 'art-report.html' },
  { key: 'novel-script', label: '剧本', description: '将大纲、角色和美术资产转成可拍摄剧本。', output: 'script-report.html' },
  { key: 'novel-storyboard', label: '分镜', description: '把剧本拆成段、切、机位与首帧需求。', output: 'storyboard-report.html' },
  { key: 'shot-recipes', label: '镜头配方', description: '为视频模型整理镜头提示词与参考资产约束。', output: 'shot-recipes' },
];

const state = {
  view: 'home',
  route: { view: 'home' },
  activeStage: 'outline',
  projects: [],
  project: null,
  tasks: [],
  artifacts: [],
  filter: 'all',
  selectedTask: null,
  selectedArtifact: null,
  selectedTaskSubscription: null,
  taskEvents: new Map(),
  skillSyncReady: false,
  skillSyncToken: null,
  taskLogOpen: false,
  loadToken: 0,
};

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `请求失败（${status}）`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(response.status, typeof body === 'string' ? { error: body } : body);
  return body;
}

const WorkbenchApi = {
  listProjects: () => request('/api/projects'),
  getProject: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}`),
  createProject: (title, source) => request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, source }) }),
  listTasks: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks`),
  createTask: (projectId, type, options = {}) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, options }) }),
  cancelTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  retryTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' }),
  subscribeTask: (taskId, onEvent) => {
    const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
    source.onmessage = (event) => onEvent(JSON.parse(event.data));
    return () => source.close();
  },
  listArtifacts: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/artifacts`),
  artifactUrl: (projectId, relativePath) => `/api/projects/${encodeURIComponent(projectId)}/artifacts/${String(relativePath).split('/').map((segment) => encodeURIComponent(segment)).join('/')}`,
  createVideoJob: (projectId, provider, options = {}) => request(`/api/projects/${encodeURIComponent(projectId)}/video-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, options }) }),
  cancelVideoJob: (jobId) => request(`/api/video-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  checkSkillUpdate: () => request('/api/skills/check-update', { method: 'POST' }),
  syncSkills: (confirmToken) => request('/api/skills/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: confirmToken }) }),
};

function $(id) { return document.getElementById(id); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const ICON_NAMES = new Set([
  'folder-add', 'document-upload', 'folder-2', 'folder-open',
  'document-text', 'gallery', 'video-play', 'play-circle',
  'tick-circle', 'timer-1', 'refresh-2', 'rotate-right',
  'close-circle', 'arrow-right-2', 'search-normal-1', 'filter',
]);

function icon(name, className = 'icon icon-sm') {
  if (!ICON_NAMES.has(name)) throw new Error(`Unknown Iconsax icon: ${name}`);
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="/icons/iconsax.svg#${name}"></use></svg>`;
}

function statusIcon(status) {
  if (['succeeded', 'partial'].includes(status)) return 'tick-circle';
  if (['running', 'queued'].includes(status)) return 'timer-1';
  if (['failed', 'cancelled'].includes(status)) return 'close-circle';
  if (status === 'ready') return 'play-circle';
  return 'document-text';
}

function artifactIcon(type) {
  if (type === 'image') return 'gallery';
  if (type === 'video') return 'video-play';
  return 'document-text';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  $('toastRegion').append(toast);
  setTimeout(() => toast.remove(), 4200);
}
function setConnection(online, label = online ? '本地服务已连接' : '本地服务不可用') {
  $('connectionDot').classList.toggle('online', online);
  $('connectionLabel').textContent = label;
}
function setTopbarMode(mode) {
  const workflowTopbar = $('workflowTopbar');
  const workflowNav = $('workflowNav');
  const topbar = $('appTopbar');
  const projectLabel = $('workflowTopbarProject');
  const taskLogButton = $('taskLogToggle');
  const workflowMode = mode === 'workflow';
  if (workflowTopbar) workflowTopbar.hidden = !workflowMode;
  if (workflowNav) workflowNav.hidden = !workflowMode;
  if (topbar) topbar.classList.toggle('workflow-mode', workflowMode);
  if (projectLabel) projectLabel.textContent = workflowMode ? (state.project?.title ?? '未命名项目') : '—';
  if (taskLogButton) {
    taskLogButton.hidden = !workflowMode;
    taskLogButton.setAttribute('aria-expanded', String(workflowMode && state.taskLogOpen));
    taskLogButton.classList.toggle('active', workflowMode && state.taskLogOpen);
  }
}

function stageTask(project, stageKey) {
  return [...state.tasks].filter((task) => task.projectId === project?.id && task.type === stageKey).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}
function statusLabel(status) {
  return ({ queued: '排队中', running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[status] ?? '未开始';
}
function statusClass(status) { return status ? `status-${status}` : 'status-idle'; }

function stageDefinition(stageKey) {
  return STAGES.find((stage) => stage.key === stageKey) ?? STAGES[0];
}

function stageGate(project, stageKey) {
  return project?.readiness?.[stageKey] ?? { ok: false, missing: ['项目'], warnings: [] };
}

function stageStatus(project, stageKey) {
  const task = stageTask(project, stageKey);
  if (task?.status) return task.status;
  const stored = project?.stageState?.[stageKey]?.status;
  if (stored) return stored;
  return stageGate(project, stageKey).ok ? 'ready' : 'idle';
}

function stageStatusText(status) {
  return ({ ready: '可执行', idle: '待前置', queued: '排队中', running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[status] ?? '未开始';
}

function completedStageCount(project) {
  return STAGE_KEYS.filter((stageKey) => ['succeeded', 'partial'].includes(stageStatus(project, stageKey))).length;
}

function projectUpdatedText(project) {
  if (!project?.updatedAt) return '尚无运行记录';
  const date = new Date(project.updatedAt);
  return Number.isNaN(date.getTime()) ? '尚无运行记录' : `更新于 ${date.toLocaleDateString('zh-CN')}`;
}

function projectCard(project) {
  const count = completedStageCount(project);
  const latestStage = STAGE_KEYS.map((stageKey) => stageStatus(project, stageKey)).find((status) => ['running', 'queued', 'failed'].includes(status));
  const status = latestStage ? stageStatusText(latestStage) : `${count}/6 阶段完成`;
  return `<button class="project-card panel-block" data-project-open="${escapeHtml(project.id)}" type="button" aria-label="进入 ${escapeHtml(project.title)}">
    <div class="project-card-mark">${icon('folder-open', 'icon icon-lg')}</div>
    <div class="project-card-copy"><p class="eyebrow">SHORT-DRAMA PROJECT</p><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.sources?.length ?? 0)} 份输入资料 · ${escapeHtml(projectUpdatedText(project))}</p></div>
    <div class="project-card-progress"><strong>${escapeHtml(status)}</strong><small>Skill 流程</small></div>
    <span class="project-card-arrow" aria-hidden="true">${icon('arrow-right-2', 'icon icon-sm')}</span>
  </button>`;
}

function renderHome() {
  state.view = 'home';
  state.project = null;
  state.tasks = [];
  state.artifacts = [];
  state.selectedTask = null;
  state.selectedArtifact = null;
  setTopbarMode('home');
  const appRoot = $('appRoot');
  if (!appRoot) return;
  const hasProjects = state.projects.length > 0;
  appRoot.innerHTML = `<section class="home-page page-shell">
    <header class="home-heading">
      <div><p class="eyebrow">PROJECT DIRECTORY</p><h2>项目</h2><p>从小说和资料开始，沿原 Skill 链完成短剧前期制作。</p></div>
      ${hasProjects ? `<button class="primary-button" id="newProjectButton" type="button">${icon('folder-add', 'icon icon-sm')}<span>新建项目</span></button>` : ''}
    </header>
    <section class="project-directory panel-block" aria-label="项目列表">
      <div class="section-heading compact"><div><p class="eyebrow">YOUR PROJECTS</p><h3>${hasProjects ? '最近项目' : '还没有项目'}</h3></div><span class="material-count">${state.projects.length}</span></div>
      ${hasProjects ? `<div class="project-list">${state.projects.map(projectCard).join('')}</div>` : `<div class="empty-home"><div class="empty-home-mark">${icon('folder-add', 'icon icon-xl')}</div><p>创建第一个短剧项目，开始整理小说、角色、美术和分镜成果物。</p><button class="primary-button" id="newProjectButton" type="button">${icon('folder-add', 'icon icon-sm')}<span>新建项目</span></button></div>`}
    </section>
    <section class="skills-directory panel-block" aria-label="全部 Skill">
      <div class="section-heading compact"><div><p class="eyebrow">ALL SKILLS</p><h3>全部 Skill</h3><p class="muted">Skill 目录锁定在本地版本，更新检查与同步也在这里完成。</p></div><span class="material-count">${SKILL_CATALOG.length}</span></div>
      <div class="skill-list">${SKILL_CATALOG.map((skill) => `<article class="skill-row"><div class="skill-row-mark">${icon('folder-2', 'icon icon-sm')}</div><div class="skill-row-copy"><strong>${escapeHtml(skill.label)}</strong><small>${escapeHtml(skill.key)} · ${escapeHtml(skill.output)}</small><p>${escapeHtml(skill.description)}</p></div><span class="status-pill neutral">锁定</span></article>`).join('')}</div>
      <div class="skill-sync-panel"><div><p class="eyebrow">LOCKED SKILLS</p><strong>Skill 版本</strong><p class="muted" id="skillStatusDetail">运行时只读，更新需要明确确认。</p></div><div class="skill-sync-actions"><span class="status-pill neutral" id="skillStatus">检查中</span><button class="quiet-button" id="checkSkillsButton" type="button">${icon('refresh-2', 'icon icon-sm')}<span>检查更新</span></button><button class="quiet-button accent" id="syncSkillsButton" type="button" disabled>${icon('rotate-right', 'icon icon-sm')}<span>确认同步</span></button></div></div>
    </section>
  </section>`;
  void checkSkills();
}

function renderSources() {
  const sources = state.project?.sources ?? [];
  if (!$('sourceCount') || !$('sourceList')) return;
  $('sourceCount').textContent = sources.length;
  $('sourceList').innerHTML = sources.length
    ? sources.map((source) => `<div class="source-item"><span class="file-icon">${icon('document-text', 'icon icon-xs')}<span>${escapeHtml((source.filename ?? '').split('.').pop()?.toUpperCase() ?? 'FILE')}</span></span><span><strong>${escapeHtml(source.filename)}</strong><small>${formatBytes(source.size ?? 0)} · ${escapeHtml(source.sha256?.slice(0, 8) ?? '')}</small></span></div>`).join('')
    : '<p class="empty-inline">尚未上传资料。</p>';
}

function renderWorkflowTopbar() {
  const nav = $('workflowNav');
  if (!nav) return;
  nav.innerHTML = STAGES.map((stage, index) => {
    const status = stageStatus(state.project, stage.key);
    const active = state.activeStage === stage.key;
    const connector = index ? '<span class="stage-nav-connector" aria-hidden="true"></span>' : '';
    return `${connector}<button class="stage-nav-item ${active ? 'active' : ''} ${statusClass(status)}" data-stage-nav="${stage.key}" type="button" aria-current="${active ? 'step' : 'false'}" aria-label="${escapeHtml(stage.shortLabel)} · ${escapeHtml(stageStatusText(status))}"><span class="stage-nav-number">${stage.mark}</span><span class="stage-nav-copy"><strong>${escapeHtml(stage.shortLabel)}</strong></span></button>`;
  }).join('');
}

function renderVideoWorkspace(disabled) {
  return `<button class="primary-button" data-stage-action="video" type="button" ${disabled ? 'disabled' : ''}>${icon('video-play', 'icon icon-sm')}<span>开始执行成片</span></button>`;
}

function stageArtifacts(stageKey) {
  const task = stageTask(state.project, stageKey);
  const taskArtifactIds = new Set(task?.artifactIds ?? []);
  if (taskArtifactIds.size) {
    const taskArtifacts = state.artifacts.filter((artifact) => taskArtifactIds.has(artifact.relativePath));
    if (taskArtifacts.length) return taskArtifacts;
  }
  return state.artifacts.filter((artifact) => artifactBelongsToStage(artifact, stageKey));
}

function stageReportArtifact(stageKey) {
  return stageArtifacts(stageKey).find((artifact) => artifact.type === 'report') ?? null;
}

function imageTask(project, ownerStage) {
  return [...state.tasks]
    .filter((task) => task.projectId === project?.id && task.type === 'image' && (task.options?.ownerStage ?? task.ownerStage) === ownerStage)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}

function renderOwnerImageAction(ownerStage) {
  const copy = IMAGE_STAGE_COPY[ownerStage];
  if (!copy || !state.project) return '';
  const task = imageTask(state.project, ownerStage);
  const status = task?.status ?? 'ready';
  const running = ['queued', 'running'].includes(status);
  const label = running ? '图片任务运行中' : ['succeeded', 'partial'].includes(status) ? '重新生成图片' : copy.label;
  return `<div class="owner-image-action" data-owner-stage="${ownerStage}"><div><p class="eyebrow">OPTIONAL IMAGE ASSET</p><strong>${escapeHtml(copy.label)}</strong><small>${escapeHtml(copy.note)}</small></div><button class="quiet-button" data-image-action="${ownerStage}" type="button" ${running ? 'disabled' : ''}>${icon(running ? 'timer-1' : 'gallery', 'icon icon-sm')}<span>${escapeHtml(label)}</span></button></div>`;
}

function renderStageWorkspace() {
  const stage = stageDefinition(state.activeStage);
  const project = state.project;
  const gate = stageGate(project, stage.key);
  const task = stageTask(project, stage.key);
  const status = stageStatus(project, stage.key);
  const report = stageReportArtifact(stage.key);
  const completed = ['succeeded', 'partial'].includes(status) && Boolean(report);
  const isVideo = stage.key === 'video';
  const disabled = isVideo ? !gate.ok : !project || !gate.ok;
  const warnings = gate.warnings?.length ? `<div class="gate-warning">${icon('timer-1', 'icon icon-xs')}<span>${escapeHtml(gate.warnings.join('；'))}</span></div>` : '';
  const missing = gate.missing?.length ? `<p class="gate-note">前置条件：${escapeHtml(gate.missing.join('、'))}</p>` : '';
  const action = isVideo
    ? renderVideoWorkspace(disabled)
    : `<button class="primary-button" data-stage-action="${stage.key}" type="button" ${disabled ? 'disabled' : ''}>${icon(stage.icon === 'gallery' ? 'gallery' : 'play-circle', 'icon icon-sm')}<span>${completed ? '重新执行' : '开始执行'}${escapeHtml(stage.label.replace('生成', ''))}</span></button>`;
  const workspace = $('stageWorkspace');
  if (!workspace) return;
  const output = completed
    ? `${renderOwnerImageAction(stage.key)}<div class="report-viewer"><iframe title="${escapeHtml(report.relativePath)}" src="${WorkbenchApi.artifactUrl(project.id, report.relativePath)}"></iframe></div>`
    : `<div class="stage-start-view panel-block"><div><p class="eyebrow">RUN THIS STEP</p><h3>${task?.status === 'running' ? '正在执行当前步骤' : task?.status === 'queued' ? '任务已排队' : '准备开始当前步骤'}</h3>${missing}${warnings}</div>${action}</div>`;
  workspace.innerHTML = output;
}

function renderWorkflow() {
  if (!state.project || !$('appRoot')) return renderHome();
  state.view = 'workflow';
  setTopbarMode('workflow');
  const taskLogHidden = state.taskLogOpen ? '' : ' hidden';
  $('appRoot').innerHTML = `<section class="workflow-page page-shell">
    <div class="workflow-body ${state.taskLogOpen ? 'task-log-open' : ''}"><section class="stage-workspace artifact-canvas" id="stageWorkspace" aria-label="步骤工作区"></section><aside id="runInspector" class="activity-column run-inspector" aria-label="任务日志${taskLogHidden}"><section class="activity-header"><p class="eyebrow">RUN MONITOR</p><div class="activity-title-row"><h2>任务日志</h2><span class="live-indicator">${icon('timer-1', 'icon icon-xs')}<span>LIVE</span></span></div><p class="muted" id="taskSummary">暂无运行中的任务</p></section><section class="task-log panel-block" id="taskLog" aria-live="polite"></section><section class="run-detail panel-block" id="runDetail"><p class="eyebrow">SELECTED RUN</p><h3 id="selectedTaskTitle">尚未选择任务</h3><dl class="run-facts"><div><dt>状态</dt><dd id="selectedTaskStatus">—</dd></div><div><dt>使用 Skill</dt><dd id="selectedTaskSkill">—</dd></div><div><dt>任务编号</dt><dd id="selectedTaskId">—</dd></div></dl><div class="control-row"><button class="quiet-button" id="retryTaskButton" type="button" disabled>${icon('rotate-right', 'icon icon-sm')}<span>重新执行</span></button><button class="quiet-button danger" id="cancelTaskButton" type="button" disabled>${icon('close-circle', 'icon icon-sm')}<span>取消任务</span></button></div><div class="event-stream" id="eventStream" aria-live="polite"></div></section><div class="footer-note">本地运行 · Skill 只读 · 产物可追溯</div></aside></div>
  </section>`;
  const runInspector = $('runInspector');
  if (runInspector) {
    runInspector.hidden = !state.taskLogOpen;
    runInspector.setAttribute('aria-label', '任务日志');
  }
  renderWorkflowTopbar();
  renderStageWorkspace();
  renderTaskLog();
}

function artifactBelongsToStage(artifact, stageKey) {
  const path = String(artifact.relativePath ?? '');
  if (stageKey === 'video') return artifact.type === 'video' || path.startsWith('video/') || path === '.workbench/report.html';
  return path.startsWith(`${stageKey}/`);
}

function renderArtifactList() {
  const list = $('artifactList');
  if (!list) return;
  const stageArtifacts = state.artifacts.filter((artifact) => artifactBelongsToStage(artifact, state.activeStage));
  const filtered = state.filter === 'all' ? stageArtifacts : stageArtifacts.filter((artifact) => artifact.type === state.filter);
  if ($('artifactCount')) $('artifactCount').textContent = stageArtifacts.length;
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state compact-empty">${icon('document-text', 'icon icon-lg empty-icon')}<p>这个步骤还没有成果物。</p><small>执行当前步骤后，报告和原始文件会显示在这里。</small></div>`;
    return;
  }
  list.innerHTML = filtered.map((artifact) => `<button class="artifact-row ${state.selectedArtifact?.relativePath === artifact.relativePath ? 'selected' : ''}" data-artifact-path="${escapeHtml(artifact.relativePath)}" type="button"><span class="artifact-type ${artifact.type}">${icon(artifactIcon(artifact.type), 'icon icon-xs')}<span>${escapeHtml(artifact.type.toUpperCase().slice(0, 4))}</span></span><span class="artifact-row-copy"><strong>${escapeHtml(artifact.relativePath.split('/').pop())}</strong><small>${escapeHtml(artifact.relativePath)} · ${formatBytes(artifact.size)}</small></span><span class="row-arrow">${icon('arrow-right-2', 'icon icon-xs')}</span></button>`).join('');
}

async function openArtifact(relativePath) {
  const artifact = state.artifacts.find((item) => item.relativePath === relativePath);
  if (!artifact || !state.project) return;
  state.selectedArtifact = artifact;
  renderArtifactList();
  const url = WorkbenchApi.artifactUrl(state.project.id, artifact.relativePath);
  const preview = $('artifactPreview');
  if (artifact.type === 'report') preview.innerHTML = `<iframe title="${escapeHtml(artifact.relativePath)}" src="${url}"></iframe>`;
  else if (artifact.type === 'image') preview.innerHTML = `<div class="media-preview"><img src="${url}" alt="${escapeHtml(artifact.relativePath)}"><p>${escapeHtml(artifact.relativePath)}</p></div>`;
  else if (artifact.type === 'video') preview.innerHTML = `<div class="media-preview"><video controls src="${url}"></video><p>${escapeHtml(artifact.relativePath)}</p></div>`;
  else {
    const response = await fetch(url);
    const text = await response.text();
    let content = text;
    if (artifact.type === 'json') {
      try { content = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show original */ }
    }
    preview.innerHTML = `<div class="text-preview"><div class="preview-caption"><span>${escapeHtml(artifact.type.toUpperCase())}</span><strong>${escapeHtml(artifact.relativePath)}</strong></div><pre>${escapeHtml(content)}</pre></div>`;
  }
}

function renderTaskLog() {
  if (!$('taskLog')) return;
  const tasks = [...state.tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('taskSummary').textContent = tasks.length ? `${tasks.filter((task) => ['queued', 'running'].includes(task.status)).length} 个任务正在排队或运行` : '暂无运行中的任务';
  $('taskLog').innerHTML = tasks.length
    ? tasks.map((task) => `<button class="task-row ${state.selectedTask?.id === task.id ? 'selected' : ''}" data-task-id="${escapeHtml(task.id)}" type="button"><span class="task-dot ${statusClass(task.status)}">${icon(statusIcon(task.status), 'icon icon-sm')}</span><span class="task-copy"><strong>${escapeHtml(task.type)}</strong><small>${escapeHtml(statusLabel(task.status))} · ${escapeHtml(new Date(task.createdAt).toLocaleTimeString())}</small></span><span class="row-arrow">${icon('arrow-right-2', 'icon icon-xs')}</span></button>`).join('')
    : `<div class="empty-state log-empty">${icon('timer-1', 'icon icon-lg empty-icon')}<p>任务事件会实时显示。</p></div>`;
  if (state.selectedTask) {
    $('selectedTaskTitle').textContent = `${state.selectedTask.type} · ${statusLabel(state.selectedTask.status)}`;
    $('selectedTaskStatus').textContent = statusLabel(state.selectedTask.status);
    $('selectedTaskSkill').textContent = state.selectedTask.skillName ?? 'Provider / imagegen';
    $('selectedTaskId').textContent = state.selectedTask.id;
    $('retryTaskButton').disabled = !['failed', 'cancelled', 'partial'].includes(state.selectedTask.status);
    $('cancelTaskButton').disabled = !['queued', 'running'].includes(state.selectedTask.status);
    const events = state.taskEvents.get(state.selectedTask.id) ?? [];
    $('eventStream').innerHTML = events.length
      ? events.slice(-24).map((event) => {
        const message = event.message ?? event.result?.message ?? event.result?.error ?? event.type ?? '任务事件';
        const at = event.at ? new Date(event.at).toLocaleTimeString() : '--:--:--';
        return `<div class="event-line"><time>${escapeHtml(at)}</time><span>${escapeHtml(message)}</span></div>`;
      }).join('')
      : '<p class="empty-inline">等待任务事件。</p>';
  } else {
    $('selectedTaskTitle').textContent = '尚未选择任务';
    $('selectedTaskStatus').textContent = '—'; $('selectedTaskSkill').textContent = '—'; $('selectedTaskId').textContent = '—';
    $('retryTaskButton').disabled = true; $('cancelTaskButton').disabled = true;
    $('eventStream').innerHTML = '<p class="empty-inline">选择任务后显示逐条事件。</p>';
  }
}

function toggleTaskLog() {
  state.taskLogOpen = !state.taskLogOpen;
  const inspector = $('runInspector');
  const button = $('taskLogToggle');
  const workflowBody = document.querySelector('.workflow-body');
  if (inspector) inspector.hidden = !state.taskLogOpen;
  if (workflowBody) workflowBody.classList.toggle('task-log-open', state.taskLogOpen);
  if (button) {
    button.setAttribute('aria-expanded', String(state.taskLogOpen));
    button.classList.toggle('active', state.taskLogOpen);
  }
}

function clearTaskSelection() {
  if (state.selectedTaskSubscription) state.selectedTaskSubscription();
  state.selectedTaskSubscription = null;
  state.selectedTask = null;
  state.selectedArtifact = null;
  state.taskLogOpen = false;
}

function navigate(path) {
  const next = String(path).startsWith('#') ? String(path) : `#${path}`;
  if (window.location.hash === next) void handleRoute();
  else window.location.hash = next;
}

function renderProject(project) {
  if (project) {
    state.project = project;
    renderWorkflow();
  } else {
    renderHome();
  }
}

function renderTaskEvent(event) {
  const task = state.tasks.find((item) => item.id === event.taskId);
  if (task) task.status = event.status ?? task.status;
  if (state.selectedTask?.id === event.taskId) state.selectedTask = { ...state.selectedTask, status: event.status ?? state.selectedTask.status };
  if (state.view === 'workflow') {
    renderWorkflowTopbar();
    renderStageWorkspace();
    renderTaskLog();
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(event.status)) {
      void refreshProject().catch((error) => showToast(error.message, 'error'));
    }
  }
}

async function refreshProject() {
  if (!state.project) return;
  state.project = await WorkbenchApi.getProject(state.project.id);
  state.tasks = await WorkbenchApi.listTasks(state.project.id);
  state.artifacts = await WorkbenchApi.listArtifacts(state.project.id);
  state.activeStage = state.route.stage ?? defaultStage(state.project.stageState);
  renderWorkflow();
}

async function loadWorkflowProject(projectId, requestedStage = null) {
  const token = ++state.loadToken;
  if (state.project?.id !== projectId) clearTaskSelection();
  try {
    const project = await WorkbenchApi.getProject(projectId);
    const tasks = await WorkbenchApi.listTasks(projectId);
    const artifacts = await WorkbenchApi.listArtifacts(projectId);
    if (token !== state.loadToken) return;
    state.project = project;
    state.tasks = tasks;
    state.artifacts = artifacts;
    state.activeStage = requestedStage && STAGE_KEYS.includes(requestedStage) ? requestedStage : defaultStage(project.stageState);
    state.view = 'workflow';
    renderWorkflow();
    setConnection(true);
    await checkSkills().catch(() => {});
    if (!requestedStage && window.location.hash !== workflowHash(projectId, state.activeStage)) window.history.replaceState(null, '', workflowHash(projectId, state.activeStage));
  } catch (error) {
    if (token !== state.loadToken) return;
    showToast(error.message, 'error');
    setConnection(false, '本地服务请求失败');
    navigate('#/');
  }
}

async function handleRoute() {
  const route = parseHash(window.location.hash);
  state.route = route;
  if (route.view === 'home') {
    clearTaskSelection();
    state.view = 'home';
    renderHome();
    return;
  }
  if (state.project?.id === route.projectId) {
    state.view = 'workflow';
    state.activeStage = route.stage ?? defaultStage(state.project.stageState);
    renderWorkflow();
    return;
  }
  await loadWorkflowProject(route.projectId, route.stage);
}

async function selectProject(projectId) {
  if (!projectId) return navigate('#/');
  navigate(workflowHash(projectId));
}

async function refreshCurrent() {
  state.projects = await WorkbenchApi.listProjects();
  if (state.route.view === 'workflow' && state.project) await refreshProject();
  else renderHome();
}

async function runStage(type, options = {}) {
  if (!state.project) return showToast('请先创建项目。', 'error');
  if (type === 'image') {
    const ownerStage = options.ownerStage;
    if (!['characters', 'art', 'storyboard'].includes(ownerStage)) return showToast('图片任务需要归属角色、美术或分镜阶段。', 'error');
    options = { ownerStage };
  }
  try {
    const task = type === 'video'
      ? await WorkbenchApi.createVideoJob(state.project.id, 'minimax-h3', {})
      : await WorkbenchApi.createTask(state.project.id, type, options);
    state.tasks.unshift(task); selectTask(task.id); renderWorkflowTopbar(); renderStageWorkspace(); renderTaskLog();
    showToast(`${type === 'image' ? IMAGE_STAGE_COPY[options.ownerStage]?.label ?? '图片' : type}任务已排队。`);
  } catch (error) { showToast(error.message, 'error'); }
}

function subscribeTask(taskId) {
  if (state.selectedTaskSubscription) state.selectedTaskSubscription();
  state.selectedTaskSubscription = WorkbenchApi.subscribeTask(taskId, (event) => {
    const events = state.taskEvents.get(taskId) ?? [];
    const signature = `${event.type ?? ''}:${event.at ?? ''}:${event.status ?? ''}`;
    if (!events.some((item) => `${item.type ?? ''}:${item.at ?? ''}:${item.status ?? ''}` === signature)) {
      state.taskEvents.set(taskId, [...events, event].slice(-100));
    }
    renderTaskEvent(event);
  });
}
function selectTask(taskId) {
  state.selectedTask = state.tasks.find((task) => task.id === taskId) ?? null;
  renderTaskLog();
  if (state.selectedTask) subscribeTask(taskId);
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function setProjectDialogError(message = '') {
  const error = $('newProjectError');
  if (error) error.textContent = message;
}

function openNewProjectDialog() {
  const dialog = $('newProjectDialog');
  const form = $('newProjectForm');
  if (!dialog || !form) return;
  form.reset();
  setProjectDialogError('');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

async function createProject(title, file) {
  if (!title?.trim()) throw new Error('项目名称不能为空。');
  if (!file) throw new Error('创建项目必须上传小说或资料。');
  const project = await WorkbenchApi.createProject(title.trim(), {
    filename: file.name,
    contentBase64: await fileToBase64(file),
  });
  state.projects = await WorkbenchApi.listProjects();
  const dialog = $('newProjectDialog');
  if (dialog?.open) dialog.close();
  navigate(workflowHash(project.id));
  showToast('项目已创建。');
}

async function submitNewProject(event) {
  event.preventDefault();
  const title = $('projectTitleInput')?.value ?? '';
  const file = $('sourceFileInput')?.files?.[0] ?? null;
  const submit = $('createProjectSubmit');
  if (!title.trim()) return setProjectDialogError('请填写项目名称。');
  if (!file) return setProjectDialogError('请选择小说或资料文件。');
  setProjectDialogError('');
  if (submit) submit.disabled = true;
  try {
    await createProject(title, file);
  } catch (error) {
    setProjectDialogError(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function checkSkills() {
  if (!$('skillStatus')) return;
  try {
    const result = await WorkbenchApi.checkSkillUpdate();
    state.skillSyncToken = result.confirmationToken ?? null;
    state.skillSyncReady = Boolean(state.skillSyncToken);
    $('skillStatus').textContent = state.skillSyncReady ? '有更新' : '已同步';
    $('skillStatus').className = `status-pill ${state.skillSyncReady ? 'warning' : 'success'}`;
    $('skillStatusDetail').textContent = state.skillSyncReady ? `${result.changedFiles.length} 个文件有变化，确认后才会同步。` : '当前锁定版本与源仓库一致。';
    $('syncSkillsButton').disabled = !state.skillSyncReady;
  } catch (error) { $('skillStatus').textContent = '检查失败'; $('skillStatus').className = 'status-pill danger'; showToast(error.message, 'error'); }
}

async function syncSkills() {
  if (!state.skillSyncReady || !state.skillSyncToken) return;
  if (!window.confirm('确认从 upstream 同步 Skill，并在本地创建同步提交？')) return;
  try { const result = await WorkbenchApi.syncSkills(state.skillSyncToken); state.skillSyncReady = false; state.skillSyncToken = null; $('syncSkillsButton').disabled = true; $('skillStatus').textContent = '已同步'; $('skillStatusDetail').textContent = `${result.commit ?? '新版本'} 已提交到 ${result.branch ?? '当前分支'}。`; showToast('Skill 同步完成。'); }
  catch (error) { showToast(error.message, 'error'); }
}

async function retrySelected() { if (!state.selectedTask) return; try { const task = await WorkbenchApi.retryTask(state.selectedTask.id); state.tasks.unshift(task); selectTask(task.id); renderWorkflowTopbar(); renderStageWorkspace(); renderTaskLog(); showToast('任务已重新排队。'); } catch (error) { showToast(error.message, 'error'); } }
async function cancelSelected() { if (!state.selectedTask) return; try { await WorkbenchApi.cancelTask(state.selectedTask.id); await refreshProject(); showToast('任务已取消。'); } catch (error) { showToast(error.message, 'error'); } }

async function boot() {
  try {
    const health = await request('/api/health');
    setConnection(Boolean(health.ok), health.ok ? '本地服务已连接' : '本地服务不可用');
    state.projects = await WorkbenchApi.listProjects();
    await handleRoute();
  } catch (error) { setConnection(false, '请启动本地工作台服务'); renderHome(); showToast(error.message, 'error'); }
}

window.WorkbenchApi = WorkbenchApi;
window.WorkbenchApp = { renderProject, renderTaskEvent, renderHome, renderWorkflow, navigate, parseHash };

function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'newProjectButton') return openNewProjectDialog();
  if (button.dataset.projectOpen) return navigate(workflowHash(button.dataset.projectOpen));
  if (button.dataset.goHome !== undefined) return navigate('#/');
  if (button.dataset.stageNav) return navigate(workflowHash(state.project.id, button.dataset.stageNav));
  if (button.dataset.imageAction) return runStage('image', { ownerStage: button.dataset.imageAction });
  if (button.dataset.stageAction) return runStage(button.dataset.stageAction);
  if (button.dataset.taskLogToggle !== undefined) return toggleTaskLog();
  if (button.dataset.taskId) return selectTask(button.dataset.taskId);
  if (button.dataset.artifactPath) return openArtifact(button.dataset.artifactPath);
  if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
    return renderArtifactList();
  }
  if (button.id === 'refreshButton') return refreshCurrent().catch((error) => showToast(error.message, 'error'));
  if (button.id === 'checkSkillsButton') return checkSkills();
  if (button.id === 'syncSkillsButton') return syncSkills();
  if (button.id === 'retryTaskButton') return retrySelected();
  if (button.id === 'cancelTaskButton') return cancelSelected();
  return undefined;
}

$('appRoot').addEventListener('click', handleClick);
$('appTopbar').addEventListener('click', handleClick);
$('refreshButton').addEventListener('click', handleClick);
$('newProjectForm')?.addEventListener('submit', submitNewProject);
$('newProjectDialog')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-dialog-close]')) {
    $('newProjectDialog').close();
  }
});
window.addEventListener('hashchange', () => { void handleRoute(); });
boot();
