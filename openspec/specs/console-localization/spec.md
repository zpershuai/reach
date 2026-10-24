# console-localization Specification

## Purpose

Lets the Gateway owner use the console and the OAuth approval page in Simplified Chinese or English, with a remembered language choice and locale-aware formatting.

## Requirements

### Requirement: Supported console languages
The console SHALL offer exactly two languages, `en` and `zh-CN`, and MUST render every user-visible string in the active language. This covers visible text, accessible names, tooltips and SVG titles. User data, identifiers, protocol values, paths and commands MUST be shown as received and never translated.

#### Scenario: Chinese console
- **WHEN** the active language is `zh-CN` and the owner opens each view, the add-device wizard and the re-authentication dialog
- **THEN** every label, heading, button, empty state and accessible name is shown in Chinese, and no English UI text remains

#### Scenario: Data stays verbatim
- **WHEN** the active language is `zh-CN` and an Engine named `nas-01` reports workspace `media`
- **THEN** the console shows `nas-01` and `media` unchanged

### Requirement: Initial language detection
When no saved choice exists, the console SHALL choose `zh-CN` if the browser's first preferred language that matches a supported language starts with `zh`, and `en` otherwise.

#### Scenario: Chinese browser
- **WHEN** a browser with preferred languages `zh-CN, en` opens the console for the first time
- **THEN** the console renders in `zh-CN`

#### Scenario: Unsupported browser language
- **WHEN** a browser with preferred languages `fr-FR, de` opens the console for the first time
- **THEN** the console renders in `en`

### Requirement: Language switching
The owner SHALL be able to switch languages from the sign-in and setup screens, from the main navigation at every viewport width, and from Settings. A switch MUST take effect immediately without a reload, keep the current view and form input, and never require authentication or re-authentication.

#### Scenario: Switch before signing in
- **WHEN** the owner selects 中文 on the sign-in screen
- **THEN** the sign-in screen re-renders in Chinese and the typed password is kept

#### Scenario: Switch with stale authentication
- **WHEN** the owner's last authentication is more than ten minutes old and they choose English in Settings
- **THEN** the console switches to English at once and does not ask for the password

### Requirement: Language preference persistence
The console SHALL save the chosen language in browser-local storage and restore it on later visits in that browser. Browser detection MUST NOT persist a preference or set a language cookie; only an explicit owner choice does so. The saved choice MUST take precedence over browser detection. If storage is unavailable, the console MUST still work and fall back to detection. The preference MUST NOT be stored on the Gateway.

#### Scenario: Reload keeps the choice
- **WHEN** the owner, whose browser prefers English, chooses 中文 and reloads the page
- **THEN** the console renders in `zh-CN`

#### Scenario: Storage blocked
- **WHEN** browser storage throws on access
- **THEN** the console renders in the detected language and switching still works for the current page

### Requirement: Document language attributes
The console SHALL set the document `lang` attribute to the active language, `en` or `zh-CN`. It MUST localize the document title.

#### Scenario: Screen reader language
- **WHEN** the owner switches to `zh-CN`
- **THEN** the root element's `lang` becomes `zh-CN` and the tab title is shown in Chinese

### Requirement: Locale-aware formatting
Dates, times, relative times and numbers in the console SHALL be formatted for the active language. Relative times MUST keep refreshing as the existing relative-time requirement describes.

#### Scenario: Relative time in Chinese
- **WHEN** the active language is `zh-CN` and a device last heartbeated 12 seconds ago
- **THEN** the console shows a Chinese relative time such as `12 秒前`

#### Scenario: Never seen
- **WHEN** a registered device has never heartbeated and the active language is `zh-CN`
- **THEN** its last-seen value is shown in Chinese rather than `never`

### Requirement: Localized request errors
When a console API error carries a known error code, the console SHALL show that error's message in the active language. When the code is unknown or missing, it MUST show the Gateway's message text. When the response has no usable body, it MUST show a localized message that names the HTTP status.

#### Scenario: Wrong password in Chinese
- **WHEN** the active language is `zh-CN` and sign-in fails with invalid credentials
- **THEN** the console shows a Chinese invalid-credentials message

#### Scenario: Proxy error page in Chinese
- **WHEN** the active language is `zh-CN` and a reverse proxy answers with a 502 HTML page
- **THEN** the console shows a Chinese error that includes `502`

### Requirement: Console error codes
Every JSON error response under `/api/console/` SHALL include a stable, machine-readable `code` next to its `error` text. Existing codes MUST keep their values. Each code MUST describe one distinct error meaning rather than grouping unrelated reasons by HTTP status.

#### Scenario: Invalid credentials code
- **WHEN** sign-in is attempted with a wrong password
- **THEN** the 401 response body contains `code` `INVALID_CREDENTIALS` and the existing `error` text

#### Scenario: Re-authentication code unchanged
- **WHEN** a sensitive action requires recent authentication
- **THEN** the response still carries `code` `REAUTH_REQUIRED`

### Requirement: Localized OAuth approval page
The Gateway SHALL render the `/oauth/authorize` approval page, including its validation messages, in `zh-CN` or `en`. It MUST use the console language cookie when that cookie holds a supported language, otherwise the request's `Accept-Language`, otherwise `en`. The page's `lang` attribute MUST match. Fields, security headers and approval behavior MUST NOT change.

#### Scenario: Chinese browser approves an app
- **WHEN** a browser sending `Accept-Language: zh-CN,zh;q=0.9` with no language cookie opens an authorization request
- **THEN** the approval page, its labels and its Approve and Deny buttons are in Chinese, and `<html lang="zh-CN">` is set

#### Scenario: Console choice wins
- **WHEN** the owner chose English in the console of a browser that sends `Accept-Language: zh-CN`
- **THEN** the approval page renders in English

#### Scenario: Wrong code in Chinese
- **WHEN** the approval page is in Chinese and the owner submits a wrong authentication code
- **THEN** the page re-renders in Chinese with a Chinese error message and the failure still counts toward rate limiting

### Requirement: Language cookie is non-sensitive
The console language cookie SHALL hold only a supported language tag. It MUST be readable by the Gateway on same-origin requests. The Gateway MUST ignore any other value. The cookie MUST NOT affect authentication, authorization or CSRF decisions.

#### Scenario: Tampered cookie
- **WHEN** a request to `/oauth/authorize` carries a language cookie with value `<script>`
- **THEN** the Gateway ignores it, picks the language from `Accept-Language`, and the value is never echoed into the page

### Requirement: Stable warning codes
Gateway snapshot warnings SHALL include additive `warningDetails` entries with a stable code, message and optional parameters, alongside the existing warning strings. The console MUST translate known codes independently of the message wording and preserve unknown or legacy warning text.

#### Scenario: Warning wording changes
- **WHEN** a known warning message changes wording or punctuation while its code stays unchanged
- **THEN** the console still shows its translation in the active language

#### Scenario: Gateway unreachable
- **WHEN** the browser cannot fetch a console API response
- **THEN** the console shows a localized Gateway-unavailable message that follows subsequent language changes
