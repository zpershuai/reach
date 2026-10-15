import { useEffect, type ReactNode } from "react";
import { glyphState } from "./Glyph";
import type { Engine } from "./types";

export function Drawer({
  title,
  label,
  onClose,
  children,
}: {
  title: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <aside className="drawer" role="dialog" aria-label={label}>
      <div className="drawer-head">
        <h3>{title}</h3>
        <button className="btn small" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop">
      <section
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="panel-head">
          <h2>{title}</h2>
          {onClose && (
            <button className="btn small" type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <div className="panel-body">{children}</div>
      </section>
    </div>
  );
}

const statusText = {
  ready: ["In session", "ok"],
  connecting: ["Connecting", "warn"],
  idle: ["Idle · heartbeat", ""],
  offline: ["Offline", "err"],
} as const;

export function EngineStatus({ engine }: { engine: Engine }) {
  const [text, tone] =
    engine.enrollmentStatus === "awaiting_heartbeat"
      ? ["Awaiting first heartbeat", "warn"]
      : statusText[glyphState(engine)];
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {text}
    </span>
  );
}

export function platformText(engine: Engine): string {
  const hardware = engine.hardware;
  if (!hardware) return "Hardware not reported";
  return (
    [
      [hardware.os, hardware.osVersion].filter(Boolean).join(" "),
      hardware.arch,
    ]
      .filter(Boolean)
      .join(" · ") || "Hardware not reported"
  );
}

export function modelText(engine: Engine): string {
  return engine.effectiveHardware?.model || platformText(engine);
}

export function MethodSwatch({ methodClass }: { methodClass?: string }) {
  return <i className={`sw c-${methodClass ?? "control"}`} />;
}

const hues = ["#0F6B7A", "#2F6FE4", "#7A4FD6", "#B0562F", "#10A37F", "#3B3F46", "#B8456B"];
export function ClientAvatar({ label }: { label: string }) {
  const words = label
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  const initials =
    (words.length > 1
      ? words[0][0] + words[1][0]
      : (words[0] ?? label).slice(0, 2)) || "?";
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return (
    <span
      className="avatar"
      style={{ background: hues[Math.abs(hash) % hues.length] }}
      aria-hidden="true"
    >
      {initials.toUpperCase()}
    </span>
  );
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return "never";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "—";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
