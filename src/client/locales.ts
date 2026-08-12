/**
 * i18n dictionaries for the AIGC canvas plugin.
 *
 * @module @dsh-external/dsh-aigc-canvas/client/locales
 */

export const NS = 'dsh-aigc-canvas' as const

export type AigcKey =
  // Canvas view
  | 'tabTitle'
  | 'title'
  | 'empty'
  | 'emptyHint'
  | 'prompt'
  | 'image'
  | 'video'
  | 'audio'
  | 'meta'
  | 'generatedBy'
  | 'edgeCount'
  | 'elementCount'
  | 'loadError'
  | 'disconnected'
  | 'reconnecting'
  | 'refresh'
  | 'resetView'
  | 'zoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'detailClose'
  | 'detailPrompt'
  | 'detailParams'
  | 'detailPosition'
  | 'detailPath'
  | 'delete'
  | 'deleteElement'
  | 'dropHint'
  | 'uploading'
  // Right-click context menu items (per docs/product/04-ux-reliability.md §1)
  | 'menuRegenerate'
  | 'menuUseAsReference'
  | 'menuSendToChat'
  | 'menuDownload'
  | 'menuPromoteToLibrary'
  | 'menuMarkWinner'
  | 'menuMarkRejected'
  | 'menuArchive'
  | 'menuSeparator'
  // Quick action toolbar (per docs/product/04-ux-reliability.md §7)
  | 'toolbarGenerate'
  | 'toolbarEditSelected'
  | 'toolbarRunWorkflow'
  | 'toolbarGenerateTitle'
  | 'toolbarEditSelectedTitle'
  | 'toolbarRunWorkflowTitle'
  | 'toolbarNoSelection'
  // Status update notices (sent to the agent via canvas.notify)
  | 'noticeRegenerate'
  | 'noticeUseAsReference'
  | 'noticeSendToChat'
  | 'noticeGenerate'
  | 'noticeEditSelected'
  | 'noticeRunWorkflow'
  // Settings — page chrome
  | 'settingsNav'
  | 'settingsTitle'
  | 'settingsIntro'
  | 'settingsEmpty'
  | 'settingsAdd'
  | 'settingsLoading'
  | 'settingsError'
  // Settings — provider card
  | 'row.id'
  | 'row.name'
  | 'row.endpoint'
  | 'row.apiKey'
  | 'row.instructions'
  | 'row.idPlaceholder'
  | 'row.namePlaceholder'
  | 'row.endpointPlaceholder'
  | 'row.apiKeyPlaceholder'
  | 'row.instructionsPlaceholder'
  | 'row.idHint'
  | 'row.endpointDesc'
  | 'row.apiKeyDesc'
  | 'row.instructionsDesc'
  | 'row.instructionsHint'
  | 'row.save'
  | 'row.delete'
  | 'row.deleteConfirm'
  | 'row.expand'
  | 'row.collapse'
  | 'row.create'
  | 'row.cancel'
  | 'row.init'
  | 'row.initPrompt'
  | 'row.auth'
  | 'row.authBearer'
  | 'row.authHeader'
  | 'row.authQuery'
  | 'row.authDesc'
  | 'badge.builtin'
  | 'badge.stub'
  | 'badge.real'
  | 'badge.default'
  // Request log panel
  | 'logButton'
  | 'logTitle'
  | 'logClear'
  | 'logEmpty'
  | 'logLoading'
  | 'logError'
  | 'logRequestBody'
  | 'logRequestHeaders'
  | 'logResponseBody'
  | 'logProducedFile'
  | 'logLocate'
  // Element lifecycle (per docs/product/01-agent-autonomy.md §5)
  | 'winner'
  | 'statusFilter'
  | 'statusReady'
  | 'statusDraft'
  | 'statusRejected'
  | 'statusArchived'
  // Compare view (per docs/product/04-ux-reliability.md §2)
  | 'compareButton'
  | 'compareTitle'
  | 'compareClose'
  | 'compareSelectWinner'
  | 'compareRejectAll'
  | 'compareCancelSelection'
  | 'compareSeed'
  | 'compareCost'
  | 'compareDuration'
  | 'comparePrompt'
  | 'compareNoMedia'
  | 'compareNotEnough'
  | 'compareTooMany'
  | 'compareClearSelection'
  | 'compareNSelected'
  // Provider settings — endpoint catalog editor (per docs/product/03-provider-catalog.md §5)
  | 'row.priority'
  | 'row.qualityHint'
  | 'row.costPerCall'
  | 'row.costPerKiloToken'
  | 'row.costPerSecond'
  | 'row.priorityDesc'
  | 'row.qualityHintDesc'
  | 'row.costPerCallDesc'
  | 'row.costPerKiloTokenDesc'
  | 'row.costPerSecondDesc'
  | 'row.endpoints'
  | 'row.endpointsDesc'
  | 'row.endpointsEmpty'
  | 'row.addEndpoint'
  | 'row.editEndpoint'
  | 'row.removeEndpoint'
  | 'row.endpointPath'
  | 'row.endpointMethod'
  | 'row.endpointCapability'
  | 'row.endpointResponseKind'
  | 'row.endpointResponsePath'
  | 'row.endpointAcceptsCanvasRef'
  | 'row.endpointNotes'
  | 'row.endpointParams'
  | 'row.endpointParamsEmpty'
  | 'row.endpointParamName'
  | 'row.endpointParamType'
  | 'row.endpointParamRequired'
  | 'row.endpointParamDefault'
  | 'row.endpointAddParam'
  | 'row.endpointRemoveParam'
  | 'row.endpointCancel'
  | 'row.endpointSave'
  | 'row.autoDetect'
  | 'row.autoDetectTitle'
  | 'row.autoDetectPrompt'

export const zh: Record<AigcKey, string> = {
  tabTitle: 'AIGC 画布',
  title: 'AIGC 画布',
  empty: '画布是空的。模型通过 aigc_http_request 调用供应商 API 生成素材,再用 aigc_canvas_place 把文件放到画布的任意位置。',
  emptyHint: '可在右侧设置页配置供应商,然后让模型开始生成。',
  prompt: '提示词',
  image: '图片',
  video: '视频',
  audio: '音频',
  meta: '元信息',
  generatedBy: '生成方式',
  edgeCount: '条连线',
  elementCount: '个元素',
  loadError: '加载画布失败',
  disconnected: '已断开,正在重连…',
  reconnecting: '正在重连…',
  refresh: '刷新',
  resetView: '重置视图',
  zoom: '缩放',
  zoomIn: '放大',
  zoomOut: '缩小',
  detailClose: '关闭',
  detailPrompt: '提示词',
  detailParams: '生成参数',
  detailPosition: '位置',
  detailPath: '文件路径',
  delete: '删除',
  deleteElement: '删除元素',
  dropHint: '拖放文件到画布',
  uploading: '上传中…',
  menuRegenerate: '重新生成...',
  menuUseAsReference: '用作参考...',
  menuSendToChat: '发到对话',
  menuDownload: '下载',
  menuPromoteToLibrary: '提升到资产库...',
  menuMarkWinner: '标记为 winner',
  menuMarkRejected: '标记为否决',
  menuArchive: '归档',
  menuSeparator: '─────────────',
  toolbarGenerate: '+ 生成',
  toolbarEditSelected: '✂ 编辑选中',
  toolbarRunWorkflow: '▶ 运行工作流',
  toolbarGenerateTitle: '打开快速生成弹窗（t2i/t2v/tts）',
  toolbarEditSelectedTitle: '对选中元素执行 ffmpeg 操作',
  toolbarRunWorkflowTitle: '打开 pipeline 模板选择器',
  toolbarNoSelection: '请先在画布上选中一个元素',
  noticeRegenerate: '请用 aigc_reroll 重新生成元素 {filePath}',
  noticeUseAsReference: '请把以下元素用作后续生成的参考: {filePath}',
  noticeSendToChat: '请使用这个元素作为参考: [filePath: {filePath}, kind: {kind}, title: {title}]',
  noticeGenerate: '请帮我生成一个新的 AIGC 素材（先调用 aigc_get_provider_info 查看可用供应商，再调用 aigc_http_request 发起生成，最后用 aigc_canvas_place 把产物放到画布上）。',
  noticeEditSelected: '请用 aigc_media_edit（ffmpeg）对选中元素进行编辑: {filePath}（kind: {kind}, title: {title}）',
  noticeRunWorkflow: '请列出可用的 pipeline 模板并运行其中一个（如果只有一个模板就直接运行它）。',
  settingsNav: 'AIGC 画布',
  settingsTitle: 'AIGC 供应商',
  settingsIntro: '配置一个或多个 AIGC 供应商。每个供应商可独立设置名称、API 地址、密钥、鉴权方式和调用说明。模型通过 aigc_get_provider_info 读取供应商列表,用 aigc_http_request 调用 API(自动携带 endpoint 和 apiKey),生成的文件用 aigc_canvas_place 放到画布上。',
  settingsEmpty: '暂无供应商,请在下方添加。',
  settingsAdd: '+ 添加供应商',
  settingsLoading: '加载中…',
  settingsError: '错误',
  'row.id': 'ID',
  'row.name': '名称',
  'row.endpoint': 'API 地址',
  'row.apiKey': 'API Key',
  'row.instructions': '调用说明',
  'row.idPlaceholder': 'volcano / jimeng / minimax',
  'row.namePlaceholder': '显示名(如"火山引擎")',
  'row.endpointPlaceholder': 'stub://aigc-backend',
  'row.apiKeyPlaceholder': 'sk-...',
  'row.instructionsPlaceholder': '调用说明由 Agent 初始化供应商时自动撰写(点击卡片上的"初始化"按钮)...',
  'row.idHint': '小写字母、数字、连字符;必须以字母开头。作为 provider_id 传给 aigc_http_request',
  'row.endpointDesc': '供应商 API 地址。填 stub://aigc-backend 使用内置 stub(合成测试媒体,不调真实 API)',
  'row.apiKeyDesc': '供应商 API 密钥。stub 后端不需要。模型看不到密钥,由 aigc_http_request 自动附加',
  'row.instructionsDesc': 'Agent 通过 aigc_get_provider_info 工具读取此字段,决定如何调用该供应商的 API',
  'row.instructionsHint': '💡 点击卡片上的"初始化"按钮,Agent 会用 aigc_http_request 探测 API 并自动撰写调用说明',
  'row.save': '保存',
  'row.delete': '删除',
  'row.deleteConfirm': '确定删除此供应商?',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.create': '创建',
  'row.cancel': '取消',
  'row.init': '初始化',
  'row.initPrompt': '请帮我初始化 AIGC 供应商「{name}」(id: {id}):先用 aigc_get_provider_info 查看配置,再用 aigc_http_request 探测它的 API(apiKey 会自动附加,无需手动传入),最后调用 aigc_provider_set_instructions 把调用说明保存下来,方便以后直接使用。',
  'row.auth': '鉴权方式',
  'row.authBearer': 'Bearer 头',
  'row.authHeader': '自定义 Header',
  'row.authQuery': 'URL 参数',
  'row.authDesc': 'aigc_http_request 自动附加 apiKey 的方式。默认 Authorization: Bearer <key>;选择自定义 Header 或 URL 参数时需填写名称',
  'badge.builtin': '内置',
  'badge.stub': 'stub 模式',
  'badge.real': '真实 API',
  'badge.default': '默认',
  logButton: '日志',
  logTitle: '请求日志',
  logClear: '清空',
  logEmpty: '暂无请求记录。',
  logLoading: '加载中…',
  logError: '错误',
  logRequestBody: '请求体',
  logRequestHeaders: '请求头',
  logResponseBody: '响应预览',
  logProducedFile: '产物文件',
  logLocate: '在画布上定位',
  winner: '优胜',
  statusFilter: '状态',
  statusReady: '就绪',
  statusDraft: '草稿',
  statusRejected: '否决',
  statusArchived: '归档',
  compareButton: '对比',
  compareTitle: '对比视图',
  compareClose: '关闭',
  compareSelectWinner: '选为 winner',
  compareRejectAll: '全部否决',
  compareCancelSelection: '取消选择',
  compareSeed: 'seed',
  compareCost: '成本',
  compareDuration: '耗时',
  comparePrompt: '提示词',
  compareNoMedia: '该元素无可显示的媒体',
  compareNotEnough: '请选择 2-4 个元素进行对比',
  compareTooMany: '最多只能同时对比 4 个元素',
  compareClearSelection: '清除选择',
  compareNSelected: '已选 {n} 个',
  'row.priority': '优先级',
  'row.qualityHint': '质量',
  'row.costPerCall': '单次成本 ($)',
  'row.costPerKiloToken': '千 token 成本 ($)',
  'row.costPerSecond': '每秒成本 ($)',
  'row.priorityDesc': '数字越小优先级越高（默认 100）。多 provider 同 capability 时按此排序',
  'row.qualityHintDesc': 'fast / balanced / quality，供 Agent 选择快速或高质量 provider',
  'row.costPerCallDesc': '单次调用成本（美元），用于成本追踪',
  'row.costPerKiloTokenDesc': '按 token 计费时（chat / transcribe）的千 token 成本',
  'row.costPerSecondDesc': '按秒计费时（t2v / tts）的每秒成本',
  'row.endpoints': 'Endpoints',
  'row.endpointsDesc': '结构化能力表。Agent 通过 aigc_get_provider_info 读取，无需解析自然语言',
  'row.endpointsEmpty': '暂无 endpoint。点击下方"自动探测"或"+ 添加 endpoint"',
  'row.addEndpoint': '+ 添加 endpoint',
  'row.editEndpoint': '编辑 endpoint',
  'row.removeEndpoint': '删除',
  'row.endpointPath': 'Path',
  'row.endpointMethod': 'Method',
  'row.endpointCapability': 'Capability',
  'row.endpointResponseKind': '响应类型',
  'row.endpointResponsePath': '响应字段路径',
  'row.endpointAcceptsCanvasRef': '支持 $base64 占位符',
  'row.endpointNotes': '备注',
  'row.endpointParams': '参数',
  'row.endpointParamsEmpty': '暂无参数',
  'row.endpointParamName': '名称',
  'row.endpointParamType': '类型',
  'row.endpointParamRequired': '必填',
  'row.endpointParamDefault': '默认值',
  'row.endpointAddParam': '+ 添加参数',
  'row.endpointRemoveParam': '删除参数',
  'row.endpointCancel': '取消',
  'row.endpointSave': '保存',
  'row.autoDetect': '自动探测',
  'row.autoDetectTitle': '让 Agent 用 aigc_probe_endpoint 自动探测响应格式',
  'row.autoDetectPrompt': '请帮我自动探测 AIGC 供应商「{name}」(id: {id}) 的 endpoint 响应格式：对每个未配置响应类型的 endpoint 调用 aigc_probe_endpoint（会发送一次最小测试请求，apiKey 自动附加），把探测到的 response.kind + response.path 通过 aigc_provider_set_endpoints 保存到 EndpointSpec。如果该 provider 还没有任何 endpoint，请先用 aigc_http_request 探测常见的 endpoint（如 /v1/images/generations、/v1/videos/generations、/v1/audio/speech），再用 aigc_probe_endpoint 探测响应格式。',
}

export const en: Record<AigcKey, string> = {
  tabTitle: 'AIGC Canvas',
  title: 'AIGC Canvas',
  empty: 'Canvas is empty. The agent calls provider APIs via aigc_http_request and places the generated files anywhere on the canvas with aigc_canvas_place.',
  emptyHint: 'Configure a provider in the settings tab on the right, then ask the agent to generate something.',
  prompt: 'Prompt',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  meta: 'Metadata',
  generatedBy: 'Generated by',
  edgeCount: 'edges',
  elementCount: 'elements',
  loadError: 'Failed to load canvas',
  disconnected: 'Disconnected, reconnecting…',
  reconnecting: 'Reconnecting…',
  refresh: 'Refresh',
  resetView: 'Reset view',
  zoom: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  detailClose: 'Close',
  detailPrompt: 'Prompt',
  detailParams: 'Generation params',
  detailPosition: 'Position',
  detailPath: 'File path',
  delete: 'Delete',
  deleteElement: 'Delete element',
  dropHint: 'Drop files onto canvas',
  uploading: 'Uploading…',
  menuRegenerate: 'Regenerate...',
  menuUseAsReference: 'Use as reference...',
  menuSendToChat: 'Send to chat',
  menuDownload: 'Download',
  menuPromoteToLibrary: 'Promote to library...',
  menuMarkWinner: 'Mark as winner',
  menuMarkRejected: 'Mark as rejected',
  menuArchive: 'Archive',
  menuSeparator: '─────────────',
  toolbarGenerate: '+ Generate',
  toolbarEditSelected: '✂ Edit selected',
  toolbarRunWorkflow: '▶ Run workflow',
  toolbarGenerateTitle: 'Open the quick-generate dialog (t2i/t2v/tts)',
  toolbarEditSelectedTitle: 'Run an ffmpeg operation on the selected element',
  toolbarRunWorkflowTitle: 'Open the pipeline template picker',
  toolbarNoSelection: 'Select an element on the canvas first',
  noticeRegenerate: 'Please regenerate the element {filePath} using aigc_reroll',
  noticeUseAsReference: 'Please use the following element as a reference for the next generation: {filePath}',
  noticeSendToChat: 'Please use this element as a reference: [filePath: {filePath}, kind: {kind}, title: {title}]',
  noticeGenerate: 'Please generate a new AIGC asset (call aigc_get_provider_info to list available providers, then aigc_http_request to generate, and finally aigc_canvas_place to put the result on the canvas).',
  noticeEditSelected: 'Please edit the selected element with aigc_media_edit (ffmpeg): {filePath} (kind: {kind}, title: {title})',
  noticeRunWorkflow: 'Please list the available pipeline templates and run one (if there is only one, run it directly).',
  settingsNav: 'AIGC Canvas',
  settingsTitle: 'AIGC Providers',
  settingsIntro: 'Configure one or more AIGC providers. Each provider has its own name, API endpoint, key, auth scheme, and usage instructions. The agent reads the provider list via aigc_get_provider_info, calls the API via aigc_http_request (endpoint + apiKey attached automatically), and places generated files onto the canvas with aigc_canvas_place.',
  settingsEmpty: 'No providers configured. Add one below.',
  settingsAdd: '+ Add provider',
  settingsLoading: 'Loading…',
  settingsError: 'Error',
  'row.id': 'ID',
  'row.name': 'Name',
  'row.endpoint': 'Endpoint',
  'row.apiKey': 'API Key',
  'row.instructions': 'Instructions',
  'row.idPlaceholder': 'volcano / jimeng / minimax',
  'row.namePlaceholder': 'Display name (e.g. "Volcano Engine")',
  'row.endpointPlaceholder': 'stub://aigc-backend',
  'row.apiKeyPlaceholder': 'sk-...',
  'row.instructionsPlaceholder': 'The agent writes these when you initialize the provider (click "Initialize" on the card)...',
  'row.idHint': 'Lowercase letters, digits, hyphens; must start with a letter. Used as the provider_id parameter to aigc_http_request',
  'row.endpointDesc': 'Provider API URL. Use stub://aigc-backend for the built-in stub (synthetic test media, no real API calls)',
  'row.apiKeyDesc': 'Provider API key. Not needed for the stub backend. The agent never sees it — aigc_http_request attaches it automatically',
  'row.instructionsDesc': 'The agent reads this field via the aigc_get_provider_info tool to decide how to call the provider API',
  'row.instructionsHint': '💡 Click "Initialize" on the card: the agent probes the API with aigc_http_request and writes the instructions itself',
  'row.save': 'Save',
  'row.delete': 'Delete',
  'row.deleteConfirm': 'Delete this provider?',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.create': 'Create',
  'row.cancel': 'Cancel',
  'row.init': 'Initialize',
  'row.initPrompt': 'Please initialize the AIGC provider "{name}" (id: {id}): first call aigc_get_provider_info to see its config, then probe its API with aigc_http_request (the apiKey is attached automatically — do not pass it yourself), and finally call aigc_provider_set_instructions to save the usage instructions so it can be used directly later.',
  'row.auth': 'Auth scheme',
  'row.authBearer': 'Bearer header',
  'row.authHeader': 'Custom header',
  'row.authQuery': 'URL query param',
  'row.authDesc': 'How aigc_http_request attaches the apiKey. Default: Authorization: Bearer <key>. For custom header or URL query param, fill in the name',
  'badge.builtin': 'builtin',
  'badge.stub': 'stub mode',
  'badge.real': 'real API',
  'badge.default': 'default',
  logButton: 'Logs',
  logTitle: 'Request Log',
  logClear: 'Clear',
  logEmpty: 'No requests logged yet.',
  logLoading: 'Loading…',
  logError: 'Error',
  logRequestBody: 'Request body',
  logRequestHeaders: 'Request headers',
  logResponseBody: 'Response preview',
  logProducedFile: 'Produced file',
  logLocate: 'Locate on canvas',
  winner: 'Winner',
  statusFilter: 'Status',
  statusReady: 'Ready',
  statusDraft: 'Draft',
  statusRejected: 'Rejected',
  statusArchived: 'Archived',
  compareButton: 'Compare',
  compareTitle: 'Compare view',
  compareClose: 'Close',
  compareSelectWinner: 'Select as winner',
  compareRejectAll: 'Reject all',
  compareCancelSelection: 'Cancel selection',
  compareSeed: 'seed',
  compareCost: 'cost',
  compareDuration: 'duration',
  comparePrompt: 'Prompt',
  compareNoMedia: 'No media to display for this element',
  compareNotEnough: 'Select 2-4 elements to compare',
  compareTooMany: 'You can compare at most 4 elements at once',
  compareClearSelection: 'Clear selection',
  compareNSelected: '{n} selected',
  'row.priority': 'Priority',
  'row.qualityHint': 'Quality',
  'row.costPerCall': 'Cost per call ($)',
  'row.costPerKiloToken': 'Cost per 1k tokens ($)',
  'row.costPerSecond': 'Cost per second ($)',
  'row.priorityDesc': 'Smaller = higher priority (default 100). When multiple providers serve the same capability, they are sorted by this',
  'row.qualityHintDesc': 'fast / balanced / quality — lets the agent pick fast vs. quality providers',
  'row.costPerCallDesc': 'Cost per call in USD (for cost tracking)',
  'row.costPerKiloTokenDesc': 'Per-1k-token cost in USD (for chat / transcribe cost tracking)',
  'row.costPerSecondDesc': 'Per-second cost in USD (for t2v / tts cost tracking)',
  'row.endpoints': 'Endpoints',
  'row.endpointsDesc': 'Structured capability catalog. The agent reads it via aigc_get_provider_info — no natural-language parsing needed',
  'row.endpointsEmpty': 'No endpoints yet. Click "Auto-detect" or "+ Add endpoint" below',
  'row.addEndpoint': '+ Add endpoint',
  'row.editEndpoint': 'Edit endpoint',
  'row.removeEndpoint': 'Remove',
  'row.endpointPath': 'Path',
  'row.endpointMethod': 'Method',
  'row.endpointCapability': 'Capability',
  'row.endpointResponseKind': 'Response kind',
  'row.endpointResponsePath': 'Response field path',
  'row.endpointAcceptsCanvasRef': 'Accepts $base64 placeholder',
  'row.endpointNotes': 'Notes',
  'row.endpointParams': 'Parameters',
  'row.endpointParamsEmpty': 'No parameters',
  'row.endpointParamName': 'Name',
  'row.endpointParamType': 'Type',
  'row.endpointParamRequired': 'Required',
  'row.endpointParamDefault': 'Default',
  'row.endpointAddParam': '+ Add parameter',
  'row.endpointRemoveParam': 'Remove parameter',
  'row.endpointCancel': 'Cancel',
  'row.endpointSave': 'Save',
  'row.autoDetect': 'Auto-detect',
  'row.autoDetectTitle': 'Ask the agent to auto-detect the response shape via aigc_probe_endpoint',
  'row.autoDetectPrompt': 'Please auto-detect the response shape for the AIGC provider "{name}" (id: {id}): for every endpoint whose response.kind is not yet set, call aigc_probe_endpoint (it sends ONE minimal test request — apiKey is attached automatically) and save the detected response.kind + response.path into the EndpointSpec via aigc_provider_set_endpoints. If this provider has no endpoints at all yet, first probe common endpoints with aigc_http_request (e.g. /v1/images/generations, /v1/videos/generations, /v1/audio/speech), then probe the response shape with aigc_probe_endpoint.',
}
