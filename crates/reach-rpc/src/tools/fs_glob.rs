//! `fs.glob` Tool (task 5.3): read-class bounded traversal with session-scoped
//! cursors, backed by shared workspace.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_glob_params_value, FsGlobParams,
};

use super::{check_deadline, deadline, parse_params, to_value, workspace_error};

pub struct FsGlobTool {
    descriptor: ToolDescriptor,
}

impl FsGlobTool {
    pub fn new() -> FsGlobTool {
        FsGlobTool {
            descriptor: ToolDescriptor::read("fs.glob"),
        }
    }
}

impl Tool for FsGlobTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        let params: FsGlobParams = parse_params(context.params, parse_fs_glob_params_value)?;
        let result = context
            .workspace
            .glob_until(&params, deadline(context))
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
