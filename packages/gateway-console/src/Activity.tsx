import { navigate, useSearch } from "./router";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Activity, Snapshot } from "./types";
import { activityKey, MethodSwatch, formatBytes, formatTime } from "./ui";

function resultText(row: Activity): string {
  const type = row.type ?? row.eventType;
  if (type === "rpc.denied")
    return `Denied · ${row.stage ?? "policy"}${row.code ? ` (${row.code})` : ""}`;
  if (row.outcome === "ok") return type === "rpc.finished" ? "OK" : "Done";
  if (row.outcome === "error") return row.code ?? "Error";
  if (type === "auth.failed") return "Auth failed";
  return type?.replace(/^\w+\./, "") ?? "Event";
}

export const ActivityTable = memo(function ActivityTable({
  rows,
  tall = false,
}: {
  rows: Activity[];
  tall?: boolean;
}) {
  return (
    <div className={`table-wrap${tall ? " tall" : ""}`}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Client</th>
            <th>Device</th>
            <th>Method</th>
            <th>Target</th>
            <th>Result</th>
            <th className="num">Latency</th>
            <th className="num">Size</th>
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
                <td className="mono">{formatTime(row.ts)}</td>
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
                    : `${Math.round(row.latencyMs)} ms`}
                </td>
                <td className="num">{formatBytes(row.responseBytes)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty">
          No activity matches this view. Operations appear here as they happen.
        </div>
      )}
    </div>
  );
});

export function ActivityView({ snapshot }: { snapshot: Snapshot }) {
  const search = useSearch();
  const filters = useMemo(
    () => Object.fromEntries(new URLSearchParams(search)),
    [search],
  );
  const [rows, setRows] = useState(snapshot.activity);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
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
      if (requestGeneration === generation.current)
        setError(
          error instanceof Error ? error.message : "Activity unavailable",
        );
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
        <h2>Activity ledger</h2>
        <div className="tools">
          <a
            className="btn small"
            href={`/api/console/activity/export?${query}&format=csv`}
          >
            Export CSV
          </a>
          <a
            className="btn small"
            href={`/api/console/activity/export?${query}&format=jsonl`}
          >
            Export JSONL
          </a>
        </div>
      </div>
      <div className="filters">
        <label>
          Device
          <select
            aria-label="Filter device"
            value={filters.engineId ?? ""}
            onChange={(event) => select("engineId", event.target.value)}
          >
            <option value="">All devices</option>
            {snapshot.engines.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Client
          <select
            aria-label="Filter client"
            value={filters.clientLabel ?? ""}
            onChange={(event) => select("clientLabel", event.target.value)}
          >
            <option value="">All clients</option>
            {snapshot.clients.map((client) => (
              <option key={`${client.type}-${client.label}`}>
                {client.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Class
          <select
            value={filters.methodClass ?? ""}
            onChange={(event) => select("methodClass", event.target.value)}
          >
            <option value="">All classes</option>
            {["read", "write", "exec", "control"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Result
          <select
            value={filters.outcome ?? ""}
            onChange={(event) => select("outcome", event.target.value)}
          >
            <option value="">All results</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
            <option value="denied">Denied</option>
            <option value="not_ok">Error or denied</option>
          </select>
        </label>
        <label>
          From
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
          To
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
      {error && (
        <div className="notice err" role="alert">
          {error}
        </div>
      )}
      <ActivityTable rows={rows} />
      {cursor && (
        <div className="note">
          <button className="btn small" onClick={() => void load(true)}>
            Load more
          </button>
        </div>
      )}
      <div className="note">
        Metadata only: method, path, result code, latency and size. File
        contents, search patterns, process arguments and output are never
        recorded.
      </div>
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
