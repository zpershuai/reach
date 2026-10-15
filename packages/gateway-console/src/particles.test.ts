import { expect, it } from "vitest";
import {
  linkState,
  ParticleScheduler,
  ROUTE,
  particleFrame,
  type Particle,
} from "./particles";
import { executionState, glyphKind, glyphKinds } from "./Glyph";
import { engine } from "./test-fixture";

it("maps every link state with a distinct non-color encoding", () => {
  expect(linkState("ready", true).className).toBe("ready");
  expect(linkState("ready", true).dash).toBeUndefined();
  expect(linkState("none", true).dash).toBe("6 7");
  for (const status of ["wanted", "pending", "connecting"])
    expect(linkState(status, true).className).toBe("connecting");
  expect(linkState("ready", false)).toMatchObject({
    className: "offline",
    dash: "1 7",
  });
});
it("schedules stage timing, latency dwell, response marks and policy stopping", () => {
  const particle: Particle = {
    requestId: "a",
    client: "Test",
    engineId: "engine-a",
    methodClass: "read",
    started: 0,
    latency: 200,
    outcome: "ok",
    count: 1,
  };
  expect(particleFrame(particle, 100).stage).toBe("auth");
  expect(particleFrame(particle, 550).stage).toBe("policy");
  expect(particleFrame(particle, 590).stage).toBe("route");
  expect(particleFrame(particle, 800).stage).toBe("engine");
  expect(particleFrame(particle, 1200)).toMatchObject({
    stage: "engine",
    progress: 1,
  });
  expect(particleFrame(particle, 1500).mark).toBe("hollow");
  expect(particleFrame({ ...particle, outcome: "error" }, 1500).mark).toBe(
    "diamond",
  );
  const denied = particleFrame(
    { ...particle, outcome: "denied", stage: "policy" },
    500,
  );
  expect(denied).toMatchObject({
    progress: ROUTE.policy,
    stage: "policy",
    mark: "denied",
  });
  expect(particleFrame(particle, 2300).done).toBe(true);
});
it("starts the return trip only after a late outcome arrives", () => {
  const particle: Particle = {
    requestId: "a",
    client: "Test",
    engineId: "engine-a",
    methodClass: "read",
    started: 0,
    latency: 9000,
    outcome: "ok",
    finishedAt: 9000,
    count: 1,
  };
  expect(particleFrame(particle, 8000)).toMatchObject({ stage: "engine" });
  expect(particleFrame(particle, 9100)).toMatchObject({
    stage: "return",
    done: false,
  });
});
it("creates no synthetic particles and aggregates links over twenty received events per second", () => {
  const scheduler = new ParticleScheduler();
  expect(scheduler.frames(100).length).toBe(0);
  for (let id = 1; id <= 40; id++)
    scheduler.accept(
      {
        id,
        ts: id,
        type: "rpc.started",
        engineId: "engine-a",
        requestId: String(id),
        caller: { type: "controller", label: "Test", verified: false },
      },
      10,
    );
  expect(
    scheduler.frames(100).filter((item) => item.particle.aggregate)[0].particle
      .count,
  ).toBe(40);
  expect(scheduler.particles.size).toBe(21);
  scheduler.accept({ id: 40, ts: 1, type: "rpc.started" }, 10);
  expect(scheduler.particles.size).toBe(21);
});
it("selects all glyphs, override precedence and the server fallback", () => {
  for (const kind of glyphKinds)
    expect(
      glyphKind({ ...engine, hardware: { ...engine.hardware!, kind } }),
    ).toBe(kind);
  expect(glyphKind({ ...engine, hardware: null })).toBe("server");
  expect(
    glyphKind({
      ...engine,
      hardware: { ...engine.hardware!, kind: "unknown" },
    }),
  ).toBe("server");
  expect(
    glyphKind({ ...engine, deviceOverride: { kind: "nas", model: "NAS" } }),
  ).toBe("nas");
  expect(executionState("scripts", ["scripts"])).toBe("enabled");
  expect(executionState("scripts", [])).toBe("disabled");
  expect(executionState("scripts", undefined)).toBe("not reported");
});

it("keeps identical request ids on different Engine links independent", () => {
  const scheduler = new ParticleScheduler();
  scheduler.accept(
    {
      id: 1,
      ts: 1,
      type: "rpc.started",
      requestId: "same",
      engineId: "engine-a",
    },
    0,
  );
  scheduler.accept(
    {
      id: 2,
      ts: 1,
      type: "rpc.started",
      requestId: "same",
      engineId: "engine-b",
    },
    0,
  );
  scheduler.accept(
    {
      id: 3,
      ts: 1,
      type: "rpc.finished",
      requestId: "same",
      engineId: "engine-b",
      outcome: "ok",
    },
    50,
  );
  expect(
    scheduler
      .frames(100)
      .map((item) => [item.particle.engineId, item.particle.outcome]),
  ).toEqual([
    ["engine-a", undefined],
    ["engine-b", "ok"],
  ]);
});
