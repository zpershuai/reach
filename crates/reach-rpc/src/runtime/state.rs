//! Runtime state model, session closure reasons, and structured lifecycle
//! events emitted by the Engine Runtime.

use crate::session::{
    CLOSURE_AGENT_REQUESTED, CLOSURE_DISCONNECTED, CLOSURE_IDLE_TIMEOUT, CLOSURE_LEASE_EXPIRED,
    CLOSURE_ROTATION, CLOSURE_SESSION_COMPLETE, CLOSURE_SHUTDOWN,
};

/// The explicit single-Gateway Runtime state machine. Transitions are events,
/// not nested control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    /// Process start; nothing has been configured or attempted yet.
    Boot,
    /// Posting device heartbeats to the configured Gateway.
    Heartbeating,
    /// A session lease has been acquired but the connection is not attempted.
    Waiting,
    /// Opening the session WebSocket / awaiting readiness.
    Connecting,
    /// A ready WebSocket session is live and dispatching work.
    ActiveSession,
    /// Closing the session: cancelling context, draining work, closing transport.
    Draining,
    /// Backing off after a failed heartbeat or errored session close.
    Backoff,
    /// Terminal; the Runtime stops.
    Shutdown,
}

impl RuntimeState {
    pub fn label(&self) -> &'static str {
        match self {
            RuntimeState::Boot => "boot",
            RuntimeState::Heartbeating => "heartbeating",
            RuntimeState::Waiting => "waiting",
            RuntimeState::Connecting => "connecting",
            RuntimeState::ActiveSession => "active_session",
            RuntimeState::Draining => "draining",
            RuntimeState::Backoff => "backoff",
            RuntimeState::Shutdown => "shutdown",
        }
    }
}

/// Machine-readable reason a session ended. Mirrors the `session.closed`
/// wire reasons plus local-only reasons (connection failure, policy error).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionClosureReason {
    /// The Agent/Gateway requested closure.
    AgentRequested,
    /// Legacy `session.complete` translated to an Agent-requested close.
    SessionComplete,
    /// The renewable lease expired without a valid renewal.
    LeaseExpired,
    /// No valid RPC, renewal, or control activity within the idle bound.
    IdleTimeout,
    /// The continuous connection reached its maximum age.
    Rotation,
    /// The transport closed unexpectedly.
    Disconnected,
    /// Application shutdown.
    Shutdown,
    /// The connection could not be established.
    ConnectionFailed,
    /// A local policy/internal error forced the close.
    PolicyError,
    /// A request exceeded its RPC deadline (session-level close).
    RpcTimeout,
}

impl SessionClosureReason {
    pub fn code(&self) -> &'static str {
        match self {
            SessionClosureReason::AgentRequested => CLOSURE_AGENT_REQUESTED,
            SessionClosureReason::SessionComplete => CLOSURE_SESSION_COMPLETE,
            SessionClosureReason::LeaseExpired => CLOSURE_LEASE_EXPIRED,
            SessionClosureReason::IdleTimeout => CLOSURE_IDLE_TIMEOUT,
            SessionClosureReason::Rotation => CLOSURE_ROTATION,
            SessionClosureReason::Disconnected => CLOSURE_DISCONNECTED,
            SessionClosureReason::Shutdown => CLOSURE_SHUTDOWN,
            SessionClosureReason::ConnectionFailed => "connection_failed",
            SessionClosureReason::PolicyError => "policy_error",
            SessionClosureReason::RpcTimeout => "rpc_timeout",
        }
    }

    /// True when this closure should resume heartbeat through backoff (an
    /// error/abnormal close) rather than an explicit clean close.
    pub fn is_error(&self) -> bool {
        matches!(
            self,
            SessionClosureReason::ConnectionFailed
                | SessionClosureReason::Disconnected
                | SessionClosureReason::PolicyError
                | SessionClosureReason::RpcTimeout
        )
    }
}

/// Structured lifecycle event emitted by the Runtime.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RuntimeEvent {
    StateChanged {
        from: RuntimeState,
        to: RuntimeState,
    },
    Heartbeat {
        leased: bool,
        ok: bool,
        error: Option<String>,
    },
    SessionReady {
        session_id: String,
    },
    SessionClosed {
        session_id: String,
        reason: SessionClosureReason,
    },
    LeaseExpired {
        session_id: String,
    },
    RpcDisposition {
        request_id: String,
        method: String,
        ok: bool,
    },
    AuthorizationDenied {
        method: String,
    },
    ToolExecuted {
        method: String,
        ok: bool,
    },
    /// A human-readable log line (stdout by default).
    Message {
        line: String,
    },
}

impl RuntimeEvent {
    /// Service diagnostics never serialize peer-controlled identifiers or exception text.
    pub fn diagnostic(&self) -> serde_json::Value {
        use serde_json::json;
        let method = |value: &str| match value {
            "fs.read" | "fs.list" | "fs.stat" | "fs.glob" | "fs.grep" | "fs.write" | "fs.edit"
            | "process.run" | "process.status" | "process.logs" | "process.list"
            | "process.stop" | "session.complete" => value.to_owned(),
            _ => "unknown".into(),
        };
        match self {
            Self::StateChanged { from, to } => json!({"event":"state_changed","from":from,"to":to}),
            Self::Heartbeat { leased, ok, .. } => {
                json!({"event":"heartbeat","leased":leased,"ok":ok})
            }
            Self::SessionReady { .. } => json!({"event":"session_ready"}),
            Self::SessionClosed { reason, .. } => {
                json!({"event":"session_closed","reason":reason.code()})
            }
            Self::LeaseExpired { .. } => json!({"event":"lease_expired"}),
            Self::RpcDisposition {
                method: name, ok, ..
            } => json!({"event":"rpc_disposition","method":method(name),"ok":ok}),
            Self::AuthorizationDenied { method: name } => {
                json!({"event":"authorization_denied","method":method(name)})
            }
            Self::ToolExecuted { method: name, ok } => {
                json!({"event":"tool_executed","method":method(name),"ok":ok})
            }
            Self::Message { line } => {
                let code = [
                    "UPDATE_CHECK_FAILED",
                    "SESSION_ENDPOINT_REJECTED",
                    "HEARTBEAT_FAILED",
                    "SESSION_CONNECT_FAILED",
                    "SESSION_PROTOCOL_INVALID",
                    "SESSION_READ_FAILED",
                    "PROCESS_CLEANUP_FAILED",
                    "WORKSPACE_RELOAD_FAILED",
                    "WORKSPACE_STATE_INVALIDATED",
                ]
                .into_iter()
                .find(|code| line.starts_with(code))
                .unwrap_or("ENGINE_LIFECYCLE");
                json!({"event":"diagnostic","code":code})
            }
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn diagnostic_allowlist_drops_identifiers_exceptions_and_unknown_methods() {
        let secret = "private-token-body-args-output\nFORGED_LOG".repeat(1000);
        let events = [
            RuntimeEvent::Heartbeat {
                leased: false,
                ok: false,
                error: Some(secret.clone()),
            },
            RuntimeEvent::SessionReady {
                session_id: secret.clone(),
            },
            RuntimeEvent::SessionClosed {
                session_id: secret.clone(),
                reason: SessionClosureReason::RpcTimeout,
            },
            RuntimeEvent::RpcDisposition {
                request_id: secret.clone(),
                method: secret.clone(),
                ok: false,
            },
            RuntimeEvent::Message {
                line: secret.clone(),
            },
            RuntimeEvent::Message {
                line: format!("SESSION_READ_FAILED: {secret}"),
            },
        ];
        for event in events {
            let line = event.diagnostic().to_string();
            assert!(!line.contains("private-token"));
            assert!(!line.contains("FORGED_LOG"));
            assert!(line.len() < 256);
        }
        assert_eq!(
            RuntimeEvent::ToolExecuted {
                method: "process.logs".into(),
                ok: true
            }
            .diagnostic()["method"],
            "process.logs"
        );
    }
}
