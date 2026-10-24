# OpenWrt Engine and multiple-device Gateway

English | [简体中文](openwrt_cn.md)

One Gateway manages multiple Engines. Each has its own token, session, lease, RPC deduplication records and write grants. The Controller token controls all registered Engines. Each Engine retains one interactive session at a time.

## Register devices with Gateway

Preserve existing `REACH_ENGINE_ID`, `REACH_ENGINE_TOKEN` and `REACH_CONTROLLER_TOKEN` for the default Engine. Old clients without a device still route there. Generate independent tokens for additional devices and list them in VPS `/srv/reach/deploy/engines.json`, excluding the default:

```json
[{"engineId":"engine-b","engineToken":"replace-with-an-independent-random-credential-of-at-least-32-characters"}]
```

Add `REACH_ENGINES_FILE=/run/reach/engines.json` to `gateway.env`. Compose mounts it read-only. The container's node user must read it; restrict its parent directory to administrators. Without additional Engines, copy `deploy/engines.json.example`, containing `[]`.

Restart Gateway to apply registration. Controller requests use `?engineId=engine-b` across session control, status, grant and RPC endpoints. Heartbeats route by each credential, and Gateway returns device-specific WSS endpoints with independently verified single-use tokens. Unknown devices never fall back to default.

## Prepare an x86_64 OpenWrt package

The Node bundle is part of standard installation delivery for same-host Gateway/MCP. Rust Engine uses it for trusted workspace scripts only when process execution is explicitly enabled; on Engine-only routers it may remain unused. See [Node runtime boundaries](node-runtime.md).

Build static Engine on Linux:

```sh
rustup target add x86_64-unknown-linux-musl
CC_x86_64_unknown_linux_musl=musl-gcc cargo build --release --locked -p reach-rpc --bin engine --target x86_64-unknown-linux-musl
```

The build host needs musl-tools, Docker, Python 3 and Node Alpine/Rust images. Obtain the official linux-x64-musl Node archive matching `scripts/node-runtime.json` version/SHA256, then run:

```sh
sh scripts/build-node-openwrt.sh /path/to/node-v24.21.0-linux-x64-musl.tar.gz /path/to/node-bundle reach-gateway:current
```

Old OpenWrt C++ libraries cannot run this Node directly. The builder bundles private musl, libstdc++ and libgcc and patches Node's loader/library paths without upgrading system libraries. Publish the bundle and same-directory `node-runtime.json` together; the installer verifies digests.

Prepare router `engine.env`, mode 600:

```sh
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_ID=engine-b
REACH_ENGINE_TOKEN=replace-with-this-devices-independent-credential
REACH_WORKSPACE_ROOTS=default:/root/.reach/workspace
```

Upload static Engine, config, `scripts/install-engine-openwrt.sh`, `scripts/run-node.sh`, bundle and manifest into one router temporary directory. Run as root:

```sh
sh install-engine-openwrt.sh ./engine ./engine.env ./node-v24.21.0-openwrt-x64.tar.gz
```

Every installation verifies/installs Node and POSIX launcher `/root/.reach/run-node.sh`. Stable runtime entry is `/root/.reach/runtime/node/bin/node`; Engine is `/root/.reach/engine`. The installer backs up old files, configures procd and enables boot. Read logs with `logread -e reach`. Workspace: `/root/.reach/workspace`; config: `/etc/reach/engine.env`; record: `/root/.reach/versions.json`. This installer supports x86_64, musl and root's home only, not other architectures.

## Select devices in MCP

Upgrade MCP to an `engineId`-aware version and add two entries for the same Gateway:

```json
[
  {"id":"engine-a","engineId":"engine-a","gatewayUrl":"https://reach.example.com","controllerToken":"shared-controller-credential"},
  {"id":"engine-b","engineId":"engine-b","gatewayUrl":"https://reach.example.com","controllerToken":"shared-controller-credential"}
]
```

`id` is the MCP display name; `engineId` is the registered Gateway identity. Omitting `engineId` preserves default-device routing. Call `list_devices`, then `list_workspaces({deviceId})` to connect/discover real workspace names, or connect first with `pick_device`. `get_versions` reports the selected Engine and shared Gateway versions.

## OpenWrt installer recovery verification scope

The installer validates/stages privately before stopping the old service, atomically replacing files and starting. Failure restores files, runtime pointer and supervisor state. First-install failure removes new targets but preserves workspaces. Failed recovery retains private backups for manual repair and cannot count as a successful upgrade. Isolated supervisor fixtures cover staging, activation, start/health, old-config preservation and first-failure cleanup; they do not certify real LaunchAgent/procd devices. See [Operations](operations.md) for target-platform acceptance/recovery.
