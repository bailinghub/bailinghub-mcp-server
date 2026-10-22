# MCP / Agent Client SDK 0.8.0：完整参数与按需知识

用户让智能体保存一份包含 HTML/CSS 的完整页面时，旧适配器可能在业务服务收到请求前就拒绝参数。另一些任务只需要查库存或确认操作规则，却在准备工具时重复带入大量指导正文。本版分别修复输入容量和信息披露：配套 **Core 0.10.0 / SDK 0.8.0 / DSH 0.8.0**。

## 新增与修复

- Agent 工具参数按实际 `JSON.stringify(arguments)` 的 UTF-8 字节计算，上限为 1 MiB。保持对象结构；Core HTTP 信封与业务字段限制独立生效。超限返回安全的大小标量和 `not_dispatched`，不回显完整内容。
- 短工具描述可以声明有补充指导；用 `getToolDetail()`，或 MCP `search_business_capabilities` 的 `tool_name` 与 `include_usage_guidance`，只读取当前授权、运行和能力修订下选定工具的有界指导。
- 新增 `getKnowledgeCapabilities()`、`searchKnowledge()`、`readKnowledge()`，以及 MCP 的 `search_business_knowledge`、`read_business_knowledge`。协议协商成功后按需返回提示和分页正文；不支持时保留原 inline 知识。知识是参考资料，不覆盖指令、授权、审批或记忆。Core 原生聊天和嵌入的知识组装不变。
- `bailinghub-mcp-server/usage` 新增 `resolveModelOutputBudget()` 与 `modelOutputOptions()`，分开默认请求预算、服务允许上限及可选供应商能力上限，明确输出字段与思考/答案范围。旧目录保持兼容；不改写原已准备请求，不静默裁剪或改名输出参数。
- MCP SDK 更新至 1.32.1，更新相关生产依赖修复；发布仍执行正常测试、审计与 prepack 门禁。

## 长任务与原操作

供应商响应交换完成、回答完整与任务完成是不同状态。输出截断可以由宿主在保存检查点后发起新的模型 operation；SDK 不自动重发请求，不实现宿主的自动续跑。缺少最终回执或原结果未知时先查询原 ID；截断工具参数不执行，已完成业务动作不随续写重跑。`inspectInvocation()` 是只读查询；`resume()` 可能首次派发原已批准操作，不能当轮询。

## 升级与检查

先升级 Core，再安装精确 SDK 0.8.0；DSH 用户使用配套插件，不手工混装 SDK。保留原凭据、会话、任务与操作记录。业务服务须已开放需要的能力；更大的 SDK 参数预算不改变业务字段上限或权限。

验证旧 Client Token 和 Agent Session 流程仍可使用，再核对按需知识、原引用分页与过期处理、参数边界、旧目录回退和所选模型输出字段。真正的长任务续跑、停止按钮及副作用防重仍由宿主验收。[完整升级步骤](UPGRADE_v0.8.0.md)
