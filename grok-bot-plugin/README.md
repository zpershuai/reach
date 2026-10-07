# Reach Grok Bot plugin

This folder provides a remote HTTP MCP plugin. Build and deploy the Gateway from this repository first; its MCP endpoint is `https://reach.example.com/mcp` on the existing HTTPS site. No connector process or client device file is needed.

Install this folder using your Grok Bot host's local plugin installation mechanism and configure:

- `REACH_GATEWAY_URL`: your Gateway's HTTPS root, without a trailing slash or path.
- `REACH_CONTROLLER_TOKEN`: the Gateway Controller token. It authorizes reads and writes across every registered Engine workspace. Store it in the host's private settings, never in this repository.

The manifest intentionally does not invent a minimum Grok Bot version or an unsupported secret-field annotation. Confirm that your host stores setup variables privately. URL variable interpolation still requires verification in Grok Bot: if the host leaves `${REACH_GATEWAY_URL}` unresolved, replace only the `url` in a private copy of `mcp.json` with your literal HTTPS `/mcp` URL. Keep the token in the authorization variable.

During setup, check whether the actual host sends an `Origin` header. If present, configure the Gateway's `REACH_MCP_ALLOWED_ORIGINS` with that exact Origin (comma-separated for multiple approved Origins); otherwise leave it empty. The default rejects supplied Origins. Keep this check enabled, avoid wildcards, and do not record Authorization while inspecting headers. Local tests cannot determine which Origin your host sends.

Verify installation by listing tools, running `list_devices`, connecting to the intended device, polling `device_status` until ready, reading a known workspace file with `fs_read`, and closing it with `session_close`. All remote tools use underscore names. Default idle heartbeats can take 120 seconds; connection calls return promptly instead of waiting inside one tool request.

See [MCP deployment](../docs/deploy/mcp.md) for protocol, limits, Origin settings and the reusable verification script. Local protocol and real Engine integration tests are automated; installation behavior in a particular Grok Bot host must be verified there.
