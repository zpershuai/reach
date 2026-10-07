## Context

本方案基于报告及当前源码核查，不采用报告评分作为缺陷证据。现有同步 Engine、固定 dispatch 安全顺序、session-owned process 和 EngineApi 边界应保留。

核查结果：
- D1–D13 的公开文档/规格缺口成立；`Permission.kind` 已存在于 Rust lib.rs 与 TS index.ts，问题是规格遗漏，不是字段尚未实现。
- process DTO 位于 Rust process.rs 与 TS process.ts，Rust 参数执行解析与 TS Zod 分散；需要共同 fixtures 锁住字节限制、默认值、null/未知字段及路径规范化。现有 Rust run 会规范化 script/cwd，TS 校验层暂不规范化，应明确执行层规范化与线层原值的区别，避免借重构改变 launchId 指纹。
- Gateway 大闭包、RemoteMcpServer 几乎全覆盖继承、双 initialized、workspace/process 大模块和两路取消状态属维护债；并无证据表明必须换架构。
- HTTP readBody 后 releaseReadPin 到 enqueue 没有 await；enqueue 同步增加 queued，release 同步刷新 lastUsed。定时 sweep 无法在同步段插入，报告的残余 idle 竞态不成立。真正 DELETE/shutdown 可导致合法 retirement，应保留 requireActive 和读取期间 pin。
- HTTP 无 session 的 close 是幂等成功，不是误关漏洞；可以用附加字段改善可解释性。
- Execute/Control 的 write_claimed=false 是当前授权表示方式，不是绕过；授权函数已有 kind 检查，但单元覆盖不足。
- copy-mcp-core 仅 copyFileSync，无构建后内容与完整 flat dist 运行校验；parse_params 有 Value→JSON→parse 往返。
- 8MiB 启动入口检查有界且在串行执行面上；暂不改调度并发，防止改变授权/launchId/关闭顺序。

## Goals / Non-Goals

**Goals:** 修正文档与契约；统一 DTO 和取消语义；改善模块边界、构建验证、授权覆盖和 close 结果；发布 patch。

**Non-Goals:** 引入 async、Actor、DI/插件框架、通用 Filesystem trait、schema 生成器或沙箱；自动重放 mutation/process.run；改变 64KiB REST 与 MCP 限制、408 已入队 mutation 语义、grep 子串或 gitignore 子集；删除兼容 job.done/session.complete；操作真实部署。

## Decisions

1. 文档按代码修正。D1/D2/D9/D12 对应根 README；D3/D4 修正 connector 早期要求；D5/D6 更新生命周期；D7 描述已有 permission.kind；D8/D10/D13 更新 deploy/package/configuration；D11 新增 reach-processes 插件技能，写清授权、同 session 同 launchId 查询、不可自动重跑、关闭即终止。公开例子使用保留域名和通用设备 ID。
2. process 线层 DTO 移至共享契约模块（Rust 可由 lib.rs re-export；TS index.ts re-export）。process.ts 保留兼容 re-export 及执行授权策略；ProcessManager 只保留执行状态。保留 strict process params 与宽容 fs 参数的区别；`from_value` 必须复用语义校验，不能仅反序列化后跳过范围检查。拒绝全仓 schema 生成器方案，降低迁移面。
3. Gateway 提取 EngineSessionState 与 SessionRpcForwarder，保留 createGateway/createEngineGateway、EngineApi 和路由行为；分别迁移租约/ready/ownership 与 RPC 去重/deadline/grant，不将固定安全顺序插件化。
4. MCP 用共享协议分发和 GrantAwareInvoker 组合；stdio 单选和 HTTP 多设备所有权表各自持有。协议初始化与 HTTP initialized 通知阶段明确区分，保证每个阶段只有一个权威来源。保持 stdio 名称、静态模式、通知和独立发行布局。
5. Rust workspace 按 path、Unix I/O、cursor、walk/glob、read/mutate 拆内部模块；process 按 policy、spawn、supervision、logs 拆分，状态枚举只表达现有状态转换。统一取消 Flag/Token，保留跨线程 acquire/release 和会话开始 reset；清理入口幂等，保持 worker drain 与子进程组退出后再释放所有权。按 mutex invariant 判断 poisoning 策略，不能把所有 unwrap 机械替换为恢复继续执行。
6. 授权维持 Read/Write/Execute/ProcessControl 的显式匹配，补完整矩阵。轻量 FnTool 仅在保留每方法 descriptor、deadline 和写上下文校验时用于消除重复；无收益的抽象不落地。
7. HTTP session_close 保留 closedDeviceId，附加 `closed: boolean`、`owned: boolean`；实际成功关闭自己会话返回 true/true，无会话 noop 返回 false/false，他人会话仍 ENGINE_BUSY。失败不伪造成功，也不关闭替代会话。
8. 拷贝后逐文件字节比较并在临时独立安装布局验证 stdio 初始化/工具表/版本，确保共享模块拆分后的依赖闭包仍可运行。保持 flat dist 兼容，本次不废弃拷贝。
9. patch 版本为 Engine 0.2.1 / Gateway 0.3.1 / MCP 0.3.1；同步 Cargo.lock、npm lockfile、文档当前版本及产物。历史 archive 不改写；reach-rpc/1.0、MCP 协议和 Node runtime 不变。

## Risks / Trade-offs

- [安全 I/O 拆分可能改变 no-follow/commit 边界] → 先纯移动再简化，复跑 symlink/FIFO/revision/deadline/cursor 回归。
- [共享 DTO 默认值或规范化影响 launchId] → fixtures 区分 wire roundtrip 与执行参数规范化，保留指纹和 spawn 失败重查语义。
- [MCP 组合破坏独立 connector 安装] → 构建内容断言加独立布局 smoke 验证。
- [取消统一或进程锁策略误放存活任务] → 覆盖 close/lease expiry/disconnect/shutdown 的 drain 和进程组终止，不吞掉状态损坏。
- [范围横跨多个模块] → 分阶段小步，迁移一层即运行对应现有测试，最终完整 verify。

## Migration Plan

先补契约/回归，再拆分，最后同步文档与 patch。执行 `bash scripts/verify.sh`，另验证三个 CLI --version、MCP serverInfo/get_versions 和 Gateway health/status/Engine ready 的产物来源。仅生成可交付代码和产物，不自动安装或重启服务。回滚使用先前组件产物及其版本 JSON，无持久化数据迁移。

## Open Questions

无阻塞问题。模块具体文件名和 FnTool 是否带来净简化由 apply 阶段按代码决定，保持此处约束并记录最终选择。
