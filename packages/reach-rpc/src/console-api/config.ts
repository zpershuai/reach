import { ConfigurationError } from "../diagnostics.js";
export interface ConsoleConfig {
  dataDir: string;
  publicOrigin: string;
  setupToken?: string;
  trustedProxies: string[];
  retentionDays: number;
}

export function parseConsoleConfig(env: NodeJS.ProcessEnv, host: string, port: number): ConsoleConfig | undefined {
  const retention = env.REACH_AUDIT_RETENTION_DAYS ?? "30";
  const retentionDays = Number(retention);
  if (!/^\d+$/.test(retention) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new ConfigurationError("REACH_AUDIT_RETENTION_DAYS must be an integer between 1 and 365");
  }
  if (env.REACH_DATA_DIR === undefined) return undefined;
  const dataDir = env.REACH_DATA_DIR.trim();
  if (!dataDir) throw new ConfigurationError("REACH_DATA_DIR must name a writable directory");
  if (!env.REACH_PUBLIC_ORIGIN && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new ConfigurationError("The console requires REACH_PUBLIC_ORIGIN for a non-loopback Gateway");
  }
  const publicOrigin = env.REACH_PUBLIC_ORIGIN ?? `http://${host === "::1" ? "[::1]" : host}:${port}`;
  const parsed = new URL(publicOrigin);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== publicOrigin) {
    throw new ConfigurationError("REACH_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials");
  }
  return {
    dataDir,
    publicOrigin,
    setupToken: env.REACH_ADMIN_SETUP_TOKEN,
    trustedProxies: (env.REACH_TRUSTED_PROXIES ?? "").split(",").map(value => value.trim()).filter(Boolean),
    retentionDays,
  };
}
