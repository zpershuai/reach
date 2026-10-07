//! Registered per-method Tool modules (tasks 5.1–5.5).
//!
//! Filesystem methods are independently registered Tools backed by the shared
//! `WorkspaceFilesystem`. Each Tool owns its typed parameter validation and
//! error mapping; authorization is supplied through `InvocationContext` by the
//! Dispatcher (write-class Tools check their authorized flag, never the raw
//! request payload).

pub mod fs_edit;
pub mod fs_glob;
pub mod fs_grep;
pub mod fs_list;
pub mod fs_read;
pub mod fs_stat;
pub mod fs_write;
pub mod process;

use std::sync::Arc;

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, ToolError, ToolRegistry},
    ContractError,
};

/// Parse typed params from the invocation context's JSON `Value`.
pub(crate) fn parse_params<T>(
    value: &Value,
    parse: fn(&Value) -> Result<T, ContractError>,
) -> Result<T, ToolError> {
    parse(value).map_err(|_| ToolError::invalid_params())
}

/// Refuse to begin work when the request deadline window has already elapsed.
pub(crate) fn check_deadline(context: &InvocationContext<'_>) -> Result<(), ToolError> {
    if context.cancelled() {
        return Err(ToolError::new(crate::dispatch::SESSION_CLOSED));
    }
    if context.expired() {
        Err(ToolError::new(crate::dispatch::DEADLINE_EXCEEDED))
    } else {
        Ok(())
    }
}

/// The deadline used for workspace traversal. Directory enumeration and
/// recursive searches check it cooperatively between filesystem entries.
pub(crate) fn deadline(context: &InvocationContext<'_>) -> std::time::Instant {
    context.deadline
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(|_| ToolError::invalid_params())
}

fn workspace_error(error: &crate::FilesystemError) -> ToolError {
    ToolError::new(&error.code)
}

pub use fs_edit::FsEditTool;
pub use fs_glob::FsGlobTool;
pub use fs_grep::FsGrepTool;
pub use fs_list::FsListTool;
pub use fs_read::FsReadTool;
pub use fs_stat::FsStatTool;
pub use fs_write::FsWriteTool;

/// The production registry: every supported canonical method.
pub fn default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    registry.register(Arc::new(FsReadTool::new()));
    registry.register(Arc::new(FsListTool::new()));
    registry.register(Arc::new(FsStatTool::new()));
    registry.register(Arc::new(FsWriteTool::new()));
    registry.register(Arc::new(FsEditTool::new()));
    registry.register(Arc::new(FsGlobTool::new()));
    registry.register(Arc::new(FsGrepTool::new()));
    #[cfg(unix)]
    for method in [
        "process.run",
        "process.status",
        "process.logs",
        "process.stop",
        "process.list",
    ] {
        registry.register(Arc::new(process::ProcessTool::new(method)));
    }
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dispatch::{InvocationContext, Tool},
        WorkspaceFilesystem, WORKSPACE_ACCESS_DENIED,
    };
    use serde_json::json;
    use std::{collections::HashMap, path::PathBuf};

    fn workspace(root: &std::path::Path) -> WorkspaceFilesystem {
        let mut roots = HashMap::new();
        roots.insert("fixture".to_owned(), PathBuf::from(root));
        WorkspaceFilesystem::new(roots)
    }

    fn context<'a>(
        processes: &'a mut crate::process::ProcessManager,
        workspace: &'a mut WorkspaceFilesystem,
        params: &'a Value,
        write_claimed: bool,
    ) -> InvocationContext<'a> {
        InvocationContext {
            processes,
            access: crate::dispatch::AccessClass::Read,
            params,
            workspace,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            write_claimed,
            session_id: "session-1",
        }
    }

    #[test]
    fn write_tool_persists_through_workspace_and_read_tool_returns_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = workspace(dir.path());
        let write_params = json!({
            "workspace": "fixture",
            "path": "note.txt",
            "content": "hello world",
            "mode": "overwrite"
        });
        let result = FsWriteTool::new()
            .execute(&mut context(
                &mut crate::process::ProcessManager::default(),
                &mut workspace,
                &write_params,
                true,
            ))
            .unwrap();
        assert_eq!(result["path"], "note.txt");
        let revision = result["revision"].as_str().unwrap();
        assert_eq!(revision.len(), 64);

        let read = FsReadTool::new()
            .execute(&mut context(
                &mut crate::process::ProcessManager::default(),
                &mut workspace,
                &json!({
                    "workspace": "fixture", "path": "note.txt"
                }),
                false,
            ))
            .unwrap();
        assert_eq!(read["content"], "hello world");
        assert_eq!(read["revision"].as_str().unwrap(), revision);

        // Stale revision is rejected (revision behavior).
        let stale = FsWriteTool::new().execute(&mut context(
            &mut crate::process::ProcessManager::default(),
            &mut workspace,
            &json!({
                "workspace": "fixture",
                "path": "note.txt",
                "content": "changed",
                "mode": "overwrite",
                "ifMatch": "0".repeat(64)
            }),
            true,
        ));
        assert_eq!(stale.unwrap_err().code, crate::workspace::REVISION_CONFLICT);
    }

    #[test]
    fn workspace_containment_and_error_mapping() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = workspace(dir.path());
        // Unknown workspace is a containment error.
        let denied = FsReadTool::new().execute(&mut context(
            &mut crate::process::ProcessManager::default(),
            &mut workspace,
            &json!({
                "workspace": "missing", "path": "x"
            }),
            false,
        ));
        assert_eq!(denied.unwrap_err().code, WORKSPACE_ACCESS_DENIED);
        // Missing file maps to FILE_NOT_FOUND.
        let missing = FsReadTool::new().execute(&mut context(
            &mut crate::process::ProcessManager::default(),
            &mut workspace,
            &json!({
                "workspace": "fixture", "path": "nope.txt"
            }),
            false,
        ));
        assert_eq!(missing.unwrap_err().code, "FILE_NOT_FOUND");
        // Malformed params map to INVALID_PARAMS.
        let invalid = FsReadTool::new().execute(&mut context(
            &mut crate::process::ProcessManager::default(),
            &mut workspace,
            &json!({
                "workspace": "fixture", "path": "x", "startLine": 0
            }),
            false,
        ));
        assert_eq!(invalid.unwrap_err().code, crate::INVALID_PARAMS);
    }

    #[test]
    fn write_tools_deny_without_authorized_context() {
        // SessionContext::write_claimed defaults false; a write Tool invoked
        // without authorization must deny itself.
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = workspace(dir.path());
        let params = json!({
            "workspace": "fixture", "path": "note.txt", "content": "x", "mode": "create"
        });
        let denied = FsWriteTool::new().execute(&mut context(
            &mut crate::process::ProcessManager::default(),
            &mut workspace,
            &params,
            false,
        ));
        assert_eq!(denied.unwrap_err().code, crate::PERMISSION_DENIED);
    }

    #[test]
    fn write_tool_refuses_to_mutate_after_its_deadline() {
        // The write Tool threads its context deadline into the workspace
        // mutation boundary: an already-expired deadline must fail with
        // DEADLINE_EXCEEDED and leave no side effect on disk.
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = workspace(dir.path());
        let params = json!({
            "workspace": "fixture", "path": "note.txt", "content": "x", "mode": "create"
        });
        let mut context = InvocationContext {
            processes: &mut crate::process::ProcessManager::default(),
            access: crate::dispatch::AccessClass::Read,
            params: &params,
            workspace: &mut workspace,
            deadline: std::time::Instant::now() - std::time::Duration::from_millis(1),
            write_claimed: true,
            session_id: "session-1",
        };
        let error = FsWriteTool::new().execute(&mut context).unwrap_err();
        assert_eq!(error.code, crate::workspace::DEADLINE_EXCEEDED);
        assert!(!dir.path().join("note.txt").exists());
    }

    #[test]
    fn default_registry_exposes_all_canonical_methods() {
        let registry = default_registry();
        let methods = registry.methods();
        for method in [
            "fs.read", "fs.list", "fs.stat", "fs.write", "fs.edit", "fs.glob", "fs.grep",
        ] {
            assert!(methods.iter().any(|m| m == method), "missing {method}");
        }
        for method in [
            "process.run",
            "process.status",
            "process.logs",
            "process.stop",
            "process.list",
        ] {
            assert_eq!(
                methods.iter().any(|m| m == method),
                cfg!(unix),
                "{method} platform capability"
            );
        }
        // A tool.call wrapper must not resolve to a registered business method.
        assert!(!methods.iter().any(|m| m == "tool.call"));
    }

    /// A cursor issued by one session is invalid after that session ends:
    /// dropping `SessionContext` closes the workspace cursor scope.
    #[test]
    fn session_context_drop_invalidates_cursors_across_sessions() {
        use crate::runtime::SessionContext;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        std::fs::write(dir.path().join("b.txt"), "y").unwrap();
        let old_cursor;
        {
            let mut workspace = workspace(dir.path());
            let session = SessionContext::new("s1".into(), 0, 0, &mut workspace);
            let page = {
                let mut ctx = InvocationContext {
                    processes: &mut crate::process::ProcessManager::default(),
                    access: crate::dispatch::AccessClass::Read,
                    params: &json!({ "workspace": "fixture", "path": ".", "maxEntries": 1 }),
                    workspace: &mut *session.workspace,
                    deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
                    write_claimed: false,
                    session_id: "s1",
                };
                FsListTool::new().execute(&mut ctx).unwrap()
            };
            old_cursor = page["cursor"]
                .as_str()
                .expect("paged result has a cursor")
                .to_owned();
            assert!(page["truncated"].as_bool().unwrap());
            // Session drops here => cursor scope closes.
        }
        let mut workspace = workspace(dir.path());
        let session = SessionContext::new("s2".into(), 0, 0, &mut workspace);
        let mut ctx = InvocationContext {
            processes: &mut crate::process::ProcessManager::default(),
            access: crate::dispatch::AccessClass::Read,
            params: &json!({ "workspace": "fixture", "path": ".", "maxEntries": 1, "cursor": old_cursor }),
            workspace: &mut *session.workspace,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            write_claimed: false,
            session_id: "s2",
        };
        let error = FsListTool::new().execute(&mut ctx).unwrap_err();
        assert_eq!(error.code, crate::workspace::INVALID_CURSOR);
    }
}
