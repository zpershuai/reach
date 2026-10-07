# 代码审查报告

## 提交信息

本次审查对象是 **未提交的工作区 diff**，不是一次 Git commit。只做审查，不修改代码。

- **基线 Commit ID**: `f86a109`
- **完整 Hash**: `f86a109db3b7a8a5fa2ff356d5831a5aef82e8a4`
- **基线提交信息**: `fix: keep Node off the Engine process and launch JS via run-node.sh`
- **基线日期**: 2026-10-07 10:20:13 +0800
- **审查日期**: 2026-10-07
- **范围**: `git diff HEAD` 的 17 个已修改文件 + 25 个未跟踪文件（MCP HTTP 核心、OpenSpec、Grok Bot plugin、验证脚本）

## 变更概览

- 变更文件数: 17 修改（+290 / −817）+ 25 新增
- 主要变更内容简述:
  - Gateway 在现有端口上提供认证 Streamable HTTP `/mcp`（JSON-only，无 SSE）
  - MCP 核心从 `grok-bot-mcp-connector` 抽到 `reach-rpc/src/mcp`；stdio 构建把编译后的 `config/gateway/server/tools` 拷进扁平 `dist`
  - 每台 Engine 暴露 identity-bound `EngineApi`，与 `/session/rpc` 共用 `executeRpc`
  - HTTP 表面使用静态下划线工具、非阻塞冷启动、`device_status` 轮询；stdio 动态模式保持不变
  - 增加 `grok-bot-plugin`、部署文档、OpenSpec `mcp-streamable-http`、协议/所有权/限额测试和 `scripts/verify-mcp-http.mjs`

## 代码质量评估

### 1. 正确性

- 评分: 7/10
- 主路径（initialize、静态工具、冷启动 intent、ENGINE_BUSY、revision、DELETE drain）有针对性测试，`executeRpc` 共用也避免了 HTTP / in-process 两套授权语义。
- 会在真实路径上出错的问题：
  1. MCP session 在 `readBody` 期间不 pin。idle sweep / 并发 DELETE 可以先 `cleanup`，随后这条 POST 再 `begin()` 打开新 Engine，且不再被任何 map 持有。
  2. 请求路径上的 idle 到期只 `retire` + 404，Engine drain 要等下一轮 sweep（最多 1s）。
  3. `session_close` 在本会话从未持有该 Engine 时仍返回成功。
  4. 接近 64KiB 的 `fs_write` 可能通过 `/mcp` 后在 `executeRpc` 二次 `JSON.stringify` 时 413。

### 2. 安全性

- 评分: 8/10
- 每个 `/mcp` 方法都验 Controller token；非 loopback 无认证直接 401；`timingSafeEqual`；带 `Origin` 且不在 allowlist 则 403；body 64KiB、session/queue 上限。
- 所有权模型（intent 绑定、不抢占、DELETE 只关自己的 Engine）方向正确，但第 1 点会在 expiry/DELETE 之后留下无人认领的 Engine，竞争者在 lease/idle 到期前会一直 `ENGINE_BUSY`。
- 默认空 `REACH_MCP_ALLOWED_ORIGINS` 会拒绝任何带 `Origin` 的请求。Node 测试不带该头所以是绿的；浏览器/webview 里的 Grok Bot 跨源 POST JSON 会带 `Origin`，不配 allowlist 则全部 403。文档写了，但应视为目标客户端的必配项。

### 3. 性能

- 评分: 8.5/10
- in-process `EngineApi` 避免 loopback HTTP 和子进程。
- 冷启动不占用 25s HTTP budget 去等 120s 心跳，改为立刻 `connecting` + `device_status`。
- session 串行队列、`maxSessions`/`maxQueue`、sweep `unref`、body 超时后 `connection: close` 都合理。
- 每次文件系统工具仍会 in-process `status()` / 可能 `renew()`，代价可忽略。

### 4. 可维护性

- 评分: 7.5/10
- 核心单份源、stdio 扁平发行、Gateway 内嵌 HTTP，和 OpenSpec 决策一致；`mcp.test.ts` 覆盖认证、版本协商、所有权、限额、chunked 413、idle drain、失败 cleanup。
- 扣分：`copy-mcp-core.mjs` 靠拷贝文件而不是包引用，connector 的 `.ts` 是对 `reach-rpc/dist` 的 re-export，构建顺序成为隐式契约。
- `RemoteMcpServer` 继承 stdio `McpServer`（空 `devices`、不用 `selected`），父类的 `releaseAfterFailure` 对 HTTP 是空操作。能工作，但共享清理语义要靠覆盖而不是共用所有权表。

## 代码优雅度评估

### 1. 设计模式

- 评分: 8/10
- 外层 Gateway 先切 `/mcp` 再按 `engineId` 分发，HTTP MCP 与 REST 共用同一套 Engine 状态机，是对的边界。
- 每 HTTP session 一个 `RemoteMcpServer` + 每设备一个 `InProcessGatewayClient`，避免跨设备 selection 竞态。
- 略重：为了复用 stdio 工具/grant 路径而继承单选设备服务器，HTTP 再把几乎所有 `callTool` 重写一遍。

### 2. 可读性

- 评分: 7.5/10
- `http.ts` 把协议状态机压在一个 `handle` 里，顺序（鉴权 → Origin → session → 版本 → 方法 → body → dispatch）清楚。
- `gateway.ts` 的 `createGateway` 现在永远包一层；`isLoopback` 闭包引用尚未声明的 `gateway`，运行时安全（只在 listen 之后调用），读起来要停一下。
- 工具名 `.` → `_` 以及 `tools[0]`/`tools[2]` 按下标改 description，依赖 `deviceTools()` 的稳定顺序。

### 3. 简洁性

- 评分: 7/10
- `executeRpc` 抽出后 `/session/rpc` 从约 80 行变成转发，这是净简化。
- connector 五个源文件变成 re-export + 构建拷贝，发行兼容换来两份“看起来像源码”的入口。
- HTTP 层自己跟踪 `initialized`，`McpServer` 在 `initialize` 时就置位，两套 initialized 含义不同（HTTP 还要求 `notifications/initialized`）。

### 4. 命名规范

- 评分: 8.5/10
- `EngineApi` / `InProcessGatewayClient` / `RemoteMcpServer` / `device_status` / `ENGINE_BUSY` 与现有 Reach 契约一致。
- 静态 HTTP 工具下划线名和 stdio 点分名并存是故意的，文档和测试都锁了。

## 详细审查意见

### 文件: `packages/reach-rpc/src/mcp/http.ts`

- 位置: `handle()` session lookup 之后、`enqueue()` 之前的 `await readBody()`（约 160–209 行）；`enqueue` / idle sweep（约 120–145 行）
- 问题: `queued` 只在 `enqueue` 时增加。lookup 成功到 `enqueue` 之间 `queued === 0`。这段时间 idle sweep 或并发 `DELETE` 会 `retire` 并立刻 `enqueue(cleanup)`。POST 恢复后对**同一个 session 对象**再 `enqueue(work)`，排在 cleanup 后面。cleanup 关掉 Engine 并从 `retired` 删除；随后 `InProcessGatewayClient.begin()` 见 `status === "none"` 再 `open()`。该 HTTP session 已不在 `sessions`/`retired`，后续 DELETE/expiry **不会再收走这次打开的 Engine**。
- 建议: lookup 成功后立刻 pin（refcount / 提前 `queued++`）。任何 `await` 之后确认 `sessions.get(id) === session`，否则 404。不要对已经 `retire` 的对象 dispatch tools。请求路径上的 `retire` 必须立刻 `enqueue(cleanup)`，不要只 404 等 sweep。
- 严重程度: 高

失败路径：

1. 客户端在 idle TTL 末尾 POST `tools/call`，或与 `DELETE /mcp` 重叠。
2. handler 通过 lookup，进入 `readBody`。
3. sweep/DELETE：`retire` → cleanup 关 Engine。
4. POST 继续执行，`begin()` 打开新 intent。
5. Engine 被无人认领地持有，直到 lease/idle；竞争者 `ENGINE_BUSY`。

`mcp.test.ts` 的 idle/DELETE 用例都没有 in-flight POST，盖不到这条。

---

### 文件: `packages/reach-rpc/src/mcp/http.ts`

- 位置: 请求路径 idle 判断（约 162–163 行）
- 问题: 迟到的带旧 `Mcp-Session-Id` 的请求会 `retire` 后立刻 404，但 `shutdown()` 只在 sweep 第二圈、且 `!session.queued` 时才跑。Engine 最多再被持有 1s（`min(1000, idleMs/2)`）。
- 建议: 与上条一并处理：`retire` 的同时 enqueue drain。
- 严重程度: 中（同根；单独看窗口短）

---

### 文件: `packages/reach-rpc/src/mcp/remote-server.ts`

- 位置: `session_close` 分支（约 85–88 行）
- 问题: 没有对应 `InProcessGatewayClient` 时仍 `toolText({ closedDeviceId })`。`ENGINE_BUSY` 后 client 已被 `delete`，竞争者再调 `session_close` 会得到成功，A 的 session 不受影响。不会误关别人，但会让模型以为设备已释放。
- 建议: 无 client 且 `api.status()` 显示别人持有时返回错误（或明确 `owned: false`）；仅在确实无 session 或本会话持有并关闭后才报成功。
- 严重程度: 中

---

### 文件: `packages/reach-rpc/src/gateway.ts`

- 位置: `executeRpc` 入口（约 474 行）
- 问题: in-process envelope 再走一遍 `MAX_HTTP_BODY_BYTES`（64KiB）。`/mcp` 已经按 64KiB 收了 JSON-RPC。内层会再加 `sessionId` / `requestId` / `deadlineAt` / `permission`。接近上限的 `fs_write` 可能 MCP 已接受、内部 413 `invalid rpc payload`。
- 建议: in-process 路径不要用 HTTP body 上限，或给 MCP 内容留出 envelope 余量；测试用略低于 64KiB 的 write，而不是只测超限 413。
- 严重程度: 中（只打接近上限的写）

---

### 文件: `packages/reach-rpc/src/mcp/http.ts`

- 位置: `bounded()`（约 97–103 行）与 `handle` 的 `Promise.race`
- 问题: HTTP 408 不取消已经 `enqueue` 的 Engine RPC。这是故意的（超时文案要求先 re-read 再写），`closeOnTimeout` 在 MCP 缩短 deadline 时为 false，Engine session 也不会拆掉。客户端若不遵守会双写。
- 建议: 保持不取消 in-flight mutation；不要把它当实现缺陷。文档和 tool description 已经写了。若要更硬，可在 408 后对该 session 拒绝新的 write 直到下一次成功 `fs_read`。
- 严重程度: 低（契约风险，非实现错误）

---

### 文件: `packages/reach-rpc/src/mcp/http.ts`

- 位置: `maxSessions` 检查（约 195 行）
- 问题: 检查发生在 `await readBody` 之后，没有锁。两个并发 `initialize` 都可以看见 `sessions.size + retired.size === 0` 然后都 `set`。默认 128  practically 难打满；测试里 `maxSessions: 1` 是串行的。
- 建议: 创建 session 与计数放在同一同步临界区，或 pin 后再读 body。
- 严重程度: 低

---

### 文件: `packages/reach-rpc/src/mcp/remote-server.ts`

- 位置: `isError` 文案改写（约 98–102 行）
- 问题: 所有 `callOnGateway` 的 `isError` 都变成 `` `${code}: ${EXPLANATIONS[code] ?? "The Engine could not complete the operation."}` ``。本地校验（缺 `path`/`workspace`）会被说成 Engine 失败。
- 建议: 只改写已知 Engine 码（`EXPLANATIONS` 的 key）；其余保持原消息。
- 严重程度: 低

---

### 文件: `packages/reach-rpc/src/mcp/in-process.ts` 与 `packages/reach-rpc/src/gateway.ts`

- 位置: `begin()` / `close()`（in-process 约 40–50、81–94 行）；upgrade 在赋值 `liveSession` 之前清掉 `wantedSessionId`（gateway 约 695–719 行）
- 问题: handshake 期间 `sessionStatus()` 会短暂变成 `none`。`begin()` 在 `this.sessionId` 已有且 status 为 `none` 时会当作需要新 `open()`；`close()` 见 `none` 会跳过 `/session/close` 并报告成功。`ws.handleUpgrade` 通常同 tick 完成，窗口很小，不是这次的主路径。
- 建议: Gateway 在 handshake 完成前保持 `wanted`/`pending`（或引入 `upgrading`）；MCP `close()` 在本地仍持有 intent 时不要把 `none` 当成已经释放。
- 严重程度: 低（窗口短；根因是既有 Gateway 状态机）

---

### 文件: `packages/reach-rpc/src/mcp/server.ts` 与 `remote-server.ts`

- 位置: `callOnGateway` 的 `SESSION_CLOSED` → `releaseAfterFailure()`（server 约 241 行）；`RemoteMcpServer` 构造（remote-server 约 27 行）
- 问题: `releaseAfterFailure` 只看 stdio 的 `this.selected`，HTTP 从不设置。当前调用仍会 `toolError(SESSION_CLOSED)`；下一次 `fs_*` 走 `begin()` 的 `status===none` 分支重新 open，和冷启动一致，不是泄漏。
- 建议: 不必当 bug 修。若希望 HTTP 在 SESSION_CLOSED 后强制再 `pick_device`，应删掉 `clients` 条目并让 `fs_*` 在无 client 时不要自动 `open`。长期看，所有权表应抽到父类之外，而不是继承单选设备服务器再全部 override。
- 严重程度: （设计债，非功能缺陷）

---

### 文件: `packages/reach-rpc/src/gateway-main.ts` 与文档

- 位置: `allowedOrigins` 默认空数组（约 29 行）；`docs/deploy/mcp.md` Origin 说明
- 问题: 实现符合 DNS rebinding 防护。目标 Grok 客户端若在浏览器里发 `Origin`，默认部署不可用。
- 建议: 把 `REACH_MCP_ALLOWED_ORIGINS` 写成 Grok Bot 接入清单的必填项，并在真实客户端上抓一次请求头。
- 严重程度: 中（上线配置，非逻辑错误）

## 总体评分

| 维度 | 评分 | 权重 | 加权得分 |
|------|------|------|----------|
| 正确性 | 7/10 | 25% | 1.75 |
| 安全性 | 8/10 | 20% | 1.60 |
| 性能 | 8.5/10 | 15% | 1.28 |
| 可维护性 | 7.5/10 | 20% | 1.50 |
| 优雅度 | 7.8/10 | 20% | 1.56 |
| **总分** | | | **7.7/10** |

优雅度取设计模式 / 可读性 / 简洁性 / 命名的算术平均：`(8 + 7.5 + 7 + 8.5) / 4 = 7.75`，表中记 7.8。

## 总结与建议

- 优点:
  - `/mcp` 进现有 Gateway，不新开端口，stdio 发行路径保持扁平、无额外运行时依赖。
  - `EngineApi` + 共用 `executeRpc` 让 grant、canonical `tool.call`、deadline 对 REST 和 HTTP MCP 一致。
  - 非阻塞冷启动和静态下划线工具对 25s HTTP budget、不支持 `tools/list_changed` 的云客户端是匹配的。
  - 测试质量高：认证/Origin/loopback、版本协商、所有权、限额、chunked 413、失败 cleanup、真实 Rust Engine 的 revision 写，外加 `verify-mcp-http.mjs`。
  - `session_close` 放在 `begin()` 之前，避免“再关一次却打开新 session”。

- 待改进（建议按此顺序）:
  1. **高** MCP session 在 lookup 后、dispatch 前必须 pin；`retire` 必须立刻 drain，且不得对已 retire 的对象跑 tools。补 POST-vs-DELETE 和 idle-during-body 测试。
  2. **中** `session_close` 不要对未持有的设备报成功。
  3. **中** in-process RPC 不要用 HTTP 64KiB 上限卡已经通过 `/mcp` 的写；Grok 接入把 Origin allowlist 当必配。
  4. **低** 只改写已知 Engine 错误码；`maxSessions` 与创建原子化；handshake 期间不要把 status 打成 `none`。

- 总体评价:
  这是一轮目标清楚的传输扩展，核心抽取和 in-process 所有权设计比再堆一个 stdio 桥要干净。协议面和测试已经能撑本地与多 Engine 场景。合入风险集中在 HTTP session 生命周期：idle/DELETE 与 in-flight POST 的交错会在“会话已死”之后重新打开 Engine 且无人回收。建议修完 pin/drain 再合。

审查结论：**有条件通过**。不修改代码；本报告仅分析。复核时并入了独立 code-review 子任务的 finding，只保留对过源码的条目。

## 修复复核（2026-10-07）

以上保留原始审查记录。收到直接修复的指令后，逐项核对并完成以下处理：

| 条目 | 复核结论与处理 |
|------|----------------|
| POST 读取期间 DELETE/空闲过期，退役后重新打开 Engine | 已复现并修复。请求体读取计入活动和 admission；读完、出队和 batch 每条 dispatch 前检查会话仍有效。退役后未开始的工具请求返回 404。 |
| 请求路径发现过期后延迟清理 | 已复现并修复。retire 立即安排串行 drain，复用同一清理任务，失败仍保留重试。 |
| 慢请求体未计入队列上限 | 补充复现并修复。读取、排队、执行共同计数，满时 429；读取失败/超时释放名额。 |
| 未持有设备的 session_close 误报成功 | 已复现并修复。其他调用者仍持有 Engine 时返回 ENGINE_BUSY；无会话时保留幂等成功。 |
| 内部 envelope 再次应用 64 KiB 上限 | 已复现并修复。仅 HTTP ingress 限制收到的字节，内部消息保留 WebSocket 上限和原有 RPC 校验。近上限写入成功，REST 超限仍为 413。 |
| 本地校验被改写成 Engine 失败 | 已复现并修复。仅已知 Engine 错误码添加解释，其余保留原消息。工具描述同时改为按名称覆盖。 |
| maxSessions 并发创建竞态 | 当前实现不成立。计数检查至 sessions.set 之间没有 await；12 个并发初始化在 maxSessions=1 时仅一个成功，其他均 503。 |
| WebSocket handshake 暂时暴露 none | 当前配置下不成立。ws 未配置异步 verifyClient，handleUpgrade 至完成回调同步执行，没有可供另一个请求交错的异步边界；未改动状态机。 |
| HTTP 408 不取消已转发写入 | 保留契约。已执行操作允许结束，客户端必须重新读取后再决定下一次写入，禁止自动重放。新增测试确认 DELETE 会等待正在执行的读完成，并拒绝仍排队的写。 |
| SESSION_CLOSED 后父类释放逻辑与 HTTP 所有权表不同 | 未发现功能缺陷或泄漏，按原报告建议不修改。 |
| Grok Bot Origin 配置 | 已补部署检查清单和插件说明。必须核对实际宿主是否发送 Origin；有该头才配置准确允许值，无该头保持空配置。实际宿主行为仍需部署者验证，不放宽默认检查。 |

验证结果：新增 9 项回归测试；`bash scripts/verify.sh` 全部通过（Python 11、Rust 89、Gateway/RPC 80、Connector 35，含真实 Rust Engine 集成与 fixture 往返）。`openspec validate --all --strict` 11 项通过，`git diff --check` 通过。修复仅在工作区，未提交、部署或修改运行中的服务。
