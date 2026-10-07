---
name: reach-devices
description: Discover, connect to, inspect or close Reach Engine devices. Use when the user wants to work with files on a Reach device or diagnose device readiness.
---

Use `list_devices` to find registered device ids. Work only on the device the user requested; ask when the target cannot be determined.

Call `pick_device` with `deviceId`, or pass that id directly to a filesystem tool. A `connecting` result means the requested file operation has not run. Wait at least `retryAfterMs`, then call `device_status`; continue when it reports `ready` and `owned: true`. Use bounded polling and report an unavailable device instead of polling forever. Default idle heartbeats can take 120 seconds to wake a device.

`ENGINE_BUSY` means another controller owns the device. Explain this and let that owner finish; do not close or take over another owner's session. Different devices can be owned independently.

Pass `deviceId` explicitly to every filesystem and close call. Close each device you used with `session_close` when work finishes. Closing releases only this MCP session's ownership.

For trusted script tasks, follow [reach-processes](../reach-processes/SKILL.md), including same-session launchId recovery and session-owned lifetime.
