import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "./api";
import { AuthScreen, ReauthDialog } from "./Auth";
import { AddDevice, DeviceDrawer, installCommand } from "./Devices";
import { DeviceGlyph, glyphKinds } from "./Glyph";
import { ClientsView, Overview, SettingsView, SkillsView } from "./Views";
import { ActivityView } from "./Activity";
import { consoleStore } from "./store";
import { engine, snapshot } from "./test-fixture";
vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(), api: vi.fn(),
}));
beforeEach(() => {
  history.replaceState(null, "", "/console/activity");
  vi.spyOn(consoleStore, "refresh").mockResolvedValue();
});
const sensitive = async (operation: () => Promise<void>) => operation();

it("setup bundles a QR, shows recovery codes once and writes no browser storage", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const authenticated = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUrl: "otpauth://totp/Reach?secret=JBSWY3DPEHPK3PXP",
    })
    .mockResolvedValueOnce({ recoveryCodes: ["RECOVERY01", "RECOVERY02"] });
  const user = userEvent.setup();
  render(<AuthScreen setup onAuthenticated={authenticated} />);
  await user.type(screen.getByLabelText("Setup token"), "setup-token");
  await user.click(screen.getByRole("button", { name: "Continue →" }));
  expect(
    await screen.findByAltText("Scan this QR code with your authenticator"),
  ).toHaveAttribute("src", expect.stringContaining("data:image/gif;base64,"));
  await user.type(screen.getByLabelText("Password"), "a long owner password");
  await user.type(screen.getByLabelText("Authenticator code"), "123456");
  await user.click(
    screen.getByRole("button", { name: "Create administrator →" }),
  );
  expect(await screen.findByText("RECOVERY01")).toBeInTheDocument();
  expect(authenticated).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "I saved my recovery codes →" }),
  );
  expect(authenticated).toHaveBeenCalledOnce();
  expect(screen.queryByText("RECOVERY01")).not.toBeInTheDocument();
  expect(storage).not.toHaveBeenCalled();
});

it("sign-in accepts recovery codes and displays generic failures", async () => {
  const user = userEvent.setup();
  vi.mocked(api).mockRejectedValueOnce(new Error("Invalid credentials"));
  render(<AuthScreen setup={false} onAuthenticated={() => {}} />);
  await user.type(screen.getByLabelText("Password"), "owner password");
  await user.type(
    screen.getByLabelText("Authenticator or recovery code"),
    "recovery01",
  );
  await user.click(screen.getByRole("button", { name: "Sign in →" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid credentials",
  );
  expect(api).toHaveBeenCalledWith("login", {
    password: "owner password",
    code: "RECOVERY01",
  });
});

it("reauthentication prompts for a password and submits it in memory", async () => {
  const confirm = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<ReauthDialog onConfirm={confirm} onCancel={() => {}} />);
  await user.type(screen.getByLabelText("Password"), "owner password");
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  expect(confirm).toHaveBeenCalledWith("owner password");
});

it("device enrollment shows a one-time token then observes the first heartbeat", async () => {
  vi.mocked(api).mockResolvedValue({ token: "one-time-test-token" });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  const data = snapshot();
  data.engines = [];
  const rendered = render(
    <AddDevice snapshot={data} sensitive={sensitive} onClose={() => {}} />,
  );
  await user.type(screen.getByLabelText("Device name"), "New device");
  expect(screen.getByLabelText("Device ID")).toHaveValue("new-device");
  await user.click(screen.getByRole("button", { name: "Choose platform →" }));
  await user.click(screen.getByRole("button", { name: "OpenWrt" }));
  await user.click(screen.getByRole("button", { name: "Register device →" }));
  expect(await screen.findByLabelText("One-time Engine token")).toHaveValue(
    "one-time-test-token",
  );
  expect(
    screen.getByText(/sh scripts\/install-engine-openwrt/),
  ).toHaveTextContent("https://gateway.example.com");
  await user.click(
    screen.getByRole("button", { name: "I’ve started the Engine →" }),
  );
  expect(
    screen.getByText("Waiting for the first heartbeat"),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("One-time Engine token"),
  ).not.toBeInTheDocument();
  data.engines = [{ ...engine, id: "new-device" }];
  rendered.rerender(
    <AddDevice snapshot={data} sensitive={sensitive} onClose={() => {}} />,
  );
  expect(screen.getByText("Device connected")).toBeInTheDocument();
  expect(storage).not.toHaveBeenCalled();
});

it.each([["scripts"], [], undefined])(
  "device details distinguish reported execution settings: %j",
  (processWorkspaces) => {
    render(
      <DeviceDrawer
        engine={{
          ...engine,
          session: { ...engine.session, processWorkspaces },
        }}
        activity={[]}
        heartbeatInterval={5}
        sensitive={sensitive}
        onClose={() => {}}
      />,
    );
    const row = screen.getByText("scripts").closest("li")!;
    expect(
      within(row).getByText(
        `Execution ${processWorkspaces === undefined ? "not reported" : processWorkspaces.length ? "enabled" : "disabled"}`,
      ),
    ).toBeInTheDocument();
  },
);

it("glyph tint follows heartbeat freshness and preserves open-session readiness", () => {
  const view = render(<DeviceGlyph engine={engine} />);
  const glyph = () => view.container.querySelector(".dev-icon")!;
  expect(glyph()).toHaveClass("s-ready");
  expect(glyph().querySelector(".ind")).toBeInTheDocument();
  view.rerender(
    <DeviceGlyph
      engine={{
        ...engine,
        lastSeenAt: Date.now(),
        session: { ...engine.session, status: "pending" },
      }}
    />,
  );
  expect(glyph()).toHaveClass("s-connecting");
  view.rerender(
    <DeviceGlyph
      engine={{ ...engine, online: false, session: { status: "none" } }}
    />,
  );
  expect(glyph()).toHaveClass("s-offline");
  expect(screen.getByRole("img")).toHaveAccessibleName("mac-mini, offline");
});

it("Overview includes health warnings, versions and KPIs; Skills stays reserved", () => {
  const data = snapshot();
  data.gateway.warnings = ["Audit storage failure: /tmp/reach-data"];
  const view = render(<Overview snapshot={data} />);
  expect(screen.getByRole("status")).toHaveTextContent("/tmp/reach-data");
  expect(screen.getByText("Clients")).toBeInTheDocument();
  expect(screen.getByText("Gateway auto-update")).toBeInTheDocument();
  view.unmount();
  render(<SkillsView />);
  expect(screen.getByText("Planned")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("Clients disconnect through the label route after an explicit action", async () => {
  vi.mocked(api).mockResolvedValue({});
  const user = userEvent.setup();
  render(<ClientsView snapshot={snapshot()} sensitive={sensitive} />);
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  await user.click(screen.getByRole("button", { name: "Disconnect client" }));
  expect(api).toHaveBeenCalledWith("clients/Test%20client%201/disconnect", {});
});

it("Settings saves theme immediately with only the theme field", async () => {
  vi.mocked(api).mockResolvedValue({});
  const user = userEvent.setup();
  render(<SettingsView snapshot={snapshot()} sensitive={sensitive} />);
  await user.selectOptions(screen.getByLabelText("Theme"), "dark");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(api).toHaveBeenCalledWith("settings", { theme: "dark" }, "PATCH");
  expect(await screen.findByRole("status")).toHaveTextContent("Settings saved");
});

it("Activity applies API filters and uses the same filters for export links", async () => {
  vi.mocked(api).mockResolvedValue({ rows: [], cursor: null });
  const user = userEvent.setup();
  render(<ActivityView snapshot={snapshot()} />);
  await user.selectOptions(screen.getByLabelText("Filter device"), "engine-a");
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith("activity?engineId=engine-a"),
  );
  expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
    "href",
    "/api/console/activity/export?engineId=engine-a&format=csv",
  );
});

it("all platform commands carry the configured origin and private Engine configuration", () => {
  for (const platform of ["Linux", "macOS", "OpenWrt", "Docker"]) {
    const command = installCommand(
      platform,
      "https://gateway.example.com",
      "engine-a",
      "token",
    );
    expect(command).toContain(
      "REACH_GATEWAY_URL='https://gateway.example.com'",
    );
    expect(command).toContain("REACH_ENGINE_ID='engine-a'");
    expect(command).toContain("umask 077");
    if (platform === "Docker") {
      expect(command).toContain("set -a\n. ./engine.env\nset +a");
      expect(command).toContain(
        "-e REACH_GATEWAY_URL -e REACH_ENGINE_ID -e REACH_ENGINE_TOKEN",
      );
      expect(command).not.toContain("--env-file");
    }
  }
});

it("Activity receives matching live rows while preserving its active filters", async () => {
  vi.mocked(api).mockResolvedValue({ rows: [], cursor: null });
  const data = snapshot();
  const view = render(<ActivityView snapshot={data} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith("activity?"));
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("Filter device"), "engine-a");
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith("activity?engineId=engine-a"),
  );
  const updated = snapshot();
  updated.activity = [
    {
      id: 1,
      ts: 2000,
      type: "rpc.finished",
      engineId: "engine-a",
      requestId: "a",
      method: "fs.read",
      outcome: "ok",
    },
    {
      id: 2,
      ts: 2000,
      type: "rpc.finished",
      engineId: "another-engine",
      requestId: "b",
      method: "fs.write",
      outcome: "ok",
    },
  ];
  view.rerender(<ActivityView snapshot={updated} />);
  expect(await screen.findByText("fs.read")).toBeVisible();
  expect(screen.queryByText("fs.write")).not.toBeInTheDocument();
});

it("draws a distinct silhouette with a status LED for every device kind", () => {
  const drawings = new Set<string>();
  for (const kind of glyphKinds) {
    const view = render(
      <DeviceGlyph
        engine={{ ...engine, hardware: { ...engine.hardware!, kind } }}
      />,
    );
    const svg = view.container.querySelector("svg")!;
    expect(svg.querySelectorAll(".ind")).toHaveLength(1);
    drawings.add(svg.innerHTML);
    view.unmount();
  }
  expect(drawings.size).toBe(glyphKinds.length);
});

it("prepends new live activity and keeps paginated rows without duplicates", async () => {
  const first = {
    id: 2,
    ts: 2000,
    type: "rpc.finished" as const,
    requestId: "page-first",
    method: "first",
  };
  const older = {
    ...first,
    id: 1,
    ts: 1000,
    requestId: "page-older",
    method: "older",
  };
  const newest = {
    ...first,
    id: 3,
    ts: 3000,
    requestId: "live",
    method: "newest",
  };
  vi.mocked(api)
    .mockResolvedValueOnce({ rows: [first], cursor: "next" })
    .mockResolvedValueOnce({ rows: [older], cursor: null });
  const data = snapshot();
  data.activity = [];
  const view = render(<ActivityView snapshot={data} />);
  await screen.findByText("first");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Load more" }));
  const oldNode = await screen.findByText("older");
  view.rerender(
    <ActivityView snapshot={{ ...data, activity: [newest, first] }} />,
  );
  expect(
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent),
  ).toEqual([
    expect.stringContaining("newest"),
    expect.stringContaining("first"),
    expect.stringContaining("older"),
  ]);
  expect(screen.getByText("older")).toBe(oldNode);
});
