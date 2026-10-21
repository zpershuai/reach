# Proposal

## Why

`reach-open-source-readiness.md` 要求先证明源码可安全公开、权限边界可验证、陌生开发者能独立使用，再推进社区与申请材料。当前已有安装恢复、协议测试及贡献文档，但客户端凭据仍拥有所有设备和工作区的权限，公开快照、扫描覆盖及真实发布路径也缺少统一的可追溯验收。

## What Changes

- 按用户选择 A，增加可过期、可撤销的客户端凭据及按身份分配的 Engine、workspace、read/write/execute 权限；REST、HTTP MCP、stdio Connector 经同一授权边界，资源发现与执行均受限。
- 将 grant 绑定签发身份和授权版本，权限收紧或撤销后清理会话、进程与 grant；保留可信 Gateway、Engine 本地工作区和默认关闭进程执行的边界，不把工作目录描述为沙箱。
- 明确保留全局 Controller 作为 Owner 凭据，存量 OAuth 权限显式迁移并标记待复核；新客户端默认拒绝。**BREAKING**：跨身份复用 grant 不再有效；新 OAuth 同意页必须选择资源和权限；首次管理员设置凭据改为私有文件交付，不再打印日志。
- 增加公开候选快照的导出、全部拟公开引用/资产/容器层扫描与发布阻断规则。原私有历史保留，所有真实清单、扫描结果、例外和验收报告仅保存在忽略的 `.reach/` 或仓库外。
- 核对并接入已经完成的授权和第三方声明修复，为实际发布路径加入逐资产许可证、摘要、源码提交对应和下载回验门槛；保护发布凭据和摘要渠道，补齐错误包及失败恢复测试。
- 复用并补齐 README、中英文入口、最小配置、完整 MCP 示例、撤销与卸载、兼容矩阵、故障恢复、Issue/PR 模板、私密安全报告渠道和固定工具链的 CI。
- 本次实施范围为 P0/P1；P2 的性能基线、SBOM/来源证明/签名、社区反馈及申请证据进入后续路线图。公开仓库、推送标签、修改线上服务、轮换真实凭据及提交申请均作为单独运维动作，不由本变更自动执行。

## Capabilities

### New Capabilities

- `client-access-policy`: 可管理的客户端身份、最小授权、统一数据面检查、权限撤销与兼容迁移。
- `source-publication`: 可审查的源码快照、发布面枚举、扫描证据和公开门槛。
- `diagnostic-confidentiality`: 服务日志、审计及错误诊断的敏感数据排除和可测试输出边界。

### Modified Capabilities

- `gateway-write-grants`: grant 的身份与授权版本绑定以及策略变更失效。
- `mcp-oauth`: 显式资源授权、稳定身份、策略感知的会话和撤销清理。
- `gateway-admin-auth`: 私有设置凭据文件交付及客户端权限管理的敏感操作保护。
- `github-release-publish`: 所有资产的许可证/源码追溯、受保护发布和远端逐资产回验。
- `component-auto-update`: 安装/更新可信来源、平台/摘要/版本拒绝与保留旧版本。
- `deployment-verification`: 权限/TLS/日志/恢复回归、固定工具版本及干净环境上手验收。

## Impact

主要影响 `packages/reach-rpc/src/{gateway,grants,gateway-forwarder,mcp/*,console-api/*}`、`packages/gateway-console/`、Connector 的凭据说明，以及 Engine 的传输诊断、安装更新和测试。新增持久化策略/凭据迁移、授权夹具、扫描/快照与发布验收工具，修改 `.github/workflows/`、打包脚本和公开文档。

不增加多管理员账户系统、不改变 `reach-rpc/1.0` 的基础线协议、不实现任意 shell 或操作系统沙箱，也不重做清单已确认修复的历史许可证问题。远端分支、发布权限、已有资产和匿名可访问性留待带日期的实际验收，不把历史记录当作当前事实。
