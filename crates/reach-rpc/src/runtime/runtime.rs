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
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
    events: RefCell<Vec<RuntimeEvent>>,
    sleep: Box<dyn Fn(Duration)>,
    state: RuntimeState,
    pending: Option<(String, Lease)>,
    session_closure: Option<SessionClosureReason>,
    backoff_secs: u64,
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
            events: RefCell::new(Vec::new()),
            sleep,
            state: RuntimeState::Boot,
            pending: None,
            session_closure: None,
            backoff_secs: 1,
        }
    }

    pub fn state(&self) -> RuntimeState {
        self.state
    }

    pub fn drain_events(&self) -> Vec<RuntimeEvent> {
        self.events.borrow().clone()
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
        let mut events = std::mem::take(&mut *self.events.borrow_mut());
        for event in &events {
            if let RuntimeEvent::Message { line } = event {
                println!("{line}");
            }
        }
        events.retain(|event| !matches!(event, RuntimeEvent::Message { .. }));
        *self.events.borrow_mut() = events;
    }

    /// Perform one state action. Non-blocking except when `ActiveSession` is
    /// entered: driving a live session reads from its transport until it ends.
    pub fn step(&mut self) -> Result<StepOutcome, String> {
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
                    return Ok(StepOutcome::Wait(interval));
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
                        finalize_session(&mut transport, &lease.session_id, reason);
                        self.session_closure = Some(reason);
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
                self.session_closure = Some(SessionClosureReason::PolicyError);
                self.transition(RuntimeState::Draining);
            }
            RuntimeState::Draining => {
                let reason = self
                    .session_closure
                    .take()
                    .unwrap_or(SessionClosureReason::PolicyError);
                self.emit(RuntimeEvent::SessionClosed {
                    session_id: "<releasing>".to_owned(),
                    reason,
                });
                if reason.is_error() {
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

    /// Drive one active session to completion and return its closure reason.
    /// Owns `SessionContext` (cancellation, request registry, cursor scope) for
    /// exactly the active session. `finalize_session` runs after the loop so
    /// every exit path clears cursor scope and closes the transport.
    fn run_session(
        &mut self,
        transport: &mut Box<dyn SessionTransport>,
        lease: &Lease,
    ) -> SessionClosureReason {
        let events: &RefCell<Vec<RuntimeEvent>> = &self.events;
        let timeouts = self.config.timeouts;
        let engine_id = self.config.engine_id.clone();
        let mut workspaces: Vec<String> = self.config.workspace_roots.keys().cloned().collect();
        workspaces.sort();

        let mut context = SessionContext::new(
            lease.session_id.clone(),
            lease.lease_expires_at_ms,
            self.clock.now_ms(),
            &mut self.workspace,
        );
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
        let reason = 'drive: loop {
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
            // Idle timeout: no valid RPC, renewal, or control activity.
            if now_ms.saturating_sub(last_activity_ms) >= timeouts.idle_timeout.as_millis() as i64 {
                break 'drive SessionClosureReason::IdleTimeout;
            }

            match transport.recv() {
                Ok(SessionIncoming::Text(text)) => {
                    last_activity_ms = now_ms;
                    match handle_session_message(
                        events,
                        &mut context,
                        &mut dispatcher,
                        transport,
                        &text,
                        now_ms,
                        timeouts.max_lease().as_millis() as i64,
                    ) {
                        Ok(Flow::Continue) => {}
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
                    if context.cancelled {
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
        drop(context);
        reason
    }
}

/// Handle one engine-side session message: control messages (`session.renew`,
/// `session.close`) and data-plane `request` envelopes. Returns `Close` when
/// the session should end (draining has been requested).
fn handle_session_message(
    events: &RefCell<Vec<RuntimeEvent>>,
    context: &mut SessionContext<'_>,
    dispatcher: &mut SessionDispatcher,
    transport: &mut Box<dyn SessionTransport>,
    text: &str,
    now_ms: i64,
    max_lease_ms: i64,
) -> Result<Flow, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| INVALID_PARAMS.to_owned())?;
    let Some(message_type) = value.get("type").and_then(Value::as_str) else {
        return Ok(Flow::Continue);
    };

    match message_type {
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
                context.cancelled = true;
                return Ok(Flow::Close(SessionClosureReason::SessionComplete));
            }
            if context.cancelled {
                send_error(
                    transport,
                    &envelope.request_id,
                    crate::dispatch::SESSION_CLOSED,
                )?;
                return Ok(Flow::Continue);
            }
            match dispatcher.dispatch(context, &envelope, now_ms) {
                Ok(result) => {
                    send_response(transport, &envelope.request_id, result)?;
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
                    send_error(transport, &envelope.request_id, &code)?;
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
            Ok(Flow::Continue)
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
                    context.cancelled = true;
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
    transport
        .send(&json!({ "type": "response", "requestId": request_id, "result": result }).to_string())
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
    use crate::{
        dispatch::tool::test_support::default_test_registry,
        runtime::config::{EngineConfig, GatewayConfig, TimeoutPolicy},
    };
    use std::{collections::HashMap, time::Duration};

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
}
