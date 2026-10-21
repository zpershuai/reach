# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue or pull request. If that option is not shown, open a public issue that only asks the maintainer for a private contact, without any technical detail.

Include the affected component (Gateway, Engine or MCP Connector), its version from `--version` or `get_versions`, the platform, and steps to reproduce with placeholder hosts and synthetic files. Do not send real credentials; if a report needs one, describe where it appears instead.

You should receive an acknowledgement within 7 days. Fixes ship in a new component Release, and the Release notes credit the reporter unless they ask not to be named.

## Supported versions

| Component | Supported |
| --- | --- |
| Gateway | Latest `gateway-v*` Release |
| Engine | Latest `engine-v*` Release, running against a supported Gateway |
| MCP Connector | Latest version in this repository |

Older versions do not receive fixes. Components are versioned independently; check the [compatibility matrix](docs/deploy/versions.md#兼容矩阵与升级顺序) before upgrading, Gateway first.

## Threat model

### Trust boundaries

```text
MCP client ──(delegated token / scoped OAuth / Owner token)──> Gateway ──(one-time session token, WSS)──> Engine ──> workspace roots
                                              ^
Engine ──(Engine token, outbound HTTPS heartbeat)┘
```

- **Gateway operator: trusted.** Anyone who controls the Gateway host or its environment can act on every registered Engine. TLS protects transport, but the Gateway relays and can observe RPC bodies, file content and process-output responses. Reach does not provide end-to-end encryption that hides content from the Gateway.
- **Network: untrusted.** Remote Engines require verified HTTPS/WSS. Plaintext HTTP is accepted only for loopback origins, and their resolved addresses must also be loopback. Each Engine accepts exactly one configured Gateway origin and refuses a lease endpoint that points elsewhere.
- **MCP clients: trusted with the authority you give them.** Reach bounds and records what a client does, but it cannot tell a well-behaved agent from a misbehaving one that holds a valid credential.
- **Device: trusted.** The Engine runs as the account that installed it. Workspace roots limit what the Engine serves; they are not an OS sandbox.

### Credentials

| Credential | Held by | Grants |
| --- | --- | --- |
| Owner Controller token (`REACH_CONTROLLER_TOKEN`) | Trusted owner tools | Every control and MCP operation, on **every** registered Engine and workspace |
| Delegated token (`reach_ct_…`) | A specific client | Explicit Engine/workspace/read/write/execute policy, with a required expiry; rotation and revocation invalidate owned authority |
| OAuth access token | Approved MCP apps (for example, ChatGPT connectors) | Current explicitly approved resource permissions; valid for 1 hour, rotating refresh tokens last 30 days; existing legacy-global apps retain Owner-equivalent authority until restricted |
| Engine token (`REACH_ENGINE_TOKEN`, one per Engine) | One Engine | Heartbeats and session leases for that Engine only; must differ from the Controller token |
| Session token | Issued in a heartbeat lease | Single use, expires after 30 seconds, binds one WebSocket session |
| Grant | Issued by the Gateway per mutation | Principal, Engine, policy revision and operation scope, for 5 minutes; execute/control grants have separate scopes |
| Console admin session | Gateway owner | Console administration; mutations need CSRF protection, and sensitive actions need a recent re-authentication |

Tokens are at least 32 characters and are compared in constant time. Delegated/OAuth tokens and console sessions are stored only as SHA-256 digests. See [client access](docs/deploy/client-access.md) for policy fields, migration and revocation.

### What Reach defends against

- Reaching a device without an inbound port: Engines only connect outbound.
- Write or execute calls without a matching grant: the Gateway validates grants before forwarding, and the Engine `Authorizer` rejects write-class tools without a grant claim. Execute and process-control tools need their own grant kinds.
- Escaping a workspace through symbolic links, special files, or oversized and deep directories: access never follows symbolic links, uses descriptor-relative operations, and enforces size and depth limits. Platforms without these primitives fail closed.
- Long-lived or abandoned sessions: leases, idle timeouts, connection rotation and per-call deadlines close them, and the Engine enforces these limits even if the Gateway does not.
- Resource exhaustion through oversized requests or responses: request bodies, messages, responses, queues and cursors all have hard limits.
- Cross-origin browser requests to `/mcp`: requests that carry an `Origin` header are refused unless that origin is allowlisted in `REACH_MCP_ALLOWED_ORIGINS`.

### Known limitations

- **Owner and legacy-global clients remain fully trusted.** Scope new delegated and OAuth identities explicitly. Review every migrated legacy-global app before publication acceptance. Grants are least-privilege plumbing, not human approval, and MCP automatically requests them within the authenticated policy.
- **One administrator, several client identities.** Delegated credentials provide API isolation, not separate human accounts or an operating system sandbox.
- **One interactive session per Engine.** A second client gets `ENGINE_BUSY` until the first one closes or its lease expires.
- **In-memory state.** Sessions, grants and request-deduplication windows live in memory. A Gateway restart drops them, and there is no durable exactly-once execution.
- **Writes may commit after a timeout.** A timeout, cancellation or credential revocation is not proof of rollback after a write reached its atomic commit boundary; check the file revision before retrying.
- **Script execution runs trusted code.** `process.*` runs Node scripts inside allowlisted workspaces with the Engine account's privileges. Enable it only for workspaces whose content you trust. Scripts can access whatever the Engine account can access; API workspace policy does not confine arbitrary script code. Writers of executable scripts can change what a trusted executor later runs.
- **The audit records selected metadata only.** It records authenticated principal, unverified display label, method, resource paths, result codes and timing, not file bodies, script arguments or process output. Paths and identity metadata can still be private; protect the data directory and exports. Normal service diagnostics use approved routes and stable codes rather than raw upstream errors.

## Hardening checklist

- Read an automatically generated setup credential privately from `REACH_DATA_DIR/admin-setup-token` (0600); it is removed after administrator creation. Never put it in service logs or public reports.
- Keep tokens in private env files with `0600` permissions and rotate them as described in [operations](docs/deploy/operations.md).
- Point each Engine at a dedicated workspace directory, not your home directory.
- Leave `REACH_PROCESS_WORKSPACES` empty unless you need script execution.
- Configure `REACH_TRUSTED_PROXIES` and `REACH_MCP_ALLOWED_ORIGINS` as narrowly as possible.
- Enable the console (`REACH_DATA_DIR`) so you can review activity and revoke OAuth apps.

## Roadmap

- Optional human approval for mutations
