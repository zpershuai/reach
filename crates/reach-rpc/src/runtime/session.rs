//! Per-session resources owned by the active session (task 3.5): session id,
//! lease deadline, cancellation root, request-id registry, serial queue state,
//! authorization context, workspace cursor scope, and lifecycle telemetry.
//!
//! `SessionContext` is constructed only on entry to `ActiveSession` and is
//! discarded (with its cursor scope and request state) on every exit path.

use std::collections::HashSet;

use crate::WorkspaceFilesystem;

pub struct SessionContext<'a> {
    pub session_id: String,
    /// Absolute lease expiry in epoch milliseconds.
    pub lease_expires_at_ms: i64,
    /// True once draining has begun: new dispatch is rejected.
    pub cancelled: bool,
    /// Request IDs already executed or rejected this session (dedup).
    pub request_ids: HashSet<String>,
    /// The workspace cursor scope bound to this session. Closed on drop, which
    /// invalidates every cursor this session issued.
    pub workspace: &'a mut WorkspaceFilesystem,
    /// Authorization state resolved by the Authorizer for the current request.
    pub write_claimed: bool,
    /// Epoch ms when the session became active (rotation base).
    pub started_at_ms: i64,
}

impl<'a> SessionContext<'a> {
    pub fn new(
        session_id: String,
        lease_expires_at_ms: i64,
        started_at_ms: i64,
        workspace: &'a mut WorkspaceFilesystem,
    ) -> SessionContext<'a> {
        SessionContext {
            session_id,
            lease_expires_at_ms,
            cancelled: false,
            request_ids: HashSet::new(),
            workspace,
            write_claimed: false,
            started_at_ms,
        }
    }
}

/// Cursor cleanup is owned by `SessionContext`: closing the session clears the
/// workspace cursor scope on every exit path, including failure paths.
impl Drop for SessionContext<'_> {
    fn drop(&mut self) {
        self.workspace.close();
    }
}
