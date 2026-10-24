import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import { api, ApiError } from "./api";
import * as store from "./store";
import { snapshot } from "./test-fixture";
import { setLang } from "./i18n";
import { en } from "./i18n/en";
import { zhCN } from "./i18n/zh-CN";
import { AuthScreen, ReauthDialog } from "./Auth";
import { Overview, ClientsView, SettingsView, SkillsView } from "./Views";
import { AddDevice, DevicesView } from "./Devices";
import { TopologyView } from "./Topology";
import { ActivityView, ActivityTable } from "./Activity";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
function assertNoEnglishUI(english: object = en, chinese: object = zhCN): void {
  for (const [key, value] of Object.entries(english)) {
    const translated = (chinese as Record<string, unknown>)[key];
    if (typeof value === "object")
      assertNoEnglishUI(value, translated as object);
    else if (value !== translated && !value.includes("{{"))
      expect(screen.queryAllByText(value, { exact: true }), value).toHaveLength(
        0,
      );
  }
}

it("renders Chinese navigation and reconnect status", async () => {
  setLang("zh-CN");
  history.replaceState(null, "", "/console/overview");
  vi.mocked(api).mockResolvedValue({ authenticated: true });
  vi.spyOn(store, "useConsole").mockReturnValue({
    snapshot: snapshot(),
    lastEventId: 0,
    recent: [],
    connected: false,
  });
  vi.spyOn(store.consoleStore, "start").mockResolvedValue();
  vi.spyOn(store.consoleStore, "stop").mockImplementation(() => {});
  render(<App />);
  expect(
    await screen.findByRole("navigation", { name: "主导航" }),
  ).toBeVisible();
  for (const text of ["概览", "拓扑", "客户端", "设备", "活动", "技能", "设置"])
    expect(screen.getByRole("link", { name: new RegExp(text) })).toBeVisible();
  expect(screen.getByRole("button", { name: "退出登录" })).toBeVisible();
  expect(screen.getByText("正在重新连接")).toBeVisible();
  assertNoEnglishUI();
});

it.each([true, false])("renders Chinese authentication (setup=%s)", (setup) => {
  setLang("zh-CN");
  render(<AuthScreen setup={setup} onAuthenticated={() => {}} />);
  expect(
    screen.getByRole("heading", { name: setup ? "设置 Gateway" : "登录" }),
  ).toBeVisible();
  expect(screen.getByLabelText(setup ? "设置令牌" : "密码")).toBeVisible();
  assertNoEnglishUI();
});
it("renders the reauthentication dialog in Chinese", () => {
  setLang("zh-CN");
  render(<ReauthDialog onConfirm={async () => {}} onCancel={() => {}} />);
  expect(screen.getByRole("dialog", { name: "确认身份" })).toBeVisible();
  expect(screen.getByRole("button", { name: "确认" })).toBeVisible();
});

it.each([
  [Overview, "最近活动"],
  [ClientsView, "客户端身份与权限"],
  [SettingsView, "设置"],
  [SkillsView, "技能"],
] as const)(
  "renders a complete Chinese view: %s",
  async (Component, heading) => {
    setLang("zh-CN");
    vi.mocked(api).mockResolvedValue({ clients: [] });
    render(
      <Component
        snapshot={snapshot()}
        sensitive={async (operation) => operation()}
      />,
    );
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    await act(async () => {});
    assertNoEnglishUI();
  },
);

it("walks all four enrollment steps in Chinese without translating device data", async () => {
  setLang("zh-CN");
  vi.mocked(api).mockResolvedValue({ token: "test-one-time-token" });
  vi.spyOn(store.consoleStore, "refresh").mockResolvedValue();
  const data = snapshot();
  data.engines = [];
  render(
    <AddDevice
      snapshot={data}
      sensitive={async (operation) => operation()}
      onClose={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("设备名称"), {
    target: { value: "nas-01" },
  });
  expect(screen.getByLabelText("设备 ID")).toHaveValue("nas-01");
  fireEvent.click(screen.getByRole("button", { name: "选择平台 →" }));
  expect(screen.getByText("Engine 将在哪里运行？")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "注册设备 →" }));
  expect(await screen.findByLabelText("一次性 Engine 令牌")).toHaveValue(
    "test-one-time-token",
  );
  fireEvent.click(screen.getByRole("button", { name: "我已启动 Engine →" }));
  expect(screen.getByRole("heading", { name: "等待首次心跳" })).toBeVisible();
  expect(
    screen.queryByText("Waiting for the first heartbeat"),
  ).not.toBeInTheDocument();
});

it("renders Chinese topology lanes, stages and linked drawers", () => {
  setLang("zh-CN");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render(
    <TopologyView
      snapshot={snapshot()}
      events={[]}
      sensitive={async (operation) => operation()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "客户端 → Gateway → Engine" }),
  ).toBeVisible();
  expect(screen.getByText("身份验证")).toBeVisible();
  fireEvent.click(screen.getByText("Test client 1"));
  expect(screen.getByRole("dialog", { name: "客户端详情" })).toBeVisible();
  expect(screen.getByText("5 次调用 · 1 次错误")).toBeVisible();
  expect(screen.queryByText("Client details")).not.toBeInTheDocument();
});

it("restores untranslated URL filters in a Chinese Activity view after remount", async () => {
  setLang("zh-CN");
  history.replaceState(
    null,
    "",
    "/console/activity?engineId=engine-a&methodClass=read&outcome=denied",
  );
  vi.mocked(api).mockResolvedValue({ rows: [], cursor: null });
  const view = render(<ActivityView snapshot={snapshot()} />);
  expect(screen.getByLabelText("筛选设备")).toHaveValue("engine-a");
  expect(screen.getByLabelText("类别")).toHaveValue("read");
  await act(async () => {});
  view.unmount();
  render(<ActivityView snapshot={snapshot()} />);
  expect(screen.getByLabelText("结果")).toHaveValue("denied");
  expect(screen.getByRole("link", { name: "导出 CSV" })).toHaveAttribute(
    "href",
    expect.stringContaining("methodClass=read&outcome=denied"),
  );
  await act(async () => {});
  expect(screen.queryByText("All devices")).not.toBeInTheDocument();
});

it("switches sign-in language without losing the typed password", () => {
  render(<AuthScreen setup={false} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "in-memory-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "中" }));
  expect(screen.getByLabelText("密码")).toHaveValue("in-memory-password");
  expect(screen.getByRole("group", { name: "语言" })).toBeVisible();
  expect(screen.getByRole("button", { name: "中" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("heading", { name: "登录" })).toBeVisible();
});
it("switches Settings language locally with stale authentication", () => {
  const sensitive = vi.fn();
  vi.mocked(api).mockClear();
  render(
    <SettingsView
      snapshot={{ ...snapshot(), ts: Date.now() - 11 * 60_000 }}
      sensitive={sensitive}
    />,
  );
  fireEvent.change(screen.getByLabelText("Language"), {
    target: { value: "zh-CN" },
  });
  expect(screen.getByLabelText("语言")).toHaveValue("zh-CN");
  expect(sensitive).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("switches an already displayed known error and health warnings", async () => {
  vi.mocked(api).mockRejectedValue(
    new (await import("./api")).ApiError(
      "Invalid credentials",
      401,
      "INVALID_CREDENTIALS",
    ),
  );
  render(<AuthScreen setup={false} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "in-memory-password" },
  });
  fireEvent.change(screen.getByLabelText("Authenticator or recovery code"), {
    target: { value: "wrong" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Sign in →" }).closest("form")!,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid credentials",
  );
  fireEvent.click(screen.getByRole("button", { name: "中" }));
  expect(screen.getByRole("alert")).toHaveTextContent("密码或验证码错误");
});

it("renders the Chinese device list and drawer without English UI", () => {
  setLang("zh-CN");
  const data = snapshot();
  render(
    <DevicesView
      snapshot={data}
      sensitive={async (operation) => operation()}
      onAdd={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Example device/ }));
  expect(
    screen.getByRole("dialog", { name: "设备 Example device" }),
  ).toBeVisible();
  expect(screen.getByText("工作区与执行")).toBeVisible();
  assertNoEnglishUI();
});
it("renders the Chinese Gateway drawer and health warnings", () => {
  setLang("zh-CN");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const data = snapshot();
  data.gateway.warnings = [
    en.common.httpWarning,
    en.common.proxyWarning,
    "Audit storage failure: /tmp/example",
  ];
  data.gateway.warningDetails = [
    {
      code: "INSECURE_HTTP",
      message: "HTTP warning with changed punctuation!",
    },
    {
      code: "NO_TRUSTED_PROXIES",
      message: "Proxy warning with changed wording.",
    },
    {
      code: "AUDIT_STORAGE_FAILURE",
      message: "Storage unavailable!",
      params: { path: "/tmp/example" },
    },
  ];
  render(
    <TopologyView
      snapshot={data}
      events={[]}
      sensitive={async (operation) => operation()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /reach-gateway/ }));
  expect(screen.getByRole("dialog", { name: "Gateway 详情" })).toBeVisible();
  expect(screen.getByText("审计存储故障：/tmp/example")).toBeVisible();
  assertNoEnglishUI();
});

it("translates event result labels while preserving protocol identifiers", () => {
  setLang("zh-CN");
  render(
    <ActivityTable rows={[{ id: 1, ts: 1000, type: "client.connected" }]} />,
  );
  expect(screen.getByText("client.connected")).toBeVisible();
  expect(screen.getByText("已连接")).toBeVisible();
  assertNoEnglishUI();
});

it.each(["theme", "activity"])(
  "switches an existing %s request error to the active language",
  async (view) => {
    vi.mocked(api).mockRejectedValue(
      new ApiError("Invalid console request", 400, "INVALID_REQUEST"),
    );
    if (view === "theme") {
      render(
        <SettingsView
          snapshot={snapshot()}
          sensitive={async (operation) => operation()}
        />,
      );
      fireEvent.change(screen.getByLabelText("Theme"), {
        target: { value: "dark" },
      });
    } else {
      history.replaceState(null, "", "/console/activity");
      render(<ActivityView snapshot={snapshot()} />);
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid console request",
    );
    act(() => setLang("zh-CN"));
    expect(screen.getByRole("alert")).toHaveTextContent("控制台请求无效");
  },
);

it("preserves unknown denial stages and strips prefixes from unknown event results", () => {
  setLang("zh-CN");
  render(
    <ActivityTable
      rows={[
        { id: 1, ts: 1000, type: "rpc.denied", stage: "quota", code: "LIMIT" },
        { id: 2, ts: 1001, eventType: "foo.failed" },
        { id: 3, ts: 1002, type: "rpc.denied", stage: "constructor" },
      ]}
    />,
  );
  expect(screen.getByText("已拒绝 · quota (LIMIT)")).toBeVisible();
  expect(screen.getByText("已拒绝 · constructor")).toBeVisible();
  expect(screen.getByText("failed")).toBeVisible();
  expect(screen.getByText("foo.failed")).toBeVisible(); // Protocol type column stays verbatim.
});

// Lays out the tab row as 300 px wide with the current tab at 400–460 px, and
// records scrolling so tests can tell row scrolling from page scrolling.
function overflowingTabs() {
  const pageScroll = vi.fn();
  const restore = [
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const scrolled = this.closest("ul")?.scrollLeft ?? 0;
        const [left, right] =
          this.tagName === "UL"
            ? [0, 300]
            : this.getAttribute("aria-current") === "page"
              ? [400 - scrolled, 460 - scrolled]
              : [0, 0];
        return new DOMRect(left, 0, right - left, 20);
      },
    ),
  ];
  const offsets = new WeakMap<Element, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      offsets.set(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: pageScroll,
  });
  return {
    pageScroll,
    restore() {
      for (const spy of restore) spy.mockRestore();
      delete (HTMLElement.prototype as { scrollLeft?: unknown }).scrollLeft;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    },
  };
}

it("keeps language in the page header and Gateway status in navigation and reveals the active tab", async () => {
  history.replaceState(null, "", "/console/devices");
  vi.mocked(api).mockResolvedValue({ authenticated: true });
  vi.spyOn(store, "useConsole").mockReturnValue({
    snapshot: snapshot(),
    lastEventId: 0,
    recent: [],
    connected: false,
  });
  vi.spyOn(store.consoleStore, "start").mockResolvedValue();
  vi.spyOn(store.consoleStore, "stop").mockImplementation(() => {});
  const tabs = overflowingTabs();
  try {
    const view = render(<App />);
    await screen.findByRole("navigation");
    expect(
      view.container.querySelector("header.topbar .language-toggle"),
    ).toBeInTheDocument();
    const nav = view.container.querySelector("nav")!;
    expect(nav.querySelector(".language-toggle")).not.toBeInTheDocument();
    expect(nav).toHaveTextContent("Gateway v1.0");
    expect(nav).toHaveTextContent("Reconnecting");
    expect(
      view.container.querySelector("header.topbar"),
    ).not.toHaveTextContent("Gateway v");
    expect(
      view.container.querySelector("header.topbar .pill"),
    ).not.toBeInTheDocument();
    const list = nav.querySelector("ul")!;
    list.scrollLeft = 0;
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(list.scrollLeft).toBe(160);
    expect(tabs.pageScroll).not.toHaveBeenCalled();
  } finally {
    tabs.restore();
  }
});

it("reveals the current tab again when item widths change without scrolling the page", async () => {
  history.replaceState(null, "", "/console/settings");
  vi.mocked(api).mockResolvedValue({ authenticated: true });
  vi.spyOn(store, "useConsole").mockReturnValue({
    snapshot: snapshot(),
    lastEventId: 0,
    recent: [],
    connected: true,
  });
  vi.spyOn(store.consoleStore, "start").mockResolvedValue();
  vi.spyOn(store.consoleStore, "stop").mockImplementation(() => {});
  let resized!: ResizeObserverCallback;
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resized = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const tabs = overflowingTabs();
  try {
    render(<App />);
    const nav = await screen.findByRole("navigation");
    const list = nav.querySelector("ul")!;
    list.scrollLeft = 0;
    act(() => resized([], {} as ResizeObserver));
    expect(list.scrollLeft).toBe(160);
    list.scrollLeft = 0;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(list.scrollLeft).toBe(160);
    expect(tabs.pageScroll).not.toHaveBeenCalled();
  } finally {
    globalThis.ResizeObserver = previousObserver;
    tabs.restore();
  }
});
