//! Engine startup configuration: one Gateway origin, Engine identifier,
//! workspace roots, and a bounded Runtime timeout policy.
//!
//! The Engine is pinned to exactly one configured Gateway. Any config input
//! that parses to more than one origin, an invalid scheme, an invalid timeout,
//! or an empty Engine identifier fails fast.

use std::{collections::HashMap, env, path::PathBuf, time::Duration};

use crate::{default_workspace_root, parse_workspace_roots};

pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8787";
pub const DEFAULT_ENGINE_ID: &str = "reach-engine";
pub const DEFAULT_CONNECTION_TIMEOUT_SECS: u64 = 15;
pub const DEFAULT_RPC_DEADLINE_SECS: u64 = 30;
pub const DEFAULT_LEASE_SECS: u64 = 300;
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;
pub const DEFAULT_ROTATION_SECS: u64 = 8 * 3600;

/// The parsed scheme/host/port of the single configured Gateway.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// Parse the local loopback transport's absolute `http://` base URL into
    /// its origin. HTTPS/WSS is deliberately rejected until a TLS transport is
    /// implemented; accepting it would make the raw TCP adapters speak
    /// plaintext to a TLS endpoint.
    /// Rejects a wrong scheme, a base path, or a malformed authority.
    pub fn parse_http_base_url(input: &str) -> Result<Origin, String> {
        let trimmed = input.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return Err("gateway URL must not be empty".into());
        }
        let (scheme, remainder) = trimmed
            .split_once("://")
            .ok_or_else(|| format!("invalid gateway URL {input:?}: missing :// scheme"))?;
        if scheme != "http" {
            return Err(format!(
                "invalid gateway URL scheme {scheme:?}; this Engine transport supports only http://"
            ));
        }
        let (authority, path) = match remainder.split_once('/') {
            Some((authority, path)) => (authority, path),
            None => (remainder, ""),
        };
        if !path.is_empty() {
            return Err("gateway base URL must not contain a path".into());
        }
        let (host, port) = parse_authority(authority, scheme)?;
        Ok(Origin {
            scheme: scheme.to_owned(),
            host,
            port,
        })
    }

    /// Parse an absolute `ws://` or `wss://` session endpoint.
    pub fn parse_ws_endpoint(input: &str) -> Result<Origin, String> {
        let (scheme, remainder) = input
            .trim()
            .split_once("://")
            .ok_or_else(|| format!("session endpoint {input:?} is not an absolute URL"))?;
        if scheme != "ws" && scheme != "wss" {
            return Err(format!(
                "session endpoint scheme {scheme:?} is not ws:// or wss://"
            ));
        }
        let authority = remainder
            .split(['/', '?'])
            .next()
            .unwrap_or(remainder)
            .to_owned();
        let (host, port) = parse_authority(&authority, scheme)?;
        Ok(Origin {
            scheme: scheme.to_owned(),
            host,
            port,
        })
    }

    fn default_port(scheme: &str) -> u16 {
        match scheme {
            "https" | "wss" => 443,
            _ => 80,
        }
    }

    /// The WebSocket scheme that corresponds to this gateway origin's scheme.
    pub fn ws_scheme(&self) -> &'static str {
        "ws"
    }

    pub fn authority(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// True when another WebSocket origin matches this gateway origin
    /// (same host and port; http/ws and https/wss are scheme-equivalent).
    pub fn matches_ws(&self, other: &Origin) -> bool {
        self.host.eq_ignore_ascii_case(&other.host) && self.port == other.port
    }
}

fn parse_authority(authority: &str, scheme: &str) -> Result<(String, u16), String> {
    if authority.is_empty() {
        return Err("URL must include a host".into());
    }
    if authority.starts_with('[') {
        // IPv6 literal: [::1] or [::1]:port.
        let close = authority
            .find(']')
            .ok_or_else(|| format!("invalid IPv6 authority {authority:?}"))?;
        let host = &authority[..=close];
        let rest = &authority[close + 1..];
        let port = if rest.is_empty() {
            Origin::default_port(scheme)
        } else if let Some(stripped) = rest.strip_prefix(':') {
            parse_port(stripped)?
        } else {
            return Err(format!("invalid URL authority {authority:?}"));
        };
        return Ok((host.to_owned(), port));
    }

    let (host, rest) = match authority.split_once(':') {
        Some((host, rest)) => {
            if rest.is_empty()
                || rest.contains(':')
                || !rest.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(format!("invalid URL authority {authority:?}"));
            }
            (host, Some(rest))
        }
        None => (authority, None),
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    {
        return Err(format!("invalid URL host {host:?}"));
    }
    let port = match rest {
        Some(port) => parse_port(port)?,
        None => Origin::default_port(scheme),
    };
    Ok((host.to_owned(), port))
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("invalid URL port {value:?}"))
}

/// The single Gateway the Engine is pinned to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConfig {
    pub origin: Origin,
    pub base_url: String,
    pub heartbeat_path: String,
    pub session_path: String,
}

impl GatewayConfig {
    pub fn new(base_url: &str) -> Result<GatewayConfig, String> {
        let origin = Origin::parse_http_base_url(base_url)?;
        Ok(GatewayConfig {
            origin,
            base_url: base_url.trim_end_matches('/').to_owned(),
            heartbeat_path: "/heartbeat".to_owned(),
            session_path: "/session".to_owned(),
        })
    }

    /// The heartbeat endpoint as an absolute http(s) URL.
    pub fn heartbeat_url(&self) -> String {
        format!("{}{}", self.base_url, self.heartbeat_path)
    }
}

/// Engine-enforced upper bounds. The Engine treats these as hard maxima and
/// never lets a Gateway/Agent request relax them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeoutPolicy {
    /// Bound on establishing a session connection and reaching readiness.
    pub connection_timeout: Duration,
    /// Default deadline applied to a data-plane request without its own.
    pub rpc_deadline: Duration,
    /// Length of a session lease (renewable up to this policy).
    pub lease_duration: Duration,
    /// Bound on session inactivity (no RPC, renewal, or control) before close.
    pub idle_timeout: Duration,
    /// Bound on continuous connection age before forced rotation.
    pub rotation: Duration,
}

impl Default for TimeoutPolicy {
    fn default() -> Self {
        TimeoutPolicy {
            connection_timeout: Duration::from_secs(DEFAULT_CONNECTION_TIMEOUT_SECS),
            rpc_deadline: Duration::from_secs(DEFAULT_RPC_DEADLINE_SECS),
            lease_duration: Duration::from_secs(DEFAULT_LEASE_SECS),
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
            rotation: Duration::from_secs(DEFAULT_ROTATION_SECS),
        }
    }
}

impl TimeoutPolicy {
    /// Parse a bounded policy. `lookup(name)` returns the env override for that
    /// variable name; absent values fall back to the defaults. Invalid values
    /// (unparseable or zero/negative) fail fast.
    pub fn parse_from(lookup: &dyn Fn(&str) -> Option<String>) -> Result<TimeoutPolicy, String> {
        let connection_timeout = parse_timeout_secs(
            lookup("REACH_CONNECTION_TIMEOUT_SECS"),
            DEFAULT_CONNECTION_TIMEOUT_SECS,
        )?;
        let rpc_deadline =
            parse_timeout_secs(lookup("REACH_RPC_DEADLINE_SECS"), DEFAULT_RPC_DEADLINE_SECS)?;
        let lease_duration = parse_timeout_secs(lookup("REACH_LEASE_SECS"), DEFAULT_LEASE_SECS)?;
        let idle_timeout =
            parse_timeout_secs(lookup("REACH_IDLE_SECS"), DEFAULT_IDLE_TIMEOUT_SECS)?;
        let rotation = parse_timeout_secs(lookup("REACH_ROTATION_SECS"), DEFAULT_ROTATION_SECS)?;
        Ok(TimeoutPolicy {
            connection_timeout,
            rpc_deadline,
            lease_duration,
            idle_timeout,
            rotation,
        })
    }

    /// The largest lease the Engine will accept from a Gateway renewal.
    pub fn max_lease(&self) -> Duration {
        self.lease_duration
    }
}

fn parse_timeout_secs(value: Option<String>, default: u64) -> Result<Duration, String> {
    let Some(value) = value else {
        return Ok(Duration::from_secs(default));
    };
    let parsed: u64 = value
        .parse()
        .map_err(|_| format!("invalid timeout value {value:?}; expected a positive integer"))?;
    if parsed == 0 {
        return Err("timeout values must be positive (got 0)".into());
    }
    Ok(Duration::from_secs(parsed))
}

/// The Engine's full startup configuration.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub engine_id: String,
    pub gateway: GatewayConfig,
    pub timeouts: TimeoutPolicy,
    pub workspace_roots: HashMap<String, PathBuf>,
}

impl EngineConfig {
    /// Parse startup configuration from the CLI gateway URL (optional) and the
    /// process environment, validating every field. Fails fast on error.
    pub fn parse(
        gateway_url_arg: Option<&str>,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<EngineConfig, String> {
        let base_url = gateway_url_arg
            .map(str::to_owned)
            .or_else(|| lookup("REACH_GATEWAY_URL"))
            .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_owned());
        if lookup("REACH_GATEWAY_URL").is_some() && gateway_url_arg.is_some() {
            return Err("gateway URL supplied both as an argument and REACH_GATEWAY_URL".into());
        }
        let gateway = GatewayConfig::new(&base_url)?;
        let timeouts = TimeoutPolicy::parse_from(lookup)?;

        let engine_id = lookup("REACH_ENGINE_ID").unwrap_or_else(|| DEFAULT_ENGINE_ID.to_owned());
        if engine_id.trim().is_empty() {
            return Err("REACH_ENGINE_ID must not be empty".into());
        }

        let workspace_roots = match lookup("REACH_WORKSPACE_ROOTS") {
            Some(spec) => parse_workspace_roots(&spec)
                .map_err(|error| format!("invalid workspace roots: {error}"))?,
            None => {
                let mut roots = HashMap::new();
                roots.insert("default".to_owned(), default_workspace_root());
                roots
            }
        };

        Ok(EngineConfig {
            engine_id,
            gateway,
            timeouts,
            workspace_roots,
        })
    }

    pub fn parse_from_env(gateway_url_arg: Option<&str>) -> Result<EngineConfig, String> {
        EngineConfig::parse(gateway_url_arg, &|name| env::var(name).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_gateway_urls() {
        for input in [
            "",
            "127.0.0.1:8787",
            "ws://127.0.0.1:8787",
            "ftp://x",
            "http://",
            "http://127.0.0.1/x",
            "http://127.0.0.1:notaport",
        ] {
            assert!(
                Origin::parse_http_base_url(input).is_err(),
                "expected {input:?} to fail"
            );
        }
    }

    #[test]
    fn parses_loopback_origin() {
        let origin = Origin::parse_http_base_url("http://127.0.0.1:8787").unwrap();
        assert_eq!(origin.host, "127.0.0.1");
        assert_eq!(origin.port, 8787);
        assert_eq!(origin.ws_scheme(), "ws");
        assert!(Origin::parse_http_base_url("https://localhost:8443").is_err());
    }

    #[test]
    fn rejects_multiple_or_bogus_origin_inputs() {
        assert!(Origin::parse_http_base_url("http://a:1,b:2").is_err());
        assert!(Origin::parse_http_base_url("http://a http://b").is_err());
    }

    #[test]
    fn bounded_timeout_policy_parses_with_defaults() {
        let policy = TimeoutPolicy::parse_from(&|_| None).unwrap();
        assert_eq!(policy.connection_timeout, Duration::from_secs(15));
        assert_eq!(policy.lease_duration, Duration::from_secs(300));
        assert_eq!(policy.rotation, Duration::from_secs(8 * 3600));
    }

    #[test]
    fn bounded_timeout_policy_rejects_invalid_values() {
        for value in ["abc", "0", "-1"] {
            let lookup = |name: &str| {
                if name == "REACH_LEASE_SECS" {
                    Some(value.to_owned())
                } else {
                    None
                }
            };
            assert!(
                TimeoutPolicy::parse_from(&lookup).is_err(),
                "expected {value:?} to fail"
            );
        }
    }

    #[test]
    fn rejects_empty_engine_id() {
        let result = EngineConfig::parse(None, &|name| match name {
            "REACH_ENGINE_ID" => Some(String::new()),
            _ => None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn accepts_single_gateway_and_defaults() {
        let config = EngineConfig::parse(None, &|_| None).unwrap();
        assert_eq!(config.engine_id, "reach-engine");
        assert_eq!(config.gateway.origin.host, "127.0.0.1");
        assert_eq!(config.gateway.origin.port, 8787);
        assert!(config.workspace_roots.contains_key("default"));
    }
}
