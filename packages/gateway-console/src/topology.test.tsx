import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TopologyView } from "./Topology";
import { snapshot } from "./test-fixture";
import type { LiveEvent } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("highlights each received event once, clears reduced-motion feedback, and opens linked details", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: true,
  } as MediaQueryList);
  const data = snapshot();
  const denied: LiveEvent = {
    id: 1,
    ts: 1,
    type: "rpc.denied",
    engineId: "engine-a",
    stage: "policy",
    outcome: "denied",
  };
  const props = {
    snapshot: data,
    sensitive: async (action: () => Promise<void>) => action(),
  };
  const view = render(<TopologyView {...props} events={[denied]} />);
  const policy = view.container.querySelector("[data-stage=policy]")!;
  expect(policy).toHaveClass("policy-denied", "stage-highlight");
  expect(screen.getByText("Clients → Gateway → Engines")).toBeVisible();
  expect(screen.getByRole("img", { name: "mac-mini, ready" })).toBeVisible();
  act(() => vi.advanceTimersByTime(600));
  expect(policy).not.toHaveClass("policy-denied", "stage-highlight");
  view.rerender(
    <TopologyView
      {...props}
      events={[
        denied,
        { id: 2, ts: 2, type: "engine.heartbeat", engineId: "engine-a" },
      ]}
    />,
  );
  expect(policy).not.toHaveClass("policy-denied", "stage-highlight");
  const edge = view.container.querySelector('[data-id="egress-engine-a"]')!;
  expect(edge).toHaveClass("event-highlight");
  act(() => vi.advanceTimersByTime(600));
  expect(edge).not.toHaveClass("event-highlight");
  fireEvent.click(screen.getByText("Test client 1"));
  expect(screen.getByRole("dialog", { name: "Client details" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("stops scheduling Canvas frames when idle and wakes for received RPC events", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  const raf = vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const context = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D,
  );
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: false,
  } as MediaQueryList);
  const props = {
    snapshot: snapshot(),
    sensitive: async (action: () => Promise<void>) => action(),
  };
  const view = render(<TopologyView {...props} events={[]} />);
  const frame = (time: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    act(() => pending.forEach((cb) => cb(time)));
  };
  frame(0);
  expect(callbacks.size).toBe(0);
  const calls = raf.mock.calls.length;
  view.rerender(
    <TopologyView
      {...props}
      events={[
        {
          id: 1,
          ts: 1,
          type: "rpc.finished",
          engineId: "engine-a",
          requestId: "a",
          outcome: "ok",
          caller: { type: "mcp-http", label: "Test client 1", verified: false },
        },
      ]}
    />,
  );
  expect(raf.mock.calls.length).toBeGreaterThan(calls);
  frame(performance.now());
  expect(callbacks.size).toBe(1);
  frame(performance.now() + 4000);
  expect(callbacks.size).toBe(0);
});
