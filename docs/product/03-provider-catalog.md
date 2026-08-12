# Provider 知识结构化改进详案

> 你已接入多个真实 provider，这一方向必做。
> 把 `instructions: string` 升级为结构化能力表，让 Agent 不用解析自然语言。

---

## §0 问题陈述

当前 provider 配置只有 `instructions: string` 单字段（且硬限 200 字），导致：

1. **装不下**：一个有 t2i/t2v/tts/edit 的 provider 至少需要 4 个 endpoint 的说明，200 字只能写"POST /v1/images {prompt} -> b64"这种失真级别
2. **无结构**：Agent 必须解析自然语言才能知道"这个 provider 支不支持 t2v"。每次会话开始浪费一轮工具调用 + 模型推理
3. **无能力声明**：没有"这个 provider 的 t2i 最大支持 1792×1024"这种约束信息，Agent 可能传非法尺寸
4. **无示例响应**：Agent 探测后只存字符串，下次会话还得"试探性调用"确认响应格式
5. **无选择策略**：多 provider 同 capability 时，Agent 没有依据选哪个

---

## §1 Endpoint Catalog 概念

### 升级前（现状）

```
provider:
  id: volcano
  endpoint: https://ark.cn-beijing.volces.com
  apiKey: sk-...
  instructions: "POST /v1/images {prompt,size} -> b64; POST /v1/videos {prompt,duration} -> mp4 url"
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  一行字符串塞两个 endpoint，超 200 字就废
```

### 升级后

```
provider:
  id: volcano
  endpoint: https://ark.cn-beijing.volces.com
  apiKey: sk-...
  
  endpoints:                       # 结构化能力表
    - path: /v1/images/generations
      method: POST
      capability: t2i
      params:
        - name: prompt
          type: string
          required: true
        - name: size
          type: string
          default: "1024x1024"
          enum: ["1024x1024", "1792x1024", "1024x1792"]
      response:
        kind: b64_json_array
        path: "data[0].b64_json"
      acceptsCanvasRef: true       # 支持 $base64 占位符
    
    - path: /v1/videos/generations
      method: POST
      capability: t2v
      params:
        - name: prompt
          type: string
          required: true
        - name: duration
          type: integer
          default: 5
          max: 10
      response:
        kind: url_field
        path: "data[0].url"
        # url_field 需要二次 GET 下载，host 自动处理
  
  priority: 10                     # 选择优先级（小=优先）
  costPerCall: 0.02                # 成本追踪用
  qualityHint: balanced            # fast / balanced / quality
```

---

## §2 数据结构

### EndpointSpec（一个 endpoint 的完整描述）

```
EndpointSpec:
  path: string                     # "/v1/images/generations"
  method: "GET" | "POST" | "PUT" | "PATCH"
  capability: Capability           # 见下表
  params: ParamSpec[]              # 参数 schema
  response: ResponseSpec           # 响应格式声明
  acceptsCanvasRef?: boolean       # 是否支持 $base64 占位符
  notes?: string                   # 简短补充（如"size 必须是 1024x1024 或 1792x1024"）
```

### Capability 枚举

| Capability | 含义 | 典型 endpoint |
|------------|------|--------------|
| `t2i` | 文生图 | `/v1/images/generations` |
| `i2i` | 图生图（风格迁移、编辑） | `/v1/images/edits` |
| `t2v` | 文生视频 | `/v1/videos/generations` |
| `i2v` | 图生视频 | `/v1/videos/generations` (with image param) |
| `fl2v` | 首尾帧生视频 | `/v1/videos/generations` (with first_frame + last_frame) |
| `ref2v` | 多参考生视频 | `/v1/videos/generations` (with references array) |
| `tts` | 文本转语音 | `/v1/audio/speech` |
| `music` | 文生音乐 | `/v1/music/generations` |
| `transcribe` | 音频转文字 | `/v1/audio/transcriptions` |
| `edit` | 媒体编辑（provider 侧） | `/v1/edits` |
| `chat` | 多模态对话（自评用） | `/v1/chat/completions` |

### ParamSpec（一个参数的描述）

```
ParamSpec:
  name: string
  type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "image_ref" | "video_ref" | "audio_ref"
  required: boolean
  default?: unknown
  enum?: unknown[]
  min?: number
  max?: number
  description?: string
```

`image_ref` / `video_ref` / `audio_ref` 类型：表示这个参数接受画布元素的 filePath，host 自动展开为 `$base64` 或 `$data_uri`。

### ResponseSpec（响应格式声明）

```
ResponseSpec:
  kind: "b64_json_array"           # OpenAI: {data:[{b64_json}]}
       | "b64_json_field"          # {result:{image:"base64..."}}
       | "binary"                  # 直接 image/png 字节流
       | "url_field"               # {data:[{url}]} 需二次 GET
       | "json_text"               # 纯 JSON 文本响应
  path?: string                    # 当 kind 是 *_field / *_array 时，指出字段路径
```

**kind 决定 host 如何处理响应**：
- `b64_json_array` / `b64_json_field`：自动解码 base64 落盘
- `binary`：直接落盘
- `url_field`：自动二次 GET 下载（带 provider auth）
- `json_text`：返回给 Agent 内联

---

## §3 工具变化

### `aigc_get_provider_info` 升级

升级前（现状）：
```
返回: {
  providers: [{ id, name, endpoint, instructions, isStub, isDefault }]
}
```

升级后（默认精简视图）：
```
返回: {
  providers: [{
    id, name, endpoint,
    isStub, isDefault,
    capabilities: ["t2i", "t2v", "tts"],   # 派生自 endpoints
    priority: 10,
    qualityHint: "balanced",
    costPerCall: 0.02,
    endpointCount: 3,
    instructions: "..."                    # 旧字段保留，向后兼容
  }]
}
```

Agent 一眼看出每个 provider 支持哪些能力、谁是首选。

### 新工具 `aigc_get_endpoint_details`

按需拉某个 provider 的某个 capability 的详细 spec：

```
参数:
  provider_id: string
  capability: Capability

返回:
  endpoints: EndpointSpec[]     # 该 provider 该 capability 的所有 endpoint
```

避免 `aigc_get_provider_info` 输出膨胀。

### `aigc_provider_set_instructions` → `aigc_provider_set_endpoints`

升级前：Agent 写一段自然语言存到 `instructions`。

升级后：Agent 探测后填结构化 catalog：
```
参数:
  provider_id: string
  endpoints: EndpointSpec[]

返回:
  ok: boolean
  provider_id: string
```

旧 `instructions` 字段保留做向后兼容，新工具同时更新两者（从 endpoints 自动生成一个简短描述）。

### 新工具 `aigc_probe_endpoint`（半自动探测）

帮 Agent 探测未知 endpoint 的响应格式：

```
参数:
  provider_id: string
  path: string                  # 要探测的 endpoint
  method: "GET" | "POST" = "POST"
  test_body?: object            # 最小测试请求

返回:
  detected:
    responseKind: "b64_json_array" | "binary" | "url_field" | "json_text"
    responsePath?: string       # 自动嗅探出的字段路径
    sampleField?: string        # 示例字段名
  raw:
    status: number
    contentType: string
    bodyPreview: string         # 响应前 500 字符
```

Agent 用这个工具半自动生成 EndpointSpec，不用人工猜响应格式。

---

## §4 Provider 选择策略

### 多 provider 同 capability 时的选择

provider 配置加可选字段：
```
provider:
  priority: 10                   # 数字越小优先级越高（默认 100）
  costPerCall?: 0.02             # 单次调用成本（美元）
  avgLatencyMs?: 3400            # 平均延迟（host 自动统计）
  qualityHint?: "fast" | "balanced" | "quality"
```

### `aigc_get_provider_info` 的输出排序

返回时按 capability 分组 + 按 priority 排序：

```
{
  providers: [...],
  capabilityMap: {
    "t2i": [
      { providerId: "volcano", priority: 10, qualityHint: "balanced" },
      { providerId: "jimeng", priority: 20, qualityHint: "quality" }
    ],
    "t2v": [
      { providerId: "minimax", priority: 10 }
    ],
    "tts": [
      { providerId: "openai", priority: 10, qualityHint: "quality" }
    ]
  }
}
```

Agent 看到 "t2i 首选 volcano、备选 jimeng"，决策不用解析自然语言。

### Agent 选择 Provider 的决策树

```
用户要 t2i
  → 看 capabilityMap.t2i[0] = volcano
  → volcano 限流了？看 [1] = jimeng
  → 用户要"高质量"？筛选 qualityHint="quality" 的
  → 用户要"快"？筛选 qualityHint="fast" 的
```

---

## §5 用户侧 UI

### 设置页 Provider 卡片升级

升级前：
```
┌─ Provider: volcano ─────────────────────────┐
│ ID: volcano              [内置] [真实 API]  │
│ Endpoint: https://ark.cn-beijing.volces.com │
│ API Key: sk-***                             │
│ Auth: Bearer                                │
│ Instructions:                               │
│ ┌────────────────────────────────────────┐ │
│ │ POST /v1/images {prompt,size} -> b64   │ │
│ │ POST /v1/videos {prompt,duration} ...  │ │
│ └────────────────────────────────────────┘ │
│ [初始化]  [保存]  [删除]                    │
└────────────────────────────────────────────┘
```

升级后：
```
┌─ Provider: volcano ─────────────────────────┐
│ ID: volcano              [内置] [真实 API]  │
│ Name: 火山引擎                              │
│ Endpoint: https://ark.cn-beijing.volces.com │
│ API Key: sk-***                             │
│ Auth: Bearer                                │
│                                            │
│ 优先级: [10]  质量: [balanced ▼]  成本: $0.02│
│                                            │
│ Endpoints (3):                              │
│ ┌────────────────────────────────────────┐ │
│ │ POST /v1/images/generations   [t2i]    │ │
│ │   params: prompt*, size               │ │
│ │   response: b64_json_array             │ │
│ │                    [查看] [编辑] [删除]│ │
│ ├────────────────────────────────────────┤ │
│ │ POST /v1/videos/generations   [t2v]    │ │
│ │   params: prompt*, duration            │ │
│ │   response: url_field                  │ │
│ │                    [查看] [编辑] [删除]│ │
│ ├────────────────────────────────────────┤ │
│ │ POST /v1/audio/speech         [tts]    │ │
│ │   params: text*, voice                 │ │
│ │   response: binary                     │ │
│ │                    [查看] [编辑] [删除]│ │
│ └────────────────────────────────────────┘ │
│ [+ 添加 endpoint]    [自动探测]            │
│                                            │
│ 旧版 Instructions（向后兼容）:              │
│ ┌────────────────────────────────────────┐ │
│ │ (从 endpoints 自动生成)                │ │
│ └────────────────────────────────────────┘ │
│                                            │
│ [初始化]  [保存]  [删除]                    │
└────────────────────────────────────────────┘
```

### Endpoint 编辑器

点"添加 endpoint"或"编辑"展开：

```
┌─ 编辑 Endpoint ────────────────────────────┐
│                                            │
│ Path: [/v1/images/generations           ]  │
│ Method: [POST ▼]                           │
│ Capability: [t2i ▼]                        │
│ 支持 $base64 占位符: [✓]                   │
│                                            │
│ 参数:                                      │
│ ┌────────────────────────────────────────┐│
│ │ name        type      required  default││
│ │ prompt      string    ✓                 ││
│ │ size        string             1024x1024││
│ │ seed        integer                      ││
│ └────────────────────────────────────────┘│
│ [+ 添加参数]                               │
│                                            │
│ 响应格式:                                  │
│ Kind: [b64_json_array ▼]                   │
│ Path: [data[0].b64_json           ]        │
│                                            │
│ 备注:                                      │
│ ┌────────────────────────────────────────┐│
│ │ size 必须是 1024x1024 或 1792x1024     ││
│ └────────────────────────────────────────┘│
│                                            │
│ [自动探测响应格式]                          │
│                                            │
│ [取消]                        [保存]       │
└────────────────────────────────────────────┘
```

### "自动探测"按钮

点"自动探测"或"自动探测响应格式"：

```
┌─ 自动探测 ─────────────────────────────────┐
│                                            │
│ 将发送一个最小测试请求到:                   │
│ POST https://...endpoint.../v1/images/...  │
│                                            │
│ 测试请求 body:                             │
│ ┌────────────────────────────────────────┐│
│ │ { "prompt": "test", "size": "1024..." }││
│ └────────────────────────────────────────┘│
│                                            │
│ 这会消耗一次 API 调用（约 $0.02）。         │
│                                            │
│ [取消]                       [开始探测]    │
└────────────────────────────────────────────┘
```

探测完成自动填充 response.kind + path，用户确认后保存。

---

## §6 用户故事

### 故事 1：第一次接入新 provider

**作为用户**，我在设置页添加了"火山引擎"provider，填好 endpoint + apiKey。

**Agent**（用户点"初始化"）：
1. 调 `aigc_get_provider_info` 看配置（此时 endpoints 为空）
2. 调 `aigc_probe_endpoint` 探测 `/v1/images/generations`：
   - 发测试请求 `{"prompt":"test","size":"1024x1024"}`
   - 响应是 `{data:[{b64_json:"..."}]}` → detected.responseKind = `b64_json_array`, responsePath = `data[0].b64_json`
3. 同理探测 `/v1/videos/generations`、`/v1/audio/speech`
4. 调 `aigc_provider_set_endpoints` 保存完整 catalog
5. 下次会话直接用，不用再探测

### 故事 2：多 provider 选择

**作为用户**，我配置了 volcano（t2i + t2v）和 jimeng（t2i）两个 provider。

**Agent** 收到"生成一张猫的图"时：
1. 调 `aigc_get_provider_info` 看到 capabilityMap：
   ```
   t2i: [{providerId: "volcano", priority: 10}, {providerId: "jimeng", priority: 20}]
   ```
2. 选 volcano（priority 更高）
3. 调 `aigc_get_endpoint_details("volcano", "t2i")` 拿到详细 spec
4. 按 spec 构造请求（size 用 default、prompt 必填）
5. 知道响应是 `b64_json_array`，自动解码落盘

### 故事 3：质量优先

**作为用户**，我说"给我一张高质量的猫"。

**Agent**：
1. 看 capabilityMap.t2i，筛选 `qualityHint == "quality"` 的 provider → jimeng
2. 用 jimeng 调用

### 故事 4：成本控制

**作为用户**，我说"用最便宜的方式生成一张图"。

**Agent**：
1. 看 capabilityMap.t2i，按 `costPerCall` 排序
2. 选最便宜的 provider

---

## §7 验收标准

### 数据结构

- [ ] `AigcProvider` 加 `endpoints: EndpointSpec[]` 字段（与 `instructions` 并存）
- [ ] `AigcProvider` 加 `priority`、`costPerCall`、`avgLatencyMs`、`qualityHint` 可选字段
- [ ] 旧 provider JSON 加载时无 endpoints 默认为空数组

### 工具

- [ ] `aigc_get_provider_info` 返回精简视图（含 capabilities + capabilityMap）
- [ ] `aigc_get_endpoint_details` 工具可用
- [ ] `aigc_provider_set_endpoints` 工具可用（替代 `aigc_provider_set_instructions`）
- [ ] `aigc_probe_endpoint` 工具可用
- [ ] 旧 `instructions` 字段保留，从 endpoints 自动生成

### Provider 选择

- [ ] 多 provider 同 capability 时按 priority 排序
- [ ] `aigc_get_provider_info` 返回 capabilityMap
- [ ] Agent 能筛选 qualityHint / costPerCall

### UI

- [ ] 设置页 Provider 卡片显示 endpoints 列表
- [ ] Endpoint 编辑器可用
- [ ] "自动探测"按钮可触发 `aigc_probe_endpoint`
- [ ] 探测结果自动填充 response.kind + path
- [ ] 优先级 / 质量 / 成本字段可编辑

### 向后兼容

- [ ] 旧 `instructions` 字段保留
- [ ] 旧 provider JSON 加载时 endpoints 为空，Agent 用 instructions 兜底
- [ ] `aigc_provider_set_endpoints` 同时更新 instructions（自动生成简短描述）

---

## §8 内置 Provider 模板

插件预置几个常见 provider 的 catalog 模板，用户填 apiKey 即可：

| 模板 | Provider | Capabilities |
|------|----------|-------------|
| `openai` | api.openai.com | t2i, tts, transcribe, chat |
| `volcano` | ark.cn-beijing.volces.com | t2i, t2v, tts |
| `jimeng` | visual.volcengineapi.com | t2i, i2i, t2v |
| `minimax` | api.minimax.chat | t2i, t2v, tts, music |

设置页"添加 provider"时可选"从模板创建"：

```
┌─ 添加 Provider ────────────────────────────┐
│                                            │
│ ○ 从模板创建                                │
│   [openai ▼]  ← 选模板                     │
│   API Key: [_______________]               │
│                                            │
│ ○ 自定义                                    │
│   ID: [____]                               │
│   Endpoint: [_______________]              │
│                                            │
│ [取消]                       [创建]         │
└────────────────────────────────────────────┘
```

---

## §9 实现要点

### host 端

- `provider-store.ts` 加载时合并 `instructions` + `endpoints`，endpoints 优先
- `aigc_http_request` 内部：
  1. 检查 provider 是否有该 path 的 EndpointSpec
  2. 有 → 用 spec.response.kind 决定如何处理响应（替换现有的 OpenAI 硬编码嗅探）
  3. 无 → 退回当前的自动嗅探逻辑
- `aigc_probe_endpoint` 复用 `executeProviderRequest`，加响应格式分析

### 响应处理升级

现状的 `extractOpenAIB64Image` 硬编码 OpenAI 格式。升级后：
- EndpointSpec.response.kind = `b64_json_array` + path = `data[0].b64_json` → 用通用路径提取器
- 路径语法：`data[0].b64_json`、`result.image`、`choices[0].message.content` 等
- 实现 `extractByPath(body: unknown, path: string): unknown`

### 客户端

- `SettingsPage.tsx` 加 endpoints 编辑器组件
- 新组件 `EndpointEditor.tsx`：单个 endpoint 的 CRUD
- 新组件 `ParamEditor.tsx`：参数列表的 CRUD
- "自动探测"按钮调 `aigc_probe_endpoint` API

### 持久化

- Provider JSON 加 `endpoints` 字段
- 旧文件加载时 endpoints = []，instructions 仍可用
- `aigc_provider_set_endpoints` 同时更新两个字段

---

## §10 优先级

| 改进 | 难度 | 优先级 | 备注 |
|------|:---:|:---:|------|
| §1-2 EndpointSpec 数据结构 | 中 | P0 | 基础 |
| §3 `aigc_get_endpoint_details` 工具 | 低 | P0 | 按需拉详情 |
| §3 `aigc_provider_set_endpoints` 工具 | 中 | P0 | 替代旧工具 |
| §4 Provider 选择策略（priority + capabilityMap） | 低 | P0 | 多 provider 必做 |
| §5 设置页 endpoints 编辑器 | 中 | P1 | UI 改造大 |
| §3 `aigc_probe_endpoint` 半自动探测 | 中 | P1 | Agent 自助 |
| §8 内置 provider 模板 | 低 | P2 | 锦上添花 |
