import { displayOnline } from "./online";
import { useNow } from "./clock";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ActivityTable } from "./Activity";
import { DeviceDrawer, type SensitiveAction } from "./Devices";
import { DeviceGlyph } from "./Glyph";
import { ParticleScheduler, linkState } from "./particles";
import type { Activity, Client, Engine, LiveEvent, Snapshot } from "./types";
import { ClientAvatar, EngineStatus, formatAgo, modelText } from "./ui";
import { Kpis, inSession } from "./Views";
import { bezier, type Geometry, type Route } from "./topology/geometry";
import { ClientDrawer, GatewayDrawer } from "./topology/drawers";

import { createRenderer, type TopologyRenderer } from "./topology/renderer";

type Selection =
  | { kind: "client"; id: string }
  | { kind: "engine"; id: string }
  | { kind: "gateway" };
const clientKey = (type: string | undefined, label: string) =>
  `${type ?? "controller"}-${label}`;
const classes = ["read", "write", "exec", "skill", "control"] as const;
const legend: Record<(typeof classes)[number], string> = {
  read: "Read",
  write: "Write",
  exec: "Exec",
  skill: "Skill (reserved)",
  control: "Control",
};

export function TopologyView({
  snapshot,
  events,
  sensitive,
}: {
  snapshot: Snapshot;
  events: LiveEvent[];
  sensitive: SensitiveAction;
}) {
  const now = useNow();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drawer, setDrawer] = useState<Selection | null>(null);
  const [paused, setPaused] = useState(false);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const topo = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gateway = useRef<HTMLDivElement>(null);
  const stages = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const renderer = useRef<TopologyRenderer | undefined>(undefined);
  const scheduler = useRef(new ParticleScheduler());
  const heartbeats = useRef<Array<{ engineId: string; started: number }>>([]);
  const geoRef = useRef<Geometry | null>(null);
  const pausedRef = useRef(paused);
  const previousId = useRef(0);
  pausedRef.current = paused;
  const lastEvent = events.at(-1)?.id;
  const { clients, engines } = snapshot;

  const clientSelected =
    selection?.kind === "client" ? selection.id : undefined;
  const engineSelected =
    selection?.kind === "engine" ? selection.id : undefined;
  const clientDim = (client: Client) =>
    Boolean(
      (clientSelected && clientSelected !== client.label) ||
      (engineSelected && !client.ownedEngines.includes(engineSelected)),
    );
  const engineDim = (engine: Engine) =>
    Boolean(
      (engineSelected && engineSelected !== engine.id) ||
      (clientSelected && engine.session.ownerLabel !== clientSelected),
    );

  function layout(): void {
    const root = topo.current;
    const card = gateway.current;
    const grid = stages.current;
    if (!root || !card || !grid) return;
    const box = root.getBoundingClientRect();
    const rel = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left - box.left,
        y: rect.top - box.top,
        w: rect.width,
        h: rect.height,
      };
    };
    const g = rel(card);
    const s = rel(grid);
    const y = s.y + s.h / 2;
    const gL = { x: g.x, y };
    const gR = { x: g.x + g.w, y };
    const stageX = { auth: 0, policy: 0, route: 0 };
    grid.querySelectorAll<HTMLElement>("[data-stage]").forEach((element) => {
      const r = rel(element);
      stageX[element.dataset.stage as keyof typeof stageX] = r.x + r.w / 2;
    });
    const clientRoutes = new Map<string, Route>();
    const engineRoutes = new Map<string, Route>();
    for (const [key, element] of nodes.current) {
      const r = rel(element);
      if (key.startsWith("ingress-"))
        clientRoutes.set(
          key.slice(8),
          bezier({ x: r.x + r.w, y: r.y + r.h / 2 }, gL),
        );
      else
        engineRoutes.set(
          key.slice(7),
          bezier(gR, { x: r.x, y: r.y + r.h / 2 }),
        );
    }
    const next = {
      w: box.width,
      h: box.height,
      gL,
      gR,
      stageX,
      clients: clientRoutes,
      engines: engineRoutes,
    };
    geoRef.current = next;
    setGeo(next);
    renderer.current?.wake();
  }

  const shape = [
    ...clients.map((client) => clientKey(client.type, client.label)),
    "|",
    ...engines.map((engine) => engine.id),
  ].join("\0");
  useLayoutEffect(layout, [shape]);
  useEffect(() => {
    const observer = new ResizeObserver(() => layout());
    for (const element of [
      topo.current,
      ...(topo.current?.querySelectorAll(".lane") ?? []),
    ])
      if (element) observer.observe(element);
    void document.fonts?.ready.then(() => layout());
    return () => observer.disconnect();
  }, []);

  function find(attribute: string, value: string): Element | undefined {
    return [...(topo.current?.querySelectorAll(`[${attribute}]`) ?? [])].find(
      (element) => element.getAttribute(attribute) === value,
    );
  }
  function pulse(
    attribute: string,
    value: string,
    className: string,
    ms: number,
  ): void {
    const element = find(attribute, value);
    if (!element) return;
    element.classList.remove(className);
    void element.getBoundingClientRect();
    element.classList.add(className);
    setTimeout(() => element.classList.remove(className), ms);
  }

  // Received events drive particles; with reduced motion or a paused view they
  // become brief highlights of the affected stage and link instead.
  useEffect(() => {
    const root = topo.current;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (lastEvent !== undefined && lastEvent < previousId.current) {
      scheduler.current = new ParticleScheduler();
      previousId.current = 0;
    }
    const pending = events.filter((event) => event.id > previousId.current);
    previousId.current = lastEvent ?? previousId.current;
    const highlighted = new Set<Element>();
    const highlight = (
      element: Element | null | undefined,
      ...names: string[]
    ) => {
      if (!element) return;
      element.classList.remove(...names);
      void element.getBoundingClientRect();
      element.classList.add(...names);
      highlighted.add(element);
    };
    const still = reduced || pausedRef.current;
    for (const event of pending) {
      const heartbeat =
        event.type === "engine.heartbeat" && snapshot.settings.heartbeatDisplay;
      if (!still) {
        scheduler.current.accept(event, performance.now());
        if (heartbeat && event.engineId)
          heartbeats.current.push({
            engineId: event.engineId,
            started: performance.now(),
          });
        continue;
      }
      if (event.type.startsWith("rpc.")) {
        const stage = root?.querySelector(
          `[data-stage=${event.stage ?? "route"}]`,
        );
        if (event.type === "rpc.denied")
          highlight(stage, "policy-denied", "stage-highlight");
        else highlight(stage, "stage-highlight");
      }
      if (
        (event.type.startsWith("rpc.") && event.type !== "rpc.denied") ||
        heartbeat
      )
        highlight(
          find("data-id", `egress-${event.engineId}`),
          "event-highlight",
        );
    }
    renderer.current?.wake();
    const names = ["event-highlight", "policy-denied", "stage-highlight"];
    const timer = setTimeout(() => {
      for (const element of highlighted) element.classList.remove(...names);
    }, 600);
    return () => {
      clearTimeout(timer);
      for (const element of highlighted) element.classList.remove(...names);
    };
  }, [lastEvent]);

  useEffect(() => {
    if (!canvas.current) return;
    const instance = createRenderer({
      target: canvas.current,
      getGeometry: () => geoRef.current,
      getScheduler: () => scheduler.current,
      heartbeats,
      isPaused: () => pausedRef.current,
      pulse,
    });
    renderer.current = instance;
    return () => {
      instance?.dispose();
      renderer.current = undefined;
    };
  }, []);
  useEffect(() => {
    renderer.current?.wake();
  }, [paused]);

  function choose(next: Selection): void {
    const same =
      selection &&
      selection.kind === next.kind &&
      (next.kind === "gateway" ||
        ("id" in selection && selection.id === next.id));
    setSelection(next.kind === "gateway" || same ? null : next);
    setDrawer(next);
  }
  function filterOnly(next: Selection): void {
    const same =
      selection &&
      "id" in selection &&
      "id" in next &&
      selection.kind === next.kind &&
      selection.id === next.id;
    setSelection(same ? null : next);
  }
  const keyActivate = (action: () => void) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
  const nodeRef = (key: string) => (element: HTMLElement | null) => {
    if (element) nodes.current.set(key, element);
    else nodes.current.delete(key);
  };

  const activity: Activity[] = useMemo(
    () =>
      snapshot.activity
        .filter(
          (row) =>
            (!clientSelected ||
              (row.clientLabel ?? row.caller?.label) === clientSelected) &&
            (!engineSelected || row.engineId === engineSelected),
        )
        .slice(0, 100),
    [snapshot.activity, clientSelected, engineSelected],
  );
  const device =
    drawer?.kind === "engine"
      ? engines.find((engine) => engine.id === drawer.id)
      : undefined;
  const client =
    drawer?.kind === "client"
      ? clients.find((item) => item.label === drawer.id)
      : undefined;
  const closeDrawer = useCallback(() => setDrawer(null), []);

  return (
    <>
      <Kpis kpis={snapshot.kpis} inSession={inSession(snapshot.engines)} />
      <section
        className={`panel${paused ? " paused" : ""}`}
        aria-label="Routing topology"
      >
        <div className="panel-head">
          <h2>Clients → Gateway → Engines</h2>
          <div className="tools">
            <div className="legend" aria-label="Legend">
              {classes.map((name) => (
                <span key={name}>
                  <i className={`sw c-${name}`} />
                  {legend[name]}
                </span>
              ))}
              <span>
                <i className="sw hollow" />
                Response
              </span>
              <span>
                <i className="sw diamond" />
                Error
              </span>
              <span>
                <i className="sw x">×</i>
                Denied
              </span>
            </div>
            <button
              className="btn small"
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
        <div className="topo-scroll">
          <div className="topo" ref={topo}>
            <svg
              className="edges"
              aria-hidden="true"
              viewBox={geo ? `0 0 ${geo.w} ${geo.h}` : undefined}
            >
              {geo && (
                <path
                  className="edge gwline"
                  d={`M${geo.gL.x},${geo.gL.y} L${geo.gR.x},${geo.gR.y}`}
                />
              )}
              {clients.map((item) => {
                const key = clientKey(item.type, item.label);
                const route = geo?.clients.get(key);
                if (!route) return null;
                const active =
                  item.activeSessions > 0 || item.ownedEngines.length > 0;
                return (
                  <g key={key}>
                    <path
                      className={`edge ${active ? "c-active" : "c-idle"}${clientDim(item) ? " dim" : ""}`}
                      data-id={`ingress-${key}`}
                      d={route.d}
                    />
                    <path
                      className="hit-path"
                      d={route.d}
                      onClick={() =>
                        filterOnly({ kind: "client", id: item.label })
                      }
                    >
                      <title>{item.label} → Gateway</title>
                    </path>
                  </g>
                );
              })}
              {engines.map((engine) => {
                const route = geo?.engines.get(engine.id);
                if (!route) return null;
                const state = linkState(
                  engine.session.status,
                  displayOnline(
                    engine,
                    now,
                    snapshot.gateway.heartbeatInterval,
                  ),
                );
                return (
                  <g key={engine.id}>
                    <path
                      className={`edge e-${state.className}${engineDim(engine) ? " dim" : ""}`}
                      data-id={`egress-${engine.id}`}
                      d={route.d}
                    >
                      <title>{state.label}</title>
                    </path>
                    <path
                      className="hit-path"
                      d={route.d}
                      onClick={() =>
                        filterOnly({ kind: "engine", id: engine.id })
                      }
                    >
                      <title>Gateway → {engine.displayName}</title>
                    </path>
                  </g>
                );
              })}
            </svg>
            <div className="lanes">
              <div className="lane">
                <div className="lane-title">
                  <span>Clients</span>
                  <span>{clients.length}</span>
                </div>
                {clients.map((item) => {
                  const key = clientKey(item.type, item.label);
                  const selected =
                    drawer?.kind === "client" && drawer.id === item.label;
                  return (
                    <div
                      key={key}
                      ref={nodeRef(`ingress-${key}`)}
                      className={`node${clientDim(item) ? " dim" : ""}${selected ? " selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => choose({ kind: "client", id: item.label })}
                      onKeyDown={keyActivate(() =>
                        choose({ kind: "client", id: item.label }),
                      )}
                    >
                      <div className="row">
                        <span className="who">
                          <ClientAvatar label={item.label} />
                          <span className="name">{item.label}</span>
                        </span>
                        <span
                          className={`pill ${item.activeSessions ? "ok" : ""}`}
                        >
                          {item.activeSessions
                            ? `${item.activeSessions} session${item.activeSessions > 1 ? "s" : ""}`
                            : "Idle"}
                        </span>
                      </div>
                      <div className="meta">
                        <span>
                          {item.type === "mcp-http"
                            ? "Remote MCP"
                            : "Controller API"}{" "}
                          · unverified
                        </span>
                        <span>{formatAgo(item.lastSeenAt, now)}</span>
                      </div>
                    </div>
                  );
                })}
                {!clients.length && (
                  <div className="lane-empty">
                    No clients have connected yet.
                  </div>
                )}
              </div>
              <div className="lane">
                <div className="lane-title">
                  <span>Gateway</span>
                  <span>v{snapshot.gateway.version}</span>
                </div>
                <div
                  ref={gateway}
                  className={`node gw${drawer?.kind === "gateway" ? " selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => choose({ kind: "gateway" })}
                  onKeyDown={keyActivate(() => choose({ kind: "gateway" }))}
                >
                  <div className="gw-head">
                    <span className="name">reach-gateway</span>
                    <span className="pill ok">
                      <span className="dot" />
                      Running
                    </span>
                  </div>
                  <div className="stages" ref={stages}>
                    <div className="stage" data-stage="auth">
                      <b>Auth</b>
                      <span>Token</span>
                    </div>
                    <div className="stage" data-stage="policy">
                      <b>Policy</b>
                      <span>Grant · scope</span>
                    </div>
                    <div className="stage" data-stage="route">
                      <b>Route</b>
                      <span>engineId</span>
                    </div>
                  </div>
                  <div className="gw-foot">
                    <span>Audit → SQLite</span>
                    <span>Kept {snapshot.settings.retentionDays} days</span>
                  </div>
                </div>
              </div>
              <div className="lane">
                <div className="lane-title">
                  <span>Engines</span>
                  <span>{engines.length}</span>
                </div>
                {engines.map((engine) => {
                  const selected =
                    drawer?.kind === "engine" && drawer.id === engine.id;
                  return (
                    <div
                      key={engine.id}
                      ref={nodeRef(`egress-${engine.id}`)}
                      data-node={`engine-${engine.id}`}
                      className={`node${displayOnline(engine, now, snapshot.gateway.heartbeatInterval) ? "" : " offline"}${engineDim(engine) ? " dim" : ""}${selected ? " selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => choose({ kind: "engine", id: engine.id })}
                      onKeyDown={keyActivate(() =>
                        choose({ kind: "engine", id: engine.id }),
                      )}
                    >
                      <div className="eng">
                        <DeviceGlyph
                          heartbeatInterval={snapshot.gateway.heartbeatInterval}
                          engine={engine}
                        />
                        <div className="eng-body">
                          <div className="row">
                            <span className="name">{engine.displayName}</span>
                          </div>
                          <div className="meta">
                            <span>{modelText(engine)}</span>
                          </div>
                          <div className="meta">
                            <EngineStatus
                              heartbeatInterval={
                                snapshot.gateway.heartbeatInterval
                              }
                              engine={engine}
                            />
                            {!displayOnline(
                              engine,
                              now,
                              snapshot.gateway.heartbeatInterval,
                            ) &&
                              engine.lastSeenAt !== null && (
                                <span>{formatAgo(engine.lastSeenAt, now)}</span>
                              )}
                            {displayOnline(
                              engine,
                              now,
                              snapshot.gateway.heartbeatInterval,
                            ) &&
                              engine.session.workspaces && (
                                <span>
                                  {engine.session.workspaces.length} workspace
                                  {engine.session.workspaces.length === 1
                                    ? ""
                                    : "s"}
                                </span>
                              )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!engines.length && (
                  <div className="lane-empty">
                    No devices yet. Add one from Devices.
                  </div>
                )}
              </div>
            </div>
            <canvas ref={canvas} className="flow" aria-hidden="true" />
          </div>
        </div>
      </section>
      <section className="panel" aria-label="Live activity">
        <div className="panel-head">
          <h2>Live activity</h2>
          <div className="tools">
            {(clientSelected || engineSelected) && (
              <span className="pill accent">
                {clientSelected
                  ? `Client: ${clientSelected}`
                  : `Device: ${engineSelected}`}
                <button
                  className="btn ghost small"
                  aria-label="Clear filter"
                  onClick={() => setSelection(null)}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        </div>
        <ActivityTable rows={activity} tall />
        <div className="note">
          Particles follow received events only. Select a client, device or link
          to filter.
        </div>
      </section>
      {device && (
        <DeviceDrawer
          key={device.id}
          engine={device}
          activity={snapshot.activity}
          heartbeatInterval={snapshot.gateway.heartbeatInterval}
          sensitive={sensitive}
          onClose={closeDrawer}
        />
      )}
      {client && (
        <ClientDrawer
          client={client}
          activity={snapshot.activity}
          sensitive={sensitive}
          onClose={closeDrawer}
        />
      )}
      {drawer?.kind === "gateway" && (
        <GatewayDrawer
          gateway={snapshot.gateway}
          kpis={snapshot.kpis}
          settings={snapshot.settings}
          onClose={closeDrawer}
        />
      )}
    </>
  );
}
