import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "./i18n";

/*
 * Decorative miniature of the console topology for the sign-in page: bot
 * clients on the left, the Gateway pipeline in the middle, devices on the
 * right. It draws fixed shapes only and never reads Gateway data, so nothing
 * real can leak before sign-in.
 */

const rows = [84, 180, 276];
const gates = [144, 180, 216];

function reducedMotionQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = reducedMotionQuery();
      query?.addEventListener("change", listener);
      return () => query?.removeEventListener("change", listener);
    },
    () => reducedMotionQuery()?.matches ?? false,
  );
}

const inbound = (row: number, gate: number) =>
  `M104 ${rows[row]} C 168 ${rows[row]}, 168 ${gates[gate]}, 228 ${gates[gate]}`;
const outbound = (gate: number, row: number) =>
  `M332 ${gates[gate]} C 392 ${gates[gate]}, 392 ${rows[row]}, 456 ${rows[row]}`;
/** A full route from a bot, through one pipeline lane, to a device. */
const route = (from: number, gate: number, to: number) =>
  `${inbound(from, gate)} L 332 ${gates[gate]} ${outbound(gate, to).replace(/^M\S+ \S+/, "")}`;

const particles = [
  { d: route(0, 0, 1), kind: "read", delay: 0 },
  { d: route(1, 1, 0), kind: "write", delay: 1.1 },
  { d: route(2, 2, 2), kind: "read", delay: 0.6 },
  { d: route(0, 1, 2), kind: "exec", delay: 2.0 },
  { d: route(2, 0, 0), kind: "read", delay: 2.7 },
  { d: route(1, 2, 1), kind: "write", delay: 3.3 },
];

function Bot({ y }: { y: number }) {
  return (
    <g className="bv-node" transform={`translate(60 ${y - 22})`}>
      <rect width="44" height="44" rx="12" />
      <line x1="22" y1="-7" x2="22" y2="0" />
      <circle cx="22" cy="-9" r="2.5" className="bv-fill" />
      <circle cx="15" cy="20" r="3" className="bv-fill" />
      <circle cx="29" cy="20" r="3" className="bv-fill" />
      <path d="M14 30 Q22 35 30 30" />
    </g>
  );
}

function Device({ y, kind }: { y: number; kind: "laptop" | "server" | "board" }) {
  return (
    <g className="bv-node" transform={`translate(456 ${y - 22})`}>
      <rect width="44" height="44" rx="12" className="bv-tile" />
      {kind === "laptop" && (
        <>
          <rect x="11" y="12" width="22" height="14" rx="2" />
          <path d="M8 31 H36" />
        </>
      )}
      {kind === "server" && (
        <>
          <rect x="11" y="10" width="22" height="9" rx="2" />
          <rect x="11" y="23" width="22" height="9" rx="2" />
          <circle cx="16" cy="14.5" r="1.5" className="bv-fill" />
          <circle cx="16" cy="27.5" r="1.5" className="bv-fill" />
        </>
      )}
      {kind === "board" && (
        <>
          <rect x="12" y="12" width="20" height="20" rx="3" />
          <rect x="18" y="18" width="8" height="8" rx="1" className="bv-fill" />
          <path d="M16 8v4M22 8v4M28 8v4M16 32v4M22 32v4M28 32v4" />
        </>
      )}
    </g>
  );
}

/** 2D fallback where WebGL is unavailable, and the placeholder while the 3D chunk loads. */
export function BrandDiagram() {
  const { t } = useT();
  const still = useReducedMotion();
  return (
    <svg className="brand-visual" viewBox="0 0 560 360" aria-hidden="true" focusable="false" data-still={still || undefined}>
      <g className="bv-links">
        {rows.map((_, row) =>
          gates.map((_, gate) =>
            row === gate || Math.abs(row - gate) === 1 ? (
              <g key={`${row}-${gate}`}>
                <path d={inbound(row, gate)} />
                <path d={outbound(gate, row)} />
              </g>
            ) : null,
          ),
        )}
      </g>
      <g className="bv-gateway">
        <rect x="228" y="56" width="104" height="248" rx="22" />
        {(["brand.stageAuth", "brand.stagePolicy", "brand.stageRoute"] as const).map((stage, index) => (
          <g key={stage} transform={`translate(244 ${gates[index] - 13})`}>
            <rect width="72" height="26" rx="13" className="bv-stage" />
            <text x="36" y="17">{t(stage)}</text>
          </g>
        ))}
        <text x="280" y="88" className="bv-title">GATEWAY</text>
      </g>
      {rows.map((y) => (
        <Bot key={y} y={y} />
      ))}
      <Device y={rows[0]} kind="laptop" />
      <Device y={rows[1]} kind="server" />
      <Device y={rows[2]} kind="board" />
      {!still &&
        particles.map((particle, index) => (
          <circle
            key={index}
            r="4"
            className={`bv-particle ${particle.kind}`}
            style={{ offsetPath: `path("${particle.d}")`, animationDelay: `${particle.delay}s` }}
          />
        ))}
    </svg>
  );
}

function webglAvailable(): boolean {
  if (typeof WebGL2RenderingContext === "undefined" && typeof WebGLRenderingContext === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The sign-in brand visual: a rendered 3D Gateway where WebGL works, the flat
 * diagram otherwise. three.js arrives as its own chunk, only on this page.
 */
export function BrandVisual() {
  const still = useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || !webglAvailable()) return;
    let cancelled = false;
    let scene: { dispose(): void } | undefined;
    import("./brand-scene")
      .then(({ mountBrandScene }) => {
        if (cancelled) return;
        scene = mountBrandScene(element, { still });
        setRendered(true);
      })
      .catch(() => setRendered(false));
    return () => {
      cancelled = true;
      scene?.dispose();
      setRendered(false);
    };
  }, [still]);
  return (
    <div className="brand-stage" data-rendered={rendered || undefined}>
      <div className="brand-scene" ref={host} aria-hidden="true" />
      {!rendered && <BrandDiagram />}
    </div>
  );
}
