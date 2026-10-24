import { i18n } from "../i18n";
import {
  OUT_MS,
  ROUTE,
  ease,
  type ParticleScheduler,
  type Particle,
  type ParticleFrame,
} from "../particles";
import { along, position, type Geometry, type Point } from "./geometry";

const clientKey = (type: string | undefined, label: string) =>
  `${type ?? "controller"}-${label}`;
function readColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const name of [
    "--c-read",
    "--c-write",
    "--c-exec",
    "--c-skill",
    "--c-ctl",
    "--err",
    "--surface",
  ])
    colors[name] = style.getPropertyValue(name).trim() || "#888";
  return colors;
}
const colorVar = (methodClass: string) =>
  methodClass === "control" ? "--c-ctl" : `--c-${methodClass}`;

export interface TopologyRenderer {
  wake(): void;
  dispose(): void;
}

export function createRenderer({
  target,
  getGeometry,
  getScheduler,
  heartbeats,
  isPaused,
  pulse,
}: {
  target: HTMLCanvasElement;
  getGeometry: () => Geometry | null;
  getScheduler: () => ParticleScheduler;
  heartbeats: { current: Array<{ engineId: string; started: number }> };
  isPaused: () => boolean;
  pulse: (
    attribute: string,
    value: string,
    className: string,
    ms: number,
  ) => void;
}): TopologyRenderer | undefined {
  const context = target.getContext("2d");
  if (!context) return;
  let colors = readColors();
  let numberFormat = new Intl.NumberFormat(i18n.language);
  const themeObserver = new MutationObserver(() => (colors = readColors()));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => (colors = readColors());
  scheme.addEventListener?.("change", onScheme);
  const stageOf = new Map<string, ParticleFrame["stage"]>();
  let frame: number | undefined;
  let disposed = false;
  const wake = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(draw);
  };
  const onLanguage = () => {
    numberFormat = new Intl.NumberFormat(i18n.language);
    wake();
  };
  i18n.on("languageChanged", onLanguage);

  function dot(
    point: Point,
    color: string,
    radius: number,
    alpha = 1,
    hollow = false,
  ): void {
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
    if (state.mark === "denied")
      pulse("data-stage", state.stage, "policy-denied", 900);
    else if (["auth", "policy", "route"].includes(state.stage))
      pulse("data-stage", state.stage, "flash", 260);
    else if (state.stage === "engine") {
      pulse("data-id", `egress-${particle.engineId}`, "event-highlight", 500);
      pulse("data-node", `engine-${particle.engineId}`, "hit", 500);
    }
  }

  function draw(now: number): void {
    frame = undefined;
    const geo = getGeometry();
    if (!geo || !target || !context) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    if (
      target.width !== Math.round(geo.w * scale) ||
      target.height !== Math.round(geo.h * scale)
    ) {
      target.width = Math.round(geo.w * scale);
      target.height = Math.round(geo.h * scale);
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, geo.w, geo.h);
    const frames = getScheduler().frames(now);
    for (const id of stageOf.keys())
      if (!getScheduler().particles.has(id)) stageOf.delete(id);
    if (isPaused()) return;
    heartbeats.current = heartbeats.current.filter(
      (beat) => now - beat.started < 900,
    );
    for (const beat of heartbeats.current) {
      const route = geo.engines.get(beat.engineId);
      if (route)
        dot(
          along(route, 1 - ease((now - beat.started) / 900)),
          colors["--c-ctl"],
          2.6,
          0.9,
        );
    }
    for (const { particle, frame: state } of frames) {
      const client = geo.clients.get(
        clientKey(particle.clientType, particle.client),
      );
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
        context.fillText(
          numberFormat.format(particle.count),
          point.x,
          point.y + 0.5,
        );
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
        else
          dot(
            point,
            color,
            particle.methodClass === "control" ? 2.6 : 3.6,
            1,
            particle.methodClass !== "control",
          );
      } else {
        if (state.progress < 1)
          for (let k = 5; k >= 1; k--)
            dot(
              position(geo, client, engine, state.progress - k * 0.012),
              color,
              radius * (1 - k * 0.12),
              (0.12 * (6 - k)) / 5,
            );
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
    if (
      getScheduler().particles.size ||
      heartbeats.current.length ||
      stageOf.size
    )
      wake();
  }
  wake();
  return {
    wake,
    dispose: () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      themeObserver.disconnect();
      i18n.off("languageChanged", onLanguage);
      scheme.removeEventListener?.("change", onScheme);
    },
  };
}
