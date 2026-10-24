import { i18n, useT, type Lang } from "./i18n";
import { useNow } from "./clock";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { glyphState } from "./Glyph";
import type { Activity, Engine, GatewayWarning } from "./types";

const overlays: symbol[] = [];
export function resetOverlayStack(): void {
  overlays.length = 0;
}

function useOverlay(close: (() => void) | undefined, trap: boolean) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const overlayId = useRef(Symbol());
  closeRef.current = close;
  useLayoutEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const id = overlayId.current;
    overlays.push(id);
    const controls = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (node) => !node.hidden && node.getAttribute("type") !== "hidden",
      );
    (controls()[0] ?? element).focus();
    const keydown = (event: KeyboardEvent) => {
      if (overlays.at(-1) !== id) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
      }
      if (trap && event.key === "Tab") {
        const nodes = controls();
        const first = nodes[0] ?? element;
        const last = nodes.at(-1) ?? element;
        if (
          !element.contains(document.activeElement) ||
          (event.shiftKey
            ? document.activeElement === first
            : document.activeElement === last) ||
          !nodes.length
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      const wasTop = overlays.at(-1) === id;
      const index = overlays.indexOf(id);
      if (index >= 0) overlays.splice(index, 1);
      // Return focus only if it is still ours; a click on another node (which
      // swaps this drawer for a new one) keeps focus where the owner put it.
      const active = document.activeElement;
      const owned =
        !active || active === document.body || element.contains(active);
      if (wasTop && owned && previous?.isConnected) previous.focus();
    };
  }, [trap]);
  return {
    ref,
    dismiss: () => {
      if (overlays.at(-1) === overlayId.current) closeRef.current?.();
    },
  };
}

export function Drawer({
  title,
  label,
  onClose,
  dismissible = true,
  children,
}: {
  title: string;
  label: string;
  onClose: () => void;
  /** False while a one-time credential is shown, so Escape cannot discard it. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  const { ref, dismiss } = useOverlay(dismissible ? onClose : undefined, false);
  return (
    <>
      <div
        className="drawer-backdrop"
        data-testid="drawer-backdrop"
        onClick={dismiss}
        aria-hidden="true"
      />
      <aside
        ref={ref}
        tabIndex={-1}
        className="drawer"
        role="dialog"
        aria-label={label}
      >
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="btn small" type="button" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({
  title,
  onClose,
  onCancel,
  dismissible = true,
  children,
}: {
  title: string;
  onCancel?: () => void;
  onClose?: () => void;
  /** False while a one-time credential is shown, so Escape cannot discard it. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  const { ref } = useOverlay(
    dismissible ? (onCancel ?? onClose) : undefined,
    true,
  );
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        tabIndex={-1}
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="panel-head">
          <h2>{title}</h2>
          {onClose && (
            <button className="btn small" type="button" onClick={onClose}>
              {t("common.close")}
            </button>
          )}
        </div>
        <div className="panel-body">{children}</div>
      </section>
    </div>
  );
}

const statusText = {
  ready: ["common.inSession", "ok"],
  connecting: ["common.connecting", "warn"],
  idle: ["common.idle", "ok"],
  offline: ["common.offline", "off"],
  awaiting: ["common.awaiting", "warn"],
} as const;

export function EngineStatus({
  engine,
  heartbeatInterval = 15,
}: {
  engine: Engine;
  heartbeatInterval?: number;
}) {
  const { t, lang } = useT();
  const now = useNow();
  const [textKey, tone] =
    engine.enrollmentStatus === "awaiting_heartbeat"
      ? statusText.awaiting
      : statusText[glyphState(engine, now, heartbeatInterval)];
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      <span>{t(textKey)}</span>
      {engine.session.status !== "ready" && (
        <>
          {" "}
          · <span>{formatAgo(engine.lastSeenAt, now, lang)}</span>
        </>
      )}
    </span>
  );
}

export function platformText(engine: Engine, lang: Lang = "en"): string {
  const t = i18n.getFixedT(lang);
  const hardware = engine.hardware;
  if (!hardware) return t("common.hardwareNotReported");
  return (
    [[hardware.os, hardware.osVersion].filter(Boolean).join(" "), hardware.arch]
      .filter(Boolean)
      .join(" · ") || t("common.hardwareNotReported")
  );
}

export function modelText(engine: Engine, lang: Lang = "en"): string {
  return engine.effectiveHardware?.model || platformText(engine, lang);
}

export function MethodSwatch({ methodClass }: { methodClass?: string }) {
  return <i className={`sw c-${methodClass ?? "control"}`} />;
}

export const hues = [
  "#35434b",
  "#454552",
  "#4a414c",
  "#3f4c50",
  "#4c4850",
  "#414b4a",
  "#4b4652",
];
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
  for (const character of label)
    hash = (hash * 31 + character.codePointAt(0)!) | 0;
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

export function formatTime(ts: number, lang: Lang = "en"): string {
  return new Intl.DateTimeFormat(lang, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(ts);
}

export function formatAgo(
  ts: number | null,
  now = Date.now(),
  lang: Lang = "en",
): string {
  if (ts === null) return i18n.getFixedT(lang)("common.never");
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds >= 86_400) return new Intl.DateTimeFormat(lang).format(ts);
  const t = i18n.getFixedT(lang);
  if (seconds >= 3600)
    return t("common.hoursAgo", { count: Math.round(seconds / 3600) });
  if (seconds >= 60)
    return t("common.minutesAgo", { count: Math.round(seconds / 60) });
  return t("common.secondsAgo", { count: seconds });
}

export function formatBytes(
  bytes: number | undefined,
  lang: Lang = "en",
): string {
  if (bytes === undefined || bytes === null) return "—";
  const value = bytes < 1024 ? bytes : bytes / 1024;
  return `${new Intl.NumberFormat(lang, { minimumFractionDigits: bytes < 1024 ? 0 : 1, maximumFractionDigits: bytes < 1024 ? 0 : 1 }).format(value)} ${bytes < 1024 ? "B" : "KB"}`;
}

/**
 * Identifies an activity record across live events and ledger rows. Live
 * events carry the stream's event id and ledger rows their row id, so records
 * without a request id are matched by their content instead.
 */
export function activityKey(row: Activity): string {
  const type = row.type ?? row.eventType;
  if (row.requestId) return `${type}:${row.engineId ?? ""}:${row.requestId}`;
  return `${type}:${row.ts}:${row.engineId ?? ""}:${row.method ?? row.action ?? ""}:${row.path ?? ""}:${row.clientLabel ?? row.caller?.label ?? ""}`;
}

export function MiniLog({
  rows,
  showEngine = true,
}: {
  rows: Activity[];
  showEngine?: boolean;
}) {
  const { t, lang } = useT();
  if (!rows.length)
    return <div className="reserved">{t("common.noOperations")}</div>;
  return (
    <div className="mini-log">
      {rows.slice(0, 6).map((row) => (
        <div key={activityKey(row)}>
          <span className="method">
            <MethodSwatch methodClass={row.methodClass} />
            {row.method ?? row.action ?? row.eventType ?? row.type}
          </span>
          <span className="mono muted">
            {showEngine && row.engineId ? `${row.engineId} · ` : ""}
            {formatTime(row.ts, lang)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CopyButton({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (manual) {
      input.current?.focus();
      input.current?.select();
    }
  }, [manual]);
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setManual(false);
      setCopied(true);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setManual(true);
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <span className="copy-control">
      <button type="button" className="btn small" onClick={() => void copy()}>
        {copied ? t("common.copied") : (label ?? t("common.copy"))}
      </button>
      {manual && (
        <label>
          {t("common.manualCopy")}
          <textarea
            ref={input}
            readOnly
            value={value}
            aria-label={t("common.copyManually")}
          />
        </label>
      )}
      <span role="status" className="sr-only">
        {copied ? t("common.copied") : ""}
      </span>
    </span>
  );
}

export function warningText(warning: string, lang: Lang, detail?: GatewayWarning): string {
  const t = i18n.getFixedT(lang);
  switch (detail?.code) {
    case "INSECURE_HTTP": return t("common.httpWarning");
    case "NO_TRUSTED_PROXIES": return t("common.proxyWarning");
    case "AUDIT_STORAGE_FAILURE":
      if (detail.params?.path !== undefined)
        return t("common.storageWarning", { path: detail.params.path });
  }
  return detail?.message ?? warning;
}

export function formatNumber(
  value: number,
  lang: Lang,
  fractionDigits = 0,
): string {
  return new Intl.NumberFormat(lang, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}
