import { useT, i18n } from "./i18n";
import { useEffect, useId, useState } from "react";
import { useNow } from "./clock";
import { api, errorText } from "./api";
import type { SensitiveAction } from "./Devices";
import type { Activity, Engine } from "./types";
import { CopyButton, Modal, formatAgo } from "./ui";

const operationKeys = {
  read: "clients.read",
  write: "clients.write",
  execute: "clients.execute",
} as const;
const editKeys = {
  policy: "clients.policy",
  rotate: "clients.rotateAction",
  revoke: "clients.revokeAction",
  review: "clients.reviewAction",
} as const;

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
  approvedAt: number;
  lastUsedAt: number | null;
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
  if (client.revokedAt !== null) return i18n.t("clients.revoked");
  if (client.expiresAt !== null)
    return i18n.t("clients.expires", {
      date: new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(client.expiresAt),
    });
  return i18n.t("clients.oauthLifecycle");
}

// Access identities change only through client and OAuth admin actions, so the
// newest such action id tells views when to reload them.
export function accessRevision(activity: Activity[]): number {
  return (
    activity.find(
      (row) =>
        row.action?.startsWith("client.") || row.action?.startsWith("oauth."),
    )?.id ?? 0
  );
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
  const { t, lang } = useT();
  const now = useNow();
  const suggestionsId = useId();
  const [clients, setClients] = useState<AccessClient[]>([]);
  const [error, setError] = useState<unknown>();
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
    } catch (error) {
      setError(error);
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
        <h2>{t("clients.title")}</h2>
        <button className="btn" onClick={() => start({ kind: "create" })}>
          {t("clients.create")}
        </button>
      </div>
      <div className="note">{t("clients.identityNote")}</div>
      {Boolean(error) && (
        <div className="notice err" role="alert">
          {errorText(error, t)}
          <button className="btn" onClick={() => void load()}>
            {t("clients.retry")}
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("clients.identity")}</th>
              <th>{t("clients.access")}</th>
              <th>{t("clients.credential")}</th>
              <th>{t("clients.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id}>
                <td>
                  <strong>{client.name}</strong>
                  <small>
                    {client.kind === "oauth" ? "OAuth" : t("clients.delegated")}
                  </small>
                  <div className="identity-id">
                    <code title={client.id}>{client.id.slice(0, 8)}…</code>
                    <CopyButton value={client.id} />
                  </div>
                  <small>
                    {t("overview.approved")}:{" "}
                    {formatAgo(client.approvedAt ?? null, now, lang)}
                  </small>
                  <small>
                    {t("overview.lastUsed")}:{" "}
                    {client.lastUsedAt != null
                      ? formatAgo(client.lastUsedAt, now, lang)
                      : t("clients.usageUnavailable")}
                  </small>
                </td>
                <td>
                  {client.legacyGlobal ? (
                    <span className="pill warn">
                      {t("clients.global")}{" "}
                      {client.reviewRequired
                        ? t("clients.reviewRequired")
                        : t("clients.reviewed")}
                    </span>
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
                          .map((operation) =>
                            t(
                              operationKeys[
                                operation as keyof typeof operationKeys
                              ],
                            ),
                          )
                          .join(", ") || t("clients.noOperations")}
                      </div>
                    ))
                  )}
                  {!client.legacyGlobal &&
                    !client.permissions.length &&
                    t("clients.noAccess")}
                </td>
                <td>{credentialStatus(client)}</td>
                <td>
                  {client.revokedAt === null && (
                    <>
                      <button
                        className="btn small"
                        onClick={() => start({ kind: "policy", client })}
                      >
                        {t("clients.edit")}
                      </button>
                      {client.kind === "delegated" && (
                        <button
                          className="btn small"
                          onClick={() => start({ kind: "rotate", client })}
                        >
                          {t("clients.rotate")}
                        </button>
                      )}
                      {client.legacyGlobal && client.reviewRequired && (
                        <button
                          className="btn small"
                          onClick={() => start({ kind: "review", client })}
                        >
                          {t("clients.review")}
                        </button>
                      )}
                      <button
                        className="btn small danger-outline"
                        onClick={() => start({ kind: "revoke", client })}
                      >
                        {t("clients.revoke")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!clients.length && !error && (
          <div className="empty">{t("clients.empty")}</div>
        )}
      </div>
      {edit && (
        <Modal
          title={
            edit.kind === "create"
              ? t("clients.create")
              : `${edit.client.name} · ${t(editKeys[edit.kind])}`
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
                  {t("clients.name")}
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
                  {t("clients.expiry")}
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
                  <p>{t("clients.permissionsNote")}</p>
                  {edit.kind === "policy" && edit.client.legacyGlobal && (
                    <p>{t("clients.replaceGlobal")}</p>
                  )}
                  {permissions.map((permission, index) => (
                    <fieldset key={index}>
                      <legend>
                        {t("clients.resource", { count: index + 1 })}
                      </legend>
                      <label>
                        Engine
                        <select
                          required
                          value={permission.engineId}
                          onChange={(event) =>
                            update(index, { engineId: event.target.value })
                          }
                        >
                          <option value="">{t("clients.selectEngine")}</option>
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
                        {t("clients.workspace")}
                        <input
                          required
                          list={`${suggestionsId}-${index}`}
                          value={permission.workspace}
                          onChange={(event) =>
                            update(index, { workspace: event.target.value })
                          }
                        />
                      </label>
                      <datalist id={`${suggestionsId}-${index}`}>
                        {engines
                          .find((engine) => engine.id === permission.engineId)
                          ?.session.workspaces?.map((workspace) => (
                            <option key={workspace} value={workspace} />
                          ))}
                      </datalist>
                      <div className="permission-operations">
                        {(["read", "write", "execute"] as const).map(
                          (operation) => (
                            <label className="checkbox" key={operation}>
                              <input
                                type="checkbox"
                                checked={permission[operation]}
                                onChange={(event) =>
                                  update(index, {
                                    [operation]: event.target.checked,
                                  })
                                }
                              />
                              {t(operationKeys[operation])}
                            </label>
                          ),
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() =>
                          setPermissions((rows) =>
                            rows.filter((_, i) => i !== index),
                          )
                        }
                      >
                        {t("clients.removeResource", { count: index + 1 })}
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
                    {t("clients.addResource")}
                  </button>
                </>
              )}
              {edit.kind === "rotate" && <p>{t("clients.rotateNote")}</p>}
              {edit.kind === "revoke" && <p>{t("clients.revokeNote")}</p>}
              {edit.kind === "review" && <p>{t("clients.reviewNote")}</p>}
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEdit(undefined)}
                >
                  {t("clients.cancel")}
                </button>
                <button
                  className={`btn ${edit.kind === "revoke" ? "danger" : "primary"}`}
                  type="submit"
                >
                  {edit.kind === "create"
                    ? t("clients.createClient")
                    : t("clients.confirmChange")}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {token && (
        <Modal title={t("clients.saveCredential")}>
          <div className="panel-body">
            <p>{t("clients.oneTimeNote")}</p>
            <label>
              {t("clients.oneTimeToken")}
              <textarea readOnly value={token} />
            </label>
            <CopyButton value={token} label={t("clients.copyToken")} />
            <button className="btn primary" onClick={() => setToken("")}>
              {t("clients.savedCredential")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
