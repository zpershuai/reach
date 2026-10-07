//! Session-owned trusted Node execution. Workspace validation is not a sandbox.
use crate::{dispatch::ToolError, WorkspaceFilesystem};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone)]
pub struct ProcessPolicy {
    pub workspaces: Vec<String>,
    pub node: PathBuf,
    pub concurrency: usize,
    pub max_runtime_ms: u64,
    pub max_records: usize,
    pub log_bytes: usize,
    pub grace_ms: u64,
}
impl Default for ProcessPolicy {
    fn default() -> Self {
        let node = crate::default_workspace_root()
            .parent()
            .unwrap()
            .join("runtime/node/bin/node");
        let node = if node.is_absolute() {
            node
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("/"))
                .join(node)
        };
        Self {
            workspaces: vec![],
            node,
            concurrency: 4,
            max_runtime_ms: 300_000,
            max_records: 128,
            log_bytes: 1024 * 1024,
            grace_ms: 2000,
        }
    }
}
impl ProcessPolicy {
    pub fn parse(lookup: &dyn Fn(&str) -> Option<String>) -> std::result::Result<Self, String> {
        let mut policy = Self::default();
        if let Some(value) = lookup("REACH_PROCESS_WORKSPACES") {
            policy.workspaces = value
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
        }
        if let Some(value) = lookup("REACH_PROCESS_NODE_BIN") {
            policy.node = PathBuf::from(value);
        }
        if !policy.node.is_absolute() {
            return Err("REACH_PROCESS_NODE_BIN must be absolute".into());
        }
        fn number(
            lookup: &dyn Fn(&str) -> Option<String>,
            key: &str,
            default: u64,
            max: u64,
        ) -> std::result::Result<u64, String> {
            let value = lookup(key)
                .map(|s| s.parse::<u64>())
                .transpose()
                .map_err(|_| format!("invalid {key}"))?
                .unwrap_or(default);
            if value == 0 || value > max {
                return Err(format!("{key} must be in 1..={max}"));
            }
            Ok(value)
        }
        policy.concurrency = number(lookup, "REACH_PROCESS_MAX_CONCURRENT", 4, 64)? as usize;
        policy.max_runtime_ms =
            number(lookup, "REACH_PROCESS_MAX_RUNTIME_MS", 300_000, 86_400_000)?;
        policy.max_records = number(lookup, "REACH_PROCESS_MAX_RECORDS", 128, 1024)? as usize;
        policy.log_bytes = number(
            lookup,
            "REACH_PROCESS_MAX_LOG_BYTES",
            1024 * 1024,
            16 * 1024 * 1024,
        )? as usize;
        policy.grace_ms = number(lookup, "REACH_PROCESS_STOP_GRACE_MS", 2000, 10_000)?;
        Ok(policy)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunParams {
    pub workspace: String,
    pub script: String,
    pub launch_id: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "root_cwd")]
    pub cwd: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_match: Option<String>,
}
fn root_cwd() -> String {
    ".".into()
}
fn default_timeout() -> u64 {
    60_000
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    if !value.is_object() || value.as_object().unwrap().values().any(Value::is_null) {
        return Err(error("INVALID_PARAMS"));
    }
    serde_json::from_value(value.clone()).map_err(|_| error("INVALID_PARAMS"))
}
fn valid_id(s: &str) -> bool {
    bounded(s) && s.len() <= 128
}
fn bounded(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.contains('\0')
}
fn relative(s: &str) -> bool {
    bounded(s) && !s.starts_with('/') && !s.split('/').any(|c| c == "..")
}
impl RunParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut p: Self = decode(value)?;
        if !bounded(&p.workspace)
            || !relative(&p.script)
            || !relative(&p.cwd)
            || !bounded(&p.launch_id)
            || p.launch_id.len() > 128
            || p.timeout_ms == 0
            || p.timeout_ms > 86_400_000
            || p.args.len() > 128
            || p.args.iter().any(|s| s.len() > 4096 || s.contains('\0'))
            || p.args.iter().map(String::len).sum::<usize>() > 32 * 1024
            || p.if_match.as_ref().is_some_and(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
        {
            return Err(error("INVALID_PARAMS"));
        }
        fn normalized(s: &str) -> String {
            let parts: Vec<_> = s
                .split('/')
                .filter(|s| !s.is_empty() && *s != ".")
                .collect();
            if parts.is_empty() {
                ".".into()
            } else {
                parts.join("/")
            }
        }
        p.script = normalized(&p.script);
        p.cwd = normalized(&p.cwd);
        Ok(p)
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusParams {
    pub process_id: Option<String>,
    pub launch_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopParams {
    pub process_id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogsParams {
    pub process_id: String,
    pub cursor: Option<String>,
    pub max_bytes: Option<usize>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    pub workspace: Option<String>,
    pub cursor: Option<String>,
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub process_id: String,
    pub launch_id: String,
    pub workspace: String,
    pub script: String,
    pub state: String,
    pub started_at: String,
    pub deadline_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: Option<String>,
}
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    sequence: u64,
    stream: &'static str,
    text: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogsResult {
    pub records: Vec<LogRecord>,
    pub next_cursor: String,
    pub truncated: bool,
    pub eof: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListResult {
    pub processes: Vec<TaskStatus>,
    pub next_cursor: Option<String>,
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
            .any(|m| !m.task.lock().unwrap().terminal())
    }
    pub fn run(&mut self, value: &Value, workspace: &WorkspaceFilesystem) -> Result<Value> {
        let mut p = RunParams::parse(value)?;
        if value.get("timeoutMs").is_none() {
            p.timeout_ms = p.timeout_ms.min(self.policy.max_runtime_ms);
        }
        if let Some(id) = self.launches.get(&p.launch_id) {
            let t = self.tasks[id].task.lock().unwrap();
            if t.params != p {
                return Err(error("LAUNCH_ID_CONFLICT"));
            }
            if t.status.reason.as_deref() == Some("RUNTIME_UNAVAILABLE") {
                return Err(error("RUNTIME_UNAVAILABLE"));
            }
            return Ok(json!(t.status));
        }
        if !cfg!(unix) {
            return Err(error("PROCESS_UNSUPPORTED"));
        }
        if !self.policy.workspaces.contains(&p.workspace) {
            return Err(error("PROCESS_EXECUTION_DISABLED"));
        }
        if p.timeout_ms > self.policy.max_runtime_ms {
            return Err(error("INVALID_PARAMS"));
        }
        if self.tasks.len() >= self.policy.max_records
            || self
                .tasks
                .values()
                .filter(|m| !m.task.lock().unwrap().terminal())
                .count()
                >= self.policy.concurrency
        {
            return Err(error("PROCESS_LIMIT_EXCEEDED"));
        }
        if !matches!(
            std::path::Path::new(&p.script)
                .extension()
                .and_then(|s| s.to_str()),
            Some("js" | "mjs" | "cjs")
        ) {
            return Err(error("INVALID_PARAMS"));
        }
        let (entry, cwd, source, directory) = workspace
            .process_entry(&p.workspace, &p.script, &p.cwd)
            .map_err(|e| error(e.code))?;
        if p.if_match
            .as_ref()
            .is_some_and(|revision| *revision != crate::workspace::revision_str(&source))
        {
            return Err(error("REVISION_CONFLICT"));
        }
        let id = Uuid::new_v4().to_string();
        let status = TaskStatus {
            process_id: id.clone(),
            launch_id: p.launch_id.clone(),
            workspace: p.workspace.clone(),
            script: p.script.clone(),
            state: "starting".into(),
            started_at: timestamp(),
            deadline_at: deadline_timestamp(p.timeout_ms),
            ended_at: None,
            exit_code: None,
            signal: None,
            reason: None,
        };
        let task = Arc::new(Mutex::new(Task {
            params: p.clone(),
            status,
            stop: None,
            timed_out: false,
            output: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            pipes: 2,
        }));
        self.launches.insert(p.launch_id.clone(), id.clone());
        self.tasks.insert(
            id.clone(),
            Managed {
                task: task.clone(),
                worker: None,
            },
        );
        let mut command = Command::new(&self.policy.node);
        command
            .args(["--preserve-symlinks-main", "--eval", BOOTSTRAP, "--"])
            .arg(&entry)
            .args(&p.args)
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin",
                    self.policy.node.parent().unwrap().display()
                ),
            )
            .env("HOME", &cwd)
            .env("TMPDIR", &cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            // fchdir is async-signal-safe and binds cwd to the validated inode.
            unsafe {
                command.pre_exec(move || {
                    rustix::process::fchdir(&directory).map_err(std::io::Error::from)
                });
            }
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let mut t = task.lock().unwrap();
                t.status.state = "failed".into();
                t.status.reason = Some("RUNTIME_UNAVAILABLE".into());
                t.status.ended_at = Some(timestamp());
                t.pipes = 0;
                return Err(error("RUNTIME_UNAVAILABLE"));
            }
        };
        task.lock().unwrap().status.state = "running".into();
        let mut input = child.stdin.take().unwrap();
        // Snapshot transport is bounded by workspace MAX_FILE_BYTES. It runs off
        // the serial RPC worker so a slow runtime cannot block status/stop.
        let writer = thread::spawn(move || {
            let _ = input.write_all(source.as_bytes());
        });
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let cap = self.policy.log_bytes;
        let out = collect(stdout, task.clone(), "stdout", cap);
        let err = collect(stderr, task.clone(), "stderr", cap);
        let grace = Duration::from_millis(self.policy.grace_ms);
        let worker_task = task.clone();
        let worker = thread::spawn(move || {
            supervise(
                &mut child,
                &worker_task,
                Duration::from_millis(p.timeout_ms),
                grace,
            );
            let _ = writer.join();
            let _ = out.join();
            let _ = err.join();
        });
        self.tasks.get_mut(&id).unwrap().worker = Some(worker);
        let result = json!(task.lock().unwrap().status);
        Ok(result)
    }
    fn find(&self, id: &str) -> Result<&Managed> {
        self.tasks.get(id).ok_or_else(|| error("PROCESS_NOT_FOUND"))
    }
    pub fn status(&self, value: &Value) -> Result<Value> {
        let p: StatusParams = decode(value)?;
        let id = match (p.process_id, p.launch_id) {
            (Some(id), None) if valid_id(&id) => id,
            (None, Some(id)) if valid_id(&id) => self
                .launches
                .get(&id)
                .cloned()
                .ok_or_else(|| error("PROCESS_NOT_FOUND"))?,
            _ => return Err(error("INVALID_PARAMS")),
        };
        Ok(json!(self.find(&id)?.task.lock().unwrap().status))
    }
    pub fn stop(&self, value: &Value) -> Result<Value> {
        let p: StopParams = decode(value)?;
        if !valid_id(&p.process_id) {
            return Err(error("INVALID_PARAMS"));
        }
        let mut t = self.find(&p.process_id)?.task.lock().unwrap();
        if !t.terminal() && t.stop.is_none() {
            t.stop = Some(Instant::now());
            t.status.state = "stopping".into();
        }
        Ok(json!(t.status))
    }
    pub fn logs(&self, value: &Value) -> Result<Value> {
        let p: LogsParams = decode(value)?;
        if !valid_id(&p.process_id) || p.cursor.as_ref().is_some_and(|cursor| cursor.len() > 4096) {
            return Err(error("INVALID_PARAMS"));
        }
        let max = p.max_bytes.unwrap_or(16 * 1024);
        if max == 0 || max > 16 * 1024 {
            return Err(error("INVALID_PARAMS"));
        }
        let t = self.find(&p.process_id)?.task.lock().unwrap();
        let prefix = format!("{}:{}:", self.scope, p.process_id);
        let (cursor, mut offset) = match p.cursor {
            None => (0, 0),
            Some(c) => c
                .strip_prefix(&prefix)
                .and_then(|s| s.split_once(':'))
                .and_then(|(sequence, offset)| {
                    Some((sequence.parse::<u64>().ok()?, offset.parse::<usize>().ok()?))
                })
                .filter(|(sequence, _)| *sequence <= t.sequence)
                .ok_or_else(|| error("INVALID_CURSOR"))?,
        };
        let first = t.output.front().map(|r| r.sequence).unwrap_or(t.sequence);
        let mut next = cursor.max(first);
        if cursor < first {
            offset = 0;
        }
        if next == t.sequence && offset != 0 {
            return Err(error("INVALID_CURSOR"));
        }
        let mut bytes = 0;
        let mut records = vec![];
        for record in t
            .output
            .iter()
            .filter(|record| record.sequence >= cursor.max(first))
        {
            if offset > record.text.len() || !record.text.is_char_boundary(offset) {
                return Err(error("INVALID_CURSOR"));
            }
            let available = &record.text[offset..];
            let mut end = available.len().min(max - bytes);
            while !available.is_char_boundary(end) {
                end -= 1;
            }
            if end == 0 && !available.is_empty() {
                if records.is_empty() {
                    return Err(error("INVALID_PARAMS"));
                }
                break;
            }
            records.push(LogRecord {
                sequence: record.sequence,
                stream: record.stream,
                text: available[..end].into(),
            });
            bytes += end;
            if end < available.len() {
                next = record.sequence;
                offset += end;
                break;
            }
            next = record.sequence + 1;
            offset = 0;
            if bytes == max {
                break;
            }
        }
        Ok(
            json!({"records":records,"nextCursor":format!("{prefix}{next}:{offset}"),"truncated":cursor<first,"eof":t.pipes==0&&next>=t.sequence}),
        )
    }

    pub fn list(&self, value: &Value) -> Result<Value> {
        let p: ListParams = decode(value)?;
        if p.workspace
            .as_ref()
            .is_some_and(|workspace| !bounded(workspace))
            || p.cursor.as_ref().is_some_and(|cursor| cursor.len() > 8192)
        {
            return Err(error("INVALID_PARAMS"));
        }
        let max = p.max_entries.unwrap_or(50);
        if max == 0 || max > 128 {
            return Err(error("INVALID_PARAMS"));
        }
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
            .map(|m| m.task.lock().unwrap().status.clone())
            .filter(|s| p.workspace.as_ref().is_none_or(|w| w == &s.workspace))
            .collect();
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
        for managed in self.tasks.values() {
            let mut task = managed.task.lock().unwrap();
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

fn append_output(task: &Arc<Mutex<Task>>, stream: &'static str, text: String, cap: usize) {
    if text.is_empty() {
        return;
    }
    let mut t = task.lock().unwrap();
    let sequence = t.sequence;
    t.sequence += 1;
    t.bytes += text.len();
    t.output.push_back(LogRecord {
        sequence,
        stream,
        text,
    });
    while t.bytes > cap {
        if let Some(record) = t.output.pop_front() {
            t.bytes -= record.text.len();
        } else {
            break;
        }
    }
}
fn collect<R: Read + Send + 'static>(
    mut pipe: R,
    task: Arc<Mutex<Task>>,
    stream: &'static str,
    cap: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        let mut pending = Vec::new();
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(text) => {
                                append_output(&task, stream, text.into(), cap);
                                pending.clear();
                                break;
                            }
                            Err(error) => {
                                let valid = error.valid_up_to();
                                if valid > 0 {
                                    append_output(
                                        &task,
                                        stream,
                                        String::from_utf8(pending.drain(..valid).collect())
                                            .unwrap(),
                                        cap,
                                    );
                                }
                                if let Some(length) = error.error_len() {
                                    pending.drain(..length);
                                    append_output(&task, stream, "\u{fffd}".into(), cap);
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        append_output(
            &task,
            stream,
            String::from_utf8_lossy(&pending).into_owned(),
            cap,
        );
        task.lock().unwrap().pipes -= 1;
    })
}
#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        kill(-(pid as i32), signal);
    }
}
#[cfg(not(unix))]
fn signal_group(_pid: u32, _signal: i32) {}
fn supervise(child: &mut Child, task: &Arc<Mutex<Task>>, timeout: Duration, grace: Duration) {
    let started = Instant::now();
    let mut signaled = false;
    let mut killed = false;
    loop {
        // Do not reap the leader until all required group signaling completes:
        // its PID/group identity cannot be recycled while still owned here.
        let mut t = task.lock().unwrap();
        if started.elapsed() >= timeout && t.stop.is_none() {
            t.stop = Some(Instant::now());
            t.timed_out = true;
            t.status.state = "stopping".into();
        }
        if let Some(at) = t.stop {
            if !signaled {
                signal_group(child.id(), 15);
                signaled = true;
            }
            if at.elapsed() >= grace && !killed {
                signal_group(child.id(), 9);
                killed = true;
            }
            if !killed {
                drop(t);
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }
        #[cfg(unix)]
        let ready = {
            use rustix::process::{waitid, Pid, WaitId, WaitIdOptions};
            waitid(
                WaitId::Pid(Pid::from_raw(child.id() as i32).unwrap()),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .map(|status| status.is_some())
        };
        #[cfg(not(unix))]
        let ready: std::io::Result<bool> = Ok(false);
        match ready {
            Ok(false) => {
                drop(t);
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => {
                signal_group(child.id(), 9);
            }
            Ok(true) => {
                if !signaled {
                    signal_group(child.id(), 9);
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // A naturally exited leader may leave ordinary descendants.
                // Group cleanup happens before this terminal record is exposed.
                t.status.exit_code = status.code();
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    t.status.signal = status.signal();
                }
                t.status.state = if t.timed_out {
                    "timed_out"
                } else if t.stop.is_some() {
                    "stopped"
                } else {
                    "exited"
                }
                .into();
                t.status.ended_at = Some(timestamp());
                break;
            }
            Ok(None) => {}
            Err(_) => {
                t.status.state = "failed".into();
                t.status.reason = Some("PROCESS_WAIT_FAILED".into());
                signal_group(child.id(), 9);
                let _ = child.wait();
                break;
            }
        }
        drop(t);
        thread::sleep(Duration::from_millis(10));
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
