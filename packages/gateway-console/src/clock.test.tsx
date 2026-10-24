import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { syncServerClock, useNow } from "./clock";
import { formatAgo } from "./ui";
import { displayOnline } from "./online";
import { engine, snapshot } from "./test-fixture";
import { DevicesView } from "./Devices";

function Time({ ts }: { ts: number }) {
  return <span>{formatAgo(ts, useNow())}</span>;
}
it("advances relative times without events and pauses its shared timer while hidden", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  const view = render(
    <>
      <Time ts={95_000} />
      <Time ts={95_000} />
    </>,
  );
  try {
    expect(screen.getAllByText("5 s ago")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getAllByText("1 min ago")).toHaveLength(2);
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getAllByText("1 min ago")).toHaveLength(2);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getAllByText("2 min ago")).toHaveLength(2);
  } finally {
    view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("expires heartbeat-only devices but keeps ready and connecting sessions online", () => {
  const idle = { ...engine, session: { status: "none" }, lastSeenAt: 1000 };
  expect(displayOnline(idle, 15_999, 5)).toBe(true);
  expect(displayOnline(idle, 16_000, 5)).toBe(false);
  expect(
    displayOnline({ ...idle, session: { status: "ready" } }, 100_000, 5),
  ).toBe(true);
  expect(
    displayOnline({ ...idle, session: { status: "connecting" } }, 100_000, 5),
  ).toBe(true);
  expect(displayOnline({ ...idle, lastSeenAt: null }, 1000, 5)).toBe(false);
});
it("updates the device status and glyph after three missed heartbeat intervals", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const data = snapshot();
  data.gateway.heartbeatInterval = 5;
  data.engines[0] = {
    ...engine,
    lastSeenAt: 100_000,
    session: { status: "none" },
  };
  const view = render(
    <DevicesView
      snapshot={data}
      sensitive={async (op) => op()}
      onAdd={() => {}}
    />,
  );
  try {
    expect(screen.getByText("Idle · heartbeat")).toBeVisible();
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAccessibleName("mac-mini, offline");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("judges heartbeats against Gateway time when the browser clock is skewed", () => {
  vi.useFakeTimers();
  // The browser runs a minute ahead of the Gateway.
  vi.setSystemTime(160_000);
  const data = snapshot();
  data.gateway.heartbeatInterval = 5;
  data.engines[0] = {
    ...engine,
    lastSeenAt: 99_000,
    session: { status: "none" },
  };
  syncServerClock(100_000);
  const view = render(
    <DevicesView
      snapshot={data}
      sensitive={async (op) => op()}
      onAdd={() => {}}
    />,
  );
  try {
    expect(screen.getByText("Idle · heartbeat")).toBeVisible();
    expect(screen.getByText("1 s ago")).toBeVisible();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("formats Chinese relative time and a never-seen device", () => {
  expect(formatAgo(88_000, 100_000, "zh-CN")).toBe("12 秒前");
  expect(formatAgo(null, 100_000, "zh-CN")).toBe("从未连接");
});

it("uses deterministic relative-time templates independently of ICU output", () => {
  const relativeTime = vi.spyOn(Intl, "RelativeTimeFormat").mockImplementation(() => {
    throw new Error("ICU relative-time formatting must not be needed");
  });
  try {
    for (const [seconds, english, chinese] of [
      [0, "0 s ago", "0 秒前"],
      [5, "5 s ago", "5 秒前"],
      [65, "1 min ago", "1 分钟前"],
      [7200, "2 h ago", "2 小时前"],
    ] as const) {
      expect(formatAgo(0, seconds * 1000, "en")).toBe(english);
      expect(formatAgo(0, seconds * 1000, "zh-CN")).toBe(chinese);
    }
  } finally { relativeTime.mockRestore(); }
});
