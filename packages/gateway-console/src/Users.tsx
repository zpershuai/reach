import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "./api";
import { useNow } from "./clock";
import type { SensitiveAction } from "./Devices";
import { useT } from "./i18n";
import { useSession } from "./session";
import { Modal, formatAgo } from "./ui";

export interface ConsoleAccount {
  id: number;
  username: string;
  role: "admin" | "user";
  totpEnabled: boolean;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

type Dialog =
  | { kind: "create" }
  | { kind: "password"; user: ConsoleAccount }
  | { kind: "delete"; user: ConsoleAccount };

function CreateUser({ onSubmit, onCancel }: { onSubmit: (body: { username: string; password: string; role: string }) => Promise<void>; onCancel: () => void }) {
  const { t } = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [error, setError] = useState<unknown>();
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      await onSubmit({ username: username.trim(), password, role });
    } catch (error) {
      setError(error);
    }
  }
  return (
    <Modal title={t("users.create")} onCancel={onCancel}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          {t("users.username")}
          <input value={username} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64}
            pattern="[A-Za-z0-9._\-]{3,64}" onChange={(event) => setUsername(event.target.value)} required />
        </label>
        <p className="muted">{t("users.usernameNote")}</p>
        <label>
          {t("users.initialPassword")}
          <input type="password" autoComplete="new-password" value={password} minLength={12} maxLength={1024}
            onChange={(event) => setPassword(event.target.value)} required />
        </label>
        <label>
          {t("users.role")}
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="user">{t("users.roleUser")}</option>
            <option value="admin">{t("users.roleAdmin")}</option>
          </select>
        </label>
        <p className="muted">{t(role === "admin" ? "users.roleAdminNote" : "users.roleUserNote")}</p>
        {Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>{t("auth.cancel")}</button>
          <button className="btn primary">{t("users.createSubmit")}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onSubmit, onCancel }: { user: ConsoleAccount; onSubmit: (password: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      await onSubmit(password);
    } catch (error) {
      setError(error);
    }
  }
  return (
    <Modal title={t("users.resetTitle", { name: user.username })} onCancel={onCancel}>
      <form onSubmit={(event) => void submit(event)}>
        <p className="muted">{t("users.resetNote")}</p>
        <label>
          {t("users.newPassword")}
          <input type="password" autoComplete="new-password" value={password} minLength={12} maxLength={1024}
            onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>{t("auth.cancel")}</button>
          <button className="btn primary">{t("users.resetSubmit")}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Admin-only account management. Every change goes through `sensitive` for re-authentication. */
export function UsersView({ sensitive }: { sensitive: SensitiveAction }) {
  const { t, lang } = useT();
  const { user: me } = useSession();
  const now = useNow();
  const [users, setUsers] = useState<ConsoleAccount[]>();
  const [dialog, setDialog] = useState<Dialog>();
  const [error, setError] = useState<unknown>();
  const load = () =>
    api<{ users: ConsoleAccount[] }>("users")
      .then((data) => setUsers(data.users))
      .catch((error) => setError(error));
  useEffect(() => {
    void load();
  }, []);
  /** Runs a change, keeping LAST_ADMIN and validation errors next to the table. */
  const change = (operation: () => Promise<void>) =>
    void sensitive(async () => {
      setError("");
      try {
        await operation();
        await load();
      } catch (error) {
        if ((error as { code?: string }).code === "REAUTH_REQUIRED") throw error;
        setError(error);
      }
    });
  /** Dialog submissions surface their own errors and close on success. */
  const submit = (operation: () => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      void sensitive(async () => {
        try {
          await operation();
          setDialog(undefined);
          await load();
          resolve();
        } catch (error) {
          if ((error as { code?: string }).code === "REAUTH_REQUIRED") throw error;
          reject(error);
        }
      });
    });
  const path = (user: ConsoleAccount) => `users/${user.id}`;
  return (
    <section className="panel users-view">
      <div className="panel-head">
        <h2>{t("users.title")}</h2>
        <button className="btn small primary" onClick={() => setDialog({ kind: "create" })}>{t("users.create")}</button>
      </div>
      <p className="panel-body muted">{t("users.intro")}</p>
      {Boolean(error) && <div className="notice err" role="alert">{errorText(error, t)}</div>}
      {!users ? (
        <div className="empty">{t("nav.loading")}</div>
      ) : (
        <div className="table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>{t("users.username")}</th>
                <th>{t("users.role")}</th>
                <th>{t("users.authenticator")}</th>
                <th>{t("users.status")}</th>
                <th>{t("users.created")}</th>
                <th>{t("users.lastSignIn")}</th>
                <th>{t("users.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.disabled ? "muted-row" : undefined}>
                  <td>
                    <b>{user.username}</b>
                    {user.id === me?.id && <span className="pill">{t("users.you")}</span>}
                  </td>
                  <td>{t(user.role === "admin" ? "users.roleAdmin" : "users.roleUser")}</td>
                  <td>
                    <span className={`pill ${user.totpEnabled ? "ok" : user.role === "admin" ? "warn" : ""}`}>
                      {user.totpEnabled ? t("account.on") : t("account.off")}
                    </span>
                  </td>
                  <td>{user.disabled ? t("users.disabled") : t("users.enabled")}</td>
                  <td>{formatAgo(user.createdAt, now, lang)}</td>
                  <td>{user.lastLoginAt ? formatAgo(user.lastLoginAt, now, lang) : t("users.never")}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => change(async () => { await api(path(user), { role: user.role === "admin" ? "user" : "admin" }, "PATCH"); })}>
                      {user.role === "admin" ? t("users.makeUser") : t("users.makeAdmin")}
                    </button>
                    <button className="btn small" onClick={() => change(async () => { await api(path(user), { disabled: !user.disabled }, "PATCH"); })}>
                      {user.disabled ? t("users.enable") : t("users.disable")}
                    </button>
                    <button className="btn small" onClick={() => setDialog({ kind: "password", user })}>{t("users.resetPassword")}</button>
                    {user.totpEnabled && (
                      <button className="btn small" onClick={() => change(async () => { await api(`${path(user)}/totp`, undefined, "DELETE"); })}>
                        {t("users.removeTotp")}
                      </button>
                    )}
                    <button className="btn small danger-outline" onClick={() => setDialog({ kind: "delete", user })}>{t("users.delete")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog?.kind === "create" && (
        <CreateUser onCancel={() => setDialog(undefined)} onSubmit={(body) => submit(async () => { await api("users", body); })} />
      )}
      {dialog?.kind === "password" && (
        <ResetPassword user={dialog.user} onCancel={() => setDialog(undefined)}
          onSubmit={(password) => submit(async () => { await api(`${path(dialog.user)}/password`, { password }); })} />
      )}
      {dialog?.kind === "delete" && (
        <Modal title={t("users.deleteTitle", { name: dialog.user.username })} onCancel={() => setDialog(undefined)}>
          <p>{t("users.deleteNote")}</p>
          <div className="actions">
            <button className="btn" onClick={() => setDialog(undefined)}>{t("auth.cancel")}</button>
            <button className="btn danger" onClick={() => { const target = dialog.user; setDialog(undefined); change(async () => { await api(path(target), undefined, "DELETE"); }); }}>
              {t("users.delete")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
