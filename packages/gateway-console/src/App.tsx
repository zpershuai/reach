import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { AuthScreen, ReauthDialog } from "./Auth";
import { ActivityView } from "./Activity";
import { AddDevice, DevicesView, type SensitiveAction } from "./Devices";
import { navigate, useRoute } from "./router";
import { consoleStore, useConsole } from "./store";
import { TopologyView } from "./Topology";
import { ClientsView, Overview, SettingsView, SkillsView } from "./Views";

const navigation = [
  ["overview", "Overview"],
  ["topology", "Topology"],
  ["clients", "Clients"],
  ["devices", "Devices"],
  ["activity", "Activity"],
  ["skills", "Skills"],
  ["settings", "Settings"],
];
export function App() {
  const [identity, setIdentity] = useState<{
    authenticated: boolean;
    setupRequired?: boolean;
  }>();
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [adding, setAdding] = useState(false);
  const pending = useRef<(() => Promise<void>) | undefined>(undefined);
  const state = useConsole();
  const route = useRoute();
  const section = route.split("/")[0];
  async function loadIdentity(): Promise<void> {
    try {
      setIdentity(await api("me"));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Gateway unavailable");
    }
  }
  useEffect(() => {
    void loadIdentity();
    const expired = () => {
      consoleStore.stop();
      void loadIdentity();
    };
    window.addEventListener("reach:unauthorized", expired);
    return () => {
      window.removeEventListener("reach:unauthorized", expired);
      consoleStore.stop();
    };
  }, []);
  useEffect(() => {
    if (identity?.authenticated)
      void consoleStore.start().catch((error) => setError(String(error)));
    else consoleStore.stop();
  }, [identity?.authenticated]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      state.snapshot?.settings.theme ?? "system";
  }, [state.snapshot?.settings.theme]);
  const sensitive: SensitiveAction = async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") {
        pending.current = operation;
        setReauth(true);
      } else
        setError(error instanceof Error ? error.message : "Request failed");
    }
  };
  if (!identity)
    return (
      <main className="loading">
        <span className="brand">
          <b>Reach</b>
          <span>Gateway</span>
        </span>
        <p>{error || "Connecting to your Gateway…"}</p>
        {error && (
          <button className="btn" onClick={() => void loadIdentity()}>
            Retry
          </button>
        )}
      </main>
    );
  if (!identity.authenticated)
    return (
      <AuthScreen
        setup={Boolean(identity.setupRequired)}
        onAuthenticated={() => void loadIdentity()}
      />
    );
  const snapshot = state.snapshot;
  const title =
    navigation.find((item) => item[0] === section)?.[1] ?? "Not found";
  const counts: Record<string, string | undefined> = {
    clients: snapshot ? String(snapshot.clients.length) : undefined,
    devices: snapshot ? String(snapshot.engines.length) : undefined,
    skills: "Planned",
  };
  const warnings = snapshot?.gateway.warnings.length ?? 0;
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <a
          className="brand"
          href="/console/"
          onClick={(event) => {
            event.preventDefault();
            navigate("overview");
          }}
        >
          <b>Reach</b>
          <span>Gateway</span>
        </a>
        <ul>
          {navigation.map(([path, label]) => (
            <li key={path}>
              <a
                className="nav-item"
                aria-current={section === path ? "page" : undefined}
                href={`/console/${path}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(path);
                }}
              >
                {label}
                {counts[path] && <small>{counts[path]}</small>}
              </a>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <button
            className="btn primary"
            disabled={!snapshot}
            onClick={() => setAdding(true)}
          >
            Add device
          </button>
          <div className="owner">
            <span>Administrator</span>
            <button
              className="btn ghost small"
              onClick={() =>
                void api("logout", {})
                  .then(() => {
                    consoleStore.stop();
                    setIdentity({ authenticated: false });
                    return loadIdentity();
                  })
                  .catch((error) => setError(String(error)))
              }
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            {snapshot && (
              <div className="sub">
                <span className="mono">
                  {snapshot.gateway.publicOrigin.replace(/^https?:\/\//, "")}
                </span>
                <span className="pill">Gateway v{snapshot.gateway.version}</span>
                <span className={`pill ${warnings ? "warn" : "ok"}`}>
                  <span className="dot" />
                  {warnings
                    ? `${warnings} warning${warnings > 1 ? "s" : ""}`
                    : "Healthy"}
                </span>
                <span>Heartbeat {snapshot.gateway.heartbeatInterval} s</span>
              </div>
            )}
          </div>
          <div className="tools">
            <span
              className={`pill ${state.connected ? "accent live" : "warn"}`}
              role="status"
            >
              <span className="dot" />
              {state.connected ? "Live" : "Reconnecting"}
            </span>
          </div>
        </header>
        {error && (
          <div className="notice err" role="alert">
            {error}
            <button
              className="btn ghost small"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {!snapshot ? (
          <div className="panel empty">Loading Gateway state…</div>
        ) : (
          <>
            {section === "overview" && <Overview snapshot={snapshot} />}
            {section === "topology" && (
              <TopologyView
                snapshot={snapshot}
                events={state.recent}
                sensitive={sensitive}
              />
            )}
            {section === "clients" && (
              <ClientsView snapshot={snapshot} sensitive={sensitive} />
            )}
            {section === "devices" && (
              <DevicesView
                snapshot={snapshot}
                sensitive={sensitive}
                onAdd={() => setAdding(true)}
                initialId={
                  route.split("/")[1]
                    ? decodeURIComponent(route.split("/")[1])
                    : undefined
                }
              />
            )}
            {section === "activity" && <ActivityView snapshot={snapshot} />}
            {section === "settings" && (
              <SettingsView snapshot={snapshot} sensitive={sensitive} />
            )}
            {section === "skills" && <SkillsView />}
            {!navigation.some((item) => item[0] === section) && (
              <section className="panel empty">
                <p>This page does not exist.</p>
                <button className="btn" onClick={() => navigate("overview")}>
                  Open Overview
                </button>
              </section>
            )}
          </>
        )}
      </main>
      {adding && snapshot && (
        <AddDevice
          snapshot={snapshot}
          sensitive={sensitive}
          onClose={() => setAdding(false)}
        />
      )}
      {reauth && (
        <ReauthDialog
          onCancel={() => {
            pending.current = undefined;
            setReauth(false);
          }}
          onConfirm={async (password) => {
            await api("reauth", { password });
            const operation = pending.current;
            pending.current = undefined;
            setReauth(false);
            if (operation) await sensitive(operation);
          }}
        />
      )}
    </div>
  );
}
