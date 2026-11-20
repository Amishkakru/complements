// Sweep diminishing returns (rho) x release-cost growth: best coordinated release interval by horizon.
import { DEFAULT_CONFIG, newGame, resolveRound, demandCurve, type GameConfig } from "../src/engine.ts";
function run(cfg: GameConfig, rounds: number, n: number) {
  let s = newGame(cfg);
  for (let t = 0; t < rounds; t++) {
    const r = t > 0 && t % n === 0;
    const versions = { intel: s.sides.intel.version + +r, ms: s.sides.ms.version + +r };
    const ages = { intel: r ? 0 : t - s.sides.intel.lastReleaseRound, ms: r ? 0 : t - s.sides.ms.lastReleaseRound };
    const { A } = demandCurve(cfg, versions, ages);
    const pI = Math.max(cfg.intelMC, (A - s.sides.ms.price + cfg.intelMC) / 2);
    const pM = Math.max(0, (A - s.sides.intel.price) / 2);
    s = resolveRound(cfg, s, { intel: { release: r, price: pI }, ms: { release: r, price: pM } });
  }
  return s.sides.intel.cumProfit + s.sides.ms.cumProfit;
}
for (const rho of [0.7, 0.8, 0.85, 0.9]) for (const g of [0.1, 0.2]) {
  const cfg = { ...DEFAULT_CONFIG, releaseCostGrowth: g, demand: { ...DEFAULT_CONFIG.demand, rho } };
  const line = [20, 30, 45, 60].map((R) => {
    const res = Array.from({ length: 20 }, (_, i) => i + 1).map((n) => ({ n, v: run(cfg, R, n) }));
    const best = res.reduce((a, b) => (b.v > a.v ? b : a));
    return `R=${R}: every ${String(best.n).padStart(2)} (${(best.v / 1000).toFixed(0)}k, never ${(run(cfg, R, 1e3) / 1000).toFixed(0)}k)`;
  });
  console.log(`rho ${rho} g ${g}:`, line.join(" | "));
}
