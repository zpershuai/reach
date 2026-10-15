# gateway-engine-registry Specification

## Purpose

Keeps the set of Engines a Gateway serves in persistent storage so the owner can enroll, rename, rotate, retype and remove devices from the console without editing files or restarting the Gateway.

## Requirements

### Requirement: Persistent Engine registry
When `REACH_DATA_DIR` is configured, the Gateway SHALL store each registered Engine's id, display name, token digest, creation time, origin (`seed` or `console`), optional device-type override and last reported hardware descriptor. Registered Engines MUST survive restarts.

#### Scenario: Restart keeps enrolled devices
- **WHEN** an Engine is added from the console and the Gateway restarts
- **THEN** the Engine is still registered and its existing token still authenticates `/heartbeat`

### Requirement: Engine tokens are stored as digests
The Gateway SHALL store only the SHA-256 digest of each Engine token and compare presented tokens in constant time. Console-generated tokens MUST contain at least 256 bits of randomness and MUST be returned exactly once, in the response that creates or rotates them.

#### Scenario: Token shown once
- **WHEN** the owner adds an Engine and later opens its detail view
- **THEN** the detail view shows that a token exists but cannot reveal it

#### Scenario: Stolen database
- **WHEN** an attacker reads the data directory
- **THEN** no Engine or Controller token can be recovered from it

### Requirement: Declarative seeds remain authoritative for their entries
At startup, Engines from `REACH_ENGINE_ID` and `REACH_ENGINE_TOKEN` and from `REACH_ENGINES_FILE` SHALL be upserted as `seed` entries. If a seed's token changes, its stored digest MUST be updated. The console MUST NOT remove or rotate a seed entry; it MAY rename it or override its device type.

#### Scenario: Existing deployment upgrades
- **WHEN** a Gateway configured with `REACH_ENGINE_ID=mac-mini` and an `engines.json` of two Engines starts with a new empty data directory
- **THEN** all three Engines are registered as seeds and their existing tokens keep working

#### Scenario: Seed removal attempt
- **WHEN** the owner tries to remove a seed Engine from the console
- **THEN** the Gateway returns 409 explaining that the entry is managed by Gateway configuration

#### Scenario: No data directory
- **WHEN** `REACH_DATA_DIR` is unset
- **THEN** Engine registration behaves exactly as it does without this change

### Requirement: Runtime Engine enrollment
A signed-in, recently re-authenticated session SHALL be able to add an Engine with a unique id (1–64 characters of `[A-Za-z0-9._-]`) and a display name. The Engine MUST become routable at once for `/heartbeat`, `/session/*?engineId=`, `/grants` and MCP device tools without a restart.

#### Scenario: Add then connect
- **WHEN** the owner adds `router-engine-a` and installs the Engine with the shown token
- **THEN** the first heartbeat from that Engine is accepted and the device appears in MCP `list_devices`

#### Scenario: Unauthenticated loopback Gateway
- **WHEN** the Gateway runs without `REACH_CONTROLLER_TOKEN` (local loopback development mode)
- **THEN** the console shows the single default Engine and refuses enrollment with an explanation that multiple Engines require Gateway authentication

#### Scenario: Duplicate id
- **WHEN** the owner adds an id that is already registered
- **THEN** the Gateway returns 409 and the existing Engine is unchanged

### Requirement: Enrollment first-heartbeat signal
After an Engine is added, the Gateway SHALL report its enrollment status as `awaiting_heartbeat` until it receives the first authenticated heartbeat, and as `connected` afterwards. The status change MUST be published on the console event stream.

#### Scenario: Wizard waits for the device
- **WHEN** the add-device wizard is open and the new Engine sends its first heartbeat
- **THEN** the wizard receives the status change and shows the device as connected with its reported hardware

### Requirement: Engine token rotation
A recently re-authenticated session SHALL be able to rotate a console-origin Engine's token. The rotation MUST return the new token once, MUST make the previous token stop authenticating immediately, and MUST NOT interrupt a session that is already live.

#### Scenario: Rotate a leaked token
- **WHEN** the owner rotates `pi-02`'s token
- **THEN** heartbeats with the old token receive 401 and heartbeats with the new token are accepted

### Requirement: Engine removal
A recently re-authenticated session SHALL be able to remove a console-origin Engine. Removal MUST close any live or wanted session for it with reason `agent_requested` and revoke its grants. After removal, its token MUST be rejected and its id MUST disappear from MCP device lists. Its historical audit records MUST be retained.

#### Scenario: Remove a device during a session
- **WHEN** the owner removes an Engine with a ready session
- **THEN** the session closes, later requests for that engineId return 404, and earlier activity records still show the Engine id

### Requirement: Device type override
The owner SHALL be able to set or clear a device-type override (kind and model) for any registered Engine. Wherever the console displays the device, the override MUST take precedence over the Engine-reported hardware descriptor.

#### Scenario: Correct a misdetected device
- **WHEN** an Engine reports kind `server` and the owner sets the override to kind `nas`, model `4-bay NAS`
- **THEN** the console shows the NAS glyph and model, and clearing the override restores the reported values
