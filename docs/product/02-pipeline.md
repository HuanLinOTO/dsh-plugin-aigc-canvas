# 工作流 DAG 改进详案 ⭐

> 让插件从"调 API 的工具集"升级到"完成 AIGC 任务的工作环境"。
> 这是本插件从工具集合跃迁到 Agent 工作环境的核心改进。

---

## §0 问题陈述

当前用户说"做个 30 秒产品广告片"，Agent 必须：

1. 自己拆解成"生图 → 生视频 → 配音 → 合成 → 剪辑"5 步
2. 每步独立调工具（`aigc_http_request` → `aigc_canvas_place`）
3. 串行等待，中间出错从头重来
4. 中间产物 filePath 全在 Agent 上下文里，崩溃即丢失
5. 无法并行独立分支

**根本问题**：插件的能力粒度是"原子操作"，没有"复合目标"的抽象。

**目标**：让 Agent 能把"复合目标"作为一份声明式 spec 提交给 host，host 负责拓扑排序、并行、进度通知、断点续跑。

---

## §1 Pipeline DAG 概念

### 什么是 Pipeline

Pipeline 是一份步骤清单，每步声明：
- **要做什么**（用哪个 capability / operation）
- **输入是什么**（前面哪些步骤的产物，以什么关系）
- **参数是什么**

host 拿到 spec 后：
1. 拓扑排序（依赖关系建图）
2. 能并行的并行跑（独立分支）
3. 每步完成通过 `agent.inject` 通知 Agent 进度
4. 全部产物自动入画布、自动按关系连边
5. 任一步失败：根据 `onError` 策略决定继续/中止

### Spec 示例：30 秒产品广告片

```yaml
pipeline:
  name: "30s product ad"
  onError: abort
  
  steps:
    # 第 1 步：生成产品图
    - id: product_img
      capability: t2i
      params:
        prompt: "product photo of {{product_name}}, studio lighting"
        size: "1024x1024"
    
    # 第 2 步：图片动起来（依赖第 1 步）
    - id: animated
      capability: i2v
      inputs:
        - from: product_img
          relation: first_frame
      params:
        prompt: "smooth camera pan around the product"
        duration: 5
    
    # 第 3 步：生成旁白（与第 2 步并行，无依赖）
    - id: narration
      capability: tts
      params:
        text: "{{tagline}}"
        voice: "male_en"
    
    # 第 4 步：合成音视频（依赖第 2、3 步）
    - id: with_audio
      operation: add_audio
      inputs:
        - from: animated
        - from: narration
          relation: audio_track
    
    # 第 5 步：剪到 30 秒（依赖第 4 步）
    - id: final_30s
      operation: clip
      inputs: [with_audio]
      params:
        start: 0
        end: 30
```

### 执行流程可视化

```
product_img ──→ animated ──┐
                  │         ├──→ with_audio ──→ final_30s
                  │         │
narration ──────────────────┘
（与 animated 并行）
```

执行时间线：
```
T0: 启动 product_img + narration（并行）
T1: product_img 完成 → 启动 animated
T2: narration 完成（等 animated）
T3: animated 完成 → 启动 with_audio
T4: with_audio 完成 → 启动 final_30s
T5: final_30s 完成 → pipeline 完成
```

---

## §2 用户故事

### 故事 1：复合目标一键提交

**作为用户**，我说"做个 30 秒的 iPhone 17 产品广告片，旁白是'未来已来'"。

**Agent**：
1. 识别这是复合目标，调 `aigc_pipeline_run` 提交 spec
2. host 开始执行，画布右上角出现进度条
3. Agent 收到 host 的进度通知（"step 2/5: generating video"），告诉用户在跑
4. 跑完，Agent 收到最终产物 filePath + 完整执行图
5. Agent 把最终视频放到对话里展示给用户

### 故事 2：断点续跑

**作为用户**，pipeline 跑到第 3 步失败了（provider 限流）。

**Agent**：
1. 收到失败通知，告知用户"第 3 步 narration 失败，前 2 步的产物已保留"
2. 等待用户决定：重试第 3 步？换 provider？改参数？
3. 用户说"换 openai 的 tts 重试"
4. Agent 调 `aigc_pipeline_resume`，传 pipeline_id + 修改第 3 步的 provider
5. host 从断点继续，跳过已完成的 step 1、2

### 故事 3：模板复用

**作为用户**，上次做过 30 秒广告片，这次想用同样流程做个 Mac 的。

**Agent**：
1. 调 `aigc_template_list`，看到"30s-product-ad"模板
2. 调 `aigc_template_instantiate`，传模板名 + 参数 `{"product_name": "MacBook", "tagline": "Power up"}`
3. host 自动跑模板 pipeline

---

## §3 工具集

### `aigc_pipeline_run`

提交一个新 pipeline 并开始执行。

```
参数：
  spec: PipelineSpec          // 见 §1 的 yaml/json 形态
  params?: Record<string, string>  // 模板参数替换（如 product_name）
  async?: boolean = true      // true=立即返回 pipeline_id，进度走通知；false=阻塞到完成

返回：
  pipeline_id: string
  status: "running" | "completed" | "failed"
  steps: Array<{
    id: string
    status: "pending" | "running" | "completed" | "failed" | "skipped"
    element_path?: string     // 成功后的产物 filePath
    error?: string            // 失败原因
    started_at?: number
    finished_at?: number
  }>
```

### `aigc_pipeline_status`

查询 pipeline 状态。

```
参数：
  pipeline_id: string

返回：
  （同 aigc_pipeline_run 的返回结构，含最新状态）
```

### `aigc_pipeline_resume`

从断点续跑失败的 pipeline。

```
参数：
  pipeline_id: string
  step_overrides?: Record<step_id, { provider_id?, params? }>  // 修改某些步骤的配置

返回：
  （同 aigc_pipeline_run）
```

### `aigc_pipeline_cancel`

取消正在跑的 pipeline。

```
参数：
  pipeline_id: string
  keep_artifacts?: boolean = true   // 是否保留已生成的产物

返回：
  cancelled: boolean
  completed_steps: number
```

### `aigc_pipeline_list`

列出当前会话的所有 pipeline（运行中/已完成/失败）。

```
参数：
  include_archived?: boolean = false

返回：
  pipelines: Array<{ pipeline_id, name, status, started_at, finished_at, step_count, completed_count }>
```

---

## §4 Pipeline Spec 形态

### 完整结构

```yaml
pipeline:
  name: string                    # 显示名
  onError: "abort" | "continue"   # 任一步失败时的策略
                                   #   abort: 立即停止，已完成的保留
                                   #   continue: 继续跑不依赖失败步骤的分支
  
  params?: ParamSpec[]            # 模板参数声明（仅模板用）
                                   #   - name, type, default, description
  
  steps: StepSpec[]
```

### StepSpec

```yaml
step:
  id: string                      # 步骤唯一 id，其他 step 用此引用
  
  # 二选一：capability 走 endpoint catalog，operation 走 ffmpeg
  capability?: "t2i" | "i2i" | "t2v" | "i2v" | "fl2v" | "ref2v" | "tts" | "music" | "transcribe" | "edit"
  operation?: MediaEditOperation  # concat/clip/extract_audio/...
  
  # 输入：前面步骤的产物 + 关系
  inputs?: Array<{
    from: string                  # 上游 step id
    relation: EdgeRelation        # 见方向 A §1
  }>
  
  # 参数：根据 capability/operation 不同
  params: Record<string, unknown>
  
  # 可选：覆盖默认 provider 选择
  provider_id?: string
  
  # 可选：条件执行
  when?: string                   # 表达式，如 "step_a.status == 'completed'"
```

### 模板参数替换

Spec 中用 `{{param_name}}` 占位，`aigc_pipeline_run` 时传 `params` 替换：

```yaml
step:
  id: product_img
  capability: t2i
  params:
    prompt: "product photo of {{product_name}}, studio lighting"
```

调用：
```
aigc_pipeline_run({
  spec: ...,
  params: { product_name: "iPhone 17", tagline: "未来已来" }
})
```

---

## §5 进度通知

### 通知时机

host 在以下时刻通过 `agent.inject` 通知 Agent：

| 时刻 | 通知内容 |
|------|---------|
| pipeline 启动 | "Pipeline '30s product ad' started: 5 steps" |
| 每步开始 | "[2/5] Generating video (animated)..." |
| 每步完成 | "[2/5] Done: animated → /path/to/video.mp4 (3.4s)" |
| 每步失败 | "[3/5] FAILED: narration (provider 429). Pipeline paused, resume with aigc_pipeline_resume." |
| pipeline 完成 | "Pipeline completed: 5/5 steps. Final output: /path/to/final.mp4" |

通知形式：`source: { kind: 'plugin', plugin: 'dsh-aigc-canvas', form: 'progress', summary: ... }`

### 客户端进度面板

画布右上角浮层：

```
┌─ Pipeline: 30s product ad ────────────┐
│ ●●●○○  3/5                             │
│                                        │
│ ✓ product_img   14:23:05  3.4s  $0.02  │
│ ✓ animated      14:23:12  8.1s  $0.15  │
│ ⏳ narration     14:23:20  running...  │
│ ○ with_audio                           │
│ ○ final_30s                            │
│                                        │
│ [取消]                  [查看执行图]   │
└────────────────────────────────────────┘
```

- 圆点状态：✓ 完成 / ⏳ 运行 / ○ 待执行 / ✗ 失败
- 点任一步可跳到画布上对应元素
- "查看执行图"展开 pipeline 的 DAG 视图

---

## §6 断点续跑

### 失败时的状态

pipeline 失败时：
- 已完成的步骤：产物保留在画布上（`status: ready`）
- 失败的步骤：无产物
- 未执行的步骤：跳过

### 续跑机制

Agent 调 `aigc_pipeline_resume`：

```
aigc_pipeline_resume({
  pipeline_id: "pipe_abc",
  step_overrides: {
    narration: { provider_id: "openai" }  // 换 provider 重试
  }
})
```

host 行为：
1. 加载 pipeline 的 spec + 已完成步骤的产物
2. 跳过 `status == 'completed'` 的步骤
3. 失败步骤：用 `step_overrides` 修改后重试
4. 后续依赖步骤：等上游完成后继续

### 用户侧 UI

进度面板在失败时显示：

```
┌─ Pipeline: 30s product ad ────────────────┐
│ ●●✗○○  2/5  FAILED at step 3              │
│                                          │
│ ✓ product_img   14:23:05  3.4s  $0.02    │
│ ✓ animated      14:23:12  8.1s  $0.15    │
│ ✗ narration     14:23:20  429 Too Many  │
│ ○ with_audio                             │
│ ○ final_30s                              │
│                                          │
│ 失败原因: provider 限流                   │
│                                          │
│ [重试此步]  [换 provider]  [取消]         │
└──────────────────────────────────────────┘
```

---

## §7 Pipeline 模板

### 模板存储

`~/.dsh/aigc-canvas/templates/<name>.json`：

```json
{
  "name": "30s-product-ad",
  "description": "生成 30 秒产品广告片：产品图 → 动起来 → 配音 → 合成 → 剪辑",
  "params": [
    { "name": "product_name", "type": "string", "required": true, "description": "产品名" },
    { "name": "tagline", "type": "string", "required": true, "description": "旁白文案" },
    { "name": "voice", "type": "string", "default": "male_en", "description": "配音音色" }
  ],
  "spec": {
    "name": "30s product ad for {{product_name}}",
    "onError": "abort",
    "steps": [
      { "id": "product_img", "capability": "t2i",
        "params": { "prompt": "product photo of {{product_name}}, studio lighting", "size": "1024x1024" } },
      { "id": "animated", "capability": "i2v",
        "inputs": [{ "from": "product_img", "relation": "first_frame" }],
        "params": { "prompt": "smooth camera pan", "duration": 5 } },
      { "id": "narration", "capability": "tts",
        "params": { "text": "{{tagline}}", "voice": "{{voice}}" } },
      { "id": "with_audio", "operation": "add_audio",
        "inputs": [{ "from": "animated" }, { "from": "narration", "relation": "audio_track" }] },
      { "id": "final_30s", "operation": "clip",
        "inputs": [{ "from": "with_audio" }],
        "params": { "start": 0, "end": 30 } }
    ]
  }
}
```

### 模板工具

- `aigc_template_list`：列出所有可用模板
- `aigc_template_get`：返回某个模板的 spec + param 声明
- `aigc_template_instantiate`：传模板名 + params，等同于 `aigc_pipeline_run(spec, params)`
- `aigc_template_save`：把当前会话的某个 pipeline 存为模板（去参数化）

### 内置模板

插件自带几个常用模板：

| 模板名 | 用途 | 步骤数 |
|--------|------|:---:|
| `simple-t2i` | 单步文生图（教学用） | 1 |
| `simple-t2v` | 单步文生视频 | 1 |
| `first-last-frame-video` | 首尾帧生视频（t2i × 2 → fl2v） | 3 |
| `30s-product-ad` | 30 秒广告片（完整流程） | 5 |
| `multi-angle-product` | 多角度产品图（t2i × N → grid） | 1 + N |

### 设置页 UI

设置页加"模板"标签：

```
┌─ AIGC 模板 ─────────────────────────────────┐
│                                            │
│ [+ 新建模板]    [导入]    [导出]            │
│                                            │
│ ┌──────────────────────────────────────┐  │
│ │ 30s-product-ad             [内置]    │  │
│ │ 生成 30 秒产品广告片                  │  │
│ │ 参数: product_name*, tagline*, voice  │  │
│ │                    [查看] [实例化]    │  │
│ └──────────────────────────────────────┘  │
│ ┌──────────────────────────────────────┐  │
│ │ multi-angle-product        [自定义]  │  │
│ │ 多角度产品图                          │  │
│ │ 参数: product*, angles                │  │
│ │            [查看] [实例化] [编辑] [删除]│  │
│ └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

---

## §8 场景走查：30 秒广告片完整流程

### 用户操作

1. 用户："做个 30 秒的 iPhone 17 产品广告片，旁白是'未来已来'"

### Agent 行为

1. Agent 识别复合目标，调 `aigc_template_list` 查可用模板
2. 看到 `30s-product-ad` 模板，参数匹配（product_name、tagline）
3. 调 `aigc_template_instantiate`：
   ```
   {
     template: "30s-product-ad",
     params: { product_name: "iPhone 17", tagline: "未来已来" }
   }
   ```
4. host 立即返回 `pipeline_id`，开始执行
5. Agent 收到进度通知：
   - "[1/5] Generating product image..."
   - "[2/5] Generating video..."
   - "[3/5] Generating narration..."
   - "[4/5] Adding audio..."
   - "[5/5] Clipping to 30s..."
   - "Pipeline completed: 5/5 steps. Final: /path/to/final_30s.mp4"
6. Agent 把 final_30s 视频展示给用户

### 画布上的变化

每个步骤完成时画布自动 pan 到新元素：

```
T1: product_img 出现在画布
T2: animated 出现在 product_img 右侧，连线标注"首帧"
T2: narration 出现在画布（与 animated 并行）
T3: with_audio 出现在 animated + narration 右侧，两条连线（input + audio_track）
T4: final_30s 出现在 with_audio 下方，连线标注"编辑自"
```

最终画布：
```
┌─ 画布 ────────────────────────────────────────────────┐
│                                                      │
│  product_img ──(首帧)──→ animated ──┐                │
│                          │          ├─(input)──→ with_audio ──(编辑自)──→ final_30s ✓
│  narration ──────────────────────────┘                │
│       └─(audio_track)────────────────┘                │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 失败场景

第 3 步 narration 失败（provider 限流）：

1. 进度面板变红色："FAILED at step 3"
2. Agent 收到通知："Pipeline paused at step 3 (narration). Steps 1, 2 completed. Resume with aigc_pipeline_resume."
3. 用户："换 openai 的 tts 重试"
4. Agent 调 `aigc_pipeline_resume`：
   ```
   {
     pipeline_id: "pipe_abc",
     step_overrides: { narration: { provider_id: "openai" } }
   }
   ```
5. host 跳过 step 1、2，重试 step 3 用 openai，成功后继续 step 4、5

---

## §9 验收标准

### Pipeline 核心功能

- [ ] `aigc_pipeline_run` 工具可用，接受 spec + params
- [ ] host 拓扑排序步骤
- [ ] 独立分支并行执行
- [ ] 每步完成通过 `agent.inject` 通知 Agent
- [ ] 每步产物自动 `aigc_canvas_place` 入画布
- [ ] 步骤间自动 `aigc_canvas_link` 连边（按 inputs.relation）
- [ ] `onError: abort` 时立即停止，保留已完成产物
- [ ] `onError: continue` 时继续跑不依赖失败步骤的分支

### 断点续跑

- [ ] `aigc_pipeline_resume` 可用
- [ ] 跳过已完成步骤
- [ ] 支持 `step_overrides` 修改失败步骤的配置
- [ ] 续跑产物继续入画布，不重复创建

### 模板

- [ ] `aigc_template_list` / `aigc_template_get` / `aigc_template_instantiate` / `aigc_template_save` 可用
- [ ] 模板存到 `~/.dsh/aigc-canvas/templates/`
- [ ] 内置模板随插件分发
- [ ] 模板参数 `{{name}}` 占位符替换

### 客户端

- [ ] 进度面板浮层在画布右上角
- [ ] 显示每步状态（✓/⏳/○/✗）+ 耗时 + 成本
- [ ] 失败时显示原因 + 重试/换 provider/取消按钮
- [ ] 点步骤可跳到画布对应元素
- [ ] "查看执行图"展开 DAG 视图
- [ ] 设置页加"模板"标签

### 异步与取消

- [ ] `async: true` 时立即返回 pipeline_id
- [ ] `async: false` 时阻塞到完成（不适合长 pipeline）
- [ ] `aigc_pipeline_cancel` 可取消运行中的 pipeline
- [ ] `keep_artifacts: true` 时取消后产物保留

---

## §10 实现要点

### host 端

- 新模块 `src/pipeline.ts`：pipeline spec 解析、拓扑排序、执行引擎
- pipeline 状态持久化到 `<cwd>/.dsh-aigc-canvas/<sessionId>/pipelines/<pipeline_id>.json`
- 复用现有 `aigc_http_request` 内部逻辑（不重复实现 provider 调用）
- 复用现有 `aigc_media_edit` 的 ffmpeg 引擎
- 通过 `ctx.jobs.start` 暴露为可观测任务

### 步骤执行抽象

每步执行器接口：
```
executeStep(step: StepSpec, inputs: Element[], ctx): Promise<Element>
```

- `capability` 类步骤：查 endpoint catalog → 调 provider → 落盘 → place
- `operation` 类步骤：调 ffmpeg → 落盘 → place

### 客户端

- 新组件 `PipelinePanel.tsx`：右上角浮层
- 通过 WS 推送 pipeline 状态变更（复用现有 canvas WS）
- 新设置页标签 `TemplatesPage.tsx`

### 错误处理

- 每步失败时记录错误 + 时间戳到 pipeline 状态
- `onError: abort` 立即停止后续步骤
- `onError: continue` 跳过失败步骤的依赖链，继续独立分支
- 取消时通过 `AbortSignal` 中止运行中的步骤

---

## §11 风险与权衡

### 风险 1：复杂度膨胀

Pipeline DAG 是双刃剑——让 Agent 能完成复合目标，但调试困难、错误处理路径多。

**缓解**：
- 第一版限制为线性 + 简单 fan-out（不支持任意 DAG）
- 跑通后再放开复杂图

### 风险 2：与 DSH plan/subagent 的边界

有人会争论："Agent 本来就是规划者，让 DSH 的 plan/subagent 拆，插件不该自己搞 pipeline"。

**反驳**：
1. 插件内 pipeline 有 host-side 状态（中间产物、进度、断点续跑），Agent 自己拆只能串行调工具，中间状态全在 Agent 上下文里，崩溃即丢失
2. Pipeline spec 可存为模板复用；Agent 拆解每次重来
3. Pipeline 的拓扑排序 + 并行分支是 host 强项，Agent 串行调用无法并行

两者不互斥：Agent 仍可用 DSH plan 拆高层任务，pipeline 处理"AIGC 子任务"这一类有结构的子流程。

### 风险 3：Agent 上下文膨胀

长 pipeline 中间产物多，画布状态可能撑爆 Agent 上下文。

**缓解**：
- `aigc_canvas_list_elements` 支持 `summarize: true` 返回压缩视图
- pipeline 通知用短摘要而非完整状态

---

## §12 优先级

| 改进 | 难度 | 优先级 | 备注 |
|------|:---:|:---:|------|
| §1-3 Pipeline 核心（spec + 执行 + 进度） | 高 | P0 | 核心 |
| §6 断点续跑 | 中 | P0 | 失败处理是刚需 |
| §4 进度面板 UI | 中 | P0 | 用户可见 |
| §7 模板系统 | 中 | P1 | 复用价值高 |
| §10 内置模板 | 低 | P1 | 锦上添花 |
