## MODIFIED Requirements

### Requirement: Workspace path containment and file revisions
The system SHALL resolve every filesystem request inside the configured root selected by the request's named workspace. The configured `default` workspace SHALL map to `~/.reach/workspace`. An unknown workspace MUST fail with `WORKSPACE_ACCESS_DENIED`. It MUST reject paths outside that root and reject reads and writes through symbolic links. For regular files, `revision` SHALL be the lowercase hexadecimal SHA-256 digest of the complete file content.

#### Scenario: Reject an unknown workspace
- **WHEN** a caller supplies a workspace name that is absent from the configured root map
- **THEN** the system returns `WORKSPACE_ACCESS_DENIED` without accessing the filesystem

#### Scenario: Reject a path outside the workspace
- **WHEN** a caller supplies a path that resolves outside the selected workspace
- **THEN** the system rejects the request without reading or modifying that path

#### Scenario: Return a stable file revision
- **WHEN** a read, write, edit, or stat operation addresses a regular workspace file
- **THEN** its returned revision equals the lowercase SHA-256 digest of the complete file content

### Requirement: Atomic conditional writes and edits
The system SHALL provide `fs.write` with `overwrite` and `create` modes and `fs.edit` with `oldString`, `newString`, and `replaceAll` defaulting to false. Mutations MUST be permission-checked, serialized, atomic, and confined to a verified real workspace directory. The system MUST reject a symbolic-link path component during mutation, create parent directories one component at a time without following links, and rename the completed temporary file only within the verified target directory. When `ifMatch` is supplied and does not equal the current revision, the operation MUST fail with `REVISION_CONFLICT`; a missing edit source MUST fail with `OLD_STRING_NOT_FOUND`; and multiple occurrences without `replaceAll` MUST fail with `OLD_STRING_NOT_UNIQUE`.

#### Scenario: Reject a symlink mutation path
- **WHEN** any target path component is a symbolic link
- **THEN** the mutation is rejected and no file outside the selected workspace is modified

#### Scenario: Reject a stale mutation
- **WHEN** a caller writes or edits using an `ifMatch` value different from the current revision
- **THEN** the system reports `REVISION_CONFLICT` and preserves the file content

#### Scenario: Replace every matching edit source
- **WHEN** an edit source occurs multiple times and `replaceAll` is true
- **THEN** the system replaces every occurrence and returns the replacement count and new revision

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

### Requirement: Session-scoped query cursors and operation sizes
The system SHALL bind pagination cursors to the active session, method, and complete query. It MUST reject cursors after disconnect or when reused for another method or query, and it MUST allow no more than 32 live cursors per session. Each read, write, and edit operation MUST reject a file larger than 8 MiB with `FILE_TOO_LARGE`. Each filesystem method SHALL be invokable directly and through `tool.call` using `{ name, arguments }`.

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
