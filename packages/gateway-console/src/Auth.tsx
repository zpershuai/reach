import { LanguageToggle } from "./LanguageToggle";
import { useT } from "./i18n";
import { useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { api, errorText } from "./api";
import { Modal } from "./ui";

interface Identity {
  authenticated: boolean;
  setupRequired?: boolean;
  csrfToken: string;
  recoveryCodes?: string[];
}

export function AuthScreen({
  setup,
  onAuthenticated,
}: {
  setup: boolean;
  onAuthenticated: () => void;
}) {
  const { t } = useT();
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup && !secret) {
        const result = await api<{ secret: string; otpauthUrl: string }>(
          "setup",
          { token },
        );
        const encoder = qrcode(0, "M");
        encoder.addData(result.otpauthUrl);
        encoder.make();
        setSecret(result.secret);
        setQr(encoder.createDataURL(4, 12));
      } else {
        const result = await api<Identity>(setup ? "setup" : "login", {
          ...(setup ? { token } : {}),
          password,
          code: code.trim().toUpperCase(),
        });
        setToken("");
        setPassword("");
        setCode("");
        setSecret("");
        setQr("");
        if (result.recoveryCodes) setRecovery(result.recoveryCodes);
        else onAuthenticated();
      }
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const heading = recovery.length
    ? t("auth.saveCodes")
    : setup
      ? secret
        ? t("auth.connectAuthenticator")
        : t("auth.setup")
      : t("auth.signIn");
  return (
    <main className="auth-page">
      <div className="auth-language">
        <LanguageToggle />
      </div>
      <section className="panel auth-card">
        <div className="panel-body">
          <span className="brand">
            <b>Reach</b>
            <span>Gateway</span>
          </span>
          <h1>{heading}</h1>
          {recovery.length ? (
            <>
              <p>{t("auth.codesNote")}</p>
              <div className="recovery">
                {recovery.map((value) => (
                  <code key={value}>{value}</code>
                ))}
              </div>
              <button
                className="btn primary"
                onClick={() => {
                  setRecovery([]);
                  onAuthenticated();
                }}
              >
                {t("auth.savedCodes")}
              </button>
            </>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              {setup && !secret ? (
                <>
                  <p className="muted">{t("auth.setupNote")}</p>
                  <label>
                    {t("auth.setupToken")}
                    <input
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="off"
                      required
                    />
                  </label>
                </>
              ) : (
                <>
                  {setup && (
                    <div className="totp">
                      <img src={qr} alt={t("auth.scan")} />
                      <details>
                        <summary>{t("auth.manual")}</summary>
                        <code>{secret}</code>
                      </details>
                    </div>
                  )}
                  <label>
                    {t("auth.password")}
                    <input
                      type="password"
                      minLength={setup ? 12 : undefined}
                      maxLength={1024}
                      autoComplete={setup ? "new-password" : "current-password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    {setup ? t("auth.code") : t("auth.recoveryCode")}
                    <input
                      inputMode="text"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      required
                    />
                  </label>
                </>
              )}
              {Boolean(error) && (
                <p className="error" role="alert">
                  {errorText(error, t)}
                </p>
              )}
              <button className="btn primary" disabled={busy}>
                {busy
                  ? t("auth.working")
                  : setup
                    ? secret
                      ? t("auth.create")
                      : t("auth.continue")
                    : t("auth.submit")}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
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
