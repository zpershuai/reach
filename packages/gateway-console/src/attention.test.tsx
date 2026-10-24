import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttentionPanel } from "./Attention";
import { api } from "./api";
import { snapshot } from "./test-fixture";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue({ clients: [] });
});
function healthySnapshot() {
  const data = snapshot();
  data.clients[0].errors24h = 0;
  return data;
}
it("lists offline devices with their age and detail link", async () => {
  const data = healthySnapshot();
  data.engines[0].session.status = "none";
  data.engines[0].lastSeenAt = Date.now() - 6000;
  data.gateway.heartbeatInterval = 1;
  render(<AttentionPanel snapshot={data} />);
  expect(
    screen.getByRole("link", { name: "Example device · Offline" }),
  ).toHaveAttribute("href", "/console/devices/engine-a");
  expect(screen.getByText("6 s ago")).toBeVisible();
  await screen.findByText("Gateway auto-update");
});
it("flags only versions older than an unambiguous mode", async () => {
  const data = healthySnapshot();
  data.engines = ["2.0", "2.0", "1.0", "3.0"].map((version, index) => ({
    ...data.engines[0],
    id: `engine-${index}`,
    displayName: `Device ${index}`,
    engineVersion: version,
  }));
  render(<AttentionPanel snapshot={data} />);
  expect(
    screen.getByRole("link", { name: "Device 2 · Older version (v1.0)" }),
  ).toHaveAttribute("href", "/console/devices/engine-2");
  expect(
    screen.queryByText("Device 3 · Older version (v3.0)"),
  ).not.toBeInTheDocument();
  await screen.findByText("Gateway auto-update");
});
it("does not flag tied versions", async () => {
  const data = healthySnapshot();
  data.engines = [
    data.engines[0],
    { ...data.engines[0], id: "engine-b", engineVersion: "2.0" },
  ];
  render(<AttentionPanel snapshot={data} />);
  expect(await screen.findByText("Everything is healthy")).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("links pending global identities and failures to their handling views", async () => {
  vi.mocked(api).mockResolvedValue({
    clients: [
      {
        id: "pending",
        name: "ChatGPT",
        legacyGlobal: true,
        reviewRequired: true,
        revokedAt: null,
      },
      {
        id: "revoked",
        name: "Revoked",
        legacyGlobal: true,
        reviewRequired: true,
        revokedAt: 1000,
      },
    ],
  });
  render(<AttentionPanel snapshot={snapshot()} />);
  expect(
    await screen.findByRole("link", { name: "ChatGPT · Review global access" }),
  ).toHaveAttribute("href", "/console/clients");
  expect(screen.queryByText(/Revoked/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", {
      name: "1 failed or denied requests in 24 hours",
    }),
  ).toHaveAttribute(
    "href",
    "/console/activity?outcome=not_ok&excludeAuthFailed=1",
  );
});
it("keeps other attention items when access identities fail", async () => {
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  render(<AttentionPanel snapshot={snapshot()} />);
  expect(
    await screen.findByText("Unable to load access identities"),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: /failed or denied/ })).toBeVisible();
  expect(screen.queryByText("Everything is healthy")).not.toBeInTheDocument();
});
it("states all healthy with Gateway/MCP versions and auto-update status and reloads identities only after access changes", async () => {
  const data = healthySnapshot();
  data.gateway.version = "1.2";
  data.gateway.mcpVersion = "2.3";
  const view = render(<AttentionPanel snapshot={data} />);
  expect(await screen.findByText("Everything is healthy")).toBeVisible();
  expect(screen.getByText("v1.2 / v2.3")).toBeVisible();
  expect(screen.getByText("Gateway auto-update")).toBeVisible();
  expect(api).toHaveBeenCalledTimes(1);
  view.rerender(<AttentionPanel snapshot={{ ...data, ts: data.ts + 5000 }} />);
  view.rerender(
    <AttentionPanel
      snapshot={{
        ...data,
        ts: data.ts + 10000,
        activity: [{ id: 7, ts: data.ts, eventType: "rpc.finished" }],
      }}
    />,
  );
  expect(api).toHaveBeenCalledTimes(1);
  view.rerender(
    <AttentionPanel
      snapshot={{
        ...data,
        ts: data.ts + 15000,
        activity: [
          {
            id: 8,
            ts: data.ts,
            eventType: "admin.action",
            action: "client.review-global",
          },
        ],
      }}
    />,
  );
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
});
it("navigates within the console instead of reloading the page", async () => {
  history.replaceState(null, "", "/console/overview");
  const data = healthySnapshot();
  data.engines[0].session.status = "none";
  data.engines[0].lastSeenAt = Date.now() - 6000;
  data.gateway.heartbeatInterval = 1;
  render(<AttentionPanel snapshot={data} />);
  const link = screen.getByRole("link", { name: "Example device · Offline" });
  // fireEvent returns false when the handler cancelled the browser navigation.
  expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
  expect(location.pathname).toBe("/console/overview");
  expect(fireEvent.click(link)).toBe(false);
  expect(location.pathname).toBe("/console/devices/engine-a");
  await screen.findByText("Gateway auto-update");
});
