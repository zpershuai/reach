# Gateway console

English | [简体中文](console_cn.md)

The console shares Gateway's listener at `/console/`; its API is `/api/console/`. One owner account signs in with password and TOTP. Controller/Engine tokens grant no console access, and console cookies grant no RPC access. Client labels are self-reported, unverified audit metadata.

## Enable and perform initial setup

For existing deployments, first back up private configuration and reuse the Controller token, Engine token and Engine ID. Do not replace active credentials with examples.

Prepare a data directory outside the source checkout, e.g. in `/srv/reach`:

```sh
cd /srv/reach
sudo install -d -m 700 -o 1000 -g 1000 data
```

Compose mounts `./data:/var/lib/reach:rw` and sets `REACH_DATA_DIR=/var/lib/reach`. Keep `read_only: true`, `cap_drop: [ALL]` and `no-new-privileges`. Add the external origin, without path/trailing slash, to private `gateway.env`:

```dotenv
REACH_PUBLIC_ORIGIN=https://gateway.example.com
REACH_AUDIT_RETENTION_DAYS=30
```

For direct execution, configure a writable `REACH_DATA_DIR`. Omitting it disables the console while preserving data-plane interfaces. Non-loopback console listeners require `REACH_PUBLIC_ORIGIN`. Unwritable directories or invalid retention days fail before listening.

Release packaging builds frontend assets into the Gateway image. See the [development README](../../packages/gateway-console/README.md). After deployment:

```sh
docker compose up -d gateway
docker compose logs gateway
```

When there is no administrator and no explicit `REACH_ADMIN_SETUP_TOKEN`, Gateway writes a random setup token to `REACH_DATA_DIR/admin-setup-token`. It must be a regular `0600` file owned by the current user. The data directory cannot be a symlink or world-writable without sticky bit; group-writable volumes such as Kubernetes `fsGroup` are supported. Restarts reuse the file. Symlinks, unsafe modes and corrupt files prevent startup without being overwritten. With an existing administrator, a leftover setup file is unusable; if safe deletion fails Gateway starts and logs `CONSOLE_SETUP_TOKEN_NOT_REMOVED` so you can delete it manually.

Logs explain how to read it privately but never print it. Read it in your private terminal, for example with `docker compose exec -T gateway sh -c 'cat "$REACH_DATA_DIR/admin-setup-token"'`, or from the configured data directory for a direct process. Never redirect it into service logs, public issues or the repository. Alternatively set `REACH_ADMIN_SETUP_TOKEN` in private env.

Open `https://gateway.example.com/console/`, enter the token, scan the authenticator QR, choose a password of at least 12 characters and confirm TOTP. Save the ten one-time recovery codes. Creating the administrator invalidates the setup token and deletes the generated file. Existing administrators do not get a new token. Older log-only temporary tokens no longer work: use the private file or explicit env for initial setup.

Session cookies are HttpOnly, SameSite=Strict, Path=/ and Secure on HTTPS. Sessions expire after 12 idle hours or seven days total; sign-out revokes immediately. Adding/removing devices, rotating tokens, disconnecting clients and changing retention require password confirmation within ten minutes. A new browser requires password plus fresh TOTP; a recovery code replaces TOTP once.

## Language

Use the `EN / 中` controls on setup/sign-in or in navigation, including the narrow-screen menu, or choose Language in Settings. English and Simplified Chinese apply immediately without reload, preserve form input and require no authentication. Browser-local `reach.console.lang` stores the choice; without it, the first supported `navigator.languages` entry selects Chinese for `zh*` or English for `en*`, falling back to English. Blocked storage still allows switching for the current page. Language changes make no settings API request. The document language/title, formatting and known API errors follow the active language.

The non-sensitive `reach_lang` cookie contains only `en` or `zh-CN`. OAuth approval pages use this supported cookie first, then weighted `Accept-Language`, then English. Invalid cookie values are ignored. Language never affects authentication, CSRF or permissions.

## Reverse proxy and rate limits

Reuse existing Caddy for TLS and keep host Gateway ports on loopback. Do not start a competing proxy on 80/443. Forward `/api/console/events` without extra buffering. Gateway sends `X-Accel-Buffering: no`; Caddy streams by default.

`REACH_TRUSTED_PROXIES` is a comma-separated IP/CIDR list. Only trusted socket peers enable `X-Forwarded-For` parsing, walking from right to left past trusted proxies. Use the smallest observed proxy range, not all addresses. Example:

```dotenv
REACH_TRUSTED_PROXIES=192.0.2.10,2001:db8::10/128
```

With host Caddy forwarding through Docker, the peer may be the bridge gateway. Inspect local networking and put only that proxy address in private env. Without configuration, the socket address is used; forwarding headers cannot spoof rate-limit identity, but requests may share one limit and Overview warns. Login, setup and reauthentication have per-address and global backoff.

Optional Caddy IP allow-list; replace documentation addresses with your authorized ranges and keep real topology private:

```caddyfile
gateway.example.com {
    @console path /console /console/* /api/console/*
    handle @console {
        @owner remote_ip 192.0.2.0/24 2001:db8::/32
        handle @owner {
            reverse_proxy 127.0.0.1:28787
        }
        respond "Forbidden" 403
    }
    handle {
        reverse_proxy 127.0.0.1:28787
    }
}
```

Every mutation requires matching configured Origin and a session CSRF header. Custom clients first obtain `GET /api/console/me`; pre-login requests also use a short-lived anonymous CSRF cookie. Do not disable checks to work around proxy configuration.

## Client permissions

Clients → Client identities & permissions creates, rotates and revokes delegated identities, edits delegated/OAuth resource permissions, and explicitly reviews legacy global access. Credentials appear once; operations require recent reauthentication. Policy changes drain old sessions/tasks. See [Client permissions](client-access.md) for API fields, procedures and database rollback.

## Add and manage devices

Devices → Add device asks for a name, unique ID and Linux/macOS/OpenWrt/Docker platform. Save the once-shown token and run the displayed commands using the matching installer, release bundle or static Engine binary. Commands use configured public origin. OpenWrt needs a matching Node bundle; macOS needs a locally built release Engine. Registration is routable immediately and waits for the first valid heartbeat; closing the wizard retains registration.

Environment/`engines.json` devices are seeds. Their display names/types can change, but console cannot remove them or rotate tokens. Console devices support token rotation: the old token expires immediately while existing sessions continue. Removal closes sessions and revokes grants, retaining audit history. Offline devices remain in topology.

See [Engine](engine.md) for reported hardware/type overrides. Device details show workspaces and execution configuration from `session.ready`. Old Engines display not reported rather than guessing permissions from the method list.

Activity stores metadata only, never file contents, search patterns, process arguments or output. Filter by time, device, client, method class and result, or select Hide unauthenticated requests to exclude authentication failures before pagination. This filter is kept in the URL (`excludeAuthFailed=1`) and also applies to CSV/JSONL exports, with exports themselves audited. Settings retains 1–365 days, default 30, cleaning daily. Skills is reserved.

## Backup, recovery and rollback

`reach.db` contains administrator TOTP secrets, sessions, recovery-code hashes, Engine-token digests, device data and audit paths. Protect it as private credentials. Forward migrations store client policy and authenticated-principal audit fields; older versions cannot open newer schemas. Database mode is 0600. Keep databases, backups, real installation records and recovery codes out of public repositories. Within a source checkout, private state belongs only in ignored `.reach/`; deployment state/backups belong outside the repository.

The simplest consistent backup stops Gateway and copies the whole directory, including remaining WAL/SHM files. Configure a private backup location:

```sh
cd /srv/reach
: "${REACH_PRIVATE_BACKUP_DIR:?Set a private backup directory outside the repository}"
install -d -m 700 "$REACH_PRIVATE_BACKUP_DIR"
docker compose stop gateway
tar -czf "$REACH_PRIVATE_BACKUP_DIR/reach-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" data
chmod 600 "$REACH_PRIVATE_BACKUP_DIR"/reach-data-*.tgz
docker compose up -d gateway
```

Back up private env, `engines.json` and Compose separately. Online backups require SQLite backup API or a consistent snapshot; copying only live `reach.db` loses WAL state.

To restore, stop Gateway, save the current directory, extract the chosen backup, restore uid/gid 1000, directory 0700 and database 0600, then start a compatible Gateway. Verify owner login, registration and activity queries. Do not replace an existing installation with an empty directory to repair login.

Release helpers preserve `data/`, env, registry and Compose without automatically enabling or migrating existing installations. Database migrations are forward-only; older binaries reject newer schemas. Before rollback to a pre-console version, migrate console devices to private `engines.json` with newly issued tokens and update Engines, since original tokens cannot be recovered from digests. Preserve the database backup, remove `REACH_DATA_DIR` or deploy the old image, and keep env/seed configuration. Reinstalling a supported version with the original data restores console access.

See [Client permissions: upgrades and rollback](client-access.md) for separate policy and legacy-migration recovery requirements.
