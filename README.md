本项目已被dshfind.com收录

# dsh-aigc-canvas

[![npm version](https://img.shields.io/npm/v/@huanlin/dsh-plugin-aigc-canvas)](https://www.npmjs.com/package/@huanlin/dsh-plugin-aigc-canvas)

> DSH 插件:一个节点-连线式的 AIGC 画布。向模型暴露文生图 / 文生视频 / 首尾帧生视频 / 多参考生视频 / 音频生成五类工具,生成的图片 / 视频 / 音频以及提示词都作为画布元素(uuid 寻址)存在,生成完成后自动按多对一(promise + 所有参考元素 → 输出)在画布上连线。

## 安装

```sh
# 从 npm 安装(推荐):
dsh plugin --profile web add @huanlin/dsh-plugin-aigc-canvas

# 从本地 clone 开发安装(开发阶段):
dsh plugin --profile web add link:D:\Projects\deepseek-harness\dsh-aigc-canvas
```

预构建 `lib/` 入库策略(含 `@deepseek-ai/*` private peer deps,必须预构建),npm 安装开箱即用,无需 `allowBuilds`。

## 配置

在 `cordis.patch.yml` 或 DSH GUI 中配置:

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `baseURL` | string | `stub://aigc-backend` | AIGC 后端 API 地址。`stub://aigc-backend` = 内置 stub 后端(无网络,合成 PNG/MP4/MP3 字节)。其他值会触发 `backend-error` 等待未来实现 |
| `apiKeyEnv` | credential-ref | `AIGC_API_KEY` | API key 的环境变量名 / 凭据引用。stub 后端不读 |
| `requestTimeoutMs` | number | `60000` | 单次后端请求超时(ms) |
| `mediaSizeLimit` | number | `104857600` (100 MiB) | 单个媒体文件大小上限(媒体路由校验) |

## 工具

模型可见的六个工具,均在调用代理的会话作用域内执行(模型不需要传 `sessionId`):

### `aigc_text_to_image`

文生图。把 prompt 也作为 prompt 元素存入画布,生成图片作为 image 元素,自动连线 prompt → image。

参数:`prompt`(必填)、`negative_prompt`、`width`(默认 1024)、`height`(默认 1024)、`seed`。

### `aigc_text_to_video`

文生视频。同上,prompt 元素 → video 元素。

参数:`prompt`(必填)、`negative_prompt`、`width`(默认 1280)、`height`(默认 720)、`duration_seconds`(默认 5)、`seed`。

### `aigc_first_last_frame_to_video`

首尾帧 + 文生视频。`first_frame_uuid` / `last_frame_uuid` 必须是已存在的 image 元素 uuid(由 `aigc_text_to_image` 返回)。prompt 元素 + 两个 image 元素都 → video 元素(三条边)。

参数:`prompt`(必填)、`first_frame_uuid`(必填)、`last_frame_uuid`(必填)、`width`、`height`、`duration_seconds`、`seed`。

### `aigc_multi_reference_to_video`

多参考生视频。`reference_uuids` 是 image / video / audio 元素的 uuid 数组(至少一个)。prompt 元素 + 所有参考元素都 → video 元素。

参数:`prompt`(必填)、`reference_uuids`(必填,非空数组)、`width`、`height`、`duration_seconds`、`seed`。

### `aigc_generate_audio`

文本生成音频。prompt 元素 → audio 元素。

参数:`prompt`(必填)、`duration_seconds`(默认 10)、`seed`。

### `aigc_canvas_list_elements`

只读:返回当前会话画布的完整快照(elements + edges)。用于长工具序列后恢复状态、查找要传给后续调用的 uuid。

参数:无。

## 画布视图

通过 better-sidebar 的服务消费(`ctx.betterSidebar.registerTab`)注册一个 `aigc-canvas:main` tab。tab 是单实例(每个会话一个),打开后:

- 通过 WebSocket `/aigc-canvas/ws/canvas?sessionId=...` 订阅 host 端的画布变更推送
- 首次加载会先 HTTP `POST /aigc-canvas/api/canvas.list` priming 一次快照
- 节点按 vertical flow 排列,每个节点的入边在节点上方以 chip 形式显示(短 uuid)
- 不同 kind 用左侧色条区分:prompt 蓝 / image 绿 / video 橙 / audio 紫
- WS 断开后 2 秒自动重连

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

扩展名按 kind 决定:`prompt` → `.txt`(实际上 prompt 元素不写文件,只在 JSON 中存 `promptText`)、`image` → `.png`、`video` → `.mp4`、`audio` → `.mp3`。

刷新浏览器 / 重启 DSH 后,会话画布从 `canvas.json` 重新水合,媒体文件保留在原位。

## 开发

```sh
pnpm install          # 安装开发依赖(schemastery、typescript、vitest、tsdown)
pnpm run typecheck    # tsc --noEmit 类型检查
pnpm test             # vitest run 单元测试(canvas-registry / tools / wire)
pnpm run build        # tsdown 构建 → lib/index.js + lib/invariant.js + lib/client.js
pnpm watch            # tsdown --watch(client bundle 热重建)
```

构建产物:
- `lib/index.js` — host 入口(cordis 插件,提供 `ctx.aigcCanvas` 服务 + 路由 + 工具)
- `lib/invariant.js` — 包级 invariant 伴生
- `lib/client.js` — 浏览器 bundle(`window.__ModuleLoader__.load` 闭包工厂,id = `@dsh-external/dsh-aigc-canvas`)
- `lib/index.d.ts` 等 — TypeScript 声明(由 `tsc -p tsconfig.json` 产出,不在 tsdown 流程内)

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
│   ├── aigc-backend.ts       # 抽象 AIGC 后端客户端(stub 实现)
│   ├── tools.ts              # 6 个 defineTool
│   ├── types.d.ts            # @deepseek-ai/dsh-tools + cordis 环境类型声明
│   └── client/
│       ├── index.tsx         # client 入口:注册 better-sidebar tab
│       ├── CanvasView.tsx    # 画布主视图
│       ├── CanvasNode.tsx    # 节点组件
│       ├── store.ts          # CanvasStore(WS 订阅 + useSyncExternalStore)
│       ├── api.ts            # HTTP/WS 客户端
│       ├── locales.ts        # i18n(zh/en)
│       └── canvas.module.css # 画布样式
├── tests/
│   ├── canvas-registry.spec.ts
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

## 后端实现路线(stub → 真实)

当前 `aigc-backend.ts` 的 stub 在 `baseURL === 'stub://aigc-backend'`(或为空)时返回合成字节;其他 `baseURL` 立即抛 `backend-error`(HTTP 501)。

要接入真实后端:

1. 在 `aigc-backend.ts` 的每个 `generate*` 方法的 `!this.isStub` 分支里替换为真实 `fetch` 调用(参考 dsh-mineru 的 `MinerUClient`)。
2. 后端 API 形状建议保持 `{ prompt, ..., signal } → { mediaBytes, meta }` 的统一契约,这样 `tools.ts` 不需要改动。
3. 工具的参数 schema 已包含 `width / height / duration_seconds / seed` 等通用字段,后端可以选择性消费。
4. 媒体格式: stub 用最小合法 PNG / ftyp-only MP4;真实后端返回的字节由 host 直接落盘 + 浏览器渲染,不需要转码。

## 安全边界

- 路由受 Host 头信任围栏保护(与 `/api` 一致;`0.0.0.0` 部署时由 `dsh web` 启动器动态派生的 LAN IP 列表生效)
- `/aigc-canvas/file` 仅限会话 canvas 目录内的媒体文件
- 工具执行绑定到调用代理的会话 id(`exec.agent.session.id`),模型不能跨会话读取 / 引用其他会话的元素
- `apiKeyEnv` 通过 `ctx.get('credentials')` 懒解析,先于 `process.env`

## 已知限制(v0.1 阶段)

- 后端 stub,无真实 AIGC 调用
- 画布视图是垂直 flow,不是真正的图布局(force-directed / DAG 布局待后续)
- 边以 chip 形式标注在节点上方,没有 SVG 连线(避免引入 react-flow 等运行时依赖)
- 元素不支持删除 / 编辑(只能通过删除 `canvas.json` + 重启会话来重置画布)

## 规范符合性

按 DSH 官方插件规范组织(参考 [dsh-external/turtle-ui](https://github.com/dsh-external/turtle-ui) 与 `plugin-development-guide.md`):

- **插件形态**: `export const name / inject / Config / apply`,无 default 导出
- **清单**: `types` + `exports`(`.` / `./invariant` / `./client` / `./client/service` / `./package.json`)、`dsh.bundle.patch`、`peerDependencies`、`engines`、`files` 产物明细、`prepare`(消费者侧 `tsdown`,git 安装可用)
- **client 契约**: 仅导出 `apply`/`inject`(+ 类型);store 为 `CanvasStore` 工厂,实例归 `apply` 所有;`src/invariant.ts` 伴生;client bundle 复刻官方 preset(externals = 平台模块表 + runtime/client 豁免、纯度门、CSS Modules 内联)
- **预构建 `lib/` 入库**: 含 `@deepseek-ai/*` private peer,必须预构建;`lib/` 不进 `.gitignore`;`github:` 安装开箱即用
- **零源码 patch**: 未修改 DSH checkout 任何文件
