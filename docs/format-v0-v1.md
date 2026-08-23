# 格式对比：v0（0.0.8）→ v1

本文档记录 v0 → v1 迁移步骤（`src/steps/v0-to-v1.ts`）所依据的完整格式差异与转换规则。
该步骤已随 v1 格式定稿而冻结，本文档作为其规格说明永久保留。
格式背景：v1 对应 [guilimao/Mutsumi](https://github.com/guilimao/Mutsumi) 的 `refactor(mtm): finalize format v1` 提交；
v0 是 0.0.8 版本写入的无 `formatVersion` 标记的布局。

## 根对象

| | v0 | v1 |
|---|---|---|
| 结构 | `{ metadata, context }` | `{ formatVersion: 1, metadata, context, notes? }` |
| 校验 | 反序列化失败时静默创建空会话 | 严格校验，失败拒绝打开 |

## 消息模型（核心差异）

v0 使用 OpenAI Chat Completions 风格；v1 使用 [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) 消息模型：

| | v0 | v1 |
|---|---|---|
| 用户消息 | `content: string \| parts[]`，幽灵块存于 `metadata.last_ghost_block` | `content: string \| (text\|image)[]`，幽灵块存于 `mutsumi.ghostBlock`，新增可选 `timestamp` |
| 图片部件 | `{ type: 'image_url', image_url: { url } }` | `{ type: 'image', data, mimeType }`（base64，无 data: 前缀） |
| 助手消息 | `content: string \| null`，`tool_calls[]`（`function.arguments` 为 JSON 字符串），`reasoning_content` 字符串 | `content: [text \| thinking \| toolCall][]` 内容块数组；`api`/`provider`/`model` 必填；禁止 `mutsumi` |
| 工具结果 | `role: 'tool'`，`tool_call_id` + `name`，字符串 content，无 `isError` | `role: 'toolResult'`，`toolCallId` + `toolName`，content 数组，`isError` 必填 |
| system 消息 | 存在于 context（仅展示用，历史重建时被跳过） | 角色被移除 |
| 回合顺序 | 无校验 | 严格校验：`user → (assistant → toolResult*)*`，toolResult 必须匹配最近的 toolCall，结尾不得有未应答的 toolCall，不允许连续 assistant |

## 新增 notes 数组

v1 把用户手写的 Markup cell 持久化为顶层 `notes: [{ beforeUserIndex, markdown }]`（按"前面有几个 user cell"锚定），**永不发送给模型**。v0 中这类内容会序列化成 user 消息（会发送）或 system 消息。

## metadata

| 字段 | v0 | v1 |
|---|---|---|
| 基础字段（uuid/name/created_at/parent_agent_id/allowed_uris 等） | 相同 | 相同 |
| `model` / `provider` | 允许只有 model | 必须成对出现，否则拒绝打开 |
| `provider` 取值 | 用户在 `mutsumi.providers` 设置里自定义（默认 `kimi-for-coding`） | pi-ai 内置 provider + `mutsumi.customProviders`；**`kimi-for-coding` 是被移除的 ID，显式拒绝**（等价内置 provider 为 `kimi-coding`，api 为 `anthropic-messages`） |
| `enabledMcpTools` | 无 | 新增可选（MCP 工具冻结快照） |

幽灵块结构 `{ files, tools }` 两版完全一致，只是存放位置变化。

## 迁移规则

| v0 输入 | v1 输出 |
|---|---|
| `user.content` 字符串/部件 | 字符串保留；`image_url` data URI → `image` 块；http(s) URL → 降级为 markdown 文本（⚠） |
| `user.metadata.last_ghost_block` | 结构校验通过则移到 `mutsumi.ghostBlock`；无效则丢弃（⚠）；其余 metadata 字段丢弃（⚠） |
| `assistant.reasoning_content` | `thinking` 内容块 |
| `assistant.content` | `text` 内容块 |
| `assistant.tool_calls[]` | `toolCall` 内容块（`function.arguments` JSON 字符串解析为对象） |
| 每条 assistant | 补齐 `api`（按 provider 查 pi-ai 内置表，缺省 `openai-completions`）、`provider`/`model`（取自 metadata，`kimi-for-coding`→`kimi-coding`；metadata 无可用对时用 `unknown` 并 ⚠） |
| `tool` 消息 | `toolResult`：`tool_call_id`→`toolCallId`，`name`→`toolName`（与注册的 toolCall 不一致时以注册名为准并 ⚠），content→text 数组，`isError` 由 `Error: ...` 字符串约定推断 |
| `system` 消息 | note：`**System**: <content>`（两版都不会把它发给模型） |
| 首条 user 之前的 assistant/tool（孤儿，v1 禁止） | 按 0.0.8 notebook 渲染规则拍平成 markdown note（⚠） |
| 连续 assistant 消息（v1 禁止） | 合并为一条（内容块拼接）（⚠） |
| 未应答的 toolCall（会话被中断；v1 禁止） | 追加占位 `toolResult`（`isError: true`，标注迁移占位）（⚠） |
| 找不到对应 toolCall 的 tool 消息 | 丢弃（⚠） |
| `metadata.model` 无 `provider` | 两者都丢弃，回退全局默认模型（⚠） |
