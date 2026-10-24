# Deployment verification and acceptance

English | [简体中文](verification_cn.md)

Verification covers source regression, network entry, real file RPC, installed MCP and fault recovery. Ensure no other client owns the target Engine session. File tests create workspace files; recovery additionally interrupts services.

Keep all configuration/reports in ignored `.reach/` or outside the repository. Never publish real hosts, accounts, private addresses, credentials, inventories or acceptance reports.

## Source and entry point

```bash
npm ci --ignore-scripts
npm --prefix packages/reach-rpc ci --ignore-scripts
bash scripts/verify.sh
curl --fail --silent --show-error https://reach.example.com/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://reach.example.com/session/status
```

Replace the example domain. Health must include `reach-rpc/1.0`; unauthenticated status must return `401`. Source tests/health checks do not replace real file RPC.

Run from repository root. Root `npm ci` installs the exact OpenSpec pinned in package.json; `scripts/verify.sh` checks that version rather than accepting any global version.

## Public file RPC

Prepare private `.reach/deployment.json`, optionally using [Configuration](configuration.md). All values below are placeholders:

```json
{
  "gatewayUrl": "https://reach.example.com",
  "engineId": "engine-a",
  "controllerToken": "<controller-token>",
  "engineToken": "<engine-token>"
}
```

If verification can directly read the Engine workspace, set optional `workspaceRoot` to its real absolute path for byte-for-byte disk checks. Omit it for remote devices.

```bash
npm --prefix packages/grok-bot-mcp-connector run build
node scripts/verify-remote.mjs .reach/deployment.json
```

The verifier selects engineId with a 150-second ready budget, covering 120-second idle heartbeat plus connection. It checks HTTPS, unauthenticated denial, credential roles/device identity, WSS ready, denied writes without grants, authorized reads/writes/queries/edits, workspace boundaries, renewal and reopening after close.

Success writes `.reach/remote-verification.json`; test file is `default` workspace `deployment-tests/<UUID>.txt`. Check report timestamp: failures do not invalidate old reports. Recovery depends on this file; clean up the specific file afterward if desired.

## Installed MCP

```bash
node scripts/verify-mcp-remote.mjs "$HOME/.config/reach/mcp.json" .reach/deployment.json
```

Arguments are client config (default `~/.config/reach/mcp.json`) and private deployment config (default `.reach/deployment.json`). The verifier starts `mcpServers.reach` and checks dynamic tools, selection and read/write/edit. Set deployment `deviceId` for an alias; otherwise engineId is used. workspaceRoot is optional local disk verification only.

This verifier requires dynamic mode, though static mode remains supported. Success writes `.reach/mcp-verification.json`. Also select/read/close once in the actual client.

## Remote HTTP MCP

With private deployment configuration prepared:

```bash
node scripts/verify-mcp-http.mjs .reach/deployment.json
```

Checks include missing-token 401, initialization/session ID, empty notification 202, listChanged/SSE invalidation, static underscore tools, registered devices, nonblocking readiness polling, ENGINE_BUSY contention, actual create/read/edit/revision conflicts, and Engine none/old MCP 404 after DELETE. Each HTTP request has a 30-second limit and readiness 150 seconds; writes are never repeated.

If the actual client sends Origin, add `"mcpOrigin": "https://client.example.com"` with the observed value to private JSON. Gateway must list it in REACH_MCP_ALLOWED_ORIGINS; otherwise initialization returns 403 with guidance. Omission sends no Origin and preserves protection. 404 usually means `/mcp` is not deployed: update Gateway.

Tests leave `default` `deployment-tests/<UUID>.txt`; success writes ignored `.reach/mcp-http-verification.json`. Regression additionally covers Origin/version checks, slow bodies interleaved with DELETE/idle expiry, queue cleanup, multi-Engine concurrency, limits, near-64-KiB writes and deadlines. Still connect from the actual host (Grok Bot uses the private generated plugin), confirm private token storage, device discovery, known-file reading and observed Origin using the [Checklist](deployment-checklist.md). Local tests do not prove host compatibility.

## Fault recovery

This verifier targets a local macOS LaunchAgent Engine and SSH-managed Docker Compose Gateway. Run only in a maintenance window permitting interruption of all affected sessions.

Add to private deployment configuration:

```json
{
  "recovery": {
    "gatewaySshTarget": "deploy@gateway.example.com",
    "gatewaySshPort": 22,
    "gatewayComposeDir": "/srv/reach/deploy",
    "launchdLabel": "org.reach.engine"
  }
}
```

Merge these fields with Gateway/Engine settings. SSH target and Compose path must be explicit; SSH port is optional. Use actual installed service label, default `org.reach.engine`, optionally set with REACH_LAUNCHD_LABEL.

```bash
node scripts/verify-recovery.mjs .reach/deployment.json .reach/remote-verification.json
```

The script restarts configured Gateway, reopens/reads the existing test file, terminates local Engine, verifies launchd gives it a new PID, rereads and closes. Success writes `.reach/recovery-verification.json`.

This proves process recovery/file persistence, not restoration of Gateway memory sessions/grants/deduplication or replay of unfinished writes.

## Checks and record keeping

See [Checklist](deployment-checklist.md). Keep source/component versions, artifact digests and backup locations privately. Public release records describe reusable features/test coverage without real environment details.
