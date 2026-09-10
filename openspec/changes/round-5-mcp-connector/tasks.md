## 1. MCP package foundation

- [x] 1.1 Create the standalone TypeScript Grok Bot MCP connector package, executable stdio entrypoint, and configured device loading with a loopback default; verify its build command succeeds.
- [x] 1.2 Implement newline-delimited JSON-RPC handling for MCP initialization, initialized notification, and structured tool responses without a native Grok registration API; verify protocol unit tests pass.

## 2. Device-gated MCP tool discovery

- [x] 2.1 Implement `list_devices` and `pick_device`, including Gateway session open and bounded ready polling; verify unknown and unready devices leave the connector unselected.
- [x] 2.2 Implement dynamic `tools/list` and `notifications/tools/list_changed` so selected-device filesystem and close tools appear only after a ready pick; verify a client refresh observes the expanded list.

## 3. Gateway tool bridge

- [x] 3.1 Implement selected-device `fs.read`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, and `session.close` through Gateway RPC, lifecycle, and conservative renewal calls; verify mock-Gateway request mapping tests pass.
- [ ] 3.2 Implement `fs.write` and `fs.edit` with Gateway-issued grants and forwarded permission identifiers; verify mutation tests reject fabricated grants and accept issued ones.
- [ ] 3.3 Ship the `REACH_MCP_TOOL_MODE=static` Path 1 surface with required `deviceId` parameters and document its use when a host ignores list-change notifications; verify static tool schemas and README guidance.

## 4. End-to-end verification

- [ ] 4.1 Add an automated stdio client proof that receives `notifications/tools/list_changed`, re-fetches `tools/list`, and sees the expanded selected-device set; verify it runs in the connector package test command.
- [ ] 4.2 Run `cargo test -p reach-rpc`, `npm --prefix packages/reach-rpc test`, and the connector build/test commands with `/home/box/.cargo/bin` on PATH; verify all commands are green.
