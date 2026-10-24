import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { ActivityTable, ActivityView } from "./Activity";
import { snapshot } from "./test-fixture";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue({ rows: [], cursor: null });
});
it("attributes auth failures to unauthenticated requests and shows only supplied repeat counts", () => {
  render(
    <ActivityTable
      rows={[
        {
          id: 1,
          ts: 1000,
          type: "auth.failed",
          path: "/unknown",
          count: 3,
          outcome: "error",
        },
        { id: 2, ts: 2000, eventType: "auth.failed", path: "/probe" },
      ]}
    />,
  );
  expect(screen.queryByText("Gateway")).not.toBeInTheDocument();
  expect(screen.getAllByText("Unauthenticated request")).toHaveLength(2);
  expect(screen.getByText("Auth failed ×3")).toBeVisible();
  expect(screen.getByText("Auth failed", { exact: true })).toBeVisible();
});
it("restores URL filters, requests and export links and follows popstate", async () => {
  const data = snapshot();
  data.engines[0].id = "nas-01";
  history.replaceState(
    null,
    "",
    "/console/activity?engineId=nas-01&outcome=not_ok",
  );
  render(<ActivityView snapshot={data} />);
  expect(screen.getByLabelText("Filter device")).toHaveValue("nas-01");
  expect(screen.getByLabelText("Result")).toHaveValue("not_ok");
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      "activity?engineId=nas-01&outcome=not_ok",
    ),
  );
  expect(screen.getByText("Export CSV")).toHaveAttribute(
    "href",
    "/api/console/activity/export?engineId=nas-01&outcome=not_ok&format=csv",
  );
  act(() => {
    history.replaceState(null, "", "/console/activity?outcome=ok");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByLabelText("Filter device")).toHaveValue("");
  expect(screen.getByLabelText("Result")).toHaveValue("ok");
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith("activity?outcome=ok"),
  );
});
it("pushes discrete filters, replaces time edits and restores local datetime inputs", async () => {
  const timestamp = new Date(2026, 0, 2, 3, 4).getTime();
  history.replaceState(null, "", `/console/activity?from=${timestamp}`);
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  render(<ActivityView snapshot={snapshot()} />);
  expect(screen.getByLabelText("From")).toHaveValue("2026-01-02T03:04");
  fireEvent.change(screen.getByLabelText("Result"), {
    target: { value: "error" },
  });
  expect(push).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-01-03T03:04" },
  });
  expect(replace).toHaveBeenCalledOnce();
  expect(new URLSearchParams(location.search).get("to")).toBe(
    String(new Date(2026, 0, 3, 3, 4).getTime()),
  );
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      expect.stringContaining("outcome=error&to="),
    ),
  );
  vi.restoreAllMocks();
});

it("does not duplicate a live record when the ledger returns it with its row id", async () => {
  const data = snapshot();
  data.activity = [];
  history.replaceState(null, "", "/console/activity");
  const view = render(<ActivityView snapshot={data} />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  await act(async () => {});
  // A live event arrives with its stream event id…
  const live = snapshot();
  live.activity = [
    { id: 7, ts: 5000, type: "admin.action", action: "settings.update" },
  ];
  view.rerender(<ActivityView snapshot={live} />);
  expect(screen.getAllByText("settings.update")).toHaveLength(1);
  // …and the next snapshot returns the same record with its ledger row id.
  const refreshed = snapshot();
  refreshed.activity = [
    { id: 912, ts: 5000, eventType: "admin.action", action: "settings.update" },
  ];
  view.rerender(<ActivityView snapshot={refreshed} />);
  expect(screen.getAllByText("settings.update")).toHaveLength(1);
});

it("keeps live records that arrive while the first page is loading", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  history.replaceState(null, "", "/console/activity");
  const data = snapshot();
  data.activity = [];
  const view = render(<ActivityView snapshot={data} />);
  const live = snapshot();
  live.activity = [
    { id: 8, ts: 9000, type: "admin.action", action: "engine.rotate" },
  ];
  view.rerender(<ActivityView snapshot={live} />);
  await act(async () =>
    resolve({
      rows: [
        {
          id: 3,
          ts: 4000,
          eventType: "admin.action",
          action: "settings.update",
        },
      ],
      cursor: null,
    }),
  );
  expect(screen.getByText("engine.rotate")).toBeVisible();
  expect(screen.getByText("settings.update")).toBeVisible();
});

it("orders activity columns and hides latency and size only when both are empty", () => {
  const rows = [
    { id: 1, ts: 1000, eventType: "auth.failed" },
    { id: 2, ts: 2000, eventType: "admin.login" },
  ];
  const view = render(<ActivityTable rows={rows} />);
  expect(
    screen.getAllByRole("columnheader").map((node) => node.textContent),
  ).toEqual(["Time", "Client", "Method", "Result", "Target", "Device"]);
  view.rerender(
    <ActivityTable
      rows={[
        ...rows,
        { id: 3, ts: 3000, eventType: "rpc.finished", latencyMs: 0 },
      ]}
    />,
  );
  expect(
    screen
      .getAllByRole("columnheader")
      .slice(-2)
      .map((node) => node.textContent),
  ).toEqual(["Latency", "Size"]);
});

it("collapses adjacent same-path auth failures, sums counts and retains the latest time", async () => {
  const { collapseAuthFailures } = await import("./Activity");
  const rows = Array.from({ length: 12 }, (_, id) => ({
    id,
    ts: 1000 + id,
    eventType: "auth.failed",
    path: "/unknown",
  }));
  const groups = collapseAuthFailures(rows);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ count: 12, ts: 1011 });
  expect(
    collapseAuthFailures([{ ...rows[0], count: 3 }, rows[1]])[0].count,
  ).toBe(4);
  expect(
    collapseAuthFailures([
      ...rows,
      { id: 20, ts: 2000, eventType: "admin.login" },
      ...rows,
    ]).filter((group) => group.auth),
  ).toHaveLength(2);
  expect(
    collapseAuthFailures([rows[0], { ...rows[1], path: "/other" }]),
  ).toHaveLength(2);
  render(<ActivityTable rows={rows} collapse />);
  const toggle = screen.getByRole("button", {
    name: /Auth failed ≥12 · \/unknown/,
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByRole("row")).toHaveLength(2);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByText("Unauthenticated request")).toHaveLength(12);
});

it("restores the unauthenticated filter in queries and exports and removes it when unchecked", async () => {
  history.replaceState(null, "", "/console/activity?excludeAuthFailed=1");
  const data = snapshot();
  data.activity = [{ id: 1, ts: 1000, type: "auth.failed" }];
  const view = render(<ActivityView snapshot={data} />);
  const toggle = screen.getByRole("checkbox", {
    name: "Hide unauthenticated requests",
  });
  expect(toggle).toBeChecked();
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith("activity?excludeAuthFailed=1"),
  );
  expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
    "href",
    expect.stringContaining("excludeAuthFailed=1"),
  );
  view.rerender(
    <ActivityView
      snapshot={{
        ...data,
        activity: [{ id: 2, ts: 2000, type: "auth.failed" }],
      }}
    />,
  );
  expect(screen.queryByText("Unauthenticated request")).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(location.search).toBe("");
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("activity?"));
});
