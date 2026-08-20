# 本地短剧制作工作台设计规格

日期：2026-08-20

状态：待用户评审

适用仓库：`HetianVision/novel-to-short-drama`

## 1. 目标

在不修改、重写或侵入现有 Skill 的前提下，为 `novel-to-short-drama` 增加一个本地浏览器工作台，完成以下闭环：

1. 上传小说和补充资料，创建短剧项目；
2. 按原项目定义的依赖关系，通过浏览器按钮启动 Codex CLI 执行 Skill；
3. 记录每次任务的状态、日志、输入、Skill 版本和成果物；
4. 在同一工作台查看 JSON、Markdown、报告 HTML、图片和视频；
5. 将分镜投产包编译成 MiniMax H3 或 Seedance 各自独立的输入任务；
6. 提交视频生成任务、轮询结果，并按集归档视频片段；
7. 在 Skill 更新前检查源仓库，确认后同步到用户自己的仓库；
8. 提供不消耗模型额度的基准测试和可选的真实 Codex/API 冒烟测试。

工作台是运行时和展示层，不是第七个 Skill。现有 `skills/` 目录、Skill 的 JSON 契约、质量门和报告渲染逻辑保持原样。

## 2. 原项目工作流作为唯一流程基线

工作台不重新发明生产顺序，严格反映原项目的管线：

```text
小说与资料
      |
      v
novel-outline -> outline.json
      |
      +------------------+------------------+
      v                  v                  v
novel-characters    novel-art          novel-script
cast.json           art.json           script.json
角色设定集           美术设定集           剧本
      +------------------+------------------+
                         v
                 novel-storyboard
                 storyboard.json
                 manifest.json
                 H3/分镜投产包
                         v
             视频模型 Provider 适配层
                         v
                 视频片段与成片
```

需要保持的具体边界：

- `novel-outline` 负责改编结构、分集和资产清单；
- `novel-characters` 负责角色设定，角色设定图是该阶段的可选出图动作；
- `novel-art` 负责场景、道具和视觉设定，场景图、道具图是该阶段的可选出图动作；
- `novel-script` 负责场次、节拍、台词和时长，不负责分镜或图片；
- `novel-storyboard` 消费剧本与上游资产，负责分段、镜头、关键帧提示词、H3 提示词和分镜投产包；分镜关键帧是该阶段的可选出图动作；
- 视频生成是原项目明确留给外部生产管线的下一层，工作台在分镜投产包之后增加它，不回写原 Skill。

角色、美术和剧本在大纲之后是可并行/迭代的分支，不强制伪造一条线性顺序。工作台按钮可以单独触发它们，但只有满足原 Skill 的输入条件时才启用。

## 3. 第一版范围

### 3.1 浏览器工作台

本地服务绑定 `127.0.0.1`，通过浏览器打开。第一版提供：

- 项目列表和项目详情；
- 小说、资料和参考图片上传；
- 原项目工作流图与每个节点的状态；
- 任务按钮：生成大纲、生成角色、生成美术、生成剧本、生成分镜、生成图片；
- 任务实时日志、取消、重新执行和失败原因；
- 成果物列表、JSON 查看、Markdown 查看、报告 HTML 预览、图片预览、视频播放；
- Skill 版本锁定状态和源仓库更新检查；
- Seedance / MiniMax H3 Provider 选择和视频任务状态。

### 3.2 任务类型

每个按钮对应一个可追踪的任务类型：

| 任务类型 | 主要输入 | 主要输出 | 执行方式 |
| --- | --- | --- | --- |
| `outline` | 小说与资料 | `outline.json`、Markdown、报告 | Codex CLI + `novel-outline` |
| `characters` | `outline.json`、小说与资料 | `cast.json`、角色图、报告 | Codex CLI + `novel-characters` |
| `art` | `outline.json`、`cast.json`、小说与资料 | `art.json`、场景/道具图、报告 | Codex CLI + `novel-art` |
| `script` | `outline.json`、可选 `cast/art` | `script.json`、Markdown、报告 | Codex CLI + `novel-script` |
| `storyboard` | `script.json`、可选 `outline/cast/art` | `storyboard.json`、报告、H3 投产包 | Codex CLI + `novel-storyboard` |
| `image` | 指定 Skill JSON 与图片提示词 | PNG/JPEG 资产 | Codex CLI 图像生成动作 |
| `video` | 分镜段、参考资产、Provider 配置 | MP4、任务记录、Provider 输入快照 | Provider API |
| `episode-render` | 一个集的 MP4 片段 | 合集视频 | 本地 `ffmpeg`，可选 |

“生成图片”是执行入口，不是新的 Skill 阶段。它必须要求用户选择归属阶段和目标资产，结果写入角色、美术或分镜目录。

### 3.3 明确不做

- 不在工作台代码中复制 `SKILL.md` 的内容或重写质量门；
- 不允许 Codex 任务改写 `skills/`；
- 不做多用户登录、远程部署和云端项目协作；
- 不做完整时间线剪辑器、字幕编辑器和专业音频混音器；
- 不把 H3 提示词原样发送给 Seedance；
- 不在没有真实 Provider 凭证时伪造视频成功状态。

## 4. 系统架构

### 4.1 技术选择

第一版使用 Node.js 标准库和浏览器原生模块，不引入必须安装的运行时依赖：

- Node.js >= 18；
- `node:http`：本地 HTTP 服务与静态资源服务；
- `node:child_process`：安全启动 `codex exec` 与 `ffmpeg`；
- `node:fs/promises`：项目、任务和成果物持久化；
- Server-Sent Events：向浏览器推送任务事件；
- 原生 HTML/CSS/ES modules：工作台界面。

这样与现有 Skill 的零依赖和 Node 标准库风格保持一致，用户不需要先安装前端构建工具即可启动工作台。

### 4.2 模块边界

```text
workbench/
├── server.mjs             # 本地 HTTP 入口
├── lib/
│   ├── project-store.mjs  # 项目、任务、成果物存储
│   ├── task-queue.mjs     # 串行队列、取消、重试
│   ├── codex-runner.mjs   # codex exec 启动与 JSONL 解析
│   ├── skill-lock.mjs     # 哈希锁与只读快照
│   ├── artifact-index.mjs # 成果物发现与安全路径解析
│   ├── report-runner.mjs  # 调用现有 report.mjs
│   ├── providers/
│   │   ├── minimax-h3.mjs
│   │   └── seedance.mjs
│   └── episode-renderer.mjs
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── modules/
└── tests/
```

工作台产物与仓库源码分离，根目录边界固定为：

```text
skills/                 # 受控同步、运行时只读
skills.lock.json        # Skill 版本与哈希锁
projects/               # 小说、项目和工作流产物
workbench/              # Web UI、后端、任务日志
providers/              # Seedance / MiniMax H3 适配配置
```

项目产物放在 `projects/` 下，与工作台代码、模型配置和 Skill 源码隔离：

```text
projects/
└── <project-id>/
    ├── source/             # 小说、资料、原始参考图
    ├── outline/            # 原 Skill 约定的输出目录
    ├── characters/
    ├── art/
    ├── script/
    ├── storyboard/
    ├── video/
    └── .workbench/
        ├── project.json
        ├── tasks.jsonl
        ├── events/
        ├── artifacts.json
        └── runs/
```

`projects/` 下的运行产物、`.workbench/`、任务日志和生成媒体默认加入 `.gitignore`，不污染用户自己的代码仓库。

## 5. Codex CLI 执行层

### 5.1 启动方式

每个 Skill 任务由本地后端通过参数数组启动，不经过 shell 字符串拼接：

```text
codex exec --json --sandbox workspace-write -C <run-directory> -
```

任务提示词通过 stdin 传入，避免小说正文、用户资料和路径进入 shell 参数。Codex 官方非交互模式支持 JSONL 事件流，事件包含线程、回合、命令执行、文件变更和最终状态，适合工作台实时记录。[官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)

### 5.2 任务提示词契约

后端为每种任务生成固定提示词，内容包括：

- 目标项目绝对路径；
- 当前任务类型和上游输入路径；
- 本次 Skill 快照中的 `SKILL.md` 路径；
- 允许写入的输出目录；
- 必须执行的 `seed`、`validate`、`render` 或 `export` 命令；
- 不能改写 Skill、不能修改其他项目文件的约束；
- 最终必须以结构化摘要说明任务结果和文件路径。

Codex 运行目录只包含当前项目产物和本次 Skill 的只读快照。源仓库的 `skills/` 不作为 Codex 的可写工作区。

### 5.3 事件与状态

任务状态：

```text
queued → running → succeeded
                 ├→ partial
                 ├→ failed
                 └→ cancelled
```

事件保存为 JSONL，至少记录：

- `task.started`；
- `codex.thread.started`；
- `codex.item.started/completed`；
- 标准错误输出；
- 发现的文件变更；
- 校验和报告结果；
- `task.completed` 或 `task.failed`。

任务成功不能只由 Codex 的退出码决定，还必须检查预期 JSON 是否存在、JSON 是否能被对应 Skill 的 `validate` 接受，以及报告是否能重新生成。

### 5.4 出图能力

角色、美术和分镜的出图任务沿用原 Skill 中的 Codex 图像生成动作。工作台需要把“图片未生成”和“任务失败”区分开：

- 生成提示词成功但本地没有图像工具：状态为 `partial`，报告显示缺图；
- 单张图片失败：其他图片继续，最终列出失败清单；
- 任务进程崩溃或输出 JSON 无效：状态为 `failed`。

第一轮实现必须做一次真实 Codex CLI 图像能力冒烟测试；在测试完成前，不能把图片路径缺失当成成功。

## 6. Skill 锁定与源仓库同步

### 6.1 锁文件

仓库根目录新增 `skills.lock.json`，记录：

```json
{
  "source": "https://github.com/eternityspring/shuohao-skills.git",
  "sourceBranch": "main",
  "sourceCommit": "<commit-sha>",
  "syncedAt": "<iso-time>",
  "skills": {
    "novel-outline": { "version": "<version>", "sha256": "<hash>" }
  }
}
```

### 6.2 运行时保护

- API 层拒绝所有指向 `skills/` 的写操作；
- Codex 任务只拿到只读 Skill 快照；
- 任务启动前记录 Skill 快照哈希，完成后再次核验；
- 检测到 Skill 内容变化时，任务标记为 `failed`，不自动覆盖或恢复用户文件；
- 所有成果物写入 `projects/<project-id>/`。

### 6.3 同步流程

```text
检查 upstream/main
  ↓
展示源提交、版本和变更文件
  ↓
用户点击确认同步
  ↓
创建 sync 分支
  ↓
同步源 Skill
  ↓
运行所有 selftest
  ↓
更新 skills.lock.json
  ↓
提交并推送到 origin（用户自己的仓库）
```

工作台不会后台静默替换 Skill。同步失败时保留当前锁定版本。

## 7. 成果物与报告查看层

项目详情页采用三栏结构：

```text
左栏：工作流与状态
中栏：报告、JSON、Markdown、图片、视频
右栏：当前任务日志与执行摘要
```

每个阶段卡片显示：

- 当前状态；
- 最近任务时间；
- 使用的 Skill commit；
- 上游依赖是否满足；
- JSON、Markdown、报告和媒体数量；
- 校验门通过/失败数量；
- “重新执行”“查看日志”“打开成果物”按钮。

报告 HTML 通过本地安全静态路由在 iframe 中打开，保持原 `report.mjs` 的相对图片和导出能力。JSON 和 Markdown 以只读查看器显示，图片和视频使用浏览器原生预览。

## 8. 本地 API

第一版 API：

```text
GET    /api/health
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
POST   /api/projects/:id/sources
GET    /api/projects/:id/tasks
POST   /api/projects/:id/tasks
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry
GET    /api/tasks/:id/events       # SSE
GET    /api/projects/:id/artifacts
GET    /api/projects/:id/artifacts/*path
GET    /api/skills/status
POST   /api/skills/check-update
POST   /api/skills/sync
GET    /api/providers
POST   /api/projects/:id/video-jobs
POST   /api/video-jobs/:id/cancel
```

所有路径参数必须经过目录边界校验，禁止 `..`、绝对路径和符号链接逃逸。服务只监听 `127.0.0.1`。

## 9. 视频 Provider 适配层

Skill 产物先编译成模型无关的 `canonical-shot-job.json`，再由 Provider 适配器生成独立输入：

```text
storyboard.json + manifest.json + cast/art/script 资产
                         ↓
              canonical-shot-job.json
                    ↙              ↘
        minimax-h3-input.json   seedance-input.json
```

每个 Provider 独立配置：

```text
providers/
├── minimax-h3/
│   ├── prompt-profile.json
│   ├── reference-policy.json
│   └── request-policy.json
└── seedance/
    ├── prompt-profile.json
    ├── reference-policy.json
    └── request-policy.json
```

必须独立处理：

- 提示词语言与结构；
- 首帧、尾帧和参考图的选择；
- 角色、场景、道具和分镜图的引用优先级；
- 时长、比例、分辨率和音频设置；
- API 提交、轮询、失败重试和结果下载；
- 输入快照和任务 ID 归档。

每个视频段保存：

```text
video/E01-01/
├── canonical-shot-job.json
├── minimax-h3-input.json
├── seedance-input.json
├── task.json
└── E01-01.mp4
```

没有 Provider 密钥或本地素材运输配置时，工作台可以生成并预览 Provider 输入 JSON，但不能报告为“视频生成成功”。

## 10. 错误处理

- 缺少小说：大纲按钮禁用；
- 缺少 `outline.json`：角色和美术的标准 seed 流程禁用；
- 缺少剧本：分镜按钮禁用；
- 上游 JSON 存在但校验失败：显示失败门，禁止继续投产；
- Codex 不存在或未认证：任务在启动前失败并给出诊断；
- Codex 退出码非零：保存 stdout/stderr 和最后事件；
- 产物缺失：任务为 `failed`；
- 部分图片缺失：任务为 `partial`，继续展示其余资产；
- Provider 返回失败：保留请求快照和错误，不删除已有视频；
- 任务取消：向子进程发送 `SIGTERM`，超时后强制结束并记录；
- 任何 Skill 文件变化：任务失败并提示重新同步/恢复锁定版本。

## 11. 基准测试与验收门

### 11.1 不消耗额度的基准测试

```text
node scripts/report-selftest.mjs
for f in skills/*/scripts/selftest.mjs; do node "$f"; done
node workbench/tests/run.mjs
```

工作台测试覆盖：

- 项目创建、文件上传和哈希记录；
- 路径穿越防护；
- Skill 锁文件生成和校验；
- Skill 写入拦截；
- 原项目依赖门控；
- 任务队列状态转换、取消和重试；
- Codex JSONL 事件解析；
- 成果物发现和报告路由；
- Provider prompt/reference 编译；
- Provider API mock 轮询和失败分支；
- `ffmpeg` 不存在时的明确降级。

### 11.2 端到端夹具

使用仓库内《渡口》样例和一个最小小说文本，通过假的 Codex Runner 产生确定性产物，验证：

1. 创建项目；
2. 上传小说；
3. 依次执行大纲、角色、美术、剧本、分镜任务；
4. 发现 JSON、Markdown、报告和图片；
5. 生成两套 Provider 输入快照；
6. 模拟视频任务成功、失败和取消；
7. 核验 `skills/` 哈希未变化；
8. 生成最终基准报告。

### 11.3 可选真实冒烟测试

真实 Codex 和视频 API 测试显式使用命令行开关，不进入默认测试：

```text
node workbench/tests/live-smoke.mjs --codex
node workbench/tests/live-smoke.mjs --provider minimax-h3
node workbench/tests/live-smoke.mjs --provider seedance
```

真实测试可能消耗模型额度、API 费用和并发额度；默认基准测试不触发它们。

### 11.4 完成标准

本规格完成的最低判定条件：

- 本地一条命令可以启动 Web UI；
- 浏览器可以创建项目、上传小说并启动任务；
- Codex CLI 任务日志可以实时显示；
- 任务成功后可以打开原始报告和 JSON；
- Skill 文件在整个任务过程中保持锁定；
- 源仓库更新可以在确认后同步到用户自己的仓库；
- 原有全部 selftest 通过；
- 工作台基准测试通过；
- Provider mock 测试覆盖两家模型的独立提示词和参考素材映射；
- 没有凭证时，系统明确显示未配置，而不是显示成功。

## 12. 实施顺序

1. 工作台目录、状态模型、项目和成果物存储；
2. 本地 HTTP API、静态 UI 和 SSE 日志；
3. Codex CLI Runner 与 Skill 只读快照；
4. 六个工作流按钮及原项目依赖门控；
5. 报告、JSON、Markdown、图片和视频查看器；
6. Skill 锁文件、更新检查和受控同步；
7. canonical shot job 与 MiniMax H3 / Seedance 适配器；
8. `ffmpeg` 集合输出；
9. 基准测试、真实 Codex 图像冒烟测试和交付验证。
