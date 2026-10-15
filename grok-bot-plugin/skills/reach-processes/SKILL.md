---
name: reach-processes
description: Run, inspect, read logs or stop trusted Node scripts on a Reach Engine through process_run, process_status, process_logs, process_stop and process_list.
---

Use the requested deviceId and a workspace-relative script path. Call `list_workspaces` first and choose a name from `processWorkspaces`; an empty list means execution is disabled or not advertised. Execution occurs on the Engine using its fixed private Node runtime. Workspace validation is not a sandbox: run only trusted scripts.

Choose a unique launchId for each intended task and retain its exact parameters. process_run obtains a session-scoped execute grant; process_stop obtains a control grant for processId. Observation tools do not launch tasks. Do not supply or invent grant IDs.

If connecting, wait retryAfterMs and poll device_status until ready and owned before launching. After an uncertain launch or timeout, query process_status with the same launchId on the same owned session. Do not automatically replay process_run or open a replacement session to look up an old task. PROCESS_NOT_FOUND after session loss does not prove a launch never happened.

Use process_logs with its returned cursor for bounded stdout/stderr pages; use process_status to distinguish terminal state from running. Stop a task with process_stop and confirm its status. Closing the session, lease expiry, disconnect or Engine shutdown terminates session-owned tasks; these are not persistent background services. Close with session_close only after work is finished. Its closed/owned flags distinguish an actual owned close from a no-op.

See [process configuration and recovery](../../../docs/deploy/processes.md) in the source repository; these instructions also apply when the plugin is installed independently.
