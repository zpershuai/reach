import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import { ActivityTable } from "./Activity";
import { DeviceDrawer, type SensitiveAction } from "./Devices";
import { DeviceGlyph } from "./Glyph";
import {
  OUT_MS,
  ParticleScheduler,
  ROUTE,
  ease,
  linkState,
  type Particle,
  type ParticleFrame,
} from "./particles";
import { consoleStore } from "./store";
import type { Activity, Client, Engine, LiveEvent, Snapshot } from "./types";
import {
  ClientAvatar,
  Drawer,
  EngineStatus,
  MethodSwatch,
  formatAgo,
  formatTime,
  modelText,
} from "./ui";
import { Kpis } from "./Views";

type Selection =
  | { kind: "client"; id: string }
  | { kind: "engine"; id: string }
  | { kind: "gateway" };
interface Point {
  x: number;
  y: number;
}
interface Route {
  d: string;
  pts: Point[];
  cum: number[];
}
interface Geometry {
  w: number;
  h: number;
  gL: Point;
  gR: Point;
  stageX: Record<"auth" | "policy" | "route", number>;
  clients: Map<string, Route>;
  engines: Map<string, Route>;
}

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

function bezier(a: Point, b: Point): Route {
  const dx = (b.x - a.x) * 0.5;
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const pts: Point[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const u = 1 - t;
    pts.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return {
    d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
    pts,
    cum,
  };
}

function along(route: Route, fraction: number): Point {
  const target = Math.max(0, Math.min(1, fraction)) * route.cum[route.cum.length - 1];
  let index = route.cum.findIndex((length) => length >= target);
  if (index < 1) index = 1;
  const span = route.cum[index] - route.cum[index - 1] || 1;
  const t = (target - route.cum[index - 1]) / span;
  const a = route.pts[index - 1];
  const b = route.pts[index];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Maps route progress onto client path → measured Gateway stages → Engine path. */
function position(
  geo: Geometry,
  client: Route,
  engine: Route,
  progress: number,
): Point {
  if (progress <= ROUTE.gatewayIn) return along(client, progress / ROUTE.gatewayIn);
  if (progress >= ROUTE.gatewayOut)
    return along(engine, (progress - ROUTE.gatewayOut) / (1 - ROUTE.gatewayOut));
  const knots: Array<[number, number]> = [
    [ROUTE.gatewayIn, geo.gL.x],
    [ROUTE.auth, geo.stageX.auth],
    [ROUTE.policy, geo.stageX.policy],
    [ROUTE.route, geo.stageX.route],
    [ROUTE.gatewayOut, geo.gR.x],
  ];
  for (let i = 1; i < knots.length; i++) {
    const [p1, x1] = knots[i];
    const [p0, x0] = knots[i - 1];
    if (progress <= p1)
      return { x: x0 + ((progress - p0) / (p1 - p0)) * (x1 - x0), y: geo.gL.y };
  }
  return geo.gR;
}

function related(selection: Selection | null, client: Client, engine?: Engine): boolean {
  if (!selection || selection.kind === "gateway") return true;
  if (selection.kind === "client")
    return engine ? client.label === selection.id : true;
  return engine ? engine.id === selection.id : true;
}

function readColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const name of ["--c-read", "--c-write", "--c-exec", "--c-skill", "--c-ctl", "--err", "--surface"])
    colors[name] = style.getPropertyValue(name).trim() || "#888";
  return colors;
}
const colorVar = (methodClass: string) =>
  methodClass === "control" ? "--c-ctl" : `--c-${methodClass}`;

export function TopologyView({
  snapshot,
  events,
  sensitive,
}: {
  snapshot: Snapshot;
  events: LiveEvent[];
  sensitive: SensitiveAction;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drawer, setDrawer] = useState<Selection | null>(null);
  const [paused, setPaused] = useState(false);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const topo = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gateway = useRef<HTMLDivElement>(null);
  const stages = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const scheduler = useRef(new ParticleScheduler());
  const heartbeats = useRef<Array<{ engineId: string; started: number }>>([]);
  const geoRef = useRef<Geometry | null>(null);
  const pausedRef = useRef(paused);
  const previousId = useRef(0);
  pausedRef.current = paused;
  const lastEvent = events.at(-1)?.id;
  const { clients, engines } = snapshot;

  const clientSelected = selection?.kind === "client" ? selection.id : undefined;
  const engineSelected = selection?.kind === "engine" ? selection.id : undefined;
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
      return { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height };
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
        clientRoutes.set(key.slice(8), bezier({ x: r.x + r.w, y: r.y + r.h / 2 }, gL));
      else engineRoutes.set(key.slice(7), bezier(gR, { x: r.x, y: r.y + r.h / 2 }));
    }
    const next = { w: box.width, h: box.height, gL, gR, stageX, clients: clientRoutes, engines: engineRoutes };
    geoRef.current = next;
    setGeo(next);
  }

  const shape = [
    ...clients.map((client) => clientKey(client.type, client.label)),
    "|",
    ...engines.map((engine) => engine.id),
  ].join("\0");
  useLayoutEffect(layout, [shape]);
  useEffect(() => {
    const observer = new ResizeObserver(() => layout());
    for (const element of [topo.current, ...(topo.current?.querySelectorAll(".lane") ?? [])])
      if (element) observer.observe(element);
    void document.fonts?.ready.then(() => layout());
    return () => observer.disconnect();
  }, []);

  function find(attribute: string, value: string): Element | undefined {
    return [...(topo.current?.querySelectorAll(`[${attribute}]`) ?? [])].find(
      (element) => element.getAttribute(attribute) === value,
    );
  }
  function pulse(attribute: string, value: string, className: string, ms: number): void {
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
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (lastEvent !== undefined && lastEvent < previousId.current) {
      scheduler.current = new ParticleScheduler();
      previousId.current = 0;
    }
    const pending = events.filter((event) => event.id > previousId.current);
    previousId.current = lastEvent ?? previousId.current;
    const highlighted = new Set<Element>();
    const highlight = (element: Element | null | undefined, ...names: string[]) => {
      if (!element) return;
      element.classList.remove(...names);
      void element.getBoundingClientRect();
      element.classList.add(...names);
      highlighted.add(element);
    };
    const still = reduced || pausedRef.current;
    for (const event of pending) {
      const heartbeat = event.type === "engine.heartbeat" && snapshot.settings.heartbeatDisplay;
      if (!still) {
        scheduler.current.accept(event, performance.now());
        if (heartbeat && event.engineId)
          heartbeats.current.push({ engineId: event.engineId, started: performance.now() });
        continue;
      }
      if (event.type.startsWith("rpc.")) {
        const stage = root?.querySelector(`[data-stage=${event.stage ?? "route"}]`);
        if (event.type === "rpc.denied") highlight(stage, "policy-denied", "stage-highlight");
        else highlight(stage, "stage-highlight");
      }
      if ((event.type.startsWith("rpc.") && event.type !== "rpc.denied") || heartbeat)
        highlight(find("data-id", `egress-${event.engineId}`), "event-highlight");
    }
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
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    let colors = readColors();
    const themeObserver = new MutationObserver(() => (colors = readColors()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (colors = readColors());
    scheme.addEventListener?.("change", onScheme);
    const stageOf = new Map<string, ParticleFrame["stage"]>();
    let frame = 0;

    function dot(point: Point, color: string, radius: number, alpha = 1, hollow = false): void {
      context!.globalAlpha = alpha;
      context!.beginPath();
      context!.arc(point.x, point.y, radius, 0, Math.PI * 2);
      if (hollow) {
        context!.fillStyle = colors["--surface"];
        context!.strokeStyle = color;
        context!.lineWidth = 2;
        context!.fill();
        context!.stroke();
      } else {
        context!.fillStyle = color;
        context!.fill();
      }
      context!.globalAlpha = 1;
    }
    function diamond(point: Point, size: number): void {
      context!.fillStyle = colors["--err"];
      context!.beginPath();
      context!.moveTo(point.x, point.y - size);
      context!.lineTo(point.x + size, point.y);
      context!.lineTo(point.x, point.y + size);
      context!.lineTo(point.x - size, point.y);
      context!.closePath();
      context!.fill();
    }
    function crossed(particle: Particle, state: ParticleFrame): void {
      if (particle.aggregate) return;
      const previous = stageOf.get(particle.requestId);
      if (previous === state.stage) return;
      stageOf.set(particle.requestId, state.stage);
      if (state.mark === "denied") pulse("data-stage", state.stage, "policy-denied", 900);
      else if (["auth", "policy", "route"].includes(state.stage))
        pulse("data-stage", state.stage, "flash", 260);
      else if (state.stage === "engine") {
        pulse("data-id", `egress-${particle.engineId}`, "event-highlight", 500);
        pulse("data-node", `engine-${particle.engineId}`, "hit", 500);
      }
    }

    function draw(now: number): void {
      frame = requestAnimationFrame(draw);
      const geo = geoRef.current;
      if (!geo || !target || !context) return;
      const scale = Math.min(2, window.devicePixelRatio || 1);
      if (target.width !== Math.round(geo.w * scale) || target.height !== Math.round(geo.h * scale)) {
        target.width = Math.round(geo.w * scale);
        target.height = Math.round(geo.h * scale);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, geo.w, geo.h);
      const frames = scheduler.current.frames(now);
      for (const id of stageOf.keys())
        if (!scheduler.current.particles.has(id)) stageOf.delete(id);
      if (pausedRef.current) return;
      heartbeats.current = heartbeats.current.filter((beat) => now - beat.started < 900);
      for (const beat of heartbeats.current) {
        const route = geo.engines.get(beat.engineId);
        if (route) dot(along(route, 1 - ease((now - beat.started) / 900)), colors["--c-ctl"], 2.6, 0.9);
      }
      for (const { particle, frame: state } of frames) {
        const client = geo.clients.get(clientKey(particle.clientType, particle.client));
        const engine = geo.engines.get(particle.engineId);
        if (!client || !engine) continue;
        crossed(particle, state);
        const color = colors[colorVar(particle.methodClass)] ?? colors["--c-ctl"];
        const point = position(geo, client, engine, state.progress);
        const radius = particle.methodClass === "control" ? 3 : 4.5;
        if (state.mark === "count") {
          dot(point, color, 11);
          context.fillStyle = colors["--surface"];
          context.font = "600 10px 'Geist Mono', monospace";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(String(particle.count), point.x, point.y + 0.5);
        } else if (state.mark === "denied") {
          const stop = ROUTE[state.stage as "auth" | "policy" | "route"] * OUT_MS;
          const k = Math.min(1, (now - particle.started - stop) / 700);
          context.strokeStyle = colors["--err"];
          context.globalAlpha = Math.max(0, 1 - k);
          context.lineWidth = 2;
          context.beginPath();
          context.arc(point.x, point.y, 5 + Math.max(0, k) * 16, 0, Math.PI * 2);
          context.stroke();
          context.lineWidth = 2.4;
          context.beginPath();
          context.moveTo(point.x - 5, point.y - 5);
          context.lineTo(point.x + 5, point.y + 5);
          context.moveTo(point.x + 5, point.y - 5);
          context.lineTo(point.x - 5, point.y + 5);
          context.stroke();
          context.globalAlpha = 1;
        } else if (state.stage === "return") {
          if (state.mark === "diamond") diamond(point, 4.5);
          else dot(point, color, particle.methodClass === "control" ? 2.6 : 3.6, 1, particle.methodClass !== "control");
        } else {
          if (state.progress < 1)
            for (let k = 5; k >= 1; k--)
              dot(position(geo, client, engine, state.progress - k * 0.012), color, radius * (1 - k * 0.12), (0.12 * (6 - k)) / 5);
          if (state.dwell !== undefined) {
            const k = (state.dwell % 600) / 600;
            context.strokeStyle = color;
            context.globalAlpha = 1 - k;
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(point.x, point.y, 4 + k * 10, 0, Math.PI * 2);
            context.stroke();
            context.globalAlpha = 1;
          }
          dot(point, color, radius);
        }
      }
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      scheme.removeEventListener?.("change", onScheme);
    };
  }, []);

  function choose(next: Selection): void {
    const same =
      selection &&
      selection.kind === next.kind &&
      (next.kind === "gateway" || ("id" in selection && selection.id === next.id));
    setSelection(next.kind === "gateway" || same ? null : next);
    setDrawer(next);
  }
  function filterOnly(next: Selection): void {
    const same =
      selection && "id" in selection && "id" in next && selection.kind === next.kind && selection.id === next.id;
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

  const activity: Activity[] = snapshot.activity.filter(
    (row) =>
      (!clientSelected || (row.clientLabel ?? row.caller?.label) === clientSelected) &&
      (!engineSelected || row.engineId === engineSelected),
  );
  const device = drawer?.kind === "engine" ? engines.find((engine) => engine.id === drawer.id) : undefined;
  const client = drawer?.kind === "client" ? clients.find((item) => item.label === drawer.id) : undefined;
  const closeDrawer = () => {
    setDrawer(null);
  };

  return (
    <>
      <Kpis snapshot={snapshot} />
      <section className={`panel${paused ? " paused" : ""}`} aria-label="Routing topology">
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
            <button className="btn small" aria-pressed={paused} onClick={() => setPaused(!paused)}>
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
        <div className="topo-scroll">
          <div className="topo" ref={topo}>
            <svg className="edges" aria-hidden="true" viewBox={geo ? `0 0 ${geo.w} ${geo.h}` : undefined}>
              {geo && (
                <path className="edge gwline" d={`M${geo.gL.x},${geo.gL.y} L${geo.gR.x},${geo.gR.y}`} />
              )}
              {clients.map((item) => {
                const key = clientKey(item.type, item.label);
                const route = geo?.clients.get(key);
                if (!route) return null;
                const active = item.activeSessions > 0 || item.ownedEngines.length > 0;
                return (
                  <g key={key}>
                    <path
                      className={`edge ${active ? "c-active" : "c-idle"}${clientDim(item) ? " dim" : ""}`}
                      data-id={`ingress-${key}`}
                      d={route.d}
                    />
                    <path className="hit-path" d={route.d} onClick={() => filterOnly({ kind: "client", id: item.label })}>
                      <title>{item.label} → Gateway</title>
                    </path>
                  </g>
                );
              })}
              {engines.map((engine) => {
                const route = geo?.engines.get(engine.id);
                if (!route) return null;
                const state = linkState(engine.session.status, engine.online);
                return (
                  <g key={engine.id}>
                    <path
                      className={`edge e-${state.className}${engineDim(engine) ? " dim" : ""}`}
                      data-id={`egress-${engine.id}`}
                      d={route.d}
                    >
                      <title>{state.label}</title>
                    </path>
                    <path className="hit-path" d={route.d} onClick={() => filterOnly({ kind: "engine", id: engine.id })}>
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
                  const selected = drawer?.kind === "client" && drawer.id === item.label;
                  return (
                    <div
                      key={key}
                      ref={nodeRef(`ingress-${key}`)}
                      className={`node${clientDim(item) ? " dim" : ""}${selected ? " selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => choose({ kind: "client", id: item.label })}
                      onKeyDown={keyActivate(() => choose({ kind: "client", id: item.label }))}
                    >
                      <div className="row">
                        <span className="who">
                          <ClientAvatar label={item.label} />
                          <span className="name">{item.label}</span>
                        </span>
                        <span className={`pill ${item.activeSessions ? "ok" : ""}`}>
                          {item.activeSessions ? `${item.activeSessions} session${item.activeSessions > 1 ? "s" : ""}` : "Idle"}
                        </span>
                      </div>
                      <div className="meta">
                        <span>{item.type === "mcp-http" ? "Remote MCP" : "Controller API"} · unverified</span>
                        <span>{formatAgo(item.lastSeenAt)}</span>
                      </div>
                    </div>
                  );
                })}
                {!clients.length && <div className="lane-empty">No clients have connected yet.</div>}
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
                  const selected = drawer?.kind === "engine" && drawer.id === engine.id;
                  return (
                    <div
                      key={engine.id}
                      ref={nodeRef(`egress-${engine.id}`)}
                      data-node={`engine-${engine.id}`}
                      className={`node${engine.online ? "" : " offline"}${engineDim(engine) ? " dim" : ""}${selected ? " selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => choose({ kind: "engine", id: engine.id })}
                      onKeyDown={keyActivate(() => choose({ kind: "engine", id: engine.id }))}
                    >
                      <div className="eng">
                        <DeviceGlyph engine={engine} />
                        <div className="eng-body">
                          <div className="row">
                            <span className="name">{engine.displayName}</span>
                          </div>
                          <div className="meta">
                            <span>{modelText(engine)}</span>
                          </div>
                          <div className="meta">
                            <EngineStatus engine={engine} />
                            {!engine.online && engine.lastSeenAt !== null && (
                              <span>{formatAgo(engine.lastSeenAt)}</span>
                            )}
                            {engine.online && engine.session.workspaces && (
                              <span>
                                {engine.session.workspaces.length} workspace
                                {engine.session.workspaces.length === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!engines.length && <div className="lane-empty">No devices yet. Add one from Devices.</div>}
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
                {clientSelected ? `Client: ${clientSelected}` : `Device: ${engineSelected}`}
                <button className="btn ghost small" aria-label="Clear filter" onClick={() => setSelection(null)}>
                  ×
                </button>
              </span>
            )}
          </div>
        </div>
        <ActivityTable rows={activity.slice(0, 100)} tall />
        <div className="note">
          Particles follow received events only. Select a client, device or link to filter.
        </div>
      </section>
      {device && (
        <DeviceDrawer key={device.id} engine={device} snapshot={snapshot} sensitive={sensitive} onClose={closeDrawer} />
      )}
      {client && <ClientDrawer client={client} snapshot={snapshot} sensitive={sensitive} onClose={closeDrawer} />}
      {drawer?.kind === "gateway" && <GatewayDrawer snapshot={snapshot} onClose={closeDrawer} />}
    </>
  );
}

function MiniLog({ rows }: { rows: Activity[] }) {
  if (!rows.length) return <div className="reserved">No operations recorded yet.</div>;
  return (
    <div className="mini-log">
      {rows.slice(0, 6).map((row, index) => (
        <div key={`${row.id}-${index}`}>
          <span className="method">
            <MethodSwatch methodClass={row.methodClass} />
            {row.method ?? row.action ?? row.eventType ?? row.type}
          </span>
          <span className="mono muted">
            {row.engineId ? `${row.engineId} · ` : ""}
            {formatTime(row.ts)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClientDrawer({
  client,
  snapshot,
  sensitive,
  onClose,
}: {
  client: Client;
  snapshot: Snapshot;
  sensitive: SensitiveAction;
  onClose: () => void;
}) {
  return (
    <Drawer title={client.label} label="Client details" onClose={onClose}>
      <section>
        <dl className="kv">
          <dt>Connects via</dt>
          <dd>{client.type === "mcp-http" ? "Remote MCP (HTTP)" : "Controller API"}</dd>
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
          <dd>{formatAgo(client.lastSeenAt)}</dd>
          <dt>Last 24 h</dt>
          <dd>
            {client.calls24h} calls · {client.errors24h} errors
          </dd>
        </dl>
      </section>
      <div className="reserved">
        This label comes from the client itself, so it attributes activity but proves nothing. Verified client identity
        arrives with MCP OAuth.
      </div>
      <section>
        <h4>Recent operations</h4>
        <MiniLog rows={snapshot.activity.filter((row) => (row.clientLabel ?? row.caller?.label) === client.label)} />
      </section>
      {client.type === "mcp-http" && client.activeSessions > 0 && (
        <section className="actions">
          <button
            className="btn small"
            onClick={() =>
              void sensitive(async () => {
                await api(`clients/${encodeURIComponent(client.label)}/disconnect`, {});
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
}

function GatewayDrawer({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const { gateway, kpis, settings } = snapshot;
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
          <dd>{gateway.updateEnabled ? "On · applies when every device is idle" : "Off"}</dd>
          <dt>Audit</dt>
          <dd>SQLite · kept {settings.retentionDays} days</dd>
        </dl>
      </section>
      <section>
        <h4>Request pipeline</h4>
        <div className="reserved">
          Auth checks the Controller token and labels the caller.
          <br />
          Policy checks grants: writes and process runs need one issued for the session.
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
}
