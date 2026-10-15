# mcp-oauth Specification

## Purpose

Lets remote MCP clients that only support OAuth, such as ChatGPT connectors, use the Gateway's `/mcp` endpoint with owner-approved, revocable tokens.

## Requirements

### Requirement: Gateway is the MCP authorization server
When the console is enabled, the Gateway SHALL publish protected resource metadata (RFC 9728) for `<public origin>/mcp` and authorization server metadata (RFC 8414) with the public origin as issuer. Unauthenticated `/mcp` requests MUST receive 401 with a `WWW-Authenticate` Bearer challenge naming the resource metadata URL. Without the console, OAuth routes MUST be absent and `/mcp` behaves as before.

#### Scenario: Discovery from an MCP 401
- **WHEN** a client calls `/mcp` without credentials on a console-enabled Gateway
- **THEN** it receives 401 with `resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`, and that document lists the Gateway origin as authorization server

### Requirement: Dynamic client registration
The Gateway SHALL accept anonymous registration (RFC 7591) of clients using the authorization code grant, with redirect URIs that are HTTPS or loopback HTTP and carry no fragment. Public clients (`none`) and secret-based clients (`client_secret_post`, `client_secret_basic`) MUST be supported; secrets are stored only as hashes. Registration MUST be rate limited per client address; unapproved registrations expire after 1 hour idle, and when 256 are pending new registrations are refused rather than evicting live ones. Pending approvals MUST NOT consume server capacity, so anonymous requests cannot invalidate an approval in progress.

#### Scenario: Unsafe redirect
- **WHEN** a registration lists `http://example.com/cb`
- **THEN** the Gateway returns 400 `invalid_redirect_uri` and stores nothing

### Requirement: Owner approval with second factor
Authorization SHALL use the code flow with S256 PKCE and exact redirect URI matching. The approval page MUST require the administrator password and a fresh TOTP or recovery code, share sign-in rate limits and audit, accept submissions only from the Gateway origin, and record approvals as admin actions. Denial MUST redirect with `access_denied`.

#### Scenario: Native browser form
- **WHEN** the owner submits the approval page in a browser
- **THEN** the page's referrer policy lets the browser send the Gateway origin, and the decision is accepted

#### Scenario: Missing PKCE
- **WHEN** an authorization request omits `code_challenge` or uses `plain`
- **THEN** the Gateway redirects to the client with `invalid_request`

#### Scenario: Wrong second factor
- **WHEN** the owner submits a correct password with a wrong code
- **THEN** no code is issued and the failure counts toward sign-in rate limiting

### Requirement: Short-lived tokens with rotation and revocation
Authorization codes SHALL be single-use and expire after 5 minutes; a failed exchange consumes the code. Access tokens SHALL expire after 1 hour and refresh tokens after 30 days, both stored only as hashes. Refreshing MUST rotate the refresh token and invalidate the previous access token; replaying a rotated refresh token MUST revoke the whole grant. The console SHALL list approved clients and revoke a client together with all its tokens after recent re-authentication.

#### Scenario: Refresh token replay
- **WHEN** a client presents a refresh token that was already rotated
- **THEN** the Gateway returns `invalid_grant` and every token in that grant stops authenticating `/mcp`

#### Scenario: Owner revokes ChatGPT
- **WHEN** the owner revokes an authorized app in the console
- **THEN** its next `/mcp` request returns 401 and it must be approved again

### Requirement: MCP sessions are bound to their principal
An HTTP MCP session SHALL be bound to the credential principal that initialized it: the Controller token, or the OAuth client id. Requests from any other principal using its `Mcp-Session-Id` MUST receive 404 and MUST NOT affect it. Refreshing an OAuth token keeps the same principal.

#### Scenario: Another client presents a session id
- **WHEN** OAuth client B sends a POST or DELETE with client A's `Mcp-Session-Id`
- **THEN** B receives 404 and A's session continues
