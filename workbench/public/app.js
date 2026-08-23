import { STAGE_KEYS, defaultStage, parseHash, workflowHash } from './router.mjs';

const STAGES = [
  { key: 'outline', label: '生成大纲', shortLabel: '大纲', skill: 'novel-outline', note: '结构与分集', mark: '01', icon: 'document-text' },
  { key: 'characters', label: '生成角色', shortLabel: '角色', skill: 'novel-characters', note: '人物与形象', mark: '02', icon: 'folder-2' },
  { key: 'art', label: '生成美术', shortLabel: '美术', skill: 'novel-art', note: '场景与道具', mark: '03', icon: 'gallery' },
  { key: 'script', label: '生成剧本', shortLabel: '剧本', skill: 'novel-script', note: '场次与节拍', mark: '04', icon: 'document-text' },
  { key: 'storyboard', label: '生成分镜', shortLabel: '分镜', skill: 'novel-storyboard', note: '段、切与首帧', mark: '05', icon: 'gallery' },
  { key: 'image', label: '生成图片', shortLabel: '图片', skill: 'Codex imagegen', note: '归属阶段的参考资产', mark: '06', icon: 'gallery' },
  { key: 'video', label: '成片', shortLabel: '成片', skill: 'Seedance / MiniMax H3', note: '视频模型最终任务', mark: '07', icon: 'video-play' },
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
  createProject: (title) => request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
  uploadSource: (projectId, file) => request(`/api/projects/${encodeURIComponent(projectId)}/sources?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }),
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
  artifactUrl: (projectId, relativePath) => `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(relativePath)}`,
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
  const topbar = $('appTopbar');
  const projectLabel = $('workflowTopbarProject');
  const workflowMode = mode === 'workflow';
  if (workflowTopbar) workflowTopbar.hidden = !workflowMode;
  if (topbar) topbar.classList.toggle('workflow-mode', workflowMode);
  if (projectLabel) projectLabel.textContent = workflowMode ? (state.project?.title ?? '未命名项目') : '—';
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
  if (stageKey === 'image') return project ? { ok: true, missing: [], warnings: [] } : { ok: false, missing: ['项目'], warnings: [] };
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
  const status = latestStage ? stageStatusText(latestStage) : `${count}/7 阶段完成`;
  return `<article class="project-card panel-block" data-project-card="${escapeHtml(project.id)}">
    <div class="project-card-mark">${icon('folder-open', 'icon icon-lg')}</div>
    <div class="project-card-copy"><p class="eyebrow">SHORT-DRAMA PROJECT</p><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.sources?.length ?? 0)} 份输入资料 · ${escapeHtml(projectUpdatedText(project))}</p></div>
    <div class="project-card-progress"><strong>${escapeHtml(status)}</strong><small>Skill 流程</small></div>
    <button class="row-arrow project-open" data-project-open="${escapeHtml(project.id)}" type="button" aria-label="进入 ${escapeHtml(project.title)}">${icon('arrow-right-2', 'icon icon-sm')}</button>
  </article>`;
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
    <section class="home-utilities" aria-label="工作台技能设置"><div class="utility-panel panel-block home-skill-panel"><div class="section-heading compact"><div><p class="eyebrow">LOCKED SKILLS</p><h3>Skill 版本</h3></div><span class="status-pill neutral" id="skillStatus">检查中</span></div><p class="muted" id="skillStatusDetail">运行时只读，更新需要明确确认。</p><div class="control-row"><button class="quiet-button" id="checkSkillsButton" type="button"><svg class="icon icon-sm" aria-hidden="true" focusable="false"><use href="/icons/iconsax.svg#refresh-2"></use></svg><span>检查更新</span></button><button class="quiet-button accent" id="syncSkillsButton" type="button" disabled><svg class="icon icon-sm" aria-hidden="true" focusable="false"><use href="/icons/iconsax.svg#rotate-right"></use></svg><span>确认同步</span></button></div></div></section>
    <section class="project-directory panel-block" aria-label="项目列表">
      <div class="section-heading compact"><div><p class="eyebrow">YOUR PROJECTS</p><h3>${hasProjects ? '最近项目' : '还没有项目'}</h3></div><span class="material-count">${state.projects.length}</span></div>
      ${hasProjects ? `<div class="project-list">${state.projects.map(projectCard).join('')}</div>` : `<div class="empty-home"><div class="empty-home-mark">${icon('folder-add', 'icon icon-xl')}</div><p>创建第一个短剧项目，开始整理小说、角色、美术和分镜成果物。</p><button class="primary-button" id="newProjectButton" type="button">${icon('folder-add', 'icon icon-sm')}<span>新建项目</span></button></div>`}
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
  nav.innerHTML = STAGES.map((stage) => {
    const status = stageStatus(state.project, stage.key);
    const active = state.activeStage === stage.key;
    return `<button class="stage-nav-item ${active ? 'active' : ''} ${statusClass(status)}" data-stage-nav="${stage.key}" type="button" aria-current="${active ? 'step' : 'false'}"><span class="stage-nav-number">${stage.mark}</span><span class="stage-nav-copy"><strong>${escapeHtml(stage.shortLabel)}</strong><small>${icon(statusIcon(status), 'icon icon-xs')}${escapeHtml(stageStatusText(status))}</small></span></button>`;
  }).join('');
}

function renderVideoWorkspace(disabled) {
  return `<div class="video-action-row"><select id="providerSelect" class="provider-select" aria-label="视频模型"><option value="minimax-h3">MiniMax H3</option><option value="seedance">Seedance</option></select><button class="primary-button" id="videoJobButton" type="button" ${disabled ? 'disabled' : ''}>${icon('video-play', 'icon icon-sm')}<span>创建视频任务</span></button></div>`;
}

function renderStageWorkspace() {
  const stage = stageDefinition(state.activeStage);
  const project = state.project;
  const gate = stageGate(project, stage.key);
  const task = stageTask(project, stage.key);
  const status = stageStatus(project, stage.key);
  const completed = ['succeeded', 'partial'].includes(status);
  const isVideo = stage.key === 'video';
  const disabled = isVideo ? !gate.ok : !project || (stage.key !== 'image' && !gate.ok);
  const warnings = gate.warnings?.length ? `<div class="gate-warning">${icon('timer-1', 'icon icon-xs')}<span>${escapeHtml(gate.warnings.join('；'))}</span></div>` : '';
  const missing = gate.missing?.length ? `<p class="gate-note">前置条件：${escapeHtml(gate.missing.join('、'))}</p>` : '';
  const action = isVideo
    ? renderVideoWorkspace(disabled)
    : `<button class="primary-button" data-stage-action="${stage.key}" type="button" ${disabled ? 'disabled' : ''}>${icon(stage.icon === 'gallery' ? 'gallery' : 'play-circle', 'icon icon-sm')}<span>${completed ? '重新执行' : '执行'}${escapeHtml(stage.label.replace('生成', ''))}</span></button>`;
  const taskInfo = task ? `<span class="stage-run-state ${statusClass(task.status)}">${icon(statusIcon(task.status), 'icon icon-xs')} ${escapeHtml(statusLabel(task.status))}</span>` : `<span class="stage-run-state ${statusClass(status)}">${icon(statusIcon(status), 'icon icon-xs')} ${escapeHtml(stageStatusText(status))}</span>`;
  const workspace = $('stageWorkspace');
  if (!workspace) return;
  workspace.innerHTML = `<div class="stage-workspace-header"><div><p class="eyebrow">CURRENT STAGE · ${escapeHtml(stage.mark)}</p><h2>${escapeHtml(stage.label)}</h2><p class="workspace-subtitle">${escapeHtml(stage.skill)} · ${escapeHtml(stage.note)}</p></div><div class="stage-workspace-status">${taskInfo}</div></div>
    <div class="stage-action-panel panel-block"><div><p class="eyebrow">RUN THIS STEP</p><h3>${completed ? '已有成果，可重新生成' : '准备执行当前步骤'}</h3>${missing}${warnings}</div>${action}</div>
    <div class="stage-output-heading"><div><p class="eyebrow">STAGE OUTPUTS</p><h3>本步骤成果物</h3></div><span class="material-count" id="artifactCount">0</span></div>
    <div class="artifact-toolbar section-rule"><div class="toolbar-tabs" role="tablist" aria-label="成果物类型"><button class="toolbar-tab active" data-filter="all" type="button">全部</button><button class="toolbar-tab" data-filter="report" type="button">报告</button><button class="toolbar-tab" data-filter="json" type="button">JSON</button><button class="toolbar-tab" data-filter="markdown" type="button">Markdown</button><button class="toolbar-tab" data-filter="image" type="button">图片</button><button class="toolbar-tab" data-filter="video" type="button">视频</button></div></div>
    <div class="artifact-layout" data-artifact-stage="${stage.key}"><div class="artifact-catalog panel-block"><div class="artifact-list" id="artifactList"></div></div><div class="artifact-preview panel-block" id="artifactPreview"><div class="empty-state preview-empty">${icon('gallery', 'icon icon-xl empty-icon')}<p>选择一个成果物查看。</p><small>报告、JSON、Markdown、图片和视频都会保留在项目目录中。</small></div></div></div>`;
  renderArtifactList();
}

function renderWorkflow() {
  if (!state.project || !$('appRoot')) return renderHome();
  state.view = 'workflow';
  setTopbarMode('workflow');
  $('appRoot').innerHTML = `<section class="workflow-page page-shell">
    <header class="workflow-context"><button class="back-button" data-go-home type="button">${icon('arrow-right-2', 'icon icon-sm')}<span>项目首页</span></button><div class="workflow-title"><p class="eyebrow">PROJECT WORKFLOW</p><h2>${escapeHtml(state.project.title)}</h2><p>按原 Skill 链推进制作，点击顶部步骤只切换工作区，执行按钮才会创建任务。</p></div><div class="workflow-metrics"><strong>${state.artifacts.length}</strong><span>成果物</span><strong>${state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length}</strong><span>运行中</span></div></header>
    <section class="workflow-utilities"><div class="utility-panel panel-block"><div><p class="eyebrow">SOURCE MATERIAL</p><h3>输入资料 <span class="material-count" id="sourceCount">0</span></h3></div><label class="upload-zone compact-upload" for="sourceInput">${icon('document-upload', 'icon icon-md upload-icon')}<span><strong>上传小说或资料</strong><small>TXT、Markdown、JSON、参考图</small></span><input id="sourceInput" type="file" multiple></label><div class="source-list" id="sourceList"></div></div></section>
    <div class="workflow-body"><section class="stage-workspace artifact-canvas" id="stageWorkspace" aria-label="步骤工作区"></section><aside class="activity-column run-inspector" aria-label="任务日志"><section class="activity-header"><p class="eyebrow">RUN MONITOR</p><div class="activity-title-row"><h2>任务日志</h2><span class="live-indicator">${icon('timer-1', 'icon icon-xs')}<span>LIVE</span></span></div><p class="muted" id="taskSummary">暂无运行中的任务</p></section><section class="task-log panel-block" id="taskLog" aria-live="polite"></section><section class="run-detail panel-block" id="runDetail"><p class="eyebrow">SELECTED RUN</p><h3 id="selectedTaskTitle">尚未选择任务</h3><dl class="run-facts"><div><dt>状态</dt><dd id="selectedTaskStatus">—</dd></div><div><dt>使用 Skill</dt><dd id="selectedTaskSkill">—</dd></div><div><dt>任务编号</dt><dd id="selectedTaskId">—</dd></div></dl><div class="control-row"><button class="quiet-button" id="retryTaskButton" type="button" disabled>${icon('rotate-right', 'icon icon-sm')}<span>重新执行</span></button><button class="quiet-button danger" id="cancelTaskButton" type="button" disabled>${icon('close-circle', 'icon icon-sm')}<span>取消任务</span></button></div><div class="event-stream" id="eventStream" aria-live="polite"></div></section><div class="footer-note">本地运行 · Skill 只读 · 产物可追溯</div></aside></div>
  </section>`;
  renderWorkflowTopbar();
  renderSources();
  renderStageWorkspace();
  renderTaskLog();
}

function artifactBelongsToStage(artifact, stageKey) {
  const path = String(artifact.relativePath ?? '');
  if (stageKey === 'image') return artifact.type === 'image' && ['characters/', 'art/', 'storyboard/'].some((prefix) => path.startsWith(prefix));
  if (stageKey === 'video') return artifact.type === 'video' || path.startsWith('video/');
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

function clearTaskSelection() {
  if (state.selectedTaskSubscription) state.selectedTaskSubscription();
  state.selectedTaskSubscription = null;
  state.selectedTask = null;
  state.selectedArtifact = null;
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

async function runStage(type) {
  if (!state.project) return showToast('请先创建项目。', 'error');
  let options = {};
  if (type === 'image') {
    const ownerStage = window.prompt('图片归属阶段：characters、art 或 storyboard', 'art');
    if (!['characters', 'art', 'storyboard'].includes(ownerStage)) return showToast('图片任务需要归属角色、美术或分镜阶段。', 'error');
    options = { ownerStage };
  }
  try {
    const task = await WorkbenchApi.createTask(state.project.id, type, options);
    state.tasks.unshift(task); selectTask(task.id); renderWorkflowTopbar(); renderStageWorkspace(); renderTaskLog();
    showToast(`${type}任务已排队。`);
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

async function createProject() {
  const title = window.prompt('给这个短剧项目取一个名字：', '渡口');
  if (!title?.trim()) return;
  try {
    const project = await WorkbenchApi.createProject(title.trim());
    state.projects = await WorkbenchApi.listProjects();
    navigate(workflowHash(project.id));
    showToast('项目已创建。');
  } catch (error) { showToast(error.message, 'error'); }
}

async function uploadFiles(files) {
  if (!state.project) return showToast('请先创建项目，再上传资料。', 'error');
  for (const file of files) {
    try { await WorkbenchApi.uploadSource(state.project.id, file); showToast(`${file.name} 已上传。`); } catch (error) { showToast(`${file.name}：${error.message}`, 'error'); }
  }
  await refreshProject();
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
  if (button.id === 'newProjectButton') return createProject();
  if (button.dataset.projectOpen) return navigate(workflowHash(button.dataset.projectOpen));
  if (button.dataset.goHome !== undefined) return navigate('#/');
  if (button.dataset.stageNav) return navigate(workflowHash(state.project.id, button.dataset.stageNav));
  if (button.dataset.stageAction) return runStage(button.dataset.stageAction);
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
  if (button.id === 'videoJobButton') {
    if (!state.project) return;
    return WorkbenchApi.createVideoJob(state.project.id, $('providerSelect').value, {})
      .then(() => { showToast('视频任务已创建。'); return refreshProject(); })
      .catch((error) => showToast(error.message, 'error'));
  }
  return undefined;
}

function handleChange(event) {
  if (event.target.id === 'sourceInput') {
    void uploadFiles([...event.target.files]);
    event.target.value = '';
  }
}

$('appRoot').addEventListener('click', handleClick);
$('appRoot').addEventListener('change', handleChange);
$('appTopbar').addEventListener('click', handleClick);
$('refreshButton').addEventListener('click', handleClick);
window.addEventListener('hashchange', () => { void handleRoute(); });
boot();
