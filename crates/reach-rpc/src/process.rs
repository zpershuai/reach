//! Session-owned trusted Node execution. Workspace validation is not a sandbox.
mod logs;
mod policy;
mod spawn;
mod supervision;
use logs::collect;
pub use policy::ProcessPolicy;
use supervision::supervise;

pub use crate::process_contract::{
    ListParams, LogRecord, LogsParams, ProcessListResult, ProcessLogsResult, RunParams,
    StatusParams, StopParams, TaskStatus,
};
use crate::{dispatch::ToolError, WorkspaceFilesystem};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ToolError>;
fn error(code: &str) -> ToolError {
    ToolError::new(code)
}
pub const BOOTSTRAP: &str = include_str!("process-bootstrap.cjs");

fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
fn deadline_timestamp(ms: u64) -> String {
    (time::OffsetDateTime::now_utc() + time::Duration::milliseconds(ms as i64))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

struct Task {
    params: RunParams,
    status: TaskStatus,
    stop: Option<Instant>,
    timed_out: bool,
    output: VecDeque<LogRecord>,
    bytes: usize,
    sequence: u64,
    pipes: usize,
}
impl Task {
    fn terminal(&self) -> bool {
        matches!(
            self.status.state.as_str(),
            "exited" | "stopped" | "timed_out" | "failed"
        )
    }
}
struct Managed {
    task: Arc<Mutex<Task>>,
    worker: Option<thread::JoinHandle<()>>,
}
pub struct ProcessManager {
    policy: ProcessPolicy,
    tasks: HashMap<String, Managed>,
    launches: HashMap<String, String>,
    scope: String,
}
impl Default for ProcessManager {
    fn default() -> Self {
        Self::new(ProcessPolicy::default())
    }
}
impl ProcessManager {
    pub fn new(policy: ProcessPolicy) -> Self {
        Self {
            policy,
            tasks: HashMap::new(),
            launches: HashMap::new(),
            scope: Uuid::new_v4().to_string(),
        }
    }
    pub fn active(&self) -> bool {
        self.tasks
            .values()
            .any(|m| m.task.lock().map_or(true, |task| !task.terminal()))
    }
    fn find(&self, id: &str) -> Result<&Managed> {
        self.tasks.get(id).ok_or_else(|| error("PROCESS_NOT_FOUND"))
    }
    pub fn status(&self, value: &Value) -> Result<Value> {
        let p = StatusParams::parse(value)?;
        let id = match (p.process_id, p.launch_id) {
            (Some(id), None) => id,
            (None, Some(id)) => self
                .launches
                .get(&id)
                .cloned()
                .ok_or_else(|| error("PROCESS_NOT_FOUND"))?,
            _ => return Err(error("INVALID_PARAMS")),
        };
        Ok(json!(
            self.find(&id)?
                .task
                .lock()
                .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?
                .status
        ))
    }
    pub fn stop(&self, value: &Value) -> Result<Value> {
        let p = StopParams::parse(value)?;
        let mut t = self
            .find(&p.process_id)?
            .task
            .lock()
            .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?;
        if !t.terminal() && t.stop.is_none() {
            t.stop = Some(Instant::now());
            t.status.state = "stopping".into();
        }
        Ok(json!(t.status))
    }
    pub fn list(&self, value: &Value) -> Result<Value> {
        let p = ListParams::parse(value)?;
        let max = p.max_entries.unwrap_or(50);
        let prefix = format!(
            "{}:list:{}:",
            self.scope,
            p.workspace.as_deref().unwrap_or("")
        );
        let start = match p.cursor {
            None => 0,
            Some(c) => c
                .strip_prefix(&prefix)
                .and_then(|s| s.parse::<usize>().ok())
                .ok_or_else(|| error("INVALID_CURSOR"))?,
        };
        let mut records: Vec<_> = self
            .tasks
            .values()
            .map(|m| {
                m.task
                    .lock()
                    .map(|task| task.status.clone())
                    .map_err(|_| error("PROCESS_CLEANUP_FAILED"))
            })
            .collect::<Result<Vec<_>>>()?;
        records.retain(|s| p.workspace.as_ref().is_none_or(|w| w == &s.workspace));
        records.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.process_id.cmp(&b.process_id))
        });
        if start > records.len() {
            return Err(error("INVALID_CURSOR"));
        }
        let end = (start + max).min(records.len());
        Ok(
            json!({"processes":&records[start..end],"nextCursor":if end<records.len(){Some(format!("{prefix}{end}"))}else{None}}),
        )
    }
    pub fn drain(&mut self) -> Result<()> {
        let mut poisoned = false;
        for managed in self.tasks.values() {
            // Poisoned records cannot be trusted for RPC, but retain enough
            // ownership to request termination and join every supervisor.
            let mut task = managed.task.lock().unwrap_or_else(|cause| {
                poisoned = true;
                cause.into_inner()
            });
            if !task.terminal() && task.stop.is_none() {
                task.stop = Some(Instant::now());
                task.status.state = "stopping".into();
            }
        }
        let deadline = Instant::now() + Duration::from_millis(self.policy.grace_ms + 2000);
        while self.tasks.values().any(|managed| {
            managed
                .worker
                .as_ref()
                .is_some_and(|worker| !worker.is_finished())
        }) {
            if Instant::now() >= deadline {
                return Err(error("PROCESS_CLEANUP_FAILED"));
            }
            thread::sleep(Duration::from_millis(10));
        }
        for managed in self.tasks.values_mut() {
            if let Some(worker) = managed.worker.take() {
                worker.join().map_err(|_| error("PROCESS_CLEANUP_FAILED"))?;
            }
        }
        if poisoned {
            return Err(error("PROCESS_CLEANUP_FAILED"));
        }
        self.tasks.clear();
        self.launches.clear();
        Ok(())
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        if let Err(error) = self.drain() {
            eprintln!("Reach process cleanup failed: {}", error.code);
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

static SHUTDOWN_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn shutdown_requested() -> bool {
    SHUTDOWN_REQUESTED.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(unix)]
pub fn install_shutdown_handlers() {
    extern "C" fn request_shutdown(_signal: i32) {
        SHUTDOWN_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    unsafe extern "C" {
        fn signal(signal: i32, handler: usize) -> usize;
    }
    unsafe {
        signal(2, request_shutdown as *const () as usize);
        signal(15, request_shutdown as *const () as usize);
    }
}
#[cfg(not(unix))]
pub fn install_shutdown_handlers() {}
