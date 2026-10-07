## ADDED Requirements

### Requirement: Execute and process-control authorization
The Tool registry SHALL distinguish Execute and ProcessControl from existing Read and Write access. Dispatcher MUST require an appropriate Gateway-forwarded process claim for process.run and process.stop and supply structured authorization through InvocationContext. A filesystem write claim MUST NOT imply execution or process-control authority. Process handlers MUST also enforce local workspace policy and session ownership. Read-class process observation MUST remain owner-scoped.

#### Scenario: Filesystem grant is presented to run
- **WHEN** a process.run invocation presents only a filesystem write authorization
- **THEN** it is rejected before spawn

#### Scenario: Local execution policy denies granted run
- **WHEN** a valid execution claim targets a locally disabled workspace
- **THEN** the handler rejects it without spawning

### Requirement: Short process tools and background execution
Process tools SHALL use a session-owned ProcessManager through InvocationContext. Serial Tool dispatch MUST remain responsive because handlers MUST NOT wait for script completion or block on unbounded output/termination. Process execution deadlines MUST be enforced independently from request deadlines. Once a successful spawn is registered, dispatch MUST preserve successful launch identity/result under the same commit-boundary rule as filesystem mutations.

#### Scenario: Request deadline after successful spawn
- **WHEN** spawn has succeeded and been registered before its run response encounters a deadline
- **THEN** Engine preserves the successful launch result and subsequent lookup resolves the same task
