# Spec Delta

## MODIFIED Requirements

### Requirement: Topology lanes
The Topology view SHALL lay out ingress clients on the left, the Gateway with its auth, policy and route stages in the centre, and registered Engines on the right. It MUST connect every client and every Engine to the Gateway. At viewport widths of 820 px or less, the view MUST stack the three lanes vertically (clients, then Gateway, then Engines) without horizontal page or diagram scrolling, and MUST keep node selection, table filtering and detail drawers working as on wide screens.

#### Scenario: Registered offline device
- **WHEN** an Engine is registered but has not heartbeated within three heartbeat intervals
- **THEN** it is drawn as offline with its last-seen time, not omitted

#### Scenario: Topology on a phone
- **WHEN** the owner opens Topology at a 375 px wide viewport with five clients and four Engines
- **THEN** the clients, the Gateway and the Engines appear one after another from top to bottom, no element is wider than the viewport, and tapping Engine `nas-01` opens its drawer and filters the table to its records

#### Scenario: Desktop layout unchanged
- **WHEN** the owner opens Topology at a 1440 px wide viewport
- **THEN** clients, Gateway and Engines are laid out left to right as three lanes with connecting edges

### Requirement: Clients view
The Clients view SHALL list observed ingress clients with the following columns:
- label and type, marked unverified when self-reported;
- active HTTP MCP sessions;
- owned Engine sessions;
- last activity;
- 24-hour call and error counts.

Numeric columns MUST be right-aligned and sized to their content. A column whose value is empty for every listed client MUST be hidden. Each access identity MUST show when it was approved and last used, and its identifier MUST be shortened with a control that copies the full value.

A recently re-authenticated owner MUST be able to disconnect a client's HTTP MCP sessions.

#### Scenario: Disconnect a client
- **WHEN** the owner disconnects `grok-bot`
- **THEN** its HTTP MCP sessions are retired as by DELETE, their owned Engine sessions drain, and a `client.disconnected` event appears

#### Scenario: No client owns an Engine session
- **WHEN** none of the listed clients owns an Engine session
- **THEN** the owned Engine sessions column is not shown

#### Scenario: Two identities from the same application
- **WHEN** two OAuth identities are both labelled `ChatGPT`
- **THEN** each row shows its approval time, last-used time and a shortened identifier, and copying the identifier yields the full value

### Requirement: Overview health
The Overview view SHALL show the following:
- ingress client count, online and registered Engine counts with the number of Engines in session as a caption beneath them, active MCP sessions, requests per minute, the five-minute error rate and today's policy denials;
- an attention panel listing offline Engines, Engines reporting a version older than the most common Engine version, access identities with global access awaiting review, and failed or denied requests in the last 24 hours excluding unauthenticated requests, each linking to the view where it can be handled;
- the Gateway and MCP versions with auto-update status;
- warnings for audit storage failure or an incomplete console security configuration.

When nothing needs attention, the attention panel MUST say so. Zero-valued metrics MUST be shown with reduced emphasis, and a non-zero error rate or policy-denial count MUST use the warning colour. The metrics MUST lay out in equal columns without leaving a single metric alone on a row.

#### Scenario: Audit storage failing
- **WHEN** audit persistence has failed since startup
- **THEN** the Overview shows a warning that names the data directory

#### Scenario: Offline device needs attention
- **WHEN** Engine `nas-01` is offline and every other item is healthy
- **THEN** the attention panel lists `nas-01` as offline with its last-seen time and a link to its device details

#### Scenario: All healthy
- **WHEN** every Engine is online on the same version, no identity awaits review and no request failed in the last 24 hours
- **THEN** the attention panel states that nothing needs attention and shows the Gateway and MCP versions

#### Scenario: Metrics at medium width
- **WHEN** the console is shown at an 800 px wide viewport
- **THEN** the metrics form complete rows of equal columns with no metric alone on the last row

### Requirement: Narrow-screen navigation
At every viewport width the console SHALL keep the Sign out and Add device actions reachable from the main navigation without horizontal page scrolling. When the view tabs overflow the navigation row, the row MUST indicate that more tabs are available, MUST keep the current tab scrolled into view, and MUST NOT show a native scrollbar track.

#### Scenario: Sign out on a phone
- **WHEN** the owner opens the console at a 390 px wide viewport
- **THEN** a Sign out control and an Add device control are visible or reachable from the navigation, and Sign out ends the administrator session

#### Scenario: Settings tab off screen
- **WHEN** the owner opens Settings at a 375 px wide viewport
- **THEN** the Settings tab is scrolled into view and marked current, and the edge of the tab row fades where further tabs are hidden

## ADDED Requirements

### Requirement: Unauthenticated requests in activity
Activity rows for rejected unauthenticated requests SHALL be attributed to "Unauthenticated request" rather than to the Gateway or any client, and MUST show the repeat count when the record carries one.

#### Scenario: Scanner probe
- **WHEN** a live `auth.failed` event for `/unknown` arrives with count 3
- **THEN** its activity row names the client as an unauthenticated request, shows the path `/unknown`, the result authentication failed and a count of 3

#### Scenario: Stored record without count
- **WHEN** a stored `auth.failed` record without a count is loaded from the activity query
- **THEN** its row names the client as an unauthenticated request and shows no count

### Requirement: Collapsed authentication failures
The Overview and Topology activity lists SHALL collapse adjacent unauthenticated failures for the same path into one row showing the total count and the latest time. The owner MUST be able to expand the row to see each record. Other rows MUST NOT be collapsed.

#### Scenario: Burst of probes
- **WHEN** the twelve newest records are unauthenticated failures for `/unknown`, followed by an `admin.login`
- **THEN** the Overview shows one row for `/unknown` with a count of 12 and the latest time, followed by the `admin.login` row

#### Scenario: Expand collapsed row
- **WHEN** the owner expands the collapsed `/unknown` row
- **THEN** the twelve individual records are shown in place

### Requirement: Hide unauthenticated requests filter
The Activity view SHALL offer a control that hides unauthenticated requests. The control MUST be applied by the Gateway query so that every page of results contains only matching records, MUST be kept in the URL with the other filters, and MUST apply to exports.

#### Scenario: Hide probes
- **WHEN** the owner turns on "Hide unauthenticated requests" and the newest 50 records are all authentication failures
- **THEN** the table shows the newest records that are not authentication failures, and the URL contains the filter

#### Scenario: Export honours the filter
- **WHEN** the filter is on and the owner exports CSV
- **THEN** the exported file contains no authentication-failure records

### Requirement: Device status colours
Device status indicators SHALL use one colour family per state across Overview, Topology, Devices and drawers: success for online (in session or idle), warning for connecting or awaiting the first heartbeat, and neutral with a dashed or struck treatment for offline. Online and offline MUST be distinguishable without relying on colour alone, and an indicator for a device that is not in session MUST show the time since its last heartbeat.

#### Scenario: Idle online device
- **WHEN** Engine `nas-01` heartbeated 4 seconds ago and holds no session
- **THEN** its status shows the online colour with the label idle and "4 s ago"

#### Scenario: Offline device
- **WHEN** Engine `nas-01` has not heartbeated for three heartbeat intervals and holds no session
- **THEN** its status uses the offline treatment, which differs from idle in shape or line style as well as colour

### Requirement: Destructive action styling
In lists and tables, destructive actions (revoke identity, revoke authorised application, disconnect client) SHALL use an outlined danger style and appear last in their action group. Only the confirmation dialog's submit control for a destructive action MUST use the filled danger style.

#### Scenario: Revoke an identity
- **WHEN** the owner views an access identity row
- **THEN** Revoke is the last action, shown outlined in the danger colour, and choosing it opens a confirmation whose submit button is filled in the danger colour

### Requirement: Global status placement
Gateway health, version, heartbeat interval and live connection state SHALL be shown once, in a status block in the navigation, rather than in every view's header. View headers MUST contain only the view title, the public origin and actions for that view.

#### Scenario: Reconnecting
- **WHEN** the live stream disconnects while the owner is on Devices
- **THEN** the navigation status block shows Reconnecting, and the Devices header does not repeat health or version badges

### Requirement: Activity table columns
Activity tables SHALL order columns as time, client, method, result, target, device, then latency and size. Latency and size MUST be hidden when no row in the current table has a value for them.

#### Scenario: Only authentication events
- **WHEN** every row in the table is an authentication or admin event without latency or size
- **THEN** the latency and size columns are not shown and the result column directly follows the method

### Requirement: Detail drawer backdrop
While a detail drawer is open, the console SHALL dim the content behind it, and clicking the dimmed area MUST close the drawer and return focus as Escape does.

#### Scenario: Click outside a drawer
- **WHEN** the device drawer for `nas-01` is open and the owner clicks the dimmed page
- **THEN** the drawer closes and focus returns to the `nas-01` card
