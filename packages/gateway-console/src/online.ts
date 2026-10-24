import type { Engine } from "./types";

export function displayOnline(
  engine: Pick<Engine, "session" | "lastSeenAt">,
  now: number,
  heartbeatInterval: number,
): boolean {
  return (
    ["ready", "connecting"].includes(engine.session.status) ||
    (engine.lastSeenAt !== null &&
      now - engine.lastSeenAt < heartbeatInterval * 3000)
  );
}
