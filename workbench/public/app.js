const STAGES = [
  { key: 'outline', label: '生成大纲', skill: 'novel-outline', note: '结构与分集', mark: '01' },
  { key: 'characters', label: '生成角色', skill: 'novel-characters', note: '人物与形象', mark: '02' },
  { key: 'art', label: '生成美术', skill: 'novel-art', note: '场景与道具', mark: '03' },
  { key: 'script', label: '生成剧本', skill: 'novel-script', note: '场次与节拍', mark: '04' },
  { key: 'storyboard', label: '生成分镜', skill: 'novel-storyboard', note: '段、切与首帧', mark: '05' },
  { key: 'image', label: '生成图片', skill: 'Codex imagegen', note: '归属阶段的参考资产', mark: '06' },
];

const state = {
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

function stageTask(project, stageKey) {
  return [...state.tasks].filter((task) => task.projectId === project?.id && task.type === stageKey).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}
function statusLabel(status) {
  return ({ queued: '排队中', running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[status] ?? '未开始';
}
function statusClass(status) { return status ? `status-${status}` : 'status-idle'; }

function renderProjects() {
  const select = $('projectSelect');
  select.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}</option>`).join('')
    : '<option value="">还没有项目</option>';
  if (state.project) select.value = state.project.id;
  $('projectHint').textContent = state.project ? `${state.project.title} · ${state.project.sources?.length ?? 0} 份输入资料` : '先创建一个项目，再上传小说或资料。';
}

function renderSources() {
  const sources = state.project?.sources ?? [];
  $('sourceCount').textContent = sources.length;
  $('sourceList').innerHTML = sources.length
    ? sources.map((source) => `<div class="source-item"><span class="file-icon">${escapeHtml((source.filename ?? '').split('.').pop()?.toUpperCase() ?? 'FILE')}</span><span><strong>${escapeHtml(source.filename)}</strong><small>${formatBytes(source.size ?? 0)} · ${escapeHtml(source.sha256?.slice(0, 8) ?? '')}</small></span></div>`).join('')
    : '<p class="empty-inline">尚未上传资料。</p>';
}

function renderStages() {
  const project = state.project;
  $('workflowStages').innerHTML = STAGES.map((stage, index) => {
    const gate = project?.readiness?.[stage.key] ?? { ok: false, missing: ['项目'] };
    const task = stageTask(project, stage.key);
    const status = task?.status ?? (gate.ok && stage.key !== 'image' ? 'ready' : 'idle');
    const disabled = !project || (stage.key !== 'image' && !gate.ok);
    const missing = gate.missing?.length ? `<small class="gate-note">待 ${escapeHtml(gate.missing.join('、'))}</small>` : '';
    const button = `<button class="stage-action ${stage.key === 'image' ? 'image-action' : ''}" data-stage-action="${stage.key}" type="button" ${disabled ? 'disabled' : ''}>${escapeHtml(stage.label)}</button>`;
    return `<article class="stage-card ${statusClass(status)} ${index === 0 ? 'first-stage' : ''}">
      <div class="stage-marker">${stage.mark}</div>
      <div class="stage-copy"><div class="stage-title-row"><strong>${escapeHtml(stage.label)}</strong><span class="stage-status">${escapeHtml(status === 'ready' ? '可执行' : statusLabel(status))}</span></div><small>${escapeHtml(stage.skill)} · ${escapeHtml(stage.note)}</small>${missing}</div>
      ${button}
    </article>`;
  }).join('');
  document.querySelectorAll('[data-stage-action]').forEach((button) => button.addEventListener('click', () => runStage(button.dataset.stageAction)));
}

function renderStats() {
  const counts = state.artifacts.reduce((map, artifact) => { map[artifact.type] = (map[artifact.type] ?? 0) + 1; return map; }, {});
  $('workspaceStats').innerHTML = `<div><strong>${state.artifacts.length}</strong><span>成果物</span></div><div><strong>${state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length}</strong><span>运行任务</span></div><div><strong>${state.project ? '已锁定' : '—'}</strong><span>Skill 锁</span></div>`;
  $('artifactCount').textContent = state.artifacts.length;
  $('workspaceSubtitle').textContent = state.project ? `${state.project.title} · ${counts.report ?? 0} 份报告 · ${counts.image ?? 0} 张图片 · 所有运行都在本机记录。` : '从左侧创建项目并上传资料，工作台会沿原流程逐步解锁。';
}

function renderArtifactList() {
  const filtered = state.filter === 'all' ? state.artifacts : state.artifacts.filter((artifact) => artifact.type === state.filter);
  if (!filtered.length) {
    $('artifactList').innerHTML = '<div class="empty-state compact-empty"><span class="empty-glyph">◇</span><p>这个筛选条件下还没有成果物。</p></div>';
    return;
  }
  $('artifactList').innerHTML = filtered.map((artifact) => `<button class="artifact-row ${state.selectedArtifact?.relativePath === artifact.relativePath ? 'selected' : ''}" data-artifact-path="${escapeHtml(artifact.relativePath)}" type="button"><span class="artifact-type ${artifact.type}">${escapeHtml(artifact.type.toUpperCase().slice(0, 4))}</span><span class="artifact-row-copy"><strong>${escapeHtml(artifact.relativePath.split('/').pop())}</strong><small>${escapeHtml(artifact.relativePath)} · ${formatBytes(artifact.size)}</small></span><span class="row-arrow">↗</span></button>`).join('');
  document.querySelectorAll('[data-artifact-path]').forEach((button) => button.addEventListener('click', () => openArtifact(button.dataset.artifactPath)));
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
  const tasks = [...state.tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('taskSummary').textContent = tasks.length ? `${tasks.filter((task) => ['queued', 'running'].includes(task.status)).length} 个任务正在排队或运行` : '暂无运行中的任务';
  $('taskLog').innerHTML = tasks.length ? tasks.map((task) => `<button class="task-row ${state.selectedTask?.id === task.id ? 'selected' : ''}" data-task-id="${escapeHtml(task.id)}" type="button"><span class="task-dot ${statusClass(task.status)}"></span><span class="task-copy"><strong>${escapeHtml(task.type)}</strong><small>${escapeHtml(statusLabel(task.status))} · ${escapeHtml(new Date(task.createdAt).toLocaleTimeString())}</small></span><span class="row-arrow">›</span></button>`).join('') : '<div class="empty-state log-empty"><span class="empty-glyph">∿</span><p>任务事件会实时显示。</p></div>';
  document.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => selectTask(button.dataset.taskId)));
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

function renderProject(project) {
  state.project = project;
  $('workspaceTitle').textContent = project?.title ?? '等待选择项目';
  renderProjects(); renderSources(); renderStages(); renderStats(); renderArtifactList(); renderTaskLog();
}

function renderTaskEvent(event) {
  const task = state.tasks.find((item) => item.id === event.taskId);
  if (task) task.status = event.status ?? task.status;
  if (state.selectedTask?.id === event.taskId) state.selectedTask = { ...state.selectedTask, status: event.status ?? state.selectedTask.status };
  renderStages(); renderStats(); renderTaskLog();
}

async function refreshProject() {
  if (!state.project) return;
  state.project = await WorkbenchApi.getProject(state.project.id);
  state.tasks = await WorkbenchApi.listTasks(state.project.id);
  state.artifacts = await WorkbenchApi.listArtifacts(state.project.id);
  renderProject(state.project);
}

async function selectProject(projectId) {
  if (!projectId) { renderProject(null); return; }
  try {
    state.project = await WorkbenchApi.getProject(projectId);
    state.tasks = await WorkbenchApi.listTasks(projectId);
    state.artifacts = await WorkbenchApi.listArtifacts(projectId);
    renderProject(state.project);
    setConnection(true);
  } catch (error) { showToast(error.message, 'error'); setConnection(false, '本地服务请求失败'); }
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
    state.tasks.unshift(task); selectTask(task.id); subscribeTask(task.id); renderStages(); renderTaskLog();
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
    await selectProject(project.id);
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
  try {
    const result = await WorkbenchApi.checkSkillUpdate();
    state.skillSyncReady = Boolean(result.changedFiles?.length);
    $('skillStatus').textContent = state.skillSyncReady ? '有更新' : '已同步';
    $('skillStatus').className = `status-pill ${state.skillSyncReady ? 'warning' : 'success'}`;
    $('skillStatusDetail').textContent = state.skillSyncReady ? `${result.changedFiles.length} 个文件有变化，确认后才会同步。` : '当前锁定版本与源仓库一致。';
    $('syncSkillsButton').disabled = !state.skillSyncReady;
  } catch (error) { $('skillStatus').textContent = '检查失败'; $('skillStatus').className = 'status-pill danger'; showToast(error.message, 'error'); }
}

async function syncSkills() {
  if (!state.skillSyncReady) return;
  if (!window.confirm('确认从 upstream 同步 Skill，并提交到自己的 origin？')) return;
  try { const result = await WorkbenchApi.syncSkills('confirmed-by-user'); state.skillSyncReady = false; $('syncSkillsButton').disabled = true; $('skillStatus').textContent = '已同步'; $('skillStatusDetail').textContent = `${result.commit ?? '新版本'} 已提交。`; showToast('Skill 同步完成。'); }
  catch (error) { showToast(error.message, 'error'); }
}

async function retrySelected() { if (!state.selectedTask) return; try { const task = await WorkbenchApi.retryTask(state.selectedTask.id); state.tasks.unshift(task); selectTask(task.id); showToast('任务已重新排队。'); } catch (error) { showToast(error.message, 'error'); } }
async function cancelSelected() { if (!state.selectedTask) return; try { await WorkbenchApi.cancelTask(state.selectedTask.id); await refreshProject(); showToast('任务已取消。'); } catch (error) { showToast(error.message, 'error'); } }

async function boot() {
  try {
    const health = await request('/api/health');
    setConnection(Boolean(health.ok), health.ok ? '本地服务已连接' : '本地服务不可用');
    state.projects = await WorkbenchApi.listProjects();
    renderProjects();
    if (state.projects.length) await selectProject(state.projects[0].id); else renderProject(null);
    await checkSkills().catch(() => {});
  } catch (error) { setConnection(false, '请启动本地工作台服务'); renderProject(null); showToast(error.message, 'error'); }
}

window.WorkbenchApi = WorkbenchApi;
window.WorkbenchApp = { renderProject, renderTaskEvent };

$('newProjectButton').addEventListener('click', createProject);
$('refreshButton').addEventListener('click', () => refreshProject().catch((error) => showToast(error.message, 'error')));
$('projectSelect').addEventListener('change', (event) => selectProject(event.target.value));
$('sourceInput').addEventListener('change', (event) => uploadFiles([...event.target.files]));
$('checkSkillsButton').addEventListener('click', checkSkills);
$('syncSkillsButton').addEventListener('click', syncSkills);
$('retryTaskButton').addEventListener('click', retrySelected);
$('cancelTaskButton').addEventListener('click', cancelSelected);
$('videoJobButton').addEventListener('click', async () => {
  if (!state.project) return;
  try { await WorkbenchApi.createVideoJob(state.project.id, $('providerSelect').value, {}); showToast('视频任务已创建。'); await refreshProject(); }
  catch (error) { showToast(error.message, 'error'); }
});
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
  renderArtifactList();
}));
boot();
