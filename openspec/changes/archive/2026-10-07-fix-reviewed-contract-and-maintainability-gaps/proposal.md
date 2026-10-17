## Why

审查报告 `docs/dev/reviews/repo_060c1d6_2026-10-07.md` 指出的文档/spec 滞后、process 契约分散和维护性问题可在当前源码中复现。需要在保持会话、安全边界和现有传输兼容的前提下修复，并发布可识别的 patch 版本。

## What Changes

- 核实并修正 D1–D13：心跳配置归属、shutdown、API/工具列表、permission.kind、会话关闭语义、部署总览与插件 process 指引。
- 将五个 process 方法的参数/结果纳入 Rust/TypeScript 共享契约和跨语言 fixtures，保持现有校验与默认值。
- 分阶段拆分 Gateway 状态与 RPC 转发、MCP 协议与授权调用、Rust workspace/process 内部模块，统一取消状态并简化参数解析；保持公开 Facade。
- 补授权 Execute/Control、Unix process 注册、MCP 核心构建拷贝和生命周期回归验证。
- HTTP session_close 保持幂等，增加结果字段明确区分实际关闭与无会话 noop。
- Engine 0.2.0 → 0.2.1，Gateway/MCP 0.3.0 → 0.3.1；同步 lockfile、版本文档和产物检查。实施时若版本已前进，选择更高 patch，不回退。
- 不将报告的 read-pin 同步交接误判为可复现竞态；保留回归测试并记录判定。保留 408 后不取消 mutation、大小限制差异、grep 子串和 gitignore 子集语义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `reach-rpc-contract`: 补 permission.kind 与 process 参数/结果共享契约及跨语言一致性要求。
- `grok-bot-mcp-connector`: 修正初始化/选设备工具面，明确 HTTP close noop、process 指引及本次 patch 发布验证。
- `edge-engine-service`: 更新 Purpose，明确显式会话控制作为主生命周期。
- `workspace-filesystem-rpc`: 将正常会话结束场景从 job.done 更新为 session.close。

## Impact

涉及 Rust 契约、dispatch、tools、runtime、workspace/process，TypeScript Gateway/MCP/process 契约，connector 构建脚本、fixtures、插件技能和公开文档。无需新框架或运行时依赖，不改变 reach-rpc/1.0、MCP 协议号或 Node runtime 版本。仅在后续 apply 阶段修改实现；不触碰现有服务、私有部署配置或运行中安装。
