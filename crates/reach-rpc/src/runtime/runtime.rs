//! The single-Gateway Engine Runtime (tasks 3.3, 3.4, 3.6).
//!
//! `EngineRuntime` owns one `GatewayConfig`, one transport factory, one
//! `WorkspaceFilesystem`, and the outer lifecycle loop. Its states are
//! `Boot`, `Heartbeating`, `Waiting`, `Connecting`, `ActiveSession`, `Draining`,
//! `Backoff`, and `Shutdown`. There is no nested control flow: each `step()`
//! performs exactly one state action, and `run()` paces steps by the interval
//! each state requests.

use std::{
    cell::RefCell,
    collections::VecDeque,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::execution::ExecutionControl;
use serde_json::{json, Value};

use crate::{
    dispatch::{SessionDispatcher, ToolRegistry},
    parse_request_envelope,
    runtime::{
        config::EngineConfig,
        endpoint::resolve_session_endpoint,
        session::SessionContext,
        state::{RuntimeEvent, RuntimeState, SessionClosureReason},
        transports::{
            rfc3339_to_epoch_millis, HeartbeatOutcome, HeartbeatTransport, Lease, SessionIncoming,
            SessionTransport, SessionTransportFactory,
        },
    },
    serialize_session_message, session_closed, session_ready, SessionMessage, WorkspaceFilesystem,
    INVALID_PARAMS,
};

/// How long the Runtime polls a non-blocking session socket between checks.
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Maximum backoff between failed heartbeat/session attempts.
const MAX_BACKOFF_SECS: u64 = 60;
const MAX_RUNTIME_EVENTS: usize = 1024;
/// Shared with Gateway WebSocket policy and fixtures/rpc-limits.json.
pub const MAX_SERIALIZED_RESPONSE_BYTES: usize = 1024 * 1024;

struct ResponseBuffer(Vec<u8>);

impl std::io::Write for ResponseBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_SERIALIZED_RESPONSE_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("response exceeds message budget"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize_response(request_id: &str, result: Value) -> Option<String> {
    let response = json!({ "type": "response", "requestId": request_id, "result": result });
    let mut buffer = ResponseBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, &response).ok()?;
    String::from_utf8(buffer.0).ok()
}

#[derive(Default)]
struct EventBuffer(VecDeque<RuntimeEvent>);

impl EventBuffer {
    fn push(&mut self, event: RuntimeEvent) {
        if self.0.len() == MAX_RUNTIME_EVENTS {
            self.0.pop_front();
        }
        self.0.push_back(event);
    }

    fn drain(&mut self) -> Vec<RuntimeEvent> {
        self.0.drain(..).collect()
    }
}

/// Wall-clock source for the Runtime; injectable for deterministic tests.
pub trait Clock: Send {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// A test clock shared with fake transports so they can advance time.
#[derive(Clone)]
pub struct SharedClock {
    now: Arc<std::sync::Mutex<i64>>,
}

impl SharedClock {
    pub fn new(start_ms: i64) -> SharedClock {
        SharedClock {
            now: Arc::new(std::sync::Mutex::new(start_ms)),
        }
    }
    pub fn advance(&self, ms: i64) {
        *self.now.lock().unwrap() += ms;
    }
}

impl Clock for SharedClock {
    fn now_ms(&self) -> i64 {
        *self.now.lock().unwrap()
    }
}

/// Result of one `step()` invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    /// Perform the next step immediately.
    Continue,
    /// Wait the given duration before the next step.
    Wait(Duration),
    /// The Runtime reached `Shutdown`.
    Shutdown,
}

/// Local control flow returned from a single session message.
enum Flow {
    Continue,
    Close(SessionClosureReason),
}

pub struct EngineRuntime {
    config: EngineConfig,
    heartbeat: Box<dyn HeartbeatTransport>,
    session_factory: Box<dyn SessionTransportFactory>,
    registry: ToolRegistry,
    workspace: WorkspaceFilesystem,
    clock: Box<dyn Clock>,
    events: RefCell<EventBuffer>,
    sleep: Box<dyn Fn(Duration)>,
    state: RuntimeState,
    pending: Option<(String, Lease)>,
    session_closure: Option<(String, SessionClosureReason)>,
    backoff_secs: u64,
    process_cleanup: Option<crate::process::ProcessManager>,
    cleanup_transport: Option<Box<dyn SessionTransport>>,
    updater: Option<Box<dyn super::update::RuntimeUpdater>>,
    next_heartbeat_ms: i64,
}

impl EngineRuntime {
    pub fn new(
        config: EngineConfig,
        workspace: WorkspaceFilesystem,
        registry: ToolRegistry,
        heartbeat: Box<dyn HeartbeatTransport>,
        session_factory: Box<dyn SessionTransportFactory>,
        clock: Box<dyn Clock>,
        sleep: Box<dyn Fn(Duration)>,
    ) -> EngineRuntime {
        EngineRuntime {
            config,
            heartbeat,
            session_factory,
            registry,
            workspace,
            clock,
            events: RefCell::new(EventBuffer::default()),
            sleep,
            state: RuntimeState::Boot,
            pending: None,
            session_closure: None,
            backoff_secs: 1,
            process_cleanup: None,
            cleanup_transport: None,
            updater: None,
            next_heartbeat_ms: 0,
        }
    }

    pub fn set_updater(&mut self, updater: Box<dyn super::update::RuntimeUpdater>) {
        self.updater = Some(updater);
    }

    fn poll_update(&mut self) -> bool {
        if !matches!(
            self.state,
            RuntimeState::Heartbeating | RuntimeState::Waiting | RuntimeState::Backoff
        ) {
            return false;
        }
        let idle = self.pending.is_none() && self.process_cleanup.is_none();
        let result = self
            .updater
            .as_mut()
            .map(|updater| updater.tick(self.clock.now_ms(), idle));
        match result {
            Some(Ok(true)) => {
                self.transition(RuntimeState::Shutdown);
                true
            }
            Some(Err(error)) => {
                self.emit(RuntimeEvent::Message {
                    line: format!("Reach update failed: {error}"),
                });
                false
            }
            _ => false,
        }
    }

    fn idle_wait(&self, duration: Duration) -> StepOutcome {
        StepOutcome::Wait(if self.updater.is_some() {
            duration.min(Duration::from_millis(100))
        } else {
            duration
        })
    }

    pub fn state(&self) -> RuntimeState {
        self.state
    }

    pub fn drain_events(&self) -> Vec<RuntimeEvent> {
        self.events.borrow_mut().drain()
    }

    fn emit(&self, event: RuntimeEvent) {
        self.events.borrow_mut().push(event);
    }

    fn transition(&mut self, to: RuntimeState) {
        if self.state == to {
            return;
        }
        self.emit(RuntimeEvent::StateChanged {
            from: self.state,
            to,
        });
        self.state = to;
    }

    /// Drive the Runtime until shutdown or the process is interrupted. `run`
    /// is the production entry point; tests drive `step()` for determinism.
    pub fn run(&mut self) -> Result<(), String> {
        loop {
            match self.step()? {
                StepOutcome::Continue => {}
                StepOutcome::Wait(duration) => (self.sleep)(duration),
                StepOutcome::Shutdown => {
                    self.flush_messages();
                    return Ok(());
                }
            }
            self.flush_messages();
        }
    }

    /// Drain `Message` lifecycle events to stdout (local-loopback observability).
    fn flush_messages(&mut self) {
        for event in self.drain_events() {
            match event {
                RuntimeEvent::Message { line } => println!("{line}"),
                event => println!(
                    "{}",
                    serde_json::to_string(&event).expect("runtime event serializes")
                ),
            }
        }
    }

    /// Perform one state action. Non-blocking except when `ActiveSession` is
    /// entered: driving a live session reads from its transport until it ends.
    pub fn step(&mut self) -> Result<StepOutcome, String> {
        self.step_with_shutdown(crate::process::shutdown_requested())
    }

    fn step_with_shutdown(&mut self, shutdown: bool) -> Result<StepOutcome, String> {
        if shutdown
            && !matches!(
                self.state,
                RuntimeState::ActiveSession | RuntimeState::Draining
            )
        {
            self.transition(RuntimeState::Shutdown);
        }
        if self.poll_update() {
            return Ok(StepOutcome::Shutdown);
        }
        if self.state == RuntimeState::Heartbeating
            && self
                .updater
                .as_ref()
                .is_some_and(|updater| updater.admission_paused(self.clock.now_ms()))
        {
            return Ok(self.idle_wait(Duration::from_millis(100)));
        }
        if self.updater.is_some()
            && self.state == RuntimeState::Heartbeating
            && self.clock.now_ms() < self.next_heartbeat_ms
        {
            return Ok(self.idle_wait(Duration::from_millis(
                (self.next_heartbeat_ms - self.clock.now_ms()) as u64,
            )));
        }
        match self.state {
            RuntimeState::Boot => {
                self.transition(RuntimeState::Heartbeating);
            }
            RuntimeState::Heartbeating => match self.heartbeat.heartbeat() {
                Ok(HeartbeatOutcome::Idle { interval }) => {
                    self.emit(RuntimeEvent::Heartbeat {
                        leased: false,
                        ok: true,
                        error: None,
                    });
                    self.next_heartbeat_ms = self
                        .clock
                        .now_ms()
                        .saturating_add(interval.as_millis() as i64);
                    return Ok(self.idle_wait(interval));
                }
                Ok(HeartbeatOutcome::Lease(lease)) => {
                    self.emit(RuntimeEvent::Heartbeat {
                        leased: true,
                        ok: true,
                        error: None,
                    });
                    match resolve_session_endpoint(&self.config.gateway, &lease.endpoint) {
                        Ok(url) => {
                            self.pending = Some((url, lease));
                            self.transition(RuntimeState::Waiting);
                        }
                        Err(error) => {
                            // Endpoint pinning: reject the lease, do not open a
                            // connection, apply the heartbeat failure/backoff policy.
                            self.emit(RuntimeEvent::Message {
                                line: format!("Reach engine rejected session endpoint: {error}"),
                            });
                            self.transition(RuntimeState::Backoff);
                        }
                    }
                }
                Err(error) => {
                    self.emit(RuntimeEvent::Heartbeat {
                        leased: false,
                        ok: false,
                        error: Some(error.clone()),
                    });
                    self.emit(RuntimeEvent::Message {
                        line: format!("Reach engine heartbeat failed: {error}"),
                    });
                    self.transition(RuntimeState::Backoff);
                }
            },
            RuntimeState::Waiting => {
                self.transition(RuntimeState::Connecting);
            }
            RuntimeState::Connecting => {
                let Some((url, lease)) = self.pending.take() else {
                    self.transition(RuntimeState::Backoff);
                    return Ok(StepOutcome::Continue);
                };
                match self.session_factory.connect(
                    &url,
                    &lease.token,
                    self.config.timeouts.connection_timeout,
                ) {
                    Ok(mut transport) => {
                        self.transition(RuntimeState::ActiveSession);
                        let reason = self.run_session(&mut transport, &lease);
                        if self.process_cleanup.is_some() {
                            self.cleanup_transport = Some(transport);
                        } else {
                            finalize_session(&mut transport, &lease.session_id, reason);
                        }
                        self.session_closure = Some((lease.session_id.clone(), reason));
                        self.transition(RuntimeState::Draining);
                    }
                    Err(error) => {
                        self.emit(RuntimeEvent::Message {
                            line: format!("Reach engine session connect failed: {error}"),
                        });
                        self.transition(RuntimeState::Backoff);
                    }
                }
            }
            RuntimeState::ActiveSession => {
                // A live session is driven inline from `Connecting`; reaching
                // this arm means no transport is bound — force a cleanup.
                self.session_closure =
                    Some(("<unbound>".into(), SessionClosureReason::PolicyError));
                self.transition(RuntimeState::Draining);
            }
            RuntimeState::Draining => {
                if let Some(cleanup) = &mut self.process_cleanup {
                    if cleanup.drain().is_err() {
                        return Ok(self.cleanup_failed(shutdown));
                    }
                }
                self.process_cleanup = None;
                if let Some(mut transport) = self.cleanup_transport.take() {
                    if let Some((id, reason)) = &self.session_closure {
                        finalize_session(&mut transport, id, *reason);
                    }
                }
                let (session_id, reason) = self
                    .session_closure
                    .take()
                    .unwrap_or(("<unbound>".into(), SessionClosureReason::PolicyError));
                self.emit(RuntimeEvent::SessionClosed { session_id, reason });
                if reason == SessionClosureReason::Shutdown {
                    self.transition(RuntimeState::Shutdown);
                } else if reason.is_error() {
                    self.transition(RuntimeState::Backoff);
                } else {
                    self.backoff_secs = 1;
                    self.transition(RuntimeState::Heartbeating);
                }
            }
            RuntimeState::Backoff => {
                let delay = Duration::from_secs(self.backoff_secs);
                self.backoff_secs = self.backoff_secs.saturating_mul(2).min(MAX_BACKOFF_SECS);
                // Resume heartbeat after the delay has elapsed.
                self.transition(RuntimeState::Heartbeating);
                return Ok(StepOutcome::Wait(delay));
            }
            RuntimeState::Shutdown => return Ok(StepOutcome::Shutdown),
        }
        Ok(StepOutcome::Continue)
    }

    fn cleanup_failed(&mut self, shutdown: bool) -> StepOutcome {
        self.emit(RuntimeEvent::Message {
            line: "PROCESS_CLEANUP_FAILED: retaining session ownership".into(),
        });
        if shutdown {
            // Exit without a successful SessionClosed event or releasing the
            // session. Drop makes a final bounded cleanup attempt.
            self.transition(RuntimeState::Shutdown);
            StepOutcome::Shutdown
        } else {
            StepOutcome::Wait(Duration::from_secs(1))
        }
    }

    /// Drive one active session to completion and return its closure reason.
    /// Owns `SessionContext` (cancellation, request registry, cursor scope) for
    /// exactly the active session. `finalize_session` runs after the loop so
    /// every exit path clears cursor scope and closes the transport.
    fn run_session(
        &mut self,
        transport: &mut Box<dyn SessionTransport>,
        lease: &Lease,
    ) -> SessionClosureReason {
        let events = &self.events;
        let timeouts = self.config.timeouts;
        let engine_id = self.config.engine_id.clone();
        let mut workspaces: Vec<String> = self.config.workspace_roots.keys().cloned().collect();
        workspaces.sort();

        let mut context = SessionContext::new(
            lease.session_id.clone(),
            lease.lease_expires_at_ms.min(
                self.clock
                    .now_ms()
                    .saturating_add(timeouts.max_lease().as_millis() as i64),
            ),
            self.clock.now_ms(),
            &mut self.workspace,
        );
        context.processes = crate::process::ProcessManager::new(self.config.processes.clone());
        let mut dispatcher = SessionDispatcher::new(
            lease.session_id.clone(),
            self.registry.clone(),
            timeouts.rpc_deadline,
        );
        let methods = dispatcher.registry().methods();

        // Announce readiness before reading any data-plane request. The Gateway
        // gates forwarding on this message.
        let ready = session_ready(&lease.session_id, &engine_id, workspaces, methods);
        let ready_text = match serialize_session_message(&SessionMessage::Ready(ready)) {
            Ok(text) => text,
            Err(_) => return SessionClosureReason::Disconnected,
        };
        if transport.send(&ready_text).is_err() {
            return SessionClosureReason::Disconnected;
        }
        events.borrow_mut().push(RuntimeEvent::SessionReady {
            session_id: lease.session_id.clone(),
        });
        events.borrow_mut().push(RuntimeEvent::Message {
            line: format!("Reach engine session ready ({})", lease.session_id),
        });

        let mut last_activity_ms = self.clock.now_ms();
        let mut execution = ExecutionControl {
            queue: VecDeque::new(),
            clock: &*self.clock,
            timeouts,
            sleep: &*self.sleep,
            last_activity_ms,
        };
        let reason = 'drive: loop {
            if crate::process::shutdown_requested() {
                break 'drive SessionClosureReason::Shutdown;
            }
            let now_ms = self.clock.now_ms();
            // Lease expiry is enforced even if the socket remains open.
            if now_ms >= context.lease_expires_at_ms {
                events.borrow_mut().push(RuntimeEvent::LeaseExpired {
                    session_id: context.session_id.clone(),
                });
                break 'drive SessionClosureReason::LeaseExpired;
            }
            // Rotation: drain and reconnect a connection past its max age.
            if now_ms.saturating_sub(context.started_at_ms) >= timeouts.rotation.as_millis() as i64
            {
                break 'drive SessionClosureReason::Rotation;
            }
            if context.processes.active() {
                last_activity_ms = now_ms;
            }
            // Idle timeout: no valid RPC, renewal, or control activity.
            if now_ms.saturating_sub(last_activity_ms) >= timeouts.idle_timeout.as_millis() as i64 {
                break 'drive SessionClosureReason::IdleTimeout;
            }

            let incoming = match execution.queue.pop_front() {
                Some(text) => Ok(SessionIncoming::Text(text)),
                None => transport.recv(),
            };
            match incoming {
                Ok(SessionIncoming::Text(text)) => {
                    let now_ms = self.clock.now_ms();
                    last_activity_ms = now_ms;
                    match handle_session_message(
                        events,
                        &mut context,
                        &mut dispatcher,
                        transport,
                        &text,
                        now_ms,
                        timeouts.max_lease().as_millis() as i64,
                        &mut execution,
                    ) {
                        Ok(Flow::Continue) => {
                            last_activity_ms = last_activity_ms.max(execution.last_activity_ms)
                        }
                        Ok(Flow::Close(reason)) => break 'drive reason,
                        Err(error) => {
                            events.borrow_mut().push(RuntimeEvent::Message {
                                line: format!("Reach engine session protocol error: {error}"),
                            });
                            break 'drive SessionClosureReason::PolicyError;
                        }
                    }
                }
                Ok(SessionIncoming::Ping(payload)) => {
                    last_activity_ms = now_ms;
                    if transport.send_pong(&payload).is_err() {
                        break 'drive SessionClosureReason::Disconnected;
                    }
                }
                Ok(SessionIncoming::Close { .. }) => {
                    if context.is_cancelled() {
                        break 'drive SessionClosureReason::AgentRequested;
                    }
                    break 'drive SessionClosureReason::Disconnected;
                }
                Ok(SessionIncoming::WouldBlock) => {
                    // Sleep until the soonest deadline (or the poll cap) so
                    // lease/idle/rotation enforcement is not lagged behind the
                    // peer and wins races against Gateway timers deterministically.
                    let now = self.clock.now_ms();
                    let until_deadline = [
                        context.lease_expires_at_ms.saturating_sub(now),
                        (context.started_at_ms + timeouts.rotation.as_millis() as i64)
                            .saturating_sub(now),
                        (last_activity_ms + timeouts.idle_timeout.as_millis() as i64)
                            .saturating_sub(now),
                    ]
                    .into_iter()
                    .filter(|value| *value > 0)
                    .min()
                    .unwrap_or(POLL_INTERVAL.as_millis() as i64);
                    let wait = until_deadline.min(POLL_INTERVAL.as_millis() as i64);
                    (self.sleep)(Duration::from_millis(wait as u64));
                }
                Err(error) => {
                    events.borrow_mut().push(RuntimeEvent::Message {
                        line: format!("Reach engine session read failed: {error}"),
                    });
                    break 'drive SessionClosureReason::Disconnected;
                }
            }
        };
        // `context` is dropped here (closes the cursor scope) before the
        // transport is finalized.
        let mut processes = context.take_processes();
        if let Err(error) = processes.drain() {
            events.borrow_mut().push(RuntimeEvent::Message {
                line: format!(
                    "Reach process cleanup failed: {}; retaining owner session",
                    error.code
                ),
            });
            self.process_cleanup = Some(processes);
        }
        drop(context);
        reason
    }
}

/// Handle one engine-side session message: control messages (`session.renew`,
/// `session.close`) and data-plane `request` envelopes. Returns `Close` when
/// the session should end (draining has been requested).
fn handle_session_message(
    events: &RefCell<EventBuffer>,
    context: &mut SessionContext<'_>,
    dispatcher: &mut SessionDispatcher,
    transport: &mut Box<dyn SessionTransport>,
    text: &str,
    now_ms: i64,
    max_lease_ms: i64,
    execution: &mut ExecutionControl<'_>,
) -> Result<Flow, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| INVALID_PARAMS.to_owned())?;
    let Some(message_type) = value.get("type").and_then(Value::as_str) else {
        return Ok(Flow::Continue);
    };

    match message_type {
        // Never answer an error frame, even when its other fields are invalid.
        "error" => Ok(Flow::Continue),
        "request" => {
            let envelope = match parse_request_envelope(text) {
                Ok(envelope) => envelope,
                Err(_) => {
                    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
                    send_error(transport, request_id, INVALID_PARAMS)?;
                    return Ok(Flow::Continue);
                }
            };
            // Legacy short-job completion: translate to an Agent-requested close.
            if envelope.method == "session.complete" {
                send_response(transport, &envelope.request_id, json!({ "ok": true }))?;
                events.borrow_mut().push(RuntimeEvent::RpcDisposition {
                    request_id: envelope.request_id.clone(),
                    method: envelope.method.clone(),
                    ok: true,
                });
                context.cancel();
                return Ok(Flow::Close(SessionClosureReason::SessionComplete));
            }
            if context.is_cancelled() {
                send_error(
                    transport,
                    &envelope.request_id,
                    crate::dispatch::SESSION_CLOSED,
                )?;
                return Ok(Flow::Continue);
            }
            let outcome = execution.dispatch(context, dispatcher, &envelope, transport);
            let result = match (outcome.result, outcome.closure) {
                // A committed mutation can succeed while the session drains.
                (Ok(result), _) => Ok(result),
                (Err(_), Some(SessionClosureReason::RpcTimeout)) => {
                    Err(crate::dispatch::DEADLINE_EXCEEDED.to_owned())
                }
                (Err(_), Some(_)) => Err(crate::dispatch::SESSION_CLOSED.to_owned()),
                (Err(code), None) => Err(code),
            };
            match result {
                Ok(result) => {
                    let sent = send_response(transport, &envelope.request_id, result);
                    if outcome.closure.is_none() {
                        sent?;
                    }
                    events.borrow_mut().push(RuntimeEvent::RpcDisposition {
                        request_id: envelope.request_id.clone(),
                        method: envelope.method.clone(),
                        ok: true,
                    });
                    events.borrow_mut().push(RuntimeEvent::ToolExecuted {
                        method: envelope.method.clone(),
                        ok: true,
                    });
                }
                Err(code) => {
                    let sent = send_error(transport, &envelope.request_id, &code);
                    if outcome.closure.is_none() {
                        sent?;
                    }
                    events.borrow_mut().push(RuntimeEvent::RpcDisposition {
                        request_id: envelope.request_id.clone(),
                        method: envelope.method.clone(),
                        ok: false,
                    });
                    if code == crate::PERMISSION_DENIED {
                        events.borrow_mut().push(RuntimeEvent::AuthorizationDenied {
                            method: envelope.method.clone(),
                        });
                    }
                }
            }
            Ok(outcome.closure.map(Flow::Close).unwrap_or(Flow::Continue))
        }
        "session.renew" => {
            let renew = match crate::parse_session_renew(text) {
                Ok(renew) if renew.session_id == context.session_id => renew,
                _ => {
                    send_error(transport, "", INVALID_PARAMS)?;
                    return Ok(Flow::Continue);
                }
            };
            match rfc3339_to_epoch_millis(&renew.lease_expires_at) {
                Ok(expiry) => {
                    // Bounded renewal: never accept beyond the Engine's hard max.
                    let capped = expiry.min(now_ms.saturating_add(max_lease_ms));
                    if capped <= now_ms {
                        return Ok(Flow::Close(SessionClosureReason::LeaseExpired));
                    }
                    context.lease_expires_at_ms = capped;
                    Ok(Flow::Continue)
                }
                Err(_) => {
                    send_error(transport, "", INVALID_PARAMS)?;
                    Ok(Flow::Continue)
                }
            }
        }
        "session.close" => {
            match crate::parse_session_close(text) {
                Ok(close) if close.session_id == context.session_id => {
                    // Drain: stop new dispatch; `finalize_session` emits
                    // `session.closed` after the loop returns.
                    context.cancel();
                    Ok(Flow::Close(SessionClosureReason::AgentRequested))
                }
                _ => {
                    send_error(transport, "", INVALID_PARAMS)?;
                    Ok(Flow::Continue)
                }
            }
        }
        // Engine-originated messages a Gateway never sends upstream.
        "session.ready" | "session.closed" | "job.done" => Ok(Flow::Continue),
        _ => {
            send_error(transport, "", INVALID_PARAMS)?;
            Ok(Flow::Continue)
        }
    }
}

fn send_response(
    transport: &mut Box<dyn SessionTransport>,
    request_id: &str,
    result: Value,
) -> Result<(), String> {
    match serialize_response(request_id, result) {
        Some(text) => transport.send(&text),
        None => send_error(transport, request_id, "RESPONSE_TOO_LARGE"),
    }
}

fn send_error(
    transport: &mut Box<dyn SessionTransport>,
    request_id: &str,
    code: &str,
) -> Result<(), String> {
    transport.send(
        &json!({ "type": "error", "requestId": request_id, "error": { "code": code } }).to_string(),
    )
}

/// Finalize a session on the transport: emit `session.closed` (except when the
/// socket is already gone) and close it with the reason code.
pub fn finalize_session(
    transport: &mut Box<dyn SessionTransport>,
    session_id: &str,
    reason: SessionClosureReason,
) {
    if !matches!(
        reason,
        SessionClosureReason::Disconnected | SessionClosureReason::Shutdown
    ) {
        if let Ok(text) = serialize_session_message(&SessionMessage::Closed(session_closed(
            session_id,
            reason.code(),
        ))) {
            let _ = transport.send(&text);
        }
    }
    let code = if reason.is_error() { 1011 } else { 1000 };
    let _ = transport.close(code, reason.code());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_budget_counts_envelope_utf8_and_json_escaping() {
        let limits: Value =
            serde_json::from_str(include_str!("../../../../fixtures/rpc-limits.json")).unwrap();
        assert_eq!(
            limits["maxSerializedResponseBytes"].as_u64().unwrap() as usize,
            MAX_SERIALIZED_RESPONSE_BYTES
        );
        let id = "id\"\\猫";
        let overhead = serialize_response(id, json!({"content": ""}))
            .unwrap()
            .len();
        let remaining = MAX_SERIALIZED_RESPONSE_BYTES - overhead;
        let exact = serialize_response(id, json!({"content": "a".repeat(remaining)})).unwrap();
        assert_eq!(exact.len(), MAX_SERIALIZED_RESPONSE_BYTES);
        assert!(serialize_response(id, json!({"content": "a".repeat(remaining + 1)})).is_none());
        assert!(
            serialize_response(id, json!({"content": "猫".repeat(remaining / 3 + 1)})).is_none()
        );
        assert!(
            serialize_response(id, json!({"content": "\u{1}".repeat(remaining / 6 + 1)})).is_none()
        );
    }
    use crate::{
        dispatch::tool::test_support::default_test_registry,
        dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError, ToolRegistry},
        runtime::config::{EngineConfig, GatewayConfig, TimeoutPolicy},
    };
    use std::{
        collections::HashMap,
        sync::{Arc, Barrier, Mutex},
        time::Duration,
    };

    /// Release the Tool either before the first control or after queuing RPCs.
    struct BarrierTransport {
        inbox: VecDeque<String>,
        release: Option<Arc<Barrier>>,
        release_after_messages: bool,
        sent: Arc<Mutex<Vec<Value>>>,
    }

    impl SessionTransport for BarrierTransport {
        fn recv(&mut self) -> Result<SessionIncoming, String> {
            if !self.release_after_messages || self.inbox.is_empty() {
                if let Some(barrier) = self.release.take() {
                    barrier.wait();
                }
            }
            Ok(self
                .inbox
                .pop_front()
                .map(SessionIncoming::Text)
                .unwrap_or(SessionIncoming::WouldBlock))
        }
        fn send(&mut self, text: &str) -> Result<(), String> {
            self.sent
                .lock()
                .unwrap()
                .push(serde_json::from_str(text).unwrap());
            Ok(())
        }
        fn send_pong(&mut self, _: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn close(&mut self, _: u16, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn request_text(id: &str, method: &str, params: Value) -> String {
        json!({"type": "request", "protocol": "reach-rpc", "version": "1.0", "sessionId": "session-1", "requestId": id, "method": method, "params": params, "permission": {"grantId": "g"}}).to_string()
    }

    #[test]
    fn gateway_errors_are_not_answered_idle_or_during_tool_execution() {
        struct WaitingRead(Arc<Barrier>, ToolDescriptor);
        impl Tool for WaitingRead {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.1
            }
            fn execute(&self, _: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                self.0.wait();
                Ok(json!({"ok": true}))
            }
        }
        let errors = [
            json!({"type": "error"}),
            json!({"type": "error", "error": {"code": "INVALID_PARAMS"}}),
            json!({"type": "error", "requestId": "", "error": {"code": "INVALID_PARAMS"}}),
            json!({"type": "error", "requestId": 1, "error": null}),
            json!({"type": "error", "requestId": "r", "error": {"code": "INVALID_PARAMS"}}),
        ]
        .map(|value| value.to_string());
        let mut workspace = WorkspaceFilesystem::new(HashMap::new());
        let barrier = Arc::new(Barrier::new(2));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(WaitingRead(
            barrier.clone(),
            ToolDescriptor::read("fs.wait"),
        )));
        let mut dispatcher =
            SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
        let mut context = SessionContext::new("session-1".into(), 1_000_000, 2_000, &mut workspace);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut transport: Box<dyn SessionTransport> = Box::new(BarrierTransport {
            inbox: errors.clone().into(),
            release: Some(barrier),
            release_after_messages: true,
            sent: sent.clone(),
        });
        let clock = SharedClock::new(2_000);
        let mut execution = ExecutionControl {
            queue: VecDeque::new(),
            clock: &clock,
            timeouts: TimeoutPolicy::default(),
            sleep: &std::thread::sleep,
            last_activity_ms: 2_000,
        };
        let events = RefCell::new(EventBuffer::default());
        for error in errors {
            assert!(matches!(
                handle_session_message(
                    &events,
                    &mut context,
                    &mut dispatcher,
                    &mut transport,
                    &error,
                    2_000,
                    300_000,
                    &mut execution
                )
                .unwrap(),
                Flow::Continue
            ));
        }
        assert!(
            sent.lock().unwrap().is_empty(),
            "idle Engine answered an error frame"
        );
        let request = request_text("read", "fs.wait", json!({}));
        assert!(matches!(
            handle_session_message(
                &events,
                &mut context,
                &mut dispatcher,
                &mut transport,
                &request,
                2_000,
                300_000,
                &mut execution
            )
            .unwrap(),
            Flow::Continue
        ));
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "busy Engine answered an error frame");
        assert_eq!(sent[0]["type"], "response");
        assert!(!context.is_cancelled());
    }

    #[test]
    fn expired_queued_write_does_not_drop_the_next_request() {
        struct WaitingRead(Arc<Barrier>, ToolDescriptor);
        impl Tool for WaitingRead {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.1
            }
            fn execute(&self, _: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                self.0.wait();
                Ok(json!({"ok": true}))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = WorkspaceFilesystem::new(HashMap::from([(
            "fixture".into(),
            dir.path().to_path_buf(),
        )]));
        let barrier = Arc::new(Barrier::new(2));
        let mut registry = crate::tools::default_registry();
        registry.register(Arc::new(WaitingRead(
            barrier.clone(),
            ToolDescriptor::read("fs.wait"),
        )));
        let mut dispatcher =
            SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
        let mut context = SessionContext::new("session-1".into(), 1_000_000, 2_000, &mut workspace);
        let mut expired: Value = serde_json::from_str(&request_text("expired", "fs.write", json!({"workspace": "fixture", "path": "expired.txt", "content": "B", "mode": "create"}))).unwrap();
        expired["deadlineAt"] = json!("1970-01-01T00:00:01Z");
        let next = request_text(
            "next",
            "fs.write",
            json!({"workspace": "fixture", "path": "next.txt", "content": "C", "mode": "create"}),
        );
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut transport: Box<dyn SessionTransport> = Box::new(BarrierTransport {
            inbox: VecDeque::from([expired.to_string(), next]),
            release: Some(barrier),
            release_after_messages: true,
            sent: sent.clone(),
        });
        let clock = SharedClock::new(2_000);
        let mut execution = ExecutionControl {
            queue: VecDeque::new(),
            clock: &clock,
            timeouts: TimeoutPolicy::default(),
            sleep: &std::thread::sleep,
            last_activity_ms: 2_000,
        };
        let events = RefCell::new(EventBuffer::default());
        let first = request_text("first", "fs.wait", json!({}));
        assert!(matches!(
            handle_session_message(
                &events,
                &mut context,
                &mut dispatcher,
                &mut transport,
                &first,
                2_000,
                300_000,
                &mut execution
            )
            .unwrap(),
            Flow::Continue
        ));
        assert_eq!(execution.queue.len(), 2);
        while let Some(text) = execution.queue.pop_front() {
            assert!(matches!(
                handle_session_message(
                    &events,
                    &mut context,
                    &mut dispatcher,
                    &mut transport,
                    &text,
                    2_000,
                    300_000,
                    &mut execution
                )
                .unwrap(),
                Flow::Continue
            ));
        }
        let sent = sent.lock().unwrap();
        assert_eq!(sent[1]["error"]["code"], crate::dispatch::DEADLINE_EXCEEDED);
        assert_eq!(sent[2]["type"], "response");
        assert!(!context.is_cancelled());
        assert!(!dir.path().join("expired.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("next.txt")).unwrap(),
            "C"
        );
    }

    #[test]
    fn shorter_request_and_tool_deadlines_preserve_the_session() {
        struct SlowRead(ToolDescriptor);
        impl Tool for SlowRead {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.0
            }
            fn execute(&self, _: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                std::thread::sleep(Duration::from_millis(5));
                Ok(json!({"ok": true}))
            }
        }
        for tool_deadline in [None, Some(Duration::from_millis(1))] {
            let mut descriptor = ToolDescriptor::read("fs.slow");
            descriptor.default_deadline = tool_deadline;
            let mut registry = ToolRegistry::default();
            registry.register(Arc::new(SlowRead(descriptor)));
            let mut workspace = WorkspaceFilesystem::new(HashMap::new());
            let mut context = SessionContext::new("session-1".into(), 1_000_000, 0, &mut workspace);
            let mut dispatcher =
                SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
            let (factory, sent, _) = factory(vec![], None, 0);
            let mut transport = factory.connect("", "", Duration::ZERO).unwrap();
            let mut text: Value =
                serde_json::from_str(&request_text("short", "fs.slow", json!({}))).unwrap();
            if tool_deadline.is_none() {
                text["deadlineAt"] = json!("1970-01-01T00:00:00.001Z");
            }
            let clock = SharedClock::new(0);
            let mut execution = ExecutionControl {
                queue: VecDeque::new(),
                clock: &clock,
                timeouts: TimeoutPolicy::default(),
                sleep: &std::thread::sleep,
                last_activity_ms: 0,
            };
            let events = RefCell::new(EventBuffer::default());
            assert!(matches!(
                handle_session_message(
                    &events,
                    &mut context,
                    &mut dispatcher,
                    &mut transport,
                    &text.to_string(),
                    0,
                    300_000,
                    &mut execution
                )
                .unwrap(),
                Flow::Continue
            ));
            let reply: Value = serde_json::from_str(&sent.lock().unwrap()[0]).unwrap();
            assert_eq!(reply["error"]["code"], crate::dispatch::DEADLINE_EXCEEDED);
            assert!(!context.is_cancelled());
        }
    }

    #[test]
    fn committed_mutation_response_survives_session_close() {
        struct CommittingWrite(Arc<Barrier>, ToolDescriptor);
        impl Tool for CommittingWrite {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.1
            }
            fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                let result = context
                    .workspace
                    .write(&crate::FsWriteParams {
                        workspace: "fixture".into(),
                        path: "committed.txt".into(),
                        content: "committed".into(),
                        mode: crate::FsWriteMode::Create,
                        if_match: None,
                    })
                    .map_err(|error| ToolError::new(error.code))?;
                self.0.wait();
                while !context.cancelled() {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Ok(serde_json::to_value(result).unwrap())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = WorkspaceFilesystem::new(HashMap::from([(
            "fixture".into(),
            dir.path().to_path_buf(),
        )]));
        let barrier = Arc::new(Barrier::new(2));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(CommittingWrite(
            barrier.clone(),
            ToolDescriptor::write("fs.commit"),
        )));
        let mut dispatcher =
            SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
        let mut context = SessionContext::new("session-1".into(), 1_000_000, 0, &mut workspace);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut transport: Box<dyn SessionTransport> = Box::new(BarrierTransport {
            inbox: VecDeque::from([
                r#"{"type":"session.close","sessionId":"session-1","reason":"agent_requested"}"#
                    .into(),
            ]),
            release: Some(barrier),
            release_after_messages: false,
            sent: sent.clone(),
        });
        let clock = SharedClock::new(0);
        let mut execution = ExecutionControl {
            queue: VecDeque::new(),
            clock: &clock,
            timeouts: TimeoutPolicy::default(),
            sleep: &std::thread::sleep,
            last_activity_ms: 0,
        };
        let events = RefCell::new(EventBuffer::default());
        let flow = handle_session_message(
            &events,
            &mut context,
            &mut dispatcher,
            &mut transport,
            &request_text("commit", "fs.commit", json!({})),
            0,
            300_000,
            &mut execution,
        )
        .unwrap();
        assert!(matches!(
            flow,
            Flow::Close(SessionClosureReason::AgentRequested)
        ));
        let sent = sent.lock().unwrap();
        assert_eq!(sent[0]["type"], "response");
        assert_eq!(sent[0]["result"]["path"], "committed.txt");
        assert!(sent[0]["result"]["revision"].as_str().is_some());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("committed.txt")).unwrap(),
            "committed"
        );
    }

    /// A scripted heartbeat transport.
    struct FakeHeartbeat {
        outcomes: std::sync::Mutex<std::vec::Vec<Result<HeartbeatOutcome, String>>>,
    }

    impl FakeHeartbeat {
        fn new(outcomes: Vec<Result<HeartbeatOutcome, String>>) -> FakeHeartbeat {
            FakeHeartbeat {
                outcomes: std::sync::Mutex::new(outcomes),
            }
        }
    }

    impl HeartbeatTransport for FakeHeartbeat {
        fn heartbeat(&mut self) -> Result<HeartbeatOutcome, String> {
            let mut queue = self.outcomes.lock().unwrap();
            if queue.is_empty() {
                return Ok(HeartbeatOutcome::Idle {
                    interval: Duration::ZERO,
                });
            }
            queue.remove(0)
        }
    }

    /// A scripted session transport. When the inbox is empty it reports
    /// `WouldBlock` and (optionally) advances a shared clock so deadline-based
    /// closures can be triggered deterministically. The sender is stored to
    /// keep the channel open; otherwise an empty inbox reads as disconnected.
    struct FakeSession {
        inbox: std::sync::mpsc::Receiver<SessionIncoming>,
        _keep_alive: std::sync::mpsc::Sender<SessionIncoming>,
        clock: Option<SharedClock>,
        advance_on_empty_ms: i64,
        sent: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        closed: std::sync::Arc<std::sync::Mutex<Option<(u16, String)>>>,
    }

    impl SessionTransport for FakeSession {
        fn recv(&mut self) -> Result<SessionIncoming, String> {
            match self.inbox.try_recv() {
                Ok(message) => Ok(message),
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    if let (Some(clock), advance) = (self.clock.as_ref(), self.advance_on_empty_ms)
                    {
                        if advance > 0 {
                            clock.advance(advance);
                        }
                    }
                    Ok(SessionIncoming::WouldBlock)
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => Ok(SessionIncoming::Close {
                    code: None,
                    reason: String::new(),
                }),
            }
        }
        fn send(&mut self, text: &str) -> Result<(), String> {
            self.sent.lock().unwrap().push(text.to_owned());
            Ok(())
        }
        fn send_pong(&mut self, _payload: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn close(&mut self, code: u16, reason: &str) -> Result<(), String> {
            *self.closed.lock().unwrap() = Some((code, reason.to_owned()));
            Ok(())
        }
    }

    struct FakeFactory {
        messages: std::sync::Mutex<std::vec::Vec<SessionIncoming>>,
        clock: Option<SharedClock>,
        advance_on_empty_ms: i64,
        sent: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        closed: std::sync::Arc<std::sync::Mutex<Option<(u16, String)>>>,
        fail: bool,
    }

    impl SessionTransportFactory for FakeFactory {
        fn connect(
            &self,
            _url: &str,
            _token: &str,
            _connection_timeout: Duration,
        ) -> Result<Box<dyn SessionTransport>, String> {
            if self.fail {
                return Err("refused".into());
            }
            let (sender, receiver) = std::sync::mpsc::channel();
            for message in self.messages.lock().unwrap().drain(..) {
                sender.send(message).unwrap();
            }
            Ok(Box::new(FakeSession {
                inbox: receiver,
                _keep_alive: sender,
                clock: self.clock.clone(),
                advance_on_empty_ms: self.advance_on_empty_ms,
                sent: self.sent.clone(),
                closed: self.closed.clone(),
            }))
        }
    }

    fn factory(
        messages: Vec<SessionIncoming>,
        clock: Option<SharedClock>,
        advance_on_empty_ms: i64,
    ) -> (
        FakeFactory,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        std::sync::Arc<std::sync::Mutex<Option<(u16, String)>>>,
    ) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let closed = std::sync::Arc::new(std::sync::Mutex::new(None));
        (
            FakeFactory {
                messages: std::sync::Mutex::new(messages),
                clock,
                advance_on_empty_ms,
                sent: sent.clone(),
                closed: closed.clone(),
                fail: false,
            },
            sent,
            closed,
        )
    }

    fn lease_at(endpoint: &str, expiry_ms: i64) -> HeartbeatOutcome {
        HeartbeatOutcome::Lease(Lease {
            token: "token".into(),
            session_id: "session-1".into(),
            endpoint: endpoint.into(),
            lease_expires_at_ms: expiry_ms,
            interval: Duration::ZERO,
        })
    }

    fn test_config(_clock_now: i64, timeouts: TimeoutPolicy) -> EngineConfig {
        let mut roots = HashMap::new();
        roots.insert("default".to_owned(), std::path::PathBuf::from("/tmp"));
        EngineConfig {
            engine_id: "test-engine".into(),
            gateway: GatewayConfig::new("http://127.0.0.1:8787").unwrap(),
            timeouts,
            workspace_roots: roots,
            processes: Default::default(),
            update: None,
        }
    }

    fn runtime(
        config: EngineConfig,
        heartbeat: Box<dyn HeartbeatTransport>,
        factory: Box<dyn SessionTransportFactory>,
        clock: Box<dyn Clock>,
    ) -> EngineRuntime {
        EngineRuntime::new(
            config,
            WorkspaceFilesystem::new(HashMap::new()),
            default_test_registry(),
            heartbeat,
            factory,
            clock,
            Box::new(|_| {}),
        )
    }

    #[test]
    fn failed_cleanup_retries_until_shutdown_without_reporting_session_closed() {
        let (factory, _, _) = factory(vec![], None, 0);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(FakeHeartbeat::new(vec![])),
            Box::new(factory),
            Box::new(SharedClock::new(0)),
        );
        engine.state = RuntimeState::Draining;
        engine.session_closure = Some(("owner".into(), SessionClosureReason::Shutdown));
        assert!(matches!(engine.cleanup_failed(false), StepOutcome::Wait(_)));
        assert_eq!(engine.state, RuntimeState::Draining);
        assert!(matches!(engine.cleanup_failed(true), StepOutcome::Shutdown));
        assert_eq!(engine.state, RuntimeState::Shutdown);
        assert!(engine.session_closure.is_some());
        assert!(!engine
            .drain_events()
            .iter()
            .any(|event| matches!(event, RuntimeEvent::SessionClosed { .. })));
    }

    #[test]
    fn lifecycle_events_are_bounded_and_consumed() {
        let (factory, _, _) = factory(vec![], None, 0);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(FakeHeartbeat::new(vec![])),
            Box::new(factory),
            Box::new(SharedClock::new(0)),
        );
        for _ in 0..MAX_RUNTIME_EVENTS * 2 {
            engine.step().unwrap();
        }
        assert_eq!(engine.drain_events().len(), MAX_RUNTIME_EVENTS);
        assert!(engine.drain_events().is_empty());
        engine.step().unwrap();
        engine.flush_messages();
        assert!(engine.drain_events().is_empty());
    }

    #[test]
    fn initial_lease_obeys_engine_ceiling() {
        let clock = SharedClock::new(0);
        let timeouts = TimeoutPolicy {
            lease_duration: Duration::from_secs(1),
            ..TimeoutPolicy::default()
        };
        let (factory, _, closed) = factory(vec![], Some(clock.clone()), 2_000);
        let mut engine = runtime(
            test_config(0, timeouts),
            Box::new(FakeHeartbeat::new(vec![Ok(lease_at(
                "/session", 1_000_000,
            ))])),
            Box::new(factory),
            Box::new(clock),
        );
        for _ in 0..5 {
            engine.step().unwrap();
        }
        assert_eq!(closed.lock().unwrap().as_ref().unwrap().1, "lease_expired");
    }

    #[test]
    fn normal_open_close_returns_to_heartbeat() {
        let clock = SharedClock::new(0);
        let (factory, sent, _closed) = factory(
            vec![SessionIncoming::Text(
                r#"{"type":"session.close","sessionId":"session-1","reason":"agent_requested"}"#
                    .into(),
            )],
            Some(clock.clone()),
            0,
        );
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 5_000))]);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock),
        );

        for _ in 0..5 {
            assert!(engine.step().is_ok());
        }
        assert_eq!(engine.state(), RuntimeState::Heartbeating);
        let sent = sent.lock().unwrap();
        assert!(sent
            .iter()
            .any(|text| text.contains("\"type\":\"session.ready\"")));
        assert!(sent
            .iter()
            .any(|text| text.contains("\"type\":\"session.closed\"")
                && text.contains("agent_requested")));
        let events = engine.drain_events();
        assert!(events
            .iter()
            .any(|event| matches!(event, RuntimeEvent::SessionReady { .. })));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::SessionClosed {
                reason: SessionClosureReason::AgentRequested,
                ..
            }
        )));
    }

    #[test]
    fn disconnect_recovery_backs_off_then_heartbeats() {
        let clock = SharedClock::new(0);
        let (factory, _sent, _closed) = factory(
            vec![SessionIncoming::Close {
                code: None,
                reason: String::new(),
            }],
            None,
            0,
        );
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 5_000))]);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock),
        );

        for _ in 0..5 {
            assert!(engine.step().is_ok());
        }
        // Disconnect is an error close: Draining -> Backoff.
        let events = engine.drain_events();
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::StateChanged {
                to: RuntimeState::Backoff,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::SessionClosed {
                reason: SessionClosureReason::Disconnected,
                ..
            }
        )));
        // Backoff advances to heartbeating on its next step.
        engine.step().unwrap();
        assert_eq!(engine.state(), RuntimeState::Heartbeating);
    }

    #[test]
    fn endpoint_rejection_never_connects() {
        let clock = SharedClock::new(0);
        let attempts = std::sync::Arc::new(std::sync::Mutex::new(0));
        let (base, _sent, _closed) = factory(vec![], None, 0);
        let attempts_for_factory = attempts.clone();
        struct CountingFactory(FakeFactory, std::sync::Arc<std::sync::Mutex<i32>>);
        impl SessionTransportFactory for CountingFactory {
            fn connect(
                &self,
                url: &str,
                token: &str,
                timeout: Duration,
            ) -> Result<Box<dyn SessionTransport>, String> {
                *self.1.lock().unwrap() += 1;
                self.0.connect(url, token, timeout)
            }
        }
        let heartbeat =
            FakeHeartbeat::new(vec![Ok(lease_at("ws://evil.example:8787/session", 5_000))]);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(CountingFactory(base, attempts_for_factory)),
            Box::new(clock),
        );
        engine.step().unwrap(); // Boot -> Heartbeating
        engine.step().unwrap(); // Heartbeating rejects the lease -> Backoff
        assert_eq!(engine.state(), RuntimeState::Backoff);
        assert_eq!(*attempts.lock().unwrap(), 0);
    }

    #[test]
    fn lease_expiry_closes_even_with_open_socket() {
        let clock = SharedClock::new(0);
        let (factory, _sent, _closed) = factory(vec![], Some(clock.clone()), 0);
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 1_000))]);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock.clone()),
        );
        clock.advance(2_000); // Expire the lease before the session loop runs.

        for _ in 0..5 {
            assert!(engine.step().is_ok());
        }
        let events = engine.drain_events();
        assert!(events
            .iter()
            .any(|event| matches!(event, RuntimeEvent::LeaseExpired { .. })));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::SessionClosed {
                reason: SessionClosureReason::LeaseExpired,
                ..
            }
        )));
    }

    #[test]
    fn idle_timeout_closes_an_inactive_session() {
        let clock = SharedClock::new(0);
        // 1s idle; a would-block poll advances the clock past it.
        let timeouts = TimeoutPolicy {
            idle_timeout: Duration::from_secs(1),
            ..TimeoutPolicy::default()
        };
        let (factory, _sent, _closed) = factory(vec![], Some(clock.clone()), 2_000);
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 1_000_000))]);
        let mut engine = runtime(
            test_config(0, timeouts),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock),
        );

        for _ in 0..5 {
            assert!(engine.step().is_ok());
        }
        let events = engine.drain_events();
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::SessionClosed {
                reason: SessionClosureReason::IdleTimeout,
                ..
            }
        )));
        assert!(
            engine
                .drain_events()
                .iter()
                .any(|event| matches!(event, RuntimeEvent::LeaseExpired { .. }))
                == false
        );
    }

    #[test]
    fn rotation_drains_a_continuous_session() {
        let clock = SharedClock::new(0);
        let timeouts = TimeoutPolicy {
            rotation: Duration::from_secs(1),
            idle_timeout: Duration::from_secs(60),
            ..TimeoutPolicy::default()
        };
        let (factory, _sent, _closed) = factory(vec![], Some(clock.clone()), 2_000);
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 1_000_000))]);
        let mut engine = runtime(
            test_config(0, timeouts),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock),
        );

        for _ in 0..5 {
            assert!(engine.step().is_ok());
        }
        let events = engine.drain_events();
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeEvent::SessionClosed {
                reason: SessionClosureReason::Rotation,
                ..
            }
        )));
    }
    struct FakeUpdater {
        calls: Arc<std::sync::Mutex<Vec<bool>>>,
        applied: bool,
        fail: bool,
    }
    impl super::super::update::RuntimeUpdater for FakeUpdater {
        fn tick(&mut self, _now_ms: i64, idle: bool) -> Result<bool, String> {
            self.calls.lock().unwrap().push(idle);
            if self.fail {
                Err("GitHub unavailable".into())
            } else {
                Ok(self.applied && idle)
            }
        }
    }
    #[test]
    fn updater_skips_live_states_and_shuts_down_only_from_idle() {
        let clock = SharedClock::new(0);
        let (factory, _, _) = factory(vec![], None, 0);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(FakeHeartbeat::new(vec![])),
            Box::new(factory),
            Box::new(clock),
        );
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        engine.set_updater(Box::new(FakeUpdater {
            calls: calls.clone(),
            applied: true,
            fail: false,
        }));
        for state in [
            RuntimeState::Connecting,
            RuntimeState::ActiveSession,
            RuntimeState::Draining,
        ] {
            engine.state = state;
            assert!(!engine.poll_update());
        }
        assert!(calls.lock().unwrap().is_empty());
        engine.state = RuntimeState::Waiting;
        engine.pending = Some((
            "ws://127.0.0.1:8787/session".into(),
            match lease_at("/session", 100000) {
                HeartbeatOutcome::Lease(lease) => lease,
                _ => unreachable!(),
            },
        ));
        assert!(!engine.poll_update());
        engine.pending = None;
        engine.state = RuntimeState::Heartbeating;
        assert_eq!(engine.step().unwrap(), StepOutcome::Shutdown);
        assert_eq!(engine.state(), RuntimeState::Shutdown);
    }
    #[test]
    fn updater_failure_does_not_delay_or_accelerate_heartbeat() {
        let clock = SharedClock::new(0);
        let heartbeat = FakeHeartbeat::new(vec![
            Ok(HeartbeatOutcome::Idle {
                interval: Duration::from_secs(120),
            }),
            Ok(HeartbeatOutcome::Idle {
                interval: Duration::from_secs(120),
            }),
        ]);
        let (factory, _, _) = factory(vec![], None, 0);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock.clone()),
        );
        engine.set_updater(Box::new(FakeUpdater {
            calls: Arc::new(std::sync::Mutex::new(vec![])),
            applied: false,
            fail: true,
        }));
        engine.step().unwrap();
        engine.step().unwrap();
        let count = |events: Vec<RuntimeEvent>| {
            events
                .into_iter()
                .filter(|e| matches!(e, RuntimeEvent::Heartbeat { .. }))
                .count()
        };
        assert_eq!(count(engine.drain_events()), 1);
        clock.advance(1000);
        engine.step().unwrap();
        assert_eq!(count(engine.drain_events()), 0);
        clock.advance(119000);
        engine.step().unwrap();
        assert_eq!(count(engine.drain_events()), 1);
    }
    struct ApplyReservation;
    impl super::super::update::RuntimeUpdater for ApplyReservation {
        fn tick(&mut self, _now: i64, _idle: bool) -> Result<bool, String> {
            Ok(false)
        }
        fn admission_paused(&self, now: i64) -> bool {
            now < 10000
        }
    }
    #[test]
    fn prepared_compose_admission_defers_new_lease_until_expiry() {
        let clock = SharedClock::new(0);
        let heartbeat = FakeHeartbeat::new(vec![Ok(lease_at("/session", 100000))]);
        let (factory, _, _) = factory(vec![], None, 0);
        let mut engine = runtime(
            test_config(0, TimeoutPolicy::default()),
            Box::new(heartbeat),
            Box::new(factory),
            Box::new(clock.clone()),
        );
        engine.set_updater(Box::new(ApplyReservation));
        engine.step().unwrap();
        assert!(matches!(engine.step().unwrap(), StepOutcome::Wait(_)));
        assert_eq!(engine.state(), RuntimeState::Heartbeating);
        assert!(engine.pending.is_none());
        assert!(!engine
            .drain_events()
            .iter()
            .any(|event| matches!(event, RuntimeEvent::Heartbeat { .. })));
        clock.advance(10000);
        engine.step().unwrap();
        assert_eq!(engine.state(), RuntimeState::Waiting);
        assert!(engine.pending.is_some());
    }
}
