# 发布前必修清单

> 这些不是产品改进，是发布到 dsh-external 之前必须做的卫生工作。
> 修复成本都很低，但不修会影响第一印象。

---

## §1 README 严重过期

### 现状

`README.md` 还在描述旧的 5 工具架构：
- `aigc_text_to_image`
- `aigc_text_to_video`
- `aigc_first_last_frame_to_video`
- `aigc_multi_reference_to_video`
- `aigc_generate_audio`
- `aigc_canvas_list_elements`

实际代码是 8 工具的 provider-agnostic 架构：
- `aigc_get_provider_info`
- `aigc_http_request`
- `aigc_provider_set_instructions`
- `aigc_canvas_place`
- `aigc_canvas_link`
- `aigc_canvas_unlink`
- `aigc_canvas_list_elements`
- `aigc_media_edit`

`package.json` 的 description 已经是新架构，但 README 完全是旧的——`package.json:4` 与 `README.md:3-4` 矛盾。

### 影响

- 用户/开发者 clone 后看 README 会困惑（找不到文档里说的工具）
- 给 dsh-external 组织的 reviewers 留下"维护不善"的印象
- `aigc_text_to_image` 等工具根本不存在，README 里的示例无法运行

### 修复

重写 README，与新架构对齐：

```markdown
# dsh-aigc-canvas

> DSH 插件：provider-agnostic 的 AIGC 画布。Agent 通过 `aigc_http_request`
> 调用任意 HTTP AIGC API（endpoint + apiKey 自动附加），生成的文件用
> `aigc_canvas_place` 摆到无限画布上，可用 `aigc_media_edit` (ffmpeg) 后处理。

## 工具

| 工具 | 用途 |
|------|------|
| `aigc_get_provider_info` | 列出已配置的 provider |
| `aigc_http_request` | 调用 provider API（endpoint + apiKey 自动附加） |
| `aigc_provider_set_instructions` | 记录 provider 的调用说明 |
| `aigc_canvas_place` | 把文件摆到画布上 |
| `aigc_canvas_link` / `unlink` | 创建/删除元素间的边 |
| `aigc_canvas_list_elements` | 列出画布元素 + 边 |
| `aigc_media_edit` | ffmpeg 编辑（concat/clip/extract_audio/...） |

...
```

### 验收

- [ ] README 工具列表与 `src/tools.ts` 实际注册的工具一一对应
- [ ] 配置说明与 `src/config.ts` 的 Config schema 一致
- [ ] `cordis.patch.yml` 示例与实际文件一致
- [ ] 安装说明与 `package.json` 的 `dsh.bundle.patch` + 预构建策略一致

---

## §2 ffmpeg 路径硬编码

### 现状

`src/media-edit.ts:80`:
```ts
const fallback = 'D:\\Softwares\\ffmpeg\\bin\\ffmpeg.exe'
```

这是开发者本机路径，发布到 dsh-external 别人机器上必坏。

### 影响

- 其他用户安装后 `aigc_media_edit` 工具完全不可用
- 错误信息"ffmpeg not found in PATH or at the default location"误导（"default location"是开发者本机路径，不是真正的默认）

### 修复

改为多平台候选 + 环境变量：

```ts
async function findFfmpeg(): Promise<string> {
  // 1. 环境变量优先
  const envPath = process.env.AIGC_FFMPEG_PATH
  if (envPath) {
    await runProcess(envPath, ['-version'], 5000)
    return envPath
  }
  
  // 2. PATH 查找
  try {
    await runProcess('ffmpeg', ['-version'], 5000)
    return 'ffmpeg'
  } catch {
    // 3. 常见安装位置（按平台）
    const candidates = process.platform === 'win32'
      ? [
          'C:\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
          // conda 安装
          ...(process.env.CONDA_PREFIX ? [`${process.env.CONDA_PREFIX}\\Scripts\\ffmpeg.exe`] : []),
        ]
      : [
          '/usr/bin/ffmpeg',
          '/usr/local/bin/ffmpeg',
          '/opt/homebrew/bin/ffmpeg',
        ]
    
    for (const candidate of candidates) {
      try {
        await runProcess(candidate, ['-version'], 5000)
        return candidate
      } catch { /* continue */ }
    }
    
    throw new AigcError(
      'backend-error',
      'ffmpeg not found. Set AIGC_FFMPEG_PATH env var, install ffmpeg to PATH, ' +
      'or install to one of the common locations: ' +
      candidates.join(', ')
    )
  }
}
```

### 验收

- [ ] 不再硬编码 `D:\Softwares\ffmpeg\bin\ffmpeg.exe`
- [ ] 支持 `AIGC_FFMPEG_PATH` 环境变量
- [ ] Windows / macOS / Linux 常见安装位置候选
- [ ] 错误信息指引清晰（告诉用户怎么装 ffmpeg）

---

## §3 instructions 字数限制

### 现状

`src/tools.ts` 中 `aigc_provider_set_instructions` 工具的 description 反复强调：
- "CRITICAL: KEEP THE INSTRUCTIONS AS SHORT AS POSSIBLE"
- "Aim for under 200 characters total"

原因：`aigc_get_provider_info` 每次调用都返回所有 provider 的 instructions，长字段会撑爆 Agent 上下文。

### 问题

- 一个有 t2i/t2v/tts/edit 的 provider 至少需要 4 个 endpoint 的说明
- 200 字只能写"POST /v1/images {prompt,size} -> b64"这种失真级别
- Agent 被迫写过度压缩到失真的说明
- 多 provider 场景下 200 字 × N provider 仍然可能撑爆上下文

### 修复

这是方向 C（Provider 知识结构化）的前置问题。短期修复 + 长期方案：

#### 短期修复（发布前）

1. 放宽字数限制到 1000 字（兼顾上下文压力）
2. `aigc_get_provider_info` 返回时只显示前 200 字 + "... (N chars total)"，Agent 按需调 `aigc_provider_get_instructions` 拉完整

```
aigc_get_provider_info 返回:
  providers: [{
    id, name, endpoint,
    instructionsPreview: "POST /v1/images... (450 chars total)"
  }]

新工具 aigc_provider_get_instructions:
  参数: provider_id
  返回: { instructions: "完整字符串" }
```

#### 长期方案（方向 C）

升级为结构化 EndpointSpec，见 [03-provider-catalog.md](./03-provider-catalog.md)。

### 验收

- [ ] instructions 字数限制放宽到至少 1000 字
- [ ] `aigc_get_provider_info` 返回 preview（前 200 字 + 总字数）
- [ ] 新工具 `aigc_provider_get_instructions` 可拉完整 instructions
- [ ] 工具 description 不再强调"under 200 characters"

---

## §4 其他发布前检查

### 4.1 package.json description 与 README 一致

`package.json:4` 的 description 已经是新架构（8 工具），但需要核对：
- 列出的工具名与 `src/tools.ts` 实际注册的完全一致
- 描述的"五个工具"改为"八个工具"

### 4.2 cordis.patch.yml 示例配置正确

`cordis.patch.yml` 的 seed 配置应该是用户开箱即用的最小配置。检查：
- `stub` provider 的 endpoint 是 `stub://aigc-backend`
- `requestTimeoutMs` 合理（当前 300000 = 5 分钟，OK）
- `mediaSizeLimit` 合理（当前 100MB，OK）

### 4.3 .gitignore 排除正确

预构建策略下 `lib/` **不进** `.gitignore`，但以下必须排除：
- `node_modules/`
- `*.tmp`
- `.DS_Store`

### 4.4 LICENSE 文件

`package.json` 声明 `"license": "MIT"`，但仓库根是否有 `LICENSE` 文件？发布到 dsh-external 前确认。

### 4.5 测试通过

发布前必须通过三件套：
```sh
pnpm typecheck
pnpm test
pnpm run build
```

确认 `lib/index.js` + `lib/invariant.js` + `lib/client.js` + `lib/index.d.ts` 都生成。

---

## §5 修复优先级

| 项 | 影响 | 难度 | 优先级 |
|---|:---:|:---:|:---:|
| §1 README 重写 | 第一印象 | 低 | P0 |
| §2 ffmpeg 路径 | 功能不可用 | 低 | P0 |
| §3 instructions 字数 | 多 provider 必现 | 低 | P0 |
| §4.1 package.json description | 一致性 | 低 | P0 |
| §4.2-4.5 其他检查 | 规范 | 低 | P0 |

所有项都是低成本，发布前一次性做完。
