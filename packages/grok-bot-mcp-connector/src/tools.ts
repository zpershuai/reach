type Schema = Record<string, unknown>;

const string = (description: string): Schema => ({ type: "string", description });
const integer = (description: string, minimum: number): Schema => ({ type: "integer", description, minimum });

function object(properties: Record<string, Schema>, required: readonly string[] = []): Schema {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function tool(name: string, description: string, inputSchema: Schema): Record<string, unknown> {
  return { name, description, inputSchema };
}

export function deviceTools(): readonly Record<string, unknown>[] {
  return [
    tool("list_devices", "List configured Reach Engine devices. Each Engine installation provisions a private Node.js runtime at ~/.reach/runtime/node/bin/node for Gateway and MCP processes on that host.", object({})),
    tool("get_versions", "Inspect MCP, Gateway and the last reported Engine release versions without opening a session. Omit deviceId to inspect the selected device, or only MCP when none is selected. Unknown versions are null.", object({ deviceId: string("Optional configured Reach device identifier.") })),
    tool("pick_device", "Open and select a ready Reach Engine device.", object({ deviceId: string("Configured Reach device identifier.") }, ["deviceId"])),
  ];
}

export function deviceScopedTools(): readonly Record<string, unknown>[] {
  return [
    tool("fs.read", "Read a file from the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative file path."),
      startLine: integer("One-based first line to read.", 1), maxLines: integer("Maximum lines to return.", 1),
    }, ["workspace", "path"])),
    tool("fs.write", "Write a file on the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative file path."), content: string("Complete file content."),
      mode: { type: "string", enum: ["overwrite", "create"] }, ifMatch: string("Optional current file revision."),
    }, ["workspace", "path", "content", "mode"])),
    tool("fs.edit", "Edit matching text in a selected Reach Engine workspace file.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative file path."), oldString: string("Text to replace."),
      newString: string("Replacement text."), replaceAll: { type: "boolean" }, ifMatch: string("Optional current file revision."),
    }, ["workspace", "path", "oldString", "newString"])),
    tool("fs.list", "List entries in the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative directory path."),
      maxEntries: integer("Maximum entries to return.", 1), cursor: string("Continuation cursor."),
    }, ["workspace"])),
    tool("fs.glob", "Find files in the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), pattern: string("Glob pattern."), path: string("Workspace-relative search root."),
      maxResults: integer("Maximum matches to return.", 1), respectGitignore: { type: "boolean" }, cursor: string("Continuation cursor."),
    }, ["workspace", "pattern"])),
    tool("fs.stat", "Inspect a selected Reach Engine workspace path.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative path."),
    }, ["workspace", "path"])),
    tool("fs.grep", "Search text in the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), pattern: string("Literal text to find."), path: string("Workspace-relative search root."),
      include: { type: "array", items: { type: "string" } }, maxMatches: integer("Maximum matches to return.", 1), cursor: string("Continuation cursor."),
    }, ["workspace", "pattern"])),
    tool("session.close", "Close the selected Reach Engine session.", object({})),
  ];
}

/** Path 1 compatibility surface for clients that do not honor tools/list_changed. */
export function staticDeviceScopedTools(): readonly Record<string, unknown>[] {
  return deviceScopedTools().map((definition) => {
    const schema = definition.inputSchema as { properties: Record<string, Schema>; required?: readonly string[] };
    return {
      ...definition,
      inputSchema: object(
        { deviceId: string("Configured Reach device identifier."), ...schema.properties },
        ["deviceId", ...(schema.required ?? [])],
      ),
    };
  });
}
