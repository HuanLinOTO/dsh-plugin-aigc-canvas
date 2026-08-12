# UX 与可靠性改进详案

> 让画布从"能看"到"好用"，让 provider 调用从"能跑"到"省心"。

---

## §0 问题陈述

### UX 短板

1. 右键菜单只有"删除"——缺少 Regenerate / Use as reference / Send to chat / Download / Promote to library
2. 无对比视图——生成 4 张图想挑最好的，用户只能肉眼扫
3. 画布工具栏只有缩放/刷新——缺少快捷动作按钮
4. 元素卡片不显示成本/耗时——用户不知道这次生成花了多少

### 可靠性短板

1. 无请求日志——Agent 调 5 次 http_request 失败 2 次，用户没法看哪步炸了
2. 无成本追踪——provider 每次 $ 多少不知道
3. 无自动重试——429/5xx 直接报错给 Agent，没有 backoff
4. 无去重——同参数调两次写两个文件，Agent retry 时浪费成本

---

## §1 右键菜单扩展

### 现状

```
[元素卡片右键]
└── 删除
```

### 改进后

```
[元素卡片右键]
├── 重新生成...                    → 弹窗（见方向 A §3）
├── 用作参考...                    → 弹窗（见下文）
├── 发到对话                       → 把元素作为消息发给 Agent
├── 下载                           → 浏览器下载媒体文件
├── 提升到资产库...                → 弹窗（见 §6）
├── ─────────────
├── 标记为 winner                  → status 保持 ready + 加角标
├── 标记为否决                     → status = rejected
├── 归档                           → status = archived
├── ─────────────
└── 删除
```

### "用作参考"弹窗

把当前元素作为后续生成的参考：

```
┌─ 用作参考 ─────────────────────────────────┐
│                                            │
│ 元素: orange cat (image)                   │
│                                            │
│ 选择关系:                                  │
│ ○ 首帧 (first_frame)                       │
│ ○ 尾帧 (last_frame)                        │
│ ○ 风格参考 (style)                          │
│ ○ 蒙版 (mask)                              │
│ ● 普通参考 (reference)                      │
│                                            │
│ 复制到剪贴板:                               │
│ ┌────────────────────────────────────────┐ │
│ │ /path/to/element.png                   │ │  ← Agent 引用用
│ └────────────────────────────────────────┘ │
│                                            │
│ [复制 filePath]    [发到对话作为参考]       │
└────────────────────────────────────────────┘
```

### "发到对话"行为

把元素的 filePath + 简短描述作为消息发给 Agent：
```
请用这个元素作为参考:[filePath: /path/to/element.png, kind: image, title: orange cat]
```
Agent 收到后知道用户希望接下来用这个元素。

---

## §2 对比视图

### 触发方式

用户多选 2-4 个元素（按住 Shift 点击，或框选）：

```
[画布上多选状态]
┌─────────────────────────────────────────┐
│ [图1] [图2] [图3] [图4]   已选 4 个      │
│                          [对比] [取消]  │
└─────────────────────────────────────────┘
```

点"对比"进入对比视图（画布浮层）：

### 对比视图 UI

```
┌─ 对比视图 ─────────────────────────────────────────────────┐
│                                                          │
│  [图1]         [图2]         [图3]         [图4]         │
│  ┌──────┐     ┌──────┐     ┌──────┐     ┌──────┐       │
│  │      │     │      │     │      │     │      │       │
│  │ img  │     │ img  │     │ img  │     │ img  │       │
│  │      │     │      │     │      │     │      │       │
│  └──────┘     └──────┘     └──────┘     └──────┘       │
│                                                          │
│  prompt:       prompt:       prompt:       prompt:      │
│  a cat sit...  a cat lie...  a cat run...  a cat jum... │
│                                                          │
│  seed: 1       seed: 2       seed: 3       seed: 4       │
│  $0.02 3.4s    $0.02 3.1s    $0.02 3.6s    $0.02 3.2s   │
│                                                          │
│  [✓ 选为 winner]    [✗ 全部否决]    [关闭]               │
└──────────────────────────────────────────────────────────┘
```

- 同尺度并排（按最大图缩放对齐）
- 每张图下方显示 prompt + seed + 成本 + 耗时
- 点"选为 winner"进入选择模式：点击任一张设为 winner
- 选 winner 后其他自动归档（status = archived）

### 验收标准

- [ ] 多选 2-4 元素（Shift 点击或框选）
- [ ] 选 2-4 个时显示"对比"按钮
- [ ] 对比视图是浮层，覆盖画布
- [ ] 同尺度并排，prompt/seed/成本/耗时可读
- [ ] 点 winner → 该元素保持 ready，其他标 archived
- [ ] "全部否决" → 所有标 rejected
- [ ] 对比视图依赖方向 A §4 的簇概念（簇内元素对比）

---

## §3 请求日志面板

### 入口

画布右下角加"日志"按钮：

```
[画布右下角]
                              [📊 日志(5)]
                              [小地图]
```

点开是浮层（或独立 tab，二选一）：

### 日志面板 UI

```
┌─ 请求日志 ───────────────────────────────────────────────────┐
│                                                            │
│ [清空]  [导出]  筛选: [全部 ▼]  搜索: [_______________]    │
│                                                            │
│ 时间          Provider    Path                          状态  耗时   大小    │
│ 14:23:05.123  volcano     /v1/images/generations        200  3.4s   1.2MB  ▶│
│ 14:23:12.456  volcano     /v1/videos/generations        200  8.1s   4.5MB  ▶│
│ 14:23:20.789  openai      /v1/audio/speech              429  0.2s   -      ▶│
│ 14:23:21.234  openai      /v1/audio/speech (retry 1)    200  1.1s   180KB  ▶│
│ 14:23:30.567  -           ffmpeg: add_audio             -    2.3s   4.6MB  ▶│
│                                                            │
│ ┌─ 详情 ─────────────────────────────────────────────────┐ │
│ │ 14:23:12.456  volcano  POST /v1/videos/generations     │ │
│ │                                                        │ │
│ │ Request headers:                                       │ │
│ │   Authorization: Bearer sk-***                         │ │
│ │   Content-Type: application/json                       │ │
│ │                                                        │ │
│ │ Request body:                                          │ │
│ │ {                                                      │ │
│ │   "prompt": "smooth camera pan around the product",    │ │
│ │   "duration": 5                                        │ │
│ │ }                                                      │ │
│ │                                                        │ │
│ │ Response (200, video/mp4, 4.5MB):                      │ │
│ │   saved to /path/to/element.mp4                        │ │
│ │   [下载]  [在画布上定位]                                │ │
│ └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 日志条目内容

每条日志记录：
- 时间戳
- 类型：provider 请求 / ffmpeg 操作 / pipeline 步骤
- provider 名（如有）
- HTTP method + path
- 状态码（HTTP 或 ffmpeg 退出码）
- 耗时（ms）
- 响应大小（字节）
- 失败时：错误原因
- 关联的元素 filePath（如生成了产物）

点开看详情：
- 请求 headers（apiKey 脱敏）
- 请求 body（完整）
- 响应 headers
- 响应 body 预览（前 500 字符）
- 响应文件路径 + 下载按钮
- "在画布上定位"按钮（跳到对应元素）

### 验收标准

- [ ] 画布右下角"日志"按钮
- [ ] 每次 `aigc_http_request` 调用记一条
- [ ] 每次 `aigc_media_edit` 调用记一条
- [ ] 每次 pipeline 步骤记一条
- [ ] 失败请求标红
- [ ] 点条目展开详情（headers + body + response）
- [ ] apiKey 在日志中脱敏
- [ ] "在画布上定位"可跳到对应元素
- [ ] "清空"按钮清空当前会话日志
- [ ] 日志按会话隔离，不跨会话

---

## §4 自动重试 + 去重

### 自动重试

`aigc_http_request` 对以下状态码自动重试：

| 状态码 | 含义 | 重试策略 |
|--------|------|---------|
| 429 | 限流 | 指数退避：1s → 2s → 4s，最多 3 次 |
| 500 | 服务器内部错误 | 同上 |
| 502 | 网关错误 | 同上 |
| 503 | 服务不可用 | 同上 |
| 504 | 网关超时 | 同上 |

其他状态码（4xx 除 429）不重试，直接报错。

### 配置项

provider 级配置：
```
provider:
  retryPolicy:
    maxAttempts: 3              # 默认 3
    backoffBaseMs: 1000         # 默认 1s
    retryOn: [429, 500, 502, 503, 504]  # 默认如上
```

### 日志显示

重试在日志面板可见：
```
14:23:20.789  openai  /v1/audio/speech   429  0.2s  -      ▶
14:23:21.890  openai  /v1/audio/speech (retry 1, backoff 1s)  200  1.1s  180KB  ▶
```

### 去重

同 provider + 同 path + 同 body 哈希的请求，在 N 分钟内返回缓存的 filePath 而不重新调用。

### 配置项

全局配置：
```
dedupWindowMs: 60000            # 默认 0 = 关闭，建议 60s
```

### 去重行为

- body 哈希 = SHA-256(method + path + body)
- 缓存 key = provider_id + body_hash
- 命中缓存时返回 `{ ok: true, status: 200, kind, file_path, file_size, deduplicated: true }`
- Agent 看到 `deduplicated: true` 知道是缓存命中

### 日志显示

去重命中也记一条：
```
14:24:00.123  volcano  /v1/images/generations  200 (cached)  0.01s  1.2MB  ▶
```

### 验收标准

- [ ] 429/5xx 自动重试，指数退避
- [ ] 重试次数可配（maxAttempts）
- [ ] 退避基数可配（backoffBaseMs）
- [ ] 重试在日志中可见
- [ ] 去重可配（dedupWindowMs，默认 0 = 关闭）
- [ ] 去重命中返回 `deduplicated: true`
- [ ] 去重缓存按会话隔离
- [ ] 去重命中也记日志

---

## §5 成本追踪

### 数据来源

每个 provider 配置可选：
```
provider:
  costPerCall: 0.02             # 单次调用成本（美元）
  # 或
  costPerKiloToken: 0.01        # 按 token 计费（如 chat）
  # 或
  costPerSecond: 0.001          # 按视频秒数计费（如 t2v）
```

### 累计

host 在每次 `aigc_http_request` 成功后累加到会话成本：
```
sessionCost: {
  total: 0.42
  byProvider: { volcano: 0.30, openai: 0.12 }
  byCapability: { t2i: 0.06, t2v: 0.30, tts: 0.06 }
}
```

### UI 显示

#### 画布 header

```
[AIGC 画布] 5 元素 | 4 连线 | 本会话 $0.42 | 100% [-][+]
```

#### 元素卡片

```
┌────────────────────┐
│ 🟢 图片 ✓winner    │
│ orange cat          │
│ [图片]              │
│ $0.02 · 3.4s        │  ← 角标
└────────────────────┘
```

#### 日志面板

每条记录显示成本，底部汇总：
```
┌─ 请求日志 ──────────────────────────────────────┐
│ ...                                            │
│ 14:23:30  ffmpeg: add_audio  -  2.3s  4.6MB    │
│                                                │
│ ──────────────────────────────────────────     │
│ 本会话总计: $0.42                              │
│   volcano: $0.30 (t2i: $0.06, t2v: $0.24)      │
│   openai: $0.12 (tts: $0.06, tts: $0.06)       │
└────────────────────────────────────────────────┘
```

#### 设置页 Provider 卡片

显示该 provider 的累计成本（全会话）：
```
┌─ Provider: volcano ─────────────────────────┐
│ ...                                        │
│ 本会话: $0.30 (15 次调用)                   │
└────────────────────────────────────────────┘
```

### 验收标准

- [ ] provider 配置支持 costPerCall / costPerKiloToken / costPerSecond
- [ ] 每次 `aigc_http_request` 成功后累加成本
- [ ] 画布 header 显示本会话总成本
- [ ] 元素卡片显示该元素的成本 + 耗时
- [ ] 日志面板每条记录显示成本
- [ ] 日志面板底部按 provider + capability 汇总
- [ ] 设置页 provider 卡片显示该 provider 累计成本
- [ ] 成本按会话隔离

---

## §6 跨会话资产库

### 概念

会话一关，画布的图就孤立了。资产库让用户主动把满意的作品"提升"出来，跨会话复用。

### 资产库存储

`~/.dsh/aigc-canvas/library/`：
```
library/
├── index.json                  # 资产索引
├── images/
│   ├── <uuid>.png              # 资产文件副本
│   └── ...
├── prompts/
│   └── <uuid>.txt
└── templates/                  # pipeline 模板（见方向 B §7）
```

### index.json 结构

```json
{
  "assets": [
    {
      "id": "asset_abc",
      "type": "image",
      "filePath": "images/asset_abc.png",
      "title": "cyberpunk cat",
      "tags": ["cyberpunk", "cat", "style-reference"],
      "category": "style-reference",
      "originalPrompt": "a cat in cyberpunk style, neon lights, ...",
      "sourceSessionId": "sess_xyz",
      "sourceElementPath": "/path/to/original.png",
      "createdAt": 1234567890,
      "metadata": { "size": "1024x1024", "model": "volcano-t2i" }
    }
  ]
}
```

### 资产分类

| category | 用途 | 示例 |
|----------|------|------|
| `style-reference` | 风格参考 | 赛博朋克风格的图 |
| `subject-reference` | 主体参考 | 某个角色的图 |
| `prompt-template` | prompt 模板 | 常用 prompt 文本 |
| `voice-sample` | 音色样本 | tts 用的音色 |
| `final-product` | 定稿产物 | 完成的广告片 |

### 工具集

#### `aigc_library_promote`

把画布元素提升为资产：
```
参数:
  element_path: string           # 画布元素 filePath
  category: Category
  title?: string
  tags?: string[]

返回:
  asset_id: string
```

#### `aigc_library_list`

列出资产：
```
参数:
  type?: "image" | "prompt" | "audio" | "video"
  category?: Category
  tags?: string[]                # 标签筛选
  search?: string                # 全文搜索 title + prompt

返回:
  assets: Asset[]
```

#### `aigc_library_get`

获取一个资产的详情 + filePath（用于引用）：
```
参数:
  asset_id: string

返回:
  asset: Asset
```

#### `aigc_library_remove`

删除资产：
```
参数:
  asset_id: string

返回:
  removed: boolean
```

### 用户侧 UI

#### 右键菜单

```
[元素卡片右键]
├── ...
├── 提升到资产库...    → 弹窗
├── ...
```

#### 提升弹窗

```
┌─ 提升到资产库 ──────────────────────────────┐
│                                            │
│ 元素: orange cat (image)                   │
│                                            │
│ 分类:                                      │
│ ○ 风格参考 (style-reference)                │
│ ● 主体参考 (subject-reference)              │
│ ○ 定稿产物 (final-product)                  │
│                                            │
│ 标题: [cyberpunk cat             ]          │
│                                            │
│ 标签: [cyberpunk] [cat] [+]                │
│                                            │
│ [取消]                       [提升]         │
└────────────────────────────────────────────┘
```

#### 设置页"资产库"标签

```
┌─ AIGC 资产库 ─────────────────────────────────────────┐
│                                                      │
│ 筛选: [全部 ▼]  类型: [全部 ▼]  搜索: [___________]  │
│                                                      │
│ ┌──────────────────────────────────────────────────┐ │
│ │ [缩略图]  cyberpunk cat                          │ │
│ │          style-reference                          │ │
│ │          tags: cyberpunk, cat                     │ │
│ │          prompt: a cat in cyberpunk style...      │ │
│ │                              [引用] [编辑] [删除] │ │
│ ├──────────────────────────────────────────────────┤ │
│ │ [缩略图]  male narrator voice                    │ │
│ │          voice-sample                             │ │
│ │                              [引用] [编辑] [删除] │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ [+ 从画布提升]    [导入文件]                         │
└──────────────────────────────────────────────────────┘
```

#### Agent 引用资产

Agent 调 `aigc_library_list` 查资产，调 `aigc_library_get` 拿 filePath，然后在 `aigc_http_request` 的 `$base64` 占位符中引用：
```
"image": {"$base64": "/path/to/library/asset.png"}
```

### 验收标准

- [ ] `aigc_library_promote` 工具可用
- [ ] `aigc_library_list` / `aigc_library_get` / `aigc_library_remove` 工具可用
- [ ] 资产存到 `~/.dsh/aigc-canvas/library/`
- [ ] 资产文件是画布元素的副本（不依赖原会话存在）
- [ ] 右键菜单"提升到资产库"
- [ ] 提升弹窗可选分类 + 标签
- [ ] 设置页"资产库"标签
- [ ] Agent 能在 `aigc_http_request` 中引用资产 filePath
- [ ] 资产库跨会话可用

---

## §7 画布工具栏扩展

### 现状

```
[AIGC 画布] 5 元素 | 4 连线 | 100% [-][滑][+][↻][⤢]
```

### 改进后

```
[AIGC 画布] 5 元素 | 4 连线 | $0.42 | 状态:[✓ready][✓draft][□rejected][□archived] | 100% [-][滑][+][↻][⤢][📊日志]
```

新增：
- **成本显示**：本会话累计 $X.XX
- **状态过滤器**：复选框切换显示哪些状态的元素
- **日志按钮**：打开请求日志面板

### 快捷动作工具栏（左上角）

```
[画布左上角]
┌─────────────────────────────────────────┐
│ [+ 生成]  [✂ 编辑选中]  [▶ 运行工作流]  │
└─────────────────────────────────────────┘
```

- **+ 生成**：打开"快速生成"弹窗（t2i/t2v/tts 任选）
- **✂ 编辑选中**：对选中元素执行 ffmpeg 操作
- **▶ 运行工作流**：打开 pipeline 模板选择器

### 验收标准

- [ ] 画布 header 显示成本
- [ ] 状态过滤器可用
- [ ] 日志按钮入口
- [ ] 左上角快捷动作工具栏
- [ ] "+ 生成"弹窗可触发 t2i/t2v/tts
- [ ] "✂ 编辑选中"对选中元素执行 ffmpeg
- [ ] "▶ 运行工作流"打开模板选择器

---

## §8 实现优先级

| 改进 | 难度 | 优先级 | 备注 |
|------|:---:|:---:|------|
| §3 请求日志面板 | 低 | P0 | 调试刚需 |
| §1 右键菜单扩展（部分） | 低 | P0 | 重新生成 / 发到对话 / 下载 |
| §5 成本追踪（画布 header） | 低 | P0 | 用户感知强 |
| §4 自动重试 | 低 | P1 | 省 provider 成本 |
| §2 对比视图 | 中 | P1 | 依赖方向 A §4 |
| §1 右键菜单（用作参考 + 提升资产库） | 中 | P1 | 依赖 §6 |
| §6 跨会话资产库 | 中 | P2 | 沉淀价值 |
| §4 去重 | 低 | P2 | 锦上添花 |
| §7 画布工具栏扩展 | 低 | P2 | 打磨 |
