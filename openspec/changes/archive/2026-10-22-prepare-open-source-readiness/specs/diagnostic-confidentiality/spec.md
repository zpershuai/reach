# Spec Delta

## Purpose

Defines confidentiality requirements for service logs, audit events and operational diagnostics across Reach components, while preserving explicitly authorized file and process-output responses as application data.

## ADDED Requirements

### Requirement: Sensitive payloads never enter service diagnostics
Gateway, Engine, Connector and installation/update tools SHALL exclude credentials, cookies, setup tokens, authorization codes, file bodies, script arguments and process output from normal and error logs. Raw upstream response bodies, token-bearing URLs and untrusted exception strings MUST NOT bypass this boundary. Authorized file reads and process log responses MUST remain data-plane payloads rather than service logs.

#### Scenario: An upstream error echoes credentials
- **WHEN** an authentication, WebSocket, TLS or update failure includes a sentinel credential or file body in the upstream message
- **THEN** captured stdout, stderr and audit records contain none of those sentinel values

#### Scenario: A caller intentionally requests process output
- **WHEN** an authorized task owner invokes `process.logs`
- **THEN** the bounded output is returned to that caller and is not copied into service logs or activity audit

### Requirement: Diagnostics use bounded approved metadata
Diagnostics SHALL use stable error codes and bounded allowlisted metadata sufficient to identify the failed operation and recovery action. HTTP logs MUST exclude query strings and credential-bearing headers. Audit attribution MUST use the authenticated principal rather than caller-supplied labels for security decisions. Untrusted strings MUST NOT inject additional log records.

#### Scenario: An HTTP request carries secrets in its query
- **WHEN** request logging is enabled and a failed request includes a credential-like query parameter
- **THEN** the log records only an approved route, method, result and timing without the query value

#### Scenario: Error text contains newlines and oversized fields
- **WHEN** a peer supplies newline characters or a large error field
- **THEN** diagnostics remain bounded and cannot create forged log entries

### Requirement: Trust and visibility are explained accurately
Security documentation SHALL state that the trusted Gateway can observe relayed RPC content, that activity audit retains selected metadata, and that trusted scripts run with the Engine account's OS permissions. Workspace path validation MUST NOT be described as script sandboxing. Diagnostic instructions MUST avoid requiring environment dumps, tokens or private file bodies in public issue reports.

#### Scenario: A user follows the troubleshooting procedure
- **WHEN** a user prepares a public issue from documented diagnostic steps
- **THEN** the requested evidence is limited to sanitized versions, error codes and reproduction details, with a separate private security reporting route
