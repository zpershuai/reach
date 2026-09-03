//! `fs.write` Tool (task 5.2): write-class, requires authorized invocation
//! context and preserves the workspace's atomic mutation guarantees.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_write_params, FsWriteParams,
};

use super::{check_deadline, parse_params, to_value, workspace_error};

pub struct FsWriteTool {
    descriptor: ToolDescriptor,
}

impl FsWriteTool {
    pub fn new() -> FsWriteTool {
        FsWriteTool {
            descriptor: ToolDescriptor::write("fs.write"),
        }
    }
}

impl Tool for FsWriteTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        // Authorization arrives through the context, not the raw request.
        // The Dispatcher denies unpermissioned write invocations before the
        // Tool runs; this guard defends against direct invocation.
        if !context.write_claimed {
            return Err(ToolError::permission_denied());
        }
        let params: FsWriteParams = parse_params(context.params, parse_fs_write_params)?;
        let result = context
            .workspace
            .write(&params)
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
