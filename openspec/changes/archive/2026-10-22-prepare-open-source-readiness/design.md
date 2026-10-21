# Design

## Context

动机见 [proposal.md](proposal.md)。用户选择了 A：客户端身份必须能限制设备、工作区及读写/执行权限。这是授权模型扩展，不是只验证现有全局访问模型。

已观察到的实现：

- `gateway.ts` 创建每个 Engine 的状态机；REST 使用共享 Controller token。`mcp/http.ts` 区分 `controller`、`oauth:<id>` 等 principal，但 OAuth 验证结果只有客户端身份，没有资源策略。
- `mcp/in-process.ts` 直接调用 `EngineApi`；部分操作只有 sessionId，没有独立的认证上下文。仅在 HTTP 外层加检查会遗漏 MCP 的内部路径。
- `grants.ts` 的文件 grant 绑定 workspace/path/method，进程 grant 额外绑定会话及 launch/process 身份；文件 grant 当前缺少调用 principal，且允许在既有期限内跨会话保留。
- `console-api/store.ts` 已有顺序 SQLite migration、单管理员、Engine registry、OAuth token digest 和元数据 audit，可承载新数据；`ConsoleAuth` 已有 CSRF、Origin、10 分钟重新认证保护。
- Engine 文件访问已有 descriptor-relative/no-follow 边界。进程默认关闭、固定 Node、`env_clear()`、直接参数数组和进程组监督；Node 脚本本身仍有服务账号的权限。现有进程、路径、去重、回滚测试应扩展而非重写。
- `ConsoleAuth` 当前会打印自动生成的 setup token；Engine 的 `Lease` 派生 Debug，若干传输错误拼接原始异常或响应。这些是需要收紧的诊断输出面，不据此宣称已经发生泄露。
- 当前有 `CONTRIBUTING.md`、`SECURITY.md` 和安装/运维/兼容文档；README 仍有未经本次计时验收的上手时长。`.github/` 当前只有两个 workflow，未见 Issue/PR 模板。
- 本地发布流程有多平台资产、校验和、镜像 digest 和版本检查，但打包脚本未体现清单所述远端分支中的完整许可证分发改进；清单记录的修复与当前路径需对照，不能重复定义为未修复历史问题。当前未核验远端合并、秘密配置、已发布资产或容器层。
- CI 已固定 OpenSpec、使用锁文件并执行 Linux/macOS 与 Linux 打包检查，但 Rust 使用 `stable`、Node 使用主版本、Actions 使用可变版本标签。

约束：真实部署信息、扫描报告和验收清单只放 `.reach/` 或仓库外；公共文件只能包含通用程序和虚构示例。规划/实施不自动改变仓库可见性、重写历史或更改线上安装。

## Goals / Non-Goals

**Goals:**

- 以服务器派生的授权上下文统一 REST、HTTP MCP、Connector 最终到达的调用路径；即使知道隐藏资源 ID、sessionId、grantId，也不能扩大权限。
- 保留单一管理员与可信 Gateway 架构，新增委派客户端身份；身份是权限边界，显示名和来源标签只是元数据。
- 为 P0/P1 提供代码检查、故障注入、公开候选和干净环境验收的具体证据链；没有执行的验收保持 pending。

**Non-Goals:**

- 多租户账户、SSO、多管理员、通用策略语言、任意 shell、Node 沙箱或对恶意脚本的完整操作系统隔离。
- 持久化 exactly-once、跨会话接管进程、自动迁移旧历史到公开仓库。
- P2 的性能优化、SBOM、签名/构建证明实现与申请提交。本次仅给出后续条目和证据格式，不编造使用数据或申请权益。

## Decisions

### 1. 身份和策略分离，资源明确列举

在现有 SQLite store 增加 clients/policies/credentials 的专用表（不复用当前仅记录展示标签的 `clients` 表）：

- `client_principals`：稳定 ID、来源（delegated/oauth）、显示名、状态、policy revision、兼容/复核状态。
- `client_credentials`：opaque token digest、所属 principal、到期/撤销时间、创建时间；初版每个 delegated principal 只保留一个有效 token，旋转后旧 token 立即失效。生成至少 32 随机字节，单次返回明文。
- `client_permissions`：principal、engineId、workspace、read/write/execute 布尔值。普通策略拒绝通配符，默认空；本地 Engine 的公开能力与 Gateway 策略取交集。
- legacy 全局权限单独用兼容模式表达，不能由新 OAuth 默认继承；每次真实收紧或替换策略递增该 principal 的 revision。

新增 `/api/console/access-clients` 及其详情、rotate/revoke/policy 操作；OAuth 同意流程复用同一策略保存服务。管理操作走现有 console session、Origin/CSRF、recent-auth 和 audit。详情不返回 token/digest。

Owner Controller 保留全局管理者数据面角色，不给日常 MCP 示例使用。未启用 console/store 时沿用 Owner token 与回环开发模式；委派凭据和 OAuth 策略管理要求持久化 store。若非回环监听仍必须认证，不能借新配置放宽。

考虑过单纯让每个 Engine 有一个 Controller token，以及引入多用户账户/RBAC。前者不能限制工作区和方法，后者超出单一所有者的需求；明确资源列表的委派身份足以落实 A。

### 2. 一个授权服务覆盖发现、会话、签发和执行

在 `packages/reach-rpc/src/` 新建共享授权模块，产出不可从请求参数伪造的 `AuthenticatedPrincipal`（ID、credential/token-family、失效时间、policy revision、Owner 标记）。只由认证入口创建；`CallerContext` 继续承担展示归因，不能充当权限证明。

将公开 Engine 调用面包装为绑定 principal 的 facade，所有 `status/open/renew/close/grant/processGrant/rpc` 都携带认证上下文。原始 EngineApi 留在可信内部，不直接交给 REST 或 MCP。`mcp/http.ts` 以认证结果创建 facade；Connector 带委派 bearer token，经 REST 进入相同服务；不把 scoped token转换成 Owner token。

操作映射：

| 操作 | 必须具备的权限 |
| --- | --- |
| `fs.read/list/stat/glob/grep` | 对应 Engine/workspace 的 read |
| `fs.write/edit`、文件 grant | 对应资源的 write，外加有效 grant |
| `process.run`、execution grant | execute，外加 Engine 本地启用及有效 grant |
| `process.status/logs/list/stop`、control grant | 当前身份拥有的会话/任务、任务工作区的 execute；stop 还需 control grant |
| 设备/版本发现 | 至少一个可见工作区；只返回授权资源的元数据 |

一次 `tool.call` 先按现有 canonicalization 解析；嵌套调用保持原有 `INVALID_PARAMS` 优先级。隐藏 Engine 与不存在 Engine 统一 404；可见 Engine 的操作/工作区拒绝使用 `PERMISSION_DENIED`。健康检查仅保留无敏感资源信息的基本可用性数据。

Engine session 的 ready capabilities 在对外返回时按策略过滤；禁止进程方法时既隐藏工具也在执行处拒绝。`processId/launchId` 到 workspace 的归属来自可信 Engine 返回和绑定会话，不接受客户端自报。列表和分页只包含当前策略允许的记录。

只在路由层过滤列表的方案被排除：知道 ID 的调用者仍能绕过；只检查 grant 的方案也无法保护读请求。

### 3. Grant 绑定身份，撤销先阻断再清理

在现有 grant scope 增加 principalId、Engine ID、policy revision，保留原路径规范化、5 分钟 TTL、workspace generation 撤销语义。文件 grant 在同一身份下的原有生命周期不额外强制改成单会话，进程 grant 继续严格绑定会话。

签发、排队后转发、自动 MCP 申请都检查当前策略。对同一 principal 的策略修改以事务提交新 revision；提交后同步阻断后续请求并失效旧 grant，再 drain 受影响会话。凭据撤销/旋转/到期也触发此路径；delegated 凭据有到期定时器，不能等下一次请求才清理任务。

权限收紧采用保守方案：关闭受影响 principal 在该 Engine 的会话，由现有 Engine session cleanup 停止任务，不尝试在同一会话内保留部分进程。其他身份的会话不受影响。清理失败保留所有权并重试，不能让新客户端复用尚未清理的 Engine。已经跨过原子提交边界的文件写入可能完成，撤销不承诺回滚。

OAuth 继续按 client principal 保持共享 ownership pool；每次请求认证当前 token 并复查策略。撤销应用或检测 refresh replay 时关闭该客户端的相关 pool；由于 pool 跨 token 共享，对该客户端保守清理，不影响其他应用。刷新只改变 token，不创建更强身份。回收路径负责结束 MCP session、Engine intent、grants 和进程，而非仅删除 token 行。

### 4. 存量权限可见迁移，新授权默认最小权限

保留配置的 Controller Owner 凭据。现有已批准 OAuth client 在事务 migration 中映射为 `legacy-global`、`review_required`，明确展示旧权限，避免升级时静默中断既有授权；新注册或新批准的客户端没有全局默认。

Owner 在 console 将存量授权缩小为具体资源，或明确复核其继续保留的全局兼容权限；后者标记为可信 Owner 等价客户端，不能宣称有资源隔离。公开验收拒绝未复核 legacy 授权。新的日常示例统一使用显式 scoped delegated/OAuth 身份。修改权限时需要 recent-auth 并清理旧会话。

这是兼容性折中；直接撤销全部 OAuth 更容易实现，但会破坏已运行客户端。强制把现有 global token 悄悄解释成 read-only 同样不采用。若用户需要多个真人账号，本变更只提供独立委派身份，不声称已有多用户平台。

### 5. 不以脱敏正则作为唯一日志边界

服务端日志使用允许字段和稳定错误码，HTTP 只记 route/method/status/duration；不拼接 query、原始 upstream body 或任意 exception。检查 Engine `Lease` 的 Debug、session endpoint/upgrade、heartbeat 和安装更新错误，移除 token 可被格式化的路径。MCP stdio stdout 继续仅承载协议。

生成的 console setup token 改为 `$REACH_DATA_DIR/admin-setup-token`：安全创建 0600 普通文件，拒绝软链接/不安全权限；重启复用，setup 成功删除；若显式配置 env token 则不写生成文件。日志只给出“从私有数据目录读取设置凭据”的操作提示。已有管理员无须重新设置。容器文档说明如何在本机安全读取，禁止复制到公开问题报告。

用 sentinel 测试覆盖正常、拒绝、超时、TLS/重定向、无效 body 和进程失败；核对 stdout/stderr/audit 均无敏感正文。明确 Gateway 仍能看到转发的应用数据；审计不记录正文并不代表端到端加密。

### 6. 本地公开候选与私有证据分离

增加通用 `scripts/prepare-public-source.py`、`scripts/verify-publication.py` 及脱敏的验收文档。导出只接受确定 commit，默认目标位于 `.reach/public-candidate/`，拒绝非空目录；用显式文件清单/排除规则，不复制 `.git`、`.reach`、私有配置或生成产物，保留合法归属。输出不 push、不创建远端、不改原引用。

审查输入 manifest 放 `.reach/publication/`，分别枚举拟公开源码引用、现有继续分发的全部 Release 资产和镜像 digest。固定秘密扫描器版本；部署信息额外由人工审查，因为凭据扫描器不会识别全部拓扑和备份细节。扫描 image export 的每一历史层和构建上下文，不只看最终文件系统。超时/跳过必须 fail/incomplete，不能作为成功。

报告包括范围、日期、工具版本、候选摘要、逐项结果、reviewer 结论、例外及凭据处置证据，只写私有目录。公共 CI 只运行 synthetic 测试和输出脱敏结论，不上传真实报告。候选 bytes 改变后旧证据失效。

不默认改写完整历史。若未来另选保留历史，应创建独立清理方案；本次快照不沿用原私有历史的 branches/tags/commit messages。新公开源码 revision 与私有来源的映射保存在私有报告；发布元数据只能指向可匿名访问的公开源码 revision。

### 7. 发布路径先对照已完成修复，再收紧门槛

实施时只读核对清单所指发布分支的合并状态、目标仓库、Actions gate 和所需凭据的“是否存在/权限范围”；不输出 secret 值。复用已完成的 LICENSE/第三方声明修复，仅对实际构建路径缺失部分移植，不把旧版已修复问题重复列为漏洞。

扩展 `package-engine.sh`、`package-gateway.sh` 和 `release-metadata.py`，构建时产出明确清单：component、version、source revision、toolchain、platform、资产与摘要。保持当前二进制资产名兼容；裸二进制分发增加强制伴随许可证/第三方声明资产，tar/image 直接内含。第三方清单需覆盖实际 Rust/Node 依赖与随包字体等资源。逐平台验证不能以一份成功抽样替代。

拆分 build/verify/publish 权限，构建 job 只读；GHCR 推送和跨仓库 release token 只在可信 tag、全部 gate 成功且受保护的发布 job 使用。普通 PR（含 fork）无 release secret。配置发布目标，不把真实部署信息固化进 workflow。精确资产白名单代替任意目录通配上传。

下载回验工具逐资产核对 build manifest，镜像核对 digest；失败保留 incomplete 状态，不自动删除或覆盖已发布版本。真实发布另行触发；本地和 CI dry run 可验证命名与内容。公开快照的公共 source revision 必须在发布前确定，不能指向匿名不可访问的私有 commit。

当前 P0 采用受保护仓库权限加验证 HTTPS 的摘要渠道；文档解释它不能抵抗同时控制包与摘要的攻击。签名、SBOM、构建来源证明列入 P2，不在本轮宣称已有。

### 8. 安装完整性检查先于执行，恢复测试覆盖支持路径

整合 installer、Rust/TS updater、宿主机 helper 的来源/平台/摘要规则：approved GitHub API/release/storage origin 的 HTTPS 链、重定向去 Authorization、严格唯一 checksum、组件版本与 platform 身份。ELF/Mach-O header 或可信 image platform metadata 必须先核对，再运行 `--version`。本地 fixture source 通过显式 test mode 开启，生产默认拒绝 file/plain HTTP 覆盖。

在原 Linux recovery 测试基础上补充 macOS/OpenWrt/Compose 的验证失败与 activation/start 失败恢复；模拟 supervisor 与真实设备验收分别记录。新安装没有 previous version 时失败应回到未安装状态并保留诊断。auto-update 的阶段下载、idle admission 和临时备份机制继续保留；对启动后失败提供 supervisor/host helper 的健康检查及恢复路径，不把“退出交给重启”当作更新成功证据。

不改正在运行的服务以“顺便验证”流程。带执行的干净验收使用独立非 root 测试用户或真正隔离环境；OpenWrt 现有 root 安装可保留只读/文件用途，但不能据此宣称满足受限脚本执行验收。

### 9. 用矩阵把 P0/P1 固定到 CI 和上手流程

共享 fixtures 定义 read-only、write-only、execute、无权限及两身份/两 Engine/同名 workspace 场景；Rust 检查本地执行限制，TypeScript 检查所有入口的授权和无转发。TLS fixture 覆盖 heartbeat、WSS、Connector 的 expired/untrusted/wrong-host 证书，测试信任根只在显式测试接口传入，不引入生产跳过校验开关。

在隔离工作副本中对授权、workspace 边界和 checksum 各做一次定向故障注入，证明对应测试会失败；不写泛化全仓库 mutation 框架。复用 `gateway.test.ts`、`oauth.test.ts`、`process_tests.rs` 和 installer tests，补上缺失矩阵。

提交准确的 Rust toolchain、Node/Python CI pins、scanner pins 与 Actions immutable SHAs，保留 npm/Cargo locks。具体补丁版本在实施时从当前可用工具验证后锁定；不得因 pin 自动扩大支持平台。CI 继续跑 Linux/macOS 和 Linux packaging，release job 使用同套门槛。

README/README_cn 提供同一最小流程及完整 MCP 例子：新环境构建/安装 → Gateway → Engine → scoped client → workspace read/write → 显式启用可信脚本 → revoke client/device → uninstall。删除未经计时验证的时长承诺。兼容矩阵写明组件、协议/feature 条件、Gateway-first 升级和 rollback 边界；故障步骤提示 lost write reply 的不确定性，不自动 replay。

复用现有 CONTRIBUTING/SECURITY，补 Issue/PR 模板和私密报告渠道实际可用性验收，不预设目标仓库已启用 security advisory。所有真实 clean-machine 报告只留私有目录。

## Risks / Trade-offs

- [legacy 全局 OAuth 保留广泛权限] → 显式标记、Owner 复核、默认新客户端空权限；将全局客户端视为可信 Owner，不能宣称它具备隔离。
- [内部入口遗漏授权或排队期间策略过期] → 绑定 principal 的统一 facade，转发前再次检查；REST/MCP/Connector 及直接/包装请求均有无转发断言。
- [撤销无法撤回已提交副作用] → 先禁止新工作再 drain，保留原子写不确定性说明；不承诺跨重启 exactly-once。
- [可信脚本可读取 Engine 账号有权访问的其他文件或逃逸进程组] → 默认关闭、独立受限账号验收、明确剩余权限；不把路径或组清理当恶意代码沙箱。
- [全部资产/镜像层扫描耗时且可能缺权限或超时] → 每项独立状态和摘要、失败阻断；没有证据的项目保持未验收。
- [legacy 数据库 migration 后旧 Gateway 无法读取新 schema] → 升级前停写备份 DB/WAL 配套状态，回滚使用对应旧版本快照，不让旧进程强读新库。
- [摘要发布渠道被接管] → 最小发布权限、受保护 tag/job、HTTPS 和可追溯 manifest；P2 再增加签名/来源证明。
- [许可证资产布局或公开源码仓库变化影响安装者] → 保留现有 executable asset 名、配置 repository、补充必需资产，不静默切换已有安装的来源。

## Migration Plan

1. 在隔离环境完成 P0/P1 工程、回归与打包，保留原私有历史、运行服务与凭据不动。实现任务完成不等于发布门槛已验收。
2. 升级候选 Gateway 前在维护环境备份 env、registry 与 SQLite 一致性快照；先升级 Gateway，执行新表 migration 和存量 OAuth 显式兼容映射，验证原 Owner/Engine 凭据及旧 Engine 的线协议行为。
3. Owner 复核 legacy 权限，为日常 MCP 签发 scoped 凭据并逐客户端迁移；旧 Owner token 不自动轮换。确认 setup token 文件流程仅影响未初始化管理员的安装。
4. 对选定 committed revision 生成候选快照，运行全范围扫描、P0 权限/传输/完整性验收及 P1 clean-machine 流程；对已公开二进制与计划继续公开镜像补齐全部历史扫描盲区。细节留私有 evidence，勾选清单必须引用真实证据。
5. 输出可供审阅的公开候选与发布 manifest；由后续明确运维动作创建公开仓库/标签并发布，再进行匿名源码访问和逐资产下载回验。此步骤不由 apply 自动改变远端可见性或线上服务。
6. 回滚候选时停止新 Gateway，恢复对应版本的 DB 一致性备份、组件、env 与 supervisor 状态；升级后签发的委派凭据及策略变更不会存在于旧库，不能回滚后仍对不可信客户端开放旧全局模型。重新启动后复测认证与恢复，保留未解决验收项。

## Readiness checklist mapping

| 原清单 | 本变更落点 | 完成证据 |
| --- | --- | --- |
| P0-1 公开方式 | `source-publication`、候选导出 | 指定 revision、候选 tree/digest、无私有历史；公开后另验匿名访问 |
| P0-2 扫描盲区 | 逐引用/资产/image layer inventory | 全项 report 和人工复核；timeout 不通过 |
| P0-3 权限/命令/TLS/日志/更新 | policy/grants/OAuth、诊断、安装器与拒绝矩阵 | 跨身份/资源无副作用、默认关闭执行、TLS 拒绝和完整性故障记录 |
| P0-4 实际发布 | 已完成修复对照、build manifest、发布 job | 分支/权限只读核验、CI、逐平台许可证/摘要/下载回验 |
| P1-5 上手 | 双语 README、最小配置和 MCP 示例 | clean-machine 跑通、耗时/卡点、撤销卸载记录 |
| P1-6 恢复/兼容 | version matrix、断连/取消/upgrade 故障测试 | 无自动重放、进程清理、明确恢复步骤 |
| P1-7 贡献 | 复用 CONTRIBUTING/SECURITY，补模板 | fork 无凭据构建、脱敏模拟 Issue、私密渠道实际可用 |
| P1-8 回归 | verify/release gates、工具 pins | Linux/macOS/packaging、定向故障注入确能失败 |
| P2 | 后续路线图 | 固定负载性能基线、SBOM/签名/来源证明、真实反馈驱动任务；不纳入本次完成声明 |
| 申请准备 | 后续私有证据模板 | 真实日期/口径/来源、公开源码及维护角色证据、短说明字符计数；提交前再核对官方条款，不自动提交 |
