import { useT, type Lang } from "./i18n";
import { useNow } from "./clock";
import { memo, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorText } from "./api";
import { ActivityTable } from "./Activity";
import { DeviceGlyph } from "./Glyph";
import { consoleStore } from "./store";
import type { SensitiveAction } from "./Devices";
import type { Snapshot } from "./types";
import {
  ClientAvatar,
  EngineStatus,
  Modal,
  formatAgo,
  modelText,
  formatNumber,
  warningText,
} from "./ui";
import { AttentionPanel } from "./Attention";
import { AccessClients } from "./AccessClients";

export function inSession(engines: Snapshot["engines"]): number {
  return engines.filter((engine) => engine.session.status === "ready").length;
}

export const Kpis = memo(function Kpis({
  kpis,
  inSession,
}: {
  kpis: Snapshot["kpis"];
  inSession: number;
}) {
  const { t, lang } = useT();
  return (
    <section className="kpis" aria-label={t("overview.metrics")}>
      <div className={`kpi${kpis.clients === 0 ? " zero" : ""}`}>
        <span className="label">{t("overview.clients")}</span>
        <span className="value">{formatNumber(kpis.clients, lang)}</span>
      </div>
      <div className={`kpi${kpis.onlineEngines === 0 ? " zero" : ""}`}>
        <span className="label">{t("overview.online")}</span>
        <span className="value">
          {formatNumber(kpis.onlineEngines, lang)}/
          {formatNumber(kpis.registeredEngines, lang)}
        </span>
        <small>{t("overview.inSession", { count: inSession })}</small>
      </div>
      <div className={`kpi${kpis.activeMcpSessions === 0 ? " zero" : ""}`}>
        <span className="label">{t("overview.mcpSessions")}</span>
        <span className="value">
          {formatNumber(kpis.activeMcpSessions, lang)}
        </span>
      </div>
      <div className={`kpi${kpis.requestsPerMinute === 0 ? " zero" : ""}`}>
        <span className="label">{t("overview.requests")}</span>
        <span className="value">
          {formatNumber(kpis.requestsPerMinute, lang)}
        </span>
      </div>
      <div
        className={`kpi${kpis.errorRate5m === 0 ? " zero" : ""}${kpis.errorRate5m > 0 ? " alert" : ""}`}
      >
        <span className="label">{t("overview.errorRate")}</span>
        <span className="value">
          {formatNumber(kpis.errorRate5m * 100, lang, 1)}%
        </span>
      </div>
      <div
        className={`kpi${kpis.policyDenialsToday === 0 ? " zero" : ""}${kpis.policyDenialsToday > 0 ? " alert" : ""}`}
      >
        <span className="label">{t("overview.denials")}</span>
        <span className="value">
          {formatNumber(kpis.policyDenialsToday, lang)}
        </span>
      </div>
    </section>
  );
});

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const { t, lang } = useT();
  const recent = useMemo(() => snapshot.activity, [snapshot.activity]);
  return (
    <>
      <Kpis kpis={snapshot.kpis} inSession={inSession(snapshot.engines)} />
      {snapshot.gateway.warnings.map((warning, index) => (
        <div className="notice warn" key={warning} role="status">
          {warningText(warning, lang, snapshot.gateway.warningDetails?.[index])}
        </div>
      ))}
      <div className="columns">
        <section className="panel">
          <div className="panel-head">
            <h2>{t("overview.devices")}</h2>
          </div>
          {snapshot.engines.map((engine) => (
            <div className="device-row" key={engine.id}>
              <DeviceGlyph
                heartbeatInterval={snapshot.gateway.heartbeatInterval}
                engine={engine}
              />
              <div>
                <strong>{engine.displayName}</strong>
                <small>{modelText(engine, lang)}</small>
              </div>
              <EngineStatus
                heartbeatInterval={snapshot.gateway.heartbeatInterval}
                engine={engine}
              />
            </div>
          ))}
          {!snapshot.engines.length && (
            <div className="empty">{t("overview.noDevices")}</div>
          )}
        </section>
        <AttentionPanel snapshot={snapshot} />
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>{t("overview.recent")}</h2>
        </div>
        <ActivityTable rows={recent} collapse maxRows={8} />
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
  const { t, lang } = useT();
  const now = useNow();
  const [confirm, setConfirm] = useState("");
  const showOwnedEngines = snapshot.clients.some(
    (client) => client.ownedEngines.length > 0,
  );
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{t("overview.clients")}</h2>
          <span className="pill">{t("overview.unverifiedLabels")}</span>
        </div>
        <div className="table-wrap">
          <table className="client-table">
            <thead>
              <tr>
                <th>{t("overview.client")}</th>
                <th className="num">{t("overview.mcpSessions")}</th>
                {showOwnedEngines && <th>{t("overview.sessionDevices")}</th>}
                <th>{t("overview.lastActivity")}</th>
                <th className="num">{t("overview.calls")}</th>
                <th className="num">{t("overview.errors")}</th>
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
                            ? t("overview.remote")
                            : t("overview.controller")}{" "}
                          {t("overview.unverified")}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="num">
                    {formatNumber(client.activeSessions, lang)}
                  </td>
                  {showOwnedEngines && (
                    <td className="mono">
                      {client.ownedEngines.join(", ") || "—"}
                    </td>
                  )}
                  <td>{formatAgo(client.lastSeenAt, now, lang)}</td>
                  <td className="num">{formatNumber(client.calls24h, lang)}</td>
                  <td className="num">
                    {formatNumber(client.errors24h, lang)}
                  </td>
                  <td>
                    {client.type === "mcp-http" &&
                      client.activeSessions > 0 && (
                        <button
                          className="btn small danger-outline"
                          onClick={() => setConfirm(client.label)}
                        >
                          {t("overview.disconnect")}
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!snapshot.clients.length && (
            <div className="empty">{t("overview.noClients")}</div>
          )}
        </div>
        <div className="note">{t("overview.labelsNote")}</div>
      </section>
      <AccessClients
        engines={snapshot.engines}
        sensitive={sensitive}
        revision={
          snapshot.activity.find(
            (row) =>
              row.action?.startsWith("client.") ||
              row.action?.startsWith("oauth."),
          )?.id ?? 0
        }
      />
      <AuthorizedApps
        sensitive={sensitive}
        revision={
          snapshot.activity.find((row) => row.action?.startsWith("oauth."))
            ?.id ?? 0
        }
      />
      {confirm && (
        <Modal
          title={t("overview.disconnectTitle", { name: confirm })}
          onCancel={() => setConfirm("")}
        >
          <p>{t("overview.disconnectNote")}</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm("")}>
              {t("overview.cancel")}
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
              {t("overview.disconnectClient")}
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
  const { t, lang } = useT();
  const now = useNow();
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
        <h2>{t("overview.apps")}</h2>
        <span className="pill">{t("overview.approvedByYou")}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("overview.app")}</th>
              <th>{t("overview.returnsTo")}</th>
              <th>{t("overview.approved")}</th>
              <th>{t("overview.lastUsed")}</th>
              <th className="num">{t("overview.liveTokens")}</th>
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
                <td>{formatAgo(app.approvedAt, now, lang)}</td>
                <td>
                  {app.lastUsedAt ? formatAgo(app.lastUsedAt, now, lang) : "—"}
                </td>
                <td className="num">{formatNumber(app.activeTokens, lang)}</td>
                <td>
                  <button
                    className="btn small danger-outline"
                    onClick={() => setConfirm(app)}
                  >
                    {t("overview.revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {apps && !apps.length && (
          <div className="empty">{t("overview.noApps")}</div>
        )}
      </div>
      <div className="note">{t("overview.oauthNote")}</div>
      {confirm && (
        <Modal
          title={t("overview.revokeTitle", { name: confirm.name })}
          onCancel={() => setConfirm(undefined)}
        >
          <p>{t("overview.revokeNote")}</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm(undefined)}>
              {t("overview.cancel")}
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
              {t("overview.revokeAccess")}
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
  const { t, lang, setLang } = useT();
  const [days, setDays] = useState(snapshot.settings.retentionDays);
  const [theme, setTheme] = useState(snapshot.settings.theme);
  useEffect(() => setTheme(snapshot.settings.theme), [snapshot.settings.theme]);
  const [heartbeats, setHeartbeats] = useState(
    snapshot.settings.heartbeatDisplay,
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>();
  const [themeBusy, setThemeBusy] = useState(false);
  async function changeTheme(value: typeof theme): Promise<void> {
    const previous = theme;
    setTheme(value);
    document.documentElement.dataset.theme = value;
    setThemeBusy(true);
    setError("");
    setSaved(false);
    try {
      await api("settings", { theme: value }, "PATCH");
    } catch (error) {
      setTheme(previous);
      document.documentElement.dataset.theme = previous;
      setError(error);
      return;
    } finally {
      setThemeBusy(false);
    }
    try {
      await consoleStore.refresh();
    } catch (error) {
      setError(error);
    }
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    setError("");
    const patch: Partial<Snapshot["settings"]> = {};
    if (days !== snapshot.settings.retentionDays) patch.retentionDays = days;
    if (heartbeats !== snapshot.settings.heartbeatDisplay)
      patch.heartbeatDisplay = heartbeats;
    const save = async () => {
      if (Object.keys(patch).length) await api("settings", patch, "PATCH");
      await consoleStore.refresh();
      setSaved(true);
    };
    if (patch.retentionDays !== undefined) await sensitive(save);
    else {
      try {
        await save();
      } catch (error) {
        setError(error);
      }
    }
  }
  return (
    <section className="settings-view">
      <h2 className="sr-only">{t("settings.title")}</h2>
      {Boolean(error) && (
        <div className="notice err" role="alert">
          {errorText(error, t)}
        </div>
      )}
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        <section className="panel">
          <div className="panel-head">
            <h3>{t("settings.activityRetention")}</h3>
          </div>
          <div className="panel-body">
            <label>
              {t("settings.retention")}
              <input
                type="number"
                min="1"
                max="365"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                required
              />
            </label>
            <div className="reserved">{t("settings.retentionNote")}</div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>{t("settings.appearance")}</h3>
          </div>
          <div className="panel-body">
            <label>
              {t("common.language")}
              <select
                value={lang}
                onChange={(event) => setLang(event.target.value as Lang)}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
            <label>
              {t("settings.theme")}
              <select
                value={theme}
                disabled={themeBusy}
                onChange={(event) =>
                  void changeTheme(event.target.value as typeof theme)
                }
              >
                <option value="system">{t("settings.system")}</option>
                <option value="light">{t("settings.light")}</option>
                <option value="dark">{t("settings.dark")}</option>
              </select>
            </label>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>{t("nav.topology")}</h3>
          </div>
          <div className="panel-body">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={heartbeats}
                onChange={(event) => setHeartbeats(event.target.checked)}
              />
              {t("settings.heartbeats")}
            </label>
          </div>
        </section>
        <div className="actions">
          <button className="btn primary">{t("settings.save")}</button>
          {saved && (
            <span className="success" role="status">
              {t("settings.saved")}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

export function SkillsView() {
  const { t } = useT();
  return (
    <section className="panel skills-reserved">
      <div className="panel-head">
        <h2>{t("skills.title")}</h2>
        <span className="pill">{t("skills.planned")}</span>
      </div>
      <div className="panel-body">
        <p>{t("skills.intro")}</p>
        <ul>
          <li>{t("skills.catalogue")}</li>
          <li>{t("skills.devices")}</li>
          <li>{t("skills.mcp")}</li>
        </ul>
      </div>
    </section>
  );
}
