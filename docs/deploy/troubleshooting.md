# Deployment troubleshooting

English | [简体中文](troubleshooting_cn.md)

Check public entry → Gateway → Engine → session → MCP tools. Preserve error codes, times, session state and stderr without tokens or full session-token WSS URLs.

## Quick diagnosis

| Symptom | Common cause | Action |
| --- | --- | --- |
| DNS/certificate failure | Wrong DNS/AAAA host, blocked 443, Caddy certificate issue | Check DNS/proxy/certificate logs; never disable TLS validation |
| Public and loopback 502 | Stopped container, wrong mapping, startup config | Inspect Compose/logs and 127.0.0.1:28787/healthz |
| Loopback works; public 502/404/wrong protocol | Caddy targets old service/port/path | Correct only Reach site to 28787; validate/reload |
| Immediate Gateway startup failure | Missing auth, short/equal tokens, invalid integers | Check private env constraints without printing credentials |
| Control API 401 | Missing/wrong-role/old/unsynchronized token | Check scoped delegated/OAuth expiry/revocation/policy; Owner is trusted administration only |
| Heartbeat 401 | Engine token mismatch | Synchronize/reload both private configs |
| Heartbeat 403 | Engine ID mismatch | Match REACH_ENGINE_ID on both ends |
| Healthy but device never ready | Sleeping/offline Mac, stopped Engine, heartbeat delay, auth | Inspect LaunchAgent/stdout/stderr and 15/120-second interval |
| Session 409 | Another Controller, stale ID, not ready, duplicate request ID | Read specific response/ownership; never blindly close another session |
| Session/RPC 503 | Full queue, disconnect, delivery/execution timeout | Correlate Gateway/Engine logs and open a new session |
| HTTP 413 | Body exceeds 64 KiB | Reduce body, not just Caddy limit |
| No file tools after selection | Ignored tool-list notification | Refresh or use static mode/restart Connector |
| MCP JSON parse failure | Build/wrapper output on stdout | Run compiled entry directly with Node; logs to stderr |
| File PERMISSION_DENIED | Bad grant, escape, symlink, OS permissions | Check roots/paths and Connector automatic write grants |
| Uncertain timed-out write | Lost response or timeout at commit | Reconnect and read content/revision before a new write |

409/503 are broad status categories; the response body determines the cause. Not every 409 means another owner.

## Network and Caddy

Check public access locally and loopback on VPS:

```bash
curl --fail --silent --show-error https://reach.example.com/healthz
ssh deploy@gateway.example.com 'curl --fail --silent --show-error http://127.0.0.1:28787/healthz'
ssh deploy@gateway.example.com 'journalctl -u caddy -n 80 --no-pager'
ssh deploy@gateway.example.com 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
```

Stdio Connector is local; its device URL must be Gateway's HTTPS root, e.g. https://reach.example.com.

Engine base URL cannot be /session, a business prefix or redirect. Engine/Connector never follow authenticated redirects; WSS endpoint must match configured origin. Additional CDN/proxies must support WSS, paths and connection timeouts; a working homepage proves little.

## Gateway and authentication

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 100 gateway'
```

Container listens on 0.0.0.0:8787; host checks 127.0.0.1:28787. Inspect conflicts and actual Compose mapping when deploying other services.

After env edits restart alone is insufficient; use up -d gateway. Never paste full environment dumps into chats. [verify-remote.mjs](verification.md) reports checks without credentials.

## Engine background startup

```bash
launchctl print "gui/$(id -u)/org.reach.engine"
tail -n 80 "$HOME/.local/share/reach/engine.log"
tail -n 80 "$HOME/.local/share/reach/engine-error.log"
```

If no service entry exists, inspect plist, logged-in user and installer account. Repeated exits need engine.env syntax, URL, token alphabet, timeouts and workspace permissions checked. Quote spaces correctly.

Providing Gateway URL in env and arguments fails startup. Remote HTTP is rejected: use valid HTTPS. Network backoff means retries continue; repeated reinstall is unnecessary.

## Sessions and heartbeats

Idle Engine only heartbeats. Controller open takes effect on the next heartbeat, then WSS connects. Default 120-second heartbeat can be lowered; selection need not be instantly ready.

Session tokens expire after 30 seconds and work once. Do not copy/reuse them or treat old sockets as resumable. After restart/expiry/rotation open a new session; old grants may be invalid.

Before multi-client tests let the previous client close/exit. Do not restart production just to investigate 409. RPC queues are bounded and file execution serial; reduce concurrency/check durations for overload/timeouts.

## MCP startup and tools

Use real absolute paths; GUI apps may lack interactive PATH. After Node upgrades, update command paths or regenerate configuration.

REACH_MCP_DEVICES and REACH_MCP_DEVICES_FILE are mutually exclusive. Devices JSON is an array with unique IDs and tokens at least 32 characters. Silent stdout may simply mean waiting for MCP input.

Dynamic file tools appear after successful pick_device; static calls need deviceId. Restart after mode/device/env changes.

Installed verification requires dynamic mode, mcpServers.reach and configured alias; local file comparison additionally needs a readable workspace path. Fix verification prerequisites first; see [Verification](verification.md).

## File results

Paths are workspace-relative; fs.edit uses oldString/newString. fs.read returns lines without the trailing newline; byte-level proof requires the actual file or disk verifier. Interpret grep/glob relative paths against the requested search root.

There is no delete RPC; tests retain files. Check device/workspace/path before changing roots. After a committed write loses its response, inspect fs.stat/fs.read revision/content. New request IDs do not provide durable exactly-once replay guarantees.

## Disconnects, timeouts and recovery

Reach never automatically replays state-changing operations. Real-Engine recovery.test.ts covers:

| Condition | Behavior | Recovery |
| --- | --- | --- |
| Engine token rotated/revoked | HEARTBEAT_FAILED/backoff; offline, no session | Update private token/restart, never publish it |
| Lost process_run response | Task may have started | Same-session process_status with original launchId. Identical launchId/args returns original; changed args LAUNCH_ID_CONFLICT. Resend only after PROCESS_NOT_FOUND |
| Timeout/process_stop | timed_out/stopped; ordinary same-group descendants terminate | Inspect process_logs; new launchId for another execution |
| Close/lease expiry/disconnect | Owned tasks/descendants stop; new session cannot query them | Reopen, verify files/revision before rerunning |
| Gateway restart | Sessions/grants lost; Engine heartbeats resume; no replay | Reopen/regrant; old grants yield PERMISSION_DENIED |
| Write timeout | May have crossed atomic commit | fs_stat/fs_read revision, then ifMatch |
| closureReason unsupported_protocol | Incompatible wire version, immediate close, no forwarding | Follow [compatibility matrix](versions.md); Gateway first |

OS-killed Engine and descendants deliberately leaving process groups are outside cleanup guarantees. Inspect leftovers under the Engine account.

## Private settings and diagnostic boundaries

Generated setup tokens never appear in logs. Read REACH_DATA_DIR/admin-setup-token privately using [Console setup](console.md). Never publish env dumps, databases, cookies, full WSS URLs, file contents, script arguments or process output. Public issues need component versions, operation names, stable codes, redacted times and synthetic reproduction. Use [SECURITY](../../SECURITY.md) privately for vulnerabilities.

| Stable diagnostic | Investigation |
| --- | --- |
| GATEWAY_CONFIGURATION_INVALID / CONFIGURATION_INVALID | Names the invalid setting (e.g. GATEWAY_PORT, REACH_ENGINES_FILE, REACH_DATA_DIR), never its value; inspect privately |
| GATEWAY_STARTUP_FAILED | Non-configuration startup reports error type; inspect env/registry/storage privately |
| HEARTBEAT_FAILED / SESSION_CONNECT_FAILED | Check reachability, trusted certificate chain/hostname; never disable TLS or follow auth redirects |
| SESSION_PROTOCOL_UNSUPPORTED | Check both component versions and upgrade by matrix |
| SESSION_PROTOCOL_INVALID / SESSION_READ_FAILED | Check versions/connection/protocol, reopen without replaying uncertain writes |
| PROCESS_CLEANUP_FAILED / SESSION_CLEANUP_FAILED | Retain ownership/retry; check service account stop rights, never seize foreign tasks |
| NODE_RUNTIME_INSTALL_FAILED / ENGINE_INSTALL_FAILED | Privately check directories/trusted assets/integrity and backup recovery; never publish raw errors/env |
| PERMISSION_DENIED / hidden-device 404 | Owner checks Engine/workspace/operation policy in Clients; labels do not authorize |

HTTP diagnostics log known routes/method/status/duration without queries/dynamic IDs. Engine logs bounded events/stable codes, not upstream bodies. Connector stdout remains JSON-RPC only. Admin audit contains selected metadata/server principal; display labels remain unverified. Diagnostic minimization never changes authorized file/process.logs contents; deliver them only to authorized callers.

Gateway is a trusted relay that sees forwarded RPC content even when audit does not store it. Node runs trusted scripts with system-account permissions; workspace paths do not sandbox scripts.
