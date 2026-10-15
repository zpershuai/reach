import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Activity, Snapshot } from "./types";
import { MethodSwatch, formatBytes, formatTime } from "./ui";

function resultText(row: Activity): string {
  const type = row.type ?? row.eventType;
  if (type === "rpc.denied")
    return `Denied · ${row.stage ?? "policy"}${row.code ? ` (${row.code})` : ""}`;
  if (row.outcome === "ok") return type === "rpc.finished" ? "OK" : "Done";
  if (row.outcome === "error") return row.code ?? "Error";
  if (type === "auth.failed") return "Auth failed";
  return type?.replace(/^\w+\./, "") ?? "Event";
}

export function ActivityTable({
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
          {rows.map((row, index) => {
            const target =
              [row.workspace, row.path ?? row.script ?? row.processId]
                .filter(Boolean)
                .join(" / ") || "—";
            return (
              <tr key={`${row.type ?? row.eventType}-${row.id}-${index}`}>
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
}

export function ActivityView({ snapshot }: { snapshot: Snapshot }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
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
      setRows((previous) =>
        more ? [...previous, ...result.rows] : result.rows,
      );
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
    void load();
    return () => {
      generation.current++;
    };
  }, [JSON.stringify(filters)]);
  useEffect(() => {
    const live = snapshot.activity.filter((row) =>
      matchesActivity(row, filters),
    );
    setRows((previous) => {
      const merged = new Map<string, Activity>();
      for (const row of [
        ...live,
        ...previous.filter((row) => matchesActivity(row, filters)),
      ]) {
        const key = row.requestId
          ? `${row.engineId}:${row.requestId}:${row.type ?? row.eventType}`
          : `${row.ts}:${row.type ?? row.eventType}:${row.method ?? row.action}:${row.clientLabel ?? row.caller?.label}`;
        if (!merged.has(key)) merged.set(key, row);
      }
      return [...merged.values()].sort((a, b) => b.ts - a.ts);
    });
  }, [snapshot.activity, JSON.stringify(filters)]);
  function select(key: string, value: string): void {
    setFilters((previous) => ({ ...previous, [key]: value }));
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
          <select onChange={(event) => select("outcome", event.target.value)}>
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
