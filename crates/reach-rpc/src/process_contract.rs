//! Portable process wire DTOs. No process launch or platform I/O occurs here.
use crate::dispatch::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
type Result<T> = std::result::Result<T, ToolError>;
fn error(code: &str) -> ToolError {
    ToolError::new(code)
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
pub(crate) fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    if !value.is_object() || value.as_object().unwrap().values().any(Value::is_null) {
        return Err(error("INVALID_PARAMS"));
    }
    serde_json::from_value(value.clone()).map_err(|_| error("INVALID_PARAMS"))
}
pub(crate) fn valid_id(s: &str) -> bool {
    bounded(s) && s.len() <= 128
}
pub(crate) fn bounded(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.contains('\0')
}
fn relative(s: &str) -> bool {
    bounded(s) && !s.starts_with('/') && !s.split('/').any(|c| c == "..")
}
impl RunParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let p: Self = decode(value)?;
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
        Ok(p)
    }

    /// Execution identity canonicalization; wire round-trips retain original paths.
    pub fn normalized(mut self) -> Self {
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
        self.script = normalized(&self.script);
        self.cwd = normalized(&self.cwd);
        self
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopParams {
    pub process_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogsParams {
    pub process_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub sequence: u64,
    pub stream: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogsResult {
    pub records: Vec<LogRecord>,
    pub next_cursor: String,
    pub truncated: bool,
    pub eof: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListResult {
    pub processes: Vec<TaskStatus>,
    pub next_cursor: Option<String>,
}

impl StatusParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let p: Self = decode(value)?;
        match (&p.process_id, &p.launch_id) {
            (Some(id), None) | (None, Some(id)) if valid_id(id) => Ok(p),
            _ => Err(error("INVALID_PARAMS")),
        }
    }
}
impl StopParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let p: Self = decode(value)?;
        if valid_id(&p.process_id) {
            Ok(p)
        } else {
            Err(error("INVALID_PARAMS"))
        }
    }
}
impl LogsParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let p: Self = decode(value)?;
        if !valid_id(&p.process_id)
            || p.cursor.as_ref().is_some_and(|c| c.len() > 4096)
            || p.max_bytes.is_some_and(|n| !(1..=16384).contains(&n))
        {
            return Err(error("INVALID_PARAMS"));
        }
        Ok(p)
    }
}
impl ListParams {
    pub fn parse(value: &Value) -> Result<Self> {
        let p: Self = decode(value)?;
        if p.workspace.as_ref().is_some_and(|w| !bounded(w))
            || p.cursor.as_ref().is_some_and(|c| c.len() > 8192)
            || p.max_entries.is_some_and(|n| !(1..=128).contains(&n))
        {
            return Err(error("INVALID_PARAMS"));
        }
        Ok(p)
    }
}
