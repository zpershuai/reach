import { useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { api, errorText } from "./api";
import { useT } from "./i18n";
import type { SensitiveAction } from "./Devices";
import { useSession } from "./session";
import { CopyButton } from "./ui";

/** Asks the app to reload `/me` after the signed-in account changed. */
export function identityChanged(): void {
  window.dispatchEvent(new Event("reach:identity"));
}

function qrDataUrl(text: string): string {
  const encoder = qrcode(0, "M");
  encoder.addData(text);
  encoder.make();
  return encoder.createDataURL(4, 12);
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useT();
  return (
    <div className="one-time">
      <strong>{t("account.saveCodes")}</strong>
      <p className="muted">{t("account.codesNote")}</p>
      <div className="recovery">
        {codes.map((value) => (
          <code key={value}>{value}</code>
        ))}
      </div>
      <div className="actions">
        <CopyButton value={codes.join("\n")} label={t("account.copyCodes")} />
        <button type="button" className="btn primary small" onClick={onDone}>
          {t("account.savedCodes")}
        </button>
      </div>
    </div>
  );
}

function PasswordForm() {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (next !== repeat) {
      setError(t("account.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await api("account/password", { current, password: next });
      setCurrent("");
      setNext("");
      setRepeat("");
      setSaved(true);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} aria-label={t("account.password")}>
      <h4>{t("account.password")}</h4>
      <label>
        {t("account.currentPassword")}
        <input type="password" autoComplete="current-password" value={current} maxLength={1024}
          onChange={(event) => setCurrent(event.target.value)} required />
      </label>
      <label>
        {t("account.newPassword")}
        <input type="password" autoComplete="new-password" value={next} minLength={12} maxLength={1024}
          onChange={(event) => setNext(event.target.value)} required />
      </label>
      <label>
        {t("account.repeatPassword")}
        <input type="password" autoComplete="new-password" value={repeat} minLength={12} maxLength={1024}
          onChange={(event) => setRepeat(event.target.value)} required />
      </label>
      <p className="muted">{t("account.passwordNote")}</p>
      {Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}
      <div className="actions">
        <button className="btn small" disabled={busy}>{t("account.changePassword")}</button>
        {saved && <span className="success" role="status">{t("account.passwordChanged")}</span>}
      </div>
    </form>
  );
}

function Authenticator({ enabled, sensitive }: { enabled: boolean; sensitive: SensitiveAction }) {
  const { t } = useT();
  const [enrolment, setEnrolment] = useState<{ secret: string; qr: string }>();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const begin = () =>
    void sensitive(async () => {
      const result = await api<{ secret: string; otpauthUrl: string }>("account/totp/begin", {});
      setEnrolment({ secret: result.secret, qr: qrDataUrl(result.otpauthUrl) });
      setCode("");
      setError("");
    });
  async function confirm(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    await sensitive(async () => {
      try {
        const result = await api<{ recoveryCodes: string[] }>("account/totp/confirm", { code: code.trim() });
        setEnrolment(undefined);
        setCode("");
        setCodes(result.recoveryCodes);
      } catch (error) {
        if ((error as { code?: string }).code === "REAUTH_REQUIRED") throw error;
        setError(error);
      }
    });
  }
  async function disable(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    await sensitive(async () => {
      try {
        await api("account/totp", { code: code.trim() }, "DELETE");
        setCode("");
        identityChanged();
      } catch (error) {
        if ((error as { code?: string }).code === "REAUTH_REQUIRED") throw error;
        setError(error);
      }
    });
  }
  const failure = Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>;
  if (codes.length)
    return (
      <section aria-label={t("account.authenticator")}>
        <h4>{t("account.authenticator")}</h4>
        <RecoveryCodes codes={codes} onDone={() => { setCodes([]); identityChanged(); }} />
      </section>
    );
  return (
    <section aria-label={t("account.authenticator")}>
      <h4>
        {t("account.authenticator")}{" "}
        <span className={`pill ${enabled ? "ok" : "warn"}`}>{enabled ? t("account.on") : t("account.off")}</span>
      </h4>
      {enabled ? (
        <form onSubmit={(event) => void disable(event)}>
          <p className="muted">{t("account.enabledNote")}</p>
          <label>
            {t("account.codeOrRecovery")}
            <input inputMode="text" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          </label>
          {failure}
          <button className="btn small danger-outline">{t("account.disable")}</button>
        </form>
      ) : enrolment ? (
        <form onSubmit={(event) => void confirm(event)}>
          <div className="totp">
            <img src={enrolment.qr} alt={t("account.scan")} />
            <details>
              <summary>{t("account.manual")}</summary>
              <code>{enrolment.secret}</code>
            </details>
          </div>
          <label>
            {t("account.code")}
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          </label>
          {failure}
          <div className="actions">
            <button type="button" className="btn small" onClick={() => setEnrolment(undefined)}>{t("auth.cancel")}</button>
            <button className="btn small primary">{t("account.confirmEnable")}</button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">{t("account.disabledNote")}</p>
          {failure}
          <button type="button" className="btn small primary" onClick={begin}>{t("account.enable")}</button>
        </>
      )}
    </section>
  );
}

/** Self-service account settings, open to every role. */
export function AccountSettings({ sensitive }: { sensitive: SensitiveAction }) {
  const { t } = useT();
  const { user } = useSession();
  if (!user) return null;
  return (
    <section className="panel account-settings">
      <div className="panel-head">
        <h3>{t("account.title")}</h3>
        <span className="pill">{user.username} · {t(user.role === "admin" ? "account.roleAdmin" : "account.roleUser")}</span>
      </div>
      <div className="panel-body account-grid">
        <PasswordForm />
        <Authenticator enabled={user.totpEnabled} sensitive={sensitive} />
      </div>
    </section>
  );
}
