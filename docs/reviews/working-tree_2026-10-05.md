# 代码审查报告

## 提交信息

本次审查对象是 **未提交的工作区 diff**，不是一次 Git commit。

- **基线 Commit ID**: `33932de`
- **完整 Hash**: `33932de8884c61ef4936b9932011afd87f80f724`
- **基线提交信息**: `chore: move round-5-mcp-connector into the OpenSpec archive.`
- **基线日期**: 2026-09-10 12:56:55 +0000
- **审查日期**: 2026-10-05
- **范围**: `git diff HEAD` 的 32 个已修改文件 + 8 个未跟踪文件

## 变更概览

- 变更文件数: 32 修改 + 8 新增（约 +1032 / −380，另含未跟踪源文件）
- 主要变更内容简述:
  - Engine：绝对 `deadlineAt`、会话控制车道（`execution.rs`）、lease 上限、loopback 传输约束、可消费的生命周期事件缓冲
  - Workspace：Unix `openat`/`NOFOLLOW` 描述符相对遍历、FIFO 非阻塞拒绝、目录条目/深度上限、协作取消
  - Gateway：session intent 绑定、单一 RPC deadline 盖戳、grant 抽到 `GrantStore`、canonical `tool.call`
  - MCP connector：session 恢复、HTTP 超时、设备切换 drain、不确定写不重放、stdio EOF shutdown
  - OpenSpec 与测试随契约一起更新

## 代码质量评估

### 1. 正确性

- 评分: 5.5/10
- 加固方向正确，但有多条会在真实路径上出错的逻辑：
  1. 任意 `DEADLINE_EXCEEDED` 被升级为拆掉整个 session，排队中的其他请求会被丢掉。
  2. Engine 以 `type=error/DEADLINE_EXCEEDED` 完成 RPC 时，Gateway **不**把 `requestId` 记入 `timedOutRequestIds`；socket 关闭后 `seenRequestIds` 被清空，同 id 重试可以二次提交。
  3. MCP `selectDevice` / `DEADLINE_EXCEEDED` 清选择时不 close Gateway session，随后 `open` 会 409 卡死直到 idle/lease。
  4. 新 connector 把 Gateway 第一次给出的不同 `sessionId` 当成“被替换”，随后 `close()` 因 id 不匹配拒绝释放。
  5. 成功的 mutation 在 `execute()` 之后若观察到 cancel/deadline，会被改报成失败。
  6. Gateway HTTP 400/409/503 被 MCP 当成 uncertain transport，整段 session 被关掉。

### 2. 安全性

- 评分: 8/10
- 这是本轮最强的部分：plaintext Gateway 限制 loopback、DNS 解析后再校验全部地址、描述符相对 + `NOFOLLOW` 钉住目录、FIFO 不阻塞、非普通文件 fail-closed、grant 与 `tool.call` 规范化在授权前完成。
- 完整性缺口：`timedOutRequestIds` 只覆盖 Gateway `setTimeout` 路径，不覆盖 Engine 主动回报的 deadline。与第 5 点叠加后，已提交的 write 可被同 `requestId` 重放。
- `/session/open` 仍可覆盖 pending intent（单 Gateway 多 controller 互踩）。

### 3. 性能

- 评分: 8/10
- 事件缓冲封顶 1024 并真正 drain，修了旧 `drain_events` 只 clone 不清空的泄漏。
- 目录枚举 10_000、遍历深度 128、grep/read 8MiB 上限合理。
- grep 大文件一次 `read_to_end` 不协作取消，session close 可能被单文件读挡住（最多约 8MiB）。
- MCP 每次文件系统调用都打 `/session/status`，延迟可接受，不是热路径灾难。

### 4. 可维护性

- 评分: 7.5/10
- `GrantStore`、`canonicalizeInvocation`、`ExecutionControl` 把原先塞在 Gateway/Runtime 里的职责拆开，和 OpenSpec 同步，测试补了 deadline fixture、loopback、FIFO、grant 时钟、cursor 释放。
- 扣分点：deadline 在 dispatcher / execution / handle_session_message 三处各算一遍，语义不完全对齐；`expired()` 注释已过时；TS/Rust 错误码（`INVALID_UTF8` vs `denied()`）不一致。

## 代码优雅度评估

### 1. 设计模式

- 评分: 8/10
- 控制车道 + 单一 worker + 协作取消是合适的并发模型，没有把 workspace 做成跨线程共享可变。
- Gateway 用注入时钟的 `GrantStore` 修了旧 `Date.now()` 分叉。
- 略重：ExecutionControl 与 Dispatcher 重复计算 budget，session 关闭条件分散。

### 2. 可读性

- 评分: 7.5/10
- 关键路径有明确步骤注释（dispatch 1–8、commit 边界、handshake 不 brick）。
- `expired()` 把 cancel 混进 deadline，注释仍写 “at dispatch start”，读代码会误判。
- `openAndWait` 里 “Older Gateways…” 与实际 throw 条件互相矛盾。

### 3. 简洁性

- 评分: 7/10
- Gateway 删除了重复的 unwrap/`hasMatchingGrant`，值得肯定。
- `canonicalizeInvocation` 在 Gateway RPC 路径上调用两次（先校验再 `leafMutation`）。
- `handle_session_message` 在 `closure` 已处理超时之后，又把一切 `DEADLINE_EXCEEDED` 映射成 `RpcTimeout`，属于多余且有害的升级。

### 4. 命名规范

- 评分: 8.5/10
- `deadlineAt` / `GrantStore` / `wantedSessionId` / `ExecutionControl` / `DIRECTORY_TOO_LARGE` 与现有契约风格一致。
- `expired()` 名不副实（现在包含 cancelled）。

## 详细审查意见

### 文件: `packages/reach-rpc/src/gateway.ts`

- 位置: 约 667 行（pending RPC `resolve`）与 237–245 行（`setTimeout` / `noteTimedOutRequest`）
- 问题: Engine 对已提交的 write 回答 `type=error/DEADLINE_EXCEEDED` 并关 socket 时，Gateway 把它当成**正常完成的 RPC**（`pending.resolve`），**不会**写入 `timedOutRequestIds`。随后 `close` 清空 `seenRequestIds`。同 `requestId` 在下一 session 会被再次转发。
- 建议: 凡是 Engine 回报 `DEADLINE_EXCEEDED` / `SESSION_CLOSED`、或即将因 rpc timeout 拆 session 的 requestId，都走 `noteTimedOutRequest`。注释写明的“timed-out mutation cannot be retried”目前只对 Gateway 自己的 timer 生效。
- 严重程度: 高

失败路径：write 已 `renameat` → dispatcher 因 cancel/deadline 改报错误 → Engine 关 session → Gateway 当成功错误信封交给调用方 → 调用方用同一 `requestId` 重试 → 二次提交。

---

### 文件: `crates/reach-rpc/src/runtime/runtime.rs`

- 位置: 约 551–554 行（`handle_session_message`）
- 问题: dispatcher 返回的任意 `DEADLINE_EXCEEDED`（含排队已过期、Tool 更短的 `default_deadline`、调用方更早的 `deadlineAt`）都会 `Flow::Close(RpcTimeout)`，并触发 `execution.queue.clear()`。
- 建议: 仅在 `ExecutionControl` 的会话级 RPC timeout / lease / rotation / close 时拆 session。排队过期的请求只回 `DEADLINE_EXCEEDED` 并 `Continue`。
- 严重程度: 高

失败路径：

1. 请求 A 正在执行且未超时。
2. 请求 B 带着更短 `deadlineAt` 进入队列，排队期间过期。
3. A 成功返回。
4. B 在 dispatch 入口被拒绝 → session 被拆掉。
5. 队列中尚未执行的 C 被丢弃。

Spec「Expired queued mutation」只要求不跑 Tool 并返回 deadline，并不要求 teardown。

---

### 文件: `packages/grok-bot-mcp-connector/src/server.ts`

- 位置: `selectDevice` catch（约 176–179 行）；`callFilesystem` 约 198 行与 202 行；`closeSession` catch（约 232–234 行）
- 问题:
  1. `status()` / `close()` 抛错时只 `clearSelection()`，不释放 Gateway session。
  2. `DEADLINE_EXCEEDED` / `SESSION_CLOSED` 同样只清选择。Gateway **本地**拒绝已过期 RPC（`gateway.ts:543`）时 Engine session 仍是 ready，下一发 `pick_device` → 409 `session already active`；`close()` 再因 sessionId 不匹配拒绝，session 孤儿到 idle。
  3. `post()` 对 HTTP 400/409/503 抛错，catch 当成 uncertain transport：关掉 ready session 并摘掉 dynamic tools。缺 `mode`/`content` 的 `fs.write`（`leafMutation` 抛）会变成整段重启，而 `type=error INVALID_PARAMS` 却留在活 session 上。
- 建议: 信封级错误与 HTTP 参数错误不要 close session；只有 transport/timeout 才 drain。`clearSelection` 的 deadline/closed 分支先 `gateway.close()`。catch 里对 `previous` 做 best-effort close。
- 严重程度: 高

---

### 文件: `packages/grok-bot-mcp-connector/src/gateway.ts`

- 位置: `openAndWait` 约 49–51 行
- 问题: 客户端先生成 UUID，一旦 `status.sessionId` 存在且不等于该 UUID 就 throw。注释写「旧 Gateway 在 wanted 期间不暴露 sessionId」，但旧 Gateway 在 heartbeat 之后会给出**自己生成的** id，adopt 那一行永远走不到。
- 建议: 尚未绑定过 id 时 adopt Gateway 给出的 id；只在已经观察过一个 id 之后发生变化才报 “replaced”。同仓库一起发布则不是生产 blocker，但和注释/文档冲突。
- 严重程度: 中（混版本为高）

---

### 文件: `crates/reach-rpc/src/dispatch/dispatcher.rs`

- 位置: 约 120–127 行
- 问题: `tool.execute` 已经 `Ok` 后，若 workspace 已 cancelled 或 `expired()`，成功结果被改写成 `SESSION_CLOSED` / `DEADLINE_EXCEEDED`。`handle_session_message` 在 `outcome.closure` 有值时同样丢弃 `Ok(result)`。
- 建议: spec 允许越过 commit 边界的 mutation 跑完。至少不要把已经成功的结果改报失败；由上层按 uncertain 处理。Connector 不自动重放是对的，但 Agent 按错误重试仍可能双写。
- 严重程度: 中

附带：`InvocationContext::expired()` 现在包含 `is_cancelled()`，注释仍说 “deadline window at dispatch start”。只看 `expired()` 的 Tool 会把 close 误报成 deadline。`check_deadline` 先看 cancel 是对的。

---

### 文件: `packages/reach-rpc/src/gateway.ts`

- 位置: `openSession` 约 268–276 行
- 问题: 无 live session 时，新的 `/session/open` 直接覆盖 `wantedSessionId` 并清空 `pendingSession`。close/renew 对错误 id 回 409，open 却 last-writer-wins，正在进行的 heartbeat token 作废。
- 建议: 已有 wanted/pending 且传入不同 `sessionId` 时 409；相同 id 视为幂等。spec 目前只约束 stale close，这是契约缺口。
- 严重程度: 中（单 controller 部署为低）

---

### 文件: `crates/reach-rpc/src/workspace.rs`

- 位置: grep 回调内 `read_to_end`（约 509–513 行）；`descriptor_read_file` UTF-8 映射；`stat`/`read` 错误码
- 问题:
  - grep 大文件一次读完，不按 64KiB 检查 cancelled，与 `read_regular_file` 不一致。
  - 读目录由 `FILE_NOT_FOUND` 变为 `WORKSPACE_ACCESS_DENIED`。
  - mutation 路径非 UTF-8 仍 `denied()`，`fs.read` 则是 `INVALID_UTF8`。
  - 非 Unix 平台全部 fail-closed（spec 要求，若曾支持 Windows 则是平台回归）。
- 建议: grep 复用 `read_regular_file`；UTF-8 错误码对齐；目录误读保持 `FILE_NOT_FOUND` 或在 spec 写明。
- 严重程度: 低–中

---

### 文件: `crates/reach-rpc/src/runtime/execution.rs`

- 位置: 约 100 行（控制车道 `serde_json::from_str` 失败 → `PolicyError`）；约 63–83、105–115 行
- 问题: Tool 执行期间收到截断的 WebSocket 文本或垃圾帧，`from_str` 失败会直接 `PolicyError`，取消 in-flight worker、丢掉队列并结束 session。形态正确但未知的消息只回 `INVALID_PARAMS` 并继续（约 130 行）。默认 `rpc_deadline` 30s < `idle_timeout` 300s，长 Tool 不会被 idle 误杀；配置反转时执行中的 Tool 会被当成 idle。
- 建议: 控制车道非法 JSON 与空闲路径对齐（回 `INVALID_PARAMS`，不拆 session）。idle 在 worker 运行时应视为活跃。
- 严重程度: 中（非法 JSON）/ 低（idle 配置）

---

### 文件: `crates/reach-rpc/src/workspace.rs`

- 位置: 约 1121 行（`walk_file_entries` 对非普通文件 `denied()`）
- 问题: `readdir` 把某项标成普通文件后、`open_child` 前若被换成 FIFO/目录/symlink，整个 `fs.glob`/`fs.grep` 以 `WORKSPACE_ACCESS_DENIED` 失败。旧实现对非文件是 skip 后继续；并发 writer 现在可以 DoS 搜索。
- 建议: 钉住的父目录下 `open`/`metadata` 失败或非普通文件时 skip 该项，只在确认读到 workspace 外时才 fail-closed。
- 严重程度: 中

---

### 文件: `packages/reach-rpc/src/workspace.ts`

- 位置: 分页返回（约 292–297 行）
- 问题: 无。这是修复：旧逻辑在 `!more` 时把 `cursor` 赋成 `undefined`，exhausted snapshot 从不 `delete`。Rust `page()` 本来就会 `remove`。
- 建议: 保持；测试 `completed pages release snapshots` 应保留。
- 严重程度: （正面修复）

---

### 文件: `packages/reach-rpc/src/grants.ts`

- 位置: `matches()`
- 问题: 匹配时不再二次 `normalizeWorkspacePath(grant.path)`。Gateway `issue` 前已经规范化，生产路径安全；防御纵深略减。
- 建议: `matches` 对 grant 路径再 normalize 一次，或断言 store 内路径已规范。
- 严重程度: 低

## 总体评分

| 维度 | 评分 | 权重 | 加权得分 |
|------|------|------|----------|
| 正确性 | 5.5/10 | 25% | 1.38 |
| 安全性 | 8/10 | 20% | 1.60 |
| 性能 | 8/10 | 15% | 1.20 |
| 可维护性 | 7.5/10 | 20% | 1.50 |
| 优雅度 | 7.8/10 | 20% | 1.56 |
| **总分** | | | **7.2/10** |

优雅度取设计模式 / 可读性 / 简洁性 / 命名的算术平均：`(8 + 7.5 + 7 + 8.5) / 4 = 7.75`，表中记 7.8。

## 总结与建议

- 优点:
  - 安全边界明显收紧：loopback、描述符相对遍历、FIFO、grant/canonical 前置。
  - 绝对 deadline 从 Gateway 盖戳到 Engine monotonic 转换，思路清楚。
  - 控制车道让 close/renew 不必等 Tool 结束才被看见。
  - Grant 注入时钟、TS cursor 泄漏、事件缓冲真正消费，都是具体的旧债清理。
  - 测试覆盖了 deadline fixture、loopback 变体、FIFO、session binding、connector 恢复、不确定写不重放。

- 待改进（建议按此顺序）:
  1. **高** Engine 回报的 `DEADLINE_EXCEEDED`/`SESSION_CLOSED` 必须记入 `timedOutRequestIds`，否则同 id 可二次提交。
  2. **高** 不要把单请求 `DEADLINE_EXCEEDED` 升级成拆 session。
  3. **高** MCP 清选择时必须 close；HTTP 400 不要当 uncertain transport。
  4. **中** 已成功的 mutation 不要改报失败。
  5. **中** 旧 Gateway：首次出现的 sessionId 应 adopt；`close()` 不能在 mismatch 时把别人的 intent 留着也不放自己的。
  6. **低/契约** `/session/open` 与 close/renew 对齐；grep 协作取消；walk 遇非文件 skip 而不是整次失败。

- 总体评价:
  这是一轮目标明确的加固，传输与 FS 安全边界明显好于基线，不应当作“有问题就整批打回”。真正的合入风险在 session/RPC 生命周期：Engine 见 deadline 就拆会话、Gateway 的“超时不可重试”只覆盖 timer、MCP 见错误就丢引用。这三处叠在一起，已提交的 write 既可能被报失败，也可能被同一 `requestId` 再执行一次。建议修完前三项再合入。

审查结论：**有条件通过**。不修改代码；本报告仅分析。复核时并入了独立 code-review 子任务的 10 条 finding。

## 问题复核与修复记录

以下内容在原审查之后补充，并覆盖复核期间新增的 finding。上面的评分和结论描述修复前的工作区，保留原文；本节记录逐条源码复核和已完成的修改。

| 审查意见 | 复核结论 | 处理结果 |
|---|---|---|
| Engine deadline/closed 错误没有跨会话保护 requestId | **成立，高优先级** | Gateway 将 Engine 的 `DEADLINE_EXCEEDED`、`SESSION_CLOSED` 以及断开时尚未收到回复的请求记入有界保留集合，与自身 timer 超时采用相同去重保护。后续 session 不再转发同 ID。 |
| 任意 `DEADLINE_EXCEEDED` 拆掉 Engine session | **成立，高优先级** | 移除按错误码关闭会话的分支。Dispatcher 负责请求截止时间，ExecutionControl 只用 Engine 硬执行上限决定 RPC 超时拆会话。过期的排队 B 不执行，也不丢弃后续 C。Gateway 的较短调用方截止时间原来也会拆会话，已同时修复。 |
| MCP 失败后清选择、丢失仍存活的 session | **成立，需区分路径** | 状态查询或关闭失败时尝试 drain；仍失败则保留 `uncertain` 客户端、隐藏动态工具，下次选择先 drain 再 open。请求级 deadline 保留健康选择；`SESSION_CLOSED` 触发清理。原 `closeSession` catch 本身保留选择，并未清空，本次统一其失败恢复行为。 |
| HTTP 400/409/503 均被视为不确定执行并拆会话 | **成立，但不能一律保留所有 HTTP 错误** | 增加带 path/status 的 `GatewayHttpError`。参数错误、超大请求、重复 ID、队列满等明确的转发前拒绝保留会话；转发超时或 session 不存在仍清理。不能仅凭 503 判断执行结果确定与否。真实 Rust Engine 链路验证了无效 write 不会关闭会话，随后合法 write 可继续执行。 |
| 新 Connector 无法使用旧 Gateway 生成的 ID | **成立，混版本兼容问题** | 有 open 回复 ID 时立即绑定并严格校验后续状态；旧 Gateway 的 open 回复不含 ID 时，允许首次观察到 Gateway ID 后绑定，之后再变化仍报 replaced。缺失 ID 的异常状态属于不确定，不能当成确认失去所有权。已确认 ID 被替换时只释放旧本地引用，拒绝关闭替代会话是正确行为；旧 Gateway 仍要求单 controller。 |
| 已提交成功的 mutation 被改报关闭或截止时间错误 | **成立** | Write-class Tool 成功后保留结果和 revision，不再做事后失败改写。Runtime 在 drain 时也尝试发送成功结果，再完成会话关闭。传输已断开时仍可能无法交付，不能保证调用方总能收到成功。 |
| `/session/open` 覆盖 wanted/pending intent | **成立，契约缺口** | 不同显式 ID 返回 409；同 ID 重试保持原 token、token 到期和 lease。无 ID 的旧单会话 API 重试也保持已有 intent。 |
| grep 不分块检查取消；文本和目录错误码不一致 | **成立** | grep 与整文件读取共用 64 KiB 分块读循环，并检查取消和截止时间，扫描行时也检查。Rust 文本读取及 mutation 预读统一为 `INVALID_UTF8`，TS 参考实现使用严格 UTF-8 解码；读取目录保持 `FILE_NOT_FOUND`，FIFO 等特殊文件仍拒绝访问。 |
| Tool 执行期间的非法 JSON 处理与空闲路径不一致 | **不成立，建议描述的空闲行为有误** | 空闲路径的 `handle_session_message` 同样在 JSON 解析失败时返回错误，外层 drive 转为 `PolicyError` 并关闭会话。两条路径对顶层非法 JSON 一致；形态正确但参数无效的消息仍可回 `INVALID_PARAMS` 后继续。保持现有协议策略。 |
| 执行中的 Tool 在较短 idle 配置下被取消 | **成立，非默认配置可触发** | Engine 执行期间不计为 idle，worker drain 后重置 idle 窗口；Gateway 有 pending RPC 时也计为活跃。Lease、rotation、硬执行超时继续生效。 |
| 搜索时子项并发消失/变型导致整个查询失败 | **成立，修复时保留安全边界** | 对钉住目录内的 `ENOENT`、`ENOTDIR`、`ELOOP` 和打开后类型不匹配跳过该子项；目录枚举 stat 时消失的条目也跳过。grep 回调直接使用已钉住的文件，不再按名字重新 open。根路径验证及其他 I/O、权限、截止时间、取消错误仍上报，不采用“所有错误都 skip”的宽泛建议。 |
| TS 游标释放 | **不是问题，是正确修复** | 保留实现和 exhausted cursor 回归测试。 |
| `GrantStore.matches` 不再二次规范化存储路径 | **生产路径不是漏洞，可加强入口不变量** | Gateway 原本已经规范化，且 store 是私有 Map。本次在 `GrantStore.issue` 确保路径规范化并拒绝非法路径，复制方法列表，防止调用方修改数组影响已签发 grant；匹配无需重复规范化已受控数据。 |

非 Unix 平台 fail-closed 是已有明确规格要求，本次没有改成路径回退。TS mutation 参考实现仅在 Linux 支持目录描述符访问，macOS 上仍拒绝；生产 Rust Engine 的 Unix 描述符实现在本地 macOS 测试通过。

另外，`InvocationContext.expired()` 已只表示单调时钟截止时间，新增独立 `cancelled()`；旧注释已更新。Gateway RPC 授权复用一次 canonical invocation，删除重复解析。关闭测试使用有界状态等待，避免客户端 close 事件先于服务端清理造成偶发失败。主规格和 README 已同步上述语义。

### 验证结果

`bash scripts/verify.sh` 完整通过，共 **169** 项测试：Rust **88**、Gateway/协议/TS 参考实现 **56**、MCP Connector **25**，无失败。Rust 格式检查、`git diff --check` 和两组 Rust Serde / TypeScript Zod fixture round-trip 通过。

关键回归覆盖实际文件写入、排队请求截止时间隔离、提交结果与关闭竞争、硬执行上限、活跃期间短 idle、待连接 token 重试、Engine 错误及丢失回复的跨会话去重、失败 drain 的后续恢复、混版本身份获取、HTTP 请求拒绝与不确定结果区分、FIFO/目录/symlink 并发替换，以及 Connector → Gateway → 真实 Rust Engine 的完整调用链。

确认成立的缺陷均已处理。协作取消仍无法强制中断已经阻塞的系统调用；已提交但响应丢失的 mutation 仍需调用方核对 revision，Connector 不自动重放。跨会话去重是有界内存保护，不保证进程重启或记录淘汰后的 exactly-once。
