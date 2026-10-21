# Tasks

实施顺序覆盖 P0/P1；P2 和实际公开/发布动作列在末尾 follow-up。每项只有在所列交付物或验证完成后才勾选；真实部署、扫描、验收结果仅保存在 `.reach/` 或仓库外。缺少环境或权限的真实验收保持未完成，不能用模拟测试代替。

## 1. P0 — 公开候选与扫描基础

- [x] 1.1 只读核对清单所指发布分支、实际构建路径和已完成许可证修复，记录合并状态、发布目标及凭据存在性/权限范围（不读取或输出 secret）；以带日期的私有对照表验收，无法核验的状态明确标为 unknown。
- [x] 1.2 实现 `scripts/prepare-public-source.py`，从指定 commit 导出到空候选目录并保留版权/许可证；用临时 Git 仓库测试无 `.git`/`.reach`/私有配置/生成物、不覆盖非空目录、不更改源树和引用。
- [x] 1.3 为 `scripts/verify-publication.py` 定义逐引用、资产、image digest/layer 和 build-context 的私有 inventory/report 格式；用缺项、重复项、timeout 和 bytes 变化夹具验证 incomplete 与失效逻辑。
- [x] 1.4 接入固定版本秘密扫描及部署信息人工复核结果，扫描源码、解包资产和所有镜像历史层；用后层删除前层 synthetic secret 的镜像夹具证明不会漏扫，真实报告只写私有目录。
- [x] 1.5 实现 evidence-bound readiness 判定，覆盖未处置有效凭据、未复核例外、未复核 legacy 权限和未验收 P0；用拒绝用例确认删除文件或忽略超时均不能使 gate 通过。
- [x] 1.6 更新 `docs/dev/publishing-checklist.md`，提供干净快照、逐项扫描、凭据处置、私有证据位置和后续公开流程；在 synthetic 候选上逐条运行文档命令，确认不重写历史、不改变远端或运行服务。

## 2. P0 — 客户端身份与策略存储

- [x] 2.1 在 `console-api/store.ts` 增加 principal/credential/permission 表与事务 migration，映射已有 OAuth 为显式 `legacy-global/review_required`；用空库、旧库、重复启动和失败回滚测试验证数据及原 Owner/Engine 凭据兼容。
- [x] 2.2 实现 256-bit delegated token 生成、digest 存储、到期、旋转、撤销和策略 revision；用注入时钟测试 401、旧 token 失效、重启持久化、单次明文披露及数据库中无 plaintext token。
- [x] 2.3 实现明确 Engine/workspace/read/write/execute 策略解析和操作映射，拒绝普通策略通配符与未知操作；新增共享 synthetic fixture，验证空权限、只读、只写、执行、同名跨设备工作区和新增资源默认拒绝。
- [x] 2.4 新增 console access-client 管理 API，接入 recent-auth、Origin、CSRF、审计及事务服务；接口测试验证各类 bearer token 不能管理权限、过期 re-auth 拒绝、失败无部分写入、详情无 token/digest。
- [x] 2.5 更新配置与安全文档说明 Owner、delegated、OAuth 与单管理员边界、legacy 复核和凭据生命周期；对照接口测试核对示例字段、过期行为和兼容说明。

## 3. P0 — 全入口授权、会话与 grant

- [x] 3.1 建立服务端认证上下文和绑定 principal 的 Engine facade，改造 REST 及 MCP in-process 调用；在 `gateway.test.ts` 和 MCP 测试中验证原始 EngineApi 不暴露给请求入口、伪造标签/身份不提权、直接与单层包装调用等价。
- [x] 3.2 为设备、workspace、capability、状态和版本发现实施策略过滤，统一隐藏/未知 Engine 404；用双身份双 Engine 测试确认 response、分页及工具列表均无越权元数据。
- [x] 3.3 为文件/进程 grant 增加 principal/Engine/policy revision，签发及转发前均复查；覆盖跨身份、跨设备、过期、伪造、只读、跨 grant 类型与 queued-policy-change 的无转发/无副作用测试。
- [x] 3.4 将 session open/renew/close 和 process status/logs/list/stop 绑定真实 principal 和可信 task workspace；测试已知他人 session/process/launch ID 仍不可访问，默认关闭执行仍在 Engine 拒绝。
- [x] 3.5 接入撤销、旋转、到期定时器和权限收紧的同步阻断、grant 失效及 drain；用真实 Engine 集成验证无新请求时也能到期清理、普通后代终止、清理失败保留所有权且不影响另一身份。
- [x] 3.6 更新协议与 MCP/权限文档，说明错误形态、操作权限映射、自动 grant 不等于人工批准和原子写撤销边界；对照新增矩阵确认文档与 REST/MCP/Connector 行为一致。

## 4. P0 — OAuth 与控制台权限管理

- [x] 4.1 扩展 OAuth 同意页的 Engine/workspace/read/write/execute 选择和策略保存；在 `oauth.test.ts` 验证无默认全局权限、未选择不签发有效权限、篡改资源选择不能绕过 Owner 认证与 PKCE。
- [x] 4.2 使 token 验证、refresh、MCP session 和 ownership pool 使用稳定 principal 与当前策略；测试刷新不扩大权限、跨 principal session 为 404、idle grace 后不能复用已撤销权限。
- [x] 4.3 将 OAuth revoke 与 refresh replay 接入统一会话/grant/进程回收；测试 token 立即拒绝、客户端 pool 清理、cleanup 重试以及其他 OAuth 客户端不受影响。
- [x] 4.4 在 Gateway console 增加委派身份创建/旋转/撤销、权限编辑和 legacy 复核界面；组件测试验证 token 只展示一次、未复核全局权限可见、recent-auth 错误可恢复且不回显凭据。
- [x] 4.5 补充 legacy 迁移、Owner 等价权限风险、scoped 客户端接入和数据库回滚文档；在旧库升级夹具与 console 测试中逐步核对文档流程，不操作现有安装。

## 5. P0 — TLS 与诊断输出

- [x] 5.1 将自动 setup token 交付改为数据目录的 0600 普通文件，安全复用/删除，保留显式 env token 和已建管理员；测试 symlink、不安全权限、并发创建、重启、成功 setup、旧日志 token 拒绝及 stdout/stderr 无 token。
- [x] 5.2 收紧 Gateway HTTP/audit、Engine Lease Debug/transport、Connector 和安装更新诊断为允许字段及稳定错误码；sentinel 测试覆盖成功、无效输入、拒绝、upstream echo、超时、换行注入和大字段，确认日志无凭据/正文/args/进程输出。
- [x] 5.3 为 heartbeat HTTPS、Engine WSS、Connector HTTPS 增加本地证书拒绝集成夹具；验证 expired/untrusted/wrong-host 失败且无凭据转发、无 insecure fallback，并保持可信证书成功路径。
- [x] 5.4 更新 console setup、SECURITY 和 troubleshooting，解释 Gateway 可见 RPC 内容、audit 元数据、可信脚本系统权限及私有设置凭据读取；按干净 fixture 验证说明，不要求公开 env dump 或敏感日志。

## 6. P0 — 安装更新完整性与恢复

- [x] 6.1 收敛 installer、Rust/TS updater 和 host helper 的 approved HTTPS origin/redirect 策略，测试跨 origin 去 Authorization、HTTP/未知来源拒绝及显式 fixture test mode；确认生产默认不接受 file/plain HTTP 覆盖。
- [x] 6.2 在执行下载包前验证 ELF/Mach-O 或 image platform 身份，并严格检查唯一 checksum、component/version；扩展 `test-install-engine.py`、updater 和 helper 测试，验证错误架构/格式、重复摘要、篡改、截断和错误版本不会执行或替换产物。
- [x] 6.3 在原 Linux 回滚测试上补齐新验证步骤的故障注入；运行 `test-engine-linux-installer.py`，确认失败前旧服务未停止、激活/start 失败恢复文件/runtime/服务状态，失败回滚保留可操作恢复信息。
- [x] 6.4 为 macOS/OpenWrt installer 补充 staging、activation/start 失败恢复及首次安装失败清理；用隔离 supervisor 夹具验证配置/旧版本保留、状态恢复和真实环境验收范围说明。
- [x] 6.5 为 host auto-update 与 Compose helper 补充启动健康确认及恢复路径；运行 Engine/Gateway updater 与 `test-release-helpers.py`，验证 idle admission、busy 不替换、失败保留/恢复旧版本和凭据挂载不变。
- [x] 6.6 更新安装/升级/运维指南，明确摘要信任渠道、签名尚未实现、各 supervisor 的恢复与手动 fallback；在故障夹具中逐项对照恢复步骤及文档命令。

## 7. P0 — 实际发布路径与资产验收

- [x] 7.1 根据 1.1 对照表将已完成的许可证/第三方声明修复接入实际 package scripts；保留现有 executable asset 名，补强制伴随资产及 tar/image 内文件，逐平台检查实际 Rust/Node/字体等分发声明。
- [x] 7.2 扩展 `release-metadata.py` 输出公共 source revision、version、platform、toolchain、资产白名单和摘要 manifest；测试漏项/重复/额外文件/版本不符/私有信息拒绝，不向公开元数据写私有 revision 映射。
- [x] 7.3 拆分 release workflow 的 build/verify/publish 权限和 GHCR/跨仓库目标配置；用 workflow 约束检查和无发布 dry run 验证 fork/PR 无 secrets、可信 tag 且所有 gate 成功才发布、上传资产使用准确白名单。
- [x] 7.4 扩展 `verify-packaging.sh` 及 macOS package checks，逐资产验证版本、平台、LICENSE/notice 和摘要；故意移除一个平台声明或注入未批准资产，确认对应 gate 失败。
- [x] 7.5 实现远端下载回验命令，比较完整 approved manifest 与逐资产 bytes/image digest；以本地 HTTP fixture 的显式测试模式验证 timeout、漏资产和摘要不同保持 incomplete，不覆盖或删除已有 Release。
- [x] 7.6 更新版本/发布文档，说明独立源码与二进制仓库的对应、公共 source revision 前置条件、发布权限及逐资产下载验收；以生成的 synthetic manifest 核对文档流程和匿名源码链接占位格式。

## 8. P1 — 完整上手、兼容和贡献路径

- [ ] 8.1 同步 README/README_cn 的用途、限制、架构、支持平台、最低依赖、源码构建/自托管和卸载入口，删除未经测量的时长承诺；在无历史配置目录按入口命令完成 build 和启动。
- [ ] 8.2 提供 reserved-value 最小配置与完整 scoped MCP 示例，覆盖 Engine 配对、read/write、明确启用可信 Node 脚本、撤销客户端/设备和卸载；在非 root 隔离测试身份下执行示例，验证默认不能执行、越权失败和卸载保留工作区。
- [x] 8.3 扩充 Engine/Gateway/runtime/Connector 的协议与 feature 兼容矩阵和升级顺序；用支持组合、缺 capability、未知协议及旧 Gateway/新 workspace 特性夹具核对可操作错误和明确限制。
- [x] 8.4 扩展现有真实 Engine 集成测试覆盖掉线、token 失效、reply lost、reconnect、timeout 和取消；断言副作用不自动重放、launch identity 不绕过、普通后代清理，更新 troubleshooting 中的恢复步骤。
- [ ] 8.5 补 Issue/PR 模板并完善现有 CONTRIBUTING/SECURITY 的测试/支持版本/私密报告说明；从无部署凭据的 fork-style checkout 构建测试，生成脱敏模拟 issue，并验证文档不会要求公开秘密。
- [x] 8.6 仅把证据已就绪的后续事项整理到路线图与私有证据模板：固定负载性能基线、SBOM/签名/来源证明、真实反馈和申请维护证据；以交付模板和 P2 标记验收，不宣称实现 P2、公开源码或已提交申请。

## 9. P1 — CI 与固定验证环境

- [x] 9.1 锁定经验证的准确 Rust/Node/Python 及 scanner 版本、Actions immutable SHA，保留 npm/Cargo locks；运行锁定环境构建，确认 lock drift 或工具版本偏差会明确失败，文档区分支持范围与 CI pins。
- [ ] 9.2 将各组新增授权、TLS、日志、恢复、兼容、安装完整性和许可证检查接入 `scripts/verify.sh` 与适当平台 job；运行 Linux/macOS 验证及 Linux packaging，确认 release 使用相同 gate 且无真实报告上传。
- [x] 9.3 在隔离副本加入定向故障注入验证：分别关闭授权检查、破坏 workspace containment、跳过 checksum；确认对应负向测试逐一失败，并验证正常代码全部通过，不修改主工作区行为。

## 10. 跨能力验收与交付

- [ ] 10.1 对全部规划和实现执行 `openspec validate --all --strict --no-interactive`、`bash scripts/verify.sh` 和 Linux `bash scripts/verify-packaging.sh`；保存准确提交/环境/结果于私有报告，不把未运行的平台标为通过。
- [x] 10.2 在无历史配置的隔离机器/环境，仅按文档完成 build/install → Gateway → Engine → scoped MCP → 测试工作区 → 允许脚本 → revoke → uninstall；私有记录实际耗时、卡点、非 root 身份、清理和故障恢复结果。
- [ ] 10.3 运行选定 committed revision 的候选导出及 inventory 全覆盖扫描，补查清单提及超时资产和继续公开的容器历史层；保存逐项摘要、工具版本、人工复核和例外处置证据，未覆盖项阻断 readiness。
- [x] 10.4 只读核验目标仓库的私密安全报告渠道、发布保护/权限和已有待继续公开资产的下载结果；记录实际可用与 pending 项，不能把历史许可证修复或未核验远端状态重述成当前缺陷/完成事实。
- [ ] 10.5 对照 design 的清单映射交付 P0/P1 readiness 汇总和具体公开候选；更新原清单时仅勾选有真实证据的项目，明确工程完成、公开前门槛、发布后匿名/下载验证三种状态，确保跟踪文件没有真实部署报告内容。

## Workflow follow-up

- 实施与验收经审阅后，另行调用 verify/archive 工作流；本次 propose 不实施或归档。
- 源码公开、远端创建/推送、正式标签发布、配置真实发布凭据与线上升级为后续明确运维动作；完成前交付可审阅候选，保留原私有历史和现有安装。
- 实际公开后再验证匿名源码访问、公共 source revision 及全部新 Release 的远端下载结果，不能提前勾选这些发布后项目。
- 若发现有效凭据暴露，先按私有处置记录完成撤销/轮换，再批准发布；不自动轮换真实部署凭据。
- P2 按真实需求创建后续变更；申请材料只使用可核验事实，提交前重新查阅官方条款并确认字符限制，不自动提交申请。
