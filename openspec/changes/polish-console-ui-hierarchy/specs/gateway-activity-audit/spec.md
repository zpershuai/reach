# Spec Delta

## MODIFIED Requirements

### Requirement: Activity query
Signed-in sessions SHALL be able to query audit records newest first through a cursor-paginated API. The query MUST accept filters for time range, Engine id, client label, method class (read, write, exec, control) and outcome. It MUST also accept an optional flag that excludes `auth.failed` records; when the flag is absent, `auth.failed` records MUST be included as before.

#### Scenario: Filter by device and failures
- **WHEN** the console requests records for Engine `nas-01` with outcome not `ok`
- **THEN** only that Engine's error and denied records are returned, newest first, with a cursor when more exist

#### Scenario: Exclude authentication failures
- **WHEN** the console requests a page of 50 records with the exclude-authentication-failures flag and the newest 80 stored records are `auth.failed`
- **THEN** the page contains the newest 50 records that are not `auth.failed`, with a cursor when more exist

#### Scenario: Flag absent
- **WHEN** the console requests records without the exclude-authentication-failures flag
- **THEN** `auth.failed` records are returned alongside other records
