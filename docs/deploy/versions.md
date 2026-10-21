# 组件版本与更新

MCP、Engine、Gateway 各自维护独立的 SemVer 发布版本，当前 Engine 为 `0.3.2`，Gateway 为 `0.7.2`，独立 stdio MCP Connector 为 `0.4.0`。修复递增 patch，向后兼容的功能递增 minor，破坏性变更递增 major。版本不要求同步递增；一次发布只更新实际变更的组件。

Gateway `0.7.2` 和 Engine `0.3.2` 强化开源就绪能力：限定范围客户端身份、策略绑定 grant、更安全的管理员 setup token、诊断脱敏、发布/安装校验与文档。stdio MCP 代码无需更新，版本保持 `0.4.0`，`reach-rpc/1.0` 协议版本保持不变。


Gateway `0.7.0` 和 Engine `0.3.0` 新增动态工作区文件：Engine 校验并热重载本机 JSON，在同一会话刷新工作区、执行许可和不暴露路径的 generation；Gateway 刷新列表、发布控制台事件，并撤销移除、更换根目录或关闭执行的工作区的相应文件/执行 grant。processId 控制 grant 保留至过期。stdio MCP 代码无需更新，版本保持 `0.4.0`，`reach-rpc/1.0` 协议版本保持不变。`0.7.1` / `0.3.1` 仅修复发布门禁，功能与 `0.7.0` / `0.3.0` 相同。

### 迁移到动态工作区

1. 先升级 Gateway 至 `0.7.2`，确认它仍可与现有 Engine 正常连接；再升级 Engine 至 `0.3.2`。环境变量安装保持原行为，无需修改配置。
2. 需要动态调整时，把当前根目录和执行许可写入设备本机的 `~/.reach/workspaces.json`，格式见 [Engine](engine.md)。移除服务环境中的 `REACH_WORKSPACE_ROOTS` 和 `REACH_PROCESS_WORKSPACES`，可显式设置 `REACH_WORKSPACES_FILE`，然后重启一次。实际路径、凭证和验证记录保留在忽略的 `.reach/` 文件或仓库外。
3. 后续修改文件会每 2 秒自动检查，Unix 上也可发送 `SIGHUP`；建议写临时文件后原子重命名。无效修改保留最后有效配置，无需关闭会话。
4. 回滚时恢复原工作区环境变量，移除 `REACH_WORKSPACES_FILE` 并重启。旧 Engine 忽略工作区 JSON 文件。

旧 Gateway 会更新列表，但不能在原名更换根目录时撤销旧 grant，最长可继续授权 5 分钟。尚未升级 Gateway 时请用新名称替代原名更换根目录。

Gateway `0.6.0` 新增 HTTP MCP 工具列表变更通知，声明 `listChanged: true`，通过 GET `/mcp` SSE 发送 `notifications/tools/list_changed`，POST JSON 调用保持兼容。客户端应在通知后重新获取 `tools/list`；宿主保存的旧对话工具定义仍需刷新后在新对话中验证。

Gateway `0.5.0` 和 stdio MCP `0.4.0` 新增 `list_workspaces({deviceId})`，从 Engine 就绪元数据返回文件工作区名称和 `processWorkspaces` 执行许可列表。Gateway 同时修复 OAuth 客户端在多次 MCP 初始化之间的 Engine 会话归属，支持每次工具调用创建新 MCP 会话的客户端。Engine `0.2.2` 随本次发布重建，继续使用现有工作区元数据协议，无需修改工作区配置。

Gateway `0.4.0` 新增 MCP OAuth 授权，支持动态客户端注册、S256 PKCE、密码与二次验证批准、轮换刷新令牌和控制台撤销应用授权。启用控制台并完成管理员设置后即可使用；原有 Controller token 和旧 Engine 保持兼容，接入步骤见 [MCP 配置](mcp.md#chatgpt-等-oauth-客户端remote-http)。

| 组件 | 版本的唯一维护位置 | 产物中的版本 |
| --- | --- | --- |
| Engine | `crates/reach-rpc/Cargo.toml` 的 `[package].version` | 构建时通过 `CARGO_PKG_VERSION` 编入二进制 |
| Gateway | `packages/reach-rpc/package.json` 的 `version` | npm 构建生成的 `dist/version.json` |
| MCP | `packages/grok-bot-mcp-connector/package.json` 的 `version` | npm 构建生成的 `dist/version.json` |

`reach-rpc/1.0` 和 MCP 的 `2025-03-26` 是协议版本，分别约束通信格式。组件升级不自动改变协议版本，也不要求两端组件发布号完全相同。Node runtime 的版本由 `scripts/node-runtime.json` 单独维护。

## 兼容矩阵与升级顺序

所有组件都使用 `reach-rpc/1.0` 线协议；新增字段只做可选扩展，旧组件忽略不理解的字段。Gateway 对 Engine 上报的其他协议版本立即关闭会话，`/session/status` 的 `closureReason` 为 `unsupported_protocol`，日志记录 `SESSION_PROTOCOL_UNSUPPORTED`，不会转发任何请求，也不会自动重试。

| 组合 | 状态 | 限制与可见结果 |
| --- | --- | --- |
| Gateway 0.7.x + Engine 0.3.x | 支持（当前） | 动态工作区、generation 撤销、执行许可列表全部可用 |
| Gateway 0.7.x + Engine 0.2.x | 支持，降级 | 文件读写正常；Engine 不上报 generation，只有移除工作区才撤销 grant；不支持工作区文件热重载 |
| Gateway 0.5–0.6 + Engine 0.3.x | 兼容，不推荐 | 文件读写正常；原名更换根目录后旧写入/执行 grant 最长仍可使用 5 分钟。先升级 Gateway |
| Gateway < 0.5 | 未测试，不支持 | 缺少 `list_workspaces` 及当前授权模型；先升级 Gateway |
| Engine 不提供 `process.*`（非 Unix 构建） | 仅文件 | 进程工具返回 `PROCESS_UNSUPPORTED`，Gateway 不转发 |
| Engine 未上报工作区名称 | 不支持 | stdio Connector 返回 `WORKSPACES_UNAVAILABLE`；升级 Engine |
| stdio Connector 0.4.x + Gateway ≥ 0.5 | 支持 | Connector 的本地工具列表只是便利，最终权限由 Gateway 检查 |
| 委派身份/scoped OAuth | 需要当前 Gateway 及 `REACH_DATA_DIR` | 旧 Gateway 不理解新数据库 schema，回滚须成对恢复旧快照，见[客户端权限](client-access.md#升级和回滚) |

升级顺序：备份 Gateway 数据目录 → 升级 Gateway 并确认现有 Engine 仍能 ready → 逐台升级 Engine → 需要时更新 Connector。回滚按相反顺序进行；Engine 可以单独回退到 0.2.x，Gateway 回退需要对应的数据库快照。以上组合由 `mcp.test.ts` 的兼容矩阵测试和基于发布 tag 的跨版本夹具验证；未列出的组合视为未测试。

## 查看实际产物的版本

以下命令只输出版本号，不启动服务，也不加载私有服务配置：

```bash
"$HOME/.local/share/reach/engine" --version
"$HOME/.reach/runtime/node/bin/node" "$HOME/.local/share/reach/mcp/dist/main.js" --version
"$HOME/.reach/runtime/node/bin/node" packages/reach-rpc/dist/gateway-main.js --version
```

三个入口也支持 `-V`。Engine 安装前会查询构建产物版本；安装结束把实际安装的 `engineVersion`、`mcpVersion` 和 `nodeVersion` 写入 `~/.reach/versions.json`，未安装 MCP 时其值为 `null`。此文件描述设备端安装产物，运行中的进程仍需重新启动才能使用新版本。

Gateway 的公开 `GET /healthz` 返回 `gatewayVersion`。需要 Controller 认证的 `GET/POST /session/status` 返回 `gatewayVersion` 和 `engineVersion`。Engine 在心跳和 `session.ready` 上报发布号，所以版本检查不需要专门打开会话。

MCP 初始化响应的 `serverInfo.version` 返回当前 MCP 产物版本。所有工具模式均提供 `get_versions`：

```json
{"deviceId":"engine-a"}
```

示例结果：

```json
{
  "mcpVersion": "0.4.0",
  "deviceId": "engine-a",
  "gatewayVersion": "0.7.2",
  "engineVersion": "0.3.2"
}
```

查询只读取状态，不会选择设备、打开或关闭会话。省略 `deviceId` 时查询已选设备；未选设备时只返回本地 MCP 版本，远端字段为 `null`。旧 Gateway 或旧 Engine 未上报版本时对应字段也为 `null`，不会假设它与本机版本相同。网络或认证失败返回工具错误。

`engineVersion` 是 Gateway 最后收到的 Engine 发布号，不表示 Engine 当前在线。Gateway 重启后，在收到第一条心跳或就绪消息前它为 `null`；设备离线后可能仍保留最后上报的版本。

## 更新发布版本

更新 Gateway 或 MCP 的包版本，例如：

```bash
npm --prefix packages/reach-rpc version 0.7.2 --no-git-tag-version
npm --prefix packages/grok-bot-mcp-connector version 0.4.0 --no-git-tag-version
```

仅对实际更新的组件执行相应命令。Gateway 的 npm lockfile 由 npm 同步更新。Engine 修改 Cargo manifest 后运行 `cargo check --workspace` 更新 `Cargo.lock` 中的包版本。

随后重新构建目标组件、运行 `bash scripts/verify.sh`，按 [运维与回滚](operations.md) 更新安装产物或 Gateway 容器。Gateway/MCP 发布时必须携带整个构建输出，包括 `dist/version.json`；只修改包清单不会改变已有 JS 产物报告的版本。MCP 安装器会复制版本模块和版本 JSON。

升级后通过 CLI、`get_versions` 或 Gateway 状态确认版本。除现有构建和安装流程外，也可选择下述 GitHub Release 自动更新。

## GitHub Release 发布

源码仓库与 Engine/Gateway 二进制分发仓库可以独立。公开二进制不等于完整源码已开源。正式候选必须从**已批准、可匿名读取的公共源码 revision** 构建，`release-manifest.json` 记录该完整 revision 和源码链接；私有历史与公共 revision 的对应只留在私有记录中。当前工作区新增的授权和发布门禁尚未形成新远端发行版，不应由旧版本号推断已有这些能力。

| 组件 | 必需 Release 资产 |
| --- | --- |
| Engine | `engine-linux-x64-musl`、`engine-darwin-arm64`、`engine-darwin-x64`，每个二进制各有 `.NOTICES.txt` 和 `.licenses.tgz` |
| Gateway | `gateway-amd64.tgz`；配置 GHCR 发布时额外提供 `gateway-image.txt`，内容为完整 image digest 引用 |
| 两者 | `LICENSE`、`THIRD_PARTY_NOTICES.txt`、`third-party-licenses.tgz`、`release-manifest.json`、`SHA256SUMS` |

原 executable 资产名保持兼容。Engine 的平台声明绑定目标、编译器、组件版本和二进制摘要；公共声明包收集三个平台的声明。Linux x64 Engine 为静态 musl 二进制，用于 systemd Linux 和 x86_64 OpenWrt。macOS 分别使用 arm64 与 Intel runner。Gateway tar 包含构建输出、npm manifests、Compose/Dockerfile、宿主机 helpers 和许可证；镜像也包含同一声明。首次安装可选 updater 的 systemd 模板从对应公共源码取得，见 [运维](operations.md#安装可选-github-release-updater)。

发布 workflow 把只读 build/verify/candidate 与受 `public-release` environment 保护的 publish 分开。PR/fork 不接收发布凭据；手动 dispatch 只验证，不发布。正式发布要求配置的源码仓库、默认分支上的合法组件 tag、Linux/macOS 验证、Linux packaging、全部平台构建、资产检查与源码/资产/镜像层扫描成功，并批准**这一批确切字节**的 candidate 摘要。跨仓库 token 和可选 GHCR token 仅给 publish。目标仓库、environment protection 与 token 权限需在实际部署环境只读核验，文件中的 workflow 不证明它们已配置。

发布说明采用审阅过的固定内容和公共源码链接，不复制私有提交说明。已有 tag 或 Release 会阻断发布；失败不覆盖或删除已有版本。下载回验必须覆盖全部资产，验证摘要、版本、平台、声明和可选 image digest；任一超时仍为 incomplete。

构建、白名单、权限配置及回验命令见 [发布流程](../dev/releases.md)。本流程使用批准 HTTPS 渠道上的 SHA-256，并未实现发行者签名、SBOM 或来源证明。原有安装与自动更新的信任配置保持独立，不会因文档修改切换仓库或服务。

## 可选自动更新

自动更新默认关闭；仅 `REACH_UPDATE_ENABLED=1` 或 `true` 启用，并需设置 `REACH_UPDATE_REPO=example/reach`。配置详见 [配置](configuration.md)，宿主机 helper 安装与回滚见 [运维](operations.md)。检查使用分页 GitHub Releases，按组件选择最高稳定 `X.Y.Z`，忽略 draft、prerelease、相等或更旧版本。默认每小时检查，失败时只对更新器退避，不改变心跳或 HTTP 服务。

Engine 在独立后台线程按批准 HTTPS 来源下载，校验唯一 SHA-256、ELF/Mach-O 平台/架构后才探测 `--version`，只在没有连接中、活动或 draining 会话时替换，保存 `engine.prev` 与私有健康 intent。新版安装器的启动 guard 在 supervisor 重启后等待新进程首次成功心跳；退出或 30 秒超时自动恢复旧 binary 和版本清单。旧启动脚本未安装 guard 时不应用 host 更新，需先在维护环境升级安装器。存在的 `~/.reach/versions.json` 同步记录 `engineVersion`。Compose Engine 与 Gateway 则在空闲时写入共享目录的 `request.json`，由宿主机 helper 先下载、校验并准备镜像，再通过共享目录握手等待空闲、暂缓新会话并重建容器；Gateway 要求所有注册 Engine 的会话均为 `none`。未安装 helper 时只保留更新请求与日志，当前进程继续运行。

自动更新不替换独立 Node runtime，也不更新 MCP Connector。更新失败保留当前运行产物；成功更新会创建全新进程，内存会话、grant 和去重状态不会恢复，客户端需重新打开会话。
