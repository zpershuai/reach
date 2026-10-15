# Gateway console development

The console is a React/Vite app served at `/console/` by the Gateway. Its assets build into `packages/reach-rpc/dist/console/`; Gateway API modules compile separately into `dist/console-api/`. All fonts and the QR encoder are bundled locally. The build checks emitted HTML/CSS resource references; inert dependency documentation, attribution and license URLs are permitted. Gateway CSP limits resource requests to the same origin (plus data images for the QR code). Dependencies are development dependencies and are absent from the Gateway runtime image.

From the repository root:

```sh
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/gateway-console ci --ignore-scripts
npm --prefix packages/reach-rpc run build
npm --prefix packages/gateway-console run build
cargo build --locked --bin engine
mkdir -p .reach/console-dev
REACH_DATA_DIR="$PWD/.reach/console-dev/data" \
REACH_PUBLIC_ORIGIN=http://127.0.0.1:8787 \
REACH_CONTROLLER_TOKEN=cccccccccccccccccccccccccccccccccccccccccccccccc \
REACH_ENGINE_TOKEN=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee \
REACH_ENGINE_ID=engine-a REACH_HEARTBEAT_INTERVAL_SECS=1 \
node packages/reach-rpc/dist/gateway-main.js
```

These fixed credentials are loopback test fixtures. Use randomly generated credentials in an installation. Keep real configuration and verification output in ignored `.reach/` files or outside the repository.

Open `http://127.0.0.1:8787/console/`. Enter the setup token printed by the Gateway, scan the TOTP QR, choose a password, confirm a fresh code, and save the ten recovery codes. Setup and sign-in use a short-lived anonymous CSRF cookie obtained from `GET /api/console/me`; successful authentication replaces it with the administrator session. No credential, enrollment token or recovery code is written to browser storage.

In a second terminal, start the seed Engine:

```sh
mkdir -p .reach/console-dev/workspace
REACH_GATEWAY_URL=http://127.0.0.1:8787 \
REACH_ENGINE_TOKEN=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee \
REACH_ENGINE_ID=engine-a \
REACH_WORKSPACE_ROOTS="default:$PWD/.reach/console-dev/workspace" \
target/debug/engine
```

Check Overview, the heartbeating device and its reported hardware, the horizontally scrolling Topology view, and the device drawer. Open an MCP session against `/mcp` with the Controller token to generate actual RPC traffic; particles only appear for received events. Check Activity filters and CSV/JSONL exports, then disconnect the MCP client in Clients. In Devices, enroll a second Engine, copy its one-time token, start it against this loopback Gateway, and watch the wizard change from waiting to connected. Confirm a sensitive action after ten minutes to exercise re-authentication. Test both themes, a narrow viewport and reduced-motion preferences. Older Engines display execution settings as **not reported**; a reported empty `processWorkspaces` list means **disabled** for every workspace.

For hot reload, start the Gateway with `REACH_PUBLIC_ORIGIN=http://127.0.0.1:5173`, then run `npm --prefix packages/gateway-console run dev` and open that origin. Vite proxies console API requests to `http://127.0.0.1:8787`; set `REACH_DEV_GATEWAY` when the Gateway uses another loopback port. Direct Engine and MCP requests still use the Gateway listener. Production verification should use the built assets on the Gateway origin.

```sh
npm --prefix packages/gateway-console test
npm --prefix packages/gateway-console run build
npm --prefix packages/reach-rpc test
```

Close test browser tabs and stop the local Engine and Gateway when finished. Preserve the data directory when restarting to test durable registration and login.
