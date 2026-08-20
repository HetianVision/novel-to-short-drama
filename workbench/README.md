# 本地短剧制作工作台

这是 `novel-to-short-drama` 的运行时和查看层，不修改 `skills/` 中的原始 Skill。工作台把小说输入、原项目的五个文字阶段、归属阶段的图片任务和最终视频 Provider 任务串成一个本地可追踪流程。

## 启动

需要 Node.js 18+；Codex CLI 只在实际执行 Skill 或图片任务时需要，`ffmpeg` 只在片段合成时需要。

```bash
node workbench/cli.mjs start --port 4318
open http://127.0.0.1:4318
```

在浏览器中创建项目并上传小说或资料，然后按原流程点击：大纲、角色、美术、剧本、分镜，最后在分镜图就绪后选择 MiniMax 或 Seedance 创建视频任务。

## 默认验证

```bash
node workbench/cli.mjs test
```

默认测试不调用模型、不消耗 Provider 额度。它会运行报告自测、所有原始 Skill selftest、workbench 测试和一个 Codex/Provider 替身夹具，并比较前后 Skill 哈希。

## 视频 Provider

视频任务只读取环境变量中的密钥：

```bash
export MINIMAX_API_KEY='...'
export ARK_API_KEY='...'
```

编译器会把本地素材写成 `asset://...` 占位符。真实 Provider 需要能从公网访问的图片 URL，因此还需要配置 `VIDEO_ASSET_BASE_URL`，或在嵌入工作台时注入自定义 asset resolver；仅有 `127.0.0.1` 地址不能作为 Provider 的图片输入。

工作台中的 `minimax-h3` 是兼容原始 H3 投产包的工作流名称，当前默认 API 模型映射为 `MiniMax-Hailuo-2.3`。MiniMax 返回 `file_id` 时，工作台会继续调用文件检索接口并下载 MP4；Seedance 使用异步任务状态和 `content.video_url`。

真实 API 冒烟会产生费用：

```bash
VIDEO_SMOKE_FIRST_FRAME_URL='https://your-public-host/frame.png' \
  node workbench/cli.mjs live-smoke --provider minimax-h3
```

## Skill 锁与同步

运行时会验证 `skills.lock.json` 的版本和 SHA-256；Codex 任务拿到的是只读快照。`检查 Skill 更新` 只读取 upstream，`确认同步` 才会切同步分支、更新 Skill、跑全部 selftest、写锁并提交。默认不自动推送，确认提交后可以按返回的分支执行 `git push --set-upstream origin <branch>`。

```bash
node workbench/cli.mjs skills-lock
```

该命令只在当前 `skills/` 已经与锁和 `upstream/main` 一致时重建锁，不能替代确认式同步。

## 项目目录

```text
projects/<project-id>/
├── source/       # 小说、资料、参考图
├── outline/      # outline.json + report
├── characters/   # cast.json + 角色图
├── art/          # art.json + 场景/道具图
├── script/       # script.json + report
├── storyboard/   # storyboard.json + manifest + 分镜图
├── video/        # 下载的 MP4 片段
└── .workbench/   # 任务、事件、运行快照和聚合报告
```

项目运行产物默认被 `.gitignore` 排除；源码 Skill、锁文件、Provider 配置和工作台代码仍然纳入 Git。

## 真实 Codex 图片冒烟

默认基准只验证图片任务的确定性编排，不伪造模型图片成功。需要显式执行：

```bash
node workbench/cli.mjs live-smoke --codex
```

如果本地 Codex 没有可用的 `$imagegen` 能力，该命令会失败并保留诊断，不能把夹具通过当成真实图片能力已验证。
