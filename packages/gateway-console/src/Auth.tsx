import { useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { api } from "./api";
import { Modal } from "./ui";

interface Identity {
  authenticated: boolean;
  setupRequired?: boolean;
  csrfToken: string;
  recoveryCodes?: string[];
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function AuthScreen({
  setup,
  onAuthenticated,
}: {
  setup: boolean;
  onAuthenticated: () => void;
}) {
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState("");
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
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const heading = recovery.length
    ? "Save your recovery codes"
    : setup
      ? secret
        ? "Connect your authenticator"
        : "Set up your Gateway"
      : "Sign in";
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="panel-body">
          <span className="brand">
            <b>Reach</b>
            <span>Gateway</span>
          </span>
          <h1>{heading}</h1>
          {recovery.length ? (
            <>
              <p>
                These ten codes are shown once. Keep them somewhere private.
                Each one replaces an authenticator code for a single sign-in.
              </p>
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
                I saved my recovery codes →
              </button>
            </>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              {setup && !secret ? (
                <>
                  <p className="muted">
                    Enter the setup token from the Gateway log or your private
                    configuration.
                  </p>
                  <label>
                    Setup token
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
                      <img
                        src={qr}
                        alt="Scan this QR code with your authenticator"
                      />
                      <details>
                        <summary>Enter the secret manually</summary>
                        <code>{secret}</code>
                      </details>
                    </div>
                  )}
                  <label>
                    Password
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
                    {setup
                      ? "Authenticator code"
                      : "Authenticator or recovery code"}
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
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="btn primary" disabled={busy}>
                {busy
                  ? "Working…"
                  : setup
                    ? secret
                      ? "Create administrator →"
                      : "Continue →"
                    : "Sign in →"}
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
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
      setPassword("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Confirm it’s you" onCancel={onCancel}>
      <p className="muted">
        Enter your password to continue. The confirmation lasts ten minutes.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Confirm
          </button>
        </div>
      </form>
    </Modal>
  );
}
