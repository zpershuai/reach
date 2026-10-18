//! Engine session control messages (control plane, distinct from data-plane
//! request/response/error envelopes).
//!
//! The WebSocket between Gateway and Engine carries two kinds of messages:
//! control messages (`session.ready`, `session.renew`, `session.close`,
//! `session.closed`) and data-plane RPC envelopes. Control messages are parsed
//! here; data-plane envelopes live in the parent `lib.rs`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{is_non_empty, ContractError, ENGINE_VERSION, PROTOCOL, VERSION};

pub const MESSAGE_READY: &str = "session.ready";
pub const MESSAGE_RENEW: &str = "session.renew";
pub const MESSAGE_CLOSE: &str = "session.close";
pub const MESSAGE_CLOSED: &str = "session.closed";

/// Machine-readable closure reasons the Engine reports to the Gateway.
pub const CLOSURE_AGENT_REQUESTED: &str = "agent_requested";
pub const CLOSURE_SESSION_COMPLETE: &str = "session_complete";
pub const CLOSURE_LEASE_EXPIRED: &str = "lease_expired";
pub const CLOSURE_IDLE_TIMEOUT: &str = "idle_timeout";
pub const CLOSURE_ROTATION: &str = "rotation";
pub const CLOSURE_DISCONNECTED: &str = "disconnected";
pub const CLOSURE_SHUTDOWN: &str = "shutdown";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReady {
    #[serde(rename = "type")]
    pub message_type: String,
    pub protocol: String,
    pub version: String,
    pub session_id: String,
    pub engine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    pub workspaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_workspaces: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_generations: Option<std::collections::BTreeMap<String, String>>,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenew {
    #[serde(rename = "type")]
    pub message_type: String,
    pub session_id: String,
    /// Absolute lease expiry as an RFC3339 UTC timestamp.
    pub lease_expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClose {
    #[serde(rename = "type")]
    pub message_type: String,
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosed {
    #[serde(rename = "type")]
    pub message_type: String,
    pub session_id: String,
    pub reason: String,
}

/// A parsed session control message, tagged by its `type`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionMessage {
    Ready(SessionReady),
    Renew(SessionRenew),
    Close(SessionClose),
    Closed(SessionClosed),
}

impl SessionMessage {
    pub fn message_type(&self) -> &'static str {
        match self {
            SessionMessage::Ready(_) => MESSAGE_READY,
            SessionMessage::Renew(_) => MESSAGE_RENEW,
            SessionMessage::Close(_) => MESSAGE_CLOSE,
            SessionMessage::Closed(_) => MESSAGE_CLOSED,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            SessionMessage::Ready(message) => &message.session_id,
            SessionMessage::Renew(message) => &message.session_id,
            SessionMessage::Close(message) => &message.session_id,
            SessionMessage::Closed(message) => &message.session_id,
        }
    }
}

fn parse_value(input: &str) -> Result<Value, ContractError> {
    serde_json::from_str(input).map_err(|_| ContractError)
}

fn validate_ready(ready: &SessionReady) -> Result<(), ContractError> {
    if ready.message_type != MESSAGE_READY
        || ready.protocol != PROTOCOL
        || ready.version != VERSION
        || !is_non_empty(&ready.session_id)
        || !is_non_empty(&ready.engine_id)
        || ready
            .engine_version
            .as_deref()
            .is_some_and(|version| !is_non_empty(version))
        || ready.workspace_generations.as_ref().is_some_and(|entries| {
            entries
                .iter()
                .any(|(name, generation)| !is_non_empty(name) || !is_non_empty(generation))
        })
        || ready.workspaces.is_empty()
        || ready.methods.is_empty()
        || ready.workspaces.iter().any(|name| !is_non_empty(name))
        || ready.methods.iter().any(|name| !is_non_empty(name))
        || ready
            .process_workspaces
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| !ready.workspaces.contains(name)))
    {
        return Err(ContractError);
    }
    Ok(())
}

fn validate_renew(renew: &SessionRenew) -> Result<(), ContractError> {
    if renew.message_type != MESSAGE_RENEW
        || !is_non_empty(&renew.session_id)
        || !is_valid_lease_expiry(&renew.lease_expires_at)
    {
        return Err(ContractError);
    }
    Ok(())
}

fn validate_close_common(
    message_type: &str,
    expected_type: &str,
    session_id: &str,
    reason: &str,
) -> Result<(), ContractError> {
    if message_type != expected_type || !is_non_empty(session_id) || !is_non_empty(reason) {
        return Err(ContractError);
    }
    Ok(())
}

fn validate_close(close: &SessionClose) -> Result<(), ContractError> {
    validate_close_common(
        &close.message_type,
        MESSAGE_CLOSE,
        &close.session_id,
        &close.reason,
    )
}

fn validate_closed(closed: &SessionClosed) -> Result<(), ContractError> {
    validate_close_common(
        &closed.message_type,
        MESSAGE_CLOSED,
        &closed.session_id,
        &closed.reason,
    )
}

/// True when `value` parses as a valid absolute RFC3339 UTC timestamp.
pub fn is_valid_lease_expiry(value: &str) -> bool {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_ok()
}

pub fn parse_session_ready(input: &str) -> Result<SessionReady, ContractError> {
    let ready: SessionReady =
        serde_json::from_value(parse_value(input)?).map_err(|_| ContractError)?;
    validate_ready(&ready)?;
    Ok(ready)
}

pub fn parse_session_renew(input: &str) -> Result<SessionRenew, ContractError> {
    let renew: SessionRenew =
        serde_json::from_value(parse_value(input)?).map_err(|_| ContractError)?;
    validate_renew(&renew)?;
    Ok(renew)
}

pub fn parse_session_close(input: &str) -> Result<SessionClose, ContractError> {
    let close: SessionClose =
        serde_json::from_value(parse_value(input)?).map_err(|_| ContractError)?;
    validate_close(&close)?;
    Ok(close)
}

pub fn parse_session_closed(input: &str) -> Result<SessionClosed, ContractError> {
    let closed: SessionClosed =
        serde_json::from_value(parse_value(input)?).map_err(|_| ContractError)?;
    validate_closed(&closed)?;
    Ok(closed)
}

/// Parse any of the four session control message shapes, rejecting an unknown
/// or malformed control message as `INVALID_PARAMS`.
pub fn parse_session_message(input: &str) -> Result<SessionMessage, ContractError> {
    let value = parse_value(input)?;
    let message_type = value.get("type").and_then(Value::as_str);
    let input = serde_json::to_string(&value).map_err(|_| ContractError)?;
    match message_type {
        Some(MESSAGE_READY) => parse_session_ready(&input).map(SessionMessage::Ready),
        Some(MESSAGE_RENEW) => parse_session_renew(&input).map(SessionMessage::Renew),
        Some(MESSAGE_CLOSE) => parse_session_close(&input).map(SessionMessage::Close),
        Some(MESSAGE_CLOSED) => parse_session_closed(&input).map(SessionMessage::Closed),
        _ => Err(ContractError),
    }
}

pub fn serialize_session_message(message: &SessionMessage) -> Result<String, ContractError> {
    match message {
        SessionMessage::Ready(ready) => validate_ready(ready)?,
        SessionMessage::Renew(renew) => validate_renew(renew)?,
        SessionMessage::Close(close) => validate_close(close)?,
        SessionMessage::Closed(closed) => validate_closed(closed)?,
    }
    let value: serde_json::Value = match message {
        SessionMessage::Ready(ready) => serde_json::to_value(ready).map_err(|_| ContractError)?,
        SessionMessage::Renew(renew) => serde_json::to_value(renew).map_err(|_| ContractError)?,
        SessionMessage::Close(close) => serde_json::to_value(close).map_err(|_| ContractError)?,
        SessionMessage::Closed(closed) => {
            serde_json::to_value(closed).map_err(|_| ContractError)?
        }
    };
    serde_json::to_string(&value).map_err(|_| ContractError)
}

/// Build a `session.ready` message from the values the Engine advertises.
pub fn session_ready(
    session_id: &str,
    engine_id: &str,
    workspaces: Vec<String>,
    methods: Vec<String>,
) -> SessionReady {
    SessionReady {
        message_type: MESSAGE_READY.to_owned(),
        protocol: PROTOCOL.to_owned(),
        version: VERSION.to_owned(),
        session_id: session_id.to_owned(),
        engine_id: engine_id.to_owned(),
        engine_version: Some(ENGINE_VERSION.to_owned()),
        workspaces,
        process_workspaces: None,
        workspace_generations: None,
        methods,
    }
}

/// Build a `session.closed` message for a given session and closure reason.
pub fn session_closed(session_id: &str, reason: &str) -> SessionClosed {
    SessionClosed {
        message_type: MESSAGE_CLOSED.to_owned(),
        session_id: session_id.to_owned(),
        reason: reason.to_owned(),
    }
}

/// Build a `session.close` message (Gateway requests Engine closure).
pub fn session_close(session_id: &str, reason: &str) -> SessionClose {
    SessionClose {
        message_type: MESSAGE_CLOSE.to_owned(),
        session_id: session_id.to_owned(),
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_generations_are_additive_and_round_trip() {
        let mut value: Value =
            serde_json::from_str(include_str!("../../../fixtures/session.ready.json")).unwrap();
        let ready = parse_session_ready(&value.to_string()).unwrap();
        assert_eq!(
            ready.workspace_generations.as_ref().unwrap()["default"],
            "generation-default"
        );
        let text = serialize_session_message(&SessionMessage::Ready(ready.clone())).unwrap();
        assert_eq!(parse_session_ready(&text).unwrap(), ready);
        value
            .as_object_mut()
            .unwrap()
            .remove("workspaceGenerations");
        assert!(parse_session_ready(&value.to_string())
            .unwrap()
            .workspace_generations
            .is_none());
        for generations in [
            serde_json::json!({"": "value"}),
            serde_json::json!({"default": ""}),
        ] {
            value["workspaceGenerations"] = generations;
            assert!(parse_session_ready(&value.to_string()).is_err());
        }
    }

    #[test]
    fn readiness_accepts_enabled_disabled_and_unreported_process_workspaces() {
        let legacy = include_str!("../../../fixtures/session.ready.json");
        let mut value: Value = serde_json::from_str(legacy).unwrap();
        assert!(parse_session_ready(legacy)
            .unwrap()
            .process_workspaces
            .is_none());
        for names in [vec![], vec!["default"]] {
            value["processWorkspaces"] = serde_json::json!(names);
            let ready = parse_session_ready(&value.to_string()).unwrap();
            assert_eq!(ready.process_workspaces.unwrap(), names);
        }
        value["processWorkspaces"] = serde_json::json!(["not-a-workspace"]);
        assert!(parse_session_ready(&value.to_string()).is_err());
    }
    use crate::INVALID_PARAMS;

    #[test]
    fn parses_shared_ready_fixture() {
        let ready =
            parse_session_ready(include_str!("../../../fixtures/session.ready.json")).unwrap();
        assert_eq!(ready.engine_version, None);
        assert_eq!(ready.session_id, "session-1");
        assert_eq!(ready.engine_id, "reach-engine");
        assert_eq!(ready.workspaces, ["default", "fixture"]);
        assert!(ready.methods.contains(&"fs.read".to_owned()));
        // Unknown fields are ignored, matching the data-plane contract.
        assert!(!serde_json::to_string(&ready)
            .unwrap()
            .contains("futureField"));
    }

    #[test]
    fn parses_shared_renew_fixture() {
        let renew =
            parse_session_renew(include_str!("../../../fixtures/session.renew.json")).unwrap();
        assert_eq!(renew.session_id, "session-1");
        assert!(is_valid_lease_expiry(&renew.lease_expires_at));
    }

    #[test]
    fn parses_shared_close_and_closed_fixtures() {
        let close =
            parse_session_close(include_str!("../../../fixtures/session.close.json")).unwrap();
        assert_eq!(close.session_id, "session-1");
        assert_eq!(close.reason, CLOSURE_AGENT_REQUESTED);

        let closed =
            parse_session_closed(include_str!("../../../fixtures/session.closed.json")).unwrap();
        assert_eq!(closed.session_id, "session-1");
        assert_eq!(closed.reason, CLOSURE_LEASE_EXPIRED);
    }

    #[test]
    fn rejects_malformed_control_messages() {
        // Missing session id.
        for input in [
            r#"{"type":"session.renew","leaseExpiresAt":"2026-09-03T12:00:00Z"}"#,
            r#"{"type":"session.close","reason":"agent_requested"}"#,
        ] {
            assert_eq!(
                parse_session_message(input).unwrap_err().code(),
                INVALID_PARAMS
            );
        }
        // Missing or malformed lease expiry.
        for input in [
            r#"{"type":"session.renew","sessionId":"s","leaseExpiresAt":"yesterday"}"#,
            r#"{"type":"session.renew","sessionId":"s"}"#,
        ] {
            assert_eq!(
                parse_session_renew(input).unwrap_err().code(),
                INVALID_PARAMS
            );
        }
        // Empty reason.
        for input in [
            r#"{"type":"session.close","sessionId":"s","reason":""}"#,
            r#"{"type":"session.closed","sessionId":"s","reason":""}"#,
        ] {
            assert_eq!(
                parse_session_close(input).unwrap_err().code(),
                INVALID_PARAMS
            );
        }
        // Unknown control type is not a session message.
        for input in [
            r#"{"type":"session.frobnicate","sessionId":"s"}"#,
            r#"not json"#,
        ] {
            assert_eq!(
                parse_session_message(input).unwrap_err().code(),
                INVALID_PARAMS
            );
        }
        // Empty engine id / empty workspaces / empty methods in ready.
        for input in [
            r#"{"type":"session.ready","protocol":"reach-rpc","version":"1.0","sessionId":"s","engineId":"","workspaces":["w"],"methods":["fs.read"]}"#,
            r#"{"type":"session.ready","protocol":"reach-rpc","version":"1.0","sessionId":"s","engineId":"e","workspaces":[],"methods":["fs.read"]}"#,
        ] {
            assert_eq!(
                parse_session_ready(input).unwrap_err().code(),
                INVALID_PARAMS
            );
        }
    }

    #[test]
    fn distinguishes_control_from_other_types() {
        assert!(matches!(
            parse_session_message(r#"{"type":"session.ready","protocol":"reach-rpc","version":"1.0","sessionId":"s","engineId":"e","workspaces":["w"],"methods":["fs.read"]}"#).unwrap(),
            SessionMessage::Ready(_)
        ));
        assert!(parse_session_message(r#"{"type":"request","protocol":"reach-rpc","version":"1.0","sessionId":"s","requestId":"r","method":"fs.read","params":{}}"#).is_err());
    }

    #[test]
    fn serializes_control_messages_round_trip_with_type() {
        let ready = session_ready(
            "s",
            "engine",
            vec!["default".into()],
            vec!["fs.read".into()],
        );
        let text = serialize_session_message(&SessionMessage::Ready(ready)).unwrap();
        assert!(text.contains("\"type\":\"session.ready\""));
        assert!(text.contains("\"sessionId\":\"s\""));
        assert_eq!(
            parse_session_ready(&text)
                .unwrap()
                .engine_version
                .as_deref(),
            Some(ENGINE_VERSION)
        );
    }
}
