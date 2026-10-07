//! `fs.list` Tool (task 5.1): read-class pagination backed by shared workspace.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_list_params_value, FsListParams,
};

use super::{check_deadline, deadline, parse_params, to_value, workspace_error};

pub struct FsListTool {
    descriptor: ToolDescriptor,
}

impl FsListTool {
    pub fn new() -> FsListTool {
        FsListTool {
            descriptor: ToolDescriptor::read("fs.list"),
        }
    }
}

impl Tool for FsListTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        let params: FsListParams = parse_params(context.params, parse_fs_list_params_value)?;
        let result = context
            .workspace
            .list_until(&params, deadline(context))
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
