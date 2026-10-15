import { useSyncExternalStore } from "react";
import { api } from "./api";
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
          engine.online ||
          ["ready", "connecting"].includes(event.status ?? ""),
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

export class ConsoleStore {
  private state: ConsoleState = initialState;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
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
    this.set(reduceEvent(this.state, event));
  }
  async refresh(): Promise<void> {
    const snapshot = await api<Snapshot>("snapshot");
    let next: ConsoleState = {
      snapshot,
      lastEventId: snapshot.eventId,
      recent: [],
      connected: this.state.connected,
    };
    for (const event of this.state.recent)
      if (event.id > snapshot.eventId) next = reduceEvent(next, event);
    this.set(next);
  }
  async start(): Promise<void> {
    this.stop();
    await this.refresh();
    this.abort = new AbortController();
    void this.stream(this.abort.signal);
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, 15_000);
  }
  private async stream(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch("/api/console/events", {
        credentials: "same-origin",
        headers: { "last-event-id": String(this.state.lastEventId) },
        signal,
      });
      if (response.status === 401) {
        window.dispatchEvent(new Event("reach:unauthorized"));
        return;
      }
      if (!response.ok || !response.body)
        throw new Error("Live stream unavailable");
      this.set({ ...this.state, connected: true });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
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
      this.set({ ...this.state, connected: false });
      this.reconnect = setTimeout(() => {
        void this.recover(signal);
      }, 1000);
    }
  }
  private async recover(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const snapshot = await api<Snapshot>("snapshot");
      // Gateway event ids restart with the process; a new snapshot establishes its epoch.
      if (snapshot.eventId < this.state.lastEventId)
        this.set({
          snapshot,
          lastEventId: snapshot.eventId,
          recent: [],
          connected: false,
        });
    } catch {
      /* Replay still works if the snapshot request fails transiently. */
    }
    if (!signal.aborted) void this.stream(signal);
  }
  stop(): void {
    this.abort?.abort();
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
export const consoleStore = new ConsoleStore();
export function useConsole(): ConsoleState {
  return useSyncExternalStore(consoleStore.subscribe, consoleStore.getSnapshot);
}
