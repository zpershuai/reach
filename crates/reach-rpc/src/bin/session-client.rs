//! Manual session-client: POSTs a heartbeat, opens the leased WebSocket,
//! announces readiness, and holds the connection until the Gateway closes it.
//! Useful for driving the Gateway without the full Engine Runtime.

use reach_rpc::{
    resolve_session_endpoint, serialize_session_message, session_ready, GatewayConfig,
    SessionMessage,
};
use serde::Deserialize;
use std::{
    env,
    error::Error,
    io::{Read, Write},
    net::TcpStream,
};
use tungstenite::{connect, Message};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    interval_seconds: u64,
    endpoint: String,
    token: String,
    session_id: String,
}

fn post_heartbeat(base_url: &str) -> Result<HeartbeatResponse, Box<dyn Error>> {
    let authority = base_url
        .strip_prefix("http://")
        .ok_or("session-client requires an http:// gateway URL")?
        .trim_end_matches('/');
    if authority.is_empty() || authority.contains('/') {
        return Err("session-client requires an http:// host and port".into());
    }

    let request_body = r#"{"device":{"id":"reach-session-client","platform":"rust"}}"#;
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

fn run(base_url: &str) -> Result<(), Box<dyn Error>> {
    let heartbeat = post_heartbeat(base_url)?;
    if heartbeat.interval_seconds != 5
        || heartbeat.endpoint.is_empty()
        || heartbeat.token.is_empty()
    {
        return Err("gateway did not issue pending session credentials".into());
    }

    let config = GatewayConfig::new(base_url)?;
    let url = resolve_session_endpoint(&config, &heartbeat.endpoint)?;
    let separator = if url.contains('?') { '&' } else { '?' };
    let session_url = format!("{url}{separator}token={}", heartbeat.token);
    let (mut session, _) = connect(session_url.as_str())?;
    let ready = session_ready(
        &heartbeat.session_id,
        "reach-session-client",
        vec!["default".into()],
        vec!["fs.read".into()],
    );
    let ready_text = serialize_session_message(&SessionMessage::Ready(ready))?;
    session.send(Message::Text(ready_text.into()))?;
    println!("Reach session client connected ({})", heartbeat.session_id);

    loop {
        match session.read()? {
            Message::Close(_) => break,
            Message::Ping(payload) => session.send(Message::Pong(payload))?,
            _ => {}
        }
    }
    println!("Reach session client closed");
    Ok(())
}

fn main() {
    let base_url = env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:8787".to_owned());
    if let Err(error) = run(&base_url) {
        eprintln!("Reach session client failed: {error}");
        std::process::exit(1);
    }
}
