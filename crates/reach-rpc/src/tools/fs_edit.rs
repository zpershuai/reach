//! `fs.edit` Tool (task 5.2): write-class, requires authorized invocation
//! context and preserves the workspace's atomic mutation guarantees.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_edit_params_value, FsEditParams,
};

use super::{check_deadline, deadline, parse_params, to_value, workspace_error};

pub struct FsEditTool {
    descriptor: ToolDescriptor,
}

impl FsEditTool {
    pub fn new() -> FsEditTool {
        FsEditTool {
            descriptor: ToolDescriptor::write("fs.edit"),
        }
    }
}

impl Tool for FsEditTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        if !context.write_claimed {
            return Err(ToolError::permission_denied());
        }
        let params: FsEditParams = parse_params(context.params, parse_fs_edit_params_value)?;
        let result = context
            .workspace
            .edit_until(&params, deadline(context))
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
