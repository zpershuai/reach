# Reach Grok Bot plugin

This folder provides a remote HTTP MCP plugin. Build and deploy the Gateway from this repository first; its MCP endpoint is `https://reach.example.com/mcp` on the existing HTTPS site. No connector process or client device file is needed.

Generate your private installation from the repository root:

```sh
node scripts/configure-grok-plugin.mjs .reach/deployment.json
```

The private JSON needs `gatewayUrl`, the public HTTPS Gateway root without a path. The script writes `.reach/grok-bot-plugin/` with a literal `/mcp` URL, copies the manifest, skills and logo, and refuses to overwrite an existing installation. It does not copy tokens from the input. Install that generated folder using your host's plugin installation mechanism. The checked-in folder is a template with the reserved `reach.example.com` URL; it cannot connect to your deployment directly.

Enter `REACH_CONTROLLER_TOKEN` through the host's private setup prompt. It authorizes reads and writes across every registered Engine workspace. Only the Authorization header uses a variable; URL interpolation is no longer required. The manifest does not invent secret-field metadata or a minimum Grok Bot version, so confirm that your host stores this variable privately.

During setup, check whether the actual host sends an `Origin` header. If present, configure the Gateway's `REACH_MCP_ALLOWED_ORIGINS` with that exact Origin (comma-separated for multiple approved Origins); otherwise leave it empty. The default rejects supplied Origins. Keep this check enabled, avoid wildcards, and do not record Authorization while inspecting headers. Local tests cannot determine which Origin your host sends.

Add the observed Origin as `mcpOrigin` in your private deployment JSON and run `node scripts/verify-mcp-http.mjs .reach/deployment.json` to test the same header. A 403 identifies the allowlist setup problem; a 404 indicates the deployed Gateway lacks `/mcp`. For interactive use, set `REACH_HEARTBEAT_INTERVAL_SECS=15` in the deployed Gateway environment and recreate its container to load the setting. Existing Engines learn the interval at their next heartbeat; there may be one remaining wait under the old interval.

Verify installation by listing tools, running `list_devices`, connecting to the intended device, polling `device_status` until ready, reading a known workspace file with `fs_read`, and closing it with `session_close`. All remote tools use underscore names. An unconfigured Gateway defaults to 120-second idle heartbeats; connection calls return promptly instead of waiting inside one tool request.

See [MCP deployment](../docs/deploy/mcp.md) for protocol, limits, Origin settings and the reusable verification script. Local protocol and real Engine integration tests are automated; installation behavior in a particular Grok Bot host must be verified there.
