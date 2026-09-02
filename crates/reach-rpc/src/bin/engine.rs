use reach_rpc::{
    default_workspace_root, parse_fs_edit_params, parse_fs_glob_params, parse_fs_grep_params,
    parse_fs_list_params, parse_fs_read_params, parse_fs_stat_params, parse_fs_write_params,
    parse_request_envelope, parse_workspace_roots, RequestEnvelope, WorkspaceFilesystem,
    INVALID_PARAMS, PERMISSION_DENIED,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    error::Error,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    thread,
    time::Duration,
};
use tungstenite::{connect, Message};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    interval_seconds: u64,
    #[serde(default)]
    wss_url: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

fn post_heartbeat(base_url: &str) -> Result<HeartbeatResponse, Box<dyn Error>> {
    let authority = base_url
        .strip_prefix("http://")
        .ok_or("GATEWAY_URL must use the local http:// scheme")?
        .trim_end_matches('/');
    if authority.is_empty() || authority.contains('/') {
        return Err("GATEWAY_URL must contain only an http:// host and port".into());
    }

    let request_body = r#"{"device":{"id":"reach-engine","platform":"rust"}}"#;
    let mut stream = TcpStream::connect(authority)?;
    write!(
        stream,
        "POST /heartbeat HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
        request_body.len()
    )?;
    stream.shutdown(std::net::Shutdown::Write)?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("gateway returned a malformed HTTP response")?;
    if !headers.starts_with("HTTP/1.1 200") {
        return Err(format!("gateway heartbeat failed: {headers}").into());
    }

    Ok(serde_json::from_str(body)?)
}

fn session_credentials(heartbeat: &HeartbeatResponse) -> Option<(String, String, String)> {
    match (
        heartbeat.wss_url.as_deref(),
        heartbeat.token.as_deref(),
        heartbeat.session_id.as_deref(),
    ) {
        (Some(url), Some(token), Some(session_id))
            if !url.is_empty() && !token.is_empty() && !session_id.is_empty() =>
        {
            Some((url.to_owned(), token.to_owned(), session_id.to_owned()))
        }
        _ => None,
    }
}

fn load_workspace() -> Result<WorkspaceFilesystem, Box<dyn Error>> {
    if let Ok(spec) = env::var("REACH_WORKSPACE_ROOTS") {
        let roots = parse_workspace_roots(&spec)?;
        Ok(WorkspaceFilesystem::new(roots))
    } else {
        Ok(WorkspaceFilesystem::with_default_root())
    }
}

fn error_message(request_id: &str, code: &str) -> String {
    json!({
        "type": "error",
        "requestId": request_id,
        "error": { "code": code }
    })
    .to_string()
}

fn response_message(request_id: &str, result: Value) -> String {
    json!({
        "type": "response",
        "requestId": request_id,
        "result": result
    })
    .to_string()
}

fn require_grant(envelope: &RequestEnvelope) -> Result<(), &'static str> {
    if envelope
        .permission
        .as_ref()
        .is_some_and(|permission| !permission.grant_id.is_empty())
    {
        Ok(())
    } else {
        Err(PERMISSION_DENIED)
    }
}

fn dispatch(
    workspace: &mut WorkspaceFilesystem,
    envelope: &RequestEnvelope,
) -> Result<Value, String> {
    dispatch_method(workspace, &envelope.method, &envelope.params, envelope)
}

fn dispatch_method(
    workspace: &mut WorkspaceFilesystem,
    method: &str,
    params: &Value,
    envelope: &RequestEnvelope,
) -> Result<Value, String> {
    let params_json = serde_json::to_string(params).map_err(|_| INVALID_PARAMS.to_owned())?;
    match method {
        "fs.read" => {
            let params = parse_fs_read_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.read(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.list" => {
            let params = parse_fs_list_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.list(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.stat" => {
            let params = parse_fs_stat_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.stat(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.write" => {
            require_grant(envelope).map_err(str::to_owned)?;
            let params = parse_fs_write_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.write(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.edit" => {
            require_grant(envelope).map_err(str::to_owned)?;
            let params = parse_fs_edit_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.edit(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.glob" => {
            let params = parse_fs_glob_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.glob(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "fs.grep" => {
            let params = parse_fs_grep_params(&params_json).map_err(|_| INVALID_PARAMS.to_owned())?;
            let result = workspace.grep(&params).map_err(|error| error.code.to_owned())?;
            serde_json::to_value(result).map_err(|_| INVALID_PARAMS.to_owned())
        }
        "tool.call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| INVALID_PARAMS.to_owned())?;
            let arguments = params
                .get("arguments")
                .ok_or_else(|| INVALID_PARAMS.to_owned())?;
            // Nested tool.call is rejected (matches prior gateway METHOD_NOT_FOUND behavior).
            if name == "tool.call" {
                return Err(INVALID_PARAMS.to_owned());
            }
            if matches!(name, "fs.write" | "fs.edit") {
                require_grant(envelope).map_err(str::to_owned)?;
            }
            dispatch_method(workspace, name, arguments, envelope)
        }
        "session.complete" => Ok(json!({ "ok": true })),
        _ => Err(INVALID_PARAMS.to_owned()),
    }
}

fn handle_session(
    wss_url: &str,
    token: &str,
    session_id: &str,
    workspace: &mut WorkspaceFilesystem,
) -> Result<(), Box<dyn Error>> {
    let separator = if wss_url.contains('?') { '&' } else { '?' };
    let session_url = format!("{wss_url}{separator}token={token}");
    let (mut session, _) = connect(session_url.as_str())?;
    println!("Reach engine session connected ({session_id})");

    loop {
        let message = session.read()?;
        match message {
            Message::Text(text) => {
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    session.send(Message::Text(
                        error_message("", INVALID_PARAMS).into(),
                    ))?;
                    continue;
                };
                let Some(message_type) = value.get("type").and_then(Value::as_str) else {
                    session.send(Message::Text(
                        error_message(
                            value.get("requestId").and_then(Value::as_str).unwrap_or(""),
                            INVALID_PARAMS,
                        )
                        .into(),
                    ))?;
                    continue;
                };
                if message_type != "request" {
                    continue;
                }

                let envelope = match parse_request_envelope(&text) {
                    Ok(envelope) if envelope.session_id == session_id => envelope,
                    Ok(envelope) => {
                        session.send(Message::Text(
                            error_message(&envelope.request_id, INVALID_PARAMS).into(),
                        ))?;
                        continue;
                    }
                    Err(_) => {
                        let request_id = value
                            .get("requestId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        session.send(Message::Text(
                            error_message(request_id, INVALID_PARAMS).into(),
                        ))?;
                        continue;
                    }
                };

                let complete = envelope.method == "session.complete";
                let reply = match dispatch(workspace, &envelope) {
                    Ok(result) => response_message(&envelope.request_id, result),
                    Err(code) => error_message(&envelope.request_id, &code),
                };
                session.send(Message::Text(reply.into()))?;

                if complete {
                    session.send(Message::Text(r#"{"type":"job.done"}"#.into()))?;
                    println!("Reach engine session job done");
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Ping(payload) => session.send(Message::Pong(payload))?,
            _ => {}
        }
    }

    workspace.close();
    println!("Reach engine session closed");
    Ok(())
}

fn run(base_url: &str) -> Result<(), Box<dyn Error>> {
    let mut workspace = load_workspace()?;
    if let Some(default_root) = workspace_default_path() {
        let _ = std::fs::create_dir_all(default_root);
    }
    println!("Reach engine heartbeating {base_url}");

    let mut backoff_secs = 1u64;
    loop {
        match post_heartbeat(base_url) {
            Ok(heartbeat) => {
                backoff_secs = 1;
                let handled_session = if let Some((wss_url, token, session_id)) =
                    session_credentials(&heartbeat)
                {
                    if let Err(error) = handle_session(&wss_url, &token, &session_id, &mut workspace)
                    {
                        eprintln!("Reach engine session failed: {error}");
                    }
                    true
                } else {
                    false
                };
                // After a session, heartbeat immediately so a new session-wanted is not delayed
                // by the prior idle interval. Otherwise honor the gateway interval.
                if !handled_session {
                    thread::sleep(Duration::from_secs(heartbeat.interval_seconds.max(1)));
                }
            }
            Err(error) => {
                eprintln!("Reach engine heartbeat failed: {error}; retrying in {backoff_secs}s");
                thread::sleep(Duration::from_secs(backoff_secs));
                backoff_secs = (backoff_secs.saturating_mul(2)).min(60);
            }
        }
    }
}

fn workspace_default_path() -> Option<PathBuf> {
    if env::var_os("REACH_WORKSPACE_ROOTS").is_some() {
        None
    } else {
        Some(default_workspace_root())
    }
}

fn main() {
    let base_url = env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:8787".to_owned());
    if let Err(error) = run(&base_url) {
        eprintln!("Reach engine failed: {error}");
        std::process::exit(1);
    }
}
