import type { IncomingMessage } from "node:http";

export const en = {
  connect: "Connect to Reach Gateway",
  wants: "wants to use this Gateway's MCP tools. Select each Engine, workspace and operation you trust this application to use.",
  execution: "Execute runs trusted Node scripts with the Engine account's operating system privileges. It is not a sandbox. File write permission can change scripts that another trusted client may execute.",
  returnTo: "After approval you will return to",
  workspace: "Workspace", workspacePlaceholder: "Configured workspace name",
  read: "read", write: "write", execute: "execute",
  truncated: "Only the first {{count}} resource rows are shown. Approve with these, then add other resources from the console's Clients page.",
  noEngines: "No registered Engines. Register an Engine in the console first.",
  password: "Administrator password", code: "Authentication code or recovery code",
  approve: "Approve", deny: "Deny",
  wrongCode: "Password or authentication code is incorrect. Each code works once; wait for the next one if you just signed in.",
  invalidSelection: "Select registered Engines, workspace names and permissions. No access is selected by default.",
  tooMany: "Too many attempts", tooManyNote: "Too many failed approvals. Try again later.",
  unknownApp: "Unknown application", unknownAppNote: "This application is not registered with the Gateway. Remove and add the connector again.",
  invalidRedirect: "Invalid redirect", invalidRedirectNote: "The redirect URI does not match the application's registration.",
  notSetup: "Gateway not set up", notSetupNote: "Finish the Gateway console setup before connecting applications.",
  rejected: "Request rejected", rejectedNote: "The approval did not come from this Gateway's page.",
  expired: "Request expired", expiredNote: "This authorization request has expired. Start the connection again from the application.",
} as const;
export type MessageKey = keyof typeof en;
type Messages = { [K in MessageKey]: string };
export const zhCN: Messages = {
  connect: "连接到 Reach Gateway",
  wants: "想要使用此 Gateway 的 MCP 工具。请选择您信任此应用使用的 Engine、工作区和操作。",
  execution: "执行操作以 Engine 账户的操作系统权限运行可信 Node 脚本，并非沙箱。文件写入权限可修改其他可信客户端可能执行的脚本。",
  returnTo: "批准后将返回",
  workspace: "工作区", workspacePlaceholder: "配置的工作区名称",
  read: "读取", write: "写入", execute: "执行",
  truncated: "仅显示前 {{count}} 行资源。可先批准这些资源，再从控制台的客户端页面添加其他资源。",
  noEngines: "尚无已注册的 Engine。请先在控制台注册 Engine。",
  password: "管理员密码", code: "身份验证码或恢复码",
  approve: "批准", deny: "拒绝",
  wrongCode: "密码或身份验证码错误。每个验证码仅可使用一次；若刚刚登录，请等待下一个验证码。",
  invalidSelection: "请选择已注册的 Engine、工作区名称和权限。默认不选择任何访问权限。",
  tooMany: "尝试次数过多", tooManyNote: "批准失败次数过多，请稍后重试。",
  unknownApp: "未知应用", unknownAppNote: "此应用尚未在 Gateway 注册，请移除连接器后重新添加。",
  invalidRedirect: "重定向无效", invalidRedirectNote: "重定向 URI 与应用注册信息不符。",
  notSetup: "Gateway 尚未设置", notSetupNote: "请完成 Gateway 控制台设置后再连接应用。",
  rejected: "请求已拒绝", rejectedNote: "批准请求并非来自此 Gateway 的页面。",
  expired: "请求已过期", expiredNote: "此授权请求已过期，请从应用重新发起连接。",
};
export type Lang = "en" | "zh-CN";
export const messages: Record<Lang, Messages> = { en, "zh-CN": zhCN };

/** A supported console choice wins; untrusted cookie values are never rendered. */
export function resolveLang(request: Pick<IncomingMessage, "headers">): Lang {
  const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("reach_lang="))?.slice("reach_lang=".length);
  if (cookie === "en" || cookie === "zh-CN") return cookie;
  const header = request.headers["accept-language"];
  if (typeof header !== "string") return "en";
  const candidates = header.split(",").map((entry, order) => {
    const [tag, ...parameters] = entry.trim().split(";");
    let q = 1;
    if (parameters.length) {
      const match = parameters.length === 1 && /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameters[0].trim());
      q = match ? Number(match[1]) : 0;
    }
    return { tag: tag.trim(), q, order };
  }).filter(entry => entry.q > 0).sort((a, b) => b.q - a.q || a.order - b.order);
  for (const { tag } of candidates) {
    if (/^zh(?:-[a-z0-9]+)*$/i.test(tag)) return "zh-CN";
    if (/^en(?:-[a-z0-9]+)*$/i.test(tag)) return "en";
  }
  return "en";
}
