import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_VERSION } from "./version.js";

export interface UpdateConfig {
  repo: string;
  intervalMs: number;
  token?: string;
  backend: "host" | "compose";
  requestDir: string;
}

export function parseUpdateConfig(env: NodeJS.ProcessEnv): UpdateConfig | undefined {
  if (env.REACH_UPDATE_ENABLED !== "1" && env.REACH_UPDATE_ENABLED !== "true") return undefined;
  const repo = env.REACH_UPDATE_REPO ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some(part => part === "." || part === "..")) {
    throw new Error("REACH_UPDATE_REPO must be owner/repo");
  }
  const interval = env.REACH_UPDATE_INTERVAL_SECS ?? "3600";
  const seconds = Number(interval);
  if (!/^[0-9]+$/.test(interval) || !Number.isSafeInteger(seconds) || seconds < 60 || seconds * 1000 > 2_147_483_647) {
    throw new Error("REACH_UPDATE_INTERVAL_SECS must be an integer >= 60 within the timer range");
  }
  const backend = env.REACH_UPDATE_BACKEND ?? "host";
  if (backend !== "host" && backend !== "compose") throw new Error("REACH_UPDATE_BACKEND must be host or compose");
  const requestDir = env.REACH_UPDATE_REQUEST_DIR;
  if (!requestDir?.trim()) throw new Error("REACH_UPDATE_REQUEST_DIR is required for Gateway updates");
  if (env.REACH_UPDATE_GITHUB_TOKEN !== undefined && env.REACH_UPDATE_GITHUB_TOKEN_FILE !== undefined) {
    throw new Error("Set only one GitHub token source");
  }
  const token = env.REACH_UPDATE_GITHUB_TOKEN ?? (env.REACH_UPDATE_GITHUB_TOKEN_FILE === undefined
    ? undefined : readFileSync(env.REACH_UPDATE_GITHUB_TOKEN_FILE, "utf8").trim());
  if (token !== undefined && (!token || /\s|[\x00-\x1f\x7f]/.test(token))) throw new Error("Invalid GitHub token");
  return { repo, intervalMs: seconds * 1000, backend, requestDir, token };
}

type Version = [bigint, bigint, bigint];
export function parseVersion(value: string): Version | undefined {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) return undefined;
  return value.split(".").map(BigInt) as Version;
}

function compare(left: Version, right: Version): number {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; url: string }[];
}

export function selectRelease(releases: Release[], current = GATEWAY_VERSION): Release | undefined {
  const running = parseVersion(current);
  if (!running) throw new Error("Invalid current Gateway version");
  let selected: Release | undefined;
  let highest = running;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith("gateway-v")) continue;
    const version = parseVersion(release.tag_name.slice(9));
    if (version && compare(version, highest) > 0) { selected = release; highest = version; }
  }
  return selected;
}

export interface UpdateRequest {
  component: "gateway";
  version: string;
  asset: "gateway-amd64.tgz";
  digest: string;
  repo: string;
}

export interface ApplyIntent extends UpdateRequest {
  nonce: string;
  expiresAt: number;
}

export function readApplyIntent(config: UpdateConfig, now: number): ApplyIntent | undefined {
  try {
    const intent: ApplyIntent = JSON.parse(readFileSync(join(config.requestDir, "apply.json"), "utf8"));
    if (intent.component !== "gateway" || intent.repo !== config.repo || !parseVersion(intent.version)
      || !/^[a-f0-9]{32}$/.test(intent.nonce) || !Number.isSafeInteger(intent.expiresAt)
      || intent.expiresAt <= now || intent.expiresAt > now + 900_000) return undefined;
    return intent;
  } catch { return undefined; }
}

/** New session admission uses the same synchronous marker read as idle acknowledgement. */
export function updateAdmissionPaused(config: UpdateConfig | undefined, now: number): boolean {
  return config !== undefined && readApplyIntent(config, now) !== undefined;
}

export class GatewayUpdater {
  private pending: UpdateRequest | undefined;
  private requested: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private checking = false;
  private nextCheck = 0;
  private retryMs = 1000;
  constructor(
    private readonly config: UpdateConfig,
    private readonly idle: () => boolean,
    private readonly logger: (message: string) => void,
    private readonly fetchRelease: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => { void this.tick().then(delay => {
      if (!this.stopped) this.schedule(delay);
    }); }, delay);
    this.timer.unref();
  }

  private async get(url: string, binary = false): Promise<Response> {
    if (!url.startsWith("https://api.github.com/")) throw new Error("Release URL must use GitHub API HTTPS");
    const headers: Record<string, string> = {
      "User-Agent": `reach-gateway/${GATEWAY_VERSION}`,
      Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await this.fetchRelease(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response;
  }

  private async discover(): Promise<UpdateRequest | undefined> {
    const releases: Release[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.get(`https://api.github.com/repos/${this.config.repo}/releases?per_page=100&page=${page}`);
      const batch: Release[] = await response.json();
      if (!Array.isArray(batch)) throw new Error("Invalid GitHub release list");
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    const release = selectRelease(releases);
    if (!release) return undefined;
    const sums = release.assets.find(asset => asset.name === "SHA256SUMS");
    if (!sums || !release.assets.some(asset => asset.name === "gateway-amd64.tgz")) throw new Error("Missing Gateway release assets");
    const text = await (await this.get(sums.url, true)).text();
    const lines = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1]?.replace(/^\*/, "") === "gateway-amd64.tgz");
    if (lines.length !== 1 || lines[0].length !== 2 || !/^[a-fA-F0-9]{64}$/.test(lines[0][0])) throw new Error("Invalid Gateway checksum");
    return { component: "gateway", version: release.tag_name.slice(9), asset: "gateway-amd64.tgz", digest: lines[0][0].toLowerCase(), repo: this.config.repo };
  }

  private acknowledgeIdle(): void {
    const intent = readApplyIntent(this.config, this.now());
    if (!intent || !this.idle()) return;
    const temporary = join(this.config.requestDir, "idle.json.tmp");
    writeFileSync(temporary, JSON.stringify({ component: intent.component, version: intent.version, nonce: intent.nonce }), { mode: 0o600 });
    renameSync(temporary, join(this.config.requestDir, "idle.json"));
  }

  public async tick(): Promise<number> {
    if (this.checking || this.stopped) return 1000;
    this.checking = true;
    try {
      this.acknowledgeIdle();
      if (this.now() >= this.nextCheck && !this.pending) {
        this.pending = await this.discover();
        this.nextCheck = this.now() + this.config.intervalMs;
      }
      // Recheck after every awaited GitHub operation: a session may have opened.
      if (!this.stopped && this.pending && this.idle()) {
        if (this.requested !== this.pending.version) {
          mkdirSync(this.config.requestDir, { recursive: true });
          const temporary = join(this.config.requestDir, "request.json.tmp");
          writeFileSync(temporary, JSON.stringify(this.pending), { mode: 0o600 });
          renameSync(temporary, join(this.config.requestDir, "request.json"));
          this.requested = this.pending.version;
          this.logger(`Reach Gateway update available: ${this.pending.version}`);
        }
        this.pending = undefined;
      }
      this.retryMs = 1000;
      // Helpers may become ready between checks; acknowledgement does not fetch GitHub.
      return Math.min(1000, Math.max(1, this.nextCheck - this.now()));
    } catch {
      // Never include tokens, URLs or downloaded error bodies in the log.
      this.logger("Reach Gateway update check/apply failed; retrying");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
      this.nextCheck = this.now() + delay;
      return delay;
    } finally { this.checking = false; }
  }
}
