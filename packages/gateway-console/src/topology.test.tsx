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
