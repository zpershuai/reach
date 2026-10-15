---
name: reach-devices
description: Discover, connect to, inspect or close Reach Engine devices. Use when the user wants to work with files on a Reach device or diagnose device readiness.
---

Use `list_devices` to find registered device ids. Work only on the device the user requested; ask when the target cannot be determined.

Call `list_workspaces` with `deviceId` to connect and discover the Engine's workspace names. A `connecting` result means discovery is pending. Wait at least `retryAfterMs`, then call `device_status`; when it reports `ready` and `owned: true`, call `list_workspaces` again. Use bounded polling and report an unavailable device instead of polling forever. Default idle heartbeats can take 120 seconds to wake a device. Use only advertised `workspaces` names for files and `processWorkspaces` names for execution; never guess `default` or an absolute root. `pick_device` can connect without discovering names.

`ENGINE_BUSY` means another controller owns the device. Explain this and let that owner finish; do not close or take over another owner's session. Different devices can be owned independently.

Pass `deviceId` explicitly to every filesystem and close call. Close each device you used with `session_close` when work finishes. Closing releases only this MCP session's ownership.

For trusted script tasks, follow [reach-processes](../reach-processes/SKILL.md), including same-session launchId recovery and session-owned lifetime.
