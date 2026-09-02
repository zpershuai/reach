# Reach

Gateway and engine for Grok Bot. Protocol: reach-rpc/1.0.

**Model B topology:** the Gateway is the control plane; a long-running Engine on the device owns the workspace and executes `fs.*` RPC. Local development still uses loopback (`127.0.0.1`) with two processes.

## Two-process loopback proof

Terminal 1 — start the Gateway (default `127.0.0.1:8787`):

```bash
cd packages/reach-rpc
npm run gateway
```

Terminal 2 — start the Engine service (heartbeats the Gateway; default workspace `~/.reach/workspace`):

```bash
cargo run -p reach-rpc --bin engine -- http://127.0.0.1:8787
# optional: REACH_WORKSPACE_ROOTS=default:/srv/reach,fixture:/tmp/fixture
```

Terminal 3 — request a session, then drive filesystem RPC through the Gateway:

```bash
curl -sS -X POST http://127.0.0.1:8787/session-wanted \
  -H 'content-type: application/json' \
  --data '{"wanted":true}'

# Wait until the Engine connects (Gateway logs "Reach session connected").

curl -sS -X POST http://127.0.0.1:8787/session/rpc \
  -H 'content-type: application/json' \
  --data '{"requestId":"r1","method":"fs.read","params":{"workspace":"default","path":"notes/today.txt","maxLines":20}}'

curl -sS -X POST http://127.0.0.1:8787/grants \
  -H 'content-type: application/json' \
  --data '{"workspace":"default","path":"notes/today.txt","methods":["fs.write"]}'
# {"grantId":"...","expiresAt":"..."}

curl -sS -X POST http://127.0.0.1:8787/session/rpc \
  -H 'content-type: application/json' \
  --data '{"requestId":"w1","method":"fs.write","params":{"workspace":"default","path":"notes/today.txt","content":"hi","mode":"overwrite"},"permission":{"grantId":"<grantId>"}}'

curl -sS -X POST http://127.0.0.1:8787/session/rpc \
  -H 'content-type: application/json' \
  --data '{"requestId":"done","method":"session.complete","params":{}}'
```

Files are read and written on the **Engine** host under its configured workspace roots. The Gateway validates write grants and forwards requests; it does not serve a Gateway-local workspace during the session.

Heartbeat behavior: idle interval is 120 seconds; after `session-wanted`, the next Engine heartbeat receives interval 5 plus `wssUrl`, `token`, and `sessionId`. The Engine opens the WebSocket; when work finishes it sends `job.done` (via `session.complete`) and the Gateway closes the session.

The local loopback URL in `wssUrl` uses `ws://`; a deployed TLS terminator can supply `wss://` without changing the session fields.

## Gateway hardening

Session tokens are single-use and expire after 30 seconds. A live connection has a five-minute maximum duration and a 60-second inbound-idle limit. HTTP JSON bodies are limited to 64 KiB and WebSocket text messages to 1 MiB.

Every RPC request must be a complete `reach-rpc/1.0` envelope. Controllers may omit `sessionId` on `POST /session/rpc`; the Gateway binds the live session id before forwarding.

## Out of scope (for now)

Public bind addresses, TLS termination, remote authentication, and multi-device session targeting are not part of this loopback Model B proof.
