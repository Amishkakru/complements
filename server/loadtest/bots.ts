// Load test: N simulated students run Practice -> Game 1 -> Game 2 against a live server.
// Usage: node --experimental-strip-types loadtest/bots.ts [url] [players] [secondsPerPhase] [summary.json]
// Needs INSTRUCTOR_PASSWORD in env.
import { writeFile } from "node:fs/promises";
import { WebSocket } from "ws";

const base = process.argv[2] ?? "http://localhost:8080";
const N = Number(process.argv[3] ?? 1000);
const PHASE_SEC = Number(process.argv[4] ?? 20);
const summaryPath = process.argv[5];
const wsUrl = base.replace(/^http/, "ws") + "/ws";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = Record<string, any>;
class Client {
  ws!: WebSocket;
  pending = new Map<number, { resolve: (m: Msg) => void; reject: (e: Error) => void; sent: number }>();
  ref = 0;
  onMsg: (m: Msg) => void = () => {};
  rtts: number[];
  constructor(rtts: number[]) {
    this.rtts = rtts;
  }
  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.ref !== undefined && this.pending.has(m.ref)) {
          const p = this.pending.get(m.ref)!;
          this.pending.delete(m.ref);
          this.rtts.push(Date.now() - p.sent);
          if (m.t === "error") p.reject(new Error(m.msg));
          else p.resolve(m);
        }
        this.onMsg(m);
      });
    });
  }
  call(m: Msg): Promise<Msg> {
    const ref = ++this.ref;
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject, sent: Date.now() });
      this.ws.send(JSON.stringify({ ...m, ref }));
    });
  }
  send(m: Msg) {
    this.ws.send(JSON.stringify(m));
  }
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 10_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const prev = this.onMsg;
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.onMsg = (m) => {
        prev(m);
        if (pred(m)) {
          clearTimeout(t);
          this.onMsg = prev;
          resolve(m);
        }
      };
    });
  }
}

const stats = { submitRtt: [] as number[], otherRtt: [] as number[], errors: new Map<string, number>(), states: 0 };
const bump = (k: string) => stats.errors.set(k, (stats.errors.get(k) ?? 0) + 1);
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// ---- create session ----
const res = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: process.env.INSTRUCTOR_PASSWORD }),
});
if (!res.ok) throw new Error(`create session failed: ${res.status} ${await res.text()}`);
const { code, instructorToken } = (await res.json()) as { code: string; instructorToken: string };
console.log(`session ${code}`);

const instructor = new Client(stats.otherRtt);
await instructor.open();
let istate: Msg = {};
instructor.onMsg = (m) => {
  if (m.t === "istate") istate = m.view;
};
await instructor.call({ t: "instructor", session: code, token: instructorToken });
while (!istate.config) await sleep(50);
const cfg = istate.config;
// Short rounds so a test run takes minutes, not an hour.
await instructor.call({ t: "config", config: { ...cfg, timing: { startSec: 4, endSec: 3, releaseBonusSec: 1 } } });

// ---- players join and form teams ----
interface Bot { c: Client; id: string; token: string; roles: Record<string, string>; lastSubmitted: string; rounds: Record<string, number> }
const bots: Bot[] = [];
const t0 = Date.now();
for (let i = 0; i < N; i += 50) {
  await Promise.all(
    Array.from({ length: Math.min(50, N - i) }, async (_, j) => {
      const c = new Client(stats.otherRtt);
      await c.open();
      const w = await c.call({ t: "join", session: code, name: `Student ${i + j}` });
      bots[i + j] = { c, id: w.playerId, token: w.token, roles: {}, lastSubmitted: "", rounds: {} };
    }),
  );
}
console.log(`${N} players connected and joined in ${Date.now() - t0}ms`);

const t1 = Date.now();
await Promise.all(
  Array.from({ length: Math.floor(N / 2) }, async (_, k) => {
    const a = bots[2 * k];
    const b = bots[2 * k + 1];
    const { teamCode } = await a.c.call({ t: "createTeam" });
    await b.c.call({ t: "joinTeam", code: teamCode });
  }),
);
if (N % 2) await instructor.call({ t: "autoPair" }); // odd one out gets a bot
console.log(`teams formed in ${Date.now() - t1}ms`);

// ---- play behaviour: think 100-900ms, then submit; occasionally release or signal ----
for (const bot of bots) {
  bot.c.onMsg = (m) => {
    if (m.t !== "state") return;
    stats.states++;
    const g = m.view.game;
    if (!g) return;
    bot.roles[g.phase] = g.role;
    bot.rounds[g.phase] = g.round;
    const key = `${g.phase}:${g.round}`;
    if (g.over || m.view.session.status !== "running" || bot.lastSubmitted === key || g.mySubmission) return;
    bot.lastSubmitted = key;
    const think = 100 + Math.random() * 800;
    setTimeout(() => {
      const base = g.role === "intel" ? 400 : 50;
      const price = Math.round(base * (0.8 + Math.random() * 0.4));
      const release = Math.random() < 0.15;
      bot.c
        .call({ t: "submit", round: g.round, release, price })
        .then(() => {}, (e) => bump(e.message.replace(/\d+/g, "#")));
      if (Math.random() < 0.05) bot.c.call({ t: "plan", round: g.round + 3, on: true }).catch((e) => bump(e.message));
    }, think);
  };
}
// Submit RTT is what matters; track it separately.
for (const bot of bots) {
  const orig = bot.c.call.bind(bot.c);
  bot.c.call = (m: Msg) => {
    const start = Date.now();
    return orig(m).then((r) => {
      if (m.t === "submit") stats.submitRtt.push(Date.now() - start);
      return r;
    });
  };
}

// ---- run the three phases ----
const mem = () => fetch(`${base}/healthz`).then((r) => r.json());
for (const phase of ["practice", "game1", "game2"]) {
  const before = stats.submitRtt.length;
  await instructor.call({ t: "start", phase });
  await sleep(PHASE_SEC * 1000);
  await instructor.call({ t: "end" });
  await sleep(500);
  const rounds = Object.values(bots).map((b) => b.rounds[phase] ?? 0);
  console.log(
    `${phase.padEnd(8)} games=${istate.games?.length} rounds/game min=${Math.min(...rounds)} avg=${(rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1)} max=${Math.max(...rounds)} submits=${stats.submitRtt.length - before}`,
  );
}

// ---- checks ----
const swapped = bots.filter((b) => b.roles.game1 && b.roles.game2 && b.roles.game1 !== b.roles.game2).length;
const practiceSame = bots.filter((b) => b.roles.practice === b.roles.game1).length;
console.log(`role swap game1->game2: ${swapped}/${N}; practice role == game1 role: ${practiceSame}/${N}`);
console.log(`submit RTT ms p50=${pct(stats.submitRtt, 50)} p95=${pct(stats.submitRtt, 95)} p99=${pct(stats.submitRtt, 99)} max=${pct(stats.submitRtt, 100)} (n=${stats.submitRtt.length})`);
console.log(`state pushes received: ${stats.states}`);
console.log(`errors: ${stats.errors.size ? JSON.stringify(Object.fromEntries(stats.errors)) : "none"}`);
console.log(`final status: ${istate.session?.status}; leaderboard teams game2: ${istate.boards?.game2?.teams?.length}`);

const csv = await fetch(`${base}/api/sessions/${code}/export.csv`, { headers: { authorization: `Bearer ${instructorToken}` } }).then((r) => r.text());
console.log(`CSV rows: ${csv.trim().split("\n").length - 1}`);
console.log(`server health: ${JSON.stringify(await mem())}`);

if (summaryPath) {
  await writeFile(
    summaryPath,
    JSON.stringify({ base, code, instructorToken, player: { token: bots[0].token, id: bots[0].id }, boards: istate.boards, csvRows: csv.trim().split("\n").length - 1 }),
  );
}
for (const b of bots) b.c.ws.close();
instructor.ws.close();
process.exit(swapped === N - (N % 2 ? 1 : 0) || swapped === N ? 0 : 1);
