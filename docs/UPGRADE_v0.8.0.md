# 升级到 SDK / MCP 0.8.0

完整配套为 Core 0.10.0、SDK 0.8.0、DSH 0.8.0。原 Client API v1、Agent Auth/Runtime v1、凭据和原操作 ID 保持；不清退历史，不重新执行待核对业务动作。

1. 管理员先备份并升级 Core，按其升级指南仅执行尚未完成的迁移；SDK 安装不迁移中枢数据库。
2. 结束或保存当前任务检查点，保留原凭据、会话、任务绑定、审批和 invocation/model-operation 记录。
3. SDK 宿主执行 `npm install --save-exact bailinghub-mcp-server@0.8.0`；独立 MCP 配置固定 `bailinghub-mcp-server@0.8.0`。DSH 用户安装 `dsh-bailinghub@0.8.0`，由插件安装精确 SDK。
4. 重启并核对实际加载模块与依赖树。库内 overrides 不传播到安装宿主；独立核对宿主生产依赖，不能用库自己的 audit 代替整个应用审计。

## 按功能接入

- **完整工具参数**：对象直接传递，SDK 按序列化后的 UTF-8 字节检查 1 MiB。不要把 source 改成 JSON 字符串或靠截短正文通过校验。Core/业务字段仍可更小；超限先处理明确拒绝，不重放原未知调用。
- **指导详情**：先使用发现结果中的截断/指导标记，再读取选定工具详情。详情必须保持原 route、能力修订和工具声明绑定，仅作为参考。
- **知识按需读取**：先 `getKnowledgeCapabilities()`，只在明确支持时通过可信宿主选项 `knowledgeDelivery:'on_demand'` 启动新 turn。固定原 turn 的模式；未知协议、授权失败不能当空知识。读取分页时保留原 ref、run 和授权，`truncated` 不等于全文完成。[协议](AGENT_KNOWLEDGE.md)
- **输出预算**：新请求使用 `resolveModelOutputBudget()` 和 `modelOutputOptions()`；默认预算与服务上限分别消费，保留用户显式预算与所声明 scope。错字段或超限明确拒绝，不改旧 intent/digest、不自动换模型。旧目录没有新成组字段时继续 legacy。[预算与续跑](USAGE_SERVICE.md)

## 恢复与验收

只有明确识别的截断原因、最终原 operation 回执和已保存检查点，才可由宿主准备新模型续段。缺终帧、网络未知和原操作未决先 `inspectModelRequest()`；业务 invocation 只读核对用 `BailingHubAgentClient.inspectInvocation()`，不能把 `resume()` 当查询。截断工具参数不执行；已经完成或结果未知的业务动作不自动重做。

先用无副作用夹具验证参数边界、按需知识与旧 Core 回退、独立预算/输出键、原 ID 恢复和既有 Client Token/Agent Session 两条路径。宿主自动续跑必须另做次数/费用/时长界限、取消、审批、压缩和重启防重验收；升级包本身不自动增加这一任务循环能力。
