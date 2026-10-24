import { useT, i18n } from "./i18n";
import { navigate, useSearch } from "./router";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { Activity, Snapshot } from "./types";
import { activityKey, MethodSwatch, formatBytes, formatTime } from "./ui";

const stageKeys = {
  auth: "topology.auth",
  policy: "topology.policy",
  route: "topology.route",
} as const;

const eventKeys = {
  "rpc.started": "activity.started",
  "rpc.finished": "activity.finished",
  "session.state": "activity.state",
  "engine.heartbeat": "activity.heartbeat",
  "client.connected": "activity.connected",
  "client.disconnected": "activity.disconnected",
  "admin.action": "activity.action",
} as const;

function resultText(row: Activity): string {
  const type = row.type ?? row.eventType;
  if (type === "rpc.denied") {
    const stageKey = Object.hasOwn(stageKeys, row.stage ?? "")
      ? stageKeys[row.stage as keyof typeof stageKeys]
      : undefined;
    return i18n.t("activity.deniedAt", {
      stage: stageKey
        ? i18n.t(stageKey)
        : row.stage ?? i18n.t("topology.policy"),
      code: row.code ? ` (${row.code})` : "",
    });
  }
  if (row.outcome === "ok")
    return type === "rpc.finished"
      ? i18n.t("activity.ok")
      : i18n.t("activity.done");
  if (row.outcome === "error") return row.code ?? i18n.t("activity.error");
  if (type === "auth.failed") return i18n.t("activity.authFailed");
  const key = Object.hasOwn(eventKeys, type ?? "")
    ? eventKeys[type as keyof typeof eventKeys]
    : undefined;
  if (key) return i18n.t(key);
  return type?.replace(/^\w+\./, "") ?? i18n.t("activity.event");
}

export const ActivityTable = memo(function ActivityTable({
  rows,
  tall = false,
}: {
  rows: Activity[];
  tall?: boolean;
}) {
  const { t, lang } = useT();
  return (
    <div className={`table-wrap${tall ? " tall" : ""}`}>
      <table>
        <thead>
          <tr>
            <th>{t("activity.time")}</th>
            <th>{t("activity.client")}</th>
            <th>{t("activity.device")}</th>
            <th>{t("activity.method")}</th>
            <th>{t("activity.target")}</th>
            <th>{t("activity.result")}</th>
            <th className="num">{t("activity.latency")}</th>
            <th className="num">{t("activity.size")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const target =
              [row.workspace, row.path ?? row.script ?? row.processId]
                .filter(Boolean)
                .join(" / ") || "—";
            return (
              <tr key={activityKey(row)}>
                <td className="mono">{formatTime(row.ts, lang)}</td>
                <td>{row.clientLabel ?? row.caller?.label ?? "Gateway"}</td>
                <td className="mono">{row.engineId ?? "—"}</td>
                <td>
                  <span className="method">
                    <MethodSwatch methodClass={row.methodClass} />
                    {row.method ?? row.action ?? row.eventType ?? row.type}
                  </span>
                </td>
                <td>
                  <span className="target" title={target}>
                    {target}
                  </span>
                </td>
                <td>
                  <span
                    className={`res ${row.outcome ?? ""}${(row.type ?? row.eventType) === "rpc.denied" ? " denied" : ""}`}
                  >
                    {resultText(row)}
                  </span>
                </td>
                <td className="num">
                  {row.latencyMs === undefined || row.latencyMs === null
                    ? "—"
                    : t("common.milliseconds", {
                        count: Math.round(row.latencyMs),
                      })}
                </td>
                <td className="num">{formatBytes(row.responseBytes, lang)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="empty">{t("activity.empty")}</div>}
    </div>
  );
});

export function ActivityView({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useT();
  const search = useSearch();
  const filters = useMemo(
    () => Object.fromEntries(new URLSearchParams(search)),
    [search],
  );
  const [rows, setRows] = useState(snapshot.activity);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const generation = useRef(0);
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  );
  async function load(more = false): Promise<void> {
    const requestGeneration = generation.current;
    try {
      const params = new URLSearchParams(query);
      if (more && cursor) params.set("cursor", cursor);
      const result = await api<{ rows: Activity[]; cursor: string | null }>(
        `activity?${params}`,
      );
      if (requestGeneration !== generation.current) return;
      setRows((previous) => {
        if (more) return [...previous, ...result.rows];
        // Keep live records that arrived while this page was loading.
        const keys = new Set(result.rows.map(activityKey));
        const newest = result.rows[0]?.ts ?? -Infinity;
        const live = previous.filter(
          (row) => row.ts >= newest && !keys.has(activityKey(row)),
        );
        return [...live, ...result.rows];
      });
      setCursor(result.cursor);
      setError("");
    } catch (error) {
      if (requestGeneration === generation.current) setError(error);
    }
  }
  useEffect(() => {
    generation.current++;
    setRows([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [search]);
  useEffect(() => {
    const live = snapshot.activity.filter((row) =>
      matchesActivity(row, filters),
    );
    setRows((previous) => {
      const keys = new Set(previous.map(activityKey));
      const newest = previous[0]?.ts ?? -Infinity;
      const added = live.filter((row) => {
        const key = activityKey(row);
        if (row.ts < newest || keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      return added.length ? [...added, ...previous] : previous;
    });
  }, [snapshot.activity]);
  function select(key: string, value: string): void {
    const params = new URLSearchParams(search);
    if (value) params.set(key, value);
    else params.delete(key);
    navigate(`activity${params.size ? `?${params}` : ""}`, {
      replace: key === "from" || key === "to",
    });
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{t("activity.ledger")}</h2>
        <div className="tools">
          <a
            className="btn small"
            href={`/api/console/activity/export?${query}&format=csv`}
          >
            {t("activity.exportCsv")}
          </a>
          <a
            className="btn small"
            href={`/api/console/activity/export?${query}&format=jsonl`}
          >
            {t("activity.exportJsonl")}
          </a>
        </div>
      </div>
      <div className="filters">
        <label>
          {t("activity.device")}
          <select
            aria-label={t("activity.filterDevice")}
            value={filters.engineId ?? ""}
            onChange={(event) => select("engineId", event.target.value)}
          >
            <option value="">{t("activity.allDevices")}</option>
            {snapshot.engines.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("activity.client")}
          <select
            aria-label={t("activity.filterClient")}
            value={filters.clientLabel ?? ""}
            onChange={(event) => select("clientLabel", event.target.value)}
          >
            <option value="">{t("activity.allClients")}</option>
            {snapshot.clients.map((client) => (
              <option key={`${client.type}-${client.label}`}>
                {client.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("activity.class")}
          <select
            value={filters.methodClass ?? ""}
            onChange={(event) => select("methodClass", event.target.value)}
          >
            <option value="">{t("activity.allClasses")}</option>
            {["read", "write", "exec", "control"].map((value) => (
              <option key={value} value={value}>
                {t(
                  (
                    {
                      read: "activity.read",
                      write: "activity.write",
                      exec: "activity.exec",
                      control: "activity.control",
                    } as const
                  )[value as "read" | "write" | "exec" | "control"],
                )}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("activity.result")}
          <select
            value={filters.outcome ?? ""}
            onChange={(event) => select("outcome", event.target.value)}
          >
            <option value="">{t("activity.allResults")}</option>
            <option value="ok">{t("activity.ok")}</option>
            <option value="error">{t("activity.error")}</option>
            <option value="denied">{t("activity.denied")}</option>
            <option value="not_ok">{t("activity.notOk")}</option>
          </select>
        </label>
        <label>
          {t("activity.from")}
          <input
            type="datetime-local"
            value={dateInput(filters.from)}
            onChange={(event) =>
              select(
                "from",
                event.target.value
                  ? String(new Date(event.target.value).getTime())
                  : "",
              )
            }
          />
        </label>
        <label>
          {t("activity.to")}
          <input
            type="datetime-local"
            value={dateInput(filters.to)}
            onChange={(event) =>
              select(
                "to",
                event.target.value
                  ? String(new Date(event.target.value).getTime())
                  : "",
              )
            }
          />
        </label>
      </div>
      {Boolean(error) && (
        <div className="notice err" role="alert">
          {errorText(error, t)}
        </div>
      )}
      <ActivityTable rows={rows} />
      {cursor && (
        <div className="note">
          <button className="btn small" onClick={() => void load(true)}>
            {t("activity.loadMore")}
          </button>
        </div>
      )}
      <div className="note">{t("activity.metadataNote")}</div>
    </section>
  );
}

function matchesActivity(
  row: Activity,
  filters: Record<string, string>,
): boolean {
  if (filters.engineId && row.engineId !== filters.engineId) return false;
  if (
    filters.clientLabel &&
    (row.clientLabel ?? row.caller?.label) !== filters.clientLabel
  )
    return false;
  if (filters.methodClass && row.methodClass !== filters.methodClass)
    return false;
  if (
    filters.outcome === "not_ok" &&
    !["error", "denied"].includes(row.outcome ?? "")
  )
    return false;
  if (
    filters.outcome &&
    filters.outcome !== "not_ok" &&
    row.outcome !== filters.outcome
  )
    return false;
  return !(
    (filters.from && row.ts < Number(filters.from)) ||
    (filters.to && row.ts > Number(filters.to))
  );
}

function dateInput(value: string | undefined): string {
  if (!value || !Number.isFinite(Number(value))) return "";
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
