//! `fs.grep` Tool (task 5.3): read-class bounded search with session-scoped
//! cursors, backed by shared workspace.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_grep_params, FsGrepParams,
};

use super::{check_deadline, deadline, parse_params, to_value, workspace_error};

pub struct FsGrepTool {
    descriptor: ToolDescriptor,
}

impl FsGrepTool {
    pub fn new() -> FsGrepTool {
        FsGrepTool {
            descriptor: ToolDescriptor::read("fs.grep"),
        }
    }
}

impl Tool for FsGrepTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        let params: FsGrepParams = parse_params(context.params, parse_fs_grep_params)?;
        let result = context
            .workspace
            .grep_until(&params, deadline(context))
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
