# 设置页挂载面迁移：settings.section → plugins.row.config（dsh-plugin-aigc-canvas）

- 日期：2026-09-25
- 背景：dsh 0.1.7-rc.1 起 `settings.plugin.item` / `settings.section` 共享设置面退役，第三方插件的共享配置入口统一为 Plugins 页的 `plugins.row.config`（ui-plugin-manager 声明的 keyed slot，key = `<包名>#<行id>`，行 id 取 bundle patch insert 行声明的 `id` 原样透传）。昨日（2026-09-24，见 `2026-09-24-settings-channel-0.1.7.md`）已完成数据层迁移（volatile Config + configForms 绑定 + hooks face），本次只换 UI 挂载面，数据层与持久化语义零改动。
- 范本：`dsh-plugin-preface-context/src/client/index.ts`（whileServed gating + key 常量派生）、`yet-another-subagent/src/client/index.ts`（key `@huanlin/dsh-plugin-yet-another-subagent#ya-subagent`）。

## 变更

| 文件 | 变更 |
|---|---|
| `src/entry-identity.ts`（新） | 零依赖的身份三元组：`ENTRY_ID`（= patch 行 id / settings namespace）、`PACKAGE_NAME`、`ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}```；独立成模块以便单测钉死（key 写错 = 静默无入口，见 dsh-interpreters 事故） |
| `src/client/index.tsx` | 移除 `settings.section` 注册（id/order/label 全删），改为 `ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', function* () { yield ctx.slots.register({ name, key: ROW_CONFIG_KEY, locale, inject }, SettingsPage) })))`；行不被 serve 时撤回贡献（行禁用 → Plugins 页该行 configure 控件消失）。数据层不变：仍 `ctx.configForms.get<AigcFormValue>(ENTRY_ID)` + inject face（`hooks.aigcSettings` / `saveProviders` / `send` / `t`）。新增 type-only import `@deepseek-ai/dsh-client-ui-plugin-manager/client`（构建期擦除，bundle 零新增运行时引用） |
| `src/client/SettingsPage.tsx` | props 改 `PropsRuntime<'plugins.row.config'>`（owner = `{ view: 'summary' \| 'page', form?: ConfigPageForm }`）；`view === 'summary'` 返回单行简介 `<span>{t('rowSummary')}</span>`（行缺省描述时的兜底，页面自己画标题/图标/面包屑，贡献只画字段与文案）；`view === 'page'` 且 `form === undefined`（页面组装不出表单，如行刚被停用）渲染 `settingsUnavailable` 提示；其余走原 CRUD 编辑器（数据仍取 `useAigcSettings` reactive 快照，快照 `unavailable` 分支保留）。删除页内 `<h2>`（与行页标题重复） |
| `src/client/SettingsPage.module.css` | 删 `.title` 规则；头注释改"row-configuration page" |
| `src/client/locales.ts` + `dictionaries.ts` | key `settingsNav`/`settingsTitle` 移除，新增 `rowSummary`（一行简介，21 语言全量翻译）；`emptyHint` 从"右侧设置页"改为"插件页(Plugins)本插件行"（指向已不存在的旧入口）；其余 key 不动 |
| `package.json` | peerDependencies + peerDependenciesMeta(optional) + devDependencies(link: dsh checkout) 增 `@deepseek-ai/dsh-client-ui-plugin-manager@^0.1.7-rc.1`；`dsh.client.inject` 信息性边增该项（对齐舰队写法） |
| `src/settings.ts` / `src/index.ts` / `cordis.patch.yml` | 仅注释更新（"settings.section 页" → "plugins.row.config 页 / Plugins 页"）；`configure({ auto: false })` own-page 策略与全部持久化语义不变 |
| `tests/entry-identity.spec.ts`（新） | 钉死 key 身份：`ENTRY_ID` === cordis.patch.yml insert 行 `id` 原文；`PACKAGE_NAME` === 行 `name` 与 package.json `name`；`ROW_CONFIG_KEY` === `@huanlin/dsh-plugin-aigc-canvas#dsh-aigc-canvas` |

## 行为变化

1. 入口位置：Settings 面板独立节 → Plugins 页 `@huanlin/dsh-plugin-aigc-canvas` bundle 行的 configure 控件（行详情页内嵌表单，页面自画标题/面包屑）。
2. 行停用（serve 撤回）时贡献随 `whileServed` 撤回，configure 控件消失；此前 settings.section 页不随行状态联动。
3. 页面不再渲染自己的 `<h2>` 标题（行页标题即标题）；简介段保留。

## 不变（明确）

- volatile Config / `settings.update('dsh-aigc-canvas', …)` 持久化 / legacy `providers.json` 一次性导入 / `settings.configure({ auto: false })`。
- 数据通道：`ctx.configForms.get` + `hooks.aigcSettings`（渲染器绑定为 `useAigcSettings`）+ `saveProviders` 整表写；revision bump re-seed 语义。
- better-sidebar 画布 tab 注册、canvas API/WS 通道、host 工具面。

## 验证（2026-09-25，全绿）

```powershell
pnpm typecheck   # PASS
pnpm test        # 128 passed（125 + entry-identity 3 新增）
pnpm run build   # PASS（host 113.5 kB；client 200.4 kB，未增大运行时依赖面）
```

- grep 门禁（src/ + tests/）：`settings\.section`、`settings.register`、`settingsScope`、`dsh-settings-file` 全部零命中。
- 产物契约：`lib/client.js` 仍以 `window.__ModuleLoader__.load` 包裹；无 default 导出；host 入口导出仍为 `name/inject/Config/apply/SETTINGS_NAMESPACE`；client bundle 内 `ui-plugin-manager` 零出现（type-only 擦除），`@deepseek-ai` 值引用仅剩原有的 `ui-primitives`。
- 依赖侧注：package.json 增 devDep 后，pnpm 12 的 verify-deps-before-run 在下次脚本运行时自动把 3 行 link importer 记录写进 `pnpm-lock.yaml`（未手动跑 `pnpm install`）；会话前已存在的 pnpm 12 环境性改动块（schemastery rescope / `minimumReleaseAgeExclude`）未回滚未扩大。

## 已知取舍 / 遗留

- **未做组件级 spec**：渲染 SettingsPage 需 jsdom + CSS-module 处理 + ui-primitives 内联（其构建产物在 node 下 import `.module.css` 会炸），本插件测试基建为纯 node host 面；本次以 entry-identity spec 钉死最易翻车的 key 契约，组件渲染留待后续补建客户端测试基建。
- **`rowSummary` 为静态一行**：未做 provider 计数动态简介（打开配置页即见全列表，收益低）；行若将来在 patch/host meta 声明了自己的 description，`rowText` 优先、`view: 'summary'` 自然退居二线。
- **apiKey 明文 / 提交竞争**：沿用 2026-09-24 记录的两条已知取舍，无变化。
- **未做（任务禁止 `dsh web`）**：真实 profile 端到端（需人工：`dsh plugin --profile web update @huanlin/dsh-plugin-aigc-canvas` → 重启 → 硬刷新 → Plugins 页打开本插件行 configure → 改一个 provider → 查 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-aigc-canvas` 行）。
