# Spec Delta

## ADDED Requirements

### Requirement: Optional device hardware descriptor
The heartbeat `device` object MAY include a `hardware` object with string fields `kind`, `model`, `os`, `osVersion` and `arch`. When it is present and valid, the Gateway SHALL record it as the Engine's latest hardware and expose it to the console. An invalid or oversized descriptor MUST be ignored without rejecting the heartbeat.

The limits are:
- each field at most 64 printable characters;
- `kind` one of the console device kinds, otherwise treated as `unknown`.

#### Scenario: Engine reports a Mac mini
- **WHEN** a heartbeat contains `device.hardware` `{kind:"mac-mini", model:"Mac mini (M4, 2024)", os:"macOS", osVersion:"15.6", arch:"arm64"}`
- **THEN** the heartbeat response is unchanged and the console shows that hardware for the Engine

#### Scenario: Malformed descriptor
- **WHEN** `device.hardware.model` is 500 characters long
- **THEN** the Gateway returns the normal heartbeat response and keeps the previously recorded hardware

#### Scenario: Descriptor absent
- **WHEN** an older Engine heartbeats without `device.hardware`
- **THEN** the heartbeat is accepted exactly as before

### Requirement: Heartbeats are observable events
Each authenticated, valid heartbeat SHALL update the Engine's last-seen time. When the console is enabled, it MUST also publish an `engine.heartbeat` event carrying the Engine id, the reported Engine version and the returned interval.

#### Scenario: Idle heartbeat in the console
- **WHEN** an idle Engine heartbeats and receives `intervalSeconds` 15
- **THEN** an `engine.heartbeat` event with interval 15 is published and the console pulses that Engine's link
