use super::*;

impl ProcessManager {
    pub fn run(&mut self, value: &Value, workspace: &WorkspaceFilesystem) -> Result<Value> {
        let mut p = RunParams::parse(value)?.normalized();
        if value.get("timeoutMs").is_none() {
            p.timeout_ms = p.timeout_ms.min(self.policy.max_runtime_ms);
        }
        if let Some(id) = self.launches.get(&p.launch_id) {
            let t = self.tasks[id]
                .task
                .lock()
                .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?;
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
                .filter(|m| m.task.lock().map_or(true, |task| !task.terminal()))
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
                let mut t = task.lock().map_err(|_| error("PROCESS_CLEANUP_FAILED"))?;
                t.status.state = "failed".into();
                t.status.reason = Some("RUNTIME_UNAVAILABLE".into());
                t.status.ended_at = Some(timestamp());
                t.pipes = 0;
                return Err(error("RUNTIME_UNAVAILABLE"));
            }
        };
        task.lock()
            .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?
            .status
            .state = "running".into();
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
        let result = json!(
            task.lock()
                .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?
                .status
        );
        Ok(result)
    }
}
