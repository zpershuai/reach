# Workspace Node 脚本任务

[English](processes.md) | 简体中文

Engine 提供 `process.run/status/logs/stop/list` RPC，执行目标设备 workspace 内的可信 `.js`、`.mjs`、`.cjs` 脚本。HTTP MCP 名称使用下划线，例如 `process_run`；stdio 使用点号。HTTP/static stdio 的参数需要额外包含 `deviceId`。

脚本以 Engine 服务账号的 OS 权限执行。入口和 cwd 校验不构成沙箱：代码仍能访问该账号可访问的文件、网络和其他系统资源。入口内容通过 no-follow 描述符读取成快照，由内置 Node 启动模块以原始模块路径加载，支持 CJS/ESM 和相对导入。ESM 推荐 `.mjs` 或 `package.json` 的 `type: module`。不提供 shell、任意解释器、调用方 Node flags、环境变量覆盖、stdin 或 npm 安装接口。

## 显式启用

在目标 Engine 的私有配置文件中设置，例如：

```sh
REACH_PROCESS_WORKSPACES=default
REACH_PROCESS_NODE_BIN=/absolute/path/to/home/.reach/runtime/node/bin/node
```

未配置 allowlist 时所有 workspace 都禁止执行。解释器默认是 Engine 账号的 `~/.reach/runtime/node/bin/node`，不存在时返回 `RUNTIME_UNAVAILABLE`，不会改用 PATH 中的 Node。`REACH_NODE_BIN` 仍只控制 launcher，与这个配置独立。既有安装不会自动启用执行；运维人员在完成配置和产物更新后按原有流程重启 Engine。

| Engine 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `REACH_PROCESS_WORKSPACES` | 空 | 允许执行的 workspace 名称，逗号分隔 |
| `REACH_PROCESS_NODE_BIN` | 私有 runtime 入口 | 绝对路径 |
| `REACH_PROCESS_MAX_CONCURRENT` | 4 | 并发任务数，最大 64 |
| `REACH_PROCESS_MAX_RUNTIME_MS` | 300000 | 单任务运行上限，最大 86400000 |
| `REACH_PROCESS_MAX_RECORDS` | 128 | session 保留任务总数，最大 1024 |
| `REACH_PROCESS_MAX_LOG_BYTES` | 1048576 | 每任务输出保留字节，最大 16777216 |
| `REACH_PROCESS_STOP_GRACE_MS` | 2000 | 终止宽限期，最大 10000 |

未传 `timeoutMs` 时使用 60000 与 Engine 上限中的较小值；显式请求值不能超过 Engine 上限。任务记录和 launchId 保留到 session 结束，容量耗尽时拒绝新任务，不淘汰去重记录。

### 文件模式下的执行许可

Engine 0.3.0 支持 `REACH_WORKSPACES_FILE` 指定的工作区 JSON，或者在两个工作区环境变量均未设置时自动读取已存在的 `~/.reach/workspaces.json`。文件中的 `"process": true` 为对应工作区开启执行，默认关闭；文件模式不能同时设置 `REACH_WORKSPACE_ROOTS` 或 `REACH_PROCESS_WORKSPACES`。例如 `{"workspaces":{"scripts":{"path":"/home/example/reach-scripts","process":true}}}`，根目录必须已经存在，未知键或无效条目会导致整份配置无效。

文件模式每 2 秒轮询，Unix `SIGHUP` 也可触发重载；配置只在请求之间替换。启动时无效会退出，运行中无效 JSON、不可读或删除的文件则保留最后有效配置，记录 `WORKSPACE_RELOAD_FAILED`，不回显文件内容。环境模式不热重载。

移除、更换工作区根目录或关闭执行许可时，Engine 使用正常终止流程停止其中当前会话拥有的进程，`process.status` 仍能查询终止记录，新 `process.run` 被拒绝。即使个别进程未能在宽限期内结束，工作区变更也照常生效，残留进程按 session 清理失败规则保留所有权并在 session 结束时继续清理。其他工作区的进程继续运行。根目录移除/更换同时使对应文件游标失效。刷新 ready 后，Gateway 0.7.2 撤销受影响的执行 grant；关闭执行不会撤销文件写入 grant。仅按 processId 绑定的控制 grant 保留到过期。

应先升级 Gateway 再升级 Engine。旧 Gateway 更换根目录后仍可能接受旧 grant，直到 5 分钟到期；在旧 Gateway 上请使用新工作区名称。格式、来源优先级和迁移步骤见 [Engine](engine_cn.md) 和 [组件版本](versions_cn.md)。

## 调用流程

先调用 `list_workspaces({deviceId})`，从 `processWorkspaces` 选择允许执行的名称。列表为空时不能启动脚本。下面假设实际返回的执行工作区包含 `default`；先通过文件接口在该工作区创建脚本，然后启动：

```json
{
  "deviceId": "engine-a",
  "workspace": "default",
  "script": "scripts/report.mjs",
  "launchId": "report-001",
  "args": ["--format", "json"],
  "cwd": ".",
  "timeoutMs": 60000
}
```

`process_run` 立即返回 `processId`、`launchId`、state 和时间。可传 `ifMatch` 校验入口 revision；它不覆盖依赖文件。

- `process_status`：传 `processId` 或 `launchId`，必须二选一。返回 state、退出码、signal、原因和时间；running 不表示服务已就绪。
- `process_logs`：传 `processId`，可传 `cursor` 和 `maxBytes`（默认及最大 16384）。返回带 stream 标记的 records、nextCursor、truncated、eof。下一次使用 nextCursor，避免重复读取。超出保留上限会丢弃最旧内容并报告截断；maxBytes 太小、无法容纳下一个 Unicode 字符时返回 INVALID_PARAMS。
- `process_stop`：传 `processId`。请求正常终止，宽限期后强制终止；返回 stopping 后轮询 status。对已结束任务重复 stop 安全。
- `process_list`：可传 workspace、cursor 和 maxEntries（默认 50、最大 128），只列当前 session 的任务。

状态为 starting、running、stopping、exited、stopped、timed_out、failed。脚本非零退出仍是 exited，通过 exitCode 判断结果。starting 是 spawn 前的内部状态；成功 run 通常返回 running，也可能已进入终态。主脚本自然退出后，Engine 也会终止同组普通后代，不允许它们作为持久后台服务继续运行。输出使用 UTF-8，非法字节替换为替代字符。

启动响应丢失时，用同一 session 的 `process_status` 和原 launchId 查询。相同 launchId、相同参数不会重复启动；参数不同返回 `LAUNCH_ID_CONFLICT`。若同一 session 查询返回 PROCESS_NOT_FOUND，可以用原 launchId 和完全相同参数重试；MCP 不自动重试。spawn 失败返回 RUNTIME_UNAVAILABLE，并保留 state=failed 的记录；重复该 launchId 仍返回相同错误。需要再执行时使用新 launchId。MCP 不自动重放启动请求，也不会为了查旧任务而打开替代 session。

## 权限与清理

MCP 自动向 Gateway 申请执行/控制 grant；它不是人工确认流程。执行 grant 绑定 Engine、session、workspace、精确入口及 launchId，控制 grant 绑定 processId；有效期五分钟。文件写 grant 不能授权执行。Engine 还独立检查 workspace allowlist 和任务归属。

任务属于当前 Engine session。session close、断开、租约到期、轮换或正常 shutdown 都停止所属任务并清理输出。任务本身不续租，MCP 查询沿用既有续租策略。活跃任务阻止 idle 提前关闭，但不能突破 lease 和 rotation 上限。退出后无法跨 session 恢复任务或日志。清理失败时 Engine 保留 session 所有权并重试；此时收到 SIGTERM 会记录 PROCESS_CLEANUP_FAILED 后退出，不报告成功释放。内核不可终止状态下的进程无法保证在退出前清理完毕。

Unix 实现管理独立进程组，停止普通后代进程并回收直接子进程；孙进程由其父进程或 OS 回收。可信脚本主动脱离进程组的后代，以及 Engine 被 OS 强杀，不属于正常清理保证。非 Unix 不注册 process 方法，MCP 按不支持该能力处理；内部执行入口也以 `PROCESS_UNSUPPORTED` 拒绝运行。

部署前，在目标平台使用安装的私有 runtime 运行同样的模块加载、停止子进程和 session 清理集成测试。交叉编译成功不等同于目标设备执行验证。
