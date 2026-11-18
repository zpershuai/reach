import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { App } from "./App";
import { DeviceDrawer, DevicesView } from "./Devices";
import { SessionProvider, type SessionUser } from "./session";
import { engine, snapshot } from "./test-fixture";
import { UsersView } from "./Users";
import { ClientsView, SettingsView } from "./Views";

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

const viewer: SessionUser = { id: 2, username: "viewer", role: "user", totpEnabled: false };
const owner: SessionUser = { id: 1, username: "owner", role: "admin", totpEnabled: false };
const sensitive = async (operation: () => Promise<void>) => operation();
const as = (user: SessionUser, children: ReactNode) => <SessionProvider value={user}>{children}</SessionProvider>;
const accounts = [
  { id: 1, username: "owner", role: "admin", totpEnabled: false, disabled: false, createdAt: Date.now() - 3_600_000, lastLoginAt: Date.now() },
  { id: 2, username: "viewer", role: "user", totpEnabled: true, disabled: false, createdAt: Date.now() - 60_000, lastLoginAt: null },
];

beforeEach(() => {
  vi.mocked(api).mockReset();
  localStorage.clear();
  history.replaceState(null, "", "/console/overview");
});

it("read-only users see devices, clients and settings without any mutating control", async () => {
  vi.mocked(api).mockResolvedValue({ clients: [] });
  const data = snapshot();
  data.clients = [{ ...data.clients[0], type: "mcp-http", activeSessions: 2 }];
  const devices = render(as(viewer, <DevicesView snapshot={data} sensitive={sensitive} onAdd={() => {}} />));
  expect(screen.getByText("Example device")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add device" })).not.toBeInTheDocument();
  devices.unmount();
  const drawer = (user: SessionUser) => as(user, <DeviceDrawer engine={{ ...engine, origin: "console" }} activity={[]} heartbeatInterval={5} sensitive={sensitive} onClose={() => {}} />);
  const shown = render(drawer(owner));
  // The same labels exist for admins, so their absence below is meaningful.
  for (const name of ["Rotate Engine token", "Remove device…", "Save"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  shown.unmount();
  render(drawer(viewer));
  for (const name of ["Rotate Engine token", "Remove device…", "Save"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  document.body.innerHTML = "";
  render(as(viewer, <ClientsView snapshot={data} sensitive={sensitive} />));
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(screen.getByText(data.clients[0].label)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create delegated client" })).not.toBeInTheDocument();
  document.body.innerHTML = "";
  render(as(viewer, <SettingsView snapshot={data} sensitive={sensitive} />));
  expect(screen.queryByLabelText("Keep activity for (days)")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
});

it("a read-only user's theme choice stays in this browser and never calls the settings API", async () => {
  const user = userEvent.setup();
  render(as(viewer, <SettingsView snapshot={snapshot()} sensitive={sensitive} />));
  await user.selectOptions(screen.getByLabelText("Theme"), "dark");
  expect(localStorage.getItem("reach.console.theme")).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(api).not.toHaveBeenCalledWith("settings", expect.anything(), "PATCH");
});

it("navigation names the user, marks viewers read-only and hides Users and Add device from them", async () => {
  vi.mocked(api).mockImplementation(async (path: string) =>
    path === "me" ? { authenticated: true, user: viewer, csrfToken: "c" } : { clients: [] });
  history.replaceState(null, "", "/console/users");
  render(<App />);
  expect(await screen.findByText("viewer")).toBeInTheDocument();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  const nav = screen.getByRole("navigation", { name: "Main" });
  expect(within(nav).queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add device" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
});

it("admins see Users in navigation and the Add device action", async () => {
  vi.mocked(api).mockImplementation(async (path: string) =>
    path === "me" ? { authenticated: true, user: owner, csrfToken: "c" } : path === "users" ? { users: accounts } : { clients: [] });
  history.replaceState(null, "", "/console/users");
  render(<App />);
  expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Add device" })).toBeInTheDocument();
});

it("Users creates accounts and keeps LAST_ADMIN beside the table", async () => {
  const user = userEvent.setup();
  vi.mocked(api).mockImplementation(async (path: string, body?: unknown, method?: string) => {
    if (path === "users" && body === undefined) return { users: accounts };
    if (path === "users") return { user: { ...accounts[1], id: 3, username: "ops" } };
    if (path === "users/1" && method === "PATCH") throw new ApiError("At least one enabled administrator is required", 409, "LAST_ADMIN");
    return {};
  });
  render(as(owner, <UsersView sensitive={sensitive} />));
  const row = (await screen.findByText("owner")).closest("tr")!;
  expect(within(row).getByText("you")).toBeInTheDocument();
  await user.click(within(row).getByRole("button", { name: "Disable" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("At least one enabled administrator is required");
  await user.click(screen.getByRole("button", { name: "Add user" }));
  const dialog = screen.getByRole("dialog", { name: "Add user" });
  await user.type(within(dialog).getByLabelText("Username"), "ops");
  await user.type(within(dialog).getByLabelText("Initial password"), "a long ops password");
  await user.selectOptions(within(dialog).getByLabelText("Role"), "user");
  await user.click(within(dialog).getByRole("button", { name: "Create user" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api).toHaveBeenCalledWith("users", { username: "ops", password: "a long ops password", role: "user" });
  const viewerRow = screen.getByText("viewer").closest("tr")!;
  await user.click(within(viewerRow).getByRole("button", { name: "Delete" }));
  await user.click(within(screen.getByRole("dialog", { name: "Delete viewer?" })).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("users/2", undefined, "DELETE"));
});

it("Account settings enrol an authenticator, show recovery codes once and change the password", async () => {
  const user = userEvent.setup();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "account/totp/begin") return { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Reach:viewer?secret=JBSWY3DPEHPK3PXP" };
    if (path === "account/totp/confirm") return { recoveryCodes: ["RECOVERY01", "RECOVERY02"] };
    if (path === "account/password") return { user: viewer };
    return {};
  });
  const identity = vi.fn();
  window.addEventListener("reach:identity", identity);
  render(as(viewer, <SettingsView snapshot={snapshot()} sensitive={sensitive} />));
  await user.click(screen.getByRole("button", { name: "Enable authenticator" }));
  expect(await screen.findByAltText("Scan this QR code with your authenticator")).toHaveAttribute("src", expect.stringContaining("data:image/gif;base64,"));
  await user.type(screen.getByLabelText("Code from the authenticator"), "123456");
  await user.click(screen.getByRole("button", { name: "Confirm and enable" }));
  expect(await screen.findByText("RECOVERY01")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "I saved my recovery codes" }));
  expect(screen.queryByText("RECOVERY01")).not.toBeInTheDocument();
  expect(identity).toHaveBeenCalled();
  await user.type(screen.getByLabelText("Current password"), "a long viewer password");
  await user.type(screen.getByLabelText("New password"), "a newer viewer password");
  await user.type(screen.getByLabelText("Repeat new password"), "a newer viewer password");
  await user.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Password changed")).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith("account/password", { current: "a long viewer password", password: "a newer viewer password" });
  window.removeEventListener("reach:identity", identity);
});
