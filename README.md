# Reach

Gateway and engine for Grok Bot. Protocol: reach-rpc/1.0.

v1 test target: this Grok Bot computer.

## Round 2 heartbeat gateway

Start the loopback-only gateway (default `127.0.0.1:8787`):

```bash
cd packages/reach-rpc
npm run gateway
```

In a second terminal, an engine heartbeat receives the default 120-second interval:

```bash
curl -sS -X POST http://127.0.0.1:8787/heartbeat \
  -H 'content-type: application/json' \
  --data '{"device":{"id":"engine-1","platform":"linux"}}'
# {"intervalSeconds":120}
```

Requesting a session changes subsequent heartbeat responses to 5 seconds:

```bash
curl -sS -X POST http://127.0.0.1:8787/session-wanted \
  -H 'content-type: application/json' \
  --data '{"wanted":true}'
curl -sS -X POST http://127.0.0.1:8787/heartbeat \
  -H 'content-type: application/json' \
  --data '{"device":{"id":"engine-1","platform":"linux"}}'
# {"intervalSeconds":5}
```

The session-wanted state is gateway-wide and resets when the process stops.

## Round 3 one-shot session

With the gateway still running, request a session and run the Rust engine client from the repository root:

```bash
curl -sS -X POST http://127.0.0.1:8787/session-wanted \
  -H 'content-type: application/json' \
  --data '{"wanted":true}'
cargo run --bin session-client -- http://127.0.0.1:8787
```

The engine prints `Reach engine session connected` then `Reach engine session closed`.
The gateway prints `Reach session connected`, `Reach session job done`, and `Reach session closed`.
The local loopback URL returned in `wssUrl` uses `ws://`; a deployed TLS terminator can supply `wss://` without changing the session fields.

## Gateway hardening

Session tokens are single-use and expire after 30 seconds. A live connection has a five-minute maximum duration and a 60-second inbound-idle limit. HTTP JSON bodies are limited to 64 KiB and WebSocket text messages to 1 MiB.

The session heartbeat now also returns a `sessionId`. Every RPC request must be a complete `reach-rpc/1.0` envelope containing that ID, a non-empty `requestId`, method, and object parameters. To mutate a file, issue a scoped grant first:

```bash
curl -sS -X POST http://127.0.0.1:8787/grants \
  -H 'content-type: application/json' \
  --data '{"workspace":"default","path":"notes/today.txt","methods":["fs.write"]}'
```

The default workspace is `~/.reach/workspace`. Deployments can pass an explicit name-to-root map to `createGateway({ workspaceRoots: { default: "/srv/reach" } })`; unknown workspace names are denied. Search and mutation operations are bounded, and mutations reject symlink traversal.
