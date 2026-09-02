## ADDED Requirements

### Requirement: Engine-side filesystem execution
Filesystem methods defined by this capability SHALL be executed by the Engine process against Engine-configured workspace roots. The Gateway MUST NOT apply `fs.*` operations to a Gateway-local workspace during a Model B session. Results returned on the session MUST reflect the Engine host filesystem within those roots.

#### Scenario: Session read reflects engine files
- **WHEN** the Gateway sends `fs.read` for a path that exists only in the Engine workspace
- **THEN** the Engine returns that file’s content and the Gateway does not substitute a Gateway-local file

#### Scenario: Gateway has no session filesystem root
- **WHEN** a Model B session is live
- **THEN** filesystem success or failure depends on Engine workspace state, not on `~/.reach/workspace` on the Gateway host unless that host is also running the Engine with that root

## MODIFIED Requirements

### Requirement: Workspace path containment and file revisions
The Engine SHALL resolve every filesystem request inside the configured root selected by the request's named workspace. The configured `default` workspace SHALL map to `~/.reach/workspace` on the Engine host. An unknown workspace MUST fail with `WORKSPACE_ACCESS_DENIED`. It MUST reject paths outside that root and reject reads and writes through symbolic links. For regular files, `revision` SHALL be the lowercase hexadecimal SHA-256 digest of the complete file content.

#### Scenario: Reject an unknown workspace
- **WHEN** a caller supplies a workspace name that is absent from the Engine’s configured root map
- **THEN** the Engine returns `WORKSPACE_ACCESS_DENIED` without accessing the filesystem

#### Scenario: Reject a path outside the workspace
- **WHEN** a caller supplies a path that resolves outside the selected Engine workspace
- **THEN** the Engine rejects the request without reading or modifying that path

#### Scenario: Return a stable file revision
- **WHEN** a read, write, edit, or stat operation addresses a regular workspace file on the Engine
- **THEN** its returned revision equals the lowercase hexadecimal SHA-256 digest of the complete file content
