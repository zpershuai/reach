import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { ActivityView } from "./Activity";
import { snapshot } from "./test-fixture";
vi.mock("./api", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue({ rows: [], cursor: null });
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
