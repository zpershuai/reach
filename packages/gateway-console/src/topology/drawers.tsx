import { useT, i18n } from "../i18n";
import { useNow } from "../clock";
import { memo } from "react";
import { api } from "../api";
import type { SensitiveAction } from "../Devices";
import { consoleStore } from "../store";
import type { Activity, Client, Snapshot } from "../types";
import { Drawer, MiniLog, formatAgo, formatNumber, warningText } from "../ui";

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
  const { t, lang } = useT();
  const now = useNow();
  return (
    <Drawer
      title={client.label}
      label={t("topologyDrawer.client")}
      onClose={onClose}
    >
      <section>
        <dl className="kv">
          <dt>{t("topologyDrawer.via")}</dt>
          <dd>
            {client.type === "mcp-http"
              ? t("topologyDrawer.remote")
              : t("topologyDrawer.controller")}
          </dd>
          <dt>{t("topologyDrawer.identity")}</dt>
          <dd>
            <span className="pill warn">
              {t("topologyDrawer.selfReported")}
            </span>
          </dd>
          <dt>{t("topologyDrawer.sessions")}</dt>
          <dd className="mono">{formatNumber(client.activeSessions, lang)}</dd>
          <dt>{t("topologyDrawer.sessionWith")}</dt>
          <dd>
            {client.ownedEngines.length
              ? client.ownedEngines.map((id) => (
                  <span className="pill mono" key={id}>
                    {id}
                  </span>
                ))
              : t("topologyDrawer.noDevice")}
          </dd>
          <dt>{t("topologyDrawer.lastActivity")}</dt>
          <dd>{formatAgo(client.lastSeenAt, now, lang)}</dd>
          <dt>{t("topologyDrawer.lastDay")}</dt>
          <dd>
            {t("topologyDrawer.calls", {
              calls: client.calls24h,
              errors: client.errors24h,
            })}
          </dd>
        </dl>
      </section>
      <div className="reserved">{t("topologyDrawer.labelNote")}</div>
      <section>
        <h4>{t("topologyDrawer.recent")}</h4>
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
            {t("topologyDrawer.disconnect")}
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
  const { t, lang } = useT();
  return (
    <Drawer
      title="reach-gateway"
      label={t("topologyDrawer.gateway")}
      onClose={onClose}
    >
      <section>
        <dl className="kv">
          <dt>{t("topologyDrawer.version")}</dt>
          <dd className="mono">
            v{gateway.version} · MCP v{gateway.mcpVersion}
          </dd>
          <dt>{t("topologyDrawer.address")}</dt>
          <dd className="mono">{gateway.publicOrigin}</dd>
          <dt>{t("topologyDrawer.devices")}</dt>
          <dd className="mono">
            {t("topologyDrawer.online", {
              online: kpis.onlineEngines,
              total: kpis.registeredEngines,
            })}
          </dd>
          <dt>{t("topologyDrawer.sessions")}</dt>
          <dd className="mono">{formatNumber(kpis.activeMcpSessions, lang)}</dd>
          <dt>{t("topologyDrawer.heartbeat")}</dt>
          <dd>
            {t("topologyDrawer.every", { seconds: gateway.heartbeatInterval })}
          </dd>
          <dt>{t("topologyDrawer.update")}</dt>
          <dd>
            {gateway.updateEnabled
              ? t("topologyDrawer.on")
              : t("topologyDrawer.off")}
          </dd>
          <dt>{t("topologyDrawer.audit")}</dt>
          <dd>{t("topologyDrawer.kept", { count: settings.retentionDays })}</dd>
        </dl>
      </section>
      <section>
        <h4>{t("topologyDrawer.pipeline")}</h4>
        <div className="reserved">
          {t("topologyDrawer.authNote")}
          <br />
          {t("topologyDrawer.policyNote")}
          <br />
          {t("topologyDrawer.routeNote")}
          <br />
          {t("topologyDrawer.ledgerNote")}
        </div>
      </section>
      {gateway.warnings.map((warning, index) => (
        <div className="notice warn" key={warning}>
          {warningText(warning, lang, gateway.warningDetails?.[index])}
        </div>
      ))}
    </Drawer>
  );
});
