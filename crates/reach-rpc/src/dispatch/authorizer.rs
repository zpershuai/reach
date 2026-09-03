//! Authorization middleware (task 4.3).
//!
//! The Gateway validates issuance, path scope, method scope, and expiry of
//! mutation grants before forward. The Engine's `Authorizer` is the second
//! boundary: a write-class Tool may run only when its invocation carries a
//! non-empty Gateway-forwarded permission claim on the bound trusted session.
//! Read-class Tools never gain mutation authority merely by sharing a session.

use crate::{
    dispatch::tool::{ToolDescriptor, ToolError},
    Permission,
};

/// Authorization state supplied to a Tool via its invocation context. Tools
/// trust this rather than re-parsing the raw caller-provided identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizationContext {
    pub write_claimed: bool,
}

/// Authorize a Tool invocation. Returns `PERMISSION_DENIED` for write-class
/// Tools without a valid permission claim; read-class Tools are always
/// authorized (they act under Gateway-granted read policy).
pub fn authorize(
    descriptor: &ToolDescriptor,
    permission: Option<&Permission>,
) -> Result<AuthorizationContext, ToolError> {
    let write_claimed = permission.is_some_and(|permission| !permission.grant_id.is_empty());
    if descriptor.access.is_write() && !write_claimed {
        return Err(ToolError::permission_denied());
    }
    Ok(AuthorizationContext { write_claimed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::tool::ToolDescriptor;

    #[test]
    fn write_tools_require_a_claim() {
        let write = ToolDescriptor::write("fs.write");
        let read = ToolDescriptor::read("fs.read");
        assert!(authorize(&write, None).is_err());
        assert!(authorize(
            &write,
            Some(&Permission {
                grant_id: String::new()
            })
        )
        .is_err());
        let authorized = authorize(
            &write,
            Some(&Permission {
                grant_id: "g1".into(),
            }),
        )
        .unwrap();
        assert!(authorized.write_claimed);
        assert!(authorize(&read, None).is_ok());
    }
}
