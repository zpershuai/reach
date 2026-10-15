import { describe, expect, it, vi } from "vitest";
import { ConsoleStore, initialState, reduceEvent } from "./store";
import { snapshot } from "./test-fixture";
import type { EventType, LiveEvent } from "./types";

describe("snapshot and live reducer", () => {
  const event = (type: EventType, id = 1): LiveEvent => ({
    type,
    id,
    ts: 2000,
    engineId: "engine-a",
    requestId: "request-a",
    caller: { type: "mcp-http", label: "Test client 1", verified: false },
    outcome: "ok",
  });
  it.each<EventType>([
    "rpc.started",
    "rpc.finished",
    "rpc.denied",
    "session.state",
    "engine.heartbeat",
    "client.connected",
    "client.disconnected",
    "auth.failed",
    "admin.action",
  ])("accepts %s and deduplicates replay", (type) => {
    const first = reduceEvent(
      { ...initialState, snapshot: snapshot() },
      event(type),
    );
    expect(first.lastEventId).toBe(1);
    expect(first.recent[0].type).toBe(type);
    expect(reduceEvent(first, event(type))).toBe(first);
    expect(reduceEvent(first, event(type, 0))).toBe(first);
  });
  it("keeps override precedence through heartbeats and retains readiness configuration", () => {
    const data = snapshot();
    data.engines[0].deviceOverride = { kind: "nas", model: "4-bay NAS" };
    let state = reduceEvent(
      { ...initialState, snapshot: data },
      {
        ...event("engine.heartbeat"),
        hardware: {
          kind: "server",
          model: "Reported model",
          os: "Linux",
          osVersion: "1",
          arch: "arm64",
        },
      },
    );
    expect(state.snapshot!.engines[0].effectiveHardware!.kind).toBe("nas");
    state = reduceEvent(state, {
      ...event("session.state", 2),
      status: "ready",
      workspaces: ["scripts"],
      processWorkspaces: [],
    });
    expect(state.snapshot!.engines[0].session.processWorkspaces).toEqual([]);
  });
  it("updates linked client ownership immediately when a session changes", () => {
    const state = reduceEvent(
      { ...initialState, snapshot: snapshot() },
      {
        ...event("session.state"),
        status: "ready",
        ownerLabel: "Test client 1",
      },
    );
    expect(state.snapshot!.clients[0].ownedEngines).toEqual(["engine-a"]);
    const closed = reduceEvent(state, {
      ...event("session.state", 2),
      status: "none",
    });
    expect(closed.snapshot!.clients[0].ownedEngines).toEqual([]);
  });
  it("replays events received while a periodic snapshot was in flight", async () => {
    let resolveSnapshot!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(snapshot()))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSnapshot = resolve;
            }),
        ),
    );
    const store = new ConsoleStore();
    try {
      await store.refresh();
      const pending = store.refresh();
      store.receive({
        ...event("engine.heartbeat", 1),
        engineVersion: "newer",
      });
      resolveSnapshot(Response.json(snapshot()));
      await pending;
      expect(store.getSnapshot().lastEventId).toBe(1);
      expect(store.getSnapshot().snapshot!.engines[0].engineVersion).toBe(
        "newer",
      );
    } finally {
      store.stop();
      vi.unstubAllGlobals();
    }
  });
  it("sends Last-Event-ID when connecting and consumes SSE frames", async () => {
    const data = snapshot();
    data.eventId = 42;
    const fetcher = vi.fn(
      async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).endsWith("snapshot")) return Response.json(data);
        expect(
          (options?.headers as Record<string, string>)["last-event-id"],
        ).toBe("42");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: 43\nevent: rpc.finished\ndata: ${JSON.stringify(event("rpc.finished", 43))}\n\n`,
                ),
              );
              controller.close();
            },
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const store = new ConsoleStore();
    try {
      await store.start();
      await vi.waitFor(() => expect(store.getSnapshot().lastEventId).toBe(43));
    } finally {
      store.stop();
      vi.unstubAllGlobals();
    }
  });
});
