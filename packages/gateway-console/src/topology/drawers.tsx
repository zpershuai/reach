import { useNow } from "../clock";
import { memo } from "react";
import { api } from "../api";
import type { SensitiveAction } from "../Devices";
import { consoleStore } from "../store";
import type { Activity, Client, Snapshot } from "../types";
import { Drawer, MiniLog, formatAgo } from "../ui";

export const ClientDrawer = memo(function ClientDrawer({
  client,
  activity,
  sensitive,
  onClose,
}: {
  client: Client;
  activity: Activity[];
  sensitive: SensitiveAction;
  onClose: () => void;
}) {
  const now = useNow();
  return (
    <Drawer title={client.label} label="Client details" onClose={onClose}>
      <section>
        <dl className="kv">
          <dt>Connects via</dt>
          <dd>
            {client.type === "mcp-http"
              ? "Remote MCP (HTTP)"
              : "Controller API"}
          </dd>
          <dt>Identity</dt>
          <dd>
            <span className="pill warn">Self-reported</span>
          </dd>
          <dt>MCP sessions</dt>
          <dd className="mono">{client.activeSessions}</dd>
          <dt>In session with</dt>
          <dd>
            {client.ownedEngines.length
              ? client.ownedEngines.map((id) => (
                  <span className="pill mono" key={id}>
                    {id}
                  </span>
                ))
              : "No device"}
          </dd>
          <dt>Last activity</dt>
          <dd>{formatAgo(client.lastSeenAt, now)}</dd>
          <dt>Last 24 h</dt>
          <dd>
            {client.calls24h} calls · {client.errors24h} errors
          </dd>
        </dl>
      </section>
      <div className="reserved">
        This label comes from the client itself, so it attributes activity but
        proves nothing. Verified client identity arrives with MCP OAuth.
      </div>
      <section>
        <h4>Recent operations</h4>
        <MiniLog
          rows={activity.filter(
            (row) => (row.clientLabel ?? row.caller?.label) === client.label,
          )}
        />
      </section>
      {client.type === "mcp-http" && client.activeSessions > 0 && (
        <section className="actions">
          <button
            className="btn small"
            onClick={() =>
              void sensitive(async () => {
                await api(
                  `clients/${encodeURIComponent(client.label)}/disconnect`,
                  {},
                );
                await consoleStore.refresh();
              })
            }
          >
            Disconnect sessions
          </button>
        </section>
      )}
    </Drawer>
  );
});

export const GatewayDrawer = memo(function GatewayDrawer({
  gateway,
  kpis,
  settings,
  onClose,
}: {
  gateway: Snapshot["gateway"];
  kpis: Snapshot["kpis"];
  settings: Snapshot["settings"];
  onClose: () => void;
}) {
  return (
    <Drawer title="reach-gateway" label="Gateway details" onClose={onClose}>
      <section>
        <dl className="kv">
          <dt>Version</dt>
          <dd className="mono">
            v{gateway.version} · MCP v{gateway.mcpVersion}
          </dd>
          <dt>Address</dt>
          <dd className="mono">{gateway.publicOrigin}</dd>
          <dt>Devices</dt>
          <dd className="mono">
            {kpis.onlineEngines} online / {kpis.registeredEngines}
          </dd>
          <dt>MCP sessions</dt>
          <dd className="mono">{kpis.activeMcpSessions}</dd>
          <dt>Heartbeat</dt>
          <dd>Every {gateway.heartbeatInterval} s</dd>
          <dt>Auto-update</dt>
          <dd>
            {gateway.updateEnabled
              ? "On · applies when every device is idle"
              : "Off"}
          </dd>
          <dt>Audit</dt>
          <dd>SQLite · kept {settings.retentionDays} days</dd>
        </dl>
      </section>
      <section>
        <h4>Request pipeline</h4>
        <div className="reserved">
          Auth checks the Controller token and labels the caller.
          <br />
          Policy checks grants: writes and process runs need one issued for the
          session.
          <br />
          Route forwards the request to the Engine named by engineId.
          <br />
          Each step’s result is written to the activity ledger.
        </div>
      </section>
      {gateway.warnings.map((warning) => (
        <div className="notice warn" key={warning}>
          {warning}
        </div>
      ))}
    </Drawer>
  );
});
