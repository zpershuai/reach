import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { SettingsView } from "./Views";
import { App } from "./App";
import { snapshot } from "./test-fixture";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
vi.mock("./store", async () => {
  const { snapshot } = await import("./test-fixture");
  return {
    useConsole: () => ({ snapshot: snapshot(), recent: [], connected: true }),
    consoleStore: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    },
  };
});
beforeEach(() => {
  vi.mocked(api).mockReset();
  history.replaceState(null, "", "/console/settings");
});
it("previews a theme immediately and rolls back a failed PATCH without reauth", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const sensitive = vi.fn();
  render(<SettingsView snapshot={snapshot()} sensitive={sensitive} />);
  fireEvent.change(screen.getByLabelText("Theme"), {
    target: { value: "dark" },
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(api).toHaveBeenCalledWith("settings", { theme: "dark" }, "PATCH");
  expect(sensitive).not.toHaveBeenCalled();
  await act(async () => reject(new Error("Theme failed")));
  expect(document.documentElement.dataset.theme).toBe("system");
  expect(screen.getByLabelText("Theme")).toHaveValue("system");
  expect(screen.getByRole("alert")).toHaveTextContent("Theme failed");
});
it("saves only heartbeatDisplay without sensitive authentication", async () => {
  vi.mocked(api).mockResolvedValue({});
  const sensitive = vi.fn();
  render(<SettingsView snapshot={snapshot()} sensitive={sensitive} />);
  fireEvent.click(screen.getByLabelText("Show heartbeats in the topology"));
  fireEvent.click(screen.getByText("Save settings"));
  await screen.findByText("Settings saved");
  expect(api).toHaveBeenCalledWith(
    "settings",
    { heartbeatDisplay: false },
    "PATCH",
  );
  expect(sensitive).not.toHaveBeenCalled();
});
it("asks for reauthentication when a changed retention field requires it", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "me") return { authenticated: true } as never;
    throw new ApiError("Confirm password", 403, "REAUTH_REQUIRED");
  });
  render(<App />);
  const field = await screen.findByLabelText("Keep activity for (days)");
  fireEvent.change(field, { target: { value: "60" } });
  fireEvent.click(screen.getByText("Save settings"));
  await waitFor(() =>
    expect(
      screen.getByRole("dialog", { name: "Confirm it’s you" }),
    ).toBeVisible(),
  );
  expect(api).toHaveBeenCalledWith("settings", { retentionDays: 60 }, "PATCH");
});

it("cycles the header theme using theme-only PATCHes without reauthentication", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "me" ? { authenticated: true } : {},
  );
  render(<App />);
  for (const theme of ["light", "dark", "system"]) {
    const button = await screen.findByRole("button", {
      name: new RegExp(`Switch to ${theme}`, "i"),
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("settings", { theme }, "PATCH"),
    );
  }
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === "settings")
      .map(([, body]) => Object.keys(body as object)),
  ).toEqual([["theme"], ["theme"], ["theme"]]);
});
