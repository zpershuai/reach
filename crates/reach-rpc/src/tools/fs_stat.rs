//! `fs.stat` Tool (task 5.1): read-class metadata, backed by shared workspace.

use serde_json::Value;

use crate::{
    dispatch::{InvocationContext, Tool, ToolDescriptor, ToolError},
    parse_fs_stat_params_value, FsStatParams,
};

use super::{check_deadline, parse_params, to_value, workspace_error};

pub struct FsStatTool {
    descriptor: ToolDescriptor,
}

impl FsStatTool {
    pub fn new() -> FsStatTool {
        FsStatTool {
            descriptor: ToolDescriptor::read("fs.stat"),
        }
    }
}

impl Tool for FsStatTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        check_deadline(context)?;
        let params: FsStatParams = parse_params(context.params, parse_fs_stat_params_value)?;
        let result = context
            .workspace
            .stat(&params)
            .map_err(|error| workspace_error(&error))?;
        to_value(result)
    }
}
