# 原任务控制：SDK 本地候选接缝

本文件说明尚未公开发布的任务控制候选；包版本仍是 `0.5.0`，不能据此假定公开同版本包或线上 Core 已实现这些方法。部署、迁移与公开分发需分别验证。以下商城、库存及调用 ID 均为合成示例。

一项“给商城商品补图，再到库存系统核对”的任务可以包含同一 Hub 内多个原连接。管理员通过受控入口确认成员、工具和策略后，宿主保存固定的任务关联。模型不能创建任务、选择新任务、增加预算，或用换工具、换系统、换轮次重置累计额度。

## 读取原任务

```ts
const original = {
  connectionKey: selected.connectionKey,
  workspace: selected.workspace,
  expectedBinding: {
    hubUrl: selected.hubUrl,
    clientAppId: selected.clientAppId,
    workspace: selected.workspace,
    sessionId: selected.agentSessionId,
  },
};
const capabilities = await transport.getTaskControlCapabilities(original);
const task = await transport.getTask(savedTaskId, {
  ...original,
  clientConversationId: savedConversationId,
});
```

这两个方法只读取能力和快照，不创建任务、业务 run 或派发许可。它们要求精确的原 `connectionKey` 和完整 `expectedBinding`，不会退回全局默认连接。SDK 在请求前和最终响应成功或失败后都重新核对原绑定，调用期间替换 Session 或删除连接会使结果失效。参数在第一次异步读取之前复制，避免宿主改写调用中的参数导致改绑。普通访问令牌刷新仍可沿用原授权流程。

能力请求为 `GET /agent-api/v1/task-control/capabilities`。显式 `getTaskControlCapabilities` 每次实时请求，`mode`、`supported: false` 和错误不会缓存。`supported: false` 是有效能力响应，可同时保留 `mode: required`；不代表存在可执行的受管任务。支持任务控制时必须有 `inspect_invocation: true`。

SDK 只在同一个 transport、同一原连接的 Hub、App、工作空间和 Session 下复用严格校验成功的任务/回执协议支持证明。`getTask`、受管 `startTurn` 和 `inspectInvocation` 可据此省去重复协议协商；每次仍真实请求任务快照、创建轮次或读取原回执，身份前后校验与 DTO 校验完整保留。协议证明不包含 enrollment、权限、任务状态、预算或许可，也不提供业务身份检查的多轮 TTL。身份变化、能力否定、协议或请求错误会清除证明；晚到的肯定能力响应不能恢复已失效的证明。任务快照与回执不缓存，Core 仍逐笔执行最终完整成员及业务闸门。

快照沿用 wire 字段。导出类型为 `AgentTaskControlCapabilities`、`AgentTaskSnapshot`、`AgentTaskMember` 和 `AgentTaskBinding`，可从 `/sdk` 或 `/agent-client` 导入。SDK 严格校验版本、标识、状态、安全整数、策略、计数和当前成员的 Session、App、工作空间、会话坐标，并只返回允许字段。其他成员、身份摘要、凭据和任意服务端附加字段不会透传。

**完整成员核验由宿主完成。** 宿主必须用每个原连接读取同一 task，确认任务 ID、`scope_hash`、`member_count` 一致，数量等于全部原选成员，每份快照的自身成员准确对应原范围；不得只绑定成功返回的子集，不支持跨 Hub。服务端仍需每次验证完整成员与实际权限，SDK 快照不是派发授权。

### 身份查询失败保留结构化原因

例如，会话同时选择商城和库存授权，其中一个原授权失效时，宿主应能区分“等待网络恢复”与“原身份已不可用”，不能仅根据异常文本猜测。

- `AgentSessionManager.getSession()` 收到401并按既有规则移除当前失效凭据后，仍抛出结构化 `AgentAuthHttpError`：HTTP401、`publicCode=agent_authorization_unavailable`、不可自动重试。并发轮换的新凭据不会被当成旧凭据删除。
- 远端返回的 Session、Client或授权路由与本地原记录不一致时，返回 `agent_binding_changed`，`origin=sdk / operation=scope / dispatch=not_dispatched`。不把响应中的新身份存成本地凭据，也不把冲突当网络故障。
- 访问令牌刷新返回不同的 Session 或 Client 时，同样返回 HTTP403、不可自动重试的 `agent_binding_changed`；直接管理器反馈为 `origin=sdk / operation=authorize / dispatch=not_dispatched`，宿主 facade 保留当前操作类别。替代令牌不会保存、返回或用于后续 Session/业务请求；本地原凭据保留以便检查，不表示仍有权限。并发等待者共享该次失败，网络故障、429/5xx仍允许按原身份显式重试。该分类不新增自动重新授权、业务重放或永久撤销账本。
- 带 `expectedBinding` 的 `transport.status()` 在成功或失败返回前都核对原绑定。401清理了原凭据或等待期间发生本地改绑时，返回 `agent_binding_changed`；普通未绑定status的logged_out行为保持兼容。
- 带原绑定的令牌提供者在刷新成功或失败后都再次检查取消状态和原身份，因此取消优先于晚到的刷新冲突，失败路径也不会绕过并发改绑检查。
- 对原绑定未变的403、429/5xx、超时/传输错误，保留既有结构化状态；取消仍优先。坐标宿主据此对明确原身份失效整组阻断，对暂时无法验证保留原组重试，不通过改系统、剩余子集或默认连接绕过。

该修复沿用现有错误码和反馈协议，不新增Core接口、任务策略或DSH方法。DSH正式坐标候选可直接使用新SDK；正式坐标的 `AUTHORIZATION_CHANGED` 在同一runtime保持阻断，不会因服务重新返回旧身份而自动ready。这里不新增跨进程永久撤销账本，也不改变宿主明确重新确认未开始草稿的原规则。

`CredentialStore.load()` 的空值契约始终是 `undefined`，不是 `null`。失败时不返回坐标、无业务派发、原范围不改等断言应正向执行，不能以预期失败标记代替契约验收。

## 受管轮次只接受宿主注入

```ts
const run = await transport.startTurn({
  clientConversationId: savedConversationId,
  clientTurnId: 'turn-2',
  userMessageId: 'message-2',
  userInput: '继续核对库存',
}, {
  ...original,
  taskBinding: {
    schema_version: 'bailing.agent-task-binding.v1',
    task_id: task.task_id,
    scope_hash: task.scope_hash,
  },
});
```

`taskBinding` 放在可信宿主 options，内部字段为 snake_case。把 `taskBinding`、`task_binding`、`task_id` 或 `taskId` 放进模型可控的 turn input 会直接拒绝；拼错为 options 的 `task_binding` 也会拒绝，避免静默退回旧流程。受管调用要求完整原绑定。

SDK 先确认任务控制能力及原只读回执能力，然后发送 `task_binding`。Core 必须在创建上下文/run 前验证原成员、固定策略和关联，并持久化实际 run 的 task 归属。SDK 要求返回完全一致的 task ID 与范围摘要；缺少回显、改绑、非受管请求意外返回任务，都以 `TASK_BINDING_CONFLICT` 拒绝。

低层 `BailingHubAgentClient.startTurn(input, { taskBinding })` 使用相同分离接口；低层调用方自行负责原连接与令牌提供者的生命周期。已有连接仓的宿主应优先使用上述 facade 的身份防替换检查。

原 `invoke`、`resume` 和 `inspectInvocation` 不新增 task 选择参数。Core 从原 run 或 invocation 派生关联。受管后台轮询使用原 `inspectInvocation` 的 GET 回执；明确继续执行才走原 `resume`，不能用观察结果、审批完成或网络恢复代替用户继续意图。任务控制没有新增管理员凭据、创建方法、控制方法或 MCP 管理工具。

## 计量和失败场景

| 场景 | 应展示和保留的事实 |
| --- | --- |
| 单次调用批量修改 20 个商品 | 计量是一个唯一写 invocation；20 次单件调用计为 20。没有对象数或成功数保护承诺。 |
| `max_write_calls: 0` / `null` | 分别表示只读 / 未启用累计写上限，不可混淆。`write_reserved` 是待确定预留，`write_consumed` 是已消耗，`active_permits` 是在途许可。 |
| 暂停后原审批完成 | 暂停阻止新许可，已有许可的在途操作仍可能完成。读取回执不消费审批，也不执行操作。 |
| 取消后晚结果返回 | 取消不会回滚已发生的效果；更新原记录，不新建 task 或 invocation。v1 没有 `completed` 任务状态。 |
| 写请求发出后断网 | 保留原 task、run、invocation、参数及授权；只读核对已有证据，不把查询失败解释为未执行。 |
| 原成员撤销或改绑 | 保留整组原范围并阻断，不能改用默认授权或剩余子集。短暂不可用保留绑定等待原身份重验。 |

快照的 `snapshot_is_dispatch_permission` 始终为 `false`，计数或 `state: active` 都不保证下一笔请求一定获准。频率等待与累计额度耗尽分别展示；等待不能清空累计账本。

| 错误/能力 | SDK 分类 |
| --- | --- |
| 旧能力端点 HTTP 404/405/501，或未来 schema | `TASK_UNSUPPORTED` / `unsupported`，不发送受管 turn。 |
| 能力响应 `supported: false` | 返回完整能力 DTO；读取 task 或受管 turn 拒绝为 `TASK_UNSUPPORTED`。 |
| 网络失败或 `TASK_UNAVAILABLE` | `transport_unavailable`，保持原绑定；scope 查询可重验原范围。不能当作“不支持”。 |
| `TASK_REQUIRED`、暂停/取消/到期、额度/并发上限、范围/成员/绑定冲突、工具不允许等 | 保留大写 `publicCode` 和反馈 `code`，分类 `task_control`，无自动重试/新建建议。 |
| 不合格的快照结构或策略计数 | `TASK_RECORD_INVALID`，不返回伪造默认任务或空计数。 |
| 已支持 Core 返回 `TASK_NOT_FOUND` / `TASK_RUN_INACTIVE` | 保留原任务不存在 / 原 run 不可继续的原因与 HTTP 状态，分类 `task_control`，不误判旧 Core。`TASK_INVALID_INPUT` 分类 `invalid_request`。 |
| 原写调用已有派发不确定性 | 既有 `accepted_unknown` / `invocation_outcome_unknown` 优先，不因任务错误抹掉原调用事实。 |
| `TASK_DISPATCH_UNCERTAIN`，或 invoke/resume 返回 `TASK_UNAVAILABLE` | 原调用可能已派发：保留原 ID，`dispatch: unknown`、`next_action: inspect_original`；只读核对，不建议自动 resume 或新建调用。 |

宿主必须优先保留本地 `storage_error`、`unsavedEvents` 和 `recovery_gap`，任务摘要不能覆盖关联未落盘或原调用未知状态。SDK 不创建第二份任务账本或原调用回执协议。配套 Core、宿主持久化和真实 Session 的集成验收需独立记录，SDK 合成 fetch 测试不替代部署验证。
