//! Single-level `tool.call` compatibility canonicalization (task 4.4).
//!
//! The network's canonical data-plane request is a direct method such as
//! `fs.read`. A single-level `tool.call { name, arguments }` is accepted only
//! as a compatibility adapter and canonicalized to the equivalent direct
//! invocation *before* authorization and Tool lookup. Nested, malformed, empty,
//! or depth-exhausted wrappers are rejected as `INVALID_PARAMS`; no Tool ever
//! receives `tool.call` as its business method.

use serde_json::{json, Value};

use crate::INVALID_PARAMS;

/// A request canonicalized to a direct method invocation.
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalInvocation {
    pub method: String,
    pub params: Value,
    /// True when this request arrived wrapped in a single `tool.call`.
    pub compat_wrapped: bool,
}

pub fn invalid() -> Result<CanonicalInvocation, String> {
    Err(INVALID_PARAMS.to_owned())
}

/// Canonicalize `method`/`params` to a direct invocation. `params` is the
/// already-parsed request `params` object from the validated envelope.
pub fn canonicalize_invocation(
    method: &str,
    params: &Value,
) -> Result<CanonicalInvocation, String> {
    if method != "tool.call" {
        if method.trim().is_empty() || !params.is_object() {
            return invalid();
        }
        return Ok(CanonicalInvocation {
            method: method.to_owned(),
            params: params.clone(),
            compat_wrapped: false,
        });
    }

    // Single-level wrapper: { name: string, arguments: object }.
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return invalid();
    };
    if name.is_empty() || name.trim().is_empty() {
        return invalid();
    }
    let Some(arguments) = params.get("arguments") else {
        return invalid();
    };
    if !arguments.is_object() {
        return invalid();
    }
    // Nested or recursive tool.call is never dispatched.
    if name == "tool.call" {
        return invalid();
    }
    Ok(CanonicalInvocation {
        method: name.to_owned(),
        params: arguments.clone(),
        compat_wrapped: true,
    })
}

/// The `tool.call` wrapper shape, for diagnostics and fixture tests.
pub fn tool_call_wrapper(name: &str, arguments: Option<Value>) -> Value {
    json!({ "name": name, "arguments": arguments.unwrap_or_else(|| json!({})) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn direct_methods_pass_through() {
        let invocation = canonicalize_invocation("fs.read", &json!({ "path": "a" })).unwrap();
        assert_eq!(invocation.method, "fs.read");
        assert!(!invocation.compat_wrapped);
    }

    #[test]
    fn single_level_tool_call_is_unwrapped() {
        let invocation = canonicalize_invocation(
            "tool.call",
            &json!({ "name": "fs.write", "arguments": { "path": "a", "mode": "overwrite" } }),
        )
        .unwrap();
        assert_eq!(invocation.method, "fs.write");
        assert!(invocation.compat_wrapped);
        assert_eq!(
            invocation.params,
            json!({ "path": "a", "mode": "overwrite" })
        );
    }

    #[test]
    fn nested_tool_call_is_rejected() {
        for wrapper in [
            json!({ "name": "tool.call", "arguments": { "name": "fs.write", "arguments": {} } }),
            json!({ "name": "" , "arguments": {} }),
            json!({ "name": "fs.write" }),
            json!({ "name": "fs.write", "arguments": [] }),
            json!({ "arguments": {} }),
            json!({}),
        ] {
            assert_eq!(
                canonicalize_invocation("tool.call", &wrapper).unwrap_err(),
                INVALID_PARAMS,
                "expected {wrapper} to be rejected"
            );
        }
    }

    #[test]
    fn empty_methods_and_non_object_params_rejected() {
        assert!(canonicalize_invocation("", &json!({})).is_err());
        assert!(canonicalize_invocation("fs.read", &json!([])).is_err());
    }
}
