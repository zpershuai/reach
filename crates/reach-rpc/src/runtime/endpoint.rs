//! Session endpoint pinning (task 1.4): the Engine connects only to its
//! configured Gateway origin. A lease endpoint must be either a Gateway-relative
//! path (resolved against the configured origin) or an absolute endpoint with
//! the same normalized origin. Anything else is rejected before any connection
//! is attempted.

use crate::runtime::config::{GatewayConfig, Origin};

/// Resolve a heartbeat-supplied session endpoint to an absolute WebSocket URL,
/// or reject it. A relative path like `/session` is resolved against the
/// configured Gateway origin; an absolute URL must match that origin (host and
/// port; the current loopback transport supports `ws://` only).
pub fn resolve_session_endpoint(config: &GatewayConfig, endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("session endpoint must not be empty".into());
    }
    if let Some(relative) = trimmed.strip_prefix('/') {
        if relative.is_empty() || trimmed.starts_with("//") {
            return Err("session endpoint path is malformed".into());
        }
        if relative.contains("://") || relative.contains("..") {
            return Err("session endpoint path is malformed".into());
        }
        return Ok(format!(
            "{}://{}{}",
            config.origin.ws_scheme(),
            config.origin.authority(),
            trimmed
        ));
    }

    // Absolute endpoint: must belong to the same origin.
    let parsed: Origin = Origin::parse_ws_endpoint(trimmed)?;
    if parsed.scheme != config.origin.ws_scheme() || !config.origin.matches_ws(&parsed) {
        return Err(format!(
            "session endpoint {trimmed:?} does not match the configured Gateway origin ({})",
            config.base_url
        ));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::config::GatewayConfig;

    fn config() -> GatewayConfig {
        GatewayConfig::new("http://127.0.0.1:8787").unwrap()
    }

    #[test]
    fn resolves_relative_endpoint_against_gateway_origin() {
        assert_eq!(
            resolve_session_endpoint(&config(), "/session").unwrap(),
            "ws://127.0.0.1:8787/session"
        );
    }

    #[test]
    fn accepts_absolute_endpoint_with_matching_origin() {
        assert_eq!(
            resolve_session_endpoint(&config(), "ws://127.0.0.1:8787/session").unwrap(),
            "ws://127.0.0.1:8787/session"
        );
    }

    #[test]
    fn rejects_absolute_endpoint_with_foreign_origin() {
        let error =
            resolve_session_endpoint(&config(), "ws://evil.example:8787/session").unwrap_err();
        assert!(error.contains("does not match"), "{error}");
        let mismatched_port = resolve_session_endpoint(&config(), "ws://127.0.0.1:9999/session");
        assert!(mismatched_port.is_err());
        let wrong_scheme = resolve_session_endpoint(&config(), "https://127.0.0.1:8787/session");
        assert!(wrong_scheme.is_err());
        assert!(resolve_session_endpoint(&config(), "wss://127.0.0.1:8787/session").is_err());
    }

    #[test]
    fn rejects_empty_and_malformed_relative_endpoints() {
        for endpoint in [
            "",
            "   ",
            "//evil.example/session",
            "/../session",
            "/a/b/../c",
        ] {
            assert!(
                resolve_session_endpoint(&config(), endpoint).is_err(),
                "expected {endpoint:?} to be rejected"
            );
        }
    }

    #[test]
    fn https_gateway_is_rejected_until_tls_transport_exists() {
        assert!(GatewayConfig::new("https://reach.example:8443").is_err());
    }
}
