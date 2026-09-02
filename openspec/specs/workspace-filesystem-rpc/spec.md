## Purpose

Provides safe, bounded filesystem inspection and mutation operations for files in a Reach session workspace.

## Requirements

### Requirement: Workspace path containment and file revisions
The system SHALL resolve every filesystem request inside the named configured workspace, whose default location is `~/.reach/workspace`. It MUST reject paths outside that root and reject writes through symbolic links. For regular files, `revision` SHALL be the lowercase hexadecimal SHA-256 digest of the complete file content.

#### Scenario: Reject a path outside the workspace
- **WHEN** a caller supplies a path that resolves outside the selected workspace
- **THEN** the system rejects the request without reading or modifying that path

#### Scenario: Return a stable file revision
- **WHEN** a read, write, edit, or stat operation addresses a regular workspace file
- **THEN** its returned revision equals the lowercase SHA-256 digest of the complete file content

### Requirement: Read, list, and stat workspace entries
The system SHALL provide `fs.read`, `fs.list`, and `fs.stat`. `fs.read` SHALL return content, `startLine`, `endLine`, `totalLines`, `truncated`, and `revision`; defaults are `startLine` 1 and `maxLines` 200. `fs.list` SHALL default `path` to `.` and `maxEntries` to 200 and paginate entries with a cursor. `fs.stat` SHALL return `type`, `size`, `mtime`, and a revision for regular files.

#### Scenario: Read a limited line range
- **WHEN** a file has more lines after the requested `maxLines`
- **THEN** `fs.read` returns the requested line metadata, complete-content revision, and `truncated` true

#### Scenario: Paginate directory entries
- **WHEN** a directory contains more entries than `maxEntries`
- **THEN** `fs.list` returns a cursor that continues the same listing query

### Requirement: Atomic conditional writes and edits
The system SHALL provide `fs.write` with `overwrite` and `create` modes and `fs.edit` with `oldString`, `newString`, and `replaceAll` defaulting to false. Mutations MUST be permission-checked, serialized, and atomic. When `ifMatch` is supplied and does not equal the current revision, the operation MUST fail with `REVISION_CONFLICT`; a missing edit source MUST fail with `OLD_STRING_NOT_FOUND`; and multiple occurrences without `replaceAll` MUST fail with `OLD_STRING_NOT_UNIQUE`.

#### Scenario: Reject a stale mutation
- **WHEN** a caller writes or edits using an `ifMatch` value different from the current file revision
- **THEN** the system reports `REVISION_CONFLICT` and preserves the file content

#### Scenario: Replace every matching edit source
- **WHEN** an edit source occurs multiple times and `replaceAll` is true
- **THEN** the system replaces every occurrence and returns the replacement count and new revision

### Requirement: Bounded glob and grep search
The system SHALL provide `fs.glob` and `fs.grep`, both rooted at `path` defaulting to `.` and supporting pagination cursors. `fs.glob` SHALL return files only, default `maxResults` to 200, honor `respectGitignore` defaulting to true, and enforce a 10,000-result hard limit. `fs.grep` SHALL default `maxMatches` to 100, skip symbolic links, scan at most 8 MiB, return at most 10,000 matches, and truncate each returned line to 16 KiB.

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

