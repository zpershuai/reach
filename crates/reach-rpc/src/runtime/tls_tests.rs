//! Ephemeral certificate tests exercise the real adapters with verification enabled.
use super::*;
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    ClientConfig, RootCertStore, ServerConfig, ServerConnection, StreamOwned,
};
use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

fn tls_peer(
    directory: &Path,
    certificate: &str,
    websocket: bool,
) -> (SocketAddr, std::thread::JoinHandle<bool>) {
    let certificate = fs::read(directory.join(format!("{certificate}.der"))).unwrap();
    let key = fs::read(directory.join("leaf-key.der")).unwrap();
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(certificate)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut stream = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
        if stream.conn.complete_io(&mut stream.sock).is_err() {
            return false;
        }
        if websocket {
            let observed = Arc::new(AtomicBool::new(false));
            let copy = observed.clone();
            if let Ok(mut socket) = tungstenite::accept_hdr(
                stream,
                move |request: &tungstenite::handshake::server::Request,
                      response: tungstenite::handshake::server::Response| {
                    copy.store(
                        request
                            .uri()
                            .query()
                            .unwrap_or("")
                            .contains("token=private-session-sentinel"),
                        Ordering::SeqCst,
                    );
                    Ok(response)
                },
            ) {
                let _ = socket.close(None);
            }
            return observed.load(Ordering::SeqCst);
        }
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => return false,
                Ok(n) => request.extend_from_slice(&buffer[..n]),
            }
            if request.windows(4).any(|value| value == b"\r\n\r\n") {
                break;
            }
            if request.len() > 8192 {
                return false;
            }
        }
        let request = String::from_utf8(request).unwrap();
        let body = r#"{"intervalSeconds":30}"#;
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.flush();
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer private-engine-sentinel")
    });
    (address, peer)
}

#[test]
fn https_and_wss_verify_trust_expiry_and_hostname_before_sending_credentials() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let status = Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/tls-test-fixture.py"))
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "ephemeral certificate generation failed"
    );
    let ca = fs::read(directory.path().join("ca.der")).unwrap();
    for websocket in [false, true] {
        for certificate in [
            "trusted",
            "untrusted",
            "expired",
            "wrong-host",
            "default-roots",
        ] {
            let leaf = if certificate == "default-roots" {
                "trusted"
            } else {
                certificate
            };
            let (address, peer) = tls_peer(directory.path(), leaf, websocket);
            let success = if websocket {
                let connector = if certificate == "default-roots" {
                    None
                } else {
                    let mut roots = RootCertStore::empty();
                    roots.add(CertificateDer::from(ca.clone())).unwrap();
                    Some(tungstenite::Connector::Rustls(Arc::new(
                        ClientConfig::builder()
                            .with_root_certificates(roots)
                            .with_no_client_auth(),
                    )))
                };
                let result = connect_session(
                    &format!("wss://{address}/session"),
                    "private-session-sentinel",
                    Duration::from_secs(3),
                    connector,
                );
                if let Err(error) = &result {
                    assert!(!error.contains("sentinel"));
                }
                result.is_ok()
            } else {
                let mut config = GatewayConfig::new(&format!("https://{address}")).unwrap();
                config.engine_token = Some("private-engine-sentinel".into());
                let mut transport =
                    LocalHttpHeartbeatTransport::new(config, "fixture", Duration::from_secs(3));
                if certificate != "default-roots" {
                    transport.test_tls = Some(
                        ureq::tls::TlsConfig::builder()
                            .root_certs(ureq::tls::RootCerts::new_with_certs(&[
                                ureq::tls::Certificate::from_der(&ca).to_owned(),
                            ]))
                            .build(),
                    );
                }
                let result = transport.heartbeat();
                if let Err(error) = &result {
                    assert!(!error.contains("sentinel"));
                }
                result.is_ok()
            };
            assert_eq!(
                success,
                certificate == "trusted",
                "unexpected TLS result for {certificate}, websocket={websocket}"
            );
            assert_eq!(
                peer.join().unwrap(),
                certificate == "trusted",
                "credentials must not reach an invalid TLS peer"
            );
        }
    }
}
