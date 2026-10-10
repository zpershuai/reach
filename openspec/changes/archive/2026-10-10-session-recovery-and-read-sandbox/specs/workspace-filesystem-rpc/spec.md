## ADDED Requirements

### Requirement: Descriptor-relative read and stat
`fs.read` and `fs.stat` SHALL resolve the target through no-follow descriptor-relative opens (`openat`+`O_NOFOLLOW`+`O_NONBLOCK` or equivalent), the same containment mechanism as mutations. A symbolic-link path component MUST fail with `WORKSPACE_ACCESS_DENIED`. A FIFO, device, or other non-regular file MUST fail promptly with `WORKSPACE_ACCESS_DENIED` and MUST NOT block the Engine thread. On platforms where no-follow descriptor-relative opens are unavailable, `fs.read` and `fs.stat` MUST fail closed with `WORKSPACE_ACCESS_DENIED` rather than falling back to path-string I/O. `fs.stat` MUST NOT hash a non-regular target as a regular file.

#### Scenario: Reject a stall on a FIFO read
- **WHEN** `fs.read` addresses a FIFO or device node in the workspace
- **THEN** the operation returns `WORKSPACE_ACCESS_DENIED` without blocking the engine

#### Scenario: Reject a symlink read path
- **WHEN** any `fs.read` path component is a symbolic link
- **THEN** the operation returns `WORKSPACE_ACCESS_DENIED` without following the link

#### Scenario: Stat a FIFO without blocking
- **WHEN** `fs.stat` addresses a FIFO in the workspace
- **THEN** the operation returns without blocking and does not treat the FIFO as a regular file with a content revision

### Requirement: Distinct missing and non-UTF-8 read errors
`fs.read` MUST return `FILE_NOT_FOUND` only when the target regular file is absent. When the target is a regular file whose bytes are not valid UTF-8, `fs.read` MUST return `NOT_UTF8` without treating the file as missing.

#### Scenario: Read a missing file
- **WHEN** `fs.read` addresses a workspace path that does not exist
- **THEN** the operation returns `FILE_NOT_FOUND`

#### Scenario: Read a non-UTF-8 regular file
- **WHEN** `fs.read` addresses a regular workspace file whose content is not valid UTF-8
- **THEN** the operation returns `NOT_UTF8` and does not return `FILE_NOT_FOUND`
