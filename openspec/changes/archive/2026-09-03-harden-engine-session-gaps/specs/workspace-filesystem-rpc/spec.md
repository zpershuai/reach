## MODIFIED Requirements

### Requirement: Atomic conditional writes and edits
The system SHALL provide `fs.write` with `overwrite` and `create` modes and `fs.edit` with `oldString`, `newString`, and `replaceAll` defaulting to false. Mutations MUST be permission-checked, serialized, atomic, and confined to a verified real workspace directory. The system MUST open the real workspace root once, descend each path component with no-follow directory opens (descriptor-relative / `openat`+`O_NOFOLLOW` or equivalent), create missing parents one component at a time without following links, create the temporary file through the verified parent descriptor, and rename onto the target name only through that same parent descriptor. Path-string check-then-create-then-rename MUST NOT be used as the sole containment mechanism. When `ifMatch` is supplied and does not equal the current revision, the operation MUST fail with `REVISION_CONFLICT`; a missing edit source MUST fail with `OLD_STRING_NOT_FOUND`; and multiple occurrences without `replaceAll` MUST fail with `OLD_STRING_NOT_UNIQUE`. On platforms where no-follow descriptor-relative mutation is unavailable, the system MUST fail closed with `WORKSPACE_ACCESS_DENIED` rather than falling back to path-string mutation.

The mutation read of the target MUST open it without blocking on non-regular files (e.g. `O_NONBLOCK`), so a FIFO/device at the target is rejected promptly instead of stalling the engine thread; the read MUST NOT precede an `is_file` check with a blocking open. Missing parent directories MUST be created only after the write/edit existence and revision checks have passed, and a failed mutation MUST NOT create any parent directories. A parent whose concurrent creation races the `mkdirat` (returning `EEXIST`) MUST be re-opened and re-validated with `NOFOLLOW` rather than treated as a denial. Immediately before `renameat`, a mutation MUST re-check that the final component is not a symbolic link that appeared after validation and reject it with `WORKSPACE_ACCESS_DENIED` rather than replacing the link in place.

#### Scenario: Reject a symlink mutation path
- **WHEN** any target path component is a symbolic link
- **THEN** the mutation is rejected and no file outside the selected workspace is modified

#### Scenario: Reject a stall on a non-regular mutation target
- **WHEN** a write or edit target path resolves to a FIFO or device node in the workspace
- **THEN** the operation returns `WORKSPACE_ACCESS_DENIED` without blocking the engine and without stalling subsequent mutations

#### Scenario: Reject a stale mutation
- **WHEN** a caller writes or edits using an `ifMatch` value different from the current revision
- **THEN** the system reports `REVISION_CONFLICT` and preserves the file content

#### Scenario: Replace every matching edit source
- **WHEN** an edit source occurs multiple times and `replaceAll` is true
- **THEN** the system replaces every occurrence and returns the replacement count and new revision

#### Scenario: Reject symlink replacement between check and write
- **WHEN** a parent directory is replaced with a symbolic link after path validation begins and before the temporary file is renamed into place
- **THEN** the mutation fails without writing outside the selected workspace

#### Scenario: Do not replace a final-component symlink appearing during the write
- **WHEN** a symbolic link replaces the final component after validation and before the rename
- **THEN** the mutation fails with `WORKSPACE_ACCESS_DENIED` and does not replace the link

#### Scenario: Failed mutations do not create parent directories
- **WHEN** a write or edit fails an existence or revision check for a path whose parent directories are missing
- **THEN** the operation reports its failure and no parent directory is created

#### Scenario: Concurrent parent creation is not a denial
- **WHEN** another actor creates a missing parent directory between a failed no-follow open and the subsequent `mkdirat` (so `mkdirat` returns `EEXIST`)
- **THEN** the mutation re-opens that component with `NOFOLLOW` and continues instead of failing with `WORKSPACE_ACCESS_DENIED`

### Requirement: Session-scoped query cursors and operation sizes
The system SHALL bind pagination cursors to the active session, method, and complete query. It MUST reject cursors after disconnect or when reused for another method or query, and it MUST allow no more than 32 live cursors per session. Each read, write, and edit operation MUST reject a file larger than 8 MiB with `FILE_TOO_LARGE`. Each filesystem method SHALL be invokable directly and through a single-level `tool.call` using `{ name, arguments }` where `name` is a supported filesystem method. Nested `tool.call` (a `tool.call` whose `name` is itself `tool.call`) MUST be rejected with `INVALID_PARAMS` and MUST NOT dispatch a filesystem operation. When a session ends for any reason, including abnormal disconnect or send failure, the system MUST clear all cursors belonging to that session so a later session cannot resume them.

#### Scenario: Reject an excess cursor
- **WHEN** a session attempts to create a 33rd live filesystem cursor
- **THEN** the operation fails without creating that cursor

#### Scenario: Reject an oversized file operation
- **WHEN** a read, write, or edit addresses a file exceeding 8 MiB
- **THEN** the operation returns `FILE_TOO_LARGE` without returning or changing its content

#### Scenario: Reject a cursor reused for another query
- **WHEN** a cursor issued for one filesystem query is used with changed query parameters or another method
- **THEN** the system rejects the cursor as invalid

#### Scenario: Dispatch a filesystem tool call
- **WHEN** a caller invokes `tool.call` with a filesystem method name and its arguments
- **THEN** the system returns the same operation result as direct invocation

#### Scenario: Reject nested tool.call
- **WHEN** a caller invokes `tool.call` whose `name` is `tool.call`
- **THEN** the system returns `INVALID_PARAMS` and does not dispatch a nested filesystem operation

#### Scenario: Clear cursors after abnormal session end
- **WHEN** a session ends because the WebSocket read or response send fails before a clean `job.done` close
- **THEN** all cursors created during that session are invalidated and a later session cannot resume them
