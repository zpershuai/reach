//! Session dispatch: canonical invocation, authorization middleware, the
//! `SessionDispatcher` pipeline, and the typed Tool abstraction.

pub mod authorizer;
pub mod canonical;
pub mod dispatcher;
pub mod tool;

pub use authorizer::{authorize, AuthorizationContext};
pub use canonical::{canonicalize_invocation, tool_call_wrapper, CanonicalInvocation};
pub use dispatcher::{
    SessionDispatcher, DEADLINE_EXCEEDED, DUPLICATE_REQUEST_ID, SESSION_CLOSED, SESSION_NOT_READY,
};
pub use tool::{
    AccessClass, ExecutionPolicy, InvocationContext, Tool, ToolDescriptor, ToolError, ToolRegistry,
};
