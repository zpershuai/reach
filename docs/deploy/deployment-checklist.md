# 部署检查清单

此清单用于任意部署环境。实际主机名、账号、内网地址、设备清单、服务状态、构建摘要与备份位置应记录在部署者自己的私有目录，例如 Git 忽略的 `.reach/`，不提交到公开文档。

## 配置与安装

- 配置 Gateway 的 HTTPS URL、Controller token 和每台 Engine 独立的 Engine token。
- 为每台设备选择唯一 Engine ID 和明确的工作区边界。
- 检查凭证文件权限、Git 忽略规则和 Docker 构建上下文。
- 使用与设备架构匹配的二进制，安装私有 Node runtime。
- 选择 LaunchAgent、systemd 或 procd 托管 Engine，并检查启动策略。
- 配置 MCP 的设备别名、`engineId`、Gateway URL 和私有设备文件。
- HTTP MCP 插件配置 HTTPS `/mcp` URL 和私有 Controller token。接入时核对实际客户端是否发送 `Origin`；若发送，将观察到的完整 Origin 配入 `REACH_MCP_ALLOWED_ORIGINS`，若不发送，保留空配置。不要使用通配符或关闭 Origin 检查；核对请求头时不要保存或公开 Authorization。

## 验证

- Gateway 健康检查返回正确协议和组件版本。
- 未认证控制请求和错误角色的凭证被拒绝。
- 每台 Engine 可以建立会话并读写自己的工作区。
- 多台 Engine 的会话、grant 和 RPC 相互隔离。
- 工作区越界访问被拒绝，关闭一台设备会话不影响其他设备。
- 实际安装的 MCP 可以列出、选择设备并查询组件版本。
- HTTP MCP 生成含完整 HTTPS 地址的私有插件副本，运行验证脚本，并在实际 Grok Bot 宿主中确认 token 私有存储、Origin 配置、列设备和读取已知文件；交互场景检查 Gateway 已加载 15 秒心跳配置。
- 验证后关闭自己创建的会话。

运行方式见 [部署验证](verification.md)。测试文件和报告保留在私有目录，公开发布记录只描述通用功能与测试结果。

## 升级与恢复

- 升级前备份程序、配置、设备注册表与工作区。
- 记录目标版本和产物摘要，保留可恢复的旧版本。
- 升级后重新检查真实文件 RPC；维护窗口内按需验证进程恢复。
- 回滚程序时同步检查配置兼容性，文件工作区单独恢复。

操作流程见 [运维与回滚](operations.md)。
