# Reach RPC test workspace

Model B: the TypeScript Gateway is the control plane (`/heartbeat`, `/session-wanted`, `/grants`, `/session`, `/session/rpc`). The Rust Engine owns workspace filesystem execution.

`WorkspaceFilesystem` in this package remains a TypeScript reference used by unit tests. Session traffic no longer dispatches through it; configure Engine roots with `REACH_WORKSPACE_ROOTS` or the Engine default `~/.reach/workspace`.

Filesystem writes and edits require a gateway-issued scoped grant via `POST /grants`. Controllers present `permission.grantId` on `POST /session/rpc`; the Gateway validates the grant before forwarding the mutation to the Engine.

Trusted Node script tasks are available through `process.run/status/logs/stop/list` when Engine-local workspace execution is enabled. They use the target Engine private runtime and session-owned lifetime, with separately scoped execution/control grants. See [process configuration and behavior](../../docs/deploy/processes.md).
