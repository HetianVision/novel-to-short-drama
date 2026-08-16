# PR：novel-characters 同剧角色画风一致性校验

## 背景 / 问题

使用 `novel-characters` 生成《渡口》角色设定集时，发现**四个角色的"画风"标签各不相同**：

| 角色 | 原 `image.style` |
|------|----------|
| 沈知微 | 半写实厚涂插画，藏青低饱和配色，柔和方向光 |
| 陆行远 | 半写实厚涂插画，冷灰配色，硬质侧光 |
| 老周 | 半写实厚涂插画，大地色系低饱和配色，强调风化质感 |
| 胡二爷 | 半写实厚涂插画，赭红暖色配色，明亮均匀光线 |

基底词都是"半写实厚涂插画"，但**配色 / 光线 / 质感**按各自戏服、年龄被写成了四套。出图后同框时（分镜、海报、同船过河）会像四个不同画师画的，破坏"同一部片"的观感。

### 根因

- `image.style` 是 `schema.md` 定义的"给人读的画风一句话"字段，**没有任何枚举、格式约束**，也没有"同剧必须一致"的校验。
- `profile-pass.md` 规定了 `image.prompt` / `sheet` 的 render 句式、`negativePrompt` 不能禁 photorealistic、必须写族裔/年代/地域，但**唯独没要求 `image.style` 在角色间保持一致**。
- `validateCast` 已有的检查项（结构、`importance` 枚举、引文逐字、出图提示词人名、语言分工、风格与预设匹配）**全部是单角色维度**，没有跨角色维度；其中"风格与提示词必须匹配"只校验单个角色的 `style` 字段是否和顶层预设一致，仍管不到剧内统一。
- 于是模型在 Step 6 第二趟出卡时，按每个角色自身情况自由发挥写 `image.style`，三道关卡（文档意图 / 字段约束 / validate）全放过了。

### 这是 bug 吗

是**设计上的质量门缺口**，不是代码逻辑错误：

- 脚本按设计执行，没有跑错；
- skill 文档意图是"全剧统一一种画风"（`style-presets.md` 默认 `realistic`，整套共用），四套画风是生成时偏离了意图；
- 属于"该有确定性检查兜底、却漏了"的一类——对比它已经做的（人名禁入、引文逐字、语言分工都是硬校验），`style-presets.md` 第 34 行还专门强调"风格与反向提示词搞反了 `validate` 会直接报错"，说明作者有"用校验兜底风格"的意识，只是**漏了"角色间风格一致"这一条**。

## 解决方案

### 1. 给 `validateCast` 增加跨角色画风一致性检查（`scripts/novel-characters.mjs`）

在遍历每个角色**之前**，先收集所有角色的 `image.style`，归一化（复用已有的 `normalise`，去掉空白差异）后比较：

- 只有一种归一化值 → 通过；
- 多于一种 → 报一条错，并点名哪几个角色用了不同画风，例如：
  `同剧角色画风不一致（image.style 必须统一）：沈知微、老周、胡二爷  vs  陆行远`；
- 单角色或未写 `image.style` 的角色不触发；
- 仅空白差异（如首尾多空格）不算不一致。

该检查是**确定性**的，不调模型，与现有检查风格一致，且**不影响其他题材**——它只是防止"同一份 cast 内角色画风自己打架"，不管你选 `realistic` 还是 `ghibli`，也不限制你给不同短剧换不同风格。

### 2. 自测覆盖（`scripts/selftest.mjs`）

新增三条断言（沿用现有 `clone()` 辅助）：

- 统一后的自带样例 `validateCast` 通过；
- 故意把其中一个角色的 `image.style` 改成别的值 → 必须报"画风不一致"；
- 只对某个角色 `image.style` 加首尾空格 → 不误报。

### 3. 修复自带样例数据（`examples/渡口-cast.json`）

把四个角色的画风对齐到**剧级统一美术基线**（民国清晨浓雾渡口，冷调低饱和）：

- `image.style` 统一为：`半写实厚涂插画，冷调低饱和民国配色，晨雾柔光`；
- EN `prompt` / `sheet` 结尾调色板词统一为：`muted ink-blue and cold grey palette, 1930s Republican-era China, soft misty morning light, readable silhouette from every angle.`；
- `image.tags` 里的配色项统一为剧级标签。

> 注：本次同时发现 `selftest.mjs` 第 61 行（`块内容来自原文`）及另一处 chunkText 相关断言在 **Node v22 / Windows 环境下预先失败**，与本次改动无关（已 `git stash` 验证原始仓库同样失败）。本 PR 不处理该问题，避免范围蔓延；如需要可另开 issue。

## 影响范围

- **不影响已有功能**：`validateCast` 仅在多个角色 `image.style` 归一化后不一致时多报一条，否则返回数组与改动前完全相同；`render` / `assemble` / `buildGraph` 等路径不受影响。
- **不影响其他题材**：只约束"同一份 cast 内角色画风一致"，不限制你给科幻、古装等别的短剧换 `realistic` / `ghibli` 或自定义调性。
- **向后兼容**：旧 cast 若画风本就不一致，会在 `validate` 时明确报错并点名，而不是静默出图。

## 测试

```bash
cd skills/novel-characters
node scripts/selftest.mjs
# 预期：除预先存在的 chunkText 环境相关失败外，画风相关断言（及全部原本通过的断言）均通过

# 单独验证本 PR 逻辑
node -e "import('./scripts/novel-characters.mjs').then(m=>{const fs=require('fs');const c=JSON.parse(fs.readFileSync('examples/渡口-cast.json','utf8')).characters;console.log('统一后样例问题数:', m.validateCast(c, fs.readFileSync('examples/渡口.txt','utf8')).length);})"
```

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `skills/novel-characters/scripts/novel-characters.mjs` | `validateCast` 新增跨角色画风一致性检查 |
| `skills/novel-characters/scripts/selftest.mjs` | 新增 3 条画风一致性断言 |
| `skills/novel-characters/examples/渡口-cast.json` | 四个角色画风对齐到剧级统一基线（数据修复，使自带样例通过新校验） |
