# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue. Include the affected component (Gateway, Engine or MCP Connector), its version from `--version` or `get_versions`, and the steps to reproduce.

You should receive an acknowledgement within 7 days. Fixes ship in a new component Release, and the Release notes credit the reporter unless they ask not to be named.

## Supported versions

Only the latest Release of each component (`gateway-v*`, `engine-v*`) receives security fixes. Gateway, Engine and MCP Connector are versioned independently; see [versions](docs/deploy/versions.md).

## Threat model

### Trust boundaries

```text
MCP client ──(Controller token / OAuth)──> Gateway ──(one-time session token, WSS)──> Engine ──> workspace roots
                                              ^
Engine ──(Engine token, outbound HTTPS heartbeat)┘
```

- **Gateway operator: trusted.** Anyone who controls the Gateway host or its environment can act on every registered Engine.
- **Network: untrusted.** Remote Engines require verified HTTPS/WSS. Plaintext HTTP is accepted only for loopback origins, and their resolved addresses must also be loopback. Each Engine accepts exactly one configured Gateway origin and refuses a lease endpoint that points elsewhere.
- **MCP clients: trusted with the authority you give them.** Reach bounds and records what a client does, but it cannot tell a well-behaved agent from a misbehaving one that holds a valid credential.
- **Device: trusted.** The Engine runs as the account that installed it. Workspace roots limit what the Engine serves; they are not an OS sandbox.

### Credentials

| Credential | Held by | Grants |
| --- | --- | --- |
| Controller token (`REACH_CONTROLLER_TOKEN`) | MCP clients, controllers | Every control and MCP operation, on **every** registered Engine and workspace |
| OAuth access token | Approved MCP apps (for example, ChatGPT connectors) | The same authority as the Controller token; valid for 1 hour, refresh tokens rotate and last 30 days, and the console can revoke an app |
| Engine token (`REACH_ENGINE_TOKEN`, one per Engine) | One Engine | Heartbeats and session leases for that Engine only; must differ from the Controller token |
| Session token | Issued in a heartbeat lease | Single use, expires after 30 seconds, binds one WebSocket session |
| Grant | Issued by the Gateway per mutation | One workspace, one path and specific methods, for 5 minutes |
| Console admin session | Gateway owner | Console administration; mutations need CSRF protection, and sensitive actions need a recent re-authentication |

Tokens are at least 32 characters and are compared in constant time. OAuth tokens and console sessions are stored only as SHA-256 digests.

### What Reach defends against

- Reaching a device without an inbound port: Engines only connect outbound.
- Write or execute calls without a matching grant: the Gateway validates grants before forwarding, and the Engine `Authorizer` rejects write-class tools without a grant claim. Execute and process-control tools need their own grant kinds.
- Escaping a workspace through symbolic links, special files, or oversized and deep directories: access never follows symbolic links, uses descriptor-relative operations, and enforces size and depth limits. Platforms without these primitives fail closed.
- Long-lived or abandoned sessions: leases, idle timeouts, connection rotation and per-call deadlines close them, and the Engine enforces these limits even if the Gateway does not.
- Resource exhaustion through oversized requests or responses: request bodies, messages, responses, queues and cursors all have hard limits.
- Cross-origin browser requests to `/mcp`: requests that carry an `Origin` header are refused unless that origin is allowlisted in `REACH_MCP_ALLOWED_ORIGINS`.

### Known limitations

- **No per-device or per-workspace scoping for clients.** A Controller token or an approved OAuth app can read and write every workspace on every Engine. Grants limit each call, but a holder of the Controller token can obtain grants for any path, and the MCP layer does so automatically. Grants are least-privilege plumbing, not human approval.
- **No read-only credential.** Any client credential can also write.
- **One interactive session per Engine.** A second client gets `ENGINE_BUSY` until the first one closes or its lease expires.
- **In-memory state.** Sessions, grants and request-deduplication windows live in memory. A Gateway restart drops them, and there is no durable exactly-once execution.
- **Writes may commit after a timeout.** A timeout is not proof of rollback; check the file revision before retrying.
- **Script execution runs trusted code.** `process.*` runs Node scripts inside allowlisted workspaces with the Engine account's privileges. Enable it only for workspaces whose content you trust.
- **The audit records metadata only.** It records who called what and when, not file contents.

## Hardening checklist

- Keep tokens in private env files with `0600` permissions and rotate them as described in [operations](docs/deploy/operations.md).
- Point each Engine at a dedicated workspace directory, not your home directory.
- Leave `REACH_PROCESS_WORKSPACES` empty unless you need script execution.
- Configure `REACH_TRUSTED_PROXIES` and `REACH_MCP_ALLOWED_ORIGINS` as narrowly as possible.
- Enable the console (`REACH_DATA_DIR`) so you can review activity and revoke OAuth apps.

## Roadmap

- Client credentials scoped to specific Engines and workspaces
- Read-only client credentials
- Optional human approval for mutations
