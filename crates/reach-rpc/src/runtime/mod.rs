//! Engine Runtime: configuration, endpoint pinning, state model, transport
//! ports, `SessionContext`, and the single-Gateway lifecycle loop.
//!
//! The Runtime is deliberately testable: transports are trait objects (fake
//! adapters in tests), the clock is injectable, and the state machine has no
//! hidden loops.

pub mod config;
pub mod endpoint;
pub mod runtime;
pub mod session;
pub mod state;
pub mod transports;
pub mod update;

pub use config::{EngineConfig, GatewayConfig, TimeoutPolicy};
pub use endpoint::resolve_session_endpoint;
pub use runtime::{EngineRuntime, SharedClock, StepOutcome, SystemClock};
pub use session::SessionContext;
pub use state::{RuntimeEvent, RuntimeState, SessionClosureReason};
pub use transports::{
    epoch_millis_to_rfc3339, rfc3339_to_epoch_millis, HeartbeatOutcome, HeartbeatTransport, Lease,
    LocalHttpHeartbeatTransport, LocalWebSocketSessionTransportFactory, SessionIncoming,
    SessionTransport, SessionTransportFactory,
};
mod execution;
