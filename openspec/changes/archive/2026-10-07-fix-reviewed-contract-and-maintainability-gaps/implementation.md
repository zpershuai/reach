# 实施记录

## 审查结论与处理

- D1–D13 已按当前代码修正文档与主规格；插件增加 reach-processes，说明目标 Engine、默认关闭、授权、launchId 恢复及 session-owned 生命周期。
- permission.kind 原本已经在两端实现，本次补齐规格并修正 Rust 对未知 kind / null kind 的接收验证。客户端 kind 是提示，Gateway 依据实际 grant 的分类生成可信转发声明；现有测试覆盖客户端填 control 而实际 execute grant 仍转发 execute，保持兼容。
- process 参数与结果分别集中在 process_contract.rs / process-contract.ts，由执行模块兼容 re-export；共享 fixtures 覆盖五方法、结果、默认值、Unicode 字节边界、null/未知参数、范围、selector 和 permission。process.run 线层保持路径原值，执行阶段 normalized 后做指纹，既有幂等行为不变。
- Gateway 提取 EngineSessionState 与 SessionRpcForwarder；MCP 使用 McpProtocol 与 GrantAwareInvoker 组合，stdio 单选与 HTTP 多设备所有权独立。HTTP 初始化通知状态由协议对象持有。
- workspace 拆分 path、io_unix（包含非 Unix fail-closed 桩）、cursor、walk、glob、ops_read、ops_mutate；process 拆分 policy、spawn、logs、supervision，保留 facade。
- 同一 Flag/Token 贯穿会话控制与工作区检查，删除 session bool 双轨；新会话 reset，结束 cancel，process drain 失败显式移交 Runtime 保留所有权，Drop 清理游标。
- 进程 mutex 损坏后 RPC fail-closed；supervisor 仍 kill/reap，collector 不继续修改不可信日志，drain join 后保留损坏记录并返回 PROCESS_CLEANUP_FAILED。信号阶段用枚举表达。
- HTTP close 保留 closedDeviceId，补 closed/owned；有自有会话 true/true，无会话 false/false，他人/替代会话仍 ENGINE_BUSY。
- 构建拷贝逐文件比较，新拆出的 protocol/invoker/result 纳入安装闭包和独立发行 smoke；已有安装文件路径保持兼容。

## 非缺陷与保留限制

- read pin→enqueue 之间没有 await，enqueue 同步增加 queued，release 同步刷新 lastUsed，idle sweep 不能插入；保留读期间 pin 与 requireActive，覆盖慢读、TTL、DELETE、shutdown 和队列回归。
- Execute/Control 的 write_claimed=false 是分类表示，不是绕过；补完整授权矩阵而不将安全顺序插件化。
- 64KiB MCP/REST 入站限制与内部信封不同；408 不取消已入队 mutation；grep 为子串、gitignore 为子集；保持现有恢复语义。
- process 入口读有 8MiB 上限，保留串行调度，避免改变 launchId/授权/关闭顺序。
- FnTool 未引入：具名 Tool 保留直接调用授权防线与每方法 descriptor；read/stat 的只读借用、分页的可变借用和 mutation 的 deadline/权限分支不同。已共享参数校验与错误映射，再加泛型适配需要保留七个兼容具名入口，增加包装而未改善安全审查。
- 未使用 SESSION_NOT_READY 或单一 Serial 策略不构成当前路径缺陷，保留兼容符号，不引入提前并发。

## 版本与验证

Engine 0.2.1；Gateway/MCP 0.3.1。同步 Cargo/npm lockfile、当前版本文档和构建产物；协议、Node runtime 与历史 archive 不变。

`bash scripts/verify.sh` 全部通过：Node runtime 安装测试 7 项、launcher 4 项、插件 3 项、Rust 105 项、Gateway/MCP 86 项、connector 38 项、两份 fs.read roundtrip、48 组 process 跨语言 fixtures、独立 MCP distribution smoke。后续小幅整理已针对 Rust、Gateway/MCP 和真实 Engine 集成重新验证。

实际 CLI 产物输出：engine 0.2.1、gateway-main.js 0.3.1、MCP main.js 0.3.1。真实 Engine 集成断言 MCP serverInfo/get_versions，Gateway health/status 及 heartbeat/ready 版本均来自实际产物。OpenSpec strict validation 和 git diff --check 通过。本机验证环境为 macOS；非 Unix DTO 不依赖平台进程 API，但未交叉运行 Windows 构建。此次只修改仓库与临时测试产物，不安装或重启任何真实服务；公开例子仅使用通用标识与保留地址。
