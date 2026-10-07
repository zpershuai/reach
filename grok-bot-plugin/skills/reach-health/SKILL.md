---
name: reach-health
description: Diagnose Reach Gateway connectivity, authentication, versions and Engine availability. Use when Reach tools cannot connect, a device remains connecting, or an operation returns a session or deadline error.
---

Use `list_devices`, `get_versions` and `device_status` to distinguish registered devices, reported releases and live session readiness. `lastSeenAt` and the last reported Engine version do not prove the device is online now.

HTTP 401 means a missing or incorrect Controller token; the Engine token cannot authorize MCP. HTTP 403 with an Origin error requires the operator to configure the exact client origin in `REACH_MCP_ALLOWED_ORIGINS`. Never ask the user to paste tokens into chat or include credentials in diagnostics.

An unknown or expired MCP session returns HTTP 404; reconnect and initialize through the MCP host. `ENGINE_BUSY` means another controller is using this Engine. A sleeping device can take up to its idle heartbeat interval to notice an open intent; poll with the returned retry delay.

`DEADLINE_EXCEEDED` does not prove a mutation failed. Re-read before another write. Report persistent failures with the device id, operation and error code, excluding tokens and private deployment details.
