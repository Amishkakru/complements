import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  GUIDE_FIT_GAMMA,
  newGame,
  resolveRound,
  roundDurationSec,
  setPlannedRelease,
} from "../src/engine.ts";

const cfg = DEFAULT_CONFIG;
// The guide's worked example, reproduced with the guide-fitted gamma.
const guideCfg = { ...DEFAULT_CONFIG, demand: { ...DEFAULT_CONFIG.demand, gamma: GUIDE_FIT_GAMMA } };

const near = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${b} ± ${tol}, got ${a}`);

const hold = { release: false, price: 0 };
const play = (s: ReturnType<typeof newGame>, intelRel: boolean, msRel: boolean, c = cfg) =>
  resolveRound(c, s, {
    intel: { ...hold, release: intelRel, price: 400 },
    ms: { ...hold, release: msRel, price: 50 },
  });

test("with the guide-fitted gamma, reproduces the guide's example (rounds 0-3)", () => {
  let s = newGame(guideCfg);
  s = play(s, false, false, guideCfg); // r0
  s = play(s, true, false, guideCfg); // r1 Intel releases
  s = play(s, false, false, guideCfg); // r2
  s = play(s, false, true, guideCfg); // r3 MS releases
  const h = s.history;

  near(h[0].q, 5.0, 0.01);
  near(h[1].q, 9.82, 0.02);
  near(h[2].q, 8.33, 0.02);
  near(h[3].q, 17.86, 0.02);

  near(h[0].profit.ms, 250, 1);
  near(h[0].profit.intel, 1250, 1);
  near(h[1].profit.ms, 691, 2);
  near(h[1].profit.intel, 155, 5);
  near(h[2].profit.ms, 1010, 3);
  near(h[2].profit.intel, 2083, 5);
  near(h[3].profit.ms, -944, 3); // release wipes the base to "old" revenue
  near(h[3].profit.intel, 4464, 5);
});

test("release cost compounds per company", () => {
  let s = newGame();
  s = play(s, true, true);
  s = play(s, true, false);
  const h = s.history;
  near(h[0].releaseCost.intel, 2300, 0.01);
  near(h[1].releaseCost.intel, 2300 * (1 + cfg.releaseCostGrowth), 0.01);
  near(h[0].releaseCost.ms, 2300, 0.01);
});

test("installed base window is 5 rounds", () => {
  let s = newGame();
  for (let i = 0; i < 8; i++) s = play(s, false, false);
  const h = s.history;
  const expected = h.slice(2, 7).reduce((a, r) => a + r.q, 0);
  near(h[7].installedBase.newPCs + h[7].installedBase.oldPCs, expected, 1e-9);
});

test("cumulative profit compounds earlier rounds forward", () => {
  let s = newGame();
  for (let i = 0; i < 3; i++) s = play(s, false, false);
  const p = s.history.map((h) => h.profit.intel);
  const g = 1 + cfg.discountRate;
  near(s.sides.intel.cumProfit, p[0] * g * g + p[1] * g + p[2], 1e-6);
});

test("timeout defaults to no release and last price", () => {
  let s = newGame();
  s = resolveRound(cfg, s, { ms: { release: false, price: 80 } });
  assert.equal(s.history[0].prices.intel, 400);
  assert.equal(s.history[0].released.intel, false);
  assert.equal(s.history[0].timedOut.intel, true);
});

test("round timer shrinks and adds bonus after a release", () => {
  let s = newGame();
  const d0 = roundDurationSec(cfg, s);
  s = play(s, false, false);
  const d1 = roundDurationSec(cfg, s);
  s = play(s, true, false);
  const d2 = roundDurationSec(cfg, s);
  assert.equal(d0, cfg.timing.startSec);
  assert.ok(d1 < d0);
  assert.ok(d2 > d1 + 40);
});

test("planned releases are non-binding signals for future rounds only", () => {
  let s = newGame();
  s = setPlannedRelease(s, "intel", 0, true); // current round: ignored
  s = setPlannedRelease(s, "intel", 3, true);
  assert.deepEqual(s.sides.intel.plannedReleases, [3]);
  for (let i = 0; i < 4; i++) s = play(s, false, false);
  assert.deepEqual(s.sides.intel.plannedReleases, []);
});

test("default: a version only adds demand once both companies have it", () => {
  let s = newGame();
  s = play(s, false, false); // r0: 5.0M
  s = play(s, true, false); // r1: Intel alone -> no boost, and the OS keeps ageing
  s = play(s, false, false);
  s = play(s, false, true); // r3: MS matches -> same as the guide example
  const h = s.history;
  assert.ok(h[1].q < h[0].q, `solo release should not raise sales (${h[1].q} vs ${h[0].q})`);
  near(h[3].q, 17.86, 0.02);
});

test("default: synced releases beat the same releases out of step", async () => {
  const { report } = await import("../sim/coordination.ts");
  const r = report(cfg, 20, 5);
  assert.ok(r["MS lags 2"].joint < r.sync.joint * 0.92, "lagging 2 rounds should cost > 8%");
  assert.ok(r["MS lags 2"].ms < r.sync.ms && r["MS lags 2"].intel < r.sync.intel, "both firms lose from the lag");
  assert.ok(r["Intel alone"].intel < r.nobody.intel, "releasing alone should not pay");
});
