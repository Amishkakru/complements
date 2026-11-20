import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT, CommandError, Session, type SessionEvent } from "../src/session.ts";
import { phaseBoard, playerView, instructorView, overallBoard, exportCsv } from "../src/views.ts";

function setup(nPlayers: number) {
  let now = 1_000_000;
  const clock = () => now;
  let seed = 42;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const events: SessionEvent[] = [];
  const { session: s, instructorToken } = Session.create({ clock, rng, code: "TEST01" });
  // capture creation event too
  events.push({ type: "session_created", code: s.code, instructorTokenHash: s.instructorTokenHash, config: s.config });
  s.persist = (e) => events.push(e);
  const ids = Array.from({ length: nPlayers }, (_, i) => s.join(`P${i}`).playerId);
  return { s, ids, events, instructorToken, advance: (ms: number) => (now += ms), clock, rng };
}

function pairUp(s: Session, ids: string[]) {
  for (let i = 0; i + 1 < ids.length; i += 2) {
    const code = s.createTeam(ids[i]);
    s.joinTeam(ids[i + 1], code);
  }
}

function playRound(s: Session, ids: string[], price = { intel: 400, ms: 50 }) {
  for (const id of ids) {
    const gp = s.gameFor(id);
    if (!gp || gp.game.over) continue;
    if (gp.game.submissions[gp.role]) continue;
    s.submit(id, gp.game.state.round, false, price[gp.role]);
  }
}

test("teams of two: practice and game1 share roles, game2 swaps them", () => {
  const { s, ids } = setup(4);
  pairUp(s, ids);
  s.startPhase("practice");
  const practiceSeats = s.gameFor(ids[0])!.role;
  s.endPhase();
  s.startPhase("game1");
  const g1Role = s.gameFor(ids[0])!.role;
  assert.equal(g1Role, practiceSeats);
  const g1Partner = s.gameFor(ids[1])!.role;
  assert.notEqual(g1Role, g1Partner);
  s.endPhase();
  s.startPhase("game2");
  assert.notEqual(s.gameFor(ids[0])!.role, g1Role);
  assert.equal(s.gameFor(ids[1])!.role, g1Role);
  s.endPhase();
  assert.equal(s.status, "done");
});

test("round resolves as soon as both submit; stale or duplicate rounds rejected", () => {
  const { s, ids } = setup(2);
  pairUp(s, ids);
  s.startPhase("game1");
  playRound(s, ids);
  const g = s.gameFor(ids[0])!.game;
  assert.equal(g.state.round, 1);
  assert.equal(g.state.history[0].q.toFixed(1), "5.0");
  assert.throws(() => s.submit(ids[0], 0, false, 400), CommandError);
});

test("timer expiry applies the default (no release, last price)", () => {
  const { s, ids, advance } = setup(2);
  pairUp(s, ids);
  s.startPhase("game1");
  const { game, role } = s.gameFor(ids[0])!;
  s.submit(ids[0], 0, true, role === "intel" ? 420 : 60);
  advance(game.cfg.timing.startSec * 1000 + 1);
  s.tick();
  const h = game.state.history[0];
  const other = role === "intel" ? "ms" : "intel";
  assert.equal(h.timedOut[other], true);
  assert.equal(h.released[other], false);
  assert.equal(h.released[role], true);
});

test("autoPair fills half teams, pairs free players, and gives a leftover a bot", () => {
  const { s, ids } = setup(7);
  s.createTeam(ids[0]); // half team
  const n = s.autoPair();
  assert.equal(n, 4);
  const full = [...s.teams.values()].filter((t) => t.members.length === 2);
  const bots = [...s.teams.values()].filter((t) => t.bot);
  assert.equal(full.length, 3);
  assert.equal(bots.length, 1);
  assert.ok(full.some((t) => t.members.includes(ids[0])), "half team got filled");
  s.startPhase("game1");
  assert.equal(s.currentGames().length, 4);
  const botGame = s.currentGames().find((g) => g.seats.intel === BOT || g.seats.ms === BOT)!;
  // the bot has already submitted for round 0
  const botRole = botGame.seats.intel === BOT ? "intel" : "ms";
  assert.ok(botGame.submissions[botRole]);
});

test("a game against a bot plays through", () => {
  const { s, ids } = setup(1);
  s.autoPair();
  s.startPhase("game1");
  for (let r = 0; r < 12; r++) playRound(s, ids);
  const g = s.gameFor(ids[0])!.game;
  assert.equal(g.state.round, 12);
  assert.ok(g.state.history.some((h) => h.released.intel || h.released.ms), "bot should release at some point");
});

test("pause freezes timers and blocks submissions; resume restores remaining time", () => {
  const { s, ids, advance } = setup(2);
  pairUp(s, ids);
  s.startPhase("game1");
  const g = s.gameFor(ids[0])!.game;
  advance(10_000);
  s.pause();
  assert.throws(() => s.submit(ids[0], 0, false, 400), /paused/);
  advance(10 * 60_000);
  s.tick();
  assert.equal(g.state.round, 0);
  s.resume();
  assert.equal(g.deadline - (1_000_000 + 10_000 + 600_000), g.cfg.timing.startSec * 1000 - 10_000);
});

test("late team formed mid-phase gets a game immediately", () => {
  const { s, ids } = setup(4);
  pairUp(s, ids.slice(0, 2));
  s.startPhase("game1");
  assert.equal(s.currentGames().length, 1);
  const code = s.createTeam(ids[2]);
  s.joinTeam(ids[3], code);
  assert.equal(s.currentGames().length, 2);
});

test("replaying the event log rebuilds identical state", () => {
  const { s, ids, events, advance, clock, rng } = setup(5);
  s.autoPair();
  s.startPhase("practice");
  for (let r = 0; r < 3; r++) playRound(s, ids);
  s.endPhase();
  s.startPhase("game1");
  const g0 = s.gameFor(ids[0])!;
  s.plan(ids[0], 4, true);
  for (let r = 0; r < 5; r++) {
    playRound(s, ids, { intel: 380 + r, ms: 55 });
    advance(1000);
  }
  // one side times out
  s.submit(ids[0], g0.game.state.round, true, 300);
  advance(10 * 60_000);
  s.tick();

  const r = Session.replay(events, clock, rng);
  assert.equal(r.code, s.code);
  assert.equal(r.status, s.status);
  assert.equal(r.phase, s.phase);
  for (const ph of ["practice", "game1"] as const) {
    assert.deepEqual(phaseBoard(r, ph), phaseBoard(s, ph));
    for (const [teamId, g] of s.games[ph]) assert.deepEqual(r.games[ph].get(teamId)!.state, g.state);
  }
  assert.ok(r.playerByToken("nope") === null);
});

test("views: player sees role, partner and results; instructor sees grid and boards; CSV exports", () => {
  const { s, ids } = setup(4);
  pairUp(s, ids);
  s.startPhase("game1");
  for (let r = 0; r < 3; r++) playRound(s, ids);
  const v = playerView(s, ids[0], 0) as any;
  assert.equal(v.team.teammate, "P1");
  assert.equal(v.game.history.length, 3);
  assert.ok(["intel", "ms"].includes(v.game.role));
  s.endPhase();
  const v2 = playerView(s, ids[0], 0) as any;
  assert.ok(v2.game.result.rankInRole >= 1);
  const iv = instructorView(s, new Set([ids[0]]), 0);
  assert.equal(iv.counts.players, 4);
  assert.equal(iv.counts.connected, 1);
  assert.equal(iv.games.length, 2);
  assert.equal(iv.boards.game1!.teams.length, 2);
  s.startPhase("game2");
  for (let r = 0; r < 2; r++) playRound(s, ids);
  s.endPhase();
  const overall = overallBoard(s);
  assert.equal(overall.length, 4);
  assert.ok(overall.every((o) => o.intelPct !== null && o.msPct !== null));
  const csv = exportCsv(s);
  assert.equal(csv.trim().split("\n").length, 1 + 2 * 3 + 2 * 2);
});

test("guards: no settings changes mid-game, no joining a full team, no start without teams", () => {
  const { s, ids } = setup(3);
  assert.throws(() => s.startPhase("game1"), /no complete teams/);
  pairUp(s, ids.slice(0, 2));
  const code = [...s.teams.values()][0].code;
  assert.throws(() => s.joinTeam(ids[2], code), /full/);
  s.startPhase("game1");
  assert.throws(() => s.updateConfig(s.config), /during a game/);
  assert.throws(() => s.startPhase("game2"), /already running/);
});

test("debrief summarises coordination and gameDetail returns one game's history", async () => {
  const { debriefData, gameDetail } = await import("../src/views.ts");
  const { s, ids } = setup(2);
  pairUp(s, ids);
  s.startPhase("game1");
  // both release in round 1 (coordinated), Intel alone in round 4 (not coordinated)
  for (let r = 0; r < 6; r++) {
    for (const id of ids) {
      const { game, role } = s.gameFor(id)!;
      const rel = r === 1 || (r === 4 && role === "intel");
      s.submit(id, game.state.round, rel, role === "intel" ? 400 : 50);
    }
  }
  const d = debriefData(s).game1 as any[];
  assert.equal(d.length, 1);
  assert.equal(d[0].releasesIntel, 2);
  assert.equal(d[0].releasesMs, 1);
  assert.equal(d[0].coordination, 2 / 3);
  const code = [...s.teams.values()][0].code;
  assert.equal(gameDetail(s, "game1", code)!.history.length, 6);
  assert.equal(gameDetail(s, "game2", code), null);
});

test("hub: idle sessions are skipped on restore and evicted, and their codes are never reused", async () => {
  const { Hub } = await import("../src/server.ts");
  const { MemoryStore, FileStore } = await import("../src/store.ts");
  const day = 86_400_000;
  const store = new MemoryStore();
  store.events.push(
    { session: "OLD001", seq: 1, ts: Date.now() - 30 * day, event: { type: "session_created", code: "OLD001", instructorTokenHash: "x", config: (await import("../../engine/src/engine.ts")).DEFAULT_CONFIG } },
  );
  const hub = new Hub({ store, instructorPassword: "pw", retentionDays: 14 });
  assert.equal(await hub.restore(), 0, "30-day-old session is not loaded");
  const { code } = hub.createSession();
  assert.notEqual(code, "OLD001");
  assert.equal(hub.evictIdle(Date.now() + 15 * day), 1, "new session is evicted once idle past retention");
  assert.equal(hub.sessions.size, 0);

  // File store: same filter, streaming
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/cs-`);
  const fs = new FileStore(`${dir}/e.jsonl`);
  fs.append(store.events[0]);
  fs.append({ ...store.events[0], session: "NEW001", ts: Date.now(), event: { ...store.events[0].event, code: "NEW001" } as any });
  await fs.flush();
  const r = await fs.load(Date.now() - 14 * day);
  assert.deepEqual([...r.known].sort(), ["NEW001", "OLD001"]);
  assert.deepEqual(r.events.map((e) => e.session), ["NEW001"]);
  await rm(dir, { recursive: true });
});
