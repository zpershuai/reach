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
    tool("list_devices", "List configured Reach Engine devices. Each Engine installation provisions a private Node.js runtime at ~/.reach/runtime/node/bin/node for Gateway and MCP processes on that host. Engine uses this runtime for trusted workspace scripts when process execution is explicitly enabled.", object({})),
    tool("get_versions", "Inspect MCP, Gateway and the last reported Engine release versions without opening a session. Omit deviceId to inspect the selected device, or only MCP when none is selected. Unknown versions are null.", object({ deviceId: string("Optional configured Reach device identifier.") })),
    tool("pick_device", "Open and select a ready Reach Engine device. Multiple Engines can share one Gateway; the selected device determines where filesystem tools execute.", object({ deviceId: string("Configured Reach device identifier.") }, ["deviceId"])),
  ];
}

export function deviceScopedTools(): readonly Record<string, unknown>[] {
  return [
    tool("process.run", "Start a trusted workspace Node script using the target Engine's private runtime. Runs with the Engine account privileges; workspace entry validation is not a sandbox. Returns immediately. Supply a unique launchId; after an uncertain result query process.status by launchId on the same session before another launch. Owner session closure stops the task.", object({
      workspace: string("Execution-enabled Engine workspace."), script: string("Workspace-relative .js, .mjs or .cjs entry file."),
      launchId: string("Unique launch identity retained for this session; reuse only for the identical launch."),
      args: { type: "array", items: { type: "string" }, maxItems: 128 }, cwd: string("Workspace-relative working directory; defaults to root."),
      timeoutMs: { ...integer("Task lifetime, separate from RPC timeout; default 60000, capped by Engine policy.", 1), maximum: 86400000 },
      ifMatch: string("Optional entry revision; does not cover dependencies."),
    }, ["workspace", "script", "launchId"])),
    tool("process.status", "Inspect an owned task by exactly one of processId or launchId. Use launchId to recover an uncertain run on the same session. Running does not imply service readiness.", { ...object({ processId: string("Managed task ID."), launchId: string("Original launch identity.") }), oneOf: [{ required: ["processId"], not: { required: ["launchId"] } }, { required: ["launchId"], not: { required: ["processId"] } }] }),
    tool("process.logs", "Read bounded stdout/stderr records of an owned task. Pass nextCursor to read incrementally; truncated reports lost output. eof is true after pipes drain.", object({ processId: string("Managed task ID."), cursor: string("Task-bound output cursor."), maxBytes: { ...integer("Maximum output text bytes; default 16384.", 1), maximum: 16384 } }, ["processId"])),
    tool("process.stop", "Stop an owned managed task and its ordinary process-group descendants. Returns promptly; poll status for completion. Repeated stop of a terminal task is safe. Accepts no OS PID.", object({ processId: string("Managed task ID.") }, ["processId"])),
    tool("process.list", "List this session's managed tasks, including retained terminal records. Does not enumerate other sessions or host processes.", object({ workspace: string("Optional workspace filter."), cursor: string("List continuation cursor."), maxEntries: { ...integer("Maximum records; default 50.", 1), maximum: 128 } })),
    tool("fs.read", "Read a file from the selected Reach Engine workspace.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative file path."),
      startLine: integer("One-based first line to read.", 1), maxLines: integer("Maximum lines to return.", 1),
    }, ["workspace", "path"])),
    tool("fs.write", "Write a file on the selected Reach Engine workspace. Read revision first and pass ifMatch for an existing file. Use mode=create for a new file. Writes are never automatically retried; re-read after a timeout before another write.", object({
      workspace: string("Engine workspace name."), path: string("Workspace-relative file path."), content: string("Complete file content."),
      mode: { type: "string", enum: ["overwrite", "create"] }, ifMatch: string("Optional current file revision."),
    }, ["workspace", "path", "content", "mode"])),
    tool("fs.edit", "Edit matching text in a selected Reach Engine workspace file. Read revision first and pass ifMatch. Edits are never automatically retried; re-read after a timeout before another edit.", object({
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
      inputSchema: { ...schema, ...object(
        { deviceId: string("Configured Reach device identifier."), ...schema.properties },
        ["deviceId", ...(schema.required ?? [])],
      ) },
    };
  });
}
