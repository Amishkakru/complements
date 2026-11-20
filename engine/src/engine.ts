// Core game engine: pure, deterministic, no I/O.
// Shared by the server (authoritative) and the browser (scratch pad what-ifs).

export type Role = "intel" | "ms";

export interface DemandParams {
  A0: number; // initial price intercept (max combined price), $
  Q0: number; // initial quantity intercept, MM PCs
  alpha: number; // demand boost per unit of tech level
  gamma: number; // value of a version lead the partner hasn't matched, vs a matched one (1 = full value, 0 = none, <0 = mismatch hurts demand)
  k: number; // how much of the boost moves the quantity intercept (k<1 => curve steepens)
  delta: number; // obsolescence: price-intercept drop per round of product age (summed over both products)
  rho: number; // diminishing returns: each further version adds rho x the previous version's boost (1 = linear)
}

export interface GameConfig {
  demand: DemandParams;
  intelMC: number; // constant
  releaseCost0: number; // $MM, same for both at start
  releaseCostGrowth: number; // e.g. 0.10 => each release makes the next 10% dearer
  msRevNewPC: number; // $ per installed PC running current OS
  msRevOldPC: number; // $ per installed PC running an older OS
  installedBaseWindow: number; // number of previous rounds counted in the installed base
  discountRate: number; // per round, e.g. 0.012
  initialPrices: Record<Role, number>;
  maxRounds: number;
  timing: { startSec: number; endSec: number; releaseBonusSec: number };
}

// alpha, gamma, delta, k are fitted so that, at a combined price of $450, the guide's example sequence
// start -> Intel releases -> no release -> MS releases sells 5.0 -> 9.82 -> 8.33 -> 17.86 MM PCs.
export const GUIDE_FIT_GAMMA = 0.3677;

// Default play uses gamma = 0: a new version only adds demand once both companies are on it.
// That makes coordinating releases pay (see sim/coordination.ts); fully synced play is unchanged,
// but a solo release no longer boosts sales on its own (the guide example's round 1 sells 4.2M, not 9.8M).
export const DEFAULT_CONFIG: GameConfig = {
  demand: { A0: 500, Q0: 50, alpha: 0.3338, gamma: 0, k: 0.5, delta: 0.0184, rho: 0.7 },
  intelMC: 150,
  releaseCost0: 2300,
  releaseCostGrowth: 0.2,
  msRevNewPC: 40,
  msRevOldPC: 20,
  installedBaseWindow: 5,
  discountRate: 0.012,
  initialPrices: { intel: 400, ms: 50 },
  maxRounds: 60,
  timing: { startSec: 150, endSec: 40, releaseBonusSec: 45 },
};

export interface SideState {
  version: number;
  lastReleaseRound: number;
  releases: number;
  price: number;
  cumProfit: number; // discounted (compounded forward) cumulative profit
  plannedReleases: number[]; // non-binding signals, visible to the opponent
}

export interface RoundResult {
  round: number;
  prices: Record<Role, number>;
  released: Record<Role, boolean>;
  versions: Record<Role, number>;
  q: number;
  installedBase: { newPCs: number; oldPCs: number };
  revenue: Record<Role, number>;
  releaseCost: Record<Role, number>;
  profit: Record<Role, number>;
  cumProfit: Record<Role, number>;
  timedOut: Record<Role, boolean>;
}

export interface GameState {
  round: number; // next round to be played (0-based)
  sides: Record<Role, SideState>;
  history: RoundResult[];
}

export interface Decision {
  release: boolean;
  price: number;
}

export function newGame(cfg: GameConfig = DEFAULT_CONFIG): GameState {
  const side = (r: Role): SideState => ({
    version: 1,
    lastReleaseRound: 0,
    releases: 0,
    price: cfg.initialPrices[r],
    cumProfit: 0,
    plannedReleases: [],
  });
  return { round: 0, sides: { intel: side("intel"), ms: side("ms") }, history: [] };
}

export function currentReleaseCost(cfg: GameConfig, s: SideState): number {
  return cfg.releaseCost0 * Math.pow(1 + cfg.releaseCostGrowth, s.releases);
}

/** Demand line for given versions/ages: price = A - (A/Q) * q */
export function demandCurve(
  cfg: GameConfig,
  versions: Record<Role, number>,
  ages: Record<Role, number>,
): { A: number; Q: number } {
  const d = cfg.demand;
  // Tech value of version v: each successive release is worth `rho` times the previous one.
  const T = (v: number) => (d.rho === 1 ? v - 1 : (1 - Math.pow(d.rho, v - 1)) / (1 - d.rho));
  const lo = T(Math.min(versions.intel, versions.ms));
  const hi = T(Math.max(versions.intel, versions.ms));
  const tech = lo + d.gamma * (hi - lo);
  const A = Math.max(0, d.A0 * (1 + d.alpha * tech - d.delta * (ages.intel + ages.ms)));
  const Q = d.Q0 * (1 + d.k * d.alpha * tech);
  return { A, Q };
}

export function quantity(curve: { A: number; Q: number }, combinedPrice: number): number {
  if (curve.A <= 0) return 0;
  return Math.max(0, curve.Q * (1 - combinedPrice / curve.A));
}

/** Versions and ages that would apply this round, given release choices. */
function roundTech(state: GameState, rel: Record<Role, boolean>) {
  const t = state.round;
  const versions = {
    intel: state.sides.intel.version + (rel.intel ? 1 : 0),
    ms: state.sides.ms.version + (rel.ms ? 1 : 0),
  };
  const ages = {
    intel: rel.intel ? 0 : t - state.sides.intel.lastReleaseRound,
    ms: rel.ms ? 0 : t - state.sides.ms.lastReleaseRound,
  };
  return { versions, ages };
}

/** MS installed base for the round: PCs sold in the previous `window` rounds, split by OS currency. */
function installedBase(cfg: GameConfig, state: GameState, msVersionNow: number) {
  let newPCs = 0;
  let oldPCs = 0;
  for (const h of state.history.slice(-cfg.installedBaseWindow)) {
    if (h.versions.ms === msVersionNow) newPCs += h.q;
    else oldPCs += h.q;
  }
  return { newPCs, oldPCs };
}

/** Pure preview of a round's outcome (used by the scratch pad and by resolveRound). */
export function previewRound(
  cfg: GameConfig,
  state: GameState,
  dec: Record<Role, Decision>,
): Omit<RoundResult, "cumProfit" | "timedOut"> {
  const rel = { intel: dec.intel.release, ms: dec.ms.release };
  const { versions, ages } = roundTech(state, rel);
  const curve = demandCurve(cfg, versions, ages);
  const q = quantity(curve, dec.intel.price + dec.ms.price);
  const base = installedBase(cfg, state, versions.ms);

  const releaseCost = {
    intel: rel.intel ? currentReleaseCost(cfg, state.sides.intel) : 0,
    ms: rel.ms ? currentReleaseCost(cfg, state.sides.ms) : 0,
  };
  const revenue = {
    intel: q * (dec.intel.price - cfg.intelMC),
    ms: q * dec.ms.price + base.newPCs * cfg.msRevNewPC + base.oldPCs * cfg.msRevOldPC,
  };
  return {
    round: state.round,
    prices: { intel: dec.intel.price, ms: dec.ms.price },
    released: rel,
    versions,
    q,
    installedBase: base,
    revenue,
    releaseCost,
    profit: { intel: revenue.intel - releaseCost.intel, ms: revenue.ms - releaseCost.ms },
  };
}

export function validateDecision(d: Decision): string | null {
  if (typeof d.release !== "boolean") return "release must be boolean";
  if (!Number.isFinite(d.price) || d.price < 0 || d.price > 100_000) return "price out of range";
  return null;
}

/** Default when a side times out: no release, last round's price. */
export function defaultDecision(state: GameState, role: Role): Decision {
  return { release: false, price: state.sides[role].price };
}

/** Authoritative round resolution. Returns a new state; does not mutate the input. */
export function resolveRound(
  cfg: GameConfig,
  state: GameState,
  submitted: Partial<Record<Role, Decision>>,
): GameState {
  if (state.round >= cfg.maxRounds) throw new Error("game over: max rounds reached");
  const dec: Record<Role, Decision> = {
    intel: submitted.intel ?? defaultDecision(state, "intel"),
    ms: submitted.ms ?? defaultDecision(state, "ms"),
  };
  for (const r of ["intel", "ms"] as Role[]) {
    const err = validateDecision(dec[r]);
    if (err) throw new Error(`${r}: ${err}`);
  }
  const p = previewRound(cfg, state, dec);
  const growth = 1 + cfg.discountRate;
  const cum = {
    intel: state.sides.intel.cumProfit * growth + p.profit.intel,
    ms: state.sides.ms.cumProfit * growth + p.profit.ms,
  };
  const t = state.round;
  const nextSide = (r: Role): SideState => {
    const s = state.sides[r];
    return {
      version: p.versions[r],
      lastReleaseRound: p.released[r] ? t : s.lastReleaseRound,
      releases: s.releases + (p.released[r] ? 1 : 0),
      price: dec[r].price,
      cumProfit: cum[r],
      plannedReleases: s.plannedReleases.filter((x) => x > t),
    };
  };
  return {
    round: t + 1,
    sides: { intel: nextSide("intel"), ms: nextSide("ms") },
    history: [
      ...state.history,
      { ...p, cumProfit: cum, timedOut: { intel: !submitted.intel, ms: !submitted.ms } },
    ],
  };
}

/** Non-binding release signal for a future round. */
export function setPlannedRelease(state: GameState, role: Role, round: number, on: boolean): GameState {
  if (round <= state.round) return state;
  const cur = new Set(state.sides[role].plannedReleases);
  if (on) cur.add(round);
  else cur.delete(round);
  return {
    ...state,
    sides: { ...state.sides, [role]: { ...state.sides[role], plannedReleases: [...cur].sort((a, b) => a - b) } },
  };
}

/** Round length shrinks exponentially from startSec to endSec; +bonus after any release. */
export function roundDurationSec(cfg: GameConfig, state: GameState): number {
  const { startSec, endSec, releaseBonusSec } = cfg.timing;
  const n = Math.max(1, cfg.maxRounds - 1);
  const base = startSec * Math.pow(endSec / startSec, Math.min(state.round, n) / n);
  const last = state.history[state.history.length - 1];
  const bonus = last && (last.released.intel || last.released.ms) ? releaseBonusSec : 0;
  return Math.round(base + bonus);
}
