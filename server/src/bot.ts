// Stand-in player for a student without a partner. Deterministic given the game state.
import { demandCurve, type Decision, type GameConfig, type GameState, type Role } from "../../engine/src/engine.ts";

export const other = (r: Role): Role => (r === "intel" ? "ms" : "intel");

export interface BotMove {
  decision: Decision;
  plan: number | null; // future round to signal a release for, if any
}

export function botMove(cfg: GameConfig, state: GameState, role: Role): BotMove {
  const t = state.round;
  const me = state.sides[role];
  const them = state.sides[other(role)];
  const last = state.history[state.history.length - 1];
  const myAge = t - me.lastReleaseRound;

  // Cooperative style: honour the partner's signal, follow a partner's release, otherwise refresh every 5 rounds.
  const partnerPlansNow = them.plannedReleases.includes(t);
  const partnerJustReleased = !!last && last.released[other(role)] && !last.released[role];
  const release = t > 0 && (partnerPlansNow || (partnerJustReleased && myAge >= 2) || myAge >= 5);

  // Myopic best response on this round's demand line, assuming the partner keeps last price.
  const rel = { [role]: release, [other(role)]: partnerPlansNow } as Record<Role, boolean>;
  const versions = { intel: state.sides.intel.version + +rel.intel, ms: state.sides.ms.version + +rel.ms };
  const ages = {
    intel: rel.intel ? 0 : t - state.sides.intel.lastReleaseRound,
    ms: rel.ms ? 0 : t - state.sides.ms.lastReleaseRound,
  };
  const { A } = demandCurve(cfg, versions, ages);
  const mc = role === "intel" ? cfg.intelMC : 0;
  const price = Math.round(Math.max(mc, (A - them.price + mc) / 2));

  const nextPlanned = (release ? t : me.lastReleaseRound) + 5;
  const plan = nextPlanned > t && nextPlanned < cfg.maxRounds && !me.plannedReleases.includes(nextPlanned) ? nextPlanned : null;
  return { decision: { release, price }, plan };
}
