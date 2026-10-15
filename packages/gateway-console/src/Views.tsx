import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { ActivityTable } from "./Activity";
import { DeviceGlyph } from "./Glyph";
import { consoleStore } from "./store";
import type { SensitiveAction } from "./Devices";
import type { Snapshot } from "./types";
import { ClientAvatar, EngineStatus, Modal, formatAgo, modelText } from "./ui";

export function Kpis({ snapshot }: { snapshot: Snapshot }) {
  const { kpis } = snapshot;
  const inSession = snapshot.engines.filter(
    (engine) => engine.online && engine.session.status === "ready",
  ).length;
  return (
    <section className="kpis" aria-label="Key metrics">
      <div className="kpi">
        <span className="label">Clients</span>
        <span className="value">{kpis.clients}</span>
      </div>
      <div className="kpi">
        <span className="label">Devices online</span>
        <span className="value">
          {kpis.onlineEngines}/{kpis.registeredEngines}
          <small>{inSession} in session</small>
        </span>
      </div>
      <div className="kpi">
        <span className="label">MCP sessions</span>
        <span className="value">{kpis.activeMcpSessions}</span>
      </div>
      <div className="kpi">
        <span className="label">Requests / min</span>
        <span className="value">{kpis.requestsPerMinute}</span>
      </div>
      <div className="kpi">
        <span className="label">Error rate · 5 min</span>
        <span className="value">{(kpis.errorRate5m * 100).toFixed(1)}%</span>
      </div>
      <div className="kpi">
        <span className="label">Policy denials · today</span>
        <span className="value">{kpis.policyDenialsToday}</span>
      </div>
    </section>
  );
}

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      <Kpis snapshot={snapshot} />
      {snapshot.gateway.warnings.map((warning) => (
        <div className="notice warn" key={warning} role="status">
          {warning}
        </div>
      ))}
      <div className="columns">
        <section className="panel">
          <div className="panel-head">
            <h2>Devices</h2>
            <span className="pill">
              Heartbeat every {snapshot.gateway.heartbeatInterval} s
            </span>
          </div>
          {snapshot.engines.map((engine) => (
            <div className="device-row" key={engine.id}>
              <DeviceGlyph engine={engine} />
              <div>
                <strong>{engine.displayName}</strong>
                <small>{modelText(engine)}</small>
              </div>
              <EngineStatus engine={engine} />
            </div>
          ))}
          {!snapshot.engines.length && (
            <div className="empty">No devices registered yet.</div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Versions</h2>
          </div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Gateway</dt>
              <dd className="mono">v{snapshot.gateway.version}</dd>
              <dt>MCP</dt>
              <dd className="mono">v{snapshot.gateway.mcpVersion}</dd>
              <dt>Gateway auto-update</dt>
              <dd>
                {snapshot.gateway.updateEnabled
                  ? "On · applies when every device is idle"
                  : "Off"}
              </dd>
              {snapshot.engines.map((engine) => (
                <div key={engine.id} style={{ display: "contents" }}>
                  <dt>{engine.displayName}</dt>
                  <dd className="mono">
                    {engine.engineVersion
                      ? `v${engine.engineVersion}`
                      : "Not reported"}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="reserved">
              Engine updates are configured on each device.
            </div>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Recent activity</h2>
        </div>
        <ActivityTable rows={snapshot.activity.slice(0, 8)} />
      </section>
    </>
  );
}

export function ClientsView({
  snapshot,
  sensitive,
}: {
  snapshot: Snapshot;
  sensitive: SensitiveAction;
}) {
  const [confirm, setConfirm] = useState("");
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Clients</h2>
          <span className="pill">Self-reported labels · unverified</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">MCP sessions</th>
                <th>Devices in session</th>
                <th>Last activity</th>
                <th className="num">Calls · 24 h</th>
                <th className="num">Errors · 24 h</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshot.clients.map((client) => (
                <tr key={`${client.type}-${client.label}`}>
                  <td>
                    <span className="who">
                      <ClientAvatar label={client.label} />
                      <span>
                        <strong>{client.label}</strong>
                        <small>
                          {client.type === "mcp-http"
                            ? "Remote MCP"
                            : "Controller API"}{" "}
                          · unverified
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="num">{client.activeSessions}</td>
                  <td className="mono">
                    {client.ownedEngines.join(", ") || "—"}
                  </td>
                  <td>{formatAgo(client.lastSeenAt)}</td>
                  <td className="num">{client.calls24h}</td>
                  <td className="num">{client.errors24h}</td>
                  <td>
                    {client.type === "mcp-http" &&
                      client.activeSessions > 0 && (
                        <button
                          className="btn small"
                          onClick={() => setConfirm(client.label)}
                        >
                          Disconnect
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!snapshot.clients.length && (
            <div className="empty">No clients seen yet.</div>
          )}
        </div>
        <div className="note">
          Labels come from each client’s MCP handshake or X-Reach-Client header.
          They attribute activity; they do not prove identity or grant access.
        </div>
      </section>
      <AuthorizedApps
        sensitive={sensitive}
        revision={
          snapshot.activity.find((row) => row.action?.startsWith("oauth."))
            ?.id ?? 0
        }
      />
      {confirm && (
        <Modal title={`Disconnect ${confirm}?`}>
          <p>
            Its MCP sessions end now. Device sessions it opened finish their
            current requests and close.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm("")}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() =>
                void sensitive(async () => {
                  await api(
                    `clients/${encodeURIComponent(confirm)}/disconnect`,
                    {},
                  );
                  await consoleStore.refresh();
                  setConfirm("");
                })
              }
            >
              Disconnect client
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface OAuthApp {
  id: string;
  name: string;
  redirectUris: string[];
  approvedAt: number;
  lastUsedAt: number | null;
  activeTokens: number;
}

function AuthorizedApps({
  sensitive,
  revision,
}: {
  sensitive: SensitiveAction;
  /** Id of the latest oauth.* admin action; approvals in other tabs reload the list. */
  revision: number;
}) {
  const [apps, setApps] = useState<OAuthApp[] | undefined>();
  const [confirm, setConfirm] = useState<OAuthApp | undefined>();
  const load = () =>
    api<{ clients: OAuthApp[] }>("oauth")
      .then((data) => setApps(data.clients))
      .catch(() => setApps([]));
  useEffect(() => {
    void load();
  }, [revision]);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Authorized apps</h2>
        <span className="pill">OAuth · approved by you</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Returns to</th>
              <th>Approved</th>
              <th>Last used</th>
              <th className="num">Live tokens</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apps?.map((app) => (
              <tr key={app.id}>
                <td>
                  <strong>{app.name}</strong>
                </td>
                <td className="mono">
                  {app.redirectUris.map((uri) => new URL(uri).host).join(", ")}
                </td>
                <td>{formatAgo(app.approvedAt)}</td>
                <td>{app.lastUsedAt ? formatAgo(app.lastUsedAt) : "—"}</td>
                <td className="num">{app.activeTokens}</td>
                <td>
                  <button className="btn small" onClick={() => setConfirm(app)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {apps && !apps.length && (
          <div className="empty">No apps authorized through OAuth.</div>
        )}
      </div>
      <div className="note">
        Remote MCP clients such as ChatGPT connectors sign in through
        /oauth/authorize. Each approval needs your password and authentication
        code.
      </div>
      {confirm && (
        <Modal title={`Revoke ${confirm.name}?`}>
          <p>
            Its tokens stop working at once. It must be approved again before it
            can reconnect.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() =>
                void sensitive(async () => {
                  await api(
                    `oauth/${encodeURIComponent(confirm.id)}`,
                    undefined,
                    "DELETE",
                  );
                  await load();
                  setConfirm(undefined);
                })
              }
            >
              Revoke access
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function SettingsView({
  snapshot,
  sensitive,
}: {
  snapshot: Snapshot;
  sensitive: SensitiveAction;
}) {
  const [days, setDays] = useState(snapshot.settings.retentionDays);
  const [theme, setTheme] = useState(snapshot.settings.theme);
  const [heartbeats, setHeartbeats] = useState(
    snapshot.settings.heartbeatDisplay,
  );
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    await sensitive(async () => {
      await api(
        "settings",
        { retentionDays: days, theme, heartbeatDisplay: heartbeats },
        "PATCH",
      );
      await consoleStore.refresh();
      setSaved(true);
    });
  }
  return (
    <section className="panel" style={{ maxWidth: 640 }}>
      <div className="panel-head">
        <h2>Settings</h2>
      </div>
      <form className="panel-body" onSubmit={(event) => void submit(event)}>
        <label>
          Keep activity for (days)
          <input
            type="number"
            min="1"
            max="365"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            required
          />
        </label>
        <div className="reserved">
          Older records are deleted once a day. Changing this asks for your
          password again.
        </div>
        <label>
          Theme
          <select
            value={theme}
            onChange={(event) => setTheme(event.target.value as typeof theme)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={heartbeats}
            onChange={(event) => setHeartbeats(event.target.checked)}
          />
          Show heartbeats in the topology
        </label>
        <div className="actions">
          <button className="btn primary">Save settings</button>
          {saved && (
            <span className="success" role="status">
              Settings saved
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

export function SkillsView() {
  return (
    <section className="panel skills-reserved">
      <div className="panel-head">
        <h2>Skills</h2>
        <span className="pill">Planned</span>
      </div>
      <div className="panel-body">
        <p>Skill management is not available yet. It will let you:</p>
        <ul>
          <li>keep a catalogue of SKILL.md skills on the Gateway;</li>
          <li>choose which skills each device installs;</li>
          <li>let bots discover and run them through MCP.</li>
        </ul>
      </div>
    </section>
  );
}
