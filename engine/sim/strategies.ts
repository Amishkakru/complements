// Bot-vs-bot balance check: does coordinating releases beat going alone or never releasing?
// Run: node --experimental-strip-types sim/strategies.ts [rounds]
import { DEFAULT_CONFIG as cfg, newGame, resolveRound, demandCurve, type Role, type GameState } from "../src/engine.ts";

type ReleasePolicy = (round: number, role: Role) => boolean;
type PricePolicy = "fixed" | "bestResponse";

function bestResponsePrice(s: GameState, role: Role, release: Record<Role, boolean>): number {
  // Myopic: assume opponent keeps last price; maximise this round's margin on the linear demand.
  const versions = { intel: s.sides.intel.version + +release.intel, ms: s.sides.ms.version + +release.ms };
  const ages = {
    intel: release.intel ? 0 : s.round - s.sides.intel.lastReleaseRound,
    ms: release.ms ? 0 : s.round - s.sides.ms.lastReleaseRound,
  };
  const { A } = demandCurve(cfg, versions, ages);
  const other = role === "intel" ? s.sides.ms.price : s.sides.intel.price;
  const mc = role === "intel" ? cfg.intelMC : 0;
  return Math.max(mc, (A - other + mc) / 2);
}

function run(rounds: number, policy: ReleasePolicy, pricing: PricePolicy) {
  let s = newGame(cfg);
  for (let t = 0; t < rounds; t++) {
    const rel = { intel: policy(t, "intel"), ms: policy(t, "ms") };
    const price = (r: Role) => (pricing === "fixed" ? cfg.initialPrices[r] : bestResponsePrice(s, r, rel));
    s = resolveRound(cfg, s, {
      intel: { release: rel.intel, price: price("intel") },
      ms: { release: rel.ms, price: price("ms") },
    });
  }
  const releases = { intel: s.sides.intel.releases, ms: s.sides.ms.releases };
  return { intel: s.sides.intel.cumProfit, ms: s.sides.ms.cumProfit, releases, lastQ: s.history.at(-1)!.q };
}

const every = (n: number, offset = 0) => (t: number) => t > 0 && (t - offset) % n === 0 && t >= offset;
const policies: Record<string, ReleasePolicy> = {
  "never release": () => false,
  "coordinated every 4": (t) => every(4)(t),
  "coordinated every 6": (t) => every(6)(t),
  "coordinated every 8": (t) => every(8)(t),
  "coordinated every 5": (t) => every(5)(t),
  "staggered (Intel t, MS t+2) every 5": (t, r) => (r === "intel" ? every(5)(t) : every(5, 7)(t)),
  "Intel every 5, MS every 10": (t, r) => (r === "intel" ? every(5)(t) : every(10)(t)),
  "staggered (Intel t, MS t+1) every 6": (t, r) => (r === "intel" ? every(6)(t) : every(6, 7)(t)),
  "Intel every 6, MS never": (t, r) => r === "intel" && every(6)(t),
  "MS every 6, Intel never": (t, r) => r === "ms" && every(6)(t),
  "unsynced (Intel 5, MS 7)": (t, r) => (r === "intel" ? every(5)(t) : every(7)(t)),
  "release every round": (t) => t > 0,
};

const rounds = Number(process.argv[2] ?? 30);
const fmt = (x: number) => Math.round(x).toLocaleString("en-US").padStart(10);
for (const pricing of ["fixed", "bestResponse"] as PricePolicy[]) {
  console.log(`\n=== ${rounds} rounds, pricing: ${pricing} ===`);
  console.log("policy".padEnd(38), "Intel cum".padStart(10), "MS cum".padStart(10), "  total", " rel I/M", " final q");
  const rows = Object.entries(policies).map(([name, p]) => ({ name, ...run(rounds, p, pricing) }));
  rows.sort((a, b) => b.intel + b.ms - (a.intel + a.ms));
  for (const r of rows)
    console.log(
      r.name.padEnd(38),
      fmt(r.intel),
      fmt(r.ms),
      fmt(r.intel + r.ms),
      `  ${r.releases.intel}/${r.releases.ms}`.padEnd(8),
      r.lastQ.toFixed(1).padStart(7),
    );
}
