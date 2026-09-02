## 1. Gateway heartbeat

- [x] 1.1 Implement the loopback TypeScript gateway with validated `POST /heartbeat` device payloads and verify automated tests cover its 120-second idle response and invalid payload rejection.
- [x] 1.2 Add the `POST /session-wanted` control and runnable gateway package command, and verify automated tests cover the 5-second session-wanted response plus invalid control payload rejection.

## 2. Local proof

- [ ] 2.1 Build and run the gateway, use curl to prove a device heartbeat returns 120 seconds by default and 5 seconds after requesting a session, and capture the commands in project documentation.
