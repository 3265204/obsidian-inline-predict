# 开发文档

[English](../en/development.md) · [使用说明](../../README.md)

Inline Predict 是运行在 Obsidian Markdown 编辑器中的 CodeMirror 6 插件。开发重点是保持正常编辑体验，在有限上下文内完成预测，并减少不必要的模型请求。

## 环境与构建

本地需要 Node.js 24、npm 和 Obsidian 1.13.0 或更新的桌面端。Node.js 只用于开发工具，不是插件运行时依赖。

```bash
git clone https://github.com/3265204/obsidian-inline-predict.git
cd obsidian-inline-predict
npm ci
npm run typecheck
npm run lint -- --max-warnings 0
npm test
npm run build
```

构建产物为根目录的 `main.js`，采用 Obsidian 加载的 CommonJS 格式。`npm run dev` 启动 esbuild 监听；修改源码后仍需在 Obsidian 中重新加载插件。

## 模块职责

| 目录 | 职责 |
| --- | --- |
| `src/core/` | 共享契约、常量、文本工具与事件 |
| `src/editor/` | 编辑器观察、灰字装饰、按键与分步接受 |
| `src/completion/` | 集成工厂与每个编辑器的补全状态机 |
| `src/scheduler/` | 触发策略、请求执行、预测缓存与候选复用 |
| `src/context/`、`src/tokens/` | Markdown 上下文、结构缓存、Token 估算与预算 |
| `src/prediction/` | 提示构造、完整提示预算、输出校验和相关性检查 |
| `src/model/` | 模型适配器、传输、连接测试与响应解析 |
| `src/settings/`、`src/i18n/` | 设置默认值、归一化、运行参数变更和双语文案 |
| `src/storage/`、`src/telemetry/` | Vault adapter 存储与本地统计 |
| `src/plugin/`、`src/ui/` | 运行时组装与设置页面 |
| `src/main.ts` | 生命周期、依赖组装与命令注册 |

`src/core/types.ts` 是跨模块契约入口。调整契约时同步修改生产者、消费者和相关测试。`main.ts` 保持组装职责，业务逻辑放在对应模块中。

## 一次预测的流程

1. 编辑器观察器生成包含文件路径、文档版本、光标、有限前后文和输入法状态的快照。
2. 每个编辑器的补全会话处理光标、输入与接受事务，尝试复用尚未消费的建议。
3. 调度器检查总开关、上下文门槛、等待时间和错误退避，并查询预测缓存。
4. 上下文与预算模块选择光标附近内容；提示模块把系统规则、封装开销及实际发送的完整消息纳入预算。
5. 模型适配器执行非流式请求，解析正文、`finish_reason` 与供应商 `usage`；可选相关性复核使用独立调用。
6. 输出经过截断、重复等校验。请求 ID、文档版本、光标和文件路径必须仍然匹配，才能显示灰字。
7. 用户接受后才写入文档。已知模型用量独立记账，即使结果因过期而不显示也不能丢弃。

正文公式的系统提示规则固定为：行内使用 `$...$`，独立公式使用单独一行的 `$$...$$`；不用 `\(...\)`、`\[...\]` 或代码块代替公式定界符。光标已处于公式内时，只补充缺失内容，不重复前后文已有的定界符。规则与其他系统提示一样保持跨请求稳定，并计入完整消息预算。

## 修改代码时的约束

- 灰字是装饰，接受前不能修改 Markdown。没有候选时，Tab/Esc 必须保留原生行为。
- 编辑器扩展不能抛出错误或干扰输入法；组合输入期间不显示或接受建议。
- 不能用换行或空行作为模型停止条件。检查 `finish_reason`，截断结果只可在完整边界降级，否则拒绝。
- 自动请求默认至少有 2 个前文字符；临时缓冲区使用相同门槛。手动预测只绕过上下文门槛，总开关、输入法保护和错误退避仍有效。
- 缓存与复用必须检查原始上下文。模型或提示配置改变后清除旧候选、缓存并失效迟到响应。
- 区分逻辑预测、实际模型调用、供应商用量、估算与未知用量。同一候选的多次部分接受不能重复计入候选采纳率。
- 纯逻辑模块不能导入 `obsidian`；通过接口注入传输、存储和时间等依赖。
- 插件运行时代码不能使用 Node 文件系统、子进程、Electron 或常驻后台服务。存储通过 Vault adapter；`tools/` 和构建脚本可使用 Node。
- TypeScript 保持严格类型，使用 `unknown` 与类型收窄，避免 `any`。新 UI 文案同时加入 `src/i18n/en.ts` 和 `src/i18n/zh-cn.ts`。
- 注释说明原因，优先中文和中性示例。新增运行时依赖需说明理由及包体积影响。
- 语义检索、画像学习保持默认关闭；增加远程处理范围前设计明确的配置和同意流程。

内部类型和 CSS 类仍使用 `Predictive` / `predictive-*`，Vault 数据根目录仍是 `.predictive/`。插件公开 ID 是 `inline-predict`；改名时不要顺带迁移这些已有数据路径。

## 自动验证

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm test
npm run build
node tests/smoke/load-plugin.cjs
```

`typecheck` 同时检查源码与测试。测试使用 Vitest，位于 `tests/unit/`；Obsidian 通过 `tests/mocks/obsidian.ts` 替身加载，网络通过注入的传输或模型替身隔离。

修改调度时用假计时器验证状态变化；修改存储时使用内存 adapter；修改分步接受时验证连续接受、撤销和余文，而不只测试拆分函数。回归测试应覆盖真实问题的边界，不调用网络。

烟测在模拟 Obsidian 环境中加载构建文件，检查命令、扩展、设置注册与默认零网络调用。它不证明真实设备、输入法或模型服务兼容。

## 在测试库中调试

先在 Obsidian 中创建或打开专用测试库，然后执行：

```bash
VAULT="/path/to/test-vault" npm run deploy
```

脚本先构建，再复制 `main.js`、`manifest.json` 和 `styles.css` 到测试库的 `.obsidian/plugins/inline-predict/`。不设置 `VAULT` 时使用项目中的 `docetest/test`；目标必须已经包含 `.obsidian/`。复制后启用插件并重新加载。

测试持续输入、光标移动、切换文件、Tab/Esc、连续部分接受、撤销、中文/日文输入法、超时退避和即时修改模型配置。记录实际测试的系统、Obsidian 版本和编辑模式。

如需无付费服务的界面联调，另开终端运行：

```bash
npm run mock:server
```

测试库设置为 API 地址 `http://127.0.0.1:8765/v1`、占位密钥 `local-mock`、模型 ID `mock-model`。模拟服务返回固定文本，只验证请求与灰字流程，不评估生成质量；日志在 `.tmp/mock-requests.log`，包含提示片段。

## 数据与提交范围

设置与 API Key 由 Obsidian 保存到插件 `data.json`，密钥为明文；诊断统计仅保存在内存中。`.predictive/` 为 Vault adapter 数据根目录，不能因为是隐藏目录就认为它已加密。

公开文档包括根目录中英文 README、docs 导航和中英文开发文档。审阅、内部架构草稿、目标/进展记录、协作配置、测试库、请求日志与凭据不提交。发布前检查 `.gitignore` 和待提交文件；不要强制添加被排除的本地数据。

## 发布文件

保持 `package.json`、依赖锁文件、`manifest.json` 的版本一致，并维护 `versions.json` 中版本与最低 Obsidian 版本的映射。最低版本和移动端支持需以实际验证为依据。

源码不提交生成的 `main.js`。GitHub Release 标签与 `manifest.json` 的版本完全相同，例如 `0.1.1`，不加 `v`；独立附上 `main.js`、`manifest.json` 和 `styles.css`。可额外提供以 `inline-predict/` 为根目录的安装 ZIP，不能用 ZIP 替代独立附件。

发布由维护者操作；调整文档或同步源码不自动创建 Release。使用方法统一维护在根目录 README，不再建立独立 guide。


## 设置搜索与构建证明

设置页使用 Obsidian 1.13.0 的 `getSettingDefinitions()`，以分类名称和分类内文案建立搜索索引；仍保留折叠布局。不要在生成搜索元数据时请求模型或读取凭据。依赖状态变化时调用 `update()`，不用已弃用的 `display()`。

`npm run lint` 使用官方 Obsidian ESLint 推荐规则检查运行时代码；测试和 Node 开发脚本由类型检查及各自测试验证。新增的是开发依赖，不进入插件运行包。

维护者可在 GitHub Actions 手动运行 **Build and attest plugin assets**。工作流完成检查、构建和 provenance attestation，并上传三个独立安装文件；不会自动创建或修改 Release。发布时下载本次工作流的 `inline-predict-assets` 附件，解压后上传其中的 `main.js`、`manifest.json`、`styles.css`，保持字节不变。

已有 Release 不会因为加入工作流而自动获得证明；证明只对应实际由工作流构建并签署的文件。验证示例：`gh attestation verify main.js --repo 3265204/obsidian-inline-predict`。
