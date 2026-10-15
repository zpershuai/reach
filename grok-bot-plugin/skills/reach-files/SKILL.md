---
name: reach-files
description: Read, list, search or safely modify files in Reach Engine workspaces. Use for remote device filesystem work through Reach fs_read, fs_list, fs_stat, fs_glob, fs_grep, fs_write and fs_edit.
---

Choose the requested device using `list_devices`, then call `list_workspaces` with its `deviceId`. If connecting, poll `device_status` until ready and owned, then repeat discovery. Use a returned `workspaces` name and workspace-relative paths for file tools; do not assume `default` exists. Tool execution occurs on the Engine, so never substitute the MCP host's filesystem.

Use `fs_list` and `fs_stat` for discovery, `fs_glob` for names and `fs_grep` for literal text. Respect pagination cursors and bounded result counts.

Before changing an existing file, call `fs_read` and capture its `revision`. Supply that revision as `ifMatch` on `fs_edit` or an overwrite `fs_write`. Use `mode: create` for a new file. `fs_edit` takes `oldString`, `newString` and optional `replaceAll`.

On `REVISION_CONFLICT`, re-read and reconcile the user's requested edit with the current content. On a timeout or lost response, the write may already have committed. Re-read and inspect its revision before deciding whether another write is necessary; never replay a write blindly.

The total HTTP JSON request is limited to 64 KiB, including escaping and metadata. Keep writes within that limit. A `connecting` response means no filesystem operation ran; wait and poll `device_status`, then issue the operation when ready.

Close owned sessions with `session_close` after work finishes.

For trusted script tasks, follow [reach-processes](../reach-processes/SKILL.md), including same-session launchId recovery and session-owned lifetime.
