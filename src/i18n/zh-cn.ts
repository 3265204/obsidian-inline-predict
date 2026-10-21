import type { en } from './en';

/** 简体中文。键必须与 en.ts 完全一致，缺失的键会在测试中报错。 */
export const zhCn: Record<keyof typeof en, string> = {
	'app.name': 'Inline Predict',

	'command.accept': '接受预测',
	'command.acceptWord': '接受预测的下一个词',
	'command.acceptSentence': '接受预测的下一句',
	'command.acceptLine': '接受预测的下一行',
	'command.reject': '忽略预测',
	'command.toggle': '开关行内预测',
	'command.search': '用自然语言检索笔记',
	'command.diagnostics': '打开预测诊断',
	'command.predictNow': '立即预测',
	'command.settings': '打开 Inline Predict 设置',
	'common.cancel': '取消',
	'ribbon.search': 'Inline Predict 检索',

	'status.enabled': 'Inline Predict：已开启',
	'status.disabled': 'Inline Predict：已关闭',
	'status.modelNotConfigured': 'Inline Predict：尚未配置模型',
	'status.requesting': 'Inline Predict：预测中…',
	'status.backoff': 'Inline Predict：出错后等待重试',
	'status.ready': 'Inline Predict：就绪',
	'status.cached': 'Inline Predict：来自缓存',

	'notice.disabled': '行内预测已关闭。',
	'notice.modelNotConfigured': '请先在 Inline Predict 设置中填写模型 ID 和 API Key。',
	'notice.requestFailed': '预测请求失败：{message}',
	'notice.accepted': '已接受预测。',
	'notice.statsReset': '预测统计已重置。',
	'notice.indexRebuilt': '本地索引已重建。',
	'notice.cacheCleared': '缓存已清理。',
	'notice.profileCleared': '写作画像已清除。',
	'notice.consentRequired': '请先在设置中开启隐私授权，再将笔记内容发送到远端服务。',
	'notice.partialOnly': '只能展示该预测的一部分。',
	'notice.notAvailable': '该功能在当前版本中尚未实现。',
	'notice.providerRequired': '请输入 API Key 以启用预测。本地 OpenAI 兼容服务可填写任意占位 Key。',

	'ghost.acceptHint': '接受',
	'ghost.tapToAccept': '点按接受预测',

	'settings.title': 'Inline Predict',
	'settings.intro.modelSetup':
		'请先在模型选项下填写兼容 OpenAI 格式的 API 地址、API Key 和模型 ID，以保证插件的正常使用。',
	'settings.section.completion': '补全',
	'settings.section.model': '模型',
	'settings.section.semantic': '语义检索',
	'settings.section.learning': '写作画像',
	'settings.section.data': '索引与缓存',
	'settings.section.diagnostics': '诊断',
	'settings.section.advanced': '高级',

	'settings.completion.enabled.name': '行内预测',
	'settings.completion.enabled.desc':
		'总开关：关闭后不显示 Ghost Text，也不会请求模型；下方相关选项会暂时停用。',
	'settings.completion.autoTrigger.name': '输入时自动预测',
	'settings.completion.autoTrigger.desc':
		'开启时在输入过程中自动请求预测；关闭后只能用命令「立即预测」手动触发。关闭可显著减少 Token 消耗，但输入时不会自动出现补全。',
	'settings.completion.debounce.name': '预测前的基础停顿（毫秒）',
	'settings.completion.debounce.desc':
		'会根据输入速度和文档结构自动调整。数值越大，请求越少。',
	'settings.completion.minPrefix.name': '最小上下文长度',
	'settings.completion.minPrefix.desc':
		'接近空文档时不预测。光标附近文本需达到该长度。',
	'settings.completion.maxChars.name': '建议最大长度（字符）',
	'settings.completion.maxChars.desc':
		'仅作为安全上限。正常长度由模型在自然语义边界处停止决定。',
	'settings.completion.filterOffTopic.name': '过滤无关建议',
	'settings.completion.judge.name': '模型复核边界候选',
	'settings.completion.judge.desc':
		'本地关联度无法确定时，向已配置的模型额外询问一次 YES/NO 关联判断。只对可疑候选触发，因此仅在少数情况下增加一次很小的请求和约 0.3–1 秒延迟。',
	'settings.completion.filterOffTopic.desc':
		'对“短中文上下文 + 长候选”做本地关联度检查：候选与上下文没有任何共同词元时直接丢弃。不产生额外 API 调用；可避免上下文不足时模型背出的无关套话。短候选不会被过滤。',

	'settings.model.baseUrl.name': 'API 地址',
	'settings.model.baseUrl.desc':
		'OpenAI 兼容接口，例如 https://api.openai.com/v1。Embedding 需单独配置。',
	'settings.model.apiKey.name': 'API Key',
	'settings.model.apiKey.desc':
		'以明文保存在插件数据文件中，只会发送到你配置的接口地址。',
	'settings.model.modelId.name': '模型 ID',
	'settings.model.modelId.desc': '用于补全请求的模型。',
	'settings.model.temperature.name': '温度',
	'settings.model.temperature.desc': '数值越低，补全越稳定。',
	'settings.model.maxOutputTokens.name': '最大输出 Token',
	'settings.model.maxOutputTokens.desc':
		'用于处理截断的安全限制。达到该上限会被视为降级结果，而不是正常结束。',
	'settings.model.timeout.name': '请求超时（毫秒）',
	'settings.model.timeout.desc': '预测耗时过长时中止请求并退避。',
	'settings.model.contextWindow.name': '上下文窗口（Token）',
	'settings.model.contextWindow.desc':
		'0 表示使用适配器默认值。仅用于计算预算，不会因此发送更多文本。',
	'settings.model.reasoningEffort.name': '推理强度',
	'settings.model.reasoningEffort.desc':
		'可选的模型参数。部分推理模型（如 DeepSeek V4 Flash）会先消耗隐藏推理 Token 再输出，导致行内补全变慢甚至为空。此类模型请选择 “none”。保持“服务商默认”则完全不带该参数。',
	'settings.model.reasoningEffort.default': '服务商默认（不带该参数）',
	'settings.model.privacyNote':
		'开启预测后，光标附近的文本（以及可选的笔记片段和画像）会发送到上述服务商。API Key 或模型 ID 为空时不会发出任何请求。',
	'settings.model.test': '测试连接',
	'settings.model.testSuccess': '连接正常。网络延迟 {latency}',
	'settings.model.testFailure': '连接失败：{message}',
	'settings.model.testUnavailable': '当前版本暂不支持连接测试。',

	'settings.semantic.enabled.name': '启用语义检索',
	'settings.semantic.enabled.desc':
		'通过语义向量查找相关笔记，改善上下文匹配，减少无关内容和无效预测。关闭后仍可使用关键词检索，但在部分场景下可能需要更多请求。语义检索本身也可能产生 Embedding 费用。',
	'settings.semantic.inactive': '语义检索已关闭，仍可使用关键词检索。',
	'settings.semantic.noConsent': '语义检索需要可用的 Embedding 服务，并明确授权发送笔记片段。',
	'settings.semantic.baseUrl.name': 'Embedding API 地址',
	'settings.semantic.baseUrl.desc':
		'Embedding 服务通常与 Chat Completions 不同，可独立配置。',
	'settings.semantic.apiKey.name': 'Embedding API Key',
	'settings.semantic.apiKey.desc': '仅用于 Embedding 请求，与补全模型分开配置。',
	'settings.semantic.modelId.name': 'Embedding 模型 ID',
	'settings.semantic.modelId.desc':
		'不同模型生成的向量不会混用。更换模型会使向量索引失效。',
	'settings.semantic.batchSize.name': 'Embedding 批大小',
	'settings.semantic.batchSize.desc':
		'构建索引时每次请求的分块数。移动端建议使用更小的批大小。',
	'settings.semantic.consent.name': '允许发送笔记片段用于 Embedding',
	'settings.semantic.consent.desc':
		'开启前不会上传任何笔记内容用于向量化。默认关闭。',

	'settings.learning.enabled.name': '学习我的写作习惯',
	'settings.learning.enabled.desc':
		'在本地建立写作画像（风格、结构、推理偏好），保存在 Vault 隐藏目录。默认关闭，仅本地分析，不上传任何内容。',
	'settings.learning.scan': '立即建立画像',
	'settings.learning.scanning': '正在扫描笔记… {done}/{total}',
	'settings.learning.cancel': '取消扫描',
	'settings.learning.notAvailable': '写作画像功能在当前版本中尚未实现。',
	'settings.learning.mergedNote':
		'画像保存在本地且可解释，各项特征会记录来源数据，便于核查。',
	'settings.learning.export': '导出画像',
	'settings.learning.import': '导入画像',
	'settings.learning.clear': '清除画像',
	'settings.learning.importFailed': '导入失败，原画像未改动。原因：{message}',
	'settings.learning.importSuccess': '画像已导入。',
	'settings.learning.exportSuccess': '画像已导出至 {path}。',

	'settings.data.rebuildIndex': '重建本地索引',
	'settings.data.rebuildIndex.desc':
		'重新扫描 Markdown 文件并重建关键词索引。隐藏目录 .predictive 不参与检索。',
	'settings.data.clearCache': '清理缓存',
	'settings.data.clearCache.desc': '清理预测缓存与上下文缓存，不影响笔记和画像。',
	'settings.data.clearProfile': '清除写作画像',
	'settings.data.clearProfile.desc': '只删除画像数据。关闭学习开关不会自动删除任何数据。',
	'settings.data.storageNote':
		'数据保存在当前 Vault 的 .predictive/ 目录。隐藏目录不是加密，部分同步工具仍可能复制它。',

	'settings.diagnostics.requests': '已完成的预测次数（含失败、取消与过期）',
	'settings.diagnostics.modelCalls': '模型 API 调用次数（含相关性复核）',
	'settings.diagnostics.modelCallFailures': '模型 API 调用失败次数',
	'settings.diagnostics.unknownUsage': '用量未知的调用次数',
	'settings.diagnostics.unknown': '仅含已知用量，部分调用缺少数据',
	'settings.diagnostics.failures': '失败请求',
	'settings.diagnostics.cacheHits': '缓存命中',
	'settings.diagnostics.prefixReuses': '前缀复用',
	'settings.diagnostics.tokens': '输入 / 输出 Token',
	'settings.diagnostics.cachedTokens': '缓存命中的输入 Token',
	'settings.diagnostics.offTopic': '无关过滤',
	'settings.diagnostics.latency': '延迟 P50 / P95',
	'settings.diagnostics.acceptRate': '接受率',
	'settings.diagnostics.partialAcceptRate': '部分接受率',
	'settings.diagnostics.tokensPerAccept': '每次有效接受的 Token 消耗',
	'settings.diagnostics.cost': '预估费用',
	'settings.diagnostics.estimated': '估算',
	'settings.diagnostics.reported': '来自服务商用量',
	'settings.diagnostics.reset': '重置统计',
	'settings.diagnostics.noData': '尚未产生预测。',
	'settings.diagnostics.localOnly': '所有统计仅保存在本设备，不会上传。',

	'settings.advanced.cacheEntries.name': '预测缓存条目数',
	'settings.advanced.cacheEntries.desc': '内存中保留多少条未消费的预测用于前缀复用。',
	'settings.advanced.contextEntries.name': '上下文缓存条目数',
	'settings.advanced.contextEntries.desc': '保留多少份已解析的文档/章节上下文。',
	'settings.advanced.debug.name': '详细本地日志',
	'settings.advanced.debug.desc':
		'在开发者控制台输出调度与校验决策。数据不会离开设备。',
	'settings.advanced.resetAll': '恢复默认设置',
	'settings.advanced.resetConfirm': '将所有 Inline Predict 设置恢复为默认值？',

	'search.title': 'Inline Predict 检索',
	'search.placeholder': '用自然语言提问，例如「我之前在哪里讨论过矩阵相似？」',
	'search.run': '检索',
	'search.results': '{count} 条结果',
	'search.noResults': '没有找到匹配的笔记。',
	'search.semanticOff': '当前为关键词检索。可在设置中开启语义检索。',
	'search.semanticPending': '语义检索尚未生效。',
	'search.match': '匹配',
	'search.open': '跳转到原文位置',
	'search.emptyQuery': '输入查询内容以检索 Vault。',
	'search.indexing': '索引构建中… {done}/{total}',

	'error.modelNotConfigured': '尚未配置模型。',
	'error.timeout': '预测请求超时。',
	'error.auth': '服务商拒绝了 API Key。',
	'error.rateLimit': '触发了服务商限流，稍后重试。',
	'error.network': '连接服务商时发生网络错误。',
	'error.invalidResponse': '服务商返回了无法识别的响应。',
	'error.truncated': '预测被输出上限截断。',
	'error.aborted': '预测请求已取消。',
};
