//! Per-session resources owned by the active session (task 3.5): session id,
//! lease deadline, cancellation root, request-id registry, serial queue state,
//! authorization context, workspace cursor scope, and lifecycle telemetry.
//!
//! `SessionContext` is constructed only on entry to `ActiveSession` and is
//! discarded (with its cursor scope and request state) on every exit path.

use std::collections::{HashSet, VecDeque};

use crate::WorkspaceFilesystem;

/// Upper bound on request IDs remembered for dedup within one renewable
/// session. A session may be renewed for up to the rotation window (hours), so
/// without a cap a caller submitting unique request IDs sequentially would grow
/// this set without bound. Oldest entries are evicted once the cap is reached;
/// matching the Gateway's `seenRequestIds` cap keeps the two dedup windows in
/// lockstep.
pub const MAX_SESSION_REQUEST_IDS: usize = 65_536;

/// An insertion-ordered request-id registry with FIFO eviction. `insert`
/// mirrors `HashSet::insert`: `false` when the ID was already present. Memory
/// stays bounded even for a long-lived, heavily-renewed session.
#[derive(Default)]
pub struct RequestIdSet {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl RequestIdSet {
    pub fn new() -> RequestIdSet {
        RequestIdSet::default()
    }

    /// Record `id`; returns `false` when it was already present. Evicts the
    /// oldest ID once the cap is exceeded, so the registry tracks the most
    /// recent request window rather than the whole session.
    pub fn insert(&mut self, id: String) -> bool {
        if self.seen.contains(&id) {
            return false;
        }
        self.order.push_back(id.clone());
        self.seen.insert(id);
        while self.order.len() > MAX_SESSION_REQUEST_IDS {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

pub struct SessionContext<'a> {
    pub session_id: String,
    /// Absolute lease expiry in epoch milliseconds.
    pub lease_expires_at_ms: i64,
    /// True once draining has begun: new dispatch is rejected.
    pub cancelled: bool,
    /// Request IDs already executed or rejected this session (dedup).
    pub request_ids: RequestIdSet,
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
        workspace.begin_session();
        SessionContext {
            session_id,
            lease_expires_at_ms,
            cancelled: false,
            request_ids: RequestIdSet::new(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_set_dedups_and_evicts_oldest_when_capped() {
        let mut ids = RequestIdSet::new();
        assert!(ids.insert("r1".to_owned()));
        assert!(!ids.insert("r1".to_owned())); // duplicate is not re-recorded
        assert_eq!(ids.len(), 1);

        // Filling past the cap evicts exactly the oldest entry.
        for i in 0..=MAX_SESSION_REQUEST_IDS {
            assert!(ids.insert(format!("id{i:05}")));
        }
        assert_eq!(ids.len(), MAX_SESSION_REQUEST_IDS);

        // The evicted oldest id is re-issuable...
        assert!(ids.insert("id00000".to_owned()));
        // ...while the most recent window still dedups.
        assert!(!ids.insert(format!("id{i:05}", i = MAX_SESSION_REQUEST_IDS)));
    }
}
