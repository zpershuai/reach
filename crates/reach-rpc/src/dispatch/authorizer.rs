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
    pub access: crate::dispatch::AccessClass,
}

/// Authorize a Tool invocation. Returns `PERMISSION_DENIED` for write-class
/// Tools without a valid permission claim; read-class Tools are always
/// authorized (they act under Gateway-granted read policy).
pub fn authorize(
    descriptor: &ToolDescriptor,
    permission: Option<&Permission>,
) -> Result<AuthorizationContext, ToolError> {
    let write_claimed = permission.is_some_and(|permission| !permission.grant_id.is_empty());
    if descriptor.access != crate::dispatch::AccessClass::Read && !write_claimed {
        return Err(ToolError::permission_denied());
    }
    let kind = permission.and_then(|p| p.kind.as_deref());
    match descriptor.access {
        crate::dispatch::AccessClass::Execute if kind != Some("execute") => {
            return Err(ToolError::permission_denied())
        }
        crate::dispatch::AccessClass::ProcessControl if kind != Some("control") => {
            return Err(ToolError::permission_denied())
        }
        crate::dispatch::AccessClass::Write if kind.is_some() => {
            return Err(ToolError::permission_denied())
        }
        _ => {}
    }
    Ok(AuthorizationContext {
        write_claimed: descriptor.access.is_write() && write_claimed,
        access: descriptor.access,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::tool::ToolDescriptor;

    #[test]
    fn access_classes_require_their_own_permission_kind() {
        use crate::dispatch::AccessClass;
        for access in [
            AccessClass::Read,
            AccessClass::Write,
            AccessClass::Execute,
            AccessClass::ProcessControl,
        ] {
            let mut descriptor = ToolDescriptor::read("fixture");
            descriptor.access = access;
            for grant in [None, Some(""), Some("g1")] {
                for kind in [None, Some("execute"), Some("control"), Some("unknown")] {
                    let permission = grant.map(|id| Permission {
                        grant_id: id.into(),
                        kind: kind.map(str::to_owned),
                    });
                    let expected = access == AccessClass::Read
                        || (grant == Some("g1")
                            && match access {
                                AccessClass::Write => kind.is_none(),
                                AccessClass::Execute => kind == Some("execute"),
                                AccessClass::ProcessControl => kind == Some("control"),
                                AccessClass::Read => true,
                            });
                    let result = authorize(&descriptor, permission.as_ref());
                    assert_eq!(result.is_ok(), expected, "{access:?} {grant:?} {kind:?}");
                    if let Ok(context) = result {
                        assert_eq!(context.write_claimed, access == AccessClass::Write);
                    }
                }
            }
        }
    }

    #[test]
    fn write_tools_require_a_claim() {
        let write = ToolDescriptor::write("fs.write");
        let read = ToolDescriptor::read("fs.read");
        assert!(authorize(&write, None).is_err());
        assert!(authorize(
            &write,
            Some(&Permission {
                grant_id: String::new(),
                kind: None,
            })
        )
        .is_err());
        let authorized = authorize(
            &write,
            Some(&Permission {
                grant_id: "g1".into(),
                kind: None,
            }),
        )
        .unwrap();
        assert!(authorized.write_claimed);
        assert!(authorize(&read, None).is_ok());
    }
}
