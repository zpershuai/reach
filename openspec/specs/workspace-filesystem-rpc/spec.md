## Purpose

Provides safe, bounded filesystem inspection and mutation operations for files in a Reach session workspace.

## Requirements

### Requirement: Engine-side filesystem execution
Filesystem methods defined by this capability SHALL be executed by the Engine process against Engine-configured workspace roots. The Gateway MUST NOT apply `fs.*` operations to a Gateway-local workspace during a Model B session. Results returned on the session MUST reflect the Engine host filesystem within those roots.

#### Scenario: Session read reflects engine files
- **WHEN** the Gateway sends `fs.read` for a path that exists only in the Engine workspace
- **THEN** the Engine returns that file’s content and the Gateway does not substitute a Gateway-local file

#### Scenario: Gateway has no session filesystem root
- **WHEN** a Model B session is live
- **THEN** filesystem success or failure depends on Engine workspace state, not on `~/.reach/workspace` on the Gateway host unless that host is also running the Engine with that root

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

### Requirement: Read, list, and stat workspace entries
The system SHALL provide `fs.read`, `fs.list`, and `fs.stat`. `fs.read` SHALL return content, `startLine`, `endLine`, `totalLines`, `truncated`, and `revision`; defaults are `startLine` 1 and `maxLines` 200. `fs.list` SHALL default `path` to `.` and `maxEntries` to 200 and paginate entries with a cursor. `fs.stat` SHALL return `type`, `size`, `mtime`, and a revision for regular files.

#### Scenario: Read a limited line range
- **WHEN** a file has more lines after the requested `maxLines`
- **THEN** `fs.read` returns the requested line metadata, complete-content revision, and `truncated` true

#### Scenario: Paginate directory entries
- **WHEN** a directory contains more entries than `maxEntries`
- **THEN** `fs.list` returns a cursor that continues the same listing query

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

### Requirement: Bounded glob and grep search
The system SHALL provide `fs.glob` and `fs.grep`, both rooted at `path` defaulting to `.` and supporting pagination cursors. `fs.glob` SHALL traverse until the workspace tree is exhausted or 10,000 matching files have been found, apply its pattern during traversal, return files only, default `maxResults` to 200, and honor `respectGitignore` defaulting to true. `fs.grep` SHALL treat `pattern` as a literal substring, skip symbolic links, walk incrementally, scan at most 8 MiB, return at most 10,000 matches, and truncate each returned line to 16 KiB. Both operations SHALL mark results truncated when their applicable hard limit is reached.

#### Scenario: Continue globbing past nonmatching files
- **WHEN** a traversal visits more than 10,000 nonmatching files before later matching files
- **THEN** it still returns later matching files unless the 10,000 matching-file limit is reached

#### Scenario: Limit an ignored-file glob
- **WHEN** a glob uses the default gitignore behavior in a workspace with ignored files
- **THEN** ignored files are excluded from its returned file results

#### Scenario: Bound grep work and output
- **WHEN** grep encounters more searchable data or matching lines than its configured limits permit
- **THEN** it returns only bounded matches and indicates that its result is truncated

### Requirement: Session-scoped query cursors and tool dispatch
The system SHALL bind pagination cursors to the active session, method, and complete query. It MUST reject cursors after disconnect or when reused for another method or query. Each filesystem method SHALL be invokable directly and through `tool.call` using `{ name, arguments }`.

#### Scenario: Reject a cursor reused for another query
- **WHEN** a cursor issued for one filesystem query is used with changed query parameters or another method
- **THEN** the system rejects the cursor as invalid

#### Scenario: Dispatch a filesystem tool call
- **WHEN** a caller invokes `tool.call` with a filesystem method name and its arguments
- **THEN** the system returns the same operation result as direct invocation

### Requirement: Filesystem parameter validation
The system SHALL reject missing required fields, invalid field types, empty required strings, invalid modes, non-integer values, and out-of-range limits with `INVALID_PARAMS`. Unknown fields in filesystem request objects MUST be ignored.

#### Scenario: Reject malformed filesystem parameters
- **WHEN** a filesystem operation has an invalid required field or range
- **THEN** the system returns `INVALID_PARAMS`

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
