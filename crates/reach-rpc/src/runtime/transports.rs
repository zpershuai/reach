//! Transport ports (`HeartbeatTransport`, `SessionTransport`) plus concrete
//! local HTTP/WebSocket adapters for the loopback deployment.
//!
//! Runtime code depends only on the traits; tests inject fakes.

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
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

use serde::Deserialize;

/// Concrete heartbeat adapter that POSTs raw JSON HTTP to the configured
/// loopback Gateway endpoint. HTTPS/WSS is rejected by `GatewayConfig` until
/// a TLS-capable transport is added.
pub struct LocalHttpHeartbeatTransport {
    config: GatewayConfig,
    device_id: String,
}

impl LocalHttpHeartbeatTransport {
    pub fn new(config: GatewayConfig, device_id: &str) -> LocalHttpHeartbeatTransport {
        LocalHttpHeartbeatTransport {
            config,
            device_id: device_id.to_owned(),
        }
    }
}

impl HeartbeatTransport for LocalHttpHeartbeatTransport {
    fn heartbeat(&mut self) -> Result<HeartbeatOutcome, String> {
        let authority = self.config.origin.authority();
        let request_body = format!(
            r#"{{"device":{{"id":"{}","platform":"rust"}}}}"#,
            self.device_id
        );
        let path = &self.config.heartbeat_path;
        let mut stream = TcpStream::connect(authority.as_str())
            .map_err(|error| format!("heartbeat connect failed: {error}"))?;
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
            request_body.len()
        )
        .map_err(|error| format!("heartbeat write failed: {error}"))?;
        stream.shutdown(std::net::Shutdown::Write).ok();

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|error| format!("heartbeat read failed: {error}"))?;
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
        let addresses: Vec<SocketAddr> = (origin.host.as_str(), origin.port)
            .to_socket_addrs()
            .map_err(|error| format!("cannot resolve session host {}: {error}", origin.host))?
            .collect();
        let address = addresses
            .first()
            .ok_or_else(|| format!("no address resolved for session host {}", origin.host))?;
        let stream = TcpStream::connect_timeout(address, connection_timeout).map_err(|error| {
            format!(
                "session connect to {} timed out or failed: {error}",
                origin.authority()
            )
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
}
