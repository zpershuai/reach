# gateway-console Specification

## Purpose

Gives the owner a Gateway-hosted web console to see ingress clients, the Gateway pipeline and egress Engines, watch bot activity on devices in real time, and enroll and manage devices.

## Requirements

### Requirement: Console asset serving
When the console is enabled, the Gateway SHALL serve the console single-page app under `/console/` from its own listener. Every console response MUST carry the following security headers:
- `Content-Security-Policy` with `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'` and `object-src 'none'`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`.

The console MUST load no third-party script, style or font at runtime.

#### Scenario: Open the console
- **WHEN** a browser requests `/console/`
- **THEN** it receives the app with the CSP above and no request leaves for another origin

#### Scenario: Assets missing from the build
- **WHEN** the Gateway runs from a build without console assets
- **THEN** `/console/` returns 503 with a message to build the console, and the data plane is unaffected

#### Scenario: Deep link
- **WHEN** a browser requests `/console/devices/nas-01`
- **THEN** the Gateway serves the app shell and the app opens that device

### Requirement: Console navigation
The console SHALL provide the following views: Overview, Topology, Clients, Devices, Activity, Skills and Settings. Skills MUST be marked as reserved. Until the Skill framework exists, the Skills view MUST explain what it will offer and MUST NOT offer any action.

#### Scenario: Skills is reserved
- **WHEN** the owner opens Skills
- **THEN** the view states that skill management is planned and offers no install or remove action

### Requirement: Topology lanes
The Topology view SHALL lay out ingress clients on the left, the Gateway with its auth, policy and route stages in the centre, and registered Engines on the right. It MUST connect every client and every Engine to the Gateway. On narrow screens, the diagram MUST scroll horizontally instead of reflowing.

#### Scenario: Registered offline device
- **WHEN** an Engine is registered but has not heartbeated within three heartbeat intervals
- **THEN** it is drawn as offline with its last-seen time, not omitted

### Requirement: Link state encoding
The Topology view SHALL draw each Gateway–Engine link according to that Engine's session status. Every state MUST be distinguishable without relying on colour alone.

| Session status | Link drawing |
| --- | --- |
| `ready` | Solid live link |
| Heartbeating with no session | Dashed link, with a pulse on each heartbeat |
| `wanted`, `pending` or `connecting` | Animated amber link |
| Offline | Dotted, faint link |

#### Scenario: Session opens on an idle router
- **WHEN** a client opens a session for an idle Engine and the Engine connects on its next heartbeat
- **THEN** the link changes from dashed to amber to solid in step with the `session.state` events

### Requirement: Event-driven particles
The Topology view SHALL animate one particle per received RPC event, travelling from the ingress client through the Gateway stages to the Engine and back. Particles MUST come only from received events, never from simulated data.

#### Scenario: Successful read
- **WHEN** `rpc.started` and then `rpc.finished` with outcome `ok` arrive for one request
- **THEN** a read-class particle travels to the Engine, dwells there in proportion to the measured latency, and returns as a hollow response mark

### Requirement: Particle encoding
Particle colour SHALL encode the method class (read, write, exec, control, and a reserved skill class). A successful response MUST return as a hollow mark, an error as a diamond, and a policy denial MUST stop at the policy stage with a denial mark.

#### Scenario: Denied write
- **WHEN** an `rpc.denied` event with stage `policy` arrives for client `Hermes Agent`
- **THEN** a write-class particle travels from that client to the policy stage, shows the denial mark, and the policy stage is highlighted as denied

#### Scenario: Burst of traffic
- **WHEN** more than 20 RPC events per second arrive for one link
- **THEN** particles are aggregated into a counted marker instead of being dropped from the activity table

#### Scenario: Reduced motion
- **WHEN** the browser reports `prefers-reduced-motion: reduce`
- **THEN** particles and ambient animations are replaced by brief highlights of the affected link and stage

### Requirement: Linked activity table
The Topology view SHALL show the live activity table beneath the diagram. Selecting a client, Engine or link MUST filter the table and dim unrelated lanes. Selecting a node MUST also open a detail drawer.

#### Scenario: Click a device
- **WHEN** the owner clicks Engine `nas-01`
- **THEN** the drawer shows its status, versions, workspaces, process-execution flag and recent operations, and the table shows only its records

#### Scenario: Process execution configuration in device details
- **WHEN** an Engine reports `processWorkspaces` in `session.ready`
- **THEN** the Gateway retains it in readiness state and snapshots, and the device drawer shows enabled or disabled for each workspace according to that list

#### Scenario: Older Engine omits execution configuration
- **WHEN** an Engine sends `session.ready` without `processWorkspaces`
- **THEN** readiness is accepted and the device drawer shows "not reported" for process execution rather than inferring it from supported methods

### Requirement: Device glyphs
The console SHALL render each Engine with a line-art glyph chosen by its effective device kind: the override if one is set, otherwise the reported kind. The supported kinds are `mac-mini`, `mac-studio`, `macbook`, `imac`, `mac`, `router`, `nas`, `raspberry-pi`, `server` and `unknown`. The glyph's status indicator MUST follow session status. Unknown or missing kinds MUST use the `server` glyph.

#### Scenario: Older Engine without hardware
- **WHEN** an Engine heartbeats without a hardware descriptor
- **THEN** it is shown with the `server` glyph and its platform text, and remains fully usable

#### Scenario: OpenWrt router
- **WHEN** an Engine reports kind `router` and model `OpenWrt 24.10`
- **THEN** its card shows the router glyph and that model

### Requirement: Add-device wizard
The Devices view SHALL offer an add-device wizard with these steps:
1. Name the device.
2. Choose a platform: Linux, macOS, OpenWrt or Docker.
3. Show the one-time token and the matching install command, built from the configured public origin.
4. Wait live for the first heartbeat and then show the detected hardware.

Leaving the wizard before step 4 MUST keep the registration and show it as awaiting its first heartbeat.

#### Scenario: Complete enrollment
- **WHEN** the owner finishes the wizard for an OpenWrt device and runs the shown command on the router
- **THEN** the wizard turns to connected and displays the router glyph and reported model

#### Scenario: Copy without exposure
- **WHEN** the wizard shows the token
- **THEN** the token appears only in that step and is never written to browser storage

### Requirement: Clients view
The Clients view SHALL list observed ingress clients with the following columns:
- label and type, marked unverified when self-reported;
- active HTTP MCP sessions;
- owned Engine sessions;
- last activity;
- 24-hour call and error counts.

A recently re-authenticated owner MUST be able to disconnect a client's HTTP MCP sessions.

#### Scenario: Disconnect a client
- **WHEN** the owner disconnects `grok-bot`
- **THEN** its HTTP MCP sessions are retired as by DELETE, their owned Engine sessions drain, and a `client.disconnected` event appears

### Requirement: Overview health
The Overview view SHALL show the following:
- ingress client count, online and registered Engine counts, active MCP sessions, requests per minute, the five-minute error rate and today's policy denials;
- Gateway, MCP and per-Engine versions with auto-update status;
- warnings for audit storage failure or an incomplete console security configuration.

#### Scenario: Audit storage failing
- **WHEN** audit persistence has failed since startup
- **THEN** the Overview shows a warning that names the data directory

### Requirement: Light theme with dark support
The console SHALL use a light theme by default and follow `prefers-color-scheme` to a dark palette. The owner SHALL be able to choose light, dark or system in Settings. Text and state indicators MUST keep WCAG AA contrast in both themes.

#### Scenario: System dark mode
- **WHEN** the owner has chosen "system" and the operating system is dark
- **THEN** the console renders the dark palette with legible text and indicators
