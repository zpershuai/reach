//! Transport ports (`HeartbeatTransport`, `SessionTransport`) plus concrete
//! local HTTP/WebSocket adapters for the loopback deployment.
//!
//! Runtime code depends only on the traits; tests inject fakes.

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

use tungstenite::{
    client::IntoClientRequest,
    protocol::{CloseFrame, Message},
    WebSocket,
};

use crate::runtime::{config::GatewayConfig, config::Origin};

/// A parsed session lease from the Gateway heartbeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub token: String,
    pub session_id: String,
    /// The Gateway-provided session endpoint (relative or origin-matching).
    pub endpoint: String,
    /// Absolute lease expiry in epoch milliseconds.
    pub lease_expires_at_ms: i64,
    /// Heartbeat interval requested alongside the lease.
    pub interval: Duration,
}

impl Lease {
    pub fn is_valid(&self) -> bool {
        !self.token.is_empty() && !self.session_id.is_empty() && !self.endpoint.is_empty()
    }
}

/// The outcome of one heartbeat POST.
#[derive(Debug, Clone, PartialEq)]
pub enum HeartbeatOutcome {
    /// No session wanted (or already live): only an interval is returned.
    Idle { interval: Duration },
    /// A session lease is available to connect.
    Lease(Lease),
}

impl HeartbeatOutcome {
    pub fn interval(&self) -> Duration {
        match self {
            HeartbeatOutcome::Idle { interval }
            | HeartbeatOutcome::Lease(Lease { interval, .. }) => *interval,
        }
    }
}

/// Port used by the Runtime to acquire session leases from the Gateway.
pub trait HeartbeatTransport: Send {
    fn heartbeat(&mut self) -> Result<HeartbeatOutcome, String>;
}

/// A frame received on the session WebSocket.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionIncoming {
    Text(String),
    Ping(Vec<u8>),
    Close {
        code: Option<u16>,
        reason: String,
    },
    /// Nothing available right now; the caller should poll again after its
    /// next deadline.
    WouldBlock,
}

/// Port used by the Runtime to drive one live session WebSocket.
pub trait SessionTransport: Send {
    fn recv(&mut self) -> Result<SessionIncoming, String>;
    fn send(&mut self, text: &str) -> Result<(), String>;
    fn send_pong(&mut self, payload: &[u8]) -> Result<(), String>;
    fn close(&mut self, code: u16, reason: &str) -> Result<(), String>;
}

/// Port used to open a `SessionTransport` for a validated endpoint+token.
pub trait SessionTransportFactory: Send {
    fn connect(
        &self,
        url: &str,
        token: &str,
        connection_timeout: Duration,
    ) -> Result<Box<dyn SessionTransport>, String>;
}

/// Parse an RFC3339 UTC timestamp into epoch milliseconds.
pub fn rfc3339_to_epoch_millis(input: &str) -> Result<i64, String> {
    let parsed = time::OffsetDateTime::parse(input, &time::format_description::well_known::Rfc3339)
        .map_err(|_| format!("invalid RFC3339 timestamp {input:?}"))?;
    Ok(parsed.unix_timestamp() * 1000 + i64::from(parsed.millisecond()))
}

/// Format epoch milliseconds as an RFC3339 UTC timestamp.
pub fn epoch_millis_to_rfc3339(epoch_ms: i64) -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    let seconds = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let datetime = OffsetDateTime::from_unix_timestamp(seconds)
        .expect("epoch seconds in range")
        .replace_millisecond(millis as u16)
        .expect("millisecond in range");
    datetime.format(&Rfc3339).expect("RFC3339 formats")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    interval_seconds: u64,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    lease_expires_at: Option<String>,
}

impl HeartbeatResponse {
    fn to_outcome(&self) -> Result<HeartbeatOutcome, String> {
        let interval = Duration::from_secs(self.interval_seconds.max(1));
        let lease_fields = (
            self.endpoint.as_deref(),
            self.token.as_deref(),
            self.session_id.as_deref(),
            self.lease_expires_at.as_deref(),
        );
        match lease_fields {
            (Some(endpoint), Some(token), Some(session_id), Some(expiry))
                if !endpoint.is_empty()
                    && !token.is_empty()
                    && !session_id.is_empty()
                    && !expiry.is_empty() =>
            {
                let lease_expires_at_ms = rfc3339_to_epoch_millis(expiry)?;
                Ok(HeartbeatOutcome::Lease(Lease {
                    token: token.to_owned(),
                    session_id: session_id.to_owned(),
                    endpoint: endpoint.to_owned(),
                    lease_expires_at_ms,
                    interval,
                }))
            }
            _ => Ok(HeartbeatOutcome::Idle { interval }),
        }
    }
}

/// Upper bound on a single heartbeat HTTP response (status line, headers, and
/// JSON body). The Gateway's own accept limit is 64 KiB; a larger response is
/// treated as hostile rather than buffered without bound.
const MAX_HEARTBEAT_RESPONSE_BYTES: usize = 64 * 1024;

/// Resolve a host/port pair into candidate socket addresses, tolerating a
/// bracketed IPv6 literal (`[::1]`). An empty resolution is an error.
fn resolve_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let bare = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let addresses: Vec<SocketAddr> = (bare, port)
        .to_socket_addrs()
        .map(|addrs| addrs.collect())
        .map_err(|error| format!("cannot resolve host {host}: {error}"))?;
    if addresses.is_empty() || addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err("Gateway must resolve exclusively to loopback addresses".into());
    }
    Ok(addresses)
}

/// Open a TCP stream to the first reachable candidate address, bounded overall
/// by `timeout`. The budget is shared across every address, so a slow or
/// black-holed first address cannot starve the remaining candidates; a host
/// that resolves to both `::1` and `127.0.0.1` connects whichever listens.
fn connect_try_all(addresses: &[SocketAddr], timeout: Duration) -> Result<TcpStream, String> {
    let deadline = Instant::now() + timeout;
    let mut last_error: Option<std::io::Error> = None;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "no address resolved".to_owned()))
}

use serde::Deserialize;

/// Concrete heartbeat adapter that POSTs raw JSON HTTP to the configured
/// loopback Gateway endpoint. HTTPS/WSS is rejected by `GatewayConfig` until
/// a TLS-capable transport is added.
pub struct LocalHttpHeartbeatTransport {
    config: GatewayConfig,
    device_id: String,
    /// Upper bound on connect, write, and the whole response read of one
    /// heartbeat. A stalled or hostile Gateway cannot park the resident Engine
    /// on a single heartbeat.
    io_timeout: Duration,
}

impl LocalHttpHeartbeatTransport {
    pub fn new(
        config: GatewayConfig,
        device_id: &str,
        io_timeout: Duration,
    ) -> LocalHttpHeartbeatTransport {
        LocalHttpHeartbeatTransport {
            config,
            device_id: device_id.to_owned(),
            io_timeout,
        }
    }
}

impl HeartbeatTransport for LocalHttpHeartbeatTransport {
    fn heartbeat(&mut self) -> Result<HeartbeatOutcome, String> {
        let origin = &self.config.origin;
        let authority = origin.authority();
        let request_body =
            serde_json::json!({"device": {"id": self.device_id, "platform": "rust"}}).to_string();
        let path = &self.config.heartbeat_path;
        // Bound every phase of the round trip: resolve, connect (trying each
        // address within one shared budget), write, and read.
        let addresses = resolve_addresses(&origin.host, origin.port)?;
        let mut stream = connect_try_all(&addresses, self.io_timeout)
            .map_err(|error| format!("heartbeat connect failed: {error}"))?;
        stream
            .set_write_timeout(Some(self.io_timeout))
            .map_err(|error| format!("heartbeat write timeout setup failed: {error}"))?;
        stream
            .set_read_timeout(Some(self.io_timeout))
            .map_err(|error| format!("heartbeat read timeout setup failed: {error}"))?;
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
            request_body.len()
        )
        .map_err(|error| format!("heartbeat write failed: {error}"))?;
        stream.shutdown(std::net::Shutdown::Write).ok();

        let mut response = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    response.extend_from_slice(&buffer[..read]);
                    if response.len() > MAX_HEARTBEAT_RESPONSE_BYTES {
                        return Err("gateway heartbeat response exceeded the size limit".to_owned());
                    }
                }
                // The read timeout bounds a Gateway that accepts but never
                // responds; the size cap bounds one that streams forever.
                Err(error) => return Err(format!("heartbeat read failed: {error}")),
            }
        }
        let response = String::from_utf8(response)
            .map_err(|_| "gateway heartbeat response was not UTF-8".to_owned())?;
        let (headers, body) = response
            .split_once("\r\n\r\n")
            .ok_or("gateway returned a malformed HTTP response")?;
        if !headers.starts_with("HTTP/1.1 200") {
            return Err(format!("gateway heartbeat failed: {headers}"));
        }
        let parsed: HeartbeatResponse = serde_json::from_str(body)
            .map_err(|error| format!("gateway heartbeat body was invalid: {error}"))?;
        parsed.to_outcome()
    }
}

/// Concrete session transport backed by a tungstenite WebSocket. The socket is
/// switched to non-blocking reads so the Runtime can also honor its lease, idle,
/// and rotation deadlines while no message is pending.
pub struct LocalWebSocketSessionTransport {
    socket: WebSocket<MaybeTlsTcp>,
    peer: String,
}

/// Minimal wrapper to reach the underlying TcpStream for non-blocking mode.
pub struct MaybeTlsTcp(pub TcpStream);

impl Read for MaybeTlsTcp {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for MaybeTlsTcp {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl LocalWebSocketSessionTransport {
    fn set_nonblocking(socket: &WebSocket<MaybeTlsTcp>, enabled: bool) -> Result<(), String> {
        socket
            .get_ref()
            .0
            .set_nonblocking(enabled)
            .map_err(|error| format!("failed to set session socket non-blocking: {error}"))
    }
}

impl SessionTransport for LocalWebSocketSessionTransport {
    fn recv(&mut self) -> Result<SessionIncoming, String> {
        match self.socket.read() {
            Ok(Message::Text(text)) => Ok(SessionIncoming::Text(text.to_string())),
            Ok(Message::Ping(payload)) => Ok(SessionIncoming::Ping(payload.to_vec())),
            Ok(Message::Close(frame)) => Ok(SessionIncoming::Close {
                code: frame.as_ref().map(|frame| frame.code.into()),
                reason: frame
                    .map(|frame| frame.reason.to_string())
                    .unwrap_or_default(),
            }),
            // Pong / Binary / Frame are not part of the reach protocol.
            Ok(_) => Ok(SessionIncoming::WouldBlock),
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                Ok(SessionIncoming::WouldBlock)
            }
            Err(error) => Err(format!("session read failed on {}: {error}", self.peer)),
        }
    }

    fn send(&mut self, text: &str) -> Result<(), String> {
        self.socket
            .send(Message::Text(text.into()))
            .map_err(|error| format!("session send failed on {}: {error}", self.peer))
    }

    fn send_pong(&mut self, payload: &[u8]) -> Result<(), String> {
        self.socket
            .send(Message::Pong(payload.to_vec().into()))
            .map_err(|error| format!("session pong failed on {}: {error}", self.peer))
    }

    fn close(&mut self, code: u16, reason: &str) -> Result<(), String> {
        let frame = CloseFrame {
            code: code.into(),
            reason: reason.into(),
        };
        self.socket
            .close(Some(frame))
            .map_err(|error| format!("session close failed on {}: {error}", self.peer))
    }
}

/// Concrete factory that opens loopback WebSocket sessions with a bounded
/// connection attempt.
pub struct LocalWebSocketSessionTransportFactory;

impl SessionTransportFactory for LocalWebSocketSessionTransportFactory {
    fn connect(
        &self,
        url: &str,
        token: &str,
        connection_timeout: Duration,
    ) -> Result<Box<dyn SessionTransport>, String> {
        let origin = Origin::parse_ws_endpoint(url)?;
        // Try every resolved address within the one connection budget, so the
        // session connect agrees with the heartbeat on dual-stack hosts where
        // `localhost` resolves to both `::1` and `127.0.0.1`.
        let addresses = resolve_addresses(&origin.host, origin.port)?;
        let stream = connect_try_all(&addresses, connection_timeout).map_err(|error| {
            format!("session connect to {} failed: {error}", origin.authority())
        })?;
        // Bound the HTTP upgrade read too; a stalled Gateway cannot hang us.
        stream
            .set_read_timeout(Some(connection_timeout))
            .map_err(|error| format!("failed to set session read timeout: {error}"))?;

        let separator = if url.contains('?') { '&' } else { '?' };
        let session_url = format!("{url}{separator}token={token}");
        let request = session_url
            .into_client_request()
            .map_err(|error| format!("invalid session URL: {error}"))?;
        let (socket, response) = tungstenite::client::client(request, MaybeTlsTcp(stream))
            .map_err(|error| format!("session upgrade failed: {error}"))?;
        // A successful WebSocket upgrade is HTTP 101 Switching Protocols, not
        // a 2xx response.
        if response.status().as_u16() != 101 {
            return Err(format!("session upgrade rejected: {}", response.status()));
        }
        LocalWebSocketSessionTransport::set_nonblocking(&socket, true)?;
        Ok(Box::new(LocalWebSocketSessionTransport {
            socket,
            peer: origin.authority(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::config::GatewayConfig;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn rfc3339_round_trips_epoch_millis() {
        let millis = rfc3339_to_epoch_millis("2026-09-03T12:00:00Z").unwrap();
        assert_eq!(
            millis,
            rfc3339_to_epoch_millis("2026-09-03T12:00:00.000Z").unwrap()
        );
        // The RFC3339 formatter drops a zero subsecond fraction.
        assert_eq!(epoch_millis_to_rfc3339(millis), "2026-09-03T12:00:00Z");
        assert!(rfc3339_to_epoch_millis("not-a-time").is_err());
    }

    #[test]
    fn heartbeat_response_maps_credentials_to_lease() {
        let response: HeartbeatResponse = serde_json::from_str(
            r#"{"intervalSeconds":5,"endpoint":"/session","token":"t","sessionId":"s","leaseExpiresAt":"2026-09-03T12:00:00Z"}"#,
        )
        .unwrap();
        match response.to_outcome().unwrap() {
            HeartbeatOutcome::Lease(lease) => {
                assert_eq!(lease.token, "t");
                assert_eq!(lease.session_id, "s");
                assert_eq!(lease.endpoint, "/session");
                assert!(lease.is_valid());
            }
            other => panic!("expected lease, got {other:?}"),
        }
    }

    #[test]
    fn heartbeat_response_without_credentials_is_idle() {
        let response: HeartbeatResponse =
            serde_json::from_str(r#"{"intervalSeconds":120}"#).unwrap();
        assert_eq!(
            response.to_outcome().unwrap(),
            HeartbeatOutcome::Idle {
                interval: Duration::from_secs(120)
            }
        );
        let partial: HeartbeatResponse =
            serde_json::from_str(r#"{"intervalSeconds":5,"endpoint":"/session","token":"t"}"#)
                .unwrap();
        assert!(matches!(
            partial.to_outcome().unwrap(),
            HeartbeatOutcome::Idle { .. }
        ));
    }

    /// A heartbeat transport pointed at a live loopback listener.
    fn heartbeat_transport(
        config: GatewayConfig,
        io_timeout: Duration,
    ) -> LocalHttpHeartbeatTransport {
        LocalHttpHeartbeatTransport::new(config, "test-device", io_timeout)
    }

    fn loopback_gateway_config(address: std::net::SocketAddr) -> GatewayConfig {
        GatewayConfig::new(&format!("http://{address}")).expect("loopback URL parses")
    }

    #[test]
    fn connect_tries_every_address_within_the_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let live = listener.local_addr().unwrap();
        // A freed loopback port refuses connections: bind and drop.
        let refused = {
            let probe = TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap()
        };
        // The first address is refused; the connect must fall through to the
        // listening address instead of giving up.
        let stream = connect_try_all(&[refused, live], Duration::from_secs(2)).unwrap();
        assert_eq!(stream.peer_addr().unwrap(), live);

        // A zero budget fails fast and reports an error rather than waiting.
        assert!(connect_try_all(&[live], Duration::ZERO).is_err());
    }

    #[test]
    fn heartbeat_succeeds_against_a_local_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Drain the request to EOF (the client sends Connection: close) so
            // closing with unread data does not RST the response back.
            std::io::copy(&mut stream, &mut std::io::sink()).ok();
            let body = r#"{"intervalSeconds":30}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let mut transport =
            heartbeat_transport(loopback_gateway_config(address), Duration::from_secs(2));
        match transport.heartbeat().unwrap() {
            HeartbeatOutcome::Idle { interval } => {
                assert_eq!(interval, Duration::from_secs(30))
            }
            other => panic!("expected an idle interval, got {other:?}"),
        }
    }

    #[test]
    fn heartbeat_times_out_when_gateway_never_responds() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        // Accept the connection but hold it open without replying; the read
        // timeout must bound the heartbeat instead of hanging the engine.
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            std::thread::sleep(Duration::from_secs(5));
        });
        let mut transport =
            heartbeat_transport(loopback_gateway_config(address), Duration::from_millis(200));
        let started = Instant::now();
        assert!(transport.heartbeat().is_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "heartbeat did not honor its I/O timeout"
        );
    }

    #[test]
    fn heartbeat_rejects_an_oversized_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        // Stream more bytes than the cap; the client must stop buffering and
        // fail instead of growing memory without bound.
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let junk = "x".repeat(MAX_HEARTBEAT_RESPONSE_BYTES + 1);
            stream.write_all(junk.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_secs(1));
        });
        let mut transport =
            heartbeat_transport(loopback_gateway_config(address), Duration::from_secs(2));
        let error = transport.heartbeat().unwrap_err();
        assert!(error.contains("size limit"), "{error}");
    }
}
