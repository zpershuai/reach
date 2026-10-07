## Why

Engine installations already provision a private Node runtime, but MCP clients can only manipulate files. Managed execution of trusted workspace scripts will let clients run those files, observe results, and stop work using the target device's runtime.

## What Changes

- Add asynchronous `process.run`, `process.status`, `process.logs`, `process.stop`, and `process.list` RPC tools and corresponding MCP surfaces.
- Execute trusted Node scripts from explicitly enabled workspaces using an Engine-configured private runtime; callers cannot choose executables or Node flags.
- Add session-owned process management, bounded output and concurrency, launch deduplication, timeouts, and process-tree cleanup.
- Add execution and process-control authorization distinct from filesystem write grants, with Engine-local policy that Gateway claims cannot relax.
- Share process descriptions across stdio and HTTP MCP, including ownership, timeout recovery, and trusted-code semantics.
- Upgrade Engine from 0.1.0 to 0.2.0, Gateway and MCP from 0.2.0 to 0.3.0, including lockfiles, generated version verification, and installation documentation. Keep wire protocol and bundled Node versions unchanged.

## Capabilities

### New Capabilities
- `workspace-node-processes`: Trusted workspace script launch, task observation, bounded logs, idempotent stop, and launch identity.

### Modified Capabilities
- `engine-runtime`: Own and drain session processes; enforce local execution policy and keep lifecycle bounds effective during background work.
- `engine-tool-dispatch`: Introduce execute/control access and authorized process invocation contexts without blocking serial dispatch.
- `gateway-write-grants`: Add separately scoped process grants while preserving existing filesystem grant behavior.
- `grok-bot-mcp-connector`: Expose process tools in existing transport/device modes and share accurate descriptions and recovery semantics.

## Impact

Rust Engine configuration, registry, invocation context, session lifecycle, and a new ProcessManager; TypeScript RPC schemas, Gateway grants, in-process adapter and MCP dispatch; component manifests and lockfiles; installation/version/runtime documentation and integration verification. Existing installations remain execution-disabled until explicitly configured. Scripts execute with the Engine account's OS privileges: workspace entry validation is not a script sandbox. No deployment, service modification, arbitrary shell interface, package installation, persistent daemon management, or protocol-version upgrade is included.
