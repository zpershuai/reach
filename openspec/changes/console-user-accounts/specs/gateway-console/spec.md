# Spec Delta

## ADDED Requirements

### Requirement: Split-layout sign-in page
The sign-in and first-run setup pages SHALL use a two-panel layout on viewports at least 960 px wide: a brand panel on the left taking 55 to 60 percent of the width, and the form on the right. The form MUST ask for username and password, and MUST ask for an authentication code only after the Gateway answers `TOTP_REQUIRED`. Setup MUST ask for the setup token, username and password. The language toggle MUST stay reachable.

#### Scenario: Desktop sign-in
- **WHEN** a signed-out browser opens `/console/` at 1440 px wide
- **THEN** the brand visual fills the left side and the username and password form is on the right

#### Scenario: Second step for a TOTP user
- **WHEN** a TOTP user submits a correct username and password
- **THEN** the form keeps the entered username, shows an authentication code field, and signs in once a valid code is submitted

#### Scenario: Phone sign-in
- **WHEN** a signed-out browser opens `/console/` at 390 px wide
- **THEN** the brand visual is reduced to a banner above the form, the form is full width, and the page does not scroll horizontally

### Requirement: Sign-in brand visual
The brand panel SHALL show the Reach name, a one-line description of what Reach does, and an animated miniature of the console topology: bot clients, the Gateway and devices, with particles moving along the links. The visual MUST be decorative and contain no live Gateway data. It MUST load no third-party asset or trademarked logo, MUST be hidden from assistive technology, and MUST stop animating when `prefers-reduced-motion` is set.

#### Scenario: Signed-out request leaks nothing
- **WHEN** the sign-in page renders before authentication
- **THEN** the visual makes no console API request beyond the sign-in status check and shows no real Engine, client or workspace name

#### Scenario: Reduced motion
- **WHEN** the operating system requests reduced motion
- **THEN** the brand visual renders as a still image with no moving particles

#### Scenario: Dark palette
- **WHEN** the console renders the dark palette
- **THEN** the brand panel uses dark-palette colours and its text keeps WCAG AA contrast

### Requirement: Role-aware console controls
The console SHALL show the signed-in username and role in the navigation. For a `user` session, it MUST hide or disable every action that the Gateway would reject with `ROLE_FORBIDDEN` and MUST label the session as read-only. If the Gateway nonetheless returns `ROLE_FORBIDDEN`, the console MUST show a localized permission message.

#### Scenario: Viewer opens Devices
- **WHEN** a `user` opens the Devices view
- **THEN** devices and their status are visible, and no Add, Rotate or Remove control is offered

#### Scenario: Role changed during a session
- **WHEN** a signed-in admin is demoted and then tries an action from an open page
- **THEN** the console shows the localized permission message and refreshes the controls to read-only

### Requirement: Users view
The console SHALL provide a Users view, visible only to admins. It lists each account's username, role, TOTP status, enabled state, creation time and last sign-in time. It MUST offer creating a user, changing a role, disabling or enabling, resetting a password, removing TOTP and deleting. Each action MUST ask for the password first when recent authentication is missing, and deletion MUST use destructive action styling with confirmation.

#### Scenario: Admin adds a viewer
- **WHEN** an admin creates user `ops` with role `user` from the Users view
- **THEN** `ops` appears in the list with role `user`, TOTP off and enabled

#### Scenario: Last admin is protected
- **WHEN** the only enabled admin tries to disable themself
- **THEN** the console shows the localized `LAST_ADMIN` message and the list is unchanged

### Requirement: Account settings
Every signed-in user SHALL be able to open an Account section in Settings to change their own password and to enable or disable TOTP. Enabling TOTP MUST show a QR code and the secret, then show the ten recovery codes once after confirmation, with a copy action.

#### Scenario: Viewer changes password
- **WHEN** a `user` changes their password from Settings with the correct current password
- **THEN** the change succeeds, the current session stays signed in, and other sessions of that user are signed out

### Requirement: Admin without TOTP warning
While any enabled `admin` account has TOTP disabled, the Gateway snapshot SHALL include a warning with stable code `ADMIN_WITHOUT_TOTP` naming no secrets. The console MUST show it localized among the Gateway warnings, and it MUST clear once every enabled admin has TOTP enabled.

#### Scenario: Fresh setup
- **WHEN** the owner completes setup without enabling TOTP and opens Overview
- **THEN** a localized warning recommends enabling TOTP for admin accounts

#### Scenario: Warning clears
- **WHEN** every enabled admin has enabled TOTP
- **THEN** the snapshot no longer includes `ADMIN_WITHOUT_TOTP`

## MODIFIED Requirements

### Requirement: Console navigation
The console SHALL provide the following views: Overview, Topology, Clients, Devices, Activity, Skills and Settings, plus a Users view for admins only. Skills MUST be marked as reserved. Until the Skill framework exists, the Skills view MUST explain what it will offer and MUST NOT offer any action.

#### Scenario: Skills is reserved
- **WHEN** the owner opens Skills
- **THEN** the view states that skill management is planned and offers no install or remove action

#### Scenario: Users hidden from viewers
- **WHEN** a `user` signs in
- **THEN** the navigation has no Users tab and opening `/console/users` shows the Overview instead

### Requirement: Narrow-screen navigation
At every viewport width the console SHALL keep the Sign out action, and for admins the Add device action, reachable from the main navigation without horizontal page scrolling. When the view tabs overflow the navigation row, the row MUST indicate that more tabs are available, MUST keep the current tab scrolled into view, and MUST NOT show a native scrollbar track.

#### Scenario: Sign out on a phone
- **WHEN** an admin opens the console at a 390 px wide viewport
- **THEN** a Sign out control and an Add device control are visible or reachable from the navigation, and Sign out ends the console session

#### Scenario: Viewer on a phone
- **WHEN** a `user` opens the console at a 390 px wide viewport
- **THEN** Sign out is reachable and no Add device control is shown

#### Scenario: Settings tab off screen
- **WHEN** the owner opens Settings at a 375 px wide viewport
- **THEN** the Settings tab is scrolled into view and marked current, and the edge of the tab row fades where further tabs are hidden
