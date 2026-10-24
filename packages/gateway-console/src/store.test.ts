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

it("applies 50 queued events with one subscriber notification", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb) => {
      frames.push(cb);
      return frames.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot())));
  const store = new ConsoleStore();
  try {
    await store.refresh();
    let expected = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    for (let id = 1; id <= 50; id++) {
      const event: LiveEvent = {
        id,
        type: "rpc.finished",
        ts: id,
        requestId: String(id),
        engineId: "engine-a",
      };
      store.receive(event);
      expected = reduceEvent(expected, event);
    }
    expect(listener).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual(expected);
  } finally {
    store.stop();
    vi.unstubAllGlobals();
  }
});

it("flushes hidden-page events after 250 ms and discards stopped queues", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot())));
  const store = new ConsoleStore();
  try {
    await store.refresh();
    store.receive({ id: 1, type: "engine.heartbeat", ts: 1 });
    await vi.advanceTimersByTimeAsync(249);
    expect(store.getSnapshot().lastEventId).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot().lastEventId).toBe(1);
    store.receive({ id: 2, type: "engine.heartbeat", ts: 2 });
    store.stop();
    await vi.advanceTimersByTimeAsync(250);
    expect(store.getSnapshot().lastEventId).toBe(1);
  } finally {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("backs off with capped jitter, refreshes after reconnect and resets the delay", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fresh = snapshot();
  fresh.eventId = 2;
  let succeed = false;
  let closeStream = () => {};
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("snapshot")) return Response.json(fresh);
    if (!succeed) throw new Error("offline");
    succeed = false;
    return new Response(
      new ReadableStream({
        start(controller) {
          closeStream = () => controller.close();
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const store = new ConsoleStore();
  try {
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    const streams = () =>
      fetcher.mock.calls.filter(([url]) => url.endsWith("events")).length;
    for (const delay of [500, 1000, 2000, 4000, 8000, 15000, 15000]) {
      const count = streams();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(streams()).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams()).toBe(count + 1);
    }
    // Replace the old epoch, even when there are no SSE events to reveal the restart.
    fresh.eventId = 0;
    succeed = true;
    const snapshots = () =>
      fetcher.mock.calls.filter(([url]) => url.endsWith("snapshot")).length;
    const before = snapshots();
    await vi.advanceTimersByTimeAsync(15000);
    expect(snapshots()).toBeGreaterThan(before);
    expect(store.getSnapshot().lastEventId).toBe(0);
    // A stream that stayed up resets the delay once it ends.
    await vi.advanceTimersByTimeAsync(10_000);
    closeStream();
    await vi.advanceTimersByTimeAsync(0);
    const count = streams();
    await vi.advanceTimersByTimeAsync(499);
    expect(streams()).toBe(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams()).toBe(count + 1);
  } finally {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps backing off when streams open and close at once", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("snapshot")
      ? Response.json(snapshot())
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  const store = new ConsoleStore();
  try {
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    const streams = () =>
      fetcher.mock.calls.filter(([url]) => url.endsWith("events")).length;
    for (const delay of [500, 1000, 2000, 4000]) {
      const count = streams();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(streams()).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams()).toBe(count + 1);
    }
  } finally {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps the newest snapshot when overlapping refreshes finish out of order", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    ),
  );
  const store = new ConsoleStore();
  try {
    const older = store.refresh();
    const newer = store.refresh();
    const latest = snapshot();
    latest.eventId = 20;
    resolvers[1](Response.json(latest));
    await newer;
    const stale = snapshot();
    stale.eventId = 10;
    resolvers[0](Response.json(stale));
    await older;
    expect(store.getSnapshot().lastEventId).toBe(20);
  } finally {
    store.stop();
    vi.unstubAllGlobals();
  }
});

it("does not poll snapshots while hidden and refreshes immediately on return", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("snapshot")
      ? Response.json(snapshot())
      : new Response(new ReadableStream()),
  );
  vi.stubGlobal("fetch", fetcher);
  const store = new ConsoleStore();
  try {
    await store.start();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300_000);
    const count = () =>
      fetcher.mock.calls.filter(([url]) => url.endsWith("snapshot")).length;
    expect(count()).toBe(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(2);
    store.stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(count()).toBe(2);
  } finally {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("refreshes after the first successful stream when earlier connection attempts failed", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let connections = 0;
  let snapshots = 0;
  const fresh = snapshot();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("snapshot")) {
        snapshots++;
        return Response.json(fresh);
      }
      if (++connections === 1) throw new Error("offline");
      return new Response(new ReadableStream());
    }),
  );
  const store = new ConsoleStore();
  try {
    fresh.eventId = 50;
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    fresh.eventId = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots).toBe(2);
    expect(store.getSnapshot().lastEventId).toBe(0);
    expect(store.getSnapshot().connected).toBe(true);
  } finally {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("ignores a snapshot that finishes after the store has stopped", async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const store = new ConsoleStore();
  const pending = store.refresh();
  store.stop();
  complete(Response.json(snapshot()));
  await pending;
  expect(store.getSnapshot().snapshot).toBeNull();
  vi.unstubAllGlobals();
});
