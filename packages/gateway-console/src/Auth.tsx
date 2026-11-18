import { LanguageToggle } from "./LanguageToggle";
import { useT } from "./i18n";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, errorText } from "./api";
import { BrandVisual } from "./BrandVisual";
import { Modal } from "./ui";

/** Two panels on wide screens: the decorative brand story left, the form right. */
export function AuthLayout({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  const { t } = useT();
  return (
    <main className="auth-page">
      <aside className="auth-brand">
        <span className="brand">
          <b>Reach</b>
          <span>Gateway</span>
        </span>
        <BrandVisual />
        <div className="auth-story">
          <h2>{t("brand.tagline")}</h2>
          <p>{t("brand.lead")}</p>
        </div>
      </aside>
      <section className="auth-side">
        <div className="auth-language">
          <LanguageToggle />
        </div>
        <div className="auth-form">
          <h1>{title}</h1>
          <p className="muted">{lead}</p>
          {children}
        </div>
      </section>
    </main>
  );
}

function SignInForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("login", { username: username.trim(), password, ...(needsCode ? { code: code.trim().toUpperCase() } : {}) });
      setPassword("");
      setCode("");
      onAuthenticated();
    } catch (error) {
      // The password was right; keep it in memory only for the second step.
      if (error instanceof ApiError && error.code === "TOTP_REQUIRED") setNeedsCode(true);
      else setError(error);
    } finally {
      setBusy(false);
    }
  }
  const restart = () => {
    setNeedsCode(false);
    setPassword("");
    setCode("");
    setError("");
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      {needsCode ? (
        <>
          <p className="auth-who">
            <b>{username.trim()}</b>
            <button type="button" className="btn ghost small" onClick={restart}>{t("auth.back")}</button>
          </p>
          <label>
            {t("auth.code")}
            <input inputMode="text" autoComplete="one-time-code" autoFocus value={code} maxLength={32}
              onChange={(event) => setCode(event.target.value)} required />
          </label>
          <p className="muted small">{t("auth.codeNote")}</p>
        </>
      ) : (
        <>
          <label>
            {t("auth.username")}
            <input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} maxLength={64}
              onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label>
            {t("auth.password")}
            <input type="password" autoComplete="current-password" value={password} maxLength={1024}
              onChange={(event) => setPassword(event.target.value)} required />
          </label>
        </>
      )}
      {Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? t("auth.working") : needsCode ? t("auth.verify") : t("auth.submit")}
      </button>
    </form>
  );
}

function SetupForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useT();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("setup", { token, username: username.trim(), password });
      setToken("");
      setPassword("");
      onAuthenticated();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <p className="muted small">{t("auth.setupNote")}</p>
      <label>
        {t("auth.setupToken")}
        <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required />
      </label>
      <label>
        {t("auth.username")}
        <input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} minLength={3} maxLength={64}
          pattern="[A-Za-z0-9._\-]{3,64}" onChange={(event) => setUsername(event.target.value)} required />
      </label>
      <p className="muted small">{t("auth.usernameNote")}</p>
      <label>
        {t("auth.newPassword")}
        <input type="password" autoComplete="new-password" value={password} minLength={12} maxLength={1024}
          onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t("auth.working") : t("auth.create")}</button>
    </form>
  );
}

export function AuthScreen({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: () => void }) {
  const { t } = useT();
  return setup ? (
    <AuthLayout title={t("auth.setup")} lead={t("auth.setupLead")}>
      <SetupForm onAuthenticated={onAuthenticated} />
    </AuthLayout>
  ) : (
    <AuthLayout title={t("auth.signIn")} lead={t("auth.signInLead")}>
      <SignInForm onAuthenticated={onAuthenticated} />
    </AuthLayout>
  );
}

export function ReauthDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
      setPassword("");
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={t("auth.confirmIdentity")} onCancel={onCancel}>
      <p className="muted">{t("auth.reauthNote")}</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          {t("auth.password")}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {Boolean(error) && (
          <p role="alert" className="error">
            {errorText(error, t)}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("auth.cancel")}
          </button>
          <button className="btn primary" disabled={busy}>
            {t("auth.confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
