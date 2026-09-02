use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const PROTOCOL: &str = "reach-rpc";
pub const VERSION: &str = "1.0";
pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
pub const DEFAULT_START_LINE: u32 = 1;
pub const DEFAULT_MAX_LINES: u32 = 200;
pub const MAX_MAX_LINES: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError;

impl ContractError {
    pub const fn code(&self) -> &'static str {
        INVALID_PARAMS
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(INVALID_PARAMS)
    }
}

impl std::error::Error for ContractError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub grant_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadParams {
    pub workspace: String,
    pub path: String,
    #[serde(default = "default_start_line")]
    pub start_line: u32,
    #[serde(default = "default_max_lines")]
    pub max_lines: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub protocol: String,
    pub version: String,
    pub session_id: String,
    pub request_id: String,
    pub method: String,
    pub params: FsReadParams,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadResult {
    pub content: String,
    pub start_line: u32,
    pub end_line: u32,
    pub total_lines: u32,
    pub truncated: bool,
    pub revision: String,
}

pub fn parse_fs_read_request(input: &str) -> Result<FsReadRequest, ContractError> {
    let value: Value = serde_json::from_str(input).map_err(|_| ContractError)?;
    if value.get("permission").is_some_and(Value::is_null) {
        return Err(ContractError);
    }
    let request: FsReadRequest = serde_json::from_value(value).map_err(|_| ContractError)?;
    validate_request(&request)?;
    Ok(request)
}

pub fn parse_fs_read_result(input: &str) -> Result<FsReadResult, ContractError> {
    let result: FsReadResult = serde_json::from_str(input).map_err(|_| ContractError)?;
    validate_result(&result)?;
    Ok(result)
}

pub fn serialize_request(request: &FsReadRequest) -> Result<String, ContractError> {
    validate_request(request)?;
    serde_json::to_string(request).map_err(|_| ContractError)
}

pub fn serialize_result(result: &FsReadResult) -> Result<String, ContractError> {
    validate_result(result)?;
    serde_json::to_string(result).map_err(|_| ContractError)
}

fn validate_request(request: &FsReadRequest) -> Result<(), ContractError> {
    if request.message_type != "request"
        || request.protocol != PROTOCOL
        || request.version != VERSION
        || request.method != "fs.read"
        || !is_non_empty(&request.session_id)
        || !is_non_empty(&request.request_id)
        || !is_non_empty(&request.params.workspace)
        || !is_non_empty(&request.params.path)
        || request.params.start_line < 1
        || !(1..=MAX_MAX_LINES).contains(&request.params.max_lines)
        || request
            .permission
            .as_ref()
            .is_some_and(|permission| !is_non_empty(&permission.grant_id))
    {
        return Err(ContractError);
    }
    Ok(())
}

fn validate_result(result: &FsReadResult) -> Result<(), ContractError> {
    if result.start_line < 1
        || result.end_line < result.start_line.saturating_sub(1)
        || !is_sha256_hex(&result.revision)
    {
        return Err(ContractError);
    }
    Ok(())
}

fn is_non_empty(value: &str) -> bool {
    !value.is_empty()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

const fn default_start_line() -> u32 {
    DEFAULT_START_LINE
}

const fn default_max_lines() -> u32 {
    DEFAULT_MAX_LINES
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_REQUEST: &str = r#"{
        "type": "request",
        "protocol": "reach-rpc",
        "version": "1.0",
        "sessionId": "session-1",
        "requestId": "request-1",
        "method": "fs.read",
        "params": { "workspace": "repo", "path": "README.md" }
    }"#;

    #[test]
    fn defaults_line_parameters_and_uses_camel_case() {
        let request = parse_fs_read_request(VALID_REQUEST).unwrap();
        assert_eq!(request.params.start_line, 1);
        assert_eq!(request.params.max_lines, 200);
        let serialized = serialize_request(&request).unwrap();
        assert!(serialized.contains("\"sessionId\""));
        assert!(serialized.contains("\"startLine\":1"));
    }

    #[test]
    fn ignores_unknown_fields() {
        let request = parse_fs_read_request(
            r#"{
                "type": "request", "protocol": "reach-rpc", "version": "1.0",
                "sessionId": "s", "requestId": "r", "method": "fs.read",
                "params": { "workspace": "repo", "path": "a", "future": true },
                "future": true
            }"#,
        )
        .unwrap();
        assert!(!serialize_request(&request).unwrap().contains("future"));
    }

    #[test]
    fn maps_invalid_input_to_invalid_params() {
        for input in [
            r#"{"type":"request"}"#,
            r#"{"type":"request","protocol":"jsonrpc","version":"1.0","sessionId":"s","requestId":"r","method":"fs.read","params":{"workspace":"repo","path":"a"}}"#,
            r#"{"type":"request","protocol":"reach-rpc","version":"1.0","sessionId":"s","requestId":"r","method":"fs.read","params":{"workspace":"repo","path":"a","startLine":0}}"#,
        ] {
            assert_eq!(parse_fs_read_request(input).unwrap_err().code(), INVALID_PARAMS);
        }
    }

    #[test]
    fn validates_read_result_metadata() {
        let result = parse_fs_read_result(
            r#"{"content":"hello","startLine":1,"endLine":1,"totalLines":1,"truncated":false,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        )
        .unwrap();
        assert_eq!(serialize_result(&result).unwrap(), "{\"content\":\"hello\",\"startLine\":1,\"endLine\":1,\"totalLines\":1,\"truncated\":false,\"revision\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}");
    }

    #[test]
    fn round_trips_shared_fixture_with_normalized_defaults() {
        let request = parse_fs_read_request(include_str!("../../../fixtures/fs.read.request.json")).unwrap();
        let normalized: Value = serde_json::from_str(&serialize_request(&request).unwrap()).unwrap();
        assert_eq!(normalized["params"]["startLine"], 1);
        assert_eq!(normalized["params"]["maxLines"], 200);
        assert!(normalized.get("futureEnvelope").is_none());
        assert!(normalized["params"].get("futureParameter").is_none());
        assert!(normalized["permission"].get("futurePermission").is_none());
    }
}
