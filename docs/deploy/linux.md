# Linux Engine 与 systemd

Linux Engine 与 Gateway 可以运行在同一台机器，也可运行在其他服务器。所有 Engine 共用已有 Gateway，以独立设备 ID 和 Engine token 区分。Engine 只发起 HTTPS 心跳和按需 WSS 连接，无需新增入站端口。

## 安装

`scripts/install-engine-linux.sh` 支持有 Bash、Python 3 和 systemd 的 Linux。root 使用系统服务，普通用户使用用户服务。普通用户需有可用的 systemd 用户管理器；若要求未登录时也运行，管理员须预先启用该用户的 linger。OpenWrt 使用独立的 [procd 安装器](openwrt.md)。

准备与目标架构匹配的 Engine 二进制，以及私有配置：

```sh
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_ID=engine-linux
REACH_ENGINE_TOKEN=替换为该设备的独立凭证
REACH_WORKSPACE_ROOTS=default:/absolute/path/to/workspace
```

先按 [多设备 Gateway 注册](openwrt.md) 为设备配置凭证，再将二进制、配置和以下文件上传到同一临时目录：`install-engine-linux.sh`、`install-node-runtime.py`、`node-runtime.json`、`run-node.sh`。安装时以最终运行 Engine 的账号执行：

```sh
bash install-engine-linux.sh ./engine ./engine.env
```

每次安装会自动准备并校验 `~/.reach/runtime/node/bin/node`。这是供同机 Gateway/MCP 使用的交付策略；启用 process 接口后，Rust Engine 使用该 runtime 执行可信 workspace 脚本；默认不启用执行。通过 `~/.local/share/reach/run-node.sh` 启动 JS 组件，详见 [Node runtime](node-runtime.md)。可传入与固定版本、平台和 SHA256 匹配的官方 Node 压缩包，避免目标机器联网下载：

```sh
bash install-engine-linux.sh ./engine ./engine.env ./node-v24.21.0-linux-x64.tar.gz
```

安装器在替换服务之前验证 Engine 和 runtime，备份旧文件到 `~/.reach/backups/<时间>-linux`，安装后启动服务并启用开机运行。已有 MCP 文件保留，安装记录写入 `~/.reach/versions.json`。重复安装会重启该 Engine 并中断其活动会话。

| 文件 | 位置 |
| --- | --- |
| Engine | `~/.local/share/reach/engine` |
| 启动脚本 | `~/.local/share/reach/start-engine.sh` |
| 私有配置 | `~/.config/reach/engine.env`，权限 600 |
| 默认工作区 | `~/.reach/workspace` |
| Node runtime | `~/.reach/runtime/node/bin/node` |
| root systemd 单元 | `/etc/systemd/system/reach-engine.service` |
| 用户 systemd 单元 | `~/.config/systemd/user/reach-engine.service` |

## 服务检查与管理

以 root 安装的系统服务：

```sh
systemctl status reach-engine.service
journalctl -u reach-engine.service -n 30
systemctl restart reach-engine.service
```

以普通用户安装的用户服务：

```sh
systemctl --user status reach-engine.service
journalctl --user -u reach-engine.service -n 30
systemctl --user restart reach-engine.service
loginctl show-user "$(id -un)" -p Linger
```

需要无人登录时运行的用户服务，应由管理员为目标账号启用 linger，例如 `loginctl enable-linger <engine-user>`。以目标用户检查结果；安装器不会自动提升权限。

同一主机可以同时运行 Docker Gateway 和 systemd Engine，Engine 仍使用注册的 Gateway HTTPS URL。MCP 设备条目通过 `engineId` 选择注册设备；新增设备后重启 MCP 子进程加载更新后的设备列表。不要在公开文档中记录真实服务器列表或服务状态。
