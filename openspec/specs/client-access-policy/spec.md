# client-access-policy Specification

## Purpose

Defines least-privilege client identities for a single-owner Reach Gateway, limiting resource discovery and data-plane actions to explicitly authorized Engines, workspaces and operation classes throughout credential and session lifetimes.

## Requirements

### Requirement: Owner-managed client identities
The Gateway SHALL let a recently re-authenticated console owner create, inspect, expire, rotate and revoke delegated client credentials and assign policies to OAuth clients. Delegated tokens MUST contain at least 256 random bits, be disclosed only on creation or rotation, and be persisted only as digests. Credential metadata and policies MUST survive restart.

#### Scenario: A delegated credential is issued
- **WHEN** the owner creates an expiring delegated credential
- **THEN** the response shows its token once, later listings show metadata only, and restart preserves its identity, expiry and policy

#### Scenario: Another credential type manages policies
- **WHEN** a delegated token, Engine token or Owner Controller token calls the console management API
- **THEN** the API rejects the request without issuing a credential or changing policy

### Requirement: Explicit resource and operation authorization
A client policy SHALL enumerate Engine IDs and workspace names with independent read, write and execute permissions. New clients MUST have no access until explicitly granted. Missing entries and unknown operations MUST deny access. Write permission MUST NOT imply execute, and execute MUST NOT imply filesystem write. Future Engines and workspaces MUST NOT be implicitly included.

#### Scenario: Read-only client attempts mutation
- **WHEN** a client authorized only to read `engine-a/docs` requests a write, edit, execution grant or process launch
- **THEN** the request fails with `PERMISSION_DENIED` before forwarding or side effects

#### Scenario: A new workspace appears
- **WHEN** `engine-a` advertises a workspace absent from the client's explicit policy
- **THEN** the client cannot discover or operate on that workspace

### Requirement: One authorization boundary for all ingress paths
REST, HTTP MCP and Connector requests SHALL authenticate to a server-derived stable principal. Resource selection, session controls, grant issuance and RPC dispatch MUST enforce its current policy before forwarding. Direct calls and one valid `tool.call` wrapper MUST enforce identical policy; nested wrappers MUST remain `INVALID_PARAMS`. Caller-provided labels or identity fields MUST NOT grant authority.

#### Scenario: Switching transport does not bypass policy
- **WHEN** the same scoped credential requests an unauthorized Engine or workspace through REST, HTTP MCP or a stdio Connector
- **THEN** every path denies it without forwarding, and changing a client label does not change the result

#### Scenario: A forged identity is supplied
- **WHEN** a request claims another principal in headers, parameters or attribution fields
- **THEN** authorization continues using the authenticated credential identity

### Requirement: Policy-filtered discovery and observation
Scoped clients SHALL discover only authorized Engines, workspaces and supported operations. Status and version responses MUST omit unauthorized resource metadata. Queries for unknown and unauthorized Engine IDs MUST use indistinguishable 404 responses. Workspace and operation denials on a visible Engine MUST use `PERMISSION_DENIED` without exposing hidden workspace metadata.

#### Scenario: Device discovery is filtered
- **WHEN** a client authorized for `engine-a/docs` lists devices, queries versions or lists workspaces
- **THEN** no metadata from `engine-b` or another workspace is returned

#### Scenario: Hidden device is probed
- **WHEN** a scoped client queries a hidden Engine ID or a nonexistent Engine ID
- **THEN** both responses have the same 404 status and public error shape

### Requirement: Principal-owned sessions and processes
Session ownership SHALL bind authenticated principal and Engine, never display labels. A principal MUST NOT renew, close, adopt or use another principal's session, grants or process identifiers. Process status, logs, list and stop MUST require current execute permission for the task's workspace and its owner session. Administrative cleanup MUST remain possible without restoring client authority.

#### Scenario: Client B presents client A's session identifier
- **WHEN** client B attempts session control or process access using A's identifiers
- **THEN** no data or control is granted and A's session is unaffected

#### Scenario: Execute permission is absent
- **WHEN** a filesystem-read client requests process logs or process control
- **THEN** it receives no process content and no process is signaled

### Requirement: Immediate expiry revocation and policy reduction
Expired or revoked credentials MUST fail authentication with 401. Policy reductions MUST take effect before admitting further work, invalidate affected grants, and drain the principal's affected sessions and owned processes using bounded cleanup. Already committed atomic mutations MUST NOT be represented as rolled back. Cleanup failure MUST retain ownership and prevent unsafe reuse.

#### Scenario: Permission is removed during an active session
- **WHEN** the owner removes execute or workspace access while the client has an active task
- **THEN** further work is denied, affected grants expire immediately, and owned tasks are stopped through bounded session cleanup

#### Scenario: A credential expires without another request
- **WHEN** an active delegated credential reaches its expiry
- **THEN** its sessions drain and owned processes are cleaned up without waiting for a later client request

### Requirement: Explicit legacy Owner compatibility
The configured Controller token SHALL retain its documented global Owner role. Previously approved OAuth clients SHALL migrate to explicit global legacy policies marked for owner review, without silently changing existing authority. New OAuth clients MUST default to no access. Public-readiness approval MUST require owner review of all legacy policies. Shared Owner credentials MUST NOT be described as isolated client identities.

#### Scenario: An existing installation upgrades
- **WHEN** a database with previously approved OAuth clients is migrated
- **THEN** each client's prior authority is represented by a visible legacy policy, the Owner token continues to work, and new clients receive no inherited global policy

#### Scenario: Legacy review is incomplete
- **WHEN** a public candidate includes an unreviewed global legacy approval
- **THEN** its readiness gate remains incomplete until the owner explicitly approves or restricts that authority

### Requirement: Local Engine limits remain authoritative
Gateway policy SHALL only narrow the capabilities available from an Engine. An execute grant MUST NOT enable a locally disabled process workspace, expand an Engine workspace root or grant OS isolation. The product MUST identify Gateway operators and explicitly authorized Owner credentials as trusted and describe script execution with the Engine account's privileges.

#### Scenario: Remote policy exceeds local configuration
- **WHEN** Gateway policy permits execute but the Engine workspace has execution disabled
- **THEN** the Engine returns `PROCESS_EXECUTION_DISABLED` without spawning a process
