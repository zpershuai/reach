//! Typed Tool abstraction: descriptors, registry, invocation context, and
//! error mapping. Tools are stateless handlers registered by canonical method
//! name; they receive authorization via their invocation context.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::{WorkspaceFilesystem, INVALID_PARAMS};

/// Whether a Tool reads or mutates the workspace. Determines authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessClass {
    Read,
    Write,
    Execute,
    ProcessControl,
}

impl AccessClass {
    pub fn is_write(&self) -> bool {
        matches!(self, AccessClass::Write)
    }
}

/// Execution policy. Initial implementation is strictly serial within a
/// session; read-only concurrency is a future explicit extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionPolicy {
    Serial,
}

#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    /// Canonical method name, e.g. `fs.read`.
    pub method: &'static str,
    pub access: AccessClass,
    /// A Tool-specific default deadline; `None` falls back to the Runtime
    /// RPC deadline policy.
    pub default_deadline: Option<Duration>,
    pub execution: ExecutionPolicy,
}

impl ToolDescriptor {
    pub fn read(method: &'static str) -> ToolDescriptor {
        ToolDescriptor {
            method,
            access: AccessClass::Read,
            default_deadline: None,
            execution: ExecutionPolicy::Serial,
        }
    }

    pub fn write(method: &'static str) -> ToolDescriptor {
        ToolDescriptor {
            method,
            access: AccessClass::Write,
            default_deadline: None,
            execution: ExecutionPolicy::Serial,
        }
    }
}

/// Error a Tool returns; `code` is the wire error code (e.g. `INVALID_PARAMS`,
/// `REVISION_CONFLICT`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: String,
}

impl ToolError {
    pub fn new(code: &str) -> ToolError {
        ToolError {
            code: code.to_owned(),
        }
    }

    pub fn invalid_params() -> ToolError {
        ToolError::new(INVALID_PARAMS)
    }

    pub fn permission_denied() -> ToolError {
        ToolError::new(crate::PERMISSION_DENIED)
    }
}

/// Execution context passed to a Tool. The `write_claimed` flag is set by the
/// Authorizer after verifying a write-class invocation's permission claim;
/// Tools trust this context rather than the raw request payload.
pub struct InvocationContext<'a> {
    pub params: &'a Value,
    pub processes: &'a mut crate::process::ProcessManager,
    pub access: AccessClass,
    pub workspace: &'a mut WorkspaceFilesystem,
    /// Monotonic deadline by which the Tool must finish. A monotonic clock is
    /// deliberately used so wall-clock changes cannot extend a request.
    pub deadline: Instant,
    /// True when the Authorizer verified a write permission claim.
    pub write_claimed: bool,
    pub session_id: &'a str,
}

impl InvocationContext<'_> {
    /// True once this invocation's monotonic deadline has elapsed.
    pub fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// True when the Runtime has requested session teardown.
    pub fn cancelled(&self) -> bool {
        self.workspace.is_cancelled()
    }
}

/// A registered Tool handler.
pub trait Tool: Send + Sync {
    fn descriptor(&self) -> &ToolDescriptor;
    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError>;
}

/// A tool registry keyed by canonical method name. Clonable so each session can
/// own a cheap registry sharing the same stateless handlers.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: Arc<HashMap<String, Arc<dyn Tool>>>,
}

impl ToolRegistry {
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let descriptor = tool.descriptor().clone();
        Arc::make_mut(&mut self.tools).insert(descriptor.method.to_owned(), tool);
    }

    pub fn get(&self, method: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(method).cloned()
    }

    pub fn methods(&self) -> Vec<String> {
        let mut methods: Vec<String> = self.tools.keys().cloned().collect();
        methods.sort();
        methods
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use serde_json::json;

    /// A Tool used by Dispatcher/Runtime tests that echoes its params.
    pub fn echo_tool(method: &'static str, access: AccessClass) -> Arc<dyn Tool> {
        struct EchoTool {
            descriptor: ToolDescriptor,
        }
        impl Tool for EchoTool {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.descriptor
            }
            fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                if context.cancelled() {
                    return Err(ToolError::new(crate::dispatch::SESSION_CLOSED));
                }
                if context.expired() {
                    return Err(ToolError::new("DEADLINE_EXCEEDED"));
                }
                Ok(json!({ "method": self.descriptor.method, "params": context.params }))
            }
        }
        Arc::new(EchoTool {
            descriptor: ToolDescriptor {
                method,
                access,
                default_deadline: None,
                execution: ExecutionPolicy::Serial,
            },
        })
    }

    pub fn default_test_registry() -> ToolRegistry {
        let mut registry = ToolRegistry::default();
        registry.register(echo_tool("fs.read", AccessClass::Read));
        registry.register(echo_tool("fs.write", AccessClass::Write));
        registry.register(echo_tool("fs.list", AccessClass::Read));
        registry.register(echo_tool("unknown.write", AccessClass::Write));
        registry
    }
}
