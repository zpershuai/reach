import { useNow } from "./clock";
import { memo, useCallback, useState, type FormEvent } from "react";
import { api } from "./api";
import { DeviceGlyph, executionState, glyphKinds } from "./Glyph";
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
  const now = useNow();
  const [displayName, setName] = useState(engine.displayName);
  const [kind, setKind] = useState(engine.deviceOverride?.kind ?? "");
  const [model, setModel] = useState(engine.deviceOverride?.model ?? "");
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
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
      setError(error instanceof Error ? error.message : "Update failed");
    }
  }
  const recent = activity
    .filter((row) => row.engineId === engine.id)
    .slice(0, 6);
  return (
    <Drawer
      title={engine.displayName}
      label={`Device ${engine.displayName}`}
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
          <b>{modelText(engine)}</b>
          <div className="muted">{platformText(engine)}</div>
          <span className="pill">
            {engine.deviceOverride ? "Type set manually" : "Type detected"}
          </span>
        </div>
      </section>
      <section>
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <EngineStatus
              heartbeatInterval={heartbeatInterval}
              engine={engine}
            />
          </dd>
          <dt>Device ID</dt>
          <dd className="mono">{engine.id}</dd>
          <dt>Engine</dt>
          <dd className="mono">
            {engine.engineVersion ? `v${engine.engineVersion}` : "Not reported"}
          </dd>
          <dt>Last heartbeat</dt>
          <dd>
            {engine.lastSeenAt
              ? formatAgo(engine.lastSeenAt, now)
              : "Awaiting first heartbeat"}
          </dd>
          <dt>Session owner</dt>
          <dd>{engine.session.ownerLabel ?? "None"}</dd>
          <dt>Registered by</dt>
          <dd>
            {engine.origin === "seed" ? "Gateway configuration" : "Console"}
          </dd>
        </dl>
      </section>
      <section>
        <h4>Workspaces & execution</h4>
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
                    Execution {state}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="reserved">
            Workspaces are reported while a session is open.
          </div>
        )}
      </section>
      <section>
        <h4>Skills · reserved</h4>
        <div className="reserved">
          Planned: install SKILL.md skills on this device from the Gateway
          catalogue and expose them to bots through MCP.
        </div>
      </section>
      <section>
        <h4>Recent operations</h4>
        <MiniLog rows={recent} showEngine={false} />
      </section>
      <section>
        <h4>Display</h4>
        <form onSubmit={(event) => void save(event)}>
          <label>
            Display name
            <input
              value={displayName}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label>
            Device type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Use reported hardware</option>
              {glyphKinds.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {kind && (
            <label>
              Model
              <input
                value={model}
                maxLength={64}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          )}
          <div className="actions">
            <button className="btn small">Save</button>
            {saved && (
              <span className="success" role="status">
                Saved
              </span>
            )}
          </div>
        </form>
      </section>
      {engine.origin === "console" ? (
        <section>
          <h4>Credentials</h4>
          {token && (
            <div className="one-time">
              <strong>New Engine token · shown once</strong>
              <code>{token}</code>
              <CopyButton value={token} label="Copy token" />
              <button className="btn small" onClick={() => setToken("")}>
                I saved this token
              </button>
            </div>
          )}
          {confirmRemove ? (
            <div className="notice err">
              <span>
                Remove {engine.displayName}? Its session closes and its token
                stops working. Activity history is kept.
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
              Rotate Engine token
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
                  Remove device
                </button>
                <button
                  className="btn small"
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="btn small danger-ghost"
                onClick={() => setConfirmRemove(true)}
              >
                Remove device…
              </button>
            )}
          </div>
        </section>
      ) : (
        <div className="reserved">
          This device is configured in the Gateway environment or engines file.
          Change its token or remove it there.
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Drawer>
  );
});

const platforms = ["Linux", "macOS", "OpenWrt", "Docker"];

export function AddDevice({
  snapshot,
  sensitive,
  onClose,
}: {
  snapshot: Snapshot;
  sensitive: SensitiveAction;
  onClose: () => void;
}) {
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
      title="Add device"
      dismissible={!token}
      onClose={() => {
        setToken("");
        onClose();
      }}
    >
      <div className="steps" aria-label={`Step ${step} of 4`}>
        {["Name", "Platform", "Install", "Connect"].map((value, index) => (
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
            Device name
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
            Device ID
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
            <button className="btn primary">Choose platform →</button>
          </div>
        </form>
      )}
      {step === 2 && (
        <>
          <p className="muted">Where will the Engine run?</p>
          <div className="platforms">
            {platforms.map((value) => (
              <button
                className="btn"
                aria-pressed={platform === value}
                onClick={() => setPlatform(value)}
                key={value}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="reserved">
            Run the commands from a Reach checkout or release bundle. OpenWrt
            also needs the prepared Node bundle.
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void enroll()}
            >
              {busy ? "Registering…" : "Register device →"}
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div className="notice warn">
            This Engine token is shown once. It stays in the device’s private
            configuration file.
          </div>
          <label>
            Engine token
            <input readOnly value={token} aria-label="One-time Engine token" />
          </label>
          <CopyButton value={token} label="Copy token" />
          <pre className="command">{command}</pre>
          <div className="actions">
            <CopyButton value={command} label="Copy commands" />
            <button
              className="btn primary"
              onClick={() => {
                setToken("");
                setStep(4);
              }}
            >
              I’ve started the Engine →
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
              <h3>Device connected</h3>
              <p>{modelText(registered)}</p>
              <p className="muted">{platformText(registered)}</p>
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <span className="spinner" aria-hidden="true" />
              <h3>Waiting for the first heartbeat</h3>
              <p className="muted">
                You can close this window. The device stays in Devices until its
                Engine connects.
              </p>
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
  const now = useNow();
  const [selected, setSelected] = useState(initialId ?? "");
  const closeDrawer = useCallback(() => setSelected(""), []);
  const device = snapshot.engines.find((engine) => engine.id === selected);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Devices</h2>
          <button className="btn small primary" onClick={onAdd}>
            Add device
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
                    <span className="meta">{modelText(engine)}</span>
                  </div>
                </div>
                <div className="meta">
                  <span>{platformText(engine)}</span>
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
                      ? formatAgo(engine.lastSeenAt, now)
                      : "—"}
                  </span>
                </footer>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">
            No devices yet. Add one to install its Engine.
          </div>
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
