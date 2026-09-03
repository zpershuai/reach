# engine-tool-dispatch Specification

## Purpose

TBD: Define the Engine tool dispatch contract. Update Purpose after archive.

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
