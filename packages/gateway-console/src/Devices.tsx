import { useT } from "./i18n";
import { useNow } from "./clock";
import { memo, useCallback, useState, type FormEvent } from "react";
import { api, errorText } from "./api";
import { DeviceGlyph, executionState, glyphKinds, glyphLabels } from "./Glyph";
import { consoleStore } from "./store";
import type { Activity, Engine, Snapshot } from "./types";
import {
  CopyButton,
  Drawer,
  EngineStatus,
  MiniLog,
  Modal,
  formatAgo,
  modelText,
  platformText,
} from "./ui";

export type SensitiveAction = (operation: () => Promise<void>) => Promise<void>;
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function installCommand(
  platform: string,
  origin: string,
  id: string,
  token: string,
): string {
  const configuration = `umask 077\ncat > engine.env <<'REACH_CONFIG'\nREACH_GATEWAY_URL=${quote(origin)}\nREACH_ENGINE_ID=${quote(id)}\nREACH_ENGINE_TOKEN=${quote(token)}\nREACH_CONFIG\n`;
  switch (platform) {
    case "macOS":
      return `${configuration}cargo build --release --locked --bin engine\nbash scripts/install-engine-macos.sh ./engine.env`;
    case "OpenWrt":
      return `${configuration}sh scripts/install-engine-openwrt.sh ./engine-linux-x64-musl ./engine.env ./node-openwrt-x64.tar.gz`;
    case "Docker":
      return `${configuration}set -a\n. ./engine.env\nset +a\ndocker run -d --name reach-engine --restart unless-stopped --platform linux/amd64 -e REACH_GATEWAY_URL -e REACH_ENGINE_ID -e REACH_ENGINE_TOKEN -v "$PWD/engine-linux-x64-musl:/usr/local/bin/engine:ro" -v reach-workspace:/workspace -e REACH_WORKSPACE_ROOTS=default:/workspace debian:bookworm-slim /usr/local/bin/engine`;
    default:
      return `${configuration}bash scripts/install-engine-linux.sh ./engine-linux-x64-musl ./engine.env`;
  }
}

export const DeviceDrawer = memo(function DeviceDrawer({
  engine,
  activity,
  heartbeatInterval,
  onClose,
  sensitive,
}: {
  engine: Engine;
  activity: Activity[];
  heartbeatInterval: number;
  onClose: () => void;
  sensitive: SensitiveAction;
}) {
  const { t, lang } = useT();
  const now = useNow();
  const [displayName, setName] = useState(engine.displayName);
  const [kind, setKind] = useState(engine.deviceOverride?.kind ?? "");
  const [model, setModel] = useState(engine.deviceOverride?.model ?? "");
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaved(false);
    try {
      await api(
        `engines/${encodeURIComponent(engine.id)}`,
        { displayName, deviceOverride: kind ? { kind, model } : null },
        "PATCH",
      );
      await consoleStore.refresh();
      setSaved(true);
    } catch (error) {
      setError(error);
    }
  }
  const recent = activity
    .filter((row) => row.engineId === engine.id)
    .slice(0, 6);
  return (
    <Drawer
      title={engine.displayName}
      label={t("devices.drawer", { name: engine.displayName })}
      onClose={onClose}
      dismissible={!token}
    >
      <section className="dev-hero">
        <DeviceGlyph
          heartbeatInterval={heartbeatInterval}
          engine={engine}
          large
        />
        <div>
          <b>{modelText(engine, lang)}</b>
          <div className="muted">{platformText(engine, lang)}</div>
          <span className="pill">
            {engine.deviceOverride
              ? t("devices.manualType")
              : t("devices.detectedType")}
          </span>
        </div>
      </section>
      <section>
        <dl className="kv">
          <dt>{t("devices.status")}</dt>
          <dd>
            <EngineStatus
              heartbeatInterval={heartbeatInterval}
              engine={engine}
            />
          </dd>
          <dt>{t("devices.id")}</dt>
          <dd className="mono">{engine.id}</dd>
          <dt>Engine</dt>
          <dd className="mono">
            {engine.engineVersion
              ? `v${engine.engineVersion}`
              : t("devices.notReported")}
          </dd>
          <dt>{t("devices.lastHeartbeat")}</dt>
          <dd>
            {engine.lastSeenAt
              ? formatAgo(engine.lastSeenAt, now, lang)
              : t("devices.awaiting")}
          </dd>
          <dt>{t("devices.owner")}</dt>
          <dd>{engine.session.ownerLabel ?? t("devices.none")}</dd>
          <dt>{t("devices.registeredBy")}</dt>
          <dd>
            {engine.origin === "seed"
              ? t("devices.configuration")
              : t("devices.console")}
          </dd>
        </dl>
      </section>
      <section>
        <h4>{t("devices.workspaces")}</h4>
        {engine.session.workspaces?.length ? (
          <ul className="ws-list">
            {engine.session.workspaces.map((workspace) => {
              const state = executionState(
                workspace,
                engine.session.processWorkspaces,
              );
              return (
                <li key={workspace}>
                  <code>{workspace}</code>
                  <span
                    className={`pill ${state === "enabled" ? "accent" : ""}`}
                  >
                    {t(
                      state === "enabled"
                        ? "devices.executionEnabled"
                        : state === "disabled"
                          ? "devices.executionDisabled"
                          : "devices.executionNotReported",
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="reserved">{t("devices.workspacesNote")}</div>
        )}
      </section>
      <section>
        <h4>{t("devices.skills")}</h4>
        <div className="reserved">{t("devices.skillsNote")}</div>
      </section>
      <section>
        <h4>{t("devices.recent")}</h4>
        <MiniLog rows={recent} showEngine={false} />
      </section>
      <section>
        <h4>{t("devices.display")}</h4>
        <form onSubmit={(event) => void save(event)}>
          <label>
            {t("devices.displayName")}
            <input
              value={displayName}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label>
            {t("devices.deviceType")}
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">{t("devices.reportedHardware")}</option>
              {glyphKinds.map((value) => (
                <option key={value} value={value}>
                  {t(glyphLabels[value as keyof typeof glyphLabels])}
                </option>
              ))}
            </select>
          </label>
          {kind && (
            <label>
              {t("devices.model")}
              <input
                value={model}
                maxLength={64}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          )}
          <div className="actions">
            <button className="btn small">{t("devices.save")}</button>
            {saved && (
              <span className="success" role="status">
                {t("devices.saved")}
              </span>
            )}
          </div>
        </form>
      </section>
      {engine.origin === "console" ? (
        <section>
          <h4>{t("devices.credentials")}</h4>
          {token && (
            <div className="one-time">
              <strong>{t("devices.newToken")}</strong>
              <code>{token}</code>
              <CopyButton value={token} label={t("devices.copyToken")} />
              <button className="btn small" onClick={() => setToken("")}>
                {t("devices.savedToken")}
              </button>
            </div>
          )}
          {confirmRemove ? (
            <div className="notice err">
              <span>
                {t("devices.removeNote", { name: engine.displayName })}
              </span>
            </div>
          ) : null}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              className="btn small"
              onClick={() =>
                void sensitive(async () => {
                  const result = await api<{ token: string }>(
                    `engines/${encodeURIComponent(engine.id)}/rotate`,
                    {},
                  );
                  setToken(result.token);
                })
              }
            >
              {t("devices.rotate")}
            </button>
            {confirmRemove ? (
              <>
                <button
                  className="btn small danger"
                  onClick={() =>
                    void sensitive(async () => {
                      await api(
                        `engines/${encodeURIComponent(engine.id)}`,
                        {},
                        "DELETE",
                      );
                      await consoleStore.refresh();
                      onClose();
                    })
                  }
                >
                  {t("devices.remove")}
                </button>
                <button
                  className="btn small"
                  onClick={() => setConfirmRemove(false)}
                >
                  {t("devices.cancel")}
                </button>
              </>
            ) : (
              <button
                className="btn small danger-ghost"
                onClick={() => setConfirmRemove(true)}
              >
                {t("devices.removePrompt")}
              </button>
            )}
          </div>
        </section>
      ) : (
        <div className="reserved">{t("devices.seedNote")}</div>
      )}
      {Boolean(error) && (
        <p className="error" role="alert">
          {errorText(error, t)}
        </p>
      )}
    </Drawer>
  );
});

const platforms = ["Linux", "macOS", "OpenWrt", "Docker"] as const;
const platformLabels = {
  Linux: "glyph.linux",
  macOS: "glyph.macOS",
  OpenWrt: "glyph.openwrt",
  Docker: "glyph.docker",
} as const;

export function AddDevice({
  snapshot,
  sensitive,
  onClose,
}: {
  snapshot: Snapshot;
  sensitive: SensitiveAction;
  onClose: () => void;
}) {
  const { t, lang } = useT();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [platform, setPlatform] = useState("Linux");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [idEdited, setIdEdited] = useState(false);
  const registered = snapshot.engines.find((engine) => engine.id === id);
  const command = token
    ? installCommand(platform, snapshot.gateway.publicOrigin, id, token)
    : "";
  async function enroll(): Promise<void> {
    setBusy(true);
    try {
      await sensitive(async () => {
        const result = await api<{ token: string }>("engines", {
          id,
          displayName: name,
        });
        setToken(result.token);
        setStep(3);
        await consoleStore.refresh();
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("devices.add")}
      dismissible={!token}
      onClose={() => {
        setToken("");
        onClose();
      }}
    >
      <div className="steps" aria-label={t("devices.step", { step })}>
        {[
          t("devices.stepName"),
          t("devices.stepPlatform"),
          t("devices.stepInstall"),
          t("devices.stepConnect"),
        ].map((value, index) => (
          <span
            key={value}
            className={
              step === index + 1 ? "current" : step > index + 1 ? "done" : ""
            }
          >
            {index + 1} · {value}
          </span>
        ))}
      </div>
      {step === 1 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setStep(2);
          }}
        >
          <label>
            {t("devices.name")}
            <input
              value={name}
              maxLength={64}
              onChange={(event) => {
                setName(event.target.value);
                if (!idEdited)
                  setId(
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9._-]+/g, "-")
                      .slice(0, 64),
                  );
              }}
              required
            />
          </label>
          <label>
            {t("devices.id")}
            <input
              value={id}
              pattern="[A-Za-z0-9._-]{1,64}"
              maxLength={64}
              onChange={(event) => {
                setIdEdited(true);
                setId(event.target.value);
              }}
              required
            />
          </label>
          <div className="actions">
            <button className="btn primary">
              {t("devices.choosePlatform")}
            </button>
          </div>
        </form>
      )}
      {step === 2 && (
        <>
          <p className="muted">{t("devices.where")}</p>
          <div className="platforms">
            {platforms.map((value) => (
              <button
                className="btn"
                aria-pressed={platform === value}
                onClick={() => setPlatform(value)}
                key={value}
              >
                {t(platformLabels[value])}
              </button>
            ))}
          </div>
          <div className="reserved">{t("devices.commandsNote")}</div>
          <div className="actions">
            <button className="btn" onClick={() => setStep(1)}>
              {t("devices.back")}
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void enroll()}
            >
              {busy ? t("devices.registering") : t("devices.register")}
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div className="notice warn">{t("devices.tokenNote")}</div>
          <label>
            {t("devices.engineToken")}
            <input
              readOnly
              value={token}
              aria-label={t("devices.oneTimeToken")}
            />
          </label>
          <CopyButton value={token} label={t("devices.copyToken")} />
          <pre className="command">{command}</pre>
          <div className="actions">
            <CopyButton value={command} label={t("devices.copyCommands")} />
            <button
              className="btn primary"
              onClick={() => {
                setToken("");
                setStep(4);
              }}
            >
              {t("devices.started")}
            </button>
          </div>
        </>
      )}
      {step === 4 && (
        <div className="waiting">
          {registered?.enrollmentStatus === "connected" ? (
            <>
              <DeviceGlyph
                heartbeatInterval={snapshot.gateway.heartbeatInterval}
                engine={registered}
                large
              />
              <h3>{t("devices.connected")}</h3>
              <p>{modelText(registered, lang)}</p>
              <p className="muted">{platformText(registered, lang)}</p>
              <button className="btn primary" onClick={onClose}>
                {t("devices.done")}
              </button>
            </>
          ) : (
            <>
              <span className="spinner" aria-hidden="true" />
              <h3>{t("devices.waiting")}</h3>
              <p className="muted">{t("devices.waitingNote")}</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function DevicesView({
  snapshot,
  sensitive,
  initialId,
  onAdd,
}: {
  snapshot: Snapshot;
  sensitive: SensitiveAction;
  initialId?: string;
  onAdd: () => void;
}) {
  const { t, lang } = useT();
  const now = useNow();
  const [selected, setSelected] = useState(initialId ?? "");
  const closeDrawer = useCallback(() => setSelected(""), []);
  const device = snapshot.engines.find((engine) => engine.id === selected);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{t("devices.title")}</h2>
          <button className="btn small primary" onClick={onAdd}>
            {t("devices.add")}
          </button>
        </div>
        {snapshot.engines.length ? (
          <div className="device-grid">
            {snapshot.engines.map((engine) => (
              <button
                className={`device-card${engine.id === selected ? " selected" : ""}`}
                key={engine.id}
                onClick={() => setSelected(engine.id)}
              >
                <div className="row">
                  <DeviceGlyph
                    heartbeatInterval={snapshot.gateway.heartbeatInterval}
                    engine={engine}
                  />
                  <div className="eng-body">
                    <span className="name">{engine.displayName}</span>
                    <span className="meta">{modelText(engine, lang)}</span>
                  </div>
                </div>
                <div className="meta">
                  <span>{platformText(engine, lang)}</span>
                  {engine.engineVersion && (
                    <span className="mono">v{engine.engineVersion}</span>
                  )}
                </div>
                <footer>
                  <EngineStatus
                    heartbeatInterval={snapshot.gateway.heartbeatInterval}
                    engine={engine}
                  />
                  <span>
                    {engine.lastSeenAt
                      ? formatAgo(engine.lastSeenAt, now, lang)
                      : "—"}
                  </span>
                </footer>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">{t("devices.empty")}</div>
        )}
      </section>
      {device && (
        <DeviceDrawer
          key={device.id}
          engine={device}
          activity={snapshot.activity}
          heartbeatInterval={snapshot.gateway.heartbeatInterval}
          onClose={closeDrawer}
          sensitive={sensitive}
        />
      )}
    </>
  );
}
