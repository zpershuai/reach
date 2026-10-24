import type { Snapshot } from "./types";
import { formatNumber } from "./ui";
import { LanguageToggle } from "./LanguageToggle";
import { useT } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorText } from "./api";
import { AuthScreen, ReauthDialog } from "./Auth";
import { ActivityView } from "./Activity";
import { AddDevice, DevicesView, type SensitiveAction } from "./Devices";
import { navigate, useRoute } from "./router";
import { consoleStore, useConsole } from "./store";
import { TopologyView } from "./Topology";
import { ClientsView, Overview, SettingsView, SkillsView } from "./Views";

const navigation = [
  ["overview", "nav.overview"],
  ["topology", "nav.topology"],
  ["clients", "nav.clients"],
  ["devices", "nav.devices"],
  ["activity", "nav.activity"],
  ["skills", "nav.skills"],
  ["settings", "nav.settings"],
] as const;
function ThemeToggle({
  theme,
  onError,
}: {
  theme: Snapshot["settings"]["theme"];
  onError: (error: unknown) => void;
}) {
  const { t } = useT();
  const [current, setCurrent] = useState(theme);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCurrent(theme), [theme]);
  const next = ({ system: "light", light: "dark", dark: "system" } as const)[
    current
  ];
  async function cycle(): Promise<void> {
    const previous = current;
    setCurrent(next);
    setBusy(true);
    document.documentElement.dataset.theme = next;
    try {
      await api("settings", { theme: next }, "PATCH");
    } catch (error) {
      setCurrent(previous);
      document.documentElement.dataset.theme = previous;
      onError(error);
      setBusy(false);
      return;
    }
    try {
      await consoleStore.refresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className="btn small theme-toggle"
      disabled={busy}
      aria-label={t("settings.switchTheme", { theme: t(`settings.${next}`) })}
      title={t(`settings.${current}`)}
      onClick={() => void cycle()}
    >
      <span aria-hidden="true">
        {{ system: "◐", light: "☀", dark: "☾" }[current]}
      </span>
    </button>
  );
}

export function App() {
  const { t, lang } = useT();
  const [identity, setIdentity] = useState<{
    authenticated: boolean;
    setupRequired?: boolean;
  }>();
  const [error, setError] = useState<unknown>();
  const [reauth, setReauth] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const navList = useRef<HTMLUListElement>(null);
  const pending = useRef<(() => Promise<void>) | undefined>(undefined);
  const state = useConsole();
  const route = useRoute();
  const section = route.split("/")[0];
  useEffect(() => {
    const list = navList.current;
    if (!list) return;
    const update = () => {
      list.dataset.overflowStart = String(list.scrollLeft > 1);
      list.dataset.overflowEnd = String(
        list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
      );
    };
    // Scroll only the tab row. scrollIntoView would also scroll the page, and
    // mobile browsers fire resize while scrolling as the address bar moves.
    const revealCurrent = () => {
      const current = list.querySelector<HTMLElement>('[aria-current="page"]');
      if (current) {
        const box = list.getBoundingClientRect();
        const item = current.getBoundingClientRect();
        if (item.left < box.left) list.scrollLeft -= box.left - item.left;
        else if (item.right > box.right)
          list.scrollLeft += item.right - box.right;
      }
      update();
    };
    revealCurrent();
    list.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", revealCurrent);
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    for (const item of list.querySelectorAll(".nav-item"))
      observer.observe(item);
    return () => {
      list.removeEventListener("scroll", update);
      window.removeEventListener("resize", revealCurrent);
      observer.disconnect();
    };
  }, [section, identity?.authenticated, lang]);
  async function loadIdentity(): Promise<void> {
    try {
      setIdentity(await api("me"));
    } catch (error) {
      setError(error);
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
      void consoleStore.start().catch((error) => setError(error));
    else consoleStore.stop();
  }, [identity?.authenticated]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      state.snapshot?.settings.theme ?? "system";
  }, [state.snapshot?.settings.theme]);
  // Stable so memoized drawers do not re-render on every live event.
  const sensitive = useCallback<SensitiveAction>(async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") {
        pending.current = operation;
        setReauth(true);
      } else setError(error);
    }
  }, []);
  if (!identity)
    return (
      <main className="loading">
        <span className="brand">
          <b>Reach</b>
          <span>Gateway</span>
        </span>
        <p>{error ? errorText(error, t) : t("nav.connecting")}</p>
        {Boolean(error) && (
          <button className="btn" onClick={() => void loadIdentity()}>
            {t("nav.retry")}
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
  const title = navigation.find((item) => item[0] === section)?.[1];
  const counts: Record<string, string | undefined> = {
    clients: snapshot ? formatNumber(snapshot.clients.length, lang) : undefined,
    devices: snapshot ? formatNumber(snapshot.engines.length, lang) : undefined,
    skills: t("nav.planned"),
  };
  const warnings = snapshot?.gateway.warnings.length ?? 0;
  return (
    <div className="app">
      <nav className="nav" aria-label={t("nav.main")}>
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
        <ul ref={navList}>
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
                {t(label)}
                {counts[path] && <small>{counts[path]}</small>}
              </a>
            </li>
          ))}
        </ul>
        {snapshot && (
          <div className="nav-status" data-expanded={statusOpen}>
            <button
              className={`status-toggle btn small ${state.connected ? "connected" : "reconnecting"} ${warnings || !state.connected ? "warn" : "ok"}`}
              aria-label={t("nav.gatewayStatus")}
              aria-expanded={statusOpen}
              onClick={() => setStatusOpen(!statusOpen)}
            >
              <span className="dot" />
              <span className="connection-label" role="status">
                {state.connected ? t("nav.live") : t("nav.reconnecting")}
              </span>
            </button>
            <div className="status-details">
              <span className="pill">Gateway v{snapshot.gateway.version}</span>
              <span className={`pill ${warnings ? "warn" : "ok"}`}>
                <span className="dot" />
                {warnings
                  ? t("nav.warning", { count: warnings })
                  : t("nav.healthy")}
              </span>
              <span>
                {t("nav.heartbeat", {
                  seconds: snapshot.gateway.heartbeatInterval,
                })}
              </span>
            </div>
          </div>
        )}
        <div className="nav-foot">
          <button
            className="btn primary add-device"
            aria-label={t("nav.add")}
            disabled={!snapshot}
            onClick={() => setAdding(true)}
          >
            <span className="add-device-label">{t("nav.add")}</span>
          </button>
          <div className="owner">
            <span>{t("nav.administrator")}</span>
            <button
              className="btn ghost small"
              onClick={() =>
                void api("logout", {})
                  .then(() => {
                    consoleStore.stop();
                    setIdentity({ authenticated: false });
                    return loadIdentity();
                  })
                  .catch((error) => setError(error))
              }
            >
              {t("nav.signOut")}
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{title ? t(title) : t("nav.notFound")}</h1>
            {snapshot && (
              <div className="sub">
                <span className="mono">
                  {snapshot.gateway.publicOrigin.replace(/^https?:\/\//, "")}
                </span>
              </div>
            )}
          </div>
          <div className="tools appearance">
            <LanguageToggle />
            {snapshot && (
              <ThemeToggle theme={snapshot.settings.theme} onError={setError} />
            )}
          </div>
        </header>
        {Boolean(error) && (
          <div className="notice err" role="alert">
            {errorText(error, t)}
            <button
              className="btn ghost small"
              onClick={() => setError("")}
              aria-label={t("nav.dismiss")}
            >
              ×
            </button>
          </div>
        )}
        {!snapshot ? (
          <div className="panel empty">{t("nav.loading")}</div>
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
                <p>{t("nav.missingPage")}</p>
                <button className="btn" onClick={() => navigate("overview")}>
                  {t("nav.openOverview")}
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
