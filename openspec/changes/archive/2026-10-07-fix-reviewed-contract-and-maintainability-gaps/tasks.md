## 1. 文档与现状核对

- [x] 1.1 按 design 核对 D1/D2/D9/D12，修正根 README 心跳变量归属、shutdown、process 动态工具与 API 表。
- [x] 1.2 修正 D8/D10/D13 的 deploy 总览、reach-rpc README 控制 API、configuration grant 分类，补充 grep 子串/gitignore 子集与 408 恢复语义的准确说明。
- [x] 1.3 按 delta 修正 connector 早期工具列表、permission.kind、edge Purpose 与 filesystem 正常关闭场景（D3–D7）；不改写历史 archive。
- [x] 1.4 新增插件 reach-processes 技能并从设备/文件/健康指引交叉引用，更新 connector README 与 mcp.md 的 process 列表（D9/D11），运行插件现有验证。

## 2. 共享契约与参数验证

- [x] 2.1 提取 Rust process 参数/结果到可跨平台使用的共享契约模块，保留兼容 re-export 与执行层路径规范化。
- [x] 2.2 从 TS index.ts 暴露 process 参数/结果类型及 schema，让 Gateway/MCP/process 模块复用；ProcessPermission 使用共享 Permission。
- [x] 2.3 校对两端 permission.kind 对 execute/control 的接受规则，覆盖未知 kind 和空 grant，保持授权分类及未知 envelope 字段兼容。
- [x] 2.4 增加五方法参数与 task/log/list 结果的跨语言 fixtures，包含默认值、null、未知字段、Unicode 字节边界、无效范围及 selector，接入验证脚本。
- [x] 2.5 用 from_value 消除工具参数 JSON 文本往返，共享语义校验；验证范围检查、错误码、路径规范化和 launchId 指纹不变。

## 3. 授权与生命周期回归

- [x] 3.1 补 Read/Write/Execute/ProcessControl 对缺失/空/正确/错误 kind 的授权矩阵，保留 Gateway scope 校验和 Engine 二次授权职责。
- [x] 3.2 在 default_registry 测试中断言 Unix 五个 process 方法及非 Unix 能力边界。
- [x] 3.3 增加或复用 HTTP 慢读跨 idle sweep、同步 pin→queue 交接、DELETE/shutdown 与入队的回归；保持 requireActive，记录原报告残余竞态不成立，不以无证据竞态引入行为变更。
- [x] 3.4 HTTP session_close 附加 closed/owned 字段，覆盖自有关闭、无会话 noop、他人会话与 stale ownership，保留 closedDeviceId 和失败恢复行为。

## 4. Gateway 与 MCP 边界

- [x] 4.1 提取 Gateway EngineSessionState，保留 lease、ready、rotation、ownership 和关闭顺序，运行 Gateway 会话回归。
- [x] 4.2 提取 SessionRpcForwarder，保留 canonicalization→authorization→forward 固定顺序、去重、deadline、grant 与 EngineApi 公共接口。
- [x] 4.3 从 McpServer 提取共享协议分发与 grant-aware 调用，以组合迁移 stdio 单选实现，保留动态通知和静态兼容模式。
- [x] 4.4 以组合迁移 RemoteMcpServer 多设备所有权表，明确协议初始化与 HTTP initialized 通知状态；覆盖隔离、失败 drain 与不重放。
- [x] 4.5 copy-mcp-core 构建后逐文件验证内容，处理新增模块依赖闭包；在隔离安装布局验证 stdio initialize、工具列表和版本，保留 flat dist 兼容。

## 5. Rust 模块与取消清理

- [x] 5.1 将 workspace 路径和 no-follow Unix I/O 移入内部模块，保留 facade；复跑 symlink/FIFO/特殊文件/8MiB 边界回归。
- [x] 5.2 将 workspace cursor、walk/glob、read/mutate 分模块，保留分页、revision、commit 与 deadline 边界，复跑工作区测试。
- [x] 5.3 提取 process policy/spawn 内部模块，保留私有 Node、env_clear、workspace pin 和 launchId 幂等行为。
- [x] 5.4 提取 process supervision/logs，显式表达监督状态，逐个判断 mutex poison 的安全处理；验证超时/stop/日志上限和进程组退出。
- [x] 5.5 用统一 Flag/Token 替代 session bool 与工作区 AtomicBool 双轨，明确 reset 与幂等 drain 的所有权；复跑 close/lease expiry/disconnect/shutdown 的 worker/process/cursor 清理回归。
- [x] 5.6 审视 fs Tool 样板，仅在减少重复且保留 descriptor/授权/deadline 的前提下引入轻量 FnTool；记录采用或不采用的具体理由。

## 6. Patch 发布与验收

- [x] 6.1 Engine 递增至 0.2.1，Gateway/MCP 至 0.3.1，或基于更新后的当前版本取更高 patch；同步 Cargo/npm lockfile 和当前版本文档，保留历史记录。
- [x] 6.2 构建并验证三个 CLI --version、MCP serverInfo/get_versions、Gateway health/status 与 Engine heartbeat/session.ready 的真实版本来源；协议和 Node runtime 版本不变。
- [x] 6.3 运行 bash scripts/verify.sh 及新增契约/独立分发验证，修复失败，记录实际结果与环境限制。
- [x] 6.4 对照报告逐项记录已修、非缺陷和保留限制；检查公开改动无私有部署信息，且未安装、重启或修改运行服务。
