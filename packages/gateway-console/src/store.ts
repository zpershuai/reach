import { useSyncExternalStore } from "react";
import { api } from "./api";
import { syncServerClock } from "./clock";
import type { Activity, Client, LiveEvent, Snapshot } from "./types";

export interface ConsoleState {
  snapshot: Snapshot | null;
  lastEventId: number;
  recent: LiveEvent[];
  connected: boolean;
}
export const initialState: ConsoleState = {
  snapshot: null,
  lastEventId: 0,
  recent: [],
  connected: false,
};

export function reduceEvent(
  state: ConsoleState,
  event: LiveEvent,
): ConsoleState {
  if (event.id <= state.lastEventId || !state.snapshot) return state;
  const snapshot = { ...state.snapshot };
  let clients = [...snapshot.clients];
  if (event.caller && ["controller", "mcp-http"].includes(event.caller.type)) {
    const prior = clients.find(
      (client) =>
        client.label === event.caller!.label &&
        client.type === event.caller!.type,
    );
    const client: Client = prior
      ? { ...prior }
      : {
          label: event.caller.label,
          type: event.caller.type,
          verified: false,
          lastSeenAt: event.ts,
          activeSessions: 0,
          ownedEngines: [],
          calls24h: 0,
          errors24h: 0,
        };
    client.lastSeenAt = event.ts;
    if (event.type === "client.connected") client.activeSessions++;
    if (event.type === "client.disconnected")
      client.activeSessions = Math.max(0, client.activeSessions - 1);
    if (["rpc.finished", "rpc.denied"].includes(event.type)) {
      client.calls24h++;
      if (event.outcome !== "ok") client.errors24h++;
    }
    clients = [
      ...clients.filter(
        (item) => item.label !== client.label || item.type !== client.type,
      ),
      client,
    ];
  }
  snapshot.engines = snapshot.engines.map((engine) => {
    if (engine.id !== event.engineId) return engine;
    if (event.type === "engine.heartbeat") {
      const hardware = event.hardware ?? engine.hardware;
      return {
        ...engine,
        hardware,
        effectiveHardware:
          hardware || engine.deviceOverride
            ? { ...hardware, ...engine.deviceOverride }
            : null,
        lastSeenAt: event.ts,
        engineVersion: event.engineVersion ?? engine.engineVersion,
        online: true,
        enrollmentStatus: "connected",
      };
    }
    if (event.type === "session.state")
      return {
        ...engine,
        // An Engine holding a session socket does not heartbeat.
        online:
          engine.online || ["ready", "connecting"].includes(event.status ?? ""),
        session: {
          ...engine.session,
          status: event.status ?? "none",
          sessionId: event.sessionId,
          ownerLabel: event.ownerLabel,
          workspaces: event.workspaces,
          processWorkspaces: event.processWorkspaces,
        },
      };
    return engine;
  });
  if (
    [
      "rpc.finished",
      "rpc.denied",
      "auth.failed",
      "client.connected",
      "client.disconnected",
      "admin.action",
    ].includes(event.type)
  ) {
    const activity: Activity = {
      ...event,
      clientLabel: event.caller?.label,
      clientType: event.caller?.type,
    };
    snapshot.activity = [activity, ...snapshot.activity].slice(0, 2000);
  }
  if (event.type === "session.state") {
    clients = clients.map((client) => ({
      ...client,
      ownedEngines: snapshot.engines
        .filter(
          (engine) =>
            engine.session.status !== "none" &&
            engine.session.ownerLabel === client.label,
        )
        .map((engine) => engine.id),
    }));
  }
  snapshot.clients = clients;
  return {
    snapshot,
    lastEventId: event.id,
    recent: [...state.recent, event].slice(-2000),
    connected: true,
  };
}

const STABLE_STREAM_MS = 10_000;

export class ConsoleStore {
  private state: ConsoleState = initialState;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private queue: LiveEvent[] = [];
  private frame: number | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private failures = 0;
  private hasConnected = false;
  private refreshSeq = 0;
  private appliedSeq = 0;
  private resetPending = false;
  private cancelBatch(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    this.frame = undefined;
    this.batchTimer = undefined;
  }
  private flush = (): void => {
    this.cancelBatch();
    const events = this.queue;
    this.queue = [];
    const next = events.reduce(reduceEvent, this.state);
    if (next !== this.state) this.set(next);
  };
  private schedule(): void {
    if (
      !this.queue.length ||
      this.frame !== undefined ||
      this.batchTimer !== undefined
    )
      return;
    if (document.visibilityState === "hidden")
      this.batchTimer = setTimeout(this.flush, 250);
    else this.frame = requestAnimationFrame(this.flush);
  }
  private visibility = (): void => {
    this.cancelBatch();
    this.schedule();
    if (document.visibilityState === "visible")
      void this.refresh().catch(() => {});
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): ConsoleState => this.state;
  private set(state: ConsoleState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  receive(event: LiveEvent): void {
    this.queue.push(event);
    this.schedule();
  }
  async refresh(resetEpoch = false): Promise<void> {
    this.flush();
    const generation = this.generation;
    const seq = ++this.refreshSeq;
    if (resetEpoch) this.resetPending = true;
    const snapshot = await api<Snapshot>("snapshot");
    // A snapshot requested earlier must not replace one requested later.
    if (generation !== this.generation || seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    syncServerClock(snapshot.ts);
    this.flush();
    let next: ConsoleState = {
      snapshot,
      lastEventId: snapshot.eventId,
      recent: [],
      connected: this.state.connected,
    };
    // Events from before a Gateway restart belong to the previous id epoch.
    const replay = this.resetPending ? [] : this.state.recent;
    this.resetPending = false;
    for (const event of replay)
      if (event.id > snapshot.eventId) next = reduceEvent(next, event);
    this.set(next);
  }
  async start(): Promise<void> {
    this.stop();
    this.failures = 0;
    this.hasConnected = false;
    const generation = this.generation;
    await this.refresh();
    if (generation !== this.generation) return;
    document.addEventListener("visibilitychange", this.visibility);
    this.abort = new AbortController();
    void this.stream(this.abort.signal);
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible")
        void this.refresh().catch(() => {});
    }, 15_000);
  }
  private async stream(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let openedAt: number | undefined;
    try {
      const response = await fetch("/api/console/events", {
        credentials: "same-origin",
        headers: { "last-event-id": String(this.state.lastEventId) },
        signal,
      });
      if (signal.aborted) return;
      if (response.status === 401) {
        window.dispatchEvent(new Event("reach:unauthorized"));
        return;
      }
      if (!response.ok || !response.body)
        throw new Error("Live stream unavailable");
      const reconnecting = this.hasConnected || this.failures > 0;
      openedAt = Date.now();
      if (reconnecting) {
        // The new stream may belong to a restarted Gateway with a new event-id epoch.
        try {
          await this.refresh(true);
        } catch {
          /* Retry on the next periodic refresh. */
        }
        if (signal.aborted) return;
      }
      this.hasConnected = true;
      this.set({ ...this.state, connected: true });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (signal.aborted || chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) this.receive(JSON.parse(data));
        }
      }
    } catch {
      /* Reconnect below; the snapshot remains visible. */
    }
    if (!signal.aborted) {
      // Only a stream that stayed up resets the backoff; one that opens and
      // closes at once (as some proxies do) keeps backing off.
      if (openedAt !== undefined && Date.now() - openedAt >= STABLE_STREAM_MS)
        this.failures = 0;
      this.flush();
      this.set({ ...this.state, connected: false });
      this.reconnect = setTimeout(
        () => {
          void this.stream(signal);
        },
        Math.random() *
          Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)),
      );
    }
  }
  stop(): void {
    this.generation++;
    this.resetPending = false;
    this.cancelBatch();
    this.queue = [];
    document.removeEventListener("visibilitychange", this.visibility);
    this.abort?.abort();
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
export const consoleStore = new ConsoleStore();
export function useConsole(): ConsoleState {
  return useSyncExternalStore(consoleStore.subscribe, consoleStore.getSnapshot);
}
