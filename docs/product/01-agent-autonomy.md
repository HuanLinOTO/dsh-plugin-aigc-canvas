# Agent 自主性改进详案

> 让 Agent 从"会调 API"升级到"会基于已有产物推理下一步"。
> 包含：语义化边 / 元素记录原始请求 / 重新生成 / 批量变体 / 元素生命周期 / Agent 自评。

---

## §0 问题陈述

当前画布对 Agent 来说是"只读结果视图"——它能看到自己生成的产物，但：

1. **边没有语义**：所有连线等价，Agent 无法区分"首帧"vs"风格参考"vs"变体"
2. **不知道产物怎么来的**：`meta` 是无 schema 的 `Record<string, unknown>`，Agent 想 reroll 只能从头拼请求
3. **没有 reroll 原语**：失败重做要 4 个工具调用串起来
4. **没有 variation 原语**："给我 4 个选项"要串行调 4 次
5. **没有生命周期**：元素要么在画布上、要么被删除，没有"失败草稿/已取代旧版"概念
6. **没有自反思**：生成完就结束，Agent 不知道产物好不好

---

## §1 语义化边

### 用户故事

**作为 Agent**，当我调 `aigc_canvas_list_elements` 时，我希望看到带语义的关系图，这样我能推理"我之前用 A 做首帧生成了 B，现在 B 失败了我可以重新生成首帧 A"。

**作为用户**，我希望画布上的连线带标签和颜色，这样我一眼能看出"这是首帧关系还是风格参考关系"。

### 11 种关系类型

| 关系 | 含义 | 场景 |
|------|------|------|
| `input` | 直接输入（如 t2i 的 prompt → image） | 默认关系 |
| `reference` | 多参考生视频中的参考 | ref2v |
| `first_frame` | 首尾帧生视频的首帧 | fl2v |
| `last_frame` | 尾帧 | fl2v |
| `style` | 风格参考 | i2i 风格迁移 |
| `mask` | 蒙版 | 编辑局部 |
| `audio_track` | 音轨 | 给视频加音频 |
| `variation_of` | 同 prompt 不同 seed 的变体 | reroll / variation |
| `remix_of` | 改 prompt 的再创作 | reroll with prompt_delta |
| `alternative_of` | A/B 候选关系 | variation 簇内 |
| `edited_from` | ffmpeg 编辑链 | media_edit 后 |

### 验收标准

- [ ] `aigc_canvas_link` 工具新增 `relation` 必填参数，取值限于上述 11 种
- [ ] `aigc_canvas_place` 的 `references` 参数升级为 `{ filePath, relation }[]`
- [ ] `aigc_canvas_list_elements` 返回的 edges 带 `relation` 字段
- [ ] 客户端画布上的连线带文字标签（如"首帧"）
- [ ] 不同关系用不同线型区分：实线=直接输入，虚线=参考，点线=变体
- [ ] 旧的 `canvas.json` 文件加载时，无 relation 字段的边默认为 `input`（向后兼容）

### UI 线框

```
┌─ 画布 ─────────────────────────────────────────────────┐
│                                                        │
│  prompt A ──(首帧)─────→ video B                       │
│  prompt C ──(尾帧)─────↗                               │
│  prompt D ──(输入)─────↗                               │
│                                                        │
│  原图 ┄┄┄(变体)┄┄┄→ 变体1                              │
│        ┄┄┄(变体)┄┄┄→ 变体2  ✓winner                   │
│        ┄┄┄(变体)┄┄┄→ 变体3                            │
│                                                        │
└────────────────────────────────────────────────────────┘

线型图例：
─── 实线：直接输入（input/first_frame/last_frame/audio_track）
- - 虚线：参考（reference/style/mask）
┄┄┄ 点线：变体/候选（variation_of/remix_of/alternative_of）
─── 粗实线：编辑链（edited_from）
```

### 实现要点

- `AigcEdge` 接口加 `relation: EdgeRelation` 字段（必填）+ 可选 `note?: string`
- 工具 schema：`aigc_canvas_link` 的 `relation` 参数用 `enum` 约束
- 客户端 `renderEdge` 根据 relation 选颜色 + 线型 + 标签
- 边的标签位置：曲线中点，背景色与画布一致避免遮挡

---

## §2 元素记录"我是怎么来的"

### 用户故事

**作为 Agent**，当我看到一张图想重新生成它时，我希望直接调"重新生成"工具传原图即可，不需要自己去解析 `meta` 字段猜原始请求是什么。

**作为 host**，我需要在 `aigc_canvas_place` 时自动记录"这张图是用哪个 provider 的哪个 endpoint、什么 body 生成的"，存到元素的 `meta.originalRequest`。

### 结构化 meta 草案

元素 `meta` 字段从无 schema 的 `Record<string, unknown>` 升级为：

```
meta: {
  // host 自动填，Agent 不需要写
  originalRequest: {
    providerId: "volcano"
    endpoint: "/v1/images/generations"
    method: "POST"
    body: { prompt: "...", size: "1024x1024", seed: 42 }
    query: {}
  }
  responseInfo: {
    contentType: "application/json"
    size: 1234567
    durationMs: 3400
  }
  // 用户/Agent 显式传的 meta 仍保留
  ...userMeta
}
```

### 验收标准

- [ ] `aigc_canvas_place` 时如果元素来自 `aigc_http_request`，host 自动从最近的请求中提取 `originalRequest`
- [ ] `aigc_http_request` 返回的 `file_path` 关联的请求信息在 host 内部缓存（直到被 place 消费）
- [ ] `aigc_canvas_list_elements` 返回的 `meta.originalRequest` 完整可读
- [ ] Agent 自定义的 meta 字段不被覆盖
- [ ] 旧元素无 `originalRequest` 时 reroll 工具报错"无法 reroll 这个元素（缺少原始请求信息）"

### 实现要点

- `tools.ts` 的 `aigc_http_request` 内部维护一个 `Map<filePath, RequestSnapshot>`（按 sessionId 隔离）
- `aigc_canvas_place` 时如果 file_path 命中缓存，把 snapshot 写入 `meta.originalRequest`
- 缓存条目在 place 消费后删除，避免内存膨胀

---

## §3 重新生成（reroll）

### 用户故事

**作为用户**，我说"这张猫的姿势不对，重画一张，姿势改成坐着"，希望 Agent 一步完成，新图自动连到原图作为变体。

**作为 Agent**，我希望调一个工具 `aigc_reroll`，传原图 + 修改项，host 自动重建请求并执行。

### 工具形态

Agent 可见的新工具 `aigc_reroll`：

```
参数：
  source_element: string          // 原图 filePath
  patch?: {
    seed?: number                 // 不传则随机
    prompt_delta?: string         // 在原 prompt 后追加
    prompt_replace?: string       // 完全替换 prompt
    size?: string                 // 改尺寸
    // 其他原请求字段覆盖
  }
  count?: number                  // 默认 1，>1 时生成多个变体
  provider_id?: string            // 默认用原 provider

返回：
  elements: [{                    // 新生成的元素
    filePath, kind, title, x, y
  }]
  linked_to: string               // 原图 filePath
  relation: "variation_of" | "remix_of"  // 自动判断
```

**relation 自动判断规则**：
- 只改 seed → `variation_of`
- 改了 prompt（delta 或 replace）→ `remix_of`
- 改了其他参数 → `variation_of`

### 用户侧 UI

#### 右键菜单新增"重新生成..."

```
[元素卡片右键]
├── 重新生成...          → 弹窗
├── 用作参考...
├── 发到对话
├── 下载
├── 提升到资产库...
├── 标记为 winner
├── 标记为否决
└── 删除
```

#### 重新生成弹窗

```
┌─ 重新生成 ─────────────────────────────┐
│                                        │
│ 基于元素: orange cat (image)           │
│ 原始 prompt: a cat sitting on grass    │
│                                        │
│ Prompt 修改:                           │
│ ┌────────────────────────────────┐    │
│ │ a cat sitting on a chair       │    │
│ └────────────────────────────────┘    │
│ ○ 追加到原 prompt                       │
│ ● 完全替换                              │
│                                        │
│ Seed: [随机] 或 [______]                │
│ 尺寸: [1024x1024 ▼]                    │
│ 数量: [1] [2] [4]                      │
│                                        │
│ [取消]                  [重新生成]     │
└────────────────────────────────────────┘
```

### 验收标准

- [ ] `aigc_reroll` 工具可用，传 source_element + patch
- [ ] host 从 `meta.originalRequest` 重建请求，应用 patch，调用原 provider
- [ ] 新元素以 `variation_of` 或 `remix_of` 边连到原图
- [ ] 新元素自动摆放在原图右侧（grid 布局，count>1 时）
- [ ] 右键菜单"重新生成..."弹窗可触发同样行为，背后调 Agent 发消息
- [ ] 原图无 `originalRequest` 时友好报错
- [ ] count>1 时所有变体互连 `alternative_of` 关系

### 实现要点

- 新工具 `aigc_reroll` 在 `tools.ts` 注册
- 依赖 §2 的 `meta.originalRequest`
- 复用 `aigc_http_request` 的内部请求逻辑（避免代码重复）
- 客户端右键菜单加项，调 `ctx.conversation.send` 发准备好的 prompt

---

## §4 批量变体（variation）

### 用户故事

**作为用户**，我说"给我 4 张不同姿势的猫"，希望一次拿到 4 张并排的图，能直接挑 winner。

**作为 Agent**，我希望调一个工具 `aigc_variation`，host 并行调用 + 自动 grid 布局 + 自动簇关系。

### 工具形态

```
参数：
  source_element?: string        // 基于哪个元素变体（不传则纯 t2i）
  prompt?: string                // 不传则用 source 的 prompt
  count: 2-8                     // 变体数量
  strategy: "seed" | "prompt_perturb" | "both"
  prompt_perturb?: string        // 如 "more cinematic"
  layout?: "grid" | "row" | "column"  // 默认 grid
  provider_id?: string

返回：
  cluster_id: string             // 簇 id
  elements: [{ filePath, x, y }]
```

### 簇（cluster）概念

变体不止是 4 张图，它们组成一个"簇"：
- 簇有一个虚节点（不渲染媒体，只占位 + 标题）
- 4 张图都以 `variation_of` 连到簇节点
- 4 张图互相以 `alternative_of` 连接
- 簇节点位置 = 4 张图的几何中心

### 用户侧 UI

#### 画布上的簇渲染

```
┌─ 画布 ──────────────────────────────────────┐
│                                            │
│         ┌─ 簇: 4 cats ─┐                   │
│         │ [图1]  [图2] │                   │
│         │ [图3]  [图4] │ ✓winner: 图2     │
│         └──────────────┘                   │
│                                            │
└────────────────────────────────────────────┘
```

- 簇边框淡色虚线
- 标签"4 cats"在顶部
- winner 角标在选定的图上
- 其他变体可手动"标记为否决"→ 灰显

#### 多选 → 对比视图

用户多选 2-4 个元素（按住 Shift 或框选）：
```
┌─ 对比视图（浮层） ─────────────────────────────┐
│                                              │
│  [图1]      [图2]      [图3]      [图4]      │
│  prompt:   prompt:   prompt:   prompt:      │
│  ...       ...       ...       ...          │
│  seed: 1   seed: 2   seed: 3   seed: 4      │
│                                              │
│  [✓ 选为 winner]    [✗ 全部否决]    [关闭]   │
└──────────────────────────────────────────────┘
```

### 验收标准

- [ ] `aigc_variation` 工具可用，传 count 2-8
- [ ] host 并行调用 provider（如 provider 支持 batch 则单次）
- [ ] 变体自动以 N×M grid 摆放（如 4 个 → 2×2）
- [ ] 所有变体连到簇节点（`variation_of`）
- [ ] 变体互相连接（`alternative_of`）
- [ ] 客户端渲染簇边框 + 标签
- [ ] 多选 2-4 元素可触发对比视图
- [ ] 对比视图可选 winner，winner 角标显示在卡片上
- [ ] 选 winner 后其他变体可选"自动归档"（标 `archived`，灰显但不删）

### 实现要点

- 新工具 `aigc_variation` 在 `tools.ts` 注册
- host 内部用 `Promise.all` 并行（限制并发数避免 provider 限流）
- 簇节点是一种特殊元素 `kind: 'cluster'`（不渲染媒体）
- 客户端 `CanvasNode` 加 cluster 分支
- 对比视图是浮层组件，独立于画布的 world layer

---

## §5 元素生命周期

### 用户故事

**作为用户**，我希望区分"这是定稿"、"这是失败草稿"、"这是被取代的旧版"，这样画布不会越用越乱。

**作为 Agent**，我希望 `aigc_canvas_list_elements` 默认只返回 `ready` 元素，避免上下文被一堆 `archived` 元素污染。

### 4 种状态

| 状态 | 含义 | 视觉 |
|------|------|------|
| `draft` | 生成中（pipeline 异步用） | 半透明 + 加载动画 |
| `ready` | 可用 | 正常显示 |
| `rejected` | 被 Agent/用户否决（保留作为"不要再这样生成"的负样本） | 灰度 50% + 删除线 |
| `archived` | 被新版本取代 | 灰度 30%，默认隐藏 |

### 状态转换

```
                  ┌──────────┐
                  │  draft   │ ← pipeline 创建
                  └────┬─────┘
                       │ 生成完成
                       ▼
                  ┌──────────┐
        ┌─────────│  ready   │─────────┐
        │         └──────────┘         │
        │ 用户否决                       │ 被新版本取代
        ▼                              ▼
  ┌──────────┐                   ┌──────────┐
  │ rejected │                   │ archived │
  └──────────┘                   └──────────┘
        │                              │
        └──────────可恢复──────────────┘
                       │
                       ▼
                  ┌──────────┐
                  │  ready   │
                  └──────────┘
```

### 工具变化

- `aigc_canvas_list_elements` 加 `include_statuses?: ElementStatus[]`，默认 `['ready']`
- `aigc_canvas_place` 加 `status?: ElementStatus`，默认 `ready`
- 新工具 `aigc_canvas_set_status`：传 filePath + 新 status
- `aigc_reroll` 生成的变体如果用户选了 winner，其他变体自动标 `archived`

### 用户侧 UI

#### 状态切换

右键菜单加：
```
[元素卡片右键]
├── 重新生成...
├── 用作参考...
├── ...
├── ─────────────
├── 标记为 winner     → status 保持 ready + 加 winner 角标
├── 标记为否决        → status = rejected
├── 归档              → status = archived
└── 删除
```

#### 画布过滤器

画布 header 加状态过滤器：
```
[AIGC 画布] 5 元素 | 4 连线 | $0.42 | 状态: [✓ready] [✓draft] [□rejected] [□archived] | 100% [-][+]
```

### 验收标准

- [ ] 元素 `status` 字段存在，默认 `ready`
- [ ] `aigc_canvas_list_elements` 默认只返回 `ready`，传 `include_statuses` 可扩展
- [ ] 客户端按状态应用视觉差异（透明度/灰度）
- [ ] 状态过滤器在画布 header 可用
- [ ] 状态转换通过 `aigc_canvas_set_status` 工具或右键菜单触发
- [ ] 旧元素加载时无 status 默认为 `ready`

### 实现要点

- `AigcElement` 加 `status: ElementStatus`
- `canvas-registry.ts` 的 `snapshot` 支持状态过滤
- 客户端 `CanvasNode` 根据 status 加 className
- 状态变更通过 `notifyAgent` 通知 Agent（"用户否决了 X，不要再这样生成"）

---

## §6 Agent 自评（self-critique）

### 用户故事

**作为用户**，我希望 Agent 生成完图后自己评估好不好，分数低自动 reroll，而不是我每次都要看一眼说"不行重做"。

**作为 Agent**，我希望有一个工具 `aigc_assess` 能调用一个"评审" provider 评估产物，返回结构化分数 + 理由。

### 工具形态

```
参数：
  element: string               // 待评估元素 filePath
  dimensions?: string[]          // 评估维度，默认 ["prompt_match", "quality", "sfw"]
  judge_provider?: string        // 评审 provider，默认用配置的 judge

返回：
  scores: {
    prompt_match: 0-100
    quality: 0-100
    sfw: 0-100
  }
  overall: 0-100
  reason: string                 // 简短理由
  recommendation: "accept" | "reroll" | "reroll_with_adjustments"
  adjustments?: { prompt_delta?: string, ... }  // 建议的调整
```

### 评审 provider 配置

设置页加一个"评审 provider"配置区：
```
┌─ 评审 Provider ─────────────────────────┐
│                                        │
│ 评审 provider: [openai ▼]              │
│ 评审模型:    [gpt-4o ▼]                │
│ 触发阈值:    自动 reroll 当分数 < [60] │
│                                        │
│ ☐ 生成后自动评估                       │
│ ☐ 评估失败时降级为"不评估"             │
└────────────────────────────────────────┘
```

### 闭环行为

```
生成 → 自评 → 分数 ≥ 阈值？
              ├─ 是 → 保留，标 ready
              └─ 否 → 自动 reroll with adjustments
                      └─ 重试 N 次仍低 → 保留最佳，标 ready + 注释"质量较低"
```

### 验收标准

- [ ] `aigc_assess` 工具可用
- [ ] 评审 provider 可在设置页配置
- [ ] 自动评估开关可配置
- [ ] 阈值可配置
- [ ] 自评失败时降级为"不评估"（不阻塞主流程）
- [ ] 评估结果记录到元素 `meta.assessment`
- [ ] 自动 reroll 次数有上限（默认 3）

### 实现要点

- 新工具 `aigc_assess` 在 `tools.ts` 注册
- 评审 provider 走标准 `aigc_http_request` 路径，body 是"看这张图，按 X 维度打分"
- 评审 provider 需要支持视觉输入（如 OpenAI gpt-4o）
- 闭环逻辑在 host 内部，Agent 不需要手动串

---

## §7 实现优先级

| 改进 | 依赖 | 难度 | 优先级 |
|------|------|:---:|:---:|
| §1 语义化边 | 无 | 低 | P0 |
| §2 元素记录原始请求 | 无 | 低 | P0 |
| §3 重新生成 | §2 | 中 | P0 |
| §4 批量变体 | §1（簇关系） | 中 | P1 |
| §5 元素生命周期 | 无 | 中 | P1 |
| §6 Agent 自评 | 无（但需要评审 provider） | 中 | P2 |

---

## §8 与其他方向的依赖

- §3 重新生成依赖 §2 元素记录原始请求
- §4 批量变体依赖 §1 语义化边（簇关系）
- 方向 B 工作流 DAG 引用 §1 的关系类型作为 step 间的连接语义
- 方向 D 对比视图依赖 §4 的簇概念
- 方向 D 右键菜单扩展依赖 §3、§4、§5 的功能存在
