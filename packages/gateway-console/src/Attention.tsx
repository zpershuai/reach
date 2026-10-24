import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { accessRevision, type AccessClient } from "./AccessClients";
import { useNow } from "./clock";
import { useT } from "./i18n";
import { displayOnline } from "./online";
import { navigate } from "./router";
import type { Engine, Snapshot } from "./types";
import { formatAgo } from "./ui";

function commonVersion(engines: Engine[]): string | undefined {
  const counts = new Map<string, number>();
  for (const engine of engines) {
    if (engine.engineVersion)
      counts.set(
        engine.engineVersion,
        (counts.get(engine.engineVersion) ?? 0) + 1,
      );
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] !== ranked[1]?.[1]) return ranked[0][0];
}

// Keeps console navigation in the single-page app: a plain link would reload
// the page, re-fetch the snapshot and reopen the live stream.
function ConsoleLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={`/console/${to}`}
      onClick={(event) => {
        // Let modified clicks open a new tab or window as usual.
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function olderVersion(version: string | null, reference: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  const current = version && parse(version);
  const target = parse(reference);
  if (!current || !target) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(current[index] ?? 0) - Number(target[index] ?? 0);
    if (difference) return difference < 0;
  }
  return false;
}

export function AttentionPanel({ snapshot }: { snapshot: Snapshot }) {
  const { t, lang } = useT();
  const now = useNow();
  const [identities, setIdentities] = useState<AccessClient[]>();
  const [accessError, setAccessError] = useState(false);
  const revision = accessRevision(snapshot.activity);
  // Reload on access changes only: listing identities aggregates audit history,
  // which is too costly to repeat on every snapshot refresh.
  useEffect(() => {
    let active = true;
    void api<{ clients: AccessClient[] }>("access-clients")
      .then((data) => {
        if (active) {
          setIdentities(data.clients ?? []);
          setAccessError(false);
        }
      })
      .catch(() => {
        if (active) setAccessError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const version = commonVersion(snapshot.engines);
  const offline = snapshot.engines.filter(
    (engine) => !displayOnline(engine, now, snapshot.gateway.heartbeatInterval),
  );
  const outdated = snapshot.engines.filter(
    (engine) => version && olderVersion(engine.engineVersion, version),
  );
  const pending =
    identities?.filter(
      (client) =>
        client.revokedAt === null &&
        client.legacyGlobal &&
        client.reviewRequired,
    ) ?? [];
  const failures = snapshot.clients.reduce(
    (total, client) => total + client.errors24h,
    0,
  );
  const healthy =
    !offline.length &&
    !outdated.length &&
    !pending.length &&
    !failures &&
    !accessError &&
    identities !== undefined;
  return (
    <section className="panel attention">
      <div className="panel-head">
        <h2>{t("attention.title")}</h2>
      </div>
      <div className="panel-body">
        <ul className="attention-list">
          {offline.map((engine) => (
            <li key={`offline:${engine.id}`}>
              <ConsoleLink to={`devices/${encodeURIComponent(engine.id)}`}>
                {t("attention.offline", { name: engine.displayName })}
              </ConsoleLink>
              <small>{formatAgo(engine.lastSeenAt, now, lang)}</small>
            </li>
          ))}
          {outdated.map((engine) => (
            <li key={`version:${engine.id}`}>
              <ConsoleLink to={`devices/${encodeURIComponent(engine.id)}`}>
                {t("attention.outdated", {
                  name: engine.displayName,
                  version: engine.engineVersion ?? "",
                })}
              </ConsoleLink>
            </li>
          ))}
          {pending.map((client) => (
            <li key={client.id}>
              <ConsoleLink to="clients">
                {t("attention.review", { name: client.name })}
              </ConsoleLink>
            </li>
          ))}
          {failures > 0 && (
            <li>
              <ConsoleLink to="activity?outcome=not_ok&excludeAuthFailed=1">
                {t("attention.failures", { count: failures })}
              </ConsoleLink>
            </li>
          )}
          {accessError && (
            <li className="muted">{t("attention.accessError")}</li>
          )}
        </ul>
        {healthy && <p className="success">{t("attention.healthy")}</p>}
        {!identities && !accessError && (
          <p className="muted">{t("attention.loading")}</p>
        )}
        <dl className="kv">
          <dt>Gateway / MCP</dt>
          <dd className="mono">
            v{snapshot.gateway.version} / v{snapshot.gateway.mcpVersion}
          </dd>
          <dt>{t("overview.update")}</dt>
          <dd>
            {snapshot.gateway.updateEnabled
              ? t("overview.on")
              : t("overview.off")}
          </dd>
        </dl>
      </div>
    </section>
  );
}
