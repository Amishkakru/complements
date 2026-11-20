// What each client gets to see. Built from session state; never mutates it.
import { currentReleaseCost, type Role } from "../../engine/src/engine.ts";
import { BOT, PHASES, type Game, type PhaseName, type Session } from "./session.ts";

const ROLES: Role[] = ["intel", "ms"];

function seatName(s: Session, seat: string) {
  return seat === BOT ? "Bot" : (s.players.get(seat)?.name ?? "?");
}

export interface RoleRow { teamCode: string; playerId: string; name: string; cumProfit: number; rounds: number }
export interface TeamRow { teamCode: string; intel: string; ms: string; joint: number; rounds: number }
export interface PhaseBoard { intel: RoleRow[]; ms: RoleRow[]; teams: TeamRow[] }
export interface OverallRow { playerId: string; name: string; score: number; intelPct: number | null; msPct: number | null }

export function phaseBoard(s: Session, phase: PhaseName): PhaseBoard {
  const games = [...s.games[phase].values()];
  const code = (g: Game) => s.teams.get(g.teamId)?.code ?? "?";
  const role = (r: Role): RoleRow[] =>
    games
      .filter((g) => g.seats[r] !== BOT)
      .map((g) => ({
        teamCode: code(g),
        playerId: g.seats[r],
        name: seatName(s, g.seats[r]),
        cumProfit: g.state.sides[r].cumProfit,
        rounds: g.state.round,
      }))
      .sort((a, b) => b.cumProfit - a.cumProfit);
  const teams = games
    .map((g) => ({
      teamCode: code(g),
      intel: seatName(s, g.seats.intel),
      ms: seatName(s, g.seats.ms),
      joint: g.state.sides.intel.cumProfit + g.state.sides.ms.cumProfit,
      rounds: g.state.round,
    }))
    .sort((a, b) => b.joint - a.joint);
  return { intel: role("intel"), ms: role("ms"), teams };
}

/** Each player's percentile within their role in Game 1 and Game 2, averaged. */
export function overallBoard(s: Session): OverallRow[] {
  const pct = new Map<string, { intel: number | null; ms: number | null }>();
  for (const phase of ["game1", "game2"] as PhaseName[]) {
    const b = phaseBoard(s, phase);
    for (const r of ROLES) {
      const rows = b[r];
      rows.forEach((row, i) => {
        const p = rows.length > 1 ? 100 * (1 - i / (rows.length - 1)) : 100;
        const cur = pct.get(row.playerId) ?? { intel: null, ms: null };
        cur[r] = p;
        pct.set(row.playerId, cur);
      });
    }
  }
  return [...pct.entries()]
    .map(([playerId, v]) => {
      const parts = [v.intel, v.ms].filter((x): x is number => x !== null);
      return {
        playerId,
        name: s.players.get(playerId)?.name ?? "?",
        score: parts.reduce((a, b) => a + b, 0) / parts.length,
        intelPct: v.intel,
        msPct: v.ms,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function gameView(s: Session, g: Game, role: Role, playerId: string) {
  const st = g.state;
  const base = { newPCs: 0, oldPCs: 0 };
  for (const h of st.history.slice(-g.cfg.installedBaseWindow)) {
    if (h.versions.ms === st.sides.ms.version) base.newPCs += h.q;
    else base.oldPCs += h.q;
  }
  const opp: Role = role === "intel" ? "ms" : "intel";
  const myRow = (b: PhaseBoard) => {
    const i = b[role].findIndex((r) => r.playerId === playerId);
    const ti = b.teams.findIndex((t) => t.teamCode === s.teams.get(g.teamId)?.code);
    return {
      rankInRole: i + 1,
      ofInRole: b[role].length,
      teamRank: ti + 1,
      ofTeams: b.teams.length,
      teamJoint: b.teams[ti]?.joint ?? 0,
    };
  };
  return {
    phase: g.phase,
    role,
    partnerName: seatName(s, g.seats[opp]),
    partnerIsBot: g.seats[opp] === BOT,
    round: st.round,
    over: g.over,
    deadline: g.remainingMs === null ? g.deadline : null,
    remainingMs: g.remainingMs,
    config: g.cfg,
    sides: {
      intel: { ...st.sides.intel, nextReleaseCost: currentReleaseCost(g.cfg, st.sides.intel) },
      ms: { ...st.sides.ms, nextReleaseCost: currentReleaseCost(g.cfg, st.sides.ms) },
    },
    installedBase: base,
    history: st.history,
    submitted: { intel: !!g.submissions.intel, ms: !!g.submissions.ms },
    mySubmission: g.submissions[role] ?? null,
    result: g.over ? myRow(phaseBoard(s, g.phase)) : null,
  };
}

export function playerView(s: Session, playerId: string, serverNow: number) {
  const p = s.players.get(playerId);
  if (!p || p.removed) return { removed: true as const, serverNow };
  const team = p.teamId ? s.teams.get(p.teamId) : undefined;
  const mate = team?.members.find((m) => m !== playerId);
  const gp = s.gameFor(playerId);
  return {
    serverNow,
    session: { code: s.code, status: s.status, phase: s.phase, nextPhase: PHASES.find((ph) => s.games[ph].size === 0) ?? null },
    you: { id: p.id, name: p.name },
    team: team
      ? { code: team.code, teammate: mate ? seatName(s, mate) : team.bot ? "Bot" : null }
      : null,
    game: gp ? gameView(s, gp.game, gp.role, playerId) : null,
  };
}

export function instructorView(s: Session, connected: Set<string>, serverNow: number) {
  const players = [...s.players.values()].filter((p) => !p.removed);
  const teams = [...s.teams.values()].filter((t) => t.members.length > 0);
  const boards = Object.fromEntries(PHASES.filter((ph) => s.games[ph].size > 0).map((ph) => [ph, phaseBoard(s, ph)]));
  return {
    serverNow,
    session: { code: s.code, status: s.status, phase: s.phase, played: PHASES.filter((ph) => s.games[ph].size > 0) },
    config: s.config,
    counts: {
      players: players.length,
      connected: players.filter((p) => connected.has(p.id)).length,
      teams: teams.filter((t) => t.members.length === 2 || t.bot).length,
      unpaired: players.filter((p) => !p.teamId || (s.teams.get(p.teamId)!.members.length === 1 && !s.teams.get(p.teamId)!.bot)).length,
    },
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.teamId ? s.teams.get(p.teamId)!.code : null,
      connected: connected.has(p.id),
    })),
    teams: teams.map((t) => ({ code: t.code, members: t.members.map((m) => seatName(s, m)), bot: t.bot })),
    games: s.currentGames().map((g) => ({
      team: s.teams.get(g.teamId)?.code ?? "?",
      intel: { name: seatName(s, g.seats.intel), connected: g.seats.intel === BOT || connected.has(g.seats.intel), submitted: !!g.submissions.intel, cum: g.state.sides.intel.cumProfit, version: g.state.sides.intel.version },
      ms: { name: seatName(s, g.seats.ms), connected: g.seats.ms === BOT || connected.has(g.seats.ms), submitted: !!g.submissions.ms, cum: g.state.sides.ms.cumProfit, version: g.state.sides.ms.version },
      round: g.state.round,
      over: g.over,
      hasBot: g.seats.intel === BOT || g.seats.ms === BOT,
      deadline: g.remainingMs === null ? g.deadline : null,
    })),
    boards,
    overall: s.games.game1.size + s.games.game2.size > 0 ? overallBoard(s) : [],
  };
}

/** Per-game summary for the debrief: how well each team coordinated releases, and what it earned. */
export function debriefData(s: Session) {
  const out: Record<string, unknown[]> = {};
  for (const phase of PHASES) {
    out[phase] = [...s.games[phase].values()].map((g) => {
      const h = g.state.history;
      const relI = h.filter((r) => r.released.intel).map((r) => r.round);
      const relM = h.filter((r) => r.released.ms).map((r) => r.round);
      // A release counts as coordinated when the other company released within one round of it.
      const near = (r: number, others: number[]) => others.some((o) => Math.abs(o - r) <= 1);
      const coordinated = relI.filter((r) => near(r, relM)).length + relM.filter((r) => near(r, relI)).length;
      const releases = relI.length + relM.length;
      return {
        team: s.teams.get(g.teamId)?.code ?? "?",
        intel: seatName(s, g.seats.intel),
        ms: seatName(s, g.seats.ms),
        hasBot: g.seats.intel === BOT || g.seats.ms === BOT,
        rounds: g.state.round,
        intelCum: g.state.sides.intel.cumProfit,
        msCum: g.state.sides.ms.cumProfit,
        joint: g.state.sides.intel.cumProfit + g.state.sides.ms.cumProfit,
        releasesIntel: relI.length,
        releasesMs: relM.length,
        coordination: releases ? coordinated / releases : null,
        timeouts: h.filter((r) => r.timedOut.intel || r.timedOut.ms).length,
      };
    });
  }
  return out;
}

export function gameDetail(s: Session, phase: PhaseName, teamCode: string) {
  if (!PHASES.includes(phase)) return null;
  const g = [...s.games[phase].values()].find((x) => s.teams.get(x.teamId)?.code === teamCode);
  if (!g) return null;
  return {
    phase,
    team: teamCode,
    intel: seatName(s, g.seats.intel),
    ms: seatName(s, g.seats.ms),
    round: g.state.round,
    over: g.over,
    sides: g.state.sides,
    history: g.state.history,
  };
}

export function exportCsv(s: Session): string {
  const head = "phase,team,round,intel_player,ms_player,intel_release,intel_price,ms_release,ms_price,pcs_sold,intel_profit,ms_profit,intel_cum,ms_cum,intel_timed_out,ms_timed_out";
  const esc = (v: unknown) => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [head];
  for (const phase of PHASES) {
    for (const g of s.games[phase].values()) {
      const team = s.teams.get(g.teamId)?.code ?? "?";
      for (const h of g.state.history) {
        lines.push(
          [phase, team, h.round, seatName(s, g.seats.intel), seatName(s, g.seats.ms),
            h.released.intel, h.prices.intel, h.released.ms, h.prices.ms, h.q.toFixed(3),
            h.profit.intel.toFixed(2), h.profit.ms.toFixed(2), h.cumProfit.intel.toFixed(2), h.cumProfit.ms.toFixed(2),
            h.timedOut.intel, h.timedOut.ms].map(esc).join(","),
        );
      }
    }
  }
  return lines.join("\n") + "\n";
}
