//! `fs.read` Tool (task 5.1): read-class, backed by the shared workspace.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_read_params_value, FsReadParams,
};

use super::{check_deadline, parse_params, to_value, workspace_error};

pub struct FsReadTool {
    descriptor: ToolDescriptor,
}

impl FsReadTool {
    pub fn new() -> FsReadTool {
        FsReadTool {
            descriptor: ToolDescriptor::read("fs.read"),
        }
    }
}

impl Tool for FsReadTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        let params: FsReadParams = parse_params(context.params, parse_fs_read_params_value)?;
        let result = context
            .workspace
            .read(&params)
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
