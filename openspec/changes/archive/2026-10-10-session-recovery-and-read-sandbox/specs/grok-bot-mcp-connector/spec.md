## ADDED Requirements

### Requirement: Ready wait outlasts idle Engine heartbeat
The connector SHALL wait for Gateway session readiness long enough to cover one idle Engine heartbeat interval plus connection setup. The default ready timeout MUST be at least 150 seconds and MUST remain overridable. While Gateway status is `wanted`, `pending`, or `connecting`, the connector MUST keep polling rather than treating those statuses as a failed pick. If readiness is not reached before the timeout, the connector MUST best-effort `POST /session/close` and MUST fail the selection, leaving filesystem tools unavailable.

#### Scenario: Pick while the Engine is still in its idle heartbeat sleep
- **WHEN** a client calls `pick_device` after the Engine's last idle heartbeat and before the Engine posts again
- **THEN** the connector continues polling Gateway status through `wanted` or `pending` until the session becomes `ready` or the ready timeout elapses, and on timeout it best-effort closes the session

#### Scenario: Ready timeout closes an abandoned wanted session
- **WHEN** `pick_device` reaches its ready timeout without Gateway status `ready`
- **THEN** the connector posts `/session/close` (ignoring close failures) and reports the pick as failed

### Requirement: Same-id pick confirms a live ready session
When `pick_device` names the already-selected device, the connector MUST confirm that device's Gateway session is `ready` before treating the pick as a no-op. If the session is missing, not ready, or closed, the connector MUST close any stale binding and open a new session, waiting for readiness as on the first pick.

#### Scenario: Re-pick a still-ready device
- **WHEN** a client calls `pick_device` with the selected device identifier and that Gateway still reports `ready`
- **THEN** the connector does not open a second session and reports successful selection

#### Scenario: Re-pick after Gateway teardown
- **WHEN** a client calls `pick_device` with the selected device identifier after that Gateway session has ended
- **THEN** the connector opens a new session, waits until it is ready, and binds that device

### Requirement: Dead-session filesystem calls reopen once
After a device has been selected, a read invocation receiving `no live session`, `no ready session`, `session closed`, or `session rpc timeout` MUST best-effort close, reopen on the same device, wait until ready, and retry once. Mutations MUST retry only when the dead-session failure occurred before RPC dispatch or the Gateway explicitly rejected the invocation for no live/ready session. A dispatched mutation with an uncertain outcome MUST return a tool error containing `RESULT_UNKNOWN` and `mayHaveCommitted: true` without replay; this includes RPC timeout, session closure, and transport failures. A second failure MUST be returned as a tool error. Other errors MUST NOT trigger a reopen.

#### Scenario: Read after the live session has died
- **WHEN** a client invokes `fs.read` on the selected device after the Gateway reports no live or ready session
- **THEN** the connector reopens that device's session and retries the read once

#### Scenario: Mutation commits but the reply is lost
- **WHEN** a dispatched `fs.write` or `fs.edit` fails with a timeout, session closure, or transport exception
- **THEN** the connector reports `RESULT_UNKNOWN` with `mayHaveCommitted: true` and does not issue a second mutation or grant

#### Scenario: Old session is still closing
- **WHEN** readiness polling reports `closing` before the old session becomes `none`
- **THEN** the connector waits for `none` before reopening, and an open rejected with `session already active` does not consume the successful reopen allowance
