# 部署验证与验收

验证分为源码回归、网络入口、真实文件 RPC、安装后的 MCP 和故障恢复。`/healthz` 成功不能替代文件操作验收，LaunchAgent running 也不能证明公网链路正常。

所有本地命令从仓库根目录运行。公网验证会创建文件并占用唯一会话，运行前关闭其他 MCP/Controller 会话；故障恢复额外会重启 Gateway 和终止 Engine 进程。

## 1. 源码与协议回归

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
bash scripts/verify.sh
```

[verify.sh](../../scripts/verify.sh) 检查 Rust 格式、Rust workspace 测试、Gateway/RPC 和 MCP 测试，以及两组共享协议 fixture。测试需要 Node 24、Rust 工具链；首次运行需要已有依赖或下载条件。

这组检查验证当前源码，不会发布 VPS 服务，也不能证明线上运行的是同一产物。历史通过数与发布产物摘要见 [当前部署记录](current-deployment.md)，以后应以实际当次测试输出为准。

## 2. 不占用会话的入口检查

```bash
curl --fail --silent --show-error https://gateway.example.com/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://gateway.example.com/session/status
ssh root@vps.example.com 'cd /srv/reach-current/deploy && docker compose ps'
launchctl print "gui/$(id -u)/com.example.reach-engine"
```

预期：公网健康响应协议为 `reach-rpc/1.0`，无认证状态查询返回 `401`，容器最终显示 healthy，Engine 有运行 PID。设备是否能处理请求仍需下一步验证。

## 3. 公网认证与文件 RPC

私有配置 `.reach/deployment.json` 由 [配置文档](configuration.md) 的示例生成，结构如下，占位符需替换为实际配置：

```json
{
  "gatewayUrl": "https://gateway.example.com",
  "engineId": "mac-engine-a",
  "controllerToken": "<当前Gateway的64字符Controller凭证>",
  "engineToken": "<当前Gateway的64字符Engine凭证>",
  "workspaceRoot": "/Users/example/.reach/workspace"
}
```

配置权限为 600。`workspaceRoot` 用于从验证机器直接核对真实文件；当前在 Engine 所在 Mac 执行。若在其他电脑运行该脚本，可省略此字段，仍验证远程 RPC，但不再提供本地文件落盘证明。

先保证 MCP 编译产物存在，再执行：

```bash
npm --prefix packages/grok-bot-mcp-connector run build
node scripts/verify-remote.mjs .reach/deployment.json
```

[verify-remote.mjs](../../scripts/verify-remote.mjs) 等待 ready 的预算为 60 秒，当前适合 15 秒心跳配置。若使用默认 120 秒空闲心跳，首次等待可能超过此脚本预算，需要先调整部署心跳或按环境调整验证器，不能直接把超时认定为认证故障。

| 检查组 | 验证内容 |
| --- | --- |
| HTTPS 健康 | 域名、有效证书、Gateway 协议 |
| 未认证拒绝 | 控制接口必须认证 |
| 凭证隔离 | Engine token 不能控制会话，Controller token 不能发送 Engine 心跳 |
| Engine 身份 | 正确 Engine token 搭配错误 ID 返回 403 |
| WSS ready | 真实 Mac Engine 建立会话 |
| 无 grant 写入 | `fs.write` 返回 `PERMISSION_DENIED` |
| 带 grant 读写 | 创建唯一文件，远程读取；可选本地逐字核对 |
| 文件查询 | `stat`、`list`、`glob`、`grep` |
| 编辑 | `oldString` / `newString` 替换与结果检查 |
| 工作区边界 | `../outside.txt` 访问被拒绝 |
| 续租 | 获得新的租约期限 |
| 关闭与重开 | 重新建立会话并读取原文件 |

输出逐项 `PASS`，成功后写入 `.reach/remote-verification.json`。失败会非零退出；旧报告可能仍存在，因此检查报告的 `checkedAt`，不要把上次成功当成本次通过。报告不包含 token。

脚本在 `default` 工作区创建 `deployment-tests/<UUID>.txt`，最后关闭自己打开的会话，保留测试文件。恢复验证依赖此文件，暂时不要清理它。

## 4. 安装后的 stdio MCP 验证

先完成 [MCP 安装](mcp.md)，然后在 Engine 所在 Mac 运行：

```bash
node scripts/verify-mcp-remote.mjs "$HOME/.config/reach/mcp.json"
```

[verify-mcp-remote.mjs](../../scripts/verify-mcp-remote.mjs) 从参数指定的客户端配置读取 `mcpServers.reach` 并启动真实安装入口，不使用源码入口代替安装产物。它仍固定读取仓库的 `.reach/deployment.json`；该文件必须含本机可读的 `workspaceRoot`，设备 JSON 的 `id` 必须与其中 `engineId` 相同。

此验证要求动态模式：初始化只见两个选择工具，选中设备后出现文件工具，关闭会话后恢复两工具。静态模式是正常受支持配置，但不满足这个验证器的断言，运行验证时应使用动态配置。

检查三组行为：初始化/设备选择/动态工具，真实文件写入读取编辑及 Mac 文件核对，关闭会话及工具列表复位。最后关闭 stdin 并检查子进程正常退出，成功报告为 `.reach/mcp-verification.json`，文件保留在 `mcp-tests/<UUID>.txt`。

该脚本证明已安装 Connector 可工作，不代表某个具体客户端已经完成配置导入。还需在目标客户端完成一次 `list_devices` → `pick_device` → 文件读取 → `session.close`。

## 5. 故障恢复验证

仅在维护窗口、没有其他活动会话且允许中断服务时运行：

```bash
node scripts/verify-recovery.mjs
```

[verify-recovery.mjs](../../scripts/verify-recovery.mjs) 是当前部署的专用验证器，固定 SSH 目标 `root@vps.example.com`、Compose 路径 `/srv/reach-current/deploy` 与 LaunchAgent label `com.example.reach-engine`。迁移部署不能只修改 JSON 就直接运行，需先适配脚本中的主机与服务路径。

前置条件：已有最新 `.reach/remote-verification.json`，对应测试文件未删除；Engine 在本机由 LaunchAgent 托管；SSH 已配置可用的免密访问。脚本会：

1. 建立会话并读取之前验收的文件。
2. 在活动会话中重启 VPS Gateway，等待恢复，再建立新 WSS 会话并读取文件。
3. 对 Mac Engine 发送 `SIGKILL`，确认 launchd 拉起不同 PID，再建立新会话并读取同一文件。
4. 关闭会话，写入 `.reach/recovery-verification.json`。

这证明进程恢复与文件持久性，不证明未完成 RPC 可以恢复或自动重放。Gateway 重启后旧 grant、旧 session 和内存去重记录都不会持久保存。

## 验收条件与报告保管

验收至少满足：有效 HTTPS、认证拒绝正常、Engine ready、真实文件读写与工作区边界通过、已安装 MCP 可使用。故障恢复属于额外可用性验收。

三份报告保存在 Git 忽略的 `.reach/` 中；可摘录无凭证的结果到发布记录。保存当次源码版本或构建产物 SHA-256，才能把测试结果关联到发布版本。测试目录由脚本保留，确认不再需要恢复验证后在 Engine 本机清理指定测试文件，不删除整个工作区。
