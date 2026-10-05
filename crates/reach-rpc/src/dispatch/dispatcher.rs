//! The transport-independent data-plane dispatch pipeline (task 4.1):
//! envelope/session validation, request-id dedup, deadline gating, canonical
//! method resolution (`tool.call` unwrap), authorization, serial execution, and
//! result/error mapping.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{
    dispatch::{
        authorizer::authorize,
        canonical::canonicalize_invocation,
        tool::{InvocationContext, ToolRegistry},
    },
    runtime::SessionContext,
    RequestEnvelope, INVALID_PARAMS,
};

pub const DUPLICATE_REQUEST_ID: &str = "DUPLICATE_REQUEST_ID";
pub const DEADLINE_EXCEEDED: &str = "DEADLINE_EXCEEDED";
pub const SESSION_CLOSED: &str = "SESSION_CLOSED";
/// Deterministic error returned after the Engine has finished initialization
/// but a data-plane request still arrives (defense in depth; the Gateway
/// already gates on readiness).
pub const SESSION_NOT_READY: &str = "SESSION_NOT_READY";

pub struct SessionDispatcher {
    session_id: String,
    registry: ToolRegistry,
    rpc_deadline: Duration,
}

impl SessionDispatcher {
    pub fn new(
        session_id: String,
        registry: ToolRegistry,
        rpc_deadline: Duration,
    ) -> SessionDispatcher {
        SessionDispatcher {
            session_id,
            registry,
            rpc_deadline,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }

    /// Dispatch one validated data-plane request serially. On `Ok` the caller
    /// responds with a `response` envelope echoing `request_id`; on `Err(code)`
    /// the caller responds with an `error` envelope.
    pub fn dispatch(
        &mut self,
        session: &mut SessionContext<'_>,
        envelope: &RequestEnvelope,
        now_ms: i64,
    ) -> Result<Value, String> {
        // 1. Session binding.
        if envelope.session_id != self.session_id {
            return Err(INVALID_PARAMS.to_owned());
        }
        // 2. Request-id dedup: a duplicate is never executed twice.
        if !session.request_ids.insert(envelope.request_id.clone()) {
            return Err(DUPLICATE_REQUEST_ID.to_owned());
        }
        // 3. Session state: draining/cancelled rejects queued work that has not
        //    started.
        if session.cancelled || session.workspace.is_cancelled() {
            return Err(SESSION_CLOSED.to_owned());
        }
        // 4. Deadline gate: do not start work past its deadline.
        let started = Instant::now();
        let mut budget = self.rpc_deadline;
        if let Some(expiry) = &envelope.deadline_at {
            let expiry = crate::runtime::transports::rfc3339_to_epoch_millis(expiry)
                .map_err(|_| INVALID_PARAMS.to_owned())?;
            if expiry <= now_ms {
                return Err(DEADLINE_EXCEEDED.to_owned());
            }
            budget = budget.min(Duration::from_millis(expiry.saturating_sub(now_ms) as u64));
        }
        if budget.is_zero() {
            return Err(DEADLINE_EXCEEDED.to_owned());
        }
        // 5. Canonicalize a single-level `tool.call` before authorization.
        let invocation = canonicalize_invocation(&envelope.method, &envelope.params)
            .map_err(|_| INVALID_PARAMS.to_owned())?;
        // 6. Registry lookup by canonical method.
        let tool = self
            .registry
            .get(&invocation.method)
            .ok_or_else(|| INVALID_PARAMS.to_owned())?;
        // 7. Authorization boundary.
        let auth = authorize(tool.descriptor(), envelope.permission.as_ref())
            .map_err(|error| error.code)?;
        let budget = budget.min(
            tool.descriptor()
                .default_deadline
                .unwrap_or(self.rpc_deadline),
        );
        // Never restart the budget after validation or authorization.
        let deadline = started + budget;
        if Instant::now() >= deadline {
            return Err(DEADLINE_EXCEEDED.to_owned());
        }
        // 8. Serial execution with an authorized invocation context.
        let mut context = InvocationContext {
            params: &invocation.params,
            workspace: &mut *session.workspace,
            deadline,
            write_claimed: auth.write_claimed,
            session_id: &self.session_id,
        };
        let result = tool.execute(&mut context).map_err(|error| error.code);
        // A write Tool reports success only after its commit boundary. Do not
        // turn that known outcome into an uncertain mutation during teardown.
        if result.is_ok() && tool.descriptor().access.is_write() {
            return result;
        }
        if context.workspace.is_cancelled() {
            return Err(SESSION_CLOSED.to_owned());
        }
        if context.expired() {
            return Err(DEADLINE_EXCEEDED.to_owned());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dispatch::tool::{test_support::default_test_registry, Tool, ToolDescriptor, ToolError},
        Permission, WorkspaceFilesystem, INVALID_PARAMS, PERMISSION_DENIED,
    };
    use serde_json::json;
    use std::{collections::HashMap, sync::Arc};

    fn workspace() -> WorkspaceFilesystem {
        WorkspaceFilesystem::new(HashMap::new())
    }

    fn envelope(
        request_id: &str,
        method: &str,
        params: Value,
        permission: Option<Permission>,
    ) -> RequestEnvelope {
        RequestEnvelope {
            message_type: "request".into(),
            protocol: "reach-rpc".into(),
            version: "1.0".into(),
            session_id: "session-1".into(),
            request_id: request_id.into(),
            method: method.into(),
            params,
            deadline_at: None,
            permission,
        }
    }

    fn dispatcher() -> SessionDispatcher {
        SessionDispatcher::new(
            "session-1".into(),
            default_test_registry(),
            Duration::from_secs(30),
        )
    }

    #[test]
    fn binds_requests_to_the_session() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        let wrong = envelope("r1", "fs.read", json!({}), None);
        let request = RequestEnvelope {
            session_id: "other".into(),
            ..wrong.clone()
        };
        assert_eq!(
            d.dispatch(&mut session, &request, 0).unwrap_err(),
            INVALID_PARAMS
        );
    }

    #[test]
    fn duplicate_request_ids_are_not_executed_twice() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        let request = envelope("dup", "fs.read", json!({}), None);
        assert!(d.dispatch(&mut session, &request, 0).is_ok());
        assert_eq!(
            d.dispatch(&mut session, &request, 0).unwrap_err(),
            DUPLICATE_REQUEST_ID
        );
    }

    #[test]
    fn cancelled_session_rejects_queued_work_before_start() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        session.cancelled = true;
        let mut d = dispatcher();
        assert_eq!(
            d.dispatch(&mut session, &envelope("q1", "fs.read", json!({}), None), 0)
                .unwrap_err(),
            SESSION_CLOSED
        );
    }

    #[test]
    fn past_deadline_returns_deadline_exceeded() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let d = SessionDispatcher::new("session-1".into(), default_test_registry(), Duration::ZERO);
        let mut d = d;
        assert_eq!(
            d.dispatch(
                &mut session,
                &envelope("late", "fs.read", json!({}), None),
                1_000
            )
            .unwrap_err(),
            DEADLINE_EXCEEDED
        );
    }

    #[test]
    fn queued_expired_write_is_never_invoked() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut request = envelope(
            "expired",
            "fs.write",
            json!({}),
            Some(Permission {
                grant_id: "g".into(),
            }),
        );
        request.deadline_at = Some("1970-01-01T00:00:01Z".into());
        assert_eq!(
            dispatcher()
                .dispatch(&mut session, &request, 2_000)
                .unwrap_err(),
            DEADLINE_EXCEEDED
        );
    }

    #[test]
    fn elapsed_tool_execution_returns_deadline_exceeded() {
        struct SlowTool {
            descriptor: ToolDescriptor,
        }
        impl Tool for SlowTool {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.descriptor
            }
            fn execute(&self, _context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                std::thread::sleep(Duration::from_millis(10));
                Ok(json!({ "ok": true }))
            }
        }

        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(SlowTool {
            descriptor: ToolDescriptor {
                method: "fs.slow",
                access: crate::dispatch::AccessClass::Read,
                default_deadline: Some(Duration::from_millis(1)),
                execution: crate::dispatch::ExecutionPolicy::Serial,
            },
        }));
        let mut dispatcher =
            SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
        assert_eq!(
            dispatcher
                .dispatch(
                    &mut session,
                    &envelope("slow", "fs.slow", json!({}), None),
                    0
                )
                .unwrap_err(),
            DEADLINE_EXCEEDED
        );
    }

    #[test]
    fn committed_write_is_not_relabelled_when_its_deadline_elapses() {
        struct CommittingTool(ToolDescriptor);
        impl Tool for CommittingTool {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.0
            }
            fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                let result = context
                    .workspace
                    .write(&crate::FsWriteParams {
                        workspace: "fixture".into(),
                        path: "committed.txt".into(),
                        content: "done".into(),
                        mode: crate::FsWriteMode::Create,
                        if_match: None,
                    })
                    .map_err(|error| ToolError::new(error.code))?;
                while !context.expired() {
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
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut descriptor = ToolDescriptor::write("fs.commit");
        descriptor.default_deadline = Some(Duration::from_millis(10));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(CommittingTool(descriptor)));
        let mut dispatcher =
            SessionDispatcher::new("session-1".into(), registry, Duration::from_secs(30));
        let result = dispatcher
            .dispatch(
                &mut session,
                &envelope(
                    "commit",
                    "fs.commit",
                    json!({}),
                    Some(Permission {
                        grant_id: "g".into(),
                    }),
                ),
                0,
            )
            .unwrap();
        assert_eq!(result["path"], "committed.txt");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("committed.txt")).unwrap(),
            "done"
        );
    }

    #[test]
    fn write_tool_without_claim_is_permission_denied() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        assert_eq!(
            d.dispatch(
                &mut session,
                &envelope("w1", "fs.write", json!({}), None),
                0
            )
            .unwrap_err(),
            PERMISSION_DENIED
        );
        // A valid claim authorizes the write tool through its context.
        let result = d.dispatch(
            &mut session,
            &envelope(
                "w2",
                "fs.write",
                json!({}),
                Some(Permission {
                    grant_id: "g1".into(),
                }),
            ),
            0,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn tool_call_is_canonicalized_before_lookup_and_authorization() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        // Direct write without a claim is denied; wrapped write without a claim
        // must also be denied (canonicalization happens before authorization).
        let wrapped = envelope(
            "tc1",
            "tool.call",
            json!({ "name": "fs.write", "arguments": {} }),
            None,
        );
        assert_eq!(
            d.dispatch(&mut session, &wrapped, 0).unwrap_err(),
            PERMISSION_DENIED
        );
        // Nested tool.call is INVALID_PARAMS and no Tool runs.
        let nested = envelope(
            "tc2",
            "tool.call",
            json!({ "name": "tool.call", "arguments": { "name": "fs.read", "arguments": {} } }),
            Some(Permission {
                grant_id: "g1".into(),
            }),
        );
        assert_eq!(
            d.dispatch(&mut session, &nested, 0).unwrap_err(),
            INVALID_PARAMS
        );
    }

    #[test]
    fn unknown_method_returns_invalid_params() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        assert_eq!(
            d.dispatch(
                &mut session,
                &envelope("u1", "fs.missing", json!({}), None),
                0
            )
            .unwrap_err(),
            INVALID_PARAMS
        );
    }

    #[test]
    fn dispatcher_serializes_execution_and_records_executed_tools() {
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut d = dispatcher();
        let first = d
            .dispatch(
                &mut session,
                &envelope("a", "fs.read", json!({ "path": "x" }), None),
                0,
            )
            .unwrap();
        assert_eq!(first["method"], "fs.read");
        let second = d
            .dispatch(&mut session, &envelope("b", "fs.list", json!({}), None), 0)
            .unwrap();
        assert_eq!(second["method"], "fs.list");
        assert_eq!(session.request_ids.len(), 2);
    }

    #[test]
    fn tool_receives_authorized_invocation_context() {
        // A write tool must observe its write_claimed flag from the Authorizer.
        let mut workspace = workspace();
        let mut session = SessionContext::new("session-1".into(), 0, 0, &mut workspace);
        let mut registry = default_test_registry();
        let claims = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        struct CapturingTool {
            descriptor: ToolDescriptor,
            claims: std::sync::Arc<std::sync::Mutex<Vec<bool>>>,
        }
        impl Tool for CapturingTool {
            fn descriptor(&self) -> &ToolDescriptor {
                &self.descriptor
            }
            fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
                self.claims.lock().unwrap().push(context.write_claimed);
                Ok(json!({ "ok": true }))
            }
        }
        registry.register(Arc::new(CapturingTool {
            descriptor: ToolDescriptor::write("fs.edit"),
            claims: claims.clone(),
        }));
        let d = SessionDispatcher::new(
            "session-1".into(),
            registry.clone(),
            Duration::from_secs(30),
        );
        let mut d = d;
        assert!(d
            .dispatch(
                &mut session,
                &envelope(
                    "e1",
                    "fs.edit",
                    json!({}),
                    Some(Permission {
                        grant_id: "g".into()
                    })
                ),
                0
            )
            .is_ok());
        assert_eq!(*claims.lock().unwrap(), vec![true]);
    }
}
