# Client identities and permissions

English | [简体中文](client-access_cn.md)

Gateway has one administrator who manages independent delegated/OAuth client identities; this is not a multi-user account system. Labels, `X-Reach-Client`, MCP `clientInfo` and identity fields in request bodies are display metadata and grant no authority. REST, HTTP MCP and stdio Connector calls all pass the same Gateway policy checks.

## Credential responsibilities

| Identity/credential | Permissions and lifecycle |
| --- | --- |
| Owner Controller token | All data-plane operations on registered Engines/workspaces; trusted management tools only |
| Delegated token, `reach_ct_` | Persistent identity, explicit expiry and per-Engine/workspace policy; plaintext returned once on create/rotate |
| OAuth access token, `reach_at_` | Approved application's persistent identity/current policy; one-hour access and rotating 30-day refresh tokens |
| Existing legacy-global OAuth | Retains previous global authority during upgrade, marked Review required; Owner must restrict or explicitly review. Reviewed global access still equals Owner trust |
| Engine token | Only the matching Engine's heartbeats/short-lived session token; no client/admin access |
| Administrator cookie | Console only, no data-plane RPC. Client changes require Origin, CSRF and password confirmation within ten minutes |

Delegated/OAuth administration requires `REACH_DATA_DIR`. Credentials are stored as digests; protect data/backups privately. Existing Owner Controller configuration remains compatible. Unauthenticated loopback development is locally trusted without client isolation; remote deployments require authentication and verified HTTPS/WSS.

## Create an everyday client

1. Sign into `/console/` with password/TOTP and open **Clients → Client identities & permissions**.
2. Choose **Create delegated client**, a name and short Credential expiry.
3. **Add resource** with exact Engine/workspace, e.g. `engine-a`, `docs`. Select only necessary read/write/execute; all default off. An empty policy can create an identity but discover/access nothing.
4. **Create client** and save the once-shown token in private client settings or a `0600` file. Plaintext cannot be retrieved after closing; rotate if lost.
5. HTTP MCP uses `Authorization: Bearer <delegated-client-token>`. Stdio JSON retains the historical `controllerToken` field, which also accepts delegated tokens:

```json
[
  {
    "id": "docs-device",
    "engineId": "engine-a",
    "gatewayUrl": "https://gateway.example.com",
    "controllerToken": "<delegated-client-token>"
  }
]
```

Save as private `.reach/devices.json`, run `chmod 600 .reach/devices.json` and point `REACH_MCP_DEVICES_FILE` to it. The historical field name does not grant Owner authority. Local Connector tool lists are not security boundaries; Gateway checks actual credentials.

OAuth applications use the [MCP OAuth flow](mcp.md). Approval requires admin password plus fresh TOTP/recovery code and explicit Engine/workspace/operation selection. No selection issues no code. Connected Engine workspaces come from reported names; offline/unreported ones require the exact configured name, ultimately checked by Engine. New approvals never inherit legacy-global authority; reapproval replaces existing policy with explicit selections.

## Operation mapping and discovery

| Permission | Methods |
| --- | --- |
| read | `fs.read`, `fs.list`, `fs.stat`, `fs.glob`, `fs.grep` |
| write | `fs.write`, `fs.edit` |
| execute | `process.run`, `process.status`, `process.logs`, `process.list`, `process.stop` |

Permissions are independent; write/execute imply no read. Resources match exact Engine ID/workspace without wildcards. Device discovery lists accessible Engines only; workspace/method/version/process results follow current policy. Inaccessible and nonexistent Engines return identical 404 shapes without disclosing another device's metadata.

Execute additionally requires local Engine workspace execution. Gateway policy/grants cannot enable locally disabled execution. Node scripts run with the Engine account's OS access to system resources; workspace APIs do not sandbox arbitrary code. A client allowed to write scripts may alter code another trusted client later executes: assess both trust relationships.

## Sessions, grants and errors

An Engine allows one interactive session. Sessions bind server-authenticated principals; knowing another session/process/launch ID grants no ownership, log access or stop permission. OAuth refresh retains principal/current policy. Process observation/control also requires the identity's owned trusted-task workspace.

File write, execution and process control require respective grants bound to principal, Engine, policy revision, scope and five-minute expiry. File grants also bind path/method; execution binds session/workspace/script/launchId; control binds session/processId. Policy is checked at issuance and forwarding, equally for direct calls and single-level `tool.call`; nested wrappers are rejected.

MCP's automatic grants are narrowly scoped machine authorization, not per-call human approval. They cannot expand policy. Owner can request grants for any resource, so Owner access provides no resource isolation.

| Condition | Public result |
| --- | --- |
| Invalid/revoked/expired credential | HTTP 401 |
| Missing/policy-hidden Engine | Identical HTTP 404 shape |
| Another principal's MCP session ID | HTTP 404 without disturbing it |
| Resource/operation denied | Grant issuance HTTP 403; authenticated RPC `PERMISSION_DENIED`; MCP tool error |
| Engine owned by another identity | `ENGINE_BUSY`; REST session control 409 |
| Another identity's task ID | `PROCESS_NOT_FOUND` or session-binding rejection without workspace disclosure |
| Engine execution disabled | `PROCESS_EXECUTION_DISABLED` |

## Rotation, revocation and policy changes

Use **Edit permissions**, **Rotate credential** or **Revoke identity**. Policy changes and delegated rotation/revocation/expiry synchronously block old authority, invalidate grants and drain that identity's MCP/Engine sessions and ordinary descendant processes. Expiry timers require no further request. Rotation returns one new token and immediately rejects the old one. Other identities remain authorized.

OAuth application revocation, `/oauth/revoke` and refresh-token replay use the same cleanup path. Replay revokes that token family and conservatively drains the application's shared ownership pool/grants, without affecting others. Refresh cannot expand policy. Reducing permissions during idle grace drains the old pool; new MCP sessions cannot reuse removed access.

Failed cleanup retains ownership/retries; Engine retains undrained process managers and blocks replacement tasks. Do not bypass cleanup by retrying or changing display labels. Forwarded writes may already have crossed atomic commit; revocation cannot undo them. After timeout/cancel/revocation, read revision/actual state before retrying rather than assuming rollback.

## API fields

Admin APIs require administrator cookie, Origin and CSRF; sensitive mutations require recent authentication. Controller/Engine/delegated bearer credentials cannot replace admin login.

| Request | JSON/result |
| --- | --- |
| `GET /api/console/access-clients` | `{ "clients": [...] }`, no token/digest |
| `POST /api/console/access-clients` | `{ "name": "Daily reader", "expiresAt": <future milliseconds>, "permissions": [...] }`; 201 `{ "client": {...}, "token": "..." }` |
| `GET /api/console/access-clients/:id` | `{ "client": {...} }` |
| `POST /api/console/access-clients/:id/rotate` | `{ "expiresAt": <future milliseconds> }`; one new token, active delegated identities only |
| `PATCH /api/console/access-clients/:id/policy` | `{ "permissions": [...] }`; empty array removes all resources |
| `DELETE /api/console/access-clients/:id` | No body; idempotently revokes identity |
| `POST /api/console/access-clients/:id/review-global` | `{ "confirm": true }`; existing legacy OAuth only, never creates global access |

URL-encode `:id`, e.g. `client%3A...` or `oauth%3A...`. Complete permission shape:

```json
{
  "engineId": "engine-a",
  "workspace": "docs",
  "read": true,
  "write": false,
  "execute": false
}
```

`expiresAt` is a future safe-integer JSON number, not a date string. All permission booleans must be present/boolean. Duplicate resources, unknown fields, null policies and wildcards are rejected without partial writes. Omitted create permissions mean an empty array; explicit null is invalid. Details include `kind`, `name`, `expiresAt`, `revokedAt`, `policyRevision`, `legacyGlobal`, `reviewRequired`. Names affect display only.

## Upgrades and rollback

Before upgrading, stop the test Gateway and save consistent SQLite/private-configuration backups. For active WAL databases do not copy only `reach.db`; use SQLite backup API or stop/copy the whole directory. Documentation cleanup must not rotate production credentials or start/stop existing services.

Schema migration 3 transactionally creates identity/credential/policy tables and maps only previously approved (`approved_at` non-null) OAuth clients to `legacy-global`, `review_required`. Unapproved registrations gain nothing. Administrator, Owner/Engine credentials and OAuth digests remain. Repeated starts do not remigrate; failure rolls back tables/version.

Review every **Review required** entry. Prefer **Edit permissions** to restrict; if global access is necessary, **Review global access** explicitly acknowledges Owner-equivalent risk. Confirmation clears only the review flag, not global authority. Public readiness acceptance must leave no unreviewed legacy grants.

Older Gateway rejects the new schema. Stop the candidate and restore the old binary with its matching pre-upgrade consistent snapshot, reusing env/seed settings. Never delete tables or lower schema version manually. Post-snapshot delegated identities/policy edits disappear; old versions lack those identities and may restore former global OAuth authority. Audit this first, verify recovery with a separate data directory and preserve the running installation.

Isolated `client-policy.test.ts`, `client-access.test.ts`, `client-authorization.test.ts`, `auth.test.ts`, `oauth.test.ts`, `store.test.ts` and console tests cover these fields/lifecycles; they do not certify any production migration.
