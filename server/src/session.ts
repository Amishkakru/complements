// One class session: players, teams, phases and the games inside each phase.
// Event-sourced: every state change is an event; replaying the events rebuilds the session.
// Timers, sockets and bot "thinking" are not persisted; they are re-derived after replay.
import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  newGame,
  resolveRound,
  roundDurationSec,
  setPlannedRelease,
  validateDecision,
  type Decision,
  type GameConfig,
  type GameState,
  type Role,
} from "../../engine/src/engine.ts";
import { botMove } from "./bot.ts";

export type PhaseName = "practice" | "game1" | "game2";
export const PHASES: PhaseName[] = ["practice", "game1", "game2"];
export type Status = "lobby" | "running" | "paused" | "between" | "done";
export const BOT = "bot";
export type Seats = Record<Role, string>; // playerId or BOT
const ROLES: Role[] = ["intel", "ms"];

export interface Player {
  id: string;
  tokenHash: string;
  name: string;
  teamId: string | null;
  removed: boolean;
}
export interface Team {
  id: string;
  code: string;
  members: string[]; // [creator, joiner]
  bot: boolean;
}
export interface Game {
  teamId: string;
  phase: PhaseName;
  cfg: GameConfig;
  state: GameState;
  seats: Seats;
  submissions: Partial<Record<Role, Decision>>;
  deadline: number; // epoch ms
  remainingMs: number | null; // set while paused
  over: boolean;
}

export type SessionEvent =
  | { type: "session_created"; code: string; instructorTokenHash: string; config: GameConfig }
  | { type: "config_updated"; config: GameConfig }
  | { type: "player_joined"; playerId: string; tokenHash: string; name: string }
  | { type: "player_removed"; playerId: string }
  | { type: "team_created"; teamId: string; code: string; playerId: string }
  | { type: "team_joined"; teamId: string; playerId: string }
  | { type: "team_left"; teamId: string; playerId: string }
  | { type: "team_bot"; teamId: string }
  | { type: "phase_started"; phase: PhaseName; seats: Record<string, Seats> }
  | { type: "game_added"; teamId: string; seats: Seats }
  | { type: "plan_set"; teamId: string; role: Role; round: number; on: boolean }
  | { type: "round_resolved"; teamId: string; round: number; decisions: Partial<Record<Role, Decision>> }
  | { type: "phase_paused" }
  | { type: "phase_resumed" }
  | { type: "phase_ended" };

export class CommandError extends Error {}
const fail = (msg: string): never => {
  throw new CommandError(msg);
};

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const randomCode = (n: number) =>
  Array.from(randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const randomId = () => randomBytes(6).toString("base64url");

export type Clock = () => number;

export class Session {
  code = "";
  instructorTokenHash = "";
  config: GameConfig = DEFAULT_CONFIG;
  players = new Map<string, Player>();
  private tokenIndex = new Map<string, string>();
  teams = new Map<string, Team>();
  private teamCodes = new Map<string, string>();
  phase: PhaseName | null = null;
  status: Status = "lobby";
  games: Record<PhaseName, Map<string, Game>> = { practice: new Map(), game1: new Map(), game2: new Map() };

  // Change tracking for the transport layer.
  dirtyPlayers = new Set<string>();
  instructorDirty = true;
  persist: (e: SessionEvent) => void = () => {};

  private replaying = false;
  private clock: Clock;
  private rng: () => number;

  constructor(clock: Clock = Date.now, rng: () => number = Math.random) {
    this.clock = clock;
    this.rng = rng;
  }

  // ---------- construction ----------

  static create(opts: { clock?: Clock; rng?: () => number; config?: GameConfig; code?: string } = {}) {
    const s = new Session(opts.clock, opts.rng);
    const token = randomBytes(18).toString("base64url");
    s.emit({
      type: "session_created",
      code: opts.code ?? randomCode(6),
      instructorTokenHash: hashToken(token),
      config: opts.config ?? DEFAULT_CONFIG,
    });
    return { session: s, instructorToken: token };
  }

  static replay(events: SessionEvent[], clock: Clock = Date.now, rng: () => number = Math.random): Session {
    const s = new Session(clock, rng);
    s.replaying = true;
    for (const e of events) s.apply(e);
    s.replaying = false;
    // Running games get a fresh full round timer; bots make their move for the current round.
    if (s.phase) {
      const now = s.clock();
      for (const g of s.games[s.phase].values()) {
        if (g.over) continue;
        const ms = roundDurationSec(g.cfg, g.state) * 1000;
        if (s.status === "paused") g.remainingMs = ms;
        else g.deadline = now + ms;
        if (s.status === "running") s.botsAct(g);
      }
    }
    s.markAll();
    return s;
  }

  // ---------- event plumbing ----------

  // Persist before applying: applying can trigger follow-up events (bot moves), which must be logged after this one.
  private emit(e: SessionEvent) {
    if (!this.replaying) this.persist(e);
    this.apply(e);
  }

  private apply(e: SessionEvent) {
    const now = this.clock();
    switch (e.type) {
      case "session_created":
        this.code = e.code;
        this.instructorTokenHash = e.instructorTokenHash;
        this.config = e.config;
        break;
      case "config_updated":
        this.config = e.config;
        break;
      case "player_joined":
        this.players.set(e.playerId, { id: e.playerId, tokenHash: e.tokenHash, name: e.name, teamId: null, removed: false });
        this.tokenIndex.set(e.tokenHash, e.playerId);
        this.dirtyPlayers.add(e.playerId);
        break;
      case "player_removed": {
        const p = this.players.get(e.playerId)!;
        p.removed = true;
        this.tokenIndex.delete(p.tokenHash);
        this.dirtyPlayers.add(p.id);
        break;
      }
      case "team_created":
        this.teams.set(e.teamId, { id: e.teamId, code: e.code, members: [e.playerId], bot: false });
        this.teamCodes.set(e.code, e.teamId);
        this.players.get(e.playerId)!.teamId = e.teamId;
        this.dirtyPlayers.add(e.playerId);
        break;
      case "team_joined": {
        const t = this.teams.get(e.teamId)!;
        t.members.push(e.playerId);
        t.bot = false;
        this.players.get(e.playerId)!.teamId = e.teamId;
        this.markTeam(t.id);
        break;
      }
      case "team_left": {
        const t = this.teams.get(e.teamId)!;
        t.members = t.members.filter((m) => m !== e.playerId);
        if (t.members.length === 0) t.bot = false;
        this.players.get(e.playerId)!.teamId = null;
        this.dirtyPlayers.add(e.playerId);
        this.markTeam(t.id);
        break;
      }
      case "team_bot":
        this.teams.get(e.teamId)!.bot = true;
        this.markTeam(e.teamId);
        break;
      case "phase_started":
        this.phase = e.phase;
        this.status = "running";
        this.games[e.phase] = new Map();
        for (const [teamId, seats] of Object.entries(e.seats)) this.addGame(teamId, seats, now);
        this.markAll();
        break;
      case "game_added":
        this.addGame(e.teamId, e.seats, now);
        this.markTeam(e.teamId);
        break;
      case "plan_set": {
        const g = this.currentGame(e.teamId)!;
        g.state = setPlannedRelease(g.state, e.role, e.round, e.on);
        this.markTeam(e.teamId);
        break;
      }
      case "round_resolved": {
        const g = this.currentGame(e.teamId)!;
        g.state = resolveRound(g.cfg, g.state, e.decisions);
        g.submissions = {};
        if (g.state.round >= g.cfg.maxRounds) g.over = true;
        else g.deadline = now + roundDurationSec(g.cfg, g.state) * 1000;
        this.markTeam(e.teamId);
        if (!this.replaying && !g.over) this.botsAct(g);
        break;
      }
      case "phase_paused":
        this.status = "paused";
        for (const g of this.currentGames()) g.remainingMs = Math.max(0, g.deadline - now);
        this.markAll();
        break;
      case "phase_resumed":
        this.status = "running";
        for (const g of this.currentGames()) {
          g.deadline = now + (g.remainingMs ?? 0);
          g.remainingMs = null;
        }
        this.markAll();
        break;
      case "phase_ended":
        for (const g of this.currentGames()) g.over = true;
        this.status = this.phase === "game2" ? "done" : "between";
        this.markAll();
        break;
    }
    this.instructorDirty = true;
  }

  private addGame(teamId: string, seats: Seats, now: number) {
    const cfg = this.config;
    const state = newGame(cfg);
    const g: Game = {
      teamId,
      phase: this.phase!,
      cfg,
      state,
      seats,
      submissions: {},
      deadline: now + roundDurationSec(cfg, state) * 1000,
      remainingMs: null,
      over: false,
    };
    this.games[this.phase!].set(teamId, g);
    if (!this.replaying) this.botsAct(g);
  }

  // ---------- helpers ----------

  private markTeam(teamId: string) {
    const t = this.teams.get(teamId);
    if (t) for (const m of t.members) this.dirtyPlayers.add(m);
  }
  private markAll() {
    for (const id of this.players.keys()) this.dirtyPlayers.add(id);
    this.instructorDirty = true;
  }
  currentGames(): Game[] {
    return this.phase ? [...this.games[this.phase].values()] : [];
  }
  currentGame(teamId: string): Game | undefined {
    return this.phase ? this.games[this.phase].get(teamId) : undefined;
  }
  gameFor(playerId: string): { game: Game; role: Role } | null {
    const p = this.players.get(playerId);
    if (!p?.teamId) return null;
    const g = this.currentGame(p.teamId);
    if (!g) return null;
    const role = ROLES.find((r) => g.seats[r] === playerId);
    return role ? { game: g, role } : null;
  }
  playerByToken(token: string): Player | null {
    const id = this.tokenIndex.get(hashToken(token));
    return id ? this.players.get(id)! : null;
  }
  checkInstructor(token: string) {
    return hashToken(token) === this.instructorTokenHash;
  }
  private livePlayer(playerId: string): Player {
    const p = this.players.get(playerId);
    if (!p || p.removed) fail("unknown player");
    return p!;
  }
  private inPlayablePhase() {
    return this.status === "running" || this.status === "paused";
  }

  private seatsFor(team: Team, phase: PhaseName): Seats | null {
    const humans = team.members;
    if (humans.length === 0 || (humans.length === 1 && !team.bot)) return null;
    const pair = humans.length === 2 ? [humans[0], humans[1]] : [humans[0], BOT];
    const prev = (p: PhaseName) => this.games[p].get(team.id)?.seats;
    const valid = (s?: Seats) => s && pair.includes(s.intel) && pair.includes(s.ms);
    if (phase === "game2" && valid(prev("game1"))) return { intel: prev("game1")!.ms, ms: prev("game1")!.intel };
    if (phase === "game1" && valid(prev("practice"))) return { ...prev("practice")! };
    if (phase === "game2" && valid(prev("practice"))) return { intel: prev("practice")!.ms, ms: prev("practice")!.intel };
    return this.rng() < 0.5 ? { intel: pair[0], ms: pair[1] } : { intel: pair[1], ms: pair[0] };
  }

  private maybeAddGame(teamId: string) {
    if (!this.inPlayablePhase() || this.currentGame(teamId)) return;
    const seats = this.seatsFor(this.teams.get(teamId)!, this.phase!);
    if (seats) this.emit({ type: "game_added", teamId, seats });
  }

  private botsAct(g: Game) {
    if (this.status !== "running" || g.over) return;
    for (const role of ROLES) {
      if (g.seats[role] !== BOT || g.submissions[role]) continue;
      const mv = botMove(g.cfg, g.state, role);
      if (mv.plan !== null) this.emit({ type: "plan_set", teamId: g.teamId, role, round: mv.plan, on: true });
      g.submissions[role] = mv.decision;
    }
    this.maybeResolve(g);
  }

  private maybeResolve(g: Game) {
    if (g.submissions.intel && g.submissions.ms) this.resolve(g);
  }
  private resolve(g: Game) {
    this.emit({ type: "round_resolved", teamId: g.teamId, round: g.state.round, decisions: g.submissions });
  }

  // ---------- player commands ----------

  join(name: string): { playerId: string; token: string } {
    const clean = String(name ?? "").trim().slice(0, 40);
    if (!clean) fail("name required");
    if (this.status === "done") fail("session is over");
    const token = randomBytes(18).toString("base64url");
    const playerId = randomId();
    this.emit({ type: "player_joined", playerId, tokenHash: hashToken(token), name: clean });
    return { playerId, token };
  }

  createTeam(playerId: string): string {
    const p = this.livePlayer(playerId);
    if (p.teamId) fail("already in a team");
    let code = randomCode(4);
    while (this.teamCodes.has(code)) code = randomCode(4);
    const teamId = randomId();
    this.emit({ type: "team_created", teamId, code, playerId });
    return code;
  }

  joinTeam(playerId: string, code: string) {
    const p = this.livePlayer(playerId);
    if (p.teamId) fail("already in a team");
    const teamId = this.teamCodes.get(String(code ?? "").trim().toUpperCase());
    if (!teamId) fail("no team with that code");
    const t = this.teams.get(teamId!)!;
    if (t.members.length >= 2) fail("team is full");
    if (this.currentGame(t.id) && !this.currentGame(t.id)!.over) fail("that team is mid-game");
    this.emit({ type: "team_joined", teamId: t.id, playerId });
    this.maybeAddGame(t.id);
  }

  leaveTeam(playerId: string) {
    const p = this.livePlayer(playerId);
    const teamId = p.teamId;
    if (!teamId) return fail("not in a team");
    if (this.inPlayablePhase() && this.currentGame(teamId)) fail("can't leave during a game");
    this.emit({ type: "team_left", teamId, playerId });
  }

  submit(playerId: string, round: number, release: boolean, price: number) {
    const gp = this.gameFor(playerId);
    if (!gp) fail("you are not in a game");
    const { game, role } = gp!;
    if (this.status === "paused") fail("game is paused");
    if (this.status !== "running" || game.over) fail("game is not running");
    if (round !== game.state.round) fail(`stale round (current is ${game.state.round})`);
    const d = { release: !!release, price: Number(price) };
    const err = validateDecision(d);
    if (err) fail(err);
    game.submissions[role] = d;
    this.markTeam(game.teamId);
    this.instructorDirty = true;
    this.maybeResolve(game);
  }

  plan(playerId: string, round: number, on: boolean) {
    const gp = this.gameFor(playerId);
    if (!gp) fail("you are not in a game");
    const { game, role } = gp!;
    if (game.over) fail("game is over");
    if (!Number.isInteger(round) || round <= game.state.round || round >= game.cfg.maxRounds) fail("bad round");
    this.emit({ type: "plan_set", teamId: game.teamId, role, round, on: !!on });
  }

  // ---------- instructor commands ----------

  updateConfig(config: GameConfig) {
    if (this.inPlayablePhase()) fail("can't change settings during a game");
    const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
    const ok =
      n(config?.intelMC) && n(config.releaseCost0) && n(config.releaseCostGrowth) && n(config.msRevNewPC) &&
      n(config.msRevOldPC) && Number.isInteger(config.installedBaseWindow) && n(config.discountRate) &&
      Number.isInteger(config.maxRounds) && config.maxRounds >= 1 && config.maxRounds <= 200 &&
      n(config.timing?.startSec) && n(config.timing.endSec) && n(config.timing.releaseBonusSec) &&
      config.timing.startSec >= 1 && config.timing.endSec >= 1 &&
      Object.values(config.demand ?? {}).every(n) && n(config.initialPrices?.intel) && n(config.initialPrices?.ms);
    if (!ok) fail("invalid settings");
    this.emit({ type: "config_updated", config });
  }

  removePlayer(playerId: string) {
    const p = this.livePlayer(playerId);
    if (p.teamId) {
      if (this.inPlayablePhase() && this.currentGame(p.teamId)) fail("can't remove a player mid-game");
      this.emit({ type: "team_left", teamId: p.teamId, playerId });
    }
    this.emit({ type: "player_removed", playerId });
  }

  /** Instructor edits pairs: move a player into the team with `code`, or out of any team (code = null). */
  movePlayer(playerId: string, code: string | null) {
    const p = this.livePlayer(playerId);
    if (this.inPlayablePhase()) fail("edit pairs between phases");
    if (p.teamId) this.emit({ type: "team_left", teamId: p.teamId, playerId });
    if (code) this.joinTeam(playerId, code);
  }

  /** Pair everyone without a partner; a leftover student gets a bot. Returns how many teams were completed. */
  autoPair(): number {
    const shuffle = <T>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const live = [...this.players.values()].filter((p) => !p.removed);
    const free = shuffle(live.filter((p) => !p.teamId).map((p) => p.id));
    const open = shuffle([...this.teams.values()].filter((t) => t.members.length === 1 && !t.bot));
    let completed = 0;
    // 1) fill half-empty teams with free players
    while (open.length && free.length) {
      this.joinTeam(free.pop()!, open.pop()!.code);
      completed++;
    }
    // 2) merge half-empty teams
    while (open.length >= 2) {
      const a = open.pop()!;
      const b = open.pop()!;
      const mover = b.members[0];
      this.emit({ type: "team_left", teamId: b.id, playerId: mover });
      this.joinTeam(mover, a.code);
      completed++;
    }
    // 3) pair free players
    while (free.length >= 2) {
      const a = free.pop()!;
      const code = this.createTeam(a);
      this.joinTeam(free.pop()!, code);
      completed++;
    }
    // 4) leftover single → bot partner
    const leftover = free.length ? this.teams.get(this.teamCodes.get(this.createTeam(free.pop()!))!)! : open.pop();
    if (leftover) {
      this.emit({ type: "team_bot", teamId: leftover.id });
      this.maybeAddGame(leftover.id);
      completed++;
    }
    return completed;
  }

  startPhase(phase: PhaseName) {
    if (!PHASES.includes(phase)) fail("unknown phase");
    if (this.inPlayablePhase()) fail("a phase is already running");
    if (this.games[phase].size > 0) fail("that phase was already played");
    const seats: Record<string, Seats> = {};
    for (const t of this.teams.values()) {
      const s = this.seatsFor(t, phase);
      if (s) seats[t.id] = s;
    }
    if (Object.keys(seats).length === 0) fail("no complete teams yet");
    this.emit({ type: "phase_started", phase, seats });
  }

  pause() {
    if (this.status !== "running") fail("not running");
    this.emit({ type: "phase_paused" });
  }
  resume() {
    if (this.status !== "paused") fail("not paused");
    this.emit({ type: "phase_resumed" });
    for (const g of this.currentGames()) this.botsAct(g);
  }
  endPhase() {
    if (!this.inPlayablePhase()) fail("no phase running");
    this.emit({ type: "phase_ended" });
  }

  /** Resolve every game whose timer ran out (missing decisions take the timeout default). */
  tick(now = this.clock()) {
    if (this.status !== "running") return;
    for (const g of this.currentGames()) {
      if (!g.over && g.deadline <= now) this.resolve(g);
    }
    // A phase ends by itself once every game hit the round cap.
    const games = this.currentGames();
    if (games.length && games.every((g) => g.over)) this.emit({ type: "phase_ended" });
  }
}
