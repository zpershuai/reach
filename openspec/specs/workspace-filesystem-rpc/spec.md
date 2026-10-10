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
The system SHALL provide `fs.write` with `overwrite` and `create` modes and `fs.edit` with `oldString`, `newString`, and `replaceAll` defaulting to false.

#### Scenario: Required atomic conditional writes and edits behavior
- **WHEN** a filesystem RPC is executed
- **THEN** Mutations MUST be permission-checked, serialized, atomic, and confined to a verified real workspace directory.
- **AND** The system MUST open the real workspace root once, descend each path component with no-follow directory opens (descriptor-relative / `openat`+`O_NOFOLLOW` or equivalent), create missing parents one component at a time without following links, create the temporary file through the verified parent descriptor, and rename onto the target name only through that same parent descriptor.
- **AND** Path-string check-then-create-then-rename MUST NOT be used as the sole containment mechanism.
- **AND** When `ifMatch` is supplied and does not equal the current revision, the operation MUST fail with `REVISION_CONFLICT`; a missing edit source MUST fail with `OLD_STRING_NOT_FOUND`; and multiple occurrences without `replaceAll` MUST fail with `OLD_STRING_NOT_UNIQUE`.
- **AND** On platforms where no-follow descriptor-relative mutation is unavailable, the system MUST fail closed with `WORKSPACE_ACCESS_DENIED` rather than falling back to path-string mutation.
- **AND** The mutation read of the target MUST open it without blocking on non-regular files (e.g.
- **AND** `O_NONBLOCK`), so a FIFO/device at the target is rejected promptly instead of stalling the engine thread; the read MUST NOT precede an `is_file` check with a blocking open.
- **AND** Missing parent directories MUST be created only after the write/edit existence and revision checks have passed, and a failed mutation MUST NOT create any parent directories.
- **AND** A parent whose concurrent creation races the `mkdirat` (returning `EEXIST`) MUST be re-opened and re-validated with `NOFOLLOW` rather than treated as a denial.
- **AND** Immediately before `renameat`, a mutation MUST re-check that the final component is not a symbolic link that appeared after validation and reject it with `WORKSPACE_ACCESS_DENIED` rather than replacing the link in place.

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
The system SHALL provide `fs.glob` and `fs.grep`, both rooted at `path` defaulting to `.` and supporting pagination cursors.

#### Scenario: Required bounded glob and grep search behavior
- **WHEN** a filesystem RPC is executed
- **THEN** `fs.glob` SHALL traverse until the workspace tree is exhausted or 10,000 matching files have been found, apply its pattern during traversal, return files only, default `maxResults` to 200, and honor `respectGitignore` defaulting to true.
- **AND** `fs.grep` SHALL treat `pattern` as a literal substring, skip symbolic links, walk incrementally, scan at most 8 MiB, return at most 10,000 matches, and truncate each returned line to 16 KiB.
- **AND** Both operations SHALL mark results truncated when their applicable hard limit is reached.

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
The system SHALL bind pagination cursors to the active Engine session, canonical filesystem method, and complete query.

#### Scenario: Required session-scoped query cursors and tool dispatch behavior
- **WHEN** a filesystem RPC is executed
- **THEN** It MUST reject cursors after session disconnect, expiry, drain, or when reused for another method or query.
- **AND** Each filesystem method SHALL be invokable directly through its registered canonical method.
- **AND** A single-level `tool.call` wrapper MAY be accepted only as a compatibility adapter and MUST be canonicalized before authorization and Tool dispatch; nested or malformed `tool.call` MUST be rejected as `INVALID_PARAMS`.

#### Scenario: Reject a cursor reused for another query
- **WHEN** a cursor issued for one filesystem query is used with changed query parameters or another method
- **THEN** the system rejects the cursor as invalid

#### Scenario: Cursor is invalid after session policy closure
- **WHEN** a session ends because of lease expiry, idle timeout, rotation, or transport disconnect
- **THEN** a later session cannot use its cursor

#### Scenario: Dispatch a filesystem tool call
- **WHEN** a caller invokes one valid `tool.call` wrapper with a filesystem method name and its arguments
- **THEN** the system returns the same operation result as direct invocation

### Requirement: Filesystem operation cancellation boundary
The system SHALL associate every filesystem operation with the active SessionContext cancellation and deadline policy. A Tool MUST NOT begin a queued filesystem operation after its session enters draining or its request deadline has elapsed. An operation that has already reached an atomic workspace mutation boundary MAY complete before transport closure, but its result MUST NOT be retained for a later session.

#### Scenario: Queued mutation is cancelled on session close
- **WHEN** a write is queued behind another request and the active session enters draining before the write starts
- **THEN** the queued write is not performed and the caller receives a session-closing or deadline error

### Requirement: Filesystem parameter validation
The system SHALL reject missing required fields, invalid field types, empty required strings, invalid modes, non-integer values, and out-of-range limits with `INVALID_PARAMS`. Unknown fields in filesystem request objects MUST be ignored.

#### Scenario: Reject malformed filesystem parameters
- **WHEN** a filesystem operation has an invalid required field or range
- **THEN** the system returns `INVALID_PARAMS`

### Requirement: Session-scoped query cursors and operation sizes
The system SHALL bind pagination cursors to the active session, method, and complete query.

#### Scenario: Required session-scoped query cursors and operation sizes behavior
- **WHEN** a filesystem RPC is executed
- **THEN** It MUST reject cursors after disconnect or when reused for another method or query, and it MUST allow no more than 32 live cursors per session.
- **AND** Each read, write, and edit operation MUST reject a file larger than 8 MiB with `FILE_TOO_LARGE`.
- **AND** Each filesystem method SHALL be invokable directly and through a single-level `tool.call` using `{ name, arguments }` where `name` is a supported filesystem method.
- **AND** Nested `tool.call` (a `tool.call` whose `name` is itself `tool.call`) MUST be rejected with `INVALID_PARAMS` and MUST NOT dispatch a filesystem operation.
- **AND** When a session ends for any reason, including abnormal disconnect or send failure, the system MUST clear all cursors belonging to that session so a later session cannot resume them.

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
- **WHEN** a session ends because the WebSocket read or response send fails before a clean `session.close` close
- **THEN** all cursors created during that session are invalidated and a later session cannot resume them

### Requirement: Descriptor-relative inspection and bounded snapshots
The Rust Engine MUST inspect and traverse workspace paths through no-follow directory descriptors.

#### Scenario: Required descriptor-relative inspection and bounded snapshots behavior
- **WHEN** a filesystem RPC is executed
- **THEN** Opening and reading regular files MUST reject non-regular targets without waiting on a FIFO.
- **AND** The 8 MiB bound MUST be enforced during reads even when files grow after metadata inspection.
- **AND** Directory enumeration MUST retain at most 10,000 entries per directory and recursion MUST be bounded to 128 directory levels, failing as `DIRECTORY_TOO_LARGE` or `DIRECTORY_TOO_DEEP`.
- **AND** Platforms lacking descriptor-relative primitives MUST fail closed.
- **AND** Completed pagination snapshots, including the TypeScript test reference, MUST be deleted and exhausted cursors MUST be invalid.

#### Scenario: Directory is swapped during inspection
- **WHEN** a validated directory's path is replaced with a symbolic link to an outside directory
- **THEN** inspection continues through the pinned original descriptor or fails without reading outside content

#### Scenario: Complete many paginated queries
- **WHEN** a session repeatedly consumes queries to their final pages
- **THEN** completed snapshots do not consume the 32-live-cursor allowance and exhausted cursors are rejected

### Requirement: Bounded cooperative text reads
Regular-file reads and grep's partial byte-budget reads MUST check cooperative cancellation between chunks no larger than 64 KiB.

#### Scenario: Required bounded cooperative text reads behavior
- **WHEN** a filesystem RPC is executed
- **THEN** Grep MUST also check its invocation deadline between chunks and scanned lines while preserving its truncation behavior.
- **AND** Text reads and mutation pre-reads MUST return `INVALID_UTF8` for invalid UTF-8 content on supported platforms, without modifying that content.
- **AND** Reading a directory as a text file MUST return `FILE_NOT_FOUND`; non-regular special targets MUST remain access-denied.
- **AND** `fs.stat` MAY hash raw file bytes without requiring valid UTF-8.

#### Scenario: Cancel grep during one large file
- **WHEN** session cancellation is requested between read chunks of a large regular file
- **THEN** grep stops before reading another chunk and does not wait to consume the whole file

### Requirement: Safe traversal under concurrent entry changes
Within a verified pinned directory, traversal MUST skip children removed or replaced with a symlink, directory, or special file after enumeration when they no longer match the expected entry type. It MUST not follow replacement symlinks. File callbacks MUST receive the pinned regular-file descriptor rather than reopen the child name. Workspace-root validation and other I/O, containment, deadline, and cancellation errors MUST still be reported rather than silently skipped.

#### Scenario: A listed regular file is replaced before opening
- **WHEN** a listed file is replaced with a FIFO or symlink before the no-follow child open
- **THEN** traversal skips that entry, does not wait on the FIFO or read outside content, and continues to surviving regular files

### Requirement: Edit allocation is bounded before replacement
fs.edit MUST compute the final UTF-8 byte length with checked arithmetic before allocating replaced content. Overflow or results over 8 MiB MUST return FILE_TOO_LARGE and preserve file content and revision. Revision and occurrence checks MUST retain their existing precedence.

#### Scenario: Repeated replacement would amplify memory
- **WHEN** many matches and a large or multibyte replacement produce an oversized result
- **THEN** the result is rejected before materialization and the file is unchanged

### Requirement: Atomic mutation preserves ordinary permissions
On Unix, atomic edit and overwrite MUST retain the verified original regular file's rwx permission bits on the replacement descriptor before rename. Special setuid, setgid and sticky bits MUST be cleared. New files MUST default to 0600. No-follow access and final inode checks MUST prevent replacing a target substituted during the mutation.

#### Scenario: Edit or overwrite an executable or shared file
- **WHEN** a revision-safe mutation replaces a 0755 or 0644 file
- **THEN** its access/execution bits are retained and stale revisions still reject without mutation

### Requirement: Recursive glob tokens have consistent semantics
Rust and TypeScript MUST parse glob tokens without rewriting generated regex. A star matches zero or more non-slash characters, a question mark one Unicode non-slash character, double-star any characters including slash, and double-star-slash zero or more directory levels. Other characters MUST be literal and the entire path MUST match. Both implementations MUST satisfy independent fixtures/glob-patterns.json expectations.

#### Scenario: Recursive and literal patterns
- **WHEN** src/**, nested double-star patterns or regex-special literal filenames are queried
- **THEN** matching files agree with the fixture's expected results, including nested paths and Unicode
