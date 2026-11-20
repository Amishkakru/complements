// Sweep gamma (value of a release the partner hasn't matched). Negative = being out of step hurts demand.
import { DEFAULT_CONFIG, newGame, resolveRound, type GameConfig } from "../src/engine.ts";
import { report } from "./coordination.ts";
const pct = (a: number, b: number) => `${((100 * a) / b - 100).toFixed(0)}%`.padStart(5);
console.log("gamma  |  R20: lag1 lag2 lag3 | lagger/leader lag1 | Intel-alone vs nobody (Intel) |  R35: lag1 lag2 lag3 | solo-release round q");
for (const gamma of [0.3677, 0.2, 0, -0.1, -0.2, -0.3, -0.4]) {
  const cfg: GameConfig = { ...DEFAULT_CONFIG, demand: { ...DEFAULT_CONFIG.demand, gamma } };
  const a = report(cfg, 20, 5), b = report(cfg, 35, 5);
  let s = newGame(cfg);
  s = resolveRound(cfg, s, { intel: { release: false, price: 400 }, ms: { release: false, price: 50 } });
  s = resolveRound(cfg, s, { intel: { release: true, price: 400 }, ms: { release: false, price: 50 } });
  console.log(
    String(gamma).padEnd(7), "|",
    pct(a["MS lags 1"].joint, a.sync.joint), pct(a["MS lags 2"].joint, a.sync.joint), pct(a["MS lags 3"].joint, a.sync.joint), " |",
    pct(a["MS lags 1"].ms, a.sync.ms), "/", pct(a["MS lags 1"].intel, a.sync.intel), "      |",
    pct(a["Intel alone"].intel, a.nobody.intel), "                       |",
    pct(b["MS lags 1"].joint, b.sync.joint), pct(b["MS lags 2"].joint, b.sync.joint), pct(b["MS lags 3"].joint, b.sync.joint), " |",
    s.history[1].q.toFixed(2),
  );
}
