# Release notes

The shop/inventory update is documented in [SDK 0.5.0 release notes](RELEASE_NOTES_v0.5.0.md).

商城与库存协同这批更新已整理为 [SDK 0.5.0 发布说明](RELEASE_NOTES_v0.5.0.md#简体中文)。


## Capability discovery and failure feedback candidate

Additive candidate on the 0.5.0 package line; identify builds by their exact source commit and
package digest until a release is authorized. Discovery metadata remains optional for older Core
versions. SDK/MCP preserve bounded catalog semantics and sanitized failure guidance, including
original-invocation recovery and session-local unloaded-tool dispatch. No permission, approval,
migration or business API changes are required by the SDK candidate.

See [English SDK guidance](AGENT_CLIENT_SDK.md#discovery-counts-and-tool-set-state-candidate) and
[中文说明](AGENT_CLIENT_SDK.zh-CN.md#发现数量与工具集状态候选).
