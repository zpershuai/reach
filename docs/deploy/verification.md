# 部署验证与验收

验证分为源码回归、网络入口、真实文件 RPC、已安装 MCP 和故障恢复。运行前确认目标 Engine 没有其他客户端持有的活动会话。文件验证会在工作区创建测试文件；故障恢复额外会中断服务。

所有配置和报告保存在 Git 忽略的 `.reach/` 或仓库外。不要把真实主机、账号、内网地址、凭证、部署清单与验收报告写进公开文档。

## 源码与入口

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
bash scripts/verify.sh
curl --fail --silent --show-error https://reach.example.com/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://reach.example.com/session/status
```

示例域名需替换为自己的 Gateway URL。健康响应应包含 `reach-rpc/1.0`，未认证状态查询应返回 `401`。源码测试与 HTTP 健康检查均不能代替实际文件 RPC。

## 公网文件 RPC

准备私有 `.reach/deployment.json`；可由 [配置示例](configuration.md) 生成。以下值均为占位符：

```json
{
  "gatewayUrl": "https://reach.example.com",
  "engineId": "engine-a",
  "controllerToken": "<controller-token>",
  "engineToken": "<engine-token>"
}
```

若验证程序可直接访问 Engine 工作区，可额外设置 `workspaceRoot` 为真实绝对路径，逐字核对落盘文件；远程设备省略此字段即可。

```bash
npm --prefix packages/grok-bot-mcp-connector run build
node scripts/verify-remote.mjs .reach/deployment.json
```

验证器按 `engineId` 选择目标，等待 ready 的预算为 150 秒，覆盖默认 120 秒空闲心跳及连接建立。它检查 HTTPS、未认证拒绝、凭证角色与设备身份、WSS ready、无 grant 写入拒绝、授权读写、查询、编辑、工作区边界、续租及关闭后重开。

成功写入 `.reach/remote-verification.json`，测试文件位于 `default` 工作区的 `deployment-tests/<UUID>.txt`。检查报告时间确认本次运行成功；失败不会让旧报告失效。恢复验证依赖该文件，完成后再按需清理指定文件。

## 已安装 MCP

```bash
node scripts/verify-mcp-remote.mjs "$HOME/.config/reach/mcp.json" .reach/deployment.json
```

第一个参数为 MCP 客户端配置（默认 `~/.config/reach/mcp.json`），第二个为私有部署配置（默认 `.reach/deployment.json`）。验证器启动其中的 `mcpServers.reach`，检查动态工具、设备选择和文件读写编辑。设备别名可通过部署配置的 `deviceId` 指定，省略时使用 `engineId`。`workspaceRoot` 仅用于可选的本地落盘核对。

此验证器要求动态工具模式；静态模式仍受支持，但不满足这里的工具列表断言。成功报告为 `.reach/mcp-verification.json`。接入具体客户端后还应执行一次设备选择、文件读取和关闭会话。

## 故障恢复

此验证器适用于验证机器上的 macOS LaunchAgent Engine，以及通过 SSH 管理的 Docker Compose Gateway。仅在允许中断所有相关会话的维护窗口运行。

在私有部署配置中添加：

```json
{
  "recovery": {
    "gatewaySshTarget": "deploy@gateway.example.com",
    "gatewaySshPort": 22,
    "gatewayComposeDir": "/srv/reach/deploy",
    "launchdLabel": "org.reach.engine"
  }
}
```

这是附加字段，应与上面的 Gateway/Engine 配置合并。SSH 目标与 Compose 路径必须显式设置，SSH 端口可省略。服务 label 应使用安装时的实际值，默认 `org.reach.engine`，也可通过 `REACH_LAUNCHD_LABEL` 设置。

```bash
node scripts/verify-recovery.mjs .reach/deployment.json .reach/remote-verification.json
```

脚本重启配置的 Gateway，重建会话并读取之前的测试文件，再终止本地 Engine 进程，确认 launchd 拉起新 PID，重新读取文件并关闭会话。成功写入 `.reach/recovery-verification.json`。

这证明进程恢复和文件持久性。Gateway 重启不会恢复内存会话、grant 或 RPC 去重记录，也不提供未完成写入的自动重放。

## 检查与保管

完整检查项见 [部署检查清单](deployment-checklist.md)。部署者在私有记录中保存当次源码版本、组件版本、产物摘要和备份位置。公开发布记录可说明通用功能和测试覆盖，不能包含实际环境信息。
