# 设置通道统一到 dsh 0.1.7-rc.1 契约（dsh-plugin-aigc-canvas）

- 日期：2026-09-24
- 走廊：`dsh-v0.1.7-rc.1` 设置面三卡：`DSH-0.1.7-J1-04`（host，required）/ `DSH-0.1.7-J1-27`（client，required）/ `DSH-0.1.7-J1-34`（seat，确认无冲突）
- 背景：2026-09-23 的 rc.1 迁移（见 `2026-09-23-dsh-0.1.7-rc.1-migration.md`）把 J1-27 判为"非命中"——设置页走自建 JSON RPC（`/aigc-canvas/api/providers.*` + `config.get`），provider 持久化走自定义文件 `~/.dsh/aigc-canvas/providers.json`，host Config 未声明 `.volatile()`，也未 `settings.configure`。本次把设置读写统一到 0.1.7 标准通道，是对该决策的升级而非纠错（旧通道在 rc.1 下可运行，但不在设置服务的版本栅栏 / 生命周期内）。

## 变更

### host 半（J1-04）

| 文件 | 变更 |
|---|---|
| `src/config.ts` | `providers` 标记 `.volatile()`；新增 `AigcEntryConfig`（`providers: Volatile<readonly AigcProvider[]>`，apply 传入活引用）；拆出 `resolveAigcProviders(raw)`（规范化 + 按 id 去重，无 stub 注入）；`resolveAigcConfig` 改读 `config?.providers?.get()`，仅 seed 路径保留空表 stub 兜底 |
| `src/settings.ts`（新） | `installAigcSettings`：`ctx.inject(['settings'])` 内 `settings.configure({ auto: false }, ctx.fiber)`（本插件自带 settings.section 页，抑制 schema 自动生成页）；桥 `source()`（读活引用）/ `persist()`（`settings.update('dsh-aigc-canvas', { providers })`，写入 profile `cordis.patch.yml`）/ `writable`；一次性 legacy 导入 `importLegacyProviders`（rename 先行，`providers.json` → `.imported`，失败仅告警） |
| `src/provider-store.ts` | 重写：`ProviderPersistence` 面（source/persist）；挂接后**读穿透**（每次读经 `source()` 归一化，外部写立即可见），CRUD 全异步化、提交经 `persist`、拒绝时报 `{ ok: false }`；未挂接（headless）退回内存 Map；`builtin` 随记录持久化（数组整体替换语义下不再"从 seed 重derive"） |
| `src/index.ts` | `apply(ctx, config?: AigcEntryConfig)`；桥在 settings 服务挂载后经 `onReady` 挂到 store；JSON API 删除 `providers.list/add/update/remove` + `config.get`（设置页不再走自建 RPC；`canvas.*`/file/ws 保留） |
| `src/tools.ts` | `setInstructions` 回调改 `Promise<{ok;error?}>`，execute 内 await（指令保存真实等到 profile 写入落地） |
| `src/provider-shape.ts`（新） | 纯 id 校验（`PROVIDER_ID_PATTERN`/`validateProviderId`），host/client 两半共享（无 schemastery 依赖，可进 client bundle） |
| `src/context-types.ts` | `AigcSettingsForms`（configure/update 最小面）+ `AigcCordisFiber` 结构面 + Context augmentation 增 `settings`/`fiber`（沿用本文件"结构性 restate"惯例，不新增 peer 依赖） |

### client 半（J1-27）

| 文件 | 变更 |
|---|---|
| `src/client/index.ts` | `inject` 增 `'configForms'`；`ctx.configForms.get<AigcFormValue>('dsh-aigc-canvas')`（entry id = cordis.patch.yml 行 id）；inject face 增 `hooks: { aigcSettings: form }`（渲染器绑定为 `useAigcSettings` 选择器 hook）与 `saveProviders`（整表写 `form.set('providers', …)`，resolve `Promise<boolean>`） |
| `src/client/SettingsPage.tsx` | props 改 `InjectFace<AigcSettingsInjected>`（hooks compartment 派生 `useAigcSettings`）；drafts 以 `[status, revision]` 为 deps 的 effect 从 committed 值 seed（自有保存 / 外部写——含模型 `aigc_provider_set_instructions`——统一经 revision bump 再 seed，与旧页"每次变更后重 seed"行为一致）；`unavailable`/只读/保存被拒文案；add 前置 id 校验（共享 `validateProviderId` + 重复检查） |
| `src/client/api.ts` | 删 `fetchConfig/listProviders/addProvider/updateProvider/removeProvider` 与 `RuntimeConfig`；增 `AigcFormValue`/`AigcFormSnapshot` |
| `src/client/locales.ts` + `dictionaries.ts` | 新 key `settingsUnavailable` / `settingsReadOnly` / `settingsSaveFailed`（zh/en + 19 语言 better-locale 覆盖词典补全；法/意用排版撇号 `’` 避免单引号串冲突） |

### J1-34（settings.launcher / settings.models.sign-in）

未注册——本插件不需要启动器/凭据流 seat；`settings.section` 注册已走 `ctx.slots.inject`（跨包 slot 贡献正确姿势），无冲突。

## 行为变化（有意为之，均记录）

1. **持久化位置**：`~/.dsh/aigc-canvas/providers.json`（全局单文件）→ 活动 profile 的 `cordis.patch.yml` `dsh-aigc-canvas` 行 `config.providers`（每 profile 独立）。旧文件首次启动一次性导入后改名为 `.imported`。
2. **删光所有 provider 后重启**：旧版会在 seed 时复活 stub（与"删除可跨重启保留"的测试语义自相矛盾）；新版空覆盖表即空（工具报"no AIGC providers configured"），与部分删除语义一致。
3. **设置页可见模型写入**：模型的 `aigc_provider_set_instructions` 落库后设置页 draft 即时 re-seed（旧版需重开页面）。
4. **写入失败可见**：settings 服务拒绝（版本冲突/校验失败）时页面报错而非静默内存成功。

## 验证

```powershell
pnpm typecheck   # PASS
pnpm test        # 125 passed（原 109：provider-store 重写 9、settings 新增 10、tools 适配）
pnpm run build   # PASS（tsdown host 113.5 kB + client 197 kB；client 无 @deepseek-ai 值导入）
```

- 门禁 grep（src/ + tests/）：`settings.register`、`settingsScope`、`dsh-settings-file` 零命中；`fetchConfig|addProvider|updateProvider|removeProvider|providers.list` 零命中。
- 产物冒烟：host 入口 `node -e "import('./lib/index.js')"` 仅导出 `name/inject/Config/apply/SETTINGS_NAMESPACE`、无 default；`Config.dict.providers.meta.volatile === true`（对齐 DSH `isVolatilePath`/`volatileForm` 读法）。
- 未做（任务禁止 `dsh web`）：真实 profile 冷启动 + 设置页 UI 端到端（需人工：`dsh plugin --profile web update` 后重启 + 硬刷新，改一个 provider → 检查 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-aigc-canvas` 行）。

## 已知取舍 / 遗留

- **apiKey 明文**：`apiKey` 未标 `.role('secret')`——标记后 describe 视图会脱敏，整表 `form.set('providers', …)` 会把脱敏占位写回毁掉密钥（须改逐路径 mutate）。现状与旧 `providers.json`/seed 明文本地文件同级；后续若要 secret 化需把保存路径改为 `form.mutate([{op:'set',path:['providers',i,'apiKey'],…}])` 并处理"未改动的密钥不复述"。
- **请求超时/媒体上限**：`requestTimeoutMs`/`mediaSizeLimit` 保持非 volatile（cordis.patch.yml seed 专有，UI 从未暴露），语义不变。
- **提交后同卡片并发的编辑竞争**：保存 await 期间的同卡片输入会被 re-seed 覆盖（旧版同样在保存响应后整表重 seed，无回归）。
