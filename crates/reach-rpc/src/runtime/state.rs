//! Runtime state model, session closure reasons, and structured lifecycle
//! events emitted by the Engine Runtime.

use crate::session::{
    CLOSURE_AGENT_REQUESTED, CLOSURE_DISCONNECTED, CLOSURE_IDLE_TIMEOUT, CLOSURE_LEASE_EXPIRED,
    CLOSURE_ROTATION, CLOSURE_SESSION_COMPLETE, CLOSURE_SHUTDOWN,
};

/// The explicit single-Gateway Runtime state machine. Transitions are events,
/// not nested control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
#[derive(Debug, Clone, PartialEq)]
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
