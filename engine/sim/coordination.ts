// How much does coordinating releases pay? Controlled comparison with identical release frequency.
// Run: node --experimental-strip-types sim/coordination.ts
import { DEFAULT_CONFIG, newGame, resolveRound, demandCurve, type GameConfig, type Role, type GameState } from "../src/engine.ts";

export type Policy = (t: number, r: Role) => boolean;

function price(cfg: GameConfig, s: GameState, role: Role, rel: Record<Role, boolean>) {
  const versions = { intel: s.sides.intel.version + +rel.intel, ms: s.sides.ms.version + +rel.ms };
  const ages = { intel: rel.intel ? 0 : s.round - s.sides.intel.lastReleaseRound, ms: rel.ms ? 0 : s.round - s.sides.ms.lastReleaseRound };
  const { A } = demandCurve(cfg, versions, ages);
  const other = role === "intel" ? s.sides.ms.price : s.sides.intel.price;
  const mc = role === "intel" ? cfg.intelMC : 0;
  return Math.max(mc, (A - other + mc) / 2);
}

export function play(cfg: GameConfig, rounds: number, pol: Policy) {
  let s = newGame(cfg);
  for (let t = 0; t < rounds; t++) {
    const rel = { intel: pol(t, "intel"), ms: pol(t, "ms") };
    s = resolveRound(cfg, s, { intel: { release: rel.intel, price: price(cfg, s, "intel", rel) }, ms: { release: rel.ms, price: price(cfg, s, "ms", rel) } });
  }
  return { intel: s.sides.intel.cumProfit, ms: s.sides.ms.cumProfit, joint: s.sides.intel.cumProfit + s.sides.ms.cumProfit };
}

export function report(cfg: GameConfig, rounds = 30, n = 5) {
  const sync = play(cfg, rounds, (t) => t > 0 && t % n === 0);
  const lag = (k: number): Policy => (t, r) => (r === "intel" ? t > 0 && t % n === 0 : t > k && (t - k) % n === 0);
  const rows: Record<string, ReturnType<typeof play>> = { sync };
  for (const k of [1, 2, 3]) rows[`MS lags ${k}`] = play(cfg, rounds, lag(k));
  rows["Intel alone"] = play(cfg, rounds, (t, r) => r === "intel" && t > 0 && t % n === 0);
  rows["MS alone"] = play(cfg, rounds, (t, r) => r === "ms" && t > 0 && t % n === 0);
  rows["nobody"] = play(cfg, rounds, () => false);
  return rows;
}

if (process.argv[1]?.endsWith("coordination.ts")) {
  for (const R of [20, 35]) {
    const rows = report(DEFAULT_CONFIG, R, 5);
    console.log(`\n${R} rounds, releases every 5 (current defaults)`);
    for (const [k, v] of Object.entries(rows))
      console.log(k.padEnd(12), `joint ${(v.joint / 1000).toFixed(0).padStart(6)}k  (${((100 * v.joint) / rows.sync.joint - 100).toFixed(0).padStart(4)}% vs sync)  intel ${(v.intel / 1000).toFixed(0).padStart(5)}k  ms ${(v.ms / 1000).toFixed(0).padStart(5)}k`);
  }
}
