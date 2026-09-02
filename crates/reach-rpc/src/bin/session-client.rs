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
    wss_url: String,
    token: String,
}

fn post_heartbeat(base_url: &str) -> Result<HeartbeatResponse, Box<dyn Error>> {
    let authority = base_url
        .strip_prefix("http://")
        .ok_or("GATEWAY_URL must use the local http:// scheme")?
        .trim_end_matches('/');
    if authority.is_empty() || authority.contains('/') {
        return Err("GATEWAY_URL must contain only an http:// host and port".into());
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
    if heartbeat.interval_seconds != 5 || heartbeat.wss_url.is_empty() || heartbeat.token.is_empty() {
        return Err("gateway did not issue pending session credentials".into());
    }

    let separator = if heartbeat.wss_url.contains('?') { '&' } else { '?' };
    let session_url = format!("{}{}token={}", heartbeat.wss_url, separator, heartbeat.token);
    let (mut session, _) = connect(session_url.as_str())?;
    println!("Reach engine session connected");
    session.send(Message::Text(r#"{"type":"job.done"}"#.into()))?;

    loop {
        if matches!(session.read()?, Message::Close(_)) {
            break;
        }
    }
    println!("Reach engine session closed");
    Ok(())
}

fn main() {
    let base_url = env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:8787".to_owned());
    if let Err(error) = run(&base_url) {
        eprintln!("Reach engine session failed: {error}");
        std::process::exit(1);
    }
}
