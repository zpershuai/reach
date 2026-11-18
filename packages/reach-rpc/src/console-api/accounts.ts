import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ConsoleError, profile, type ConsoleAuth, type ConsoleSession } from "./auth.js";
import { hashPassword, newTotpSecret, normalizeUsername, userRoles, validPassword, verifyTotp, type UserRole } from "./credentials.js";
import { readJsonBody, sendJson } from "./http.js";

const userPatch = z.object({ role: z.enum(userRoles as [UserRole, ...UserRole[]]).optional(), disabled: z.boolean().optional() }).strict()
  .refine(value => value.role !== undefined || value.disabled !== undefined);

/** Console routes that are always open to every signed-in role. */
export function isSelfServiceRoute(path: string): boolean { return path.startsWith("account/"); }

/** Account routes whose mutations need recent re-authentication. A password change checks the current password instead. */
export function accountRouteNeedsRecent(path: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return path === "users" || path.startsWith("users/") || path.startsWith("account/totp");
}

function password(value: unknown): string {
  if (!validPassword(value)) throw new ConsoleError(400, "Password must contain 12 to 1024 characters", "PASSWORD_LENGTH");
  return value;
}

/** User management (`users*`, admins only) and self-service (`account/*`, every role). */
export class AccountRoutes {
  constructor(private readonly auth: ConsoleAuth, private readonly now = Date.now) {}

  /**
   * `authorize` re-checks the session and role. It runs after every await (body read, password hashing)
   * so a session revoked or demoted while this request was in flight cannot still write.
   */
  async handle(path: string, request: IncomingMessage, response: ServerResponse, session: ConsoleSession, authorize: () => ConsoleSession): Promise<boolean> {
    const method = request.method;
    const users = this.auth.users;
    const act = (action: string): void => this.auth.action(action, session.user);
    const read = async (): Promise<unknown> => { const value = await readJsonBody(request); authorize(); return value; };
    const hash = async (value: string): Promise<string> => { const hashed = await hashPassword(value); authorize(); return hashed; };
    if (path === "users") {
      if (method === "GET") { sendJson(response, 200, { users: users.list() }); return true; }
      if (method === "POST") {
        const body = z.object({ username: z.unknown(), password: z.unknown(), role: z.enum(userRoles as [UserRole, ...UserRole[]]) }).strict().parse(await read());
        const username = normalizeUsername(body.username);
        if (!username) throw new ConsoleError(400, "Username must be 3 to 64 letters, digits, '.', '_' or '-'", "USERNAME_INVALID");
        const user = users.create(username, await hash(password(body.password)), body.role);
        act(`user.create:${user.username}`);
        sendJson(response, 201, { user }); return true;
      }
      return false;
    }
    const userRoute = /^users\/(\d+)(?:\/(password|totp))?$/.exec(path);
    if (userRoute) {
      const id = Number(userRoute[1]);
      const target = users.get(id);
      if (!target) throw new ConsoleError(404, "Unknown user", "USER_NOT_FOUND");
      if (method === "PATCH" && !userRoute[2]) {
        const patch = userPatch.parse(await read());
        const user = users.update(id, patch);
        if (patch.role !== undefined && patch.role !== target.role) act(`user.role.${patch.role}:${user.username}`);
        if (patch.disabled !== undefined && patch.disabled !== target.disabled) act(`user.${patch.disabled ? "disable" : "enable"}:${user.username}`);
        sendJson(response, 200, { user }); return true;
      }
      if (method === "POST" && userRoute[2] === "password") {
        const body = z.object({ password: z.unknown() }).strict().parse(await read());
        const user = users.setPassword(id, await hash(password(body.password)));
        act(`user.password:${user.username}`);
        sendJson(response, 200, { user }); return true;
      }
      if (method === "DELETE" && userRoute[2] === "totp") {
        const user = users.disableTotp(id);
        act(`user.totp.remove:${user.username}`);
        sendJson(response, 200, { user }); return true;
      }
      if (method === "DELETE" && !userRoute[2]) {
        const user = users.delete(id);
        act(`user.delete:${user.username}`);
        sendJson(response, 200, { deleted: user.id }); return true;
      }
      return false;
    }
    if (path === "account/password" && method === "POST") {
      const body = z.object({ current: z.unknown(), password: z.unknown() }).strict().parse(await read());
      const next = password(body.password);
      await this.auth.confirmPassword(request, session, body.current, "/api/console/account/password");
      users.setPassword(session.user.id, await hash(next), { keepSession: session.digest });
      act("account.password");
      sendJson(response, 200, { user: profile(users.get(session.user.id)!) }); return true;
    }
    if (path === "account/totp/begin" && method === "POST") {
      if (session.user.totpEnabled) throw new ConsoleError(409, "Authenticator already enabled", "TOTP_ALREADY_ENABLED");
      const secret = newTotpSecret();
      this.auth.setPendingTotp(session, secret);
      const label = encodeURIComponent(`Reach:${session.user.username}`);
      sendJson(response, 200, { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Reach&algorithm=SHA1&digits=6&period=30` });
      return true;
    }
    if (path === "account/totp/confirm" && method === "POST") {
      const body = z.object({ code: z.string().max(32) }).strict().parse(await read());
      if (session.user.totpEnabled) throw new ConsoleError(409, "Authenticator already enabled", "TOTP_ALREADY_ENABLED");
      const current = authorize();
      const secret = current.pendingTotpSecret;
      const step = secret ? verifyTotp(secret, body.code.replace(/\s+/g, ""), -1, this.now()) : undefined;
      if (step === undefined) throw new ConsoleError(400, "Authentication code did not match", "TOTP_CODE_INVALID");
      // Consumes the pending secret and enables TOTP atomically; a concurrent confirm or a newer enrolment loses.
      const recoveryCodes = users.enableTotp(session.user.id, secret!, step, session.digest);
      act("account.totp.enable");
      sendJson(response, 200, { user: profile(users.get(session.user.id)!), recoveryCodes }); return true;
    }
    if (path === "account/totp" && method === "DELETE") {
      const body = z.object({ code: z.string().max(32) }).strict().parse(await read());
      const peer = this.auth.peers.resolve(request);
      this.auth.checkLimit(peer);
      if (!users.credentials.acceptFactor(session.user.id, body.code.trim().replace(/\s+/g, "").toUpperCase(), this.now())) {
        this.auth.failed(peer, "/api/console/account/totp");
        throw new ConsoleError(401, "Invalid credentials", "INVALID_CREDENTIALS");
      }
      users.disableTotp(session.user.id, session.digest);
      act("account.totp.disable");
      sendJson(response, 200, { user: profile(users.get(session.user.id)!) }); return true;
    }
    return false;
  }
}
