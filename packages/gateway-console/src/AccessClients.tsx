import { useEffect, useState } from "react";
import { api } from "./api";
import type { SensitiveAction } from "./Devices";
import type { Engine } from "./types";
import { Modal } from "./ui";

interface Permission {
  engineId: string;
  workspace: string;
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface AccessClient {
  id: string;
  kind: "delegated" | "oauth";
  name: string;
  revokedAt: number | null;
  expiresAt: number | null;
  policyRevision: number;
  legacyGlobal: boolean;
  reviewRequired: boolean;
  permissions: Permission[];
}

type Edit =
  | { kind: "create" }
  | { kind: "policy" | "rotate" | "revoke" | "review"; client: AccessClient };

function expiryDefault(): string {
  const date = new Date(Date.now() + 7 * 86_400_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function credentialStatus(client: AccessClient): string {
  if (client.revokedAt !== null) return "Revoked";
  if (client.expiresAt !== null)
    return `Expires ${new Date(client.expiresAt).toLocaleString()}`;
  return "OAuth token lifecycle";
}

export function AccessClients({
  engines,
  sensitive,
  revision = 0,
}: {
  engines: Engine[];
  sensitive: SensitiveAction;
  revision?: number;
}) {
  const [clients, setClients] = useState<AccessClient[]>([]);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Edit>();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState(expiryDefault);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [token, setToken] = useState("");
  const load = async () => {
    try {
      const data = await api<{ clients: AccessClient[] }>("access-clients");
      setClients(data.clients ?? []);
      setError("");
    } catch {
      setError(
        "Client identities could not be loaded. Retry to see current permissions.",
      );
    }
  };
  useEffect(() => {
    void load();
  }, [revision]);
  const start = (value: Edit) => {
    setToken("");
    setEdit(value);
    setName("");
    setExpiresAt(expiryDefault());
    setPermissions(
      value.kind === "policy"
        ? value.client.permissions.map((permission) => ({ ...permission }))
        : [],
    );
  };
  const update = (index: number, patch: Partial<Permission>) =>
    setPermissions((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const submit = () =>
    void sensitive(async () => {
      if (!edit) return;
      let issued = "";
      if (edit.kind === "create") {
        const result = await api<{ token: string }>("access-clients", {
          name,
          expiresAt: new Date(expiresAt).getTime(),
          permissions,
        });
        issued = result.token;
      } else {
        const path = `access-clients/${encodeURIComponent(edit.client.id)}`;
        if (edit.kind === "policy")
          await api(path + "/policy", { permissions }, "PATCH");
        if (edit.kind === "rotate") {
          const result = await api<{ token: string }>(path + "/rotate", {
            expiresAt: new Date(expiresAt).getTime(),
          });
          issued = result.token;
        }
        if (edit.kind === "revoke") await api(path, undefined, "DELETE");
        if (edit.kind === "review")
          await api(path + "/review-global", { confirm: true });
      }
      setEdit(undefined);
      setPermissions([]);
      setName("");
      setToken(issued);
      await load();
    });
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Client identities & permissions</h2>
        <button className="btn" onClick={() => start({ kind: "create" })}>
          Create delegated client
        </button>
      </div>
      <div className="note">
        These identities authenticate API access. Display labels in activity
        remain self-reported. The configured Owner token has global access.
      </div>
      {error && (
        <div role="alert">
          {error}
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Identity</th>
              <th>Access</th>
              <th>Credential</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id}>
                <td>
                  <strong>{client.name}</strong>
                  <small>{client.kind}</small>
                  <code>{client.id}</code>
                </td>
                <td>
                  {client.legacyGlobal ? (
                    <div className="notice warn">
                      Global access · Owner equivalent ·{" "}
                      {client.reviewRequired ? "Review required" : "Reviewed"}
                    </div>
                  ) : (
                    client.permissions.map((permission) => (
                      <div
                        key={JSON.stringify([
                          permission.engineId,
                          permission.workspace,
                        ])}
                      >
                        {permission.engineId}/{permission.workspace} ·{" "}
                        {["read", "write", "execute"]
                          .filter(
                            (operation) =>
                              permission[
                                operation as "read" | "write" | "execute"
                              ],
                          )
                          .join(", ") || "No operations"}
                      </div>
                    ))
                  )}
                  {!client.legacyGlobal &&
                    !client.permissions.length &&
                    "No resource access"}
                </td>
                <td>{credentialStatus(client)}</td>
                <td>
                  {client.revokedAt === null && (
                    <>
                      <button
                        className="btn small"
                        onClick={() => start({ kind: "policy", client })}
                      >
                        Edit permissions
                      </button>
                      {client.kind === "delegated" && (
                        <button
                          className="btn small"
                          onClick={() => start({ kind: "rotate", client })}
                        >
                          Rotate credential
                        </button>
                      )}
                      <button
                        className="btn small danger"
                        onClick={() => start({ kind: "revoke", client })}
                      >
                        Revoke identity
                      </button>
                      {client.legacyGlobal && client.reviewRequired && (
                        <button
                          className="btn small"
                          onClick={() => start({ kind: "review", client })}
                        >
                          Review global access
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!clients.length && !error && (
          <div className="empty">No delegated or OAuth identities yet.</div>
        )}
      </div>
      {edit && (
        <Modal
          title={
            edit.kind === "create"
              ? "Create delegated client"
              : `${edit.client.name} · ${edit.kind}`
          }
          onClose={() => setEdit(undefined)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="panel-body">
              {edit.kind === "create" && (
                <label>
                  Client name
                  <input
                    required
                    maxLength={64}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              {(edit.kind === "create" || edit.kind === "rotate") && (
                <label>
                  Credential expiry
                  <input
                    required
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </label>
              )}
              {(edit.kind === "create" || edit.kind === "policy") && (
                <>
                  <p>
                    No permissions are selected by default. Each operation is
                    independent. Execute runs trusted scripts with the Engine
                    account's system privileges; it is not a sandbox.
                  </p>
                  {edit.kind === "policy" && edit.client.legacyGlobal && (
                    <p>
                      Saving replaces global access with only the resources
                      selected below.
                    </p>
                  )}
                  {permissions.map((permission, index) => (
                    <fieldset key={index}>
                      <legend>Resource {index + 1}</legend>
                      <label>
                        Engine
                        <select
                          required
                          value={permission.engineId}
                          onChange={(event) =>
                            update(index, { engineId: event.target.value })
                          }
                        >
                          <option value="">Select Engine</option>
                          {[
                            ...new Set(
                              [
                                ...engines.map((engine) => engine.id),
                                permission.engineId,
                              ].filter(Boolean),
                            ),
                          ].map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Workspace
                        <input
                          required
                          value={permission.workspace}
                          onChange={(event) =>
                            update(index, { workspace: event.target.value })
                          }
                        />
                      </label>
                      {(["read", "write", "execute"] as const).map(
                        (operation) => (
                          <label key={operation}>
                            <input
                              type="checkbox"
                              checked={permission[operation]}
                              onChange={(event) =>
                                update(index, {
                                  [operation]: event.target.checked,
                                })
                              }
                            />
                            {operation}
                          </label>
                        ),
                      )}
                      <button
                        type="button"
                        className="btn small"
                        onClick={() =>
                          setPermissions((rows) =>
                            rows.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove resource {index + 1}
                      </button>
                    </fieldset>
                  ))}
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setPermissions((rows) => [
                        ...rows,
                        {
                          engineId: "",
                          workspace: "",
                          read: false,
                          write: false,
                          execute: false,
                        },
                      ])
                    }
                  >
                    Add resource
                  </button>
                </>
              )}
              {edit.kind === "rotate" && (
                <p>
                  The old credential stops working immediately. Its grants and
                  owned sessions drain.
                </p>
              )}
              {edit.kind === "revoke" && (
                <p>
                  This identity's credentials stop working immediately. Its
                  grants, sessions and running tasks drain.
                </p>
              )}
              {edit.kind === "review" && (
                <p>
                  This existing OAuth client retains global access equivalent to
                  the Owner. Only confirm if you trust it with every Engine and
                  workspace. Edit permissions to restrict it instead.
                </p>
              )}
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEdit(undefined)}
                >
                  Cancel
                </button>
                <button className="btn primary" type="submit">
                  {edit.kind === "create" ? "Create client" : "Confirm change"}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {token && (
        <Modal title="Save the client credential" onClose={() => setToken("")}>
          <div className="panel-body">
            <p>
              This credential is shown once. Store it privately; it cannot be
              retrieved later.
            </p>
            <label>
              One-time client token
              <textarea readOnly value={token} />
            </label>
            <button className="btn primary" onClick={() => setToken("")}>
              I saved the credential
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
