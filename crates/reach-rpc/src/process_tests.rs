use super::*;
use std::fs;
use tempfile::TempDir;

fn setup(source: &str) -> (TempDir, WorkspaceFilesystem, ProcessManager, Value) {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("main.cjs"), source).unwrap();
    let workspace =
        WorkspaceFilesystem::new(HashMap::from([("fixture".into(), temp.path().to_owned())]));
    let mut policy = ProcessPolicy::default();
    policy.workspaces = vec!["fixture".into()];
    if let Ok(path) = std::env::var("REACH_TEST_NODE_BIN") {
        policy.node = path.into();
    }
    if !policy.node.is_file() {
        let output = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is required for process tests");
        policy.node = String::from_utf8(output.stdout).unwrap().trim().into();
    }
    assert!(
        policy.node.is_file(),
        "Tests require the installed private runtime or REACH_TEST_NODE_BIN"
    );
    policy.grace_ms = 40;
    let params = json!({"workspace":"fixture","script":"main.cjs","launchId":"launch-test"});
    (temp, workspace, ProcessManager::new(policy), params)
}

#[test]
fn omitted_timeout_respects_the_local_runtime_ceiling() {
    let (_temp, workspace, mut manager, mut params) = setup("setInterval(()=>{},1000)");
    manager.policy.max_runtime_ms = 80;
    let result = manager.run(&params, &workspace).unwrap();
    let id = result["processId"].as_str().unwrap();
    assert_eq!(finished(&manager, id)["state"], "timed_out");
    params["launchId"] = json!("explicit-timeout");
    params["timeoutMs"] = json!(81);
    assert!(manager.run(&params, &workspace).is_err());
}
fn finished(manager: &ProcessManager, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let s = manager.status(&json!({"processId":id})).unwrap();
        if matches!(
            s["state"].as_str(),
            Some("exited" | "stopped" | "timed_out" | "failed")
        ) {
            return s;
        }
        assert!(Instant::now() < deadline, "task did not finish: {s}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn output(manager: &ProcessManager, id: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let r = manager.logs(&json!({"processId":id})).unwrap();
        if r["eof"] == true {
            return r["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["text"].as_str().unwrap())
                .collect();
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn bootstrap_preserves_module_paths_arguments_and_snapshot() {
    for ext in ["cjs", "mjs", "js"] {
        let source = if ext == "mjs" {
            "import value from './dep.mjs'; console.log(value,process.argv[2],import.meta.url);"
        } else {
            "if(require.main!==module)throw Error('not main'); console.log(require('./dep.cjs'),process.argv[2],__filename);"
        };
        let (temp, workspace, mut manager, mut p) = setup(source);
        fs::write(temp.path().join("dep.cjs"), "module.exports='module-ok'").unwrap();
        fs::write(temp.path().join("dep.mjs"), "export default 'module-ok'").unwrap();
        fs::write(temp.path().join(format!("entry.{ext}")), source).unwrap();
        p["script"] = json!(format!("entry.{ext}"));
        p["args"] = json!(["argument-ok"]);
        let r = manager.run(&p, &workspace).unwrap();
        let id = r["processId"].as_str().unwrap();
        assert_eq!(finished(&manager, id)["exitCode"], 0);
        let text = output(&manager, id);
        assert!(text.contains("module-ok argument-ok"), "{text}");
        assert!(text.contains(&format!("entry.{ext}")));
        // Bootstrap must consume supplied snapshot, not the on-disk bytes.
        let entry = temp.path().join(format!("entry.{ext}"));
        fs::write(&entry, "throw Error('wrong-entry')").unwrap();
        #[cfg(unix)]
        {
            let substitute = temp.path().join(format!("substitute.{ext}"));
            fs::write(&substitute, "throw Error('substituted entry')").unwrap();
            fs::remove_file(&entry).unwrap();
            std::os::unix::fs::symlink(substitute, &entry).unwrap();
        }
        let mut child = Command::new(&manager.policy.node)
            .args(["--preserve-symlinks-main", "--eval", BOOTSTRAP, "--"])
            .arg(&entry)
            .arg("argument-ok")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(source.as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("module-ok argument-ok"));
    }
}

#[test]
fn launches_deduplicate_conflict_and_remain_owner_scoped() {
    let (_temp, workspace, mut manager, p) = setup("console.log('done');process.exitCode=7");
    let r = manager.run(&p, &workspace).unwrap();
    let id = r["processId"].as_str().unwrap();
    assert_eq!(finished(&manager, id)["exitCode"], 7);
    assert_eq!(manager.run(&p, &workspace).unwrap()["processId"], id);
    let mut changed = p.clone();
    changed["args"] = json!(["changed"]);
    assert_eq!(
        manager.run(&changed, &workspace).unwrap_err().code,
        "LAUNCH_ID_CONFLICT"
    );
    assert_eq!(
        manager.status(&json!({"launchId":"launch-test"})).unwrap()["processId"],
        id
    );
    let other = ProcessManager::default();
    assert_eq!(
        other.status(&json!({"processId":id})).unwrap_err().code,
        "PROCESS_NOT_FOUND"
    );
    assert_eq!(
        manager.stop(&json!({"processId":id})).unwrap()["state"],
        "exited"
    );
    manager.drain().unwrap();
    assert_eq!(
        manager.status(&json!({"processId":id})).unwrap_err().code,
        "PROCESS_NOT_FOUND"
    );
}

#[test]
fn opt_in_revision_runtime_paths_environment_and_limits() {
    let (temp,workspace,mut manager,p)=setup("console.log(process.env.REACH_ENGINE_TOKEN,process.env.NODE_OPTIONS,process.env.NODE_PATH);console.log('ok')");
    manager.policy.workspaces.clear();
    assert_eq!(
        manager.run(&p, &workspace).unwrap_err().code,
        "PROCESS_EXECUTION_DISABLED"
    );
    manager.policy.workspaces.push("fixture".into());
    let mut stale = p.clone();
    stale["ifMatch"] = json!("0".repeat(64));
    assert_eq!(
        manager.run(&stale, &workspace).unwrap_err().code,
        "REVISION_CONFLICT"
    );
    let mut escape = p.clone();
    escape["cwd"] = json!("../");
    assert_eq!(
        manager.run(&escape, &workspace).unwrap_err().code,
        "INVALID_PARAMS"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.path().join("main.cjs"), temp.path().join("link.cjs"))
            .unwrap();
        escape = p.clone();
        escape["script"] = json!("link.cjs");
        assert_eq!(
            manager.run(&escape, &workspace).unwrap_err().code,
            "WORKSPACE_ACCESS_DENIED"
        );
    }
    let r = manager.run(&p, &workspace).unwrap();
    let id = r["processId"].as_str().unwrap();
    finished(&manager, id);
    assert!(output(&manager, id).contains("undefined undefined undefined"));
    manager.policy.max_records = 1;
    let mut next = p.clone();
    next["launchId"] = json!("next");
    assert_eq!(
        manager.run(&next, &workspace).unwrap_err().code,
        "PROCESS_LIMIT_EXCEEDED"
    );
    manager.drain().unwrap();
    manager.policy.node = temp.path().join("missing-node");
    assert_eq!(
        manager.run(&p, &workspace).unwrap_err().code,
        "RUNTIME_UNAVAILABLE"
    );
    assert_eq!(
        manager.run(&p, &workspace).unwrap_err().code,
        "RUNTIME_UNAVAILABLE"
    );
    let status = manager.status(&json!({"launchId":p["launchId"]})).unwrap();
    assert_eq!(status["state"], "failed");
    assert_eq!(status["reason"], "RUNTIME_UNAVAILABLE");
}

#[test]
fn stop_timeout_and_session_drop_terminate_groups() {
    let (_temp,workspace,mut manager,p)=setup("const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(child.pid);setInterval(()=>{},1000);");
    let r = manager.run(&p, &workspace).unwrap();
    let id = r["processId"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while manager.logs(&json!({"processId":id})).unwrap()["records"]
        .as_array()
        .unwrap()
        .is_empty()
    {
        assert!(Instant::now() < deadline, "script did not report child PID");
        thread::sleep(Duration::from_millis(10));
    }
    manager.stop(&json!({"processId":id})).unwrap();
    assert_eq!(finished(&manager, id)["state"], "stopped");
    assert!(!output(&manager, id).is_empty());
    assert_eq!(
        manager.stop(&json!({"processId":id})).unwrap()["state"],
        "stopped"
    );
    let mut next = p.clone();
    next["launchId"] = json!("timeout");
    next["timeoutMs"] = json!(80);
    let r = manager.run(&next, &workspace).unwrap();
    assert_eq!(
        finished(&manager, r["processId"].as_str().unwrap())["state"],
        "timed_out"
    );
    next["launchId"] = json!("drop");
    next["timeoutMs"] = json!(60_000);
    manager.run(&next, &workspace).unwrap();
    let began = Instant::now();
    drop(manager);
    assert!(began.elapsed() < Duration::from_secs(2));
}

#[test]
fn output_flood_is_bounded_and_eof_waits_for_collectors() {
    let (_temp,workspace,mut manager,p)=setup("process.stdout.write(Buffer.alloc(50000,65));process.stderr.write(Buffer.from([255,254]));");
    manager.policy.log_bytes = 2048;
    let r = manager.run(&p, &workspace).unwrap();
    let id = r["processId"].as_str().unwrap();
    finished(&manager, id);
    let text = output(&manager, id);
    assert!(text.len() <= 2048);
    let logs = manager.logs(&json!({"processId":id})).unwrap();
    assert_eq!(logs["truncated"], true);
    assert_eq!(logs["eof"], true);
    assert_eq!(
        manager
            .logs(&json!({"processId":id,"cursor":"foreign"}))
            .unwrap_err()
            .code,
        "INVALID_CURSOR"
    );
}

#[test]
fn policy_rejects_invalid_bounds_and_defaults_to_disabled() {
    assert!(ProcessPolicy::default().workspaces.is_empty());
    for (key, value) in [
        ("REACH_PROCESS_NODE_BIN", "node"),
        ("REACH_PROCESS_MAX_CONCURRENT", "0"),
        ("REACH_PROCESS_MAX_LOG_BYTES", "invalid"),
    ] {
        assert!(ProcessPolicy::parse(&|k| (k == key).then(|| value.into())).is_err());
    }
}

#[test]
fn gateway_execution_claim_cannot_enable_local_workspace() {
    let (_temp, mut workspace, _manager, params) = setup("console.log('not allowed')");
    let mut session = crate::SessionContext::new("owner".into(), 1_000_000, 0, &mut workspace);
    let mut dispatcher = crate::SessionDispatcher::new(
        "owner".into(),
        crate::default_registry(),
        Duration::from_secs(30),
    );
    let request = crate::parse_request_envelope(&json!({"type":"request","protocol":"reach-rpc","version":"1.0","sessionId":"owner","requestId":"run","method":"process.run","params":params,"permission":{"grantId":"gateway-checked","kind":"execute"}}).to_string()).unwrap();
    assert_eq!(
        dispatcher.dispatch(&mut session, &request, 0).unwrap_err(),
        "PROCESS_EXECUTION_DISABLED"
    );
}

#[test]
fn failed_bounded_drain_retains_owned_records_until_cleanup_finishes() {
    let (_temp, workspace, mut manager, params) = setup("console.log('done')");
    let task = manager.run(&params, &workspace).unwrap();
    let id = task["processId"].as_str().unwrap();
    finished(&manager, id);
    let managed = manager.tasks.get_mut(id).unwrap();
    managed.worker.take().unwrap().join().unwrap();
    let (release, pending) = std::sync::mpsc::channel();
    managed.worker = Some(thread::spawn(move || {
        pending.recv().unwrap();
    }));
    assert_eq!(manager.drain().unwrap_err().code, "PROCESS_CLEANUP_FAILED");
    assert!(manager.status(&json!({"processId":id})).is_ok());
    release.send(()).unwrap();
    manager.drain().unwrap();
    assert_eq!(
        manager.status(&json!({"processId":id})).unwrap_err().code,
        "PROCESS_NOT_FOUND"
    );
}

#[test]
fn log_pagination_handles_partial_records_and_split_unicode() {
    let (_temp, workspace, mut manager, p) =
        setup("process.stdout.write('ab界cd');setTimeout(()=>process.stdout.write('ef'),10)");
    let task = manager.run(&p, &workspace).unwrap();
    let id = task["processId"].as_str().unwrap();
    finished(&manager, id);
    let mut cursor = None;
    let mut text = String::new();
    for _ in 0..20 {
        let mut args = json!({"processId":id,"maxBytes":4});
        if let Some(value) = cursor {
            args["cursor"] = value;
        }
        let result = manager.logs(&args).unwrap();
        for record in result["records"].as_array().unwrap() {
            text.push_str(record["text"].as_str().unwrap());
        }
        if result["eof"] == true {
            break;
        }
        cursor = Some(result["nextCursor"].clone());
    }
    assert_eq!(text, "ab界cdef");
}

#[test]
fn concurrency_limit_and_dispatch_authorization_are_independent() {
    use crate::dispatch::authorizer::authorize;
    use crate::{AccessClass, Permission, ToolDescriptor};
    let (_temp, workspace, mut manager, p) = setup("setInterval(()=>{},1000)");
    manager.policy.concurrency = 1;
    manager.run(&p, &workspace).unwrap();
    let mut next = p.clone();
    next["launchId"] = json!("next");
    assert_eq!(
        manager.run(&next, &workspace).unwrap_err().code,
        "PROCESS_LIMIT_EXCEEDED"
    );
    let mut descriptor = ToolDescriptor::read("process.run");
    descriptor.access = AccessClass::Execute;
    assert!(authorize(
        &descriptor,
        Some(&Permission {
            grant_id: "file-grant".into(),
            kind: None
        })
    )
    .is_err());
    assert!(authorize(
        &descriptor,
        Some(&Permission {
            grant_id: "execution-grant".into(),
            kind: Some("execute".into())
        })
    )
    .is_ok());
    descriptor.access = AccessClass::ProcessControl;
    assert!(authorize(
        &descriptor,
        Some(&Permission {
            grant_id: "execution-grant".into(),
            kind: Some("execute".into())
        })
    )
    .is_err());
}
