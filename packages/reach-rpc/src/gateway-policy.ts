export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;
export const SESSION_TOKEN_TTL_MS = 30_000;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WEBSOCKET_TEXT_BYTES = 1024 * 1024;
/** Length of one issued/renewed session lease. The Engine enforces this locally. */
export const SESSION_LEASE_MS = 5 * 60 * 1000;
/** Gateway-enforced inbound-idle limit while a session is live. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;
/** Client advisory for how often an Agent should renew before its lease expires. */
export const SESSION_RENEW_CADENCE_MS = 60 * 1000;
export const SESSION_RPC_TIMEOUT_MS = 30_000;
/** Bound on a live WebSocket that has not yet sent valid `session.ready`. */
export const SESSION_CONNECTING_MS = 15_000;
export const MAX_PENDING_RPCS = 16;
/** The Gateway-relative WebSocket session endpoint returned on heartbeat. */
export const SESSION_ENDPOINT_PATH = "/session";
/**
 * Upper bound on remembered timed-out request IDs. Prevents unbounded growth
 * while keeping the "a timed-out mutation cannot be retried" guard from being
 * wiped by the session close that the timeout itself triggers.
 */
export const MAX_TIMED_OUT_REQUEST_IDS = 4096;
/**
 * Upper bound on request IDs remembered for dedup within one live connection.
 * `seenRequestIds` is keyed to a single WebSocket and survives renewals, so a
 * caller streaming unique IDs across an 8-hour session could otherwise grow it
 * without bound. Oldest entries are evicted once the cap is hit; the Engine's
 * `SessionContext` dedup window is sized identically so the two stay in step.
 */
export const MAX_SEEN_REQUEST_IDS = 65_536;

