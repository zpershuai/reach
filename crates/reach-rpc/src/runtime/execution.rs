//! Serial Tool execution with a responsive session control lane.
//! The worker owns the workspace until it drains; only its cancellation flag
//! is shared. Transport I/O and session controls remain on the Runtime thread.

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::runtime::Clock;
use super::transports::{rfc3339_to_epoch_millis, SessionIncoming, SessionTransport};
use super::{SessionClosureReason, SessionContext, TimeoutPolicy};
use crate::{RequestEnvelope, SessionDispatcher, SessionMessage, INVALID_PARAMS};

const MAX_QUEUED_REQUESTS: usize = 16;

pub(super) struct ExecutionControl<'a> {
    pub queue: VecDeque<String>,
    pub clock: &'a dyn Clock,
    pub timeouts: TimeoutPolicy,
    pub sleep: &'a dyn Fn(Duration),
    pub last_activity_ms: i64,
}

pub(super) struct ExecutionResult {
    pub result: Result<Value, String>,
    pub closure: Option<SessionClosureReason>,
}

impl ExecutionControl<'_> {
    pub fn dispatch(
        &mut self,
        context: &mut SessionContext<'_>,
        dispatcher: &mut SessionDispatcher,
        envelope: &RequestEnvelope,
        transport: &mut Box<dyn SessionTransport>,
    ) -> ExecutionResult {
        let cancellation = context.workspace.cancellation();
        let session_id = context.session_id.clone();
        let mut lease_expiry = context.lease_expires_at_ms;
        let rotation_at = context
            .started_at_ms
            .saturating_add(self.timeouts.rotation.as_millis() as i64);
        let now_ms = self.clock.now_ms();
        self.last_activity_ms = now_ms;
        // Dispatcher/Tools enforce individual request deadlines. Only this
        // hard execution bound tears down the session if a worker won't drain.
        let deadline = Instant::now() + self.timeouts.rpc_deadline;
        let mut closure = None;
        let result = std::thread::scope(|scope| {
            let worker = scope.spawn(|| dispatcher.dispatch(context, envelope, now_ms));
            while !worker.is_finished() {
                let now = self.clock.now_ms();
                if closure.is_none() {
                    closure = if now >= lease_expiry {
                        Some(SessionClosureReason::LeaseExpired)
                    } else if now >= rotation_at {
                        Some(SessionClosureReason::Rotation)
                    } else if Instant::now() >= deadline {
                        Some(SessionClosureReason::RpcTimeout)
                    } else {
                        None
                    };
                }
                if closure.is_some() {
                    cancellation.cancel();
                    (self.sleep)(Duration::from_millis(1));
                    continue;
                }
                match transport.recv() {
                    Ok(SessionIncoming::WouldBlock) => (self.sleep)(Duration::from_millis(1)),
                    Ok(SessionIncoming::Ping(payload)) => {
                        self.last_activity_ms = now;
                        if transport.send_pong(&payload).is_err() {
                            closure = Some(SessionClosureReason::Disconnected);
                        }
                    }
                    Ok(SessionIncoming::Close { .. }) | Err(_) => {
                        closure = Some(SessionClosureReason::Disconnected)
                    }
                    Ok(SessionIncoming::Text(text)) => {
                        self.last_activity_ms = now;
                        let value: Value = match serde_json::from_str(&text) {
                            Ok(value) => value,
                            Err(_) => {
                                closure = Some(SessionClosureReason::PolicyError);
                                continue;
                            }
                        };
                        // Keep the terminal-error rule while a Tool is running.
                        if value.get("type").and_then(Value::as_str) == Some("error") {
                            continue;
                        }
                        if value.get("type").and_then(Value::as_str) == Some("request") {
                            if self.queue.len() < MAX_QUEUED_REQUESTS {
                                self.queue.push_back(text);
                            } else {
                                let id =
                                    value.get("requestId").and_then(Value::as_str).unwrap_or("");
                                let reply = json!({"type": "error", "requestId": id, "error": {"code": "TOO_MANY_REQUESTS"}});
                                if transport.send(&reply.to_string()).is_err() {
                                    closure = Some(SessionClosureReason::Disconnected);
                                }
                            }
                            continue;
                        }
                        match crate::parse_session_message(&text) {
                            Ok(SessionMessage::Close(close)) if close.session_id == session_id => {
                                closure = Some(SessionClosureReason::AgentRequested)
                            }
                            Ok(SessionMessage::Renew(renew)) if renew.session_id == session_id => {
                                if let Ok(expiry) = rfc3339_to_epoch_millis(&renew.lease_expires_at)
                                {
                                    lease_expiry = expiry.min(now.saturating_add(
                                        self.timeouts.max_lease().as_millis() as i64,
                                    ));
                                }
                            }
                            _ => {
                                let reply = json!({"type": "error", "requestId": "", "error": {"code": INVALID_PARAMS}});
                                if transport.send(&reply.to_string()).is_err() {
                                    closure = Some(SessionClosureReason::Disconnected);
                                }
                            }
                        }
                    }
                }
            }
            worker
                .join()
                .unwrap_or_else(|_| Err("INTERNAL_ERROR".into()))
        });
        // Running a Tool is activity; start the idle window after it drains.
        self.last_activity_ms = self.clock.now_ms();
        context.lease_expires_at_ms = lease_expiry;
        if closure.is_some() {
            cancellation.cancel();
            context.cancel();
            self.queue.clear();
        }
        ExecutionResult { result, closure }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::InvocationContext;
    use crate::runtime::SharedClock;
    use crate::{Tool, ToolDescriptor, ToolError, ToolRegistry, WorkspaceFilesystem};
    use std::sync::{Arc, Barrier};

    struct SlowTool(Arc<Barrier>, ToolDescriptor);
    impl Tool for SlowTool {
        fn descriptor(&self) -> &ToolDescriptor {
            &self.1
        }
        fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
            self.0.wait();
            while !context.cancelled() && !context.expired() {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(ToolError::new("SESSION_CLOSED"))
        }
    }

    struct ControlTransport {
        started: Arc<Barrier>,
        first: bool,
        messages: VecDeque<String>,
        advance_clock: Option<SharedClock>,
    }
    impl SessionTransport for ControlTransport {
        fn recv(&mut self) -> Result<SessionIncoming, String> {
            if self.first {
                self.first = false;
                self.started.wait();
                if let Some(clock) = &self.advance_clock {
                    clock.advance(2_000);
                }
            }
            Ok(self
                .messages
                .pop_front()
                .map(SessionIncoming::Text)
                .unwrap_or(SessionIncoming::WouldBlock))
        }
        fn send(&mut self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn send_pong(&mut self, _: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn close(&mut self, _: u16, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn close_cancels_running_tool_and_discards_queued_write() {
        let started = Arc::new(Barrier::new(2));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(SlowTool(
            started.clone(),
            ToolDescriptor::read("fs.slow"),
        )));
        let mut workspace = WorkspaceFilesystem::new(Default::default());
        let mut context = SessionContext::new("s".into(), 1_000_000, 0, &mut workspace);
        let mut dispatcher = SessionDispatcher::new("s".into(), registry, Duration::from_secs(1));
        let envelope = crate::parse_request_envelope(r#"{"type":"request","protocol":"reach-rpc","version":"1.0","sessionId":"s","requestId":"slow","method":"fs.slow","params":{}}"#).unwrap();
        let mut transport: Box<dyn SessionTransport> = Box::new(ControlTransport {
            started,
            first: true,
            messages: VecDeque::from([
                r#"{"type":"request","requestId":"queued","method":"fs.write","params":{}}"#.into(),
                r#"{"type":"session.close","sessionId":"s","reason":"agent_requested"}"#.into(),
            ]),
            advance_clock: None,
        });
        let clock = SharedClock::new(0);
        let mut execution = ExecutionControl {
            queue: VecDeque::new(),
            clock: &clock,
            timeouts: TimeoutPolicy::default(),
            sleep: &std::thread::sleep,
            last_activity_ms: 0,
        };
        let outcome = execution.dispatch(&mut context, &mut dispatcher, &envelope, &mut transport);
        assert_eq!(outcome.closure, Some(SessionClosureReason::AgentRequested));
        assert!(context.is_cancelled());
        assert!(execution.queue.is_empty());
        assert_eq!(context.request_ids.len(), 1);
    }

    #[test]
    fn active_work_is_not_idle_but_the_hard_execution_bound_still_closes() {
        struct ActiveTool(Arc<Barrier>, ToolDescriptor, bool);
        impl Tool for ActiveTool {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.1
            }
            fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                self.0.wait();
                if self.2 {
                    // Simulate a Tool that ignores its individual deadline.
                    while !context.cancelled() {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(ToolError::new(crate::dispatch::SESSION_CLOSED))
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                    Ok(json!({"ok": true}))
                }
            }
        }
        for hit_hard_bound in [false, true] {
            let barrier = Arc::new(Barrier::new(2));
            let mut registry = ToolRegistry::default();
            registry.register(Arc::new(ActiveTool(
                barrier.clone(),
                ToolDescriptor::read("fs.active"),
                hit_hard_bound,
            )));
            let mut workspace = WorkspaceFilesystem::new(Default::default());
            let mut context = SessionContext::new("s".into(), 1_000_000, 0, &mut workspace);
            let mut dispatcher =
                SessionDispatcher::new("s".into(), registry, Duration::from_secs(1));
            let envelope = crate::parse_request_envelope(r#"{"type":"request","protocol":"reach-rpc","version":"1.0","sessionId":"s","requestId":"active","method":"fs.active","params":{}}"#).unwrap();
            let clock = SharedClock::new(0);
            let mut transport: Box<dyn SessionTransport> = Box::new(ControlTransport {
                started: barrier,
                first: true,
                messages: VecDeque::new(),
                advance_clock: Some(clock.clone()),
            });
            let mut execution = ExecutionControl {
                queue: VecDeque::new(),
                clock: &clock,
                timeouts: TimeoutPolicy {
                    idle_timeout: Duration::from_millis(1),
                    rpc_deadline: if hit_hard_bound {
                        Duration::from_millis(20)
                    } else {
                        Duration::from_secs(1)
                    },
                    ..TimeoutPolicy::default()
                },
                sleep: &std::thread::sleep,
                last_activity_ms: 0,
            };
            let outcome =
                execution.dispatch(&mut context, &mut dispatcher, &envelope, &mut transport);
            if hit_hard_bound {
                assert_eq!(outcome.closure, Some(SessionClosureReason::RpcTimeout));
                assert!(context.is_cancelled());
            } else {
                assert!(outcome.result.is_ok());
                assert_eq!(outcome.closure, None);
                assert!(!context.is_cancelled());
                assert_eq!(execution.last_activity_ms, 2_000);
            }
        }
    }
}
