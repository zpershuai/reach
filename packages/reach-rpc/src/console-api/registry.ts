import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { EngineApi } from "../mcp/in-process.js";
import type { ConsoleStore } from "./store.js";
import { z } from "zod";
import { ConfigurationError } from "../diagnostics.js";

export const deviceKinds = ["mac-mini", "mac-studio", "macbook", "imac", "mac", "router", "nas", "raspberry-pi", "server", "unknown"] as const;
export type DeviceKind = typeof deviceKinds[number];
export interface HardwareDescriptor {
  kind: DeviceKind;
  model: string;
  os: string;
  osVersion: string;
  arch: string;
}
export interface DeviceOverride { kind: DeviceKind; model: string }

const hardwareField = z.string().refine(value => [...value].length <= 64 && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const hardwareSchema = z.object({ kind: hardwareField, model: hardwareField, os: hardwareField, osVersion: hardwareField, arch: hardwareField });

export function parseHardware(value: unknown): HardwareDescriptor | undefined {
  const parsed = hardwareSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { ...parsed.data, kind: deviceKinds.includes(parsed.data.kind as DeviceKind) ? parsed.data.kind as DeviceKind : "unknown" };
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface EngineRegistration {
  id: string;
  displayName: string;
  tokenDigest: string | null;
  origin: "seed" | "console";
  createdAt: number;
  deviceOverride: DeviceOverride | null;
  hardware: HardwareDescriptor | null;
  lastSeenAt: number | null;
  engineVersion: string | null;
}

export interface EngineRuntime {
  server: Server;
  api: EngineApi;
  retire(): void;
}

export interface RegisteredEngine extends EngineRegistration, EngineRuntime {}

export class EngineRegistry {
  readonly engines = new Map<string, RegisteredEngine>();
  readonly apis = new Map<string, EngineApi>();
  storageHealth = true;

  constructor(
    private readonly createRuntime: (registration: EngineRegistration, verifyToken: (token: string) => boolean) => EngineRuntime,
    private readonly store?: ConsoleStore,
    private readonly controllerConfigured = false,
    private readonly now = Date.now,
    private readonly logger: (message: string) => void = console.error,
  ) {
    for (const row of store?.db.prepare("SELECT * FROM engines").all() ?? []) {
      const registration: EngineRegistration = {
        id: String(row.id), displayName: String(row.display_name), tokenDigest: row.token_digest as string | null,
        origin: row.origin as "seed" | "console", createdAt: Number(row.created_at),
        deviceOverride: row.device_override ? JSON.parse(String(row.device_override)) : null,
        hardware: row.hardware ? JSON.parse(String(row.hardware)) : null,
        lastSeenAt: row.last_seen_at as number | null, engineVersion: row.engine_version as string | null,
      };
      if (!controllerConfigured && registration.id !== "local-engine") {
        throw new ConfigurationError("Persisted Engines require Gateway authentication");
      }
      this.attach(registration);
    }
  }

  seed(id: string, token: string | undefined): void {
    const existing = this.engines.get(id);
    const registration: EngineRegistration = {
      id, displayName: existing?.displayName ?? id, tokenDigest: token === undefined ? null : tokenDigest(token), origin: "seed", createdAt: existing?.createdAt ?? this.now(),
      deviceOverride: existing?.deviceOverride ?? null, hardware: existing?.hardware ?? null,
      lastSeenAt: existing?.lastSeenAt ?? null, engineVersion: existing?.engineVersion ?? null,
    };
    this.persist(registration);
    if (existing) Object.assign(existing, registration);
    else this.attach(registration);
  }

  /** Drop configuration-managed Engines that the current configuration no longer names, so their old tokens stop working. */
  retainSeeds(ids: ReadonlySet<string>): void {
    for (const engine of [...this.engines.values()]) {
      if (engine.origin !== "seed" || ids.has(engine.id)) continue;
      this.store?.db.prepare("DELETE FROM engines WHERE id=?").run(engine.id);
      engine.retire();
      this.engines.delete(engine.id);
      this.apis.delete(engine.id);
    }
  }

  add(id: string, displayName: string): { engine: EngineRegistration; token: string } {
    if (!this.controllerConfigured) throw new RegistryError(409, "Multiple Engines require Gateway authentication", "ENGINE_AUTH_REQUIRED");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new RegistryError(400, "Invalid Engine id", "INVALID_ENGINE_ID");
    if (this.engines.has(id)) throw new RegistryError(409, "Engine id already exists", "ENGINE_ID_EXISTS");
    this.validateName(displayName);
    const token = randomBytes(32).toString("hex");
    const registration: EngineRegistration = {
      id, displayName: displayName.trim(), tokenDigest: tokenDigest(token), origin: "console", createdAt: this.now(),
      deviceOverride: null, hardware: null, lastSeenAt: null, engineVersion: null,
    };
    this.persist(registration);
    this.attach(registration);
    return { engine: registration, token };
  }

  update(id: string, changes: { displayName?: string; deviceOverride?: DeviceOverride | null }): void {
    const engine = this.require(id);
    if (changes.displayName !== undefined) this.validateName(changes.displayName);
    const override = changes.deviceOverride;
    if (override && (!deviceKinds.includes(override.kind) || [...override.model].length > 64 || /[\x00-\x1f\x7f]/.test(override.model))) {
      throw new RegistryError(400, "Invalid device override", "INVALID_DEVICE_OVERRIDE");
    }
    const updated = { ...engine, ...changes };
    if (changes.displayName !== undefined) updated.displayName = changes.displayName.trim();
    this.persist(updated);
    Object.assign(engine, updated);
  }

  rotate(id: string): string {
    const engine = this.requireConsole(id);
    const token = randomBytes(32).toString("hex");
    const digest = tokenDigest(token);
    this.persist({ ...engine, tokenDigest: digest });
    engine.tokenDigest = digest;
    return token;
  }

  remove(id: string): void {
    const engine = this.requireConsole(id);
    this.store?.db.prepare("DELETE FROM engines WHERE id=?").run(id);
    engine.retire();
    this.engines.delete(id);
    this.apis.delete(id);
  }

  enrollmentStatus(id: string): "awaiting_heartbeat" | "connected" {
    return this.require(id).lastSeenAt === null ? "awaiting_heartbeat" : "connected";
  }

  heartbeat(id: string, engineVersion?: string, reportedHardware?: unknown): void {
    const engine = this.require(id);
    const updated = { ...engine, lastSeenAt: this.now(), engineVersion: engineVersion ?? engine.engineVersion, hardware: parseHardware(reportedHardware) ?? engine.hardware };
    Object.assign(engine, updated);
    try { this.persist(updated); }
    catch {
      this.storageHealth = false;
      try { this.logger("Console Engine heartbeat persistence failed"); } catch { /* Keep heartbeats available. */ }
    }
  }

  private require(id: string): RegisteredEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new RegistryError(404, "Unknown device", "DEVICE_NOT_FOUND");
    return engine;
  }

  private requireConsole(id: string): RegisteredEngine {
    const engine = this.require(id);
    if (engine.origin === "seed") throw new RegistryError(409, "Engine is managed by Gateway configuration", "ENGINE_CONFIG_MANAGED");
    return engine;
  }

  private validateName(name: string): void {
    if (!name.trim() || [...name].length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new RegistryError(400, "Invalid display name", "INVALID_DISPLAY_NAME");
  }

  private attach(registration: EngineRegistration): void {
    const runtime = this.createRuntime(registration, presented => this.verifyToken(registration.id, presented));
    this.engines.set(registration.id, { ...registration, ...runtime });
    this.apis.set(registration.id, runtime.api);
  }

  private persist(engine: EngineRegistration): void {
    this.store?.db.prepare(`INSERT INTO engines (id, display_name, token_digest, origin, created_at, device_override, hardware, last_seen_at, engine_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      display_name=excluded.display_name, token_digest=excluded.token_digest, origin=excluded.origin,
      device_override=excluded.device_override, hardware=excluded.hardware, last_seen_at=excluded.last_seen_at, engine_version=excluded.engine_version`).run(
      engine.id, engine.displayName, engine.tokenDigest, engine.origin, engine.createdAt,
      engine.deviceOverride ? JSON.stringify(engine.deviceOverride) : null, engine.hardware ? JSON.stringify(engine.hardware) : null,
      engine.lastSeenAt, engine.engineVersion,
    );
  }

  verifyToken(id: string, presented: string): boolean {
    const expected = this.engines.get(id)?.tokenDigest;
    if (!expected) return false;
    const actual = Buffer.from(tokenDigest(presented), "hex");
    const required = Buffer.from(expected, "hex");
    return actual.length === required.length && timingSafeEqual(actual, required);
  }

  authenticate(presented: string): RegisteredEngine | undefined {
    return [...this.engines.values()].find(engine => this.verifyToken(engine.id, presented));
  }
}

export class RegistryError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}
