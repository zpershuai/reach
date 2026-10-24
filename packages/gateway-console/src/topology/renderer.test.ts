import { afterEach, expect, it, vi } from "vitest";
import { createRenderer } from "./renderer";
import { bezier, type Geometry } from "./geometry";
import { ParticleScheduler } from "../particles";
import { setLang } from "../i18n";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reuses the aggregate count formatter across frames, updates language and leaves no stale tooltip", () => {
  let callback: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => { callback = next; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const fillText = vi.fn();
  const context = new Proxy({}, {
    get: (_, key) => key === "fillText" ? fillText : vi.fn(),
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as CanvasRenderingContext2D);
  const NativeNumberFormat = Intl.NumberFormat;
  const numberFormat = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) {
    return new NativeNumberFormat(locale, options);
  });
  const target = document.createElement("canvas");
  const scheduler = new ParticleScheduler();
  scheduler.particles.set("aggregate", {
    requestId: "aggregate", client: "test", engineId: "engine-a", methodClass: "read",
    started: 0, latency: 0, count: 1234, aggregate: true,
  });
  const geometry: Geometry = {
    w: 600, h: 300, gL: { x: 200, y: 150 }, gR: { x: 400, y: 150 },
    stageX: { auth: 250, policy: 300, route: 350 },
    clients: new Map([["controller-test", bezier({ x: 0, y: 0 }, { x: 200, y: 150 })]]),
    engines: new Map([["engine-a", bezier({ x: 400, y: 150 }, { x: 600, y: 300 })]]),
  };
  let paused = false;
  const renderer = createRenderer({
    target, getGeometry: () => geometry, getScheduler: () => scheduler,
    heartbeats: { current: [] }, isPaused: () => paused, pulse: () => {},
  })!;
  try {
    for (const now of [10, 20, 30]) callback!(now);
    expect(fillText).toHaveBeenCalledWith("1,234", expect.any(Number), expect.any(Number));
    expect(numberFormat).toHaveBeenCalledTimes(1);
    setLang("zh-CN");
    callback!(40);
    expect(numberFormat).toHaveBeenCalledTimes(2);
    expect(numberFormat).toHaveBeenLastCalledWith("zh-CN");
    paused = true;
    callback!(50);
    expect(target.title).toBe("");
    renderer.dispose();
    setLang("en");
    expect(numberFormat).toHaveBeenCalledTimes(2);
  } finally { renderer.dispose(); }
});
