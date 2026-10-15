import type { LiveEvent } from "./types";
export interface Particle {
  requestId: string;
  client: string;
  clientType?: string;
  engineId: string;
  methodClass: string;
  started: number;
  /** Local time the outcome arrived; the return trip never starts before it. */
  finishedAt?: number;
  outcome?: string;
  latency: number;
  stage?: string;
  count: number;
  aggregate?: boolean;
}
export interface ParticleFrame {
  /** Position along client path → Gateway → Engine path, from 0 to 1. */
  progress: number;
  mark: "solid" | "hollow" | "diamond" | "denied" | "count";
  stage: "auth" | "policy" | "route" | "engine" | "return";
  /** Milliseconds spent dwelling at the Engine, for the ripple. */
  dwell?: number;
  done: boolean;
}

/** Route progress where each segment ends and each Gateway stage sits. */
export const ROUTE = {
  gatewayIn: 0.3,
  auth: 0.35,
  policy: 0.45,
  route: 0.55,
  gatewayOut: 0.6,
} as const;
export const OUT_MS = 1100;
export const BACK_MS = 900;
const DENY_HOLD_MS = 700;

export function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export function linkState(
  status: string,
  online: boolean,
): { className: string; label: string; dash?: string } {
  if (!online)
    return { className: "offline", label: "Offline · dotted", dash: "1 7" };
  if (status === "ready") return { className: "ready", label: "Ready · solid" };
  if (["wanted", "pending", "connecting"].includes(status))
    return {
      className: "connecting",
      label: "Connecting · animated",
      dash: "8 4",
    };
  return { className: "idle", label: "Heartbeating · dashed", dash: "6 7" };
}

function stageAt(progress: number): ParticleFrame["stage"] {
  if (progress < ROUTE.policy) return "auth";
  if (progress < ROUTE.route) return "policy";
  if (progress < ROUTE.gatewayOut) return "route";
  return "engine";
}

export function particleFrame(particle: Particle, now: number): ParticleFrame {
  const elapsed = Math.max(0, now - particle.started);
  if (particle.aggregate)
    return {
      progress: Math.min(ROUTE.policy, ease(Math.min(1, elapsed / OUT_MS))),
      mark: "count",
      stage: "policy",
      done: elapsed > OUT_MS + 400,
    };
  if (particle.outcome === "denied") {
    const stage =
      particle.stage === "auth"
        ? "auth"
        : particle.stage === "route"
          ? "route"
          : "policy";
    const stop = ROUTE[stage];
    const arrive = stop * OUT_MS;
    return {
      progress: Math.min(stop, elapsed / OUT_MS),
      mark: elapsed >= arrive ? "denied" : "solid",
      stage,
      done: elapsed > arrive + DENY_HOLD_MS,
    };
  }
  if (elapsed < OUT_MS) {
    const progress = ease(elapsed / OUT_MS);
    return { progress, mark: "solid", stage: stageAt(progress), done: false };
  }
  const dwellEnd = Math.max(
    OUT_MS + Math.max(140, Math.min(1500, particle.latency * 1.3)),
    (particle.finishedAt ?? 0) - particle.started,
  );
  if (!particle.outcome || elapsed < dwellEnd)
    return {
      progress: 1,
      mark: "solid",
      stage: "engine",
      dwell: elapsed - OUT_MS,
      done: elapsed > 30_000,
    };
  const back = (elapsed - dwellEnd) / BACK_MS;
  return {
    progress: 1 - ease(Math.min(1, back)),
    mark: particle.outcome === "ok" ? "hollow" : "diamond",
    stage: "return",
    done: back > 1,
  };
}

export class ParticleScheduler {
  readonly particles = new Map<string, Particle>();
  private readonly bursts = new Map<
    string,
    { start: number; count: number; aggregateId?: string }
  >();
  private lastId = 0;
  accept(event: LiveEvent, now: number): void {
    if (event.id <= this.lastId) return;
    this.lastId = event.id;
    if (!event.type.startsWith("rpc.")) return;
    const client = event.caller?.label ?? "Controller API";
    const engineId = event.engineId ?? "";
    const clientType = event.caller?.type ?? "controller";
    const link = `${clientType}\0${client}\0${engineId}`;
    const id = `${link}\0${event.requestId ?? `event-${event.id}`}`;
    const prior = this.particles.get(id);
    if (prior && event.type === "rpc.finished") {
      prior.outcome = event.outcome ?? "error";
      prior.latency = event.latencyMs ?? 0;
      prior.finishedAt = now;
      return;
    }
    let burst = this.bursts.get(link);
    if (!burst || now - burst.start >= 1000) {
      burst = { start: now, count: 0 };
      this.bursts.set(link, burst);
    }
    burst.count++;
    if (burst.count > 20) {
      burst.aggregateId ??= `aggregate-${event.id}`;
      this.particles.set(burst.aggregateId, {
        requestId: burst.aggregateId,
        client,
        clientType,
        engineId,
        methodClass: event.methodClass ?? "control",
        started: burst.start,
        latency: 0,
        count: burst.count,
        aggregate: true,
      });
      return;
    }
    this.particles.set(id, {
      requestId: id,
      client,
      clientType,
      engineId,
      methodClass: event.methodClass ?? "control",
      started: now,
      latency: event.latencyMs ?? 0,
      outcome:
        event.type === "rpc.started" ? undefined : (event.outcome ?? "error"),
      finishedAt: event.type === "rpc.started" ? undefined : now,
      stage: event.stage,
      count: 1,
    });
  }
  frames(now: number): Array<{ particle: Particle; frame: ParticleFrame }> {
    const result: Array<{ particle: Particle; frame: ParticleFrame }> = [];
    for (const [id, particle] of this.particles) {
      const frame = particleFrame(particle, now);
      if (frame.done) this.particles.delete(id);
      else result.push({ particle, frame });
    }
    for (const [key, burst] of this.bursts)
      if (now - burst.start > 2000) this.bursts.delete(key);
    return result;
  }
}
