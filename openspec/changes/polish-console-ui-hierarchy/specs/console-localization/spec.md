# Spec Delta

## MODIFIED Requirements

### Requirement: Language switching
The owner SHALL be able to switch languages from the sign-in and setup screens, from the top-right corner of the signed-in console at every viewport width, and from Settings. The top-right control MUST be in the same position on wide and narrow screens and MUST NOT also appear in the side navigation. A switch MUST take effect immediately without a reload, keep the current view and form input, and never require authentication or re-authentication.

#### Scenario: Switch before signing in
- **WHEN** the owner selects 中文 on the sign-in screen
- **THEN** the sign-in screen re-renders in Chinese and the typed password is kept

#### Scenario: Switch with stale authentication
- **WHEN** the owner's last authentication is more than ten minutes old and they choose English in Settings
- **THEN** the console switches to English at once and does not ask for the password

#### Scenario: Same place on desktop and phone
- **WHEN** the owner views Overview at a 1440 px wide viewport and then at a 375 px wide viewport
- **THEN** the language control is in the top-right corner of the page in both, and the side navigation contains no language control
