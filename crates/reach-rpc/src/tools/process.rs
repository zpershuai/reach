use crate::dispatch::{AccessClass, InvocationContext, Tool, ToolDescriptor, ToolError};
use serde_json::Value;

pub struct ProcessTool {
    descriptor: ToolDescriptor,
}
impl ProcessTool {
    pub fn new(method: &'static str) -> Self {
        let mut descriptor = ToolDescriptor::read(method);
        descriptor.access = match method {
            "process.run" => AccessClass::Execute,
            "process.stop" => AccessClass::ProcessControl,
            _ => AccessClass::Read,
        };
        Self { descriptor }
    }
}
impl Tool for ProcessTool {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }
    fn execute(&self, context: &mut InvocationContext<'_>) -> Result<Value, ToolError> {
        super::check_deadline(context)?;
        if context.access != self.descriptor.access {
            return Err(ToolError::permission_denied());
        }
        match self.descriptor.method {
            "process.run" => context.processes.run(context.params, context.workspace),
            "process.status" => context.processes.status(context.params),
            "process.logs" => context.processes.logs(context.params),
            "process.stop" => context.processes.stop(context.params),
            "process.list" => context.processes.list(context.params),
            _ => Err(ToolError::invalid_params()),
        }
    }
}
