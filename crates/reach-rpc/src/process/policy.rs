use super::*;

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
