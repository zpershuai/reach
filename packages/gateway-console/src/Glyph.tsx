import { useT } from "./i18n";
import { useNow } from "./clock";
import { displayOnline } from "./online";
import type { ReactNode } from "react";
import type { Engine } from "./types";

export const glyphLabels = {
  "mac-mini": "glyph.macMini",
  "mac-studio": "glyph.macStudio",
  macbook: "glyph.macbook",
  imac: "glyph.imac",
  mac: "glyph.mac",
  router: "glyph.router",
  nas: "glyph.nas",
  "raspberry-pi": "glyph.raspberryPi",
  server: "glyph.server",
} as const;
export const sessionLabels = {
  ready: "glyph.ready",
  wanted: "glyph.wanted",
  pending: "glyph.pending",
  connecting: "glyph.connecting",
  none: "glyph.none",
  closed: "glyph.closed",
  closing: "glyph.closing",
  offline: "glyph.offline",
  idle: "glyph.idle",
} as const;

export const glyphKinds = [
  "mac-mini",
  "mac-studio",
  "macbook",
  "imac",
  "mac",
  "router",
  "nas",
  "raspberry-pi",
  "server",
];
export function glyphKind(
  engine: Pick<Engine, "hardware" | "deviceOverride">,
): string {
  const kind = engine.deviceOverride?.kind ?? engine.hardware?.kind;
  return kind && glyphKinds.includes(kind) ? kind : "server";
}
export function executionState(
  workspace: string,
  processWorkspaces: string[] | undefined,
): string {
  if (processWorkspaces === undefined) return "not reported";
  return processWorkspaces.includes(workspace) ? "enabled" : "disabled";
}

/** Use the same heartbeat and open-session rule as the Gateway. */
export function glyphState(
  engine: Pick<Engine, "lastSeenAt" | "session">,
  now: number,
  heartbeatInterval: number,
): "ready" | "connecting" | "idle" | "offline" {
  if (!displayOnline(engine, now, heartbeatInterval)) return "offline";
  if (engine.session.status === "ready") return "ready";
  if (["wanted", "pending", "connecting"].includes(engine.session.status))
    return "connecting";
  return "idle";
}

const led = (cx: number, cy: number) => (
  <circle className="ind" cx={cx} cy={cy} r="1.05" />
);

// Hardware silhouettes on a 32-unit grid. `.face` and `.face2` are tinted
// fills, `.pin` marks ports and `.ind` is the status LED.
const glyphs: Record<string, ReactNode> = {
  // Low square slab in three-quarter view with two front ports.
  "mac-mini": (
    <>
      <path className="face" d="M3.5 14.5 16 9.5l12.5 5L16 19.5Z" />
      <path className="face2" d="M3.5 14.5v4l12.5 5v-4Z" />
      <path d="M3.5 14.5 16 9.5l12.5 5L16 19.5Z" />
      <path d="M3.5 14.5v4l12.5 5 12.5-5v-4M16 19.5v4" />
      <path d="m7.2 18.1 1.7.7m1.3.5 1.7.7" />
      {led(24.6, 18.6)}
    </>
  ),
  // The same footprint as the mini, nearly three times taller, with an SD slot.
  "mac-studio": (
    <>
      <path className="face" d="M4 9.5 16 5l12 4.5L16 14Z" />
      <path className="face2" d="M4 9.5v12L16 26V14Z" />
      <path d="M4 9.5 16 5l12 4.5L16 14Z" />
      <path d="M4 9.5v12L16 26l12-4.5v-12M16 14v12" />
      <path d="m6.8 19.6 1.5.6m1.1.4 1.5.6m1.6.6 2.4.9" />
      <path d="M4 20.2 16 24.7" opacity=".45" />
      {led(24.4, 20.4)}
    </>
  ),
  // Open laptop seen from the front: display, notch and wedge base.
  macbook: (
    <>
      <rect className="face" x="6" y="5.5" width="20" height="14.5" rx="1.6" />
      <rect x="6" y="5.5" width="20" height="14.5" rx="1.6" />
      <rect className="face2" x="8" y="7.5" width="16" height="10.5" rx=".6" />
      <path d="M14.4 7.5h3.2" />
      <path className="face" d="M2.5 21.5h27l-1.8 3H4.3Z" />
      <path d="M2.5 21.5h27l-1.8 3H4.3ZM13.5 21.5v.9h5v-.9" />
      {led(26.2, 23)}
    </>
  ),
  // All-in-one display with a chin and a slim stand.
  imac: (
    <>
      <rect className="face" x="3.5" y="4" width="25" height="18" rx="1.6" />
      <rect x="3.5" y="4" width="25" height="18" rx="1.6" />
      <rect className="face2" x="5.5" y="6" width="21" height="11.5" rx=".5" />
      <path d="M3.5 17.5h25M13.5 22l-1 5.2h7l-1-5.2M10.5 27.2h11" />
      {led(16, 19.8)}
    </>
  ),
  // Generic Mac: tower with a top handle and a lattice front.
  mac: (
    <>
      <rect className="face" x="8.5" y="5" width="15" height="23" rx="2" />
      <rect x="8.5" y="5" width="15" height="23" rx="2" />
      <path d="M11 5V3.2h10V5" />
      {[0, 1, 2, 3, 4].flatMap((row) =>
        [0, 1, 2].map((column) => (
          <circle
            key={`${row}-${column}`}
            className="pin"
            cx={12.5 + column * 3.5}
            cy={10 + row * 3.4}
            r=".9"
          />
        )),
      )}
      {led(20.4, 7.4)}
    </>
  ),
  // Flat chassis, three antennas, signal arcs and a front LED strip.
  router: (
    <>
      <rect className="face" x="3.5" y="17" width="25" height="8.5" rx="2" />
      <rect x="3.5" y="17" width="25" height="8.5" rx="2" />
      <path d="M8 17 6.2 5.5M16 17V4m8 13 1.8-11.5" />
      <path
        d="M11.6 8.6a6 6 0 0 1 8.8 0m-7 2.2a3.4 3.4 0 0 1 5.2 0"
        opacity=".55"
      />
      {led(8.5, 21.25)}
      <circle className="pin" cx="12" cy="21.25" r=".8" />
      <circle className="pin" cx="15" cy="21.25" r=".8" />
      <circle className="pin" cx="18" cy="21.25" r=".8" />
      <path d="M22 21.25h3" />
    </>
  ),
  // Upright enclosure with four drive bays.
  nas: (
    <>
      <rect className="face" x="8" y="3.5" width="16" height="25" rx="2" />
      <rect x="8" y="3.5" width="16" height="25" rx="2" />
      {[6.5, 11.2, 15.9, 20.6].map((y) => (
        <g key={y}>
          <rect x="10.5" y={y} width="11" height="3.4" rx=".6" />
          <circle className="pin" cx="19.6" cy={y + 1.7} r=".6" />
        </g>
      ))}
      {led(16, 26.2)}
    </>
  ),
  // Bare board from above: GPIO header, SoC and stacked USB/Ethernet.
  "raspberry-pi": (
    <>
      <rect className="face" x="3" y="8" width="23.5" height="17" rx="1.8" />
      <rect x="3" y="8" width="23.5" height="17" rx="1.8" />
      {Array.from({ length: 8 }, (_, index) => (
        <g key={index}>
          <circle className="pin" cx={7 + index * 1.9} cy="10.2" r=".55" />
          <circle className="pin" cx={7 + index * 1.9} cy="11.9" r=".55" />
        </g>
      ))}
      <rect className="face2" x="9" y="14.6" width="6.6" height="6.6" rx=".7" />
      <rect x="9" y="14.6" width="6.6" height="6.6" rx=".7" />
      <rect x="20" y="13.4" width="9" height="4" rx=".5" />
      <rect x="20" y="18.8" width="9" height="4" rx=".5" />
      {led(5.6, 22.4)}
    </>
  ),
  // 1U rack server: the fallback for unrecognised hosts.
  server: (
    <>
      <rect className="face" x="3" y="11" width="26" height="10" rx="1.6" />
      <rect x="3" y="11" width="26" height="10" rx="1.6" />
      <path d="M6.5 14.5h9m-9 3h9" />
      <circle className="pin" cx="21" cy="16" r=".8" />
      {led(25, 16)}
    </>
  ),
};

export function DeviceGlyph({
  engine,
  large = false,
  heartbeatInterval = 15,
}: {
  engine: Engine;
  large?: boolean;
  heartbeatInterval?: number;
}) {
  const { t } = useT();
  const kind = glyphKind(engine);
  const status = engine.session.status as keyof typeof sessionLabels;
  const state = glyphState(engine, useNow(), heartbeatInterval);
  return (
    <span
      className={`dev-icon s-${state}${large ? " lg" : ""}`}
      role="img"
      aria-label={`${t(glyphLabels[kind as keyof typeof glyphLabels])}, ${t(sessionLabels[state === "offline" ? "offline" : status] ?? "glyph.none")}`}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true">
        {glyphs[kind]}
      </svg>
    </span>
  );
}
