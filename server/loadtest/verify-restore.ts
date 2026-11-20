// After a server restart: check the session from a load-test summary came back identical,
// and that a student can reconnect with their saved token.
// Usage: node --experimental-strip-types loadtest/verify-restore.ts summary.json
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const s = JSON.parse(await readFile(process.argv[2], "utf8"));
const ws = new WebSocket(s.base.replace(/^http/, "ws") + "/ws");
const msgs: any[] = [];
await new Promise((r) => ws.on("open", r));
ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
const waitFor = async (pred: (m: any) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const m = msgs.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout");
};

ws.send(JSON.stringify({ t: "instructor", session: s.code, token: s.instructorToken, ref: 1 }));
const iv = (await waitFor((m) => m.t === "istate")).view;
assert.equal(iv.session.status, "done");
assert.deepEqual(iv.boards, s.boards, "leaderboards differ after restart");
console.log(`instructor view restored: status=${iv.session.status}, ${iv.counts.players} players, boards identical`);

ws.send(JSON.stringify({ t: "resume", session: s.code, token: s.player.token, ref: 2 }));
const w = await waitFor((m) => m.t === "welcome");
assert.equal(w.playerId, s.player.id);
const pv = (await waitFor((m) => m.t === "state")).view;
console.log(`player resumed: ${pv.you.name}, team ${pv.team.code}, last phase ${pv.game.phase} as ${pv.game.role}, rank ${pv.game.result.rankInRole}/${pv.game.result.ofInRole}`);

const csv = await fetch(`${s.base}/api/sessions/${s.code}/export.csv`, { headers: { authorization: `Bearer ${s.instructorToken}` } }).then((r) => r.text());
assert.equal(csv.trim().split("\n").length - 1, s.csvRows);
console.log(`CSV rows match: ${s.csvRows}`);
ws.close();
