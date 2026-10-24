import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessClients, type AccessClient } from "./AccessClients";
import { ApiError, api } from "./api";
import { engine } from "./test-fixture";
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
const sensitive = async (operation: () => Promise<void>) => operation();
const client: AccessClient = {
  id: "client:fixture",
  name: "Daily client",
  kind: "delegated",
  revokedAt: null,
  expiresAt: Date.now() + 86_400_000,
  policyRevision: 1,
  legacyGlobal: false,
  reviewRequired: false,
  permissions: [
    {
      engineId: engine.id,
      workspace: "docs",
      read: true,
      write: false,
      execute: false,
    },
  ],
};

it("creates a least-privilege credential displayed once without writing browser storage", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const token = "fixture-one-time-client-token";
  vi.mocked(api)
    .mockResolvedValueOnce({ clients: [] })
    .mockResolvedValueOnce({ client, token })
    .mockResolvedValue({ clients: [client] });
  const user = userEvent.setup();
  const view = render(
    <AccessClients engines={[engine]} sensitive={sensitive} />,
  );
  await screen.findByText("No delegated or OAuth identities yet.");
  await user.click(
    screen.getByRole("button", { name: "Create delegated client" }),
  );
  await user.type(screen.getByLabelText("Client name"), "Daily client");
  await user.click(screen.getByRole("button", { name: "Add resource" }));
  for (const operation of ["read", "write", "execute"])
    expect(screen.getByRole("checkbox", { name: operation })).not.toBeChecked();
  await user.selectOptions(screen.getByLabelText("Engine"), engine.id);
  await user.type(screen.getByLabelText("Workspace"), "docs");
  await user.click(screen.getByRole("checkbox", { name: "read" }));
  await user.click(screen.getByRole("button", { name: "Create client" }));
  expect(await screen.findByLabelText("One-time client token")).toHaveValue(
    token,
  );
  expect(api).toHaveBeenCalledWith("access-clients", {
    name: "Daily client",
    expiresAt: expect.any(Number),
    permissions: client.permissions,
  });
  await user.click(
    screen.getByRole("button", { name: "I saved the credential" }),
  );
  expect(
    screen.queryByLabelText("One-time client token"),
  ).not.toBeInTheDocument();
  view.rerender(
    <AccessClients engines={[engine]} sensitive={sensitive} revision={1} />,
  );
  expect(screen.queryByDisplayValue(token)).not.toBeInTheDocument();
  expect(storage).not.toHaveBeenCalled();
});

it("edits policy and rotates/revokes only after explicit confirmation", async () => {
  vi.mocked(api).mockImplementation(async (path, _body, method) => {
    if (path === "access-clients") return { clients: [client] };
    if (path.endsWith("/rotate"))
      return { token: "rotated-fixture-token", client };
    return method === "DELETE" ? { revoked: client.id } : { client };
  });
  const user = userEvent.setup();
  render(<AccessClients engines={[engine]} sensitive={sensitive} />);
  await user.click(
    await screen.findByRole("button", { name: "Edit permissions" }),
  );
  await user.click(screen.getByRole("checkbox", { name: "write" }));
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(api).toHaveBeenCalledWith(
    "access-clients/client%3Afixture/policy",
    { permissions: [{ ...client.permissions[0], write: true }] },
    "PATCH",
  );
  await user.click(screen.getByRole("button", { name: "Rotate credential" }));
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(await screen.findByLabelText("One-time client token")).toHaveValue(
    "rotated-fixture-token",
  );
  await user.click(
    screen.getByRole("button", { name: "I saved the credential" }),
  );
  await user.click(screen.getByRole("button", { name: "Revoke identity" }));
  expect(api).not.toHaveBeenCalledWith(
    "access-clients/client%3Afixture",
    undefined,
    "DELETE",
  );
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(api).toHaveBeenCalledWith(
    "access-clients/client%3Afixture",
    undefined,
    "DELETE",
  );
});

it("shows unreviewed global authority and requires an explicit Owner-equivalent acknowledgement", async () => {
  const legacy = {
    ...client,
    id: "oauth:fixture",
    kind: "oauth",
    legacyGlobal: true,
    reviewRequired: true,
    permissions: [],
    expiresAt: null,
  };
  vi.mocked(api).mockResolvedValue({ clients: [legacy] });
  const user = userEvent.setup();
  render(<AccessClients engines={[engine]} sensitive={sensitive} />);
  expect(
    await screen.findByText(
      /Global access · Owner equivalent · Review required/,
    ),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Review global access" }),
  );
  expect(
    within(screen.getByRole("dialog")).getByText(/every Engine and workspace/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(api).toHaveBeenCalledWith(
    "access-clients/oauth%3Afixture/review-global",
    { confirm: true },
  );
});

it("preserves the pending action through recent-auth and reveals no credential on rejection", async () => {
  let retry: (() => Promise<void>) | undefined;
  const recover = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiError && error.code === "REAUTH_REQUIRED")
        retry = operation;
      else throw error;
    }
  };
  vi.mocked(api)
    .mockResolvedValueOnce({ clients: [] })
    .mockRejectedValueOnce(
      new ApiError("Reauthentication required", 403, "REAUTH_REQUIRED"),
    );
  const user = userEvent.setup();
  render(<AccessClients engines={[engine]} sensitive={recover} />);
  await screen.findByText("No delegated or OAuth identities yet.");
  await user.click(
    screen.getByRole("button", { name: "Create delegated client" }),
  );
  await user.type(screen.getByLabelText("Client name"), "Daily client");
  await user.click(screen.getByRole("button", { name: "Create client" }));
  expect(retry).toBeDefined();
  expect(
    screen.queryByLabelText("One-time client token"),
  ).not.toBeInTheDocument();
  vi.mocked(api)
    .mockResolvedValueOnce({ client, token: "after-reauth-fixture-token" })
    .mockResolvedValue({ clients: [client] });
  await retry!();
  expect(await screen.findByLabelText("One-time client token")).toHaveValue(
    "after-reauth-fixture-token",
  );
});

it("suggests workspaces from the selected Engine and submits unreported workspace names", async () => {
  const second = {
    ...engine,
    id: "engine-b",
    session: { ...engine.session, workspaces: ["media"] },
  };
  vi.mocked(api).mockResolvedValue({ clients: [client] });
  const user = userEvent.setup();
  render(<AccessClients engines={[engine, second]} sensitive={sensitive} />);
  await user.click(
    await screen.findByRole("button", { name: "Edit permissions" }),
  );
  const input = screen.getByLabelText("Workspace");
  const suggestions = () =>
    [
      ...document
        .getElementById(input.getAttribute("list")!)!
        .querySelectorAll("option"),
    ].map((option) => option.value);
  expect(suggestions()).toEqual(["default", "scripts"]);
  await user.selectOptions(screen.getByLabelText("Engine"), "engine-b");
  expect(suggestions()).toEqual(["media"]);
  await user.clear(input);
  await user.type(input, "backup");
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(api).toHaveBeenCalledWith(
    "access-clients/client%3Afixture/policy",
    {
      permissions: [
        { ...client.permissions[0], engineId: "engine-b", workspace: "backup" },
      ],
    },
    "PATCH",
  );
});
it("shows a styled load error and retries the permissions list", async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ clients: [client] });
  render(<AccessClients engines={[engine]} sensitive={sensitive} />);
  expect(await screen.findByRole("alert")).toHaveClass("notice", "err");
  await userEvent.setup().click(screen.getByText("Retry"));
  expect(await screen.findByText("Daily client")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
