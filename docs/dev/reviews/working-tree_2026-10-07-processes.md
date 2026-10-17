# 代码审查报告

## 提交信息

本次审查对象是 **未提交的工作区 diff**，不是一次 Git commit。只做审查，不修改代码。

- **基线 Commit ID**: `9a8f57d`
- **完整 Hash**: `9a8f57d0f412d358137afec88cef672253e2078f`
- **基线提交信息**: `feat: generate private Grok plugins with literal MCP URLs`
- **基线日期**: 2026-10-07 14:47:19 +0800
- **审查日期**: 2026-10-07
- **范围**: `git diff HEAD` 的 40 个已修改文件（+567 / −59）+ 15 个未跟踪文件（Engine ProcessManager、Gateway process grants、MCP 五工具、OpenSpec `add-workspace-node-processes`、部署文档）

## 变更概览

- 变更文件数: 40 修改 + 15 新增
- 主要变更内容简述:
  - Engine 增加 session 所有的 `process.run/status/logs/stop/list`：固定私有 Node、workspace 白名单默认空、launchId 去重、有界日志、进程组停止
  - 入口经 no-follow 描述符读成快照，内置 `process-bootstrap.cjs` 用 `registerHooks` + `runMain` 保模块身份；调用方不能选解释器 / flags / env
  - Gateway 增加 execute/control 两类 process grant，与文件系统 grant 互斥；HTTP 与 in-process 共用 `executeRpc`
  - MCP stdio（点号）与 HTTP（下划线）共用工具定义；观察类调用不打开替代 session；不确定的 `process.run` 保留 launchId
  - Engine 0.1.0 → 0.2.0，Gateway/MCP 0.2.0 → 0.3.0；协议与 bundled Node 不变

## 代码质量评估

### 1. 正确性

- 评分: 7.5/10
- 主路径对齐 OpenSpec：默认禁用、grant 不能放松本地策略、spawn 成功即提交、launchId 去重/冲突、status 按 launchId 恢复、观察调用不 `begin()` 新 session、session 生命周期 drain、非 Unix 不注册方法。
- 集成测试覆盖 HTTP/stdio 真 Engine、disconnect/lease/rotation/shutdown/idle，以及旧 Engine `PROCESS_UNSUPPORTED`。
- 会在真实路径上出错或误导调用方的问题：
  1. MCP 把 `process.run` 的 `DEADLINE_EXCEEDED` 一律写成「按 launchId 查询、不要重放」。Engine 在 **reserve 之前** 的失败（大入口读取、`REVISION_CONFLICT`、本地 disabled）若 RPC deadline 已过，会被 dispatcher 改写成 `DEADLINE_EXCEEDED`。此时没有记录，status 返回 `PROCESS_NOT_FOUND`，按文案则卡住。
  2. `spawn` 失败会先留下 `failed` 记录再返回 `RUNTIME_UNAVAILABLE`。调用方按错误码重试同一 launchId 时，第二次变成 **成功响应**，body 是 `state=failed`。
  3. HTTP MCP 的 `initialize.instructions` 被 `RemoteMcpServer` 覆盖，丢掉 trusted-code / launchId 恢复说明（tools/list 描述仍在）。

### 2. 安全性

- 评分: 8.5/10
- 这是本轮最强的部分，和「可信脚本、不是沙箱」的产品边界一致：
  - 默认 `REACH_PROCESS_WORKSPACES` 为空；未知 workspace 名在配置期拒绝
  - `env_clear()`，不继承 token / `NODE_OPTIONS` / `NODE_PATH`；argv 在 `--` 之后，调用方不能塞 Node flags
  - 入口/cwd 走现有 `NOFOLLOW` + 非阻塞打开，FIFO/非普通文件 fail-closed；快照哈希与 `fs.stat` 同一套 UTF-8 字节
  - execute/control grant 绑定 session + 精确 script + launchId / processId，文件系统 grant 不能授权执行，process grant 不能授权写
  - Engine 只信 Gateway 转交的 `kind`，自己再查白名单和归属
- 剩余风险是产品声明过的：脚本以 Engine 账号权限运行；`PATH` 含 `/usr/bin:/bin`；进程组管不住主动脱离的后代。文档写了，不要当沙箱卖。
- `--eval` 把 bootstrap 放在 cmdline 上，内容无密钥，可接受。

### 3. 性能

- 评分: 8/10
- `process.run` 在 spawn 后立即返回，监督/收管/stdin 写入在后台线程；status/stop 不跟脚本寿命绑在 RPC deadline 上。
- 日志按 1KiB 块收取、保留上限弹出最旧记录、单次 logs 16KiB；任务记录 128、并发 4。
- 扣分：入口读取仍在串行 dispatch 上，最大 8MiB，会挡住同一 session 的 status/stop（有界，但和「handlers 必须短」有缝）。每个任务 4 条线程，默认并发下可接受。

### 4. 可维护性

- 评分: 8/10
- OpenSpec、Rust/TS schema、MCP 描述、部署文档和版本号基本同步；grant / 生命周期 / bootstrap 都有对口测试。
- `process.rs` 把策略、spawn、日志分页、监督、信号处理堆在一个文件里，能读但密度高。
- `ifMatch` 在 Engine 侧手写 `Sha256` hex，没有复用 workspace 的 `revision_str`。现在与 UTF-8 文件一致；以后改 revision 算法这里会漂。
- HTTP 层继续继承 stdio `McpServer` 再 override `callTool`：process 观察语义靠分支，而不是共用所有权表。

## 代码优雅度评估

### 1. 设计模式

- 评分: 8.5/10
- `ProcessManager` 进 `InvocationContext`、session 拥有任务、Gateway 用判别联合 grant、MCP 观察路径禁止 `open`，边界清楚。
- 快照 + `registerHooks` + `runMain` 比 `/dev/fd` 当模块身份干净，也保住了 `require.main` / 相对导入。
- 略重：为了 SIGTERM 能打断 heartbeat sleep，在 `engine.rs` 里包了一层 100ms 轮询；handler 用老式 `signal()`。能工作，不是运行时里的一等生命周期。

### 2. 可读性

- 评分: 7.5/10
- 关键不变量有注释（fchdir 钉 inode、不要在 group signal 完成前 reap leader、快照写入不挡 RPC）。
- `run()` 从校验、reserve、spawn 到挂 worker 是一条长函数；`logs()` 的 cursor/offset/截断逻辑正确但要盯着看。
- `starting` 在成功路径上几乎不可见：insert 后立刻 spawn，返回时已是 `running`。

### 3. 简洁性

- 评分: 7.5/10
- 没有做 shell、sandbox、跨 session 认领，范围克制。
- bootstrap 是合理的额外零件；HTTP initialize 文案本可复用父类，却整段覆盖。
- ProcessTool 里 `context.access != descriptor.access` 在 authorizer 之后是恒真，属于防御性重复。

### 4. 命名规范

- 评分: 8.5/10
- `launchId` / `processId` / `PROCESS_EXECUTION_DISABLED` / `LAUNCH_ID_CONFLICT` 与 spec 一致。
- HTTP 下划线名、stdio 点分名沿用现有 MCP 约定。
- `write_claimed` 仍叫 write，但对 Execute 恒为 false，靠单独的 `access` 区分，读 authorizer 时要停一下。

## 详细审查意见

### 文件: `packages/reach-rpc/src/mcp/server.ts` 与 `crates/reach-rpc/src/dispatch/dispatcher.rs`

- 位置: MCP `callOnGateway` 对 `process.run` + `DEADLINE_EXCEEDED` 的改写（server.ts 约 270–273 行）；dispatcher 在非 Read 失败后若 `expired()` 则改报 deadline（dispatcher.rs 约 122–133 行）；`ProcessManager::run` 在 `process_entry` / revision 之后才 `launches.insert`（process.rs 约 337–371 行）
- 问题: 成功 spawn 的 commit 边界是对的。失败路径仍走「过期则 DEADLINE_EXCEEDED」。MCP 把该码当成「可能已经 launch，禁止重放」。reserve 之前的失败（8MiB 入口读、`REVISION_CONFLICT`、缺 runtime 之前的校验）会变成这条文案，status 却是 `PROCESS_NOT_FOUND`。
- 建议: Engine 未 reserve 时保持原错误码，不要升级成 deadline。或 MCP 文案改成「先 status；`PROCESS_NOT_FOUND` 才允许用同一 launchId 再跑一次」。补一条：短 deadline + 慢/失败的 `process_entry`，断言 MCP 不禁止重试。
- 严重程度: 中（默认 30s RPC 下难打满 8MiB；一旦改写，恢复协议是错的）

失败路径：

1. 入口接近 `MAX_FILE_BYTES`，或磁盘慢，或剩余 budget 已经很小。
2. `process_entry` 读完后 revision/策略失败，或读的过程中 deadline 耗尽。
3. dispatcher 返回 `DEADLINE_EXCEEDED`，launch map 为空。
4. 客户端按 MCP 说明不重放，status 得到 `PROCESS_NOT_FOUND`。

---

### 文件: `crates/reach-rpc/src/process.rs`

- 位置: `command.spawn()` 的 `Err` 分支（约 408–417 行），reserve 在约 371 行
- 问题: 规范要求 spawn 前 reserve，这点满足。但第一次 RPC 是错误 `RUNTIME_UNAVAILABLE`，记录已经是 `failed`。同一 launchId 再 `process.run` 走去重，返回 **成功** 的 failed 记录。自动重试「启动失败」的客户端会以为第二次成功了。
- 建议: 第一次就返回 `state=failed` 的成功结果（带 `reason`），或对 terminal-failed 的重复 launch 仍返回原错误码。至少在 MCP 描述里写清：`RUNTIME_UNAVAILABLE` 后要用 status，不要无脑重放。
- 严重程度: 中

---

### 文件: `packages/reach-rpc/src/mcp/remote-server.ts`

- 位置: `dispatch` 里对 `initialize` 的 instructions 覆盖（约 34–36 行）
- 问题: 父类 `McpServer` 已写上私有 runtime、账号权限、launchId 恢复。HTTP 覆盖成只谈 filesystem / `device_status`。OpenSpec 5.4 要求两种传输共享 process 说明，且 initialization 不得再说 Engine 从不跑 Node。tools/list 描述是对的，只读 instructions 的客户端会缺恢复语义。
- 建议: 在覆盖文本里保留 trusted-code、固定 runtime、launchId / `process_status` 恢复；或拼上父类段落而不是整段替换。
- 严重程度: 中（契约/描述，不是 spawn 漏洞）

---

### 文件: `crates/reach-rpc/src/runtime/runtime.rs` 与 `crates/reach-rpc/src/process.rs`

- 位置: `RuntimeState::Draining` 在 `drain()` 失败时 `Wait(1s)` 重试（runtime.rs 约 308–316 行）；`shutdown_requested()` 只在非 ActiveSession/非 Draining 时切 Shutdown（约 212–220 行）；`drain` 超时为 `grace_ms + 2000`（process.rs 约 601–610 行）
- 问题: 规范要求清理失败不能报成功 drain，这一点对。副作用是：卡住的进程组（D 状态、杀不掉的后代）会让 Engine 永远停在 Draining，session 不释放，SIGTERM 也被排除在立即 Shutdown 之外。heartbeat sleep 那层 100ms 轮询帮不上，因为已经不在 ActiveSession 循环。
- 建议: Draining 认 SIGTERM：记录 `PROCESS_CLEANUP_FAILED` 后进入 Shutdown，或给清理重试一个上限并在文档写明日后需要 SIGKILL 引擎。不要在「优雅退出」上承诺杀不掉的内核状态。
- 严重程度: 中（运维/生命周期；正常脚本的集成测试是绿的）

---

### 文件: `crates/reach-rpc/src/process.rs`

- 位置: `supervise` 在 `waitid` 看到自然退出且尚未 signal 时 `kill(-pid, 9)`（约 766–770 行）
- 问题: 注释写的是收割普通后代，避免父进程先退、子进程留在组里。结果是：**任何自然退出都会 SIGKILL 整组**。脚本若 spawn 普通子进程后自己 `exit(0)`，子进程也会死，状态仍是 `exited`。第一版非目标含持久 daemon，方向合理，但和「exited = 脚本自己的退出码」不完全同一件事。
- 建议: 保持现状并在 `docs/deploy/processes.md` 写明「父进程退出会清理同组普通后代」。若以后要允许 daemonize，需要显式 opt-in，而不是默默留下孤儿。
- 严重程度: 低（可信脚本范围；行为要写清）

---

### 文件: `crates/reach-rpc/src/process.rs`

- 位置: `ifMatch` 比较（约 341–346 行）
- 问题: 手写 `Sha256` + `{:x}`，workspace 写/stat 走 `revision_str` / `revision_bytes`。当前对 UTF-8 入口一致；算法一旦分叉，`fs.stat` 的 revision 不能当 `ifMatch`。
- 建议: process 入口复用同一 helper。
- 严重程度: 低

---

### 文件: `packages/reach-rpc/src/mcp/tools.ts`

- 位置: `process.status` 的 inputSchema（约 32 行）
- 问题: 描述写「恰好一个 processId 或 launchId」，schema 两个都可选，没有 oneOf。Gateway/Engine 会 `INVALID_PARAMS`。模型容易两个都传或都不传。
- 建议: JSON Schema `oneOf` / `prefixItems` 能表达就表达；至少在 HTTP 的 `EXPLANATIONS` 里给 `INVALID_PARAMS` 补一句 XOR。
- 严重程度: 低

---

### 文件: `packages/reach-rpc/src/mcp/remote-server.ts`

- 位置: `EXPLANATIONS`（约 13–20 行）
- 问题: 没有 `PROCESS_*` / `LAUNCH_ID_CONFLICT` / `RUNTIME_UNAVAILABLE`。HTTP 对已知码才改写，process 错误保持裸码。stdio 也基本是裸码。能解析，但和「本地参数说明」不完全齐。
- 建议: 为 process 错误补短句，尤其 `PROCESS_EXECUTION_DISABLED`、`LAUNCH_ID_CONFLICT`、`PROCESS_NOT_FOUND`。
- 严重程度: 低

---

### 文件: `crates/reach-rpc/src/process.rs`

- 位置: 成功路径上的 `state`（约 353、419、445 行）
- 问题: 记录先标 `starting`，spawn 成功立刻改 `running`，RPC 返回时看不到 `starting`。规范列了这个状态，实际只是 spawn 前的内部占位。
- 建议: 要么在 spawn/stdin 快照写完之前就返回 `starting`（更诚实），要么在文档里写「成功 run 至少是 running」。
- 严重程度: 低

## 总体评分

| 维度 | 评分 | 权重 | 加权得分 |
|------|------|------|----------|
| 正确性 | 7.5/10 | 25% | 1.88 |
| 安全性 | 8.5/10 | 20% | 1.70 |
| 性能 | 8/10 | 15% | 1.20 |
| 可维护性 | 8/10 | 20% | 1.60 |
| 优雅度 | 8.0/10 | 20% | 1.60 |
| **总分** | | | **8.0/10** |

优雅度取设计模式 / 可读性 / 简洁性 / 命名的算术平均：`(8.5 + 7.5 + 7.5 + 8.5) / 4 = 8.0`。

## 总结与建议

- 优点:
  - 可信执行的边界清楚：本地 opt-in、固定 runtime、无 shell、grant 与文件系统隔离、session 拥有任务。
  - launchId 去重 + status 恢复 + 观察路径不打开替代 session，比「超时就重放」适合有副作用的启动。
  - 入口快照 + 进程组 + 有界日志/记录，把第一版范围收在可测试的 Unix 实现里。
  - 测试密度高：bootstrap 模块身份、symlink 替换、grant 伪造/过期/跨类、drain 失败保留、HTTP/stdio 真 Engine、生命周期五种关闭。
  - 版本与文档按 minor 发布走，没有把协议或 bundled Node 绑上去。

- 待改进（建议按此顺序）:
  1. **中** `DEADLINE_EXCEEDED` 与 launchId 恢复：未 reserve 不要升级错误码，或让 MCP 允许 `PROCESS_NOT_FOUND` 后重试。
  2. **中** spawn 失败的第一次响应和 launch 记录对齐，避免「错误 + 重试变成功 failed」。
  3. **中** HTTP `initialize.instructions` 补回 process / launchId 语义。
  4. **中** Draining 对 SIGTERM / 清理重试要有出口，避免杀不掉的子进程把 Engine 钉死。
  5. **低** 复用 revision helper；status schema 表达 XOR；补 process 错误说明；写清自然退出会清组。

- 总体评价:
  这是一轮目标清楚的跨组件功能，没有把「在设备上跑 Node」做成任意 shell。授权、默认关闭、session 清理和 MCP 不重放的方向都对，实现也基本贴着 OpenSpec。合入风险不在沙箱幻想，而在 **失败/超时的恢复文案**：客户端按说明做会偶发地查不到任务，或把 failed 记录当成新的成功 launch。建议先修 deadline/reserve 与 spawn 失败的契约，再合。

审查结论：**有条件通过**。不修改代码；本报告仅分析。
