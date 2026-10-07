# engine-tool-dispatch Specification

## Purpose

Defines typed serial Tool execution with authorization, request identity, shared deadlines, and responsive session control.

## Requirements

### Requirement: Transport-independent session dispatch pipeline
The Engine SHALL route every data-plane request through one SessionDispatcher after transport decoding. The Dispatcher MUST validate the protocol envelope, bind the request to the active session id, reject duplicate request ids, apply the request deadline and cancellation policy, authorize the canonical method, and serialize execution before emitting a response or error.

#### Scenario: Duplicate request is not executed twice
- **WHEN** the active session receives the same request id more than once
- **THEN** the Dispatcher returns an error without invoking a Tool a second time

### Requirement: Registered typed Tool handlers
The Engine SHALL execute supported RPC methods through a Tool registry keyed by canonical method name. Each Tool MUST define its method name, typed parameter validation, access class, execution policy, and result/error mapping. Adding a Tool MUST NOT require modification to Runtime state handling or transport adapters.

#### Scenario: Filesystem read resolves to its Tool handler
- **WHEN** the Dispatcher receives an authorized valid request with method `fs.read`
- **THEN** it invokes the registered `fs.read` Tool and returns that Tool's result

### Requirement: Serial initial execution policy
The Dispatcher SHALL execute requests serially within one active session. A timed-out, cancelled, or draining session MUST reject queued requests that have not started. Tools MAY later declare read-only concurrency only through an explicit execution-policy extension.

#### Scenario: Session drains with queued work
- **WHEN** the Engine enters `Draining` while one request executes and another is queued
- **THEN** it accepts no new request, cancels or bounds the executing request, and returns a deterministic session-closing error for the queued request

### Requirement: Gateway session authorization middleware
The Dispatcher SHALL authorize a Tool before invoking it. Write-class Tools MUST require a permission claim on the active trusted Gateway session; read-class Tools MUST NOT be granted mutation authority merely because they share a session. Tool implementations MUST receive authorization through their invocation context rather than independently trusting a caller-provided identifier. Workspace containment MUST still be enforced after authorization.

#### Scenario: New mutation Tool cannot skip authorization
- **WHEN** a registered Tool declares write-class access and receives a request without a valid Gateway-forwarded permission claim
- **THEN** the Dispatcher returns `PERMISSION_DENIED` without invoking the Tool

### Requirement: Single-level tool.call compatibility adapter
The Dispatcher SHALL canonicalize one `tool.call` wrapper with `{ name, arguments }` to a direct method before authorization and Tool lookup. It MUST reject a nested, malformed, empty, or depth-exhausted wrapper as `INVALID_PARAMS`. A business Tool MUST NOT receive `tool.call` as its method.

#### Scenario: Nested compatibility call is rejected before dispatch
- **WHEN** a request uses `tool.call` whose name is another `tool.call`
- **THEN** the Engine returns `INVALID_PARAMS` and does not invoke a Tool

### Requirement: Shared deadline and responsive control lane
The Engine MUST honor an optional Gateway-stamped absolute `deadlineAt`, including time spent queued. It MUST convert the remaining budget to a monotonic deadline and cap it by Runtime and Tool policy without restarting the budget after authorization. One serial Tool worker MAY execute while the Runtime receives session controls and a bounded queue of at most 16 deferred requests. An individual caller or Tool deadline MUST return `DEADLINE_EXCEEDED` without closing an otherwise healthy session or discarding other requests. Close, lease expiry, rotation, and the Runtime's hard RPC execution bound MUST signal cooperative cancellation and discard deferred requests before session teardown. The Runtime MUST drain the worker before resuming heartbeat; a syscall or atomic mutation already past its commit boundary MAY finish. A successful write-class Tool result MUST NOT be changed to a cancellation or deadline error after commit, and the Runtime MUST attempt to send that result before finalizing transport closure.

#### Scenario: Expired queued mutation
- **WHEN** a forwarded write reaches dispatch after its absolute deadline
- **THEN** no Tool runs, the Engine returns `DEADLINE_EXCEEDED`, and later valid queued requests remain dispatchable

#### Scenario: Close while a Tool is running
- **WHEN** a session close arrives while a cooperative Tool executes and another request is queued
- **THEN** the Runtime signals cancellation, drains the running worker, and does not execute the queued request

#### Scenario: Mutation finishes after crossing its commit boundary
- **WHEN** a write-class Tool reports success while session cancellation or its request deadline has elapsed
- **THEN** dispatch preserves its successful result and revision, while any requested session teardown still completes

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
