# Linux Engine and systemd

English | [简体中文](linux_cn.md)

Linux Engine may share a host with Gateway or run on another server. All Engines use the existing Gateway, with independent IDs/tokens. They initiate HTTPS heartbeats and on-demand WSS without new inbound ports.

## Installation

`scripts/install-engine-linux.sh` supports Linux with Bash, Python 3 and systemd. Root installs a system service; ordinary users install a user service and need a working systemd user manager. For operation without login, an administrator must enable linger first. OpenWrt has a separate [procd installer](openwrt.md).

Prepare the target-architecture Engine binary and private configuration:

```sh
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_ID=engine-linux
REACH_ENGINE_TOKEN=replace-with-this-devices-independent-credential
REACH_WORKSPACE_ROOTS=default:/absolute/path/to/workspace
```

First register credentials following [multiple-device Gateway registration](openwrt.md). Upload the binary/configuration and `install-engine-linux.sh`, `install-engine-linux.py`, `install-node-runtime.py`, `node-runtime.json`, `run-node.sh` into one temporary directory. Run as the final Engine service account:

```sh
bash install-engine-linux.sh ./engine ./engine.env
```

Each installation prepares/verifies `~/.reach/runtime/node/bin/node`. This delivery policy supports Gateway/MCP on the same host; explicitly enabled process execution uses this runtime for trusted scripts, with execution disabled by default. Launch JS with `~/.local/share/reach/run-node.sh`; see [Node runtime](node-runtime.md). Supply an official Node archive matching the pinned version/platform/SHA256 to avoid target-host downloads:

```sh
bash install-engine-linux.sh ./engine ./engine.env ./node-v24.21.0-linux-x64.tar.gz
```

The installer validates sources, env syntax, Engine and runtime, stages complete files on each target filesystem, then stops the old service and atomically replaces each file. Success starts/enables the service. Failure restores files, runtime link and previous running/enabled state. Failed rollback reports the retained backup at `~/.reach/backups/linux-<unique-id>`. Existing MCP files remain; `~/.reach/versions.json` records installation. Reinstalling restarts this Engine and interrupts its session.

Fault-injection tests use temporary directories and simulated systemctl. Verify actual systemd, boot, power-loss and SIGKILL recovery on the target host. Forced termination cannot run automatic rollback.

| File | Location |
| --- | --- |
| Engine | `~/.local/share/reach/engine` |
| Start script | `~/.local/share/reach/start-engine.sh` |
| Private config | `~/.config/reach/engine.env`, 600 |
| Default workspace | `~/.reach/workspace` |
| Node runtime | `~/.reach/runtime/node/bin/node` |
| Root unit | `/etc/systemd/system/reach-engine.service` |
| User unit | `~/.config/systemd/user/reach-engine.service` |

## Service inspection and management

Root-installed system service:

```sh
systemctl status reach-engine.service
journalctl -u reach-engine.service -n 30
systemctl restart reach-engine.service
```

User-installed service:

```sh
systemctl --user status reach-engine.service
journalctl --user -u reach-engine.service -n 30
systemctl --user restart reach-engine.service
loginctl show-user "$(id -un)" -p Linger
```

For operation without login, an administrator enables linger, e.g. `loginctl enable-linger <engine-user>`. Verify as that user; the installer never elevates privileges automatically.

Docker Gateway and systemd Engine may share a host. Engine still uses registered Gateway HTTPS URL. MCP entries select devices with `engineId`; restart the MCP child process after adding devices to reload its list. Keep real server inventories/service states out of public documentation.
