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
