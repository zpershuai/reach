# Spec Delta

## ADDED Requirements

### Requirement: Narrow-screen navigation
At every viewport width the console SHALL keep the Sign out and Add device actions reachable from the main navigation without horizontal page scrolling.

#### Scenario: Sign out on a phone
- **WHEN** the owner opens the console at a 390 px wide viewport
- **THEN** a Sign out control and an Add device control are visible or reachable from the navigation, and Sign out ends the administrator session

### Requirement: Dialog keyboard and focus handling
Every modal dialog and detail drawer SHALL move focus inside itself when it opens, close on Escape where it offers a close or cancel action, keep Tab focus inside a modal while it is open, and return focus to the element that opened it after it closes.

#### Scenario: Close a drawer with Escape
- **WHEN** the owner opens the drawer for device `nas-01` from the Topology view and presses Escape
- **THEN** the drawer closes and focus returns to the `nas-01` node

#### Scenario: Tab stays inside a modal
- **WHEN** the Add device wizard is open and the owner presses Tab past its last control
- **THEN** focus moves to the wizard's first control, not to the page behind it

#### Scenario: Re-authentication cannot be dismissed by accident
- **WHEN** the re-authentication dialog is open and the owner presses Escape
- **THEN** the dialog is cancelled the same way as its Cancel button and the pending sensitive action is not performed

### Requirement: Readable request errors
When a console API response is not JSON or has no body, the console SHALL show an error naming the HTTP status instead of a parser message, and SHALL still treat a 401 as an expired session.

#### Scenario: Proxy error page
- **WHEN** a reverse proxy answers a console API request with a 502 HTML page
- **THEN** the console shows an error that includes `502` and does not show text such as `Unexpected token`

### Requirement: Live state refresh and reconnect
The console SHALL apply live events as they arrive and refresh the full snapshot periodically only while the page is visible. It MUST fetch a fresh snapshot after the stream reconnects and when the page becomes visible again. Reconnect attempts MUST back off exponentially with jitter, up to 30 seconds between attempts, and reset after a successful connection.

#### Scenario: Gateway restarts
- **WHEN** the Gateway is unavailable for two minutes and then returns
- **THEN** the console shows Reconnecting, retries at increasing intervals no longer than 30 seconds, and after reconnecting shows the current snapshot with Live

#### Scenario: Background tab
- **WHEN** the console tab has been hidden and becomes visible again
- **THEN** the console fetches a fresh snapshot without waiting for a new event

#### Scenario: Hidden tab stops polling
- **WHEN** the console tab stays hidden for five minutes
- **THEN** the console makes no snapshot requests during that time

### Requirement: Prompt offline display
The console SHALL show a device as offline once three heartbeat intervals have passed since its last heartbeat, without waiting for the next snapshot, unless it holds an open session.

#### Scenario: Device stops heartbeating
- **WHEN** an Engine with a 5-second heartbeat interval and no session sends no heartbeat for 15 seconds
- **THEN** within the next relative-time refresh it is shown as offline with its last-seen time

### Requirement: Relative time refresh
Relative times such as "12 s ago" SHALL advance on their own while the console is open, at least every 30 seconds, even when no events arrive.

#### Scenario: Idle device
- **WHEN** a device's last heartbeat is shown as "5 s ago" and no further events arrive for one minute
- **THEN** the displayed value advances to about one minute ago

### Requirement: Shareable activity filters
The Activity view SHALL reflect its device, client, class, result and time-range filters in the page URL. Opening or reloading that URL MUST restore the same filters and results, and browser back and forward MUST move between filter states.

#### Scenario: Reload with filters
- **WHEN** the owner filters Activity to device `nas-01` and result "Error or denied", then reloads the page
- **THEN** the same filters are selected and only matching records are listed

### Requirement: One-time credential copy
Wherever the console reveals a one-time credential, it SHALL offer a copy action that copies exactly that credential and confirms success. The credential MUST NOT be written to browser storage.

#### Scenario: Copy a rotated Engine token
- **WHEN** the owner rotates an Engine token and selects Copy
- **THEN** the clipboard holds that token, the button confirms it was copied, and no browser storage entry contains it

### Requirement: Workspace suggestions in access permissions
When the owner edits a client's resource permissions, the workspace field SHALL suggest the workspaces the selected Engine has reported, while still accepting a workspace the Engine has not reported.

#### Scenario: Pick a reported workspace
- **WHEN** the owner selects Engine `nas-01`, which reports workspaces `default` and `media`
- **THEN** the workspace field offers `default` and `media`, and a typed name such as `backup` is also accepted

## MODIFIED Requirements

### Requirement: Light theme with dark support
The console SHALL use a light theme by default and follow `prefers-color-scheme` to a dark palette. The owner SHALL be able to choose light, dark or system in Settings. Choosing a theme MUST apply it immediately and save it without re-authentication; settings that require recent authentication MUST still require it. Text and state indicators MUST keep WCAG AA contrast in both themes.

#### Scenario: System dark mode
- **WHEN** the owner has chosen "system" and the operating system is dark
- **THEN** the console renders the dark palette with legible text and indicators

#### Scenario: Change theme without password
- **WHEN** the owner's last authentication is more than ten minutes old and they choose Dark in Settings
- **THEN** the console switches to the dark palette at once, saves the choice, and does not ask for the password

#### Scenario: Retention still protected
- **WHEN** the owner's last authentication is more than ten minutes old and they change the activity retention days
- **THEN** the console asks for the password before saving
