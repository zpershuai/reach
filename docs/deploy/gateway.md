# Deploy Gateway to a VPS

English | [简体中文](gateway_cn.md)

Gateway is the public control entry point. Docker Compose keeps it running on the VPS; host Caddy terminates TLS. Examples use container port `8787`, VPS loopback port `28787` and `reach.example.com`.

A local Gateway can share the independent Node runtime installed by Engine at `~/.reach/runtime/node/bin/node`. Complete the npm build below, then run `sh scripts/start-gateway.sh` from the repository root. A Mac/Linux host without Engine can first run `python3 scripts/install-node-runtime.py` (x64/arm64). Docker uses its image's Node; runtimes are not shared across hosts.

## 1. Prepare configuration and build outputs

Complete [Configuration and credentials](configuration.md), including `.reach/gateway.env`. Install Docker, Compose and Caddy, configure DNS and allow ports 80/443 before first deployment.

Compose also requires `deploy/engines.json`. For one device, copy the empty-array `deploy/engines.json.example`; for multiple devices follow [OpenWrt and multiple devices](openwrt.md) and set `REACH_ENGINES_FILE`. Restrict deployment directory access to administrators and allow the container's node user to read the registry. Back up and retain an existing registry during upgrades.

From the local repository root:

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/reach-rpc run build
```

The [Dockerfile](../../deploy/Dockerfile.gateway) copies `packages/reach-rpc/dist` without compiling TypeScript. A source-only package cannot build the image; rebuild after source edits.

Package only allowed files, excluding credentials, development dependencies, Rust outputs and workspaces:

```bash
tar -czf /tmp/reach-gateway-release.tgz \
  deploy/compose.yaml deploy/Dockerfile.gateway \
  deploy/reach-gateway-update.service deploy/reach-gateway-update.path \
  scripts/apply-gateway-release.sh scripts/apply-engine-release.sh scripts/apply-release.py \
  packages/reach-rpc/package.json packages/reach-rpc/package-lock.json \
  packages/reach-rpc/dist
```

This manual package includes optional updater helpers and systemd templates; uploading it does not enable updates. GitHub's `gateway-amd64.tgz` includes helpers but excludes systemd templates: obtain those from the matching source release tag. Explicitly install/enable either method using [updater installation](operations.md).

The image installs production dependencies such as `ws` and `zod`; the VPS Docker build needs the Node base image and npm access. Shared MCP core and HTTP `/mcp` ship in `reach-rpc/dist`; the separate stdio Connector and Rust Engine are excluded.

## 2. Upload to the VPS

Replace reserved host `gateway.example.com`, account `deploy` and directory `/srv/reach`. The account needs directory write access and Docker administration. Preserve the Compose build-context directory layout.

```bash
ssh deploy@gateway.example.com 'mkdir -p /srv/reach; chmod 700 /srv/reach; tar -xzf - -C /srv/reach' \
  < /tmp/reach-gateway-release.tgz
ssh deploy@gateway.example.com 'umask 077; cat > /srv/reach/deploy/gateway.env; chmod 600 /srv/reach/deploy/gateway.env' \
  < .reach/gateway.env
ssh deploy@gateway.example.com 'cat > /srv/reach/deploy/engines.json; chmod 644 /srv/reach/deploy/engines.json' \
  < .reach/engines.json
```

The final two commands overwrite remote configuration. Use generated files only on first deployment; for upgrades, back up and reuse current credentials and registry. Never paste token-bearing configuration into command arguments, chats or release notes.

Expected uploaded layout:

```text
/srv/reach/
├── deploy/
│   ├── compose.yaml
│   ├── Dockerfile.gateway
│   ├── reach-gateway-update.service
│   ├── reach-gateway-update.path
│   ├── gateway.env             # mode 600; excluded from the image
│   └── engines.json           # private registry; mounted read-only in the container
├── scripts/
│   ├── apply-gateway-release.sh
│   ├── apply-engine-release.sh
│   └── apply-release.py
└── packages/reach-rpc/
    ├── package.json
    ├── package-lock.json
    └── dist/
```

## 3. Build and start the container

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose up -d --build gateway'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'curl --fail --silent --show-error http://127.0.0.1:28787/healthz'
```

Health should report `status: "ok"` and `protocol: "reach-rpc/1.0"`. Compose checks every 15 seconds and may initially show `starting`. Inspect failures with:

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 80 gateway'
```

[Compose](../../deploy/compose.yaml) deployment properties:

| Setting | Behavior |
| --- | --- |
| `127.0.0.1:28787:8787` | Accessible only to the VPS-local proxy; does not expose 8787/28787 publicly |
| `restart: unless-stopped` | Starts with Docker; stays stopped after an explicit stop |
| `USER node` | Non-root container process |
| `read_only: true` | Read-only container root filesystem |
| `cap_drop: ALL`, `no-new-privileges` | Removes additional process privileges |
| Health check | Calls container `/healthz`; does not check Engine connectivity |
| `json-file` logging | 10 MB per file, at most three files |

The default project name comes from directory `deploy`, e.g. `deploy-gateway-1`. Keep that directory/project name; another `-p` creates a second installation and may conflict. Gateway has no business-file volume, so container recreation does not delete device files.

## 4. Connect existing Caddy

Add or replace only the Reach site in `/etc/caddy/Caddyfile`, preserving other sites:

```caddyfile
reach.example.com {
    request_body {
        max_size 64KB
    }
    reverse_proxy 127.0.0.1:28787
}
```

Normal `reverse_proxy` handles HTTP and WebSocket upgrades. Preserve paths, add no prefix and keep `/session` on the same domain. Engines verify WSS origin against their configured Gateway origin.

Back up before editing; validate and reload on the VPS:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active caddy
```

For an existing single-domain site on Linux/systemd, a parameterized helper is available. Its account needs configuration write access and Caddy reload permission:

```bash
ssh deploy@gateway.example.com 'python3 - --domain reach.example.com --upstream 127.0.0.1:28787' < scripts/configure-vps-caddy.py
```

The [helper](../../scripts/configure-vps-caddy.py) requires `--domain` and uses `--upstream` for the Gateway address. Override paths/service with `--config` and `--service`. It checks upstream health, generates and validates a candidate, backs up and reloads, restoring the backup on reload failure. It only updates an existing single-domain site; it does not install Docker/Caddy, create DNS or change firewalls.

## 5. Check the public entry point

Run locally:

```bash
curl --fail --silent --show-error https://reach.example.com/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://reach.example.com/session/status
```

The first request must validate the certificate and return the correct protocol. The unauthenticated second request must return `401`. Do not hide certificate/domain errors with `curl -k`.

`/healthz` only confirms Gateway/proxy availability, not Engine connectivity or file RPC. Continue with [Engine deployment](engine.md), then [Deployment verification](verification.md).

## Gateway status and logs

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 100 gateway'
ssh deploy@gateway.example.com 'journalctl -u caddy -n 50 --no-pager'
```

For HTTP diagnostics, add `REACH_HTTP_LOG=1` to remote `gateway.env` and run `docker compose up -d gateway` to recreate the service. Plain `restart` does not reload env. Logs contain paths, status and duration, excluding Authorization and session-token query parameters. If Caddy access logging is enabled separately, check its handling of sensitive data too.

See [Operations](operations.md) for upgrades and rollback.
