# dsh-aigc-canvas

> DSH 插件:provider-agnostic 的 AIGC HTTP 桥 + 自由画布 + ffmpeg 后处理。Agent 通过
> `aigc_http_request` 调用任意 HTTP AIGC API(endpoint + apiKey 自动附加),生成的文件用
> `aigc_canvas_place` 摆到无限画布上,可用 `aigc_media_edit` (ffmpeg) 后处理。

## 安装

```sh
# 从本地 clone 开发安装(开发阶段推荐):
dsh plugin --profile <profile> add link:D:\Projects\deepseek-harness\dsh-aigc-canvas

# 从 git 安装(发布到 dsh-external 组织后):
dsh plugin --profile <profile> add github:huanlinoto/dsh-plugin-aigc-canvas
```

预构建 `lib/` 入库策略(含 `@deepseek-ai/*` private peer deps,必须预构建),`github:` 安装开箱即用,无需 `allowBuilds`。

## 配置

在 `cordis.patch.yml` 或 DSH GUI 中配置:

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `providers` | `AigcProvider[]` | 见下 | 一个或多个 AIGC provider;第一个为默认。运行时可在设置页 CRUD |
| `requestTimeoutMs` | number | `300000` (5 min) | 单次 provider 请求超时(ms) |
| `mediaSizeLimit` | number | `104857600` (100 MiB) | 单个媒体文件大小上限(落盘校验) |

### `AigcProvider` 字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | string | 必填 | provider 标识符(小写字母+数字+连字符,字母开头)。作为 `provider_id` 传给工具 |
| `name` | string | `''` | 显示名(如 "Volcano Engine") |
| `endpoint` | string | `stub://aigc-backend` | API endpoint URL。`stub://aigc-backend` = 内置 stub 后端 |
| `apiKey` | string | `''` | API key(仅内存;通过 GUI 或 cordis.yml 设置) |
| `instructions` | string | `''` | Agent 通过 `aigc_get_provider_info` 读取的调用说明(预览)+ `aigc_provider_get_instructions` 读全量 |
| `auth.scheme` | `'bearer'` \| `'header'` \| `'query'` | `'bearer'` | apiKey 附加方式 |
| `auth.name` | string | `''` | `header` 方式的 header 名(默认 `x-api-key`)或 `query` 方式的参数名(默认 `api_key`) |
| `builtin` | boolean | `false` | 是否是 seed 层内置 provider(仅 cordis.yml 标记) |

## 工具

模型可见的十三个工具,均在调用代理的会话作用域内执行(模型不需要传 `sessionId`):

| 工具 | 用途 |
|------|------|
| `aigc_get_provider_info` | 列出所有 provider(id/name/endpoint/instructions 预览/capabilities/capabilityMap/stub 标志)。**最先调用** |
| `aigc_http_request` | 向 provider API 发 HTTP 请求(endpoint + apiKey 自动附加)。二进制响应落盘返回 `file_path`,JSON/文本内联返回。有 EndpointSpec 时按 spec 处理响应 |
| `aigc_provider_set_instructions` | 探测 API 后记录 provider 的调用说明(每 provider 限 1000 字,旧式自由文本) |
| `aigc_provider_get_instructions` | 拉取一个 provider 的完整 instructions(`aigc_get_provider_info` 只返回前 200 字预览) |
| `aigc_provider_set_endpoints` | 探测 API 后记录结构化 EndpointSpec[] catalog(自动派生 instructions,支持 spec 驱动响应处理) |
| `aigc_get_endpoint_details` | 拉取一个 provider+capability 的完整 EndpointSpec[](path/method/params/response shape) |
| `aigc_probe_endpoint` | 向一个 endpoint 发最小测试请求,自动嗅探响应格式(ResponseKind + path) |
| `aigc_reroll` | 基于已有元素的 `meta.originalRequest` 重新生成(支持 seed/prompt_delta/prompt_replace/size patch,count>1 时生成变体簇) |
| `aigc_canvas_place` | 把文件摆到画布上(可选 x/y,可自动布局;可附 references + relation 自动连边) |
| `aigc_canvas_link` / `aigc_canvas_unlink` | 创建/删除两个元素之间的边(filePath 寻址,relation 必填:input/first_frame/style/variation_of/...) |
| `aigc_canvas_list_elements` | 只读:返回当前会话画布的完整快照(elements + edges with relation) |
| `aigc_media_edit` | ffmpeg 编辑(concat/clip/extract_audio/extract_frame/speed/resize/reverse/add_audio/images_to_video) |

### `aigc_get_provider_info`

列出所有已配置的 provider。返回每个 provider 的 `id`、`name`、`endpoint`、`instructions`(前 200 字预览 + `instructions_total_chars`)、`isStub`、`isDefault`。

参数:无。

### `aigc_http_request`

向 provider API 发送一个 HTTP 请求。provider 的 `endpoint` 和 `apiKey` 自动附加(Agent 永远看不到 apiKey)。`path` 相对 provider endpoint,如 `/v1/images/generations`;同源的绝对 URL 也接受(用于下载 provider 返回的下载链接)。

二进制响应(image/video/audio)落盘到会话 canvas 目录并返回 `file_path`;JSON/文本响应内联返回(过大时落盘并返回预览 + `file_path`)。非 2xx 响应返回 `{ ok: false, status, error, sent_body_preview }`,便于 Agent 自诊断字段丢失/编码 bug。

**`$base64` / `$data_uri` 占位符**:在 `json_body` 或 `body` 内使用 `{"$base64": "<file_path>"}` 或 `{"$data_uri": "<file_path>"}`,host 会读取画布元素文件并替换占位符。`file_path` 必须在会话 canvas 目录内。

参数:`provider_id?`、`method?`、`path`(必填)、`headers?`、`query?`、`json_body?` / `body?`(二选一)。

### `aigc_provider_set_instructions`

记录一个 provider 的调用说明(endpoints、请求格式、参数、响应形状)。每 provider 限 1000 字。Agent 探测 API 后调用此工具持久化,后续会话可直接使用。

参数:`provider_id`(必填)、`instructions`(必填,≤ 1000 字)。

### `aigc_provider_get_instructions`

拉取一个 provider 的**完整** instructions。`aigc_get_provider_info` 只返回前 200 字预览;当需要精确的 endpoint 路径/参数名/响应形状时调用此工具。

参数:`provider_id`(必填)。返回:`{ provider_id, instructions, total_chars }`。

### `aigc_canvas_place`

把文件摆到画布上(`aigc_http_request` 返回的 `file_path`)。文件必须已存在于会话 canvas 目录内。

- `x` / `y` 可省略,**优先省略让 host 自动布局**:有 `references` 时新元素落到最右参考的右侧(垂直居中),否则落到现有最低元素下方的左对齐垂直列
- `references` 是已有元素的 filePath 数组,自动从每个参考向新元素连边
- `description` 是 ≤ 40 字的极简描述(名词/形容词/短语,如 "orange cat"),显示在卡片上

参数:`file_path`(必填)、`description`(必填)、`x?`、`y?`、`title?`、`kind?`、`prompt?`、`meta?`、`references?`。

### `aigc_canvas_link` / `aigc_canvas_unlink`

创建/删除两个元素之间的边(filePath 寻址,source → target)。幂等。

参数:`source`(必填)、`target`(必填)。

### `aigc_canvas_list_elements`

只读:返回当前会话画布的完整快照。每个元素返回 `filePath`(主标识符)、`kind`、`title`、`x`、`y`、`createdAt`、`producedBy`、可选 `promptText`/`mediaSize`/`meta`。每条边返回 `source` filePath → `target` filePath。

参数:无。

### `aigc_media_edit`

通过 ffmpeg 编辑媒体文件。`operation` 选定操作,所有输入文件必须已存在于会话 canvas 目录内,输出落盘并返回 `file_path`。

| 操作 | inputs | output_ext | 关键参数 |
|------|--------|------------|---------|
| `concat` | ≥ 2 视频 | mp4 | — |
| `clip` | 1 视频 | mp4 | `start`/`end` 或 `start`/`duration`(秒) |
| `extract_audio` | 1 视频 | mp3 | — |
| `extract_frame` | 1 视频 | png | `timestamp`(秒) |
| `speed` | 1 视频 | mp4 | `speed`(2 = 2x,0.5 = 半速) |
| `resize` | 1 视频 | mp4 | `width` 和/或 `height`(像素) |
| `reverse` | 1 视频 | mp4 | — |
| `add_audio` | 1 视频 + 1 音频 | mp4 | — |
| `images_to_video` | ≥ 1 图片 | mp4 | `fps`(默认 2) |

**ffmpeg 查找顺序**:
1. `AIGC_FFMPEG_PATH` 环境变量(显式覆盖,适用于非标准安装路径)
2. `ffmpeg` on PATH(macOS/Linux 和大多数 Windows 的正常情况)
3. 平台特定常见安装位置:
   - **Windows**:`C:\ffmpeg\bin\ffmpeg.exe`、`C:\Program Files\ffmpeg\bin\ffmpeg.exe`、`C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe`、`${CONDA_PREFIX}\Scripts\ffmpeg.exe`
   - **macOS/Linux**:`/usr/bin/ffmpeg`、`/usr/local/bin/ffmpeg`、`/opt/homebrew/bin/ffmpeg`

找不到时抛 `backend-error`,错误信息指引安装方式。

## 画布视图

通过 better-sidebar 的服务消费(`ctx.betterSidebar.registerTab`)注册一个 `aigc-canvas:main` tab。tab 是单实例(每个会话一个),打开后:

- 通过 WebSocket `/aigc-canvas/ws/canvas?sessionId=...` 订阅 host 端的画布变更推送
- 首次加载会先 HTTP `POST /aigc-canvas/api/canvas.list` priming 一次快照
- 节点按 vertical flow 排列,每个节点的入边在节点上方以 chip 形式显示
- 不同 kind 用左侧色条区分:prompt 蓝 / image 绿 / video 橙 / audio 紫
- 边按 relation 分线型:实线=直接输入(input/first_frame/last_frame/audio_track),虚线=参考(reference/style/mask),点线=变体(variation_of/remix_of/alternative_of),粗实线=编辑链(edited_from)。曲线中点显示关系标签
- WS 断开后自动重连
- **请求日志面板**:header 上的 📊 按钮打开浮层,显示本会话所有 `aigc_http_request` + `aigc_media_edit` 调用(时间/provider/path/状态/耗时/大小),点条目展开详情(请求头 + 请求体 + 响应预览,apiKey 已脱敏),可"在画布上定位"产物元素

> better-sidebar 未安装时,host 半的工具 + 元素表仍然正常工作,只是没有 UI 可视化(未来的 host-side 消费者可以通过 `ctx.aigcCanvas` 服务读取状态)。

## 存储

每个会话的画布状态(元素表 + 边)持久化到:

```
<cwd>/.dsh-aigc-canvas/<sessionId>/canvas.json
```

媒体文件落到同目录:

```
<cwd>/.dsh-aigc-canvas/<sessionId>/<uuid>.<ext>
```

provider 列表持久化到 `~/.dsh/aigc-canvas/providers.json`(用户运行时 CRUD 后保留)。

刷新浏览器 / 重启 DSH 后,会话画布从 `canvas.json` 重新水合,媒体文件保留在原位;provider 列表从 `providers.json` 重新加载。

## 开发

```sh
pnpm install          # 安装开发依赖(schemastery、typescript、vitest、tsdown)
pnpm run typecheck    # tsc --noEmit 类型检查
pnpm test             # vitest run 单元测试(canvas-registry / tools / wire / provider-store)
pnpm run build        # tsdown 构建 → lib/index.js + lib/invariant.js + lib/client.js + tsc -p tsconfig.build.json
pnpm watch            # tsdown --watch(client bundle 热重建)
```

构建产物:
- `lib/index.js` — host 入口(cordis 插件,提供 `ctx.aigcCanvas` 服务 + 路由 + 工具)
- `lib/invariant.js` — 包级 invariant 伴生
- `lib/client.js` — 浏览器 bundle(`window.__ModuleLoader__.load` 闭包工厂,id = `@huanlin/dsh-plugin-aigc-canvas`)
- `lib/index.d.ts` 等 — TypeScript 声明(由 `tsc -p tsconfig.build.json` 产出)

## 目录结构

```
dsh-aigc-canvas/
├── src/
│   ├── index.ts              # host 入口:apply + /aigc-canvas/api + /aigc-canvas/file + WS
│   ├── config.ts             # Schemastery Config schema + resolveAigcConfig
│   ├── context-types.ts      # cordis Context augmentation(结构化镜像)
│   ├── invariant.ts          # 包级 invariant 伴生
│   ├── wire.ts               # HTTP helpers + AigcError
│   ├── trust-fence.ts        # Host 头信任围栏(从 better-sidebar 拷贝)
│   ├── canvas-registry.ts    # 元素表 + 边 + 持久化(host-owned state)
│   ├── provider-http.ts      # 抽象 provider HTTP 客户端(stub + 真实 fetch)
│   ├── provider-store.ts     # ProviderStore(CRUD + 持久化到 ~/.dsh/aigc-canvas/providers.json)
│   ├── media-edit.ts         # ffmpeg 编辑引擎
│   ├── tools.ts              # 9 个 defineTool
│   ├── types.d.ts            # @deepseek-ai/dsh-tools + cordis 环境类型声明
│   └── client/
│       ├── index.tsx         # client 入口:注册 better-sidebar tab
│       ├── CanvasView.tsx    # 画布主视图
│       ├── CanvasNode.tsx    # 节点组件
│       ├── SettingsPage.tsx  # provider 设置页
│       ├── store.ts          # CanvasStore(WS 订阅 + useSyncExternalStore)
│       ├── api.ts            # HTTP/WS 客户端
│       ├── locales.ts        # i18n(zh/en)
│       └── canvas.module.css # 画布样式
├── tests/
│   ├── canvas-registry.spec.ts
│   ├── provider-store.spec.ts
│   ├── tools.spec.ts
│   └── wire.spec.ts
├── cordis.patch.yml          # bundle 层:插入插件行
├── package.json              # dsh.bundle.patch + peerDeps + 预构建 lib/
├── tsconfig.json             # NodeNext + ES2022 + strict
├── tsconfig.prepare.json     # 消费端自包含构建
├── tsdown.config.ts          # dev/CI 构建(host + client 双 bundle)
├── tsdown.prepare.config.ts  # 消费端 prepare 构建
├── vitest.config.ts
└── README.md
```

## 安全边界

- 路由受 Host 头信任围栏保护(与 `/api` 一致;`0.0.0.0` 部署时由 `dsh web` 启动器动态派生的 LAN IP 列表生效)
- `/aigc-canvas/file` 仅限会话 canvas 目录内的媒体文件
- `/aigc-canvas/api/*` JSON API 受同一 Host 头信任围栏保护
- 工具执行绑定到调用代理的会话 id(`exec.agent.session.id`),模型不能跨会话读取 / 引用其他会话的元素
- `aigc_http_request` 的 `path` 相对 provider endpoint;绝对 URL 仅限同源(防 SSRF)
- `$base64` / `$data_uri` 占位符的 `file_path` 必须在会话 canvas 目录内
- provider apiKey 永不出现在工具输出中;`aigc_http_request` 内部附加 auth header/param

## 规范符合性

按 DSH 官方插件规范组织(参考 [dsh-external/turtle-ui](https://github.com/dsh-external/turtle-ui) 与 `plugin-development-guide.md`):

- **插件形态**: `export const name / inject / Config / apply`,无 default 导出
- **清单**: `types` + `exports`(`.` / `./invariant` / `./client` / `./client/service` / `./package.json`)、`dsh.bundle.patch`、`peerDependencies`、`engines`、`files` 产物明细、`prepare`(消费者侧 `tsdown`,git 安装可用)
- **client 契约**: 仅导出 `apply`/`inject`(+ 类型);store 为 `CanvasStore` 工厂,实例归 `apply` 所有;`src/invariant.ts` 伴生;client bundle 复刻官方 preset(externals = 平台模块表 + runtime/client 豁免、纯度门、CSS Modules 内联)
- **预构建 `lib/` 入库**: 含 `@deepseek-ai/*` private peer,必须预构建;`lib/` 不进 `.gitignore`;`github:` 安装开箱即用
- **零源码 patch**: 未修改 DSH checkout 任何文件
