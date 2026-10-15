# Spec Delta

## ADDED Requirements

### Requirement: Engine reports process execution workspaces
The Engine SHALL include optional `processWorkspaces` in `session.ready`, listing the workspace names where local configuration enables process execution. An empty list SHALL report execution disabled in every workspace. Older readiness messages without this field MUST remain valid.

#### Scenario: Execution enabled for one workspace
- **WHEN** local configuration enables execution only for workspace `scripts`
- **THEN** `session.ready` contains `processWorkspaces: ["scripts"]`

#### Scenario: Execution disabled
- **WHEN** no workspace enables execution
- **THEN** the Engine sends `processWorkspaces: []` even if its supported methods include `process.run`

### Requirement: Engine reports its hardware descriptor
The resident Engine SHALL detect its device kind, model, OS, OS version and architecture once at startup and include them as `device.hardware` in every heartbeat. Detection MUST use only local system information and MUST finish or give up within 3 seconds. A failed detection MUST still send kind `unknown` and MUST NOT delay or prevent heartbeats.

#### Scenario: macOS host
- **WHEN** the Engine starts on a Mac mini
- **THEN** its heartbeats report kind `mac-mini`, the marketing model name, OS `macOS` with its version, and the CPU architecture

#### Scenario: OpenWrt router
- **WHEN** the Engine starts on a host with `/etc/openwrt_release`
- **THEN** it reports kind `router`, the board model when available, OS `OpenWrt` and the release version

#### Scenario: Raspberry Pi
- **WHEN** `/proc/device-tree/model` begins with `Raspberry Pi`
- **THEN** it reports kind `raspberry-pi` and that model string

#### Scenario: Detection fails
- **WHEN** no detection source is readable
- **THEN** the Engine reports kind `unknown` with OS and architecture from the build target and continues heartbeating normally

### Requirement: Hardware descriptor is bounded and non-identifying
The reported descriptor SHALL contain only the five defined fields. Each field MUST be truncated to 64 printable characters. Serial numbers, hostnames, MAC addresses, user names and network addresses MUST NOT be included.

#### Scenario: Long DMI product name
- **WHEN** the DMI product name is 120 characters long
- **THEN** the reported model is truncated to 64 characters

#### Scenario: Serial number available
- **WHEN** the platform exposes a hardware serial number
- **THEN** it does not appear in any heartbeat field
