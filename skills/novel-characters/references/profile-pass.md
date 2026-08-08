# 第二趟 · 生成角色卡

你是在为一部动画改编准备制作素材。给你一个角色的名字、归并后的全部观察记录、以及可引用的原文片段，产出一张完整的角色卡。

**只输出 JSON，不要任何解释、不要 markdown 围栏。** 结构见 `schema.md`。

## 语言

调用方会给一个**报告语言** `lang`（默认 `zh`）。字段分两类：

| 类别 | 字段 | 语言 |
| --- | --- | --- |
| **给人读的** | `oneLiner`、`persona.*`、`voice.timbre/pitch/pace/accent/emotion/referenceHint`、`image.style`、`image.promptLocal`、`voice.promptLocal` | **`lang` 指定的语言** |
| **喂给机器的** | `image.prompt`、`image.negativePrompt`、`image.tags`、`image.sheet`、`voice.prompt` | **永远英文** |

机器字段不跟随 `lang`——图像模型和 TTS 引擎吃英文最稳，跟报告用什么语言无关。

`promptLocal` 是对应英文提示词的本地语言译文，给人看的。**`lang` 是 `en` 时省略这两个字段**，否则就是原样重复。

## 硬规则

1. **一切基于观察记录。** 为了让设定可用而不得不补全的部分，要跟原文保持一致，并且**标注出来**——中文报告加「（推断）」，英文报告加 `(inferred)`，其他语言用该语言的等价说法。**只用一种标记，不要中英都加。**

2. **`persona.evidence` 只能放「可引用原文」区块里的字符串，逐字照抄。** 不许翻译、不许裁剪、不许把两条合并、不许从观察记录里另找。那个区块是空的就返回空数组。**注意：引文永远保持原文语言，不跟随 `lang`**——它是证据，翻译了就不是证据了。

3. **`image.prompt` / `image.promptLocal` / `image.sheet` 里绝对不许出现角色名、别名、作者名、作品名。** 图像模型对这些偏见极重，会画成它记忆里的角色而不是你的角色。描述这个人，不要叫他的名字。

4. `image.prompt` 是**单张卡通角色设定图**：纯背景、全身或半身、剪影可辨、表情有戏。写明画风、线条质感、配色、光照、构图、表情。

5. **`image.sheet` 是角色设定图——一张横构图，内部左右分两栏。** 这是给出图模型的完整版面指令，比例要写死，不能让它自由发挥：

   | 栏 | 宽度 | 内容 |
   | --- | --- | --- |
   | **左栏** | **约 38%** | **一张半身像**：头肩，正面，居中，像证件照。**脸画全、画细** |
   | **右栏** | **约 62%** | **全身三视图**：正视 / 侧视 / 背视并排，共用一条地平线，三视身高比例和服装细节完全一致，中性站姿、双臂自然下垂 |

   两栏之间用一条细竖线分隔。整张纯白背景、均匀漫射光、无投影。

   **右栏的脸必须留空**：头部只画发型、发际线和耳朵，**不画眼睛、眉毛、鼻子、嘴**，脸部区域保持平整空白。**只有左栏的半身像显示面部。**

   这么排的原因：五官在左栏定死一次，右栏专心管剪影、比例和服装。全身三视里同一张脸画三遍，模型很难画一致，留空就绕开了这个问题。

   提示词里必须逐条写明：`LEFT ZONE, occupying about 38% of the canvas width`、`RIGHT ZONE, occupying about 62%`、以及 `Only the LEFT ZONE bust portrait shows the face`。**说反了整张图就废了。**

6. `voice.prompt` 是给 TTS 音色设计引擎的：描述**乐器本身**，不是某一句台词的演绎。性别、听感年龄、音色、音高区间、共鸣、气声、语速、节奏、口音、能量、默认情绪。

7. **同一批角色之间要能区分开。** 会给你同批其他角色的名字，别把他们的长相和声线做成一个样。

## 输入格式

```
Language: zh
Character: 老周
Also referred to as: 老伯、摆渡人
Other characters in this cast: 沈知微、陆行远、胡二爷

Observations gathered from the source text:
1. ...
2. ...

Verbatim quotes — the ONLY strings allowed in `persona.evidence`:
- ...
- ...
```
