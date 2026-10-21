# OpenWrt Engine 与多设备 Gateway

一个 Gateway 可管理多个 Engine。每个 Engine 使用独立的 Engine token，拥有独立的会话、租约、RPC 去重记录和写入 grant。Controller token 可控制同一 Gateway 注册的全部 Engine。一个 Engine 同时保留一条交互会话。

## Gateway 注册设备

保留已有 `REACH_ENGINE_ID`、`REACH_ENGINE_TOKEN` 和 `REACH_CONTROLLER_TOKEN`，它们定义默认 Engine。旧客户端不指定设备时仍访问默认 Engine。为其他设备生成独立 token，在 VPS 的 `/srv/reach/deploy/engines.json` 中填写额外设备，不重复默认设备：

```json
[{"engineId":"engine-b","engineToken":"替换为至少32字符的独立随机凭证"}]
```

`gateway.env` 增加 `REACH_ENGINES_FILE=/run/reach/engines.json`。Compose 只读挂载该文件；容器以 node 用户运行，文件必须可被容器读取，父目录限制为管理员访问。未添加其他 Engine 时，复制 `deploy/engines.json.example` 为 `engines.json`，内容为 `[]`。

重启 Gateway 后注册生效。Controller 请求通过 `?engineId=engine-b` 指定目标，覆盖所有会话控制、状态、grant 和 RPC 接口。Engine 心跳由各自凭证路由；Gateway 返回带设备参数的 WSS 地址，单次会话 token 仍独立校验。未知设备不会回退至默认设备。

## 准备 x86_64 OpenWrt 安装包

Node bundle 是统一安装交付的一部分，供同一设备上的 Gateway/MCP 使用；Rust Engine 可通过显式启用的 process 接口使用该 runtime 执行可信 workspace 脚本。只运行 Engine 的路由器上，runtime 可以保持未使用。设计与启动方式见 [Node runtime 的安装与执行边界](node-runtime.md)。

在 Linux 构建机生成静态 Engine：

```sh
rustup target add x86_64-unknown-linux-musl
CC_x86_64_unknown_linux_musl=musl-gcc cargo build --release --locked -p reach-rpc --bin engine --target x86_64-unknown-linux-musl
```

构建机需有 musl-tools、Docker、Python 3，以及 Node Alpine 和 Rust 镜像。按 `scripts/node-runtime.json` 的固定版本与 SHA256 获取官方 linux-x64-musl Node 压缩包，然后运行：

```sh
sh scripts/build-node-openwrt.sh /path/to/node-v24.21.0-linux-x64-musl.tar.gz /path/to/node-bundle reach-gateway:current
```

旧版 OpenWrt 系统的 C++ 库不能直接运行该 Node。构建脚本将 musl、libstdc++、libgcc 一并放入私有 runtime，修正 Node 的加载器和库路径。系统库无需升级。生成的 bundle 与同目录 `node-runtime.json` 必须一起发布，安装器会校验摘要。

准备路由器 `engine.env`（权限 600）：

```sh
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_ID=engine-b
REACH_ENGINE_TOKEN=替换为该设备的独立凭证
REACH_WORKSPACE_ROOTS=default:/root/.reach/workspace
```

上传静态 Engine、配置、`scripts/install-engine-openwrt.sh`、`scripts/run-node.sh`、生成的 bundle 和 manifest 到路由器的同一临时目录，以 root 执行：

```sh
sh install-engine-openwrt.sh ./engine ./engine.env ./node-v24.21.0-openwrt-x64.tar.gz
```

每次安装都会校验并安装 Node 和 POSIX sh launcher `/root/.reach/run-node.sh`，runtime 的稳定入口为 `/root/.reach/runtime/node/bin/node`，Engine 为 `/root/.reach/engine`。安装器备份旧文件，使用 procd 托管并设置开机启动，服务日志通过 `logread -e reach` 查询。工作区为 `/root/.reach/workspace`，配置在 `/etc/reach/engine.env`，版本记录在 `/root/.reach/versions.json`。当前安装器支持 x86_64、musl 和 root 主目录，不适用于其他架构。

## MCP 选择设备

更新 MCP 到支持 `engineId` 的版本，为同一 Gateway 添加两个条目：

```json
[
  {"id":"engine-a","engineId":"engine-a","gatewayUrl":"https://reach.example.com","controllerToken":"共同Controller凭证"},
  {"id":"engine-b","engineId":"engine-b","gatewayUrl":"https://reach.example.com","controllerToken":"共同Controller凭证"}
]
```

`id` 是 MCP 展示的设备名称，`engineId` 是 Gateway 注册的真实身份。省略 `engineId` 时沿用旧版默认设备路由。调用 `list_devices` 查看设备，再用 `list_workspaces({deviceId})` 连接目标并发现实际工作区名称；也可先通过 `pick_device` 连接。`get_versions` 查询所选设备的 Engine 版本和共享 Gateway 版本。

## OpenWrt 安装恢复验证范围

安装器先在私有临时目录校验并准备产物，再停止旧服务、逐文件原子替换和启动；失败恢复原文件、runtime 指针和 supervisor 状态。首次安装失败会移除新目标文件，保留用户工作区；恢复失败保留私有备份供手动恢复，不能据此报告升级成功。OpenWrt 的隔离 supervisor 夹具覆盖 staging、activation、start/health、旧配置保留和首次失败清理；这些测试不等同于真实 LaunchAgent/procd 设备已验收。具体恢复与真实平台验收仍见 [运维指南](operations.md)。
