# Node runtime installation and execution boundaries

English | [简体中文](node-runtime_cn.md)

Rust Engine handles sessions/file RPC directly. When process execution is enabled, it uses a local private Node runtime for trusted workspace scripts. File operations do not need Node. Engine selects the interpreter with `REACH_PROCESS_NODE_BIN`, ignoring launcher `REACH_NODE_BIN` and never falling back to system PATH. See [Script tasks](processes.md).

Engine packages must still deliver a pinned, verified private Node runtime. This standard installation policy lets same-host Gateway/MCP later use `~/.reach/runtime/node/bin/node` without system Node. It may remain unused on Engine-only hosts; remote Gateway/MCP use their own host runtimes.

## Actual launch entry points

Gateway and MCP are Node programs. Start them with private Node directly or the installed POSIX-compatible `run-node.sh`, including on OpenWrt without Bash:

```sh
"$HOME/.reach/runtime/node/bin/node" /absolute/path/to/gateway/dist/gateway-main.js
"$HOME/.reach/runtime/node/bin/node" /absolute/path/to/mcp/dist/main.js
```

The installed launcher is `~/.local/share/reach/run-node.sh` on macOS/Linux or `/root/.reach/run-node.sh` on OpenWrt. For example, run copied JS outputs on OpenWrt:

```sh
sh /root/.reach/run-node.sh /absolute/path/to/gateway/dist/gateway-main.js
sh /root/.reach/run-node.sh /absolute/path/to/mcp/dist/main.js
```

`REACH_NODE_BIN` overrides only the launcher's executable path; Rust Engine and already-running JS processes do not read it. MCP clients choose Node with `command`; process env cannot change an interpreter already running. Repository `sh scripts/start-gateway.sh` uses the same launcher.

## Why OpenWrt requires a bundle

The installer maintains standard runtime delivery and requires a prepared Node bundle. It carries private musl/C++ libraries and a loader matching the target path, avoiding system-library dependencies and target-time downloads. Installation verifies digests, installs runtime/launcher and queries the actual Node version. Missing/corrupt bundles abort as a delivery-integrity check. File RPC remains independent of Node; enabled process execution requires it.

The installer does not start Gateway/MCP. They use this runtime continuously only if explicitly deployed on that host. See [OpenWrt](openwrt.md), [Linux](linux.md), [macOS](engine.md) and [MCP](mcp.md) for build/install procedures.
