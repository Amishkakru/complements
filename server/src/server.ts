// HTTP + WebSocket transport. All game logic lives in Session; this file routes messages and pushes views.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { CommandError, Session, type PhaseName, type SessionEvent } from "./session.ts";
import { debriefData, exportCsv, gameDetail, instructorView, playerView } from "./views.ts";
import type { EventStore } from "./store.ts";

export interface ServerOptions {
  store: EventStore;
  instructorPassword: string;
  staticDir?: string;
  trustProxy?: boolean; // behind a load balancer (Render, Fly, nginx): read the client IP from X-Forwarded-For
  retentionDays?: number; // sessions idle longer than this are dropped from memory (still on disk / in the DB)
  tickMs?: number;
  instructorPushMs?: number;
}

type Ctx =
  | { kind: "none" }
  | { kind: "player"; code: string; playerId: string }
  | { kind: "instructor"; code: string };

interface Conn {
  ws: WebSocket;
  ctx: Ctx;
  tokens: number; // rate-limit bucket
  last: number;
}

const MAX_MSG_BYTES = 8 * 1024;
const RATE_PER_SEC = 20;
const RATE_BURST = 40;
const MAX_BUFFERED = 1 << 20;

export class Hub {
  sessions = new Map<string, Session>();
  private seq = new Map<string, number>();
  private players = new Map<string, Map<string, Set<Conn>>>(); // code -> playerId -> conns
  private instructors = new Map<string, Set<Conn>>();
  private lastInstructorPush = new Map<string, number>();
  private opts: Required<ServerOptions>;

  constructor(opts: ServerOptions) {
    this.opts = { staticDir: "", tickMs: 100, instructorPushMs: 1000, trustProxy: false, retentionDays: 14, ...opts };
  }

  private knownCodes = new Set<string>();
  private lastActive = new Map<string, number>();
  private lastEvict = Date.now();
  private get retentionMs() {
    return this.opts.retentionDays * 86_400_000;
  }

  async restore() {
    const { events, known } = await this.opts.store.load(Date.now() - this.retentionMs);
    this.knownCodes = known;
    const bySession = new Map<string, SessionEvent[]>();
    for (const e of events) {
      if (!bySession.has(e.session)) bySession.set(e.session, []);
      bySession.get(e.session)!.push(e.event);
      this.seq.set(e.session, Math.max(this.seq.get(e.session) ?? 0, e.seq));
      this.lastActive.set(e.session, Math.max(this.lastActive.get(e.session) ?? 0, e.ts));
    }
    for (const evs of bySession.values()) this.attach(Session.replay(evs));
    return bySession.size;
  }

  /** Drop sessions nobody has touched within the retention window and nobody is connected to. */
  evictIdle(now = Date.now()) {
    let n = 0;
    for (const code of [...this.sessions.keys()]) {
      if (now - (this.lastActive.get(code) ?? now) < this.retentionMs) continue;
      const connected = [...(this.players.get(code)?.values() ?? [])].some((set) => set.size) || (this.instructors.get(code)?.size ?? 0) > 0;
      if (connected) continue;
      this.sessions.delete(code);
      this.players.delete(code);
      this.instructors.delete(code);
      this.lastInstructorPush.delete(code);
      this.lastActive.delete(code);
      n++;
    }
    return n;
  }

  private attach(s: Session) {
    s.persist = (event) => {
      const seq = (this.seq.get(s.code) ?? 0) + 1;
      this.seq.set(s.code, seq);
      this.lastActive.set(s.code, Date.now());
      this.opts.store.append({ session: s.code, seq, ts: Date.now(), event });
    };
    this.sessions.set(s.code, s);
    this.players.set(s.code, this.players.get(s.code) ?? new Map());
    this.instructors.set(s.code, this.instructors.get(s.code) ?? new Set());
  }

  createSession(): { code: string; instructorToken: string } {
    let created: ReturnType<typeof Session.create>;
    do {
      // persist is wired after creation, so log the creation event by hand
      created = Session.create();
    } while (this.sessions.has(created.session.code) || this.knownCodes.has(created.session.code));
    const s = created.session;
    this.knownCodes.add(s.code);
    this.lastActive.set(s.code, Date.now());
    this.attach(s);
    this.seq.set(s.code, 1);
    this.opts.store.append({
      session: s.code,
      seq: 1,
      ts: Date.now(),
      event: { type: "session_created", code: s.code, instructorTokenHash: s.instructorTokenHash, config: s.config },
    });
    return { code: s.code, instructorToken: created.instructorToken };
  }

  // ---------- push ----------

  private send(c: Conn, msg: unknown) {
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    if (c.ws.bufferedAmount > MAX_BUFFERED) return false; // slow client; it gets the next full state
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  flush(force = false) {
    const now = Date.now();
    for (const [code, s] of this.sessions) {
      if (s.dirtyPlayers.size) {
        const conns = this.players.get(code)!;
        const dirty = [...s.dirtyPlayers];
        s.dirtyPlayers.clear();
        for (const pid of dirty) {
          const set = conns.get(pid);
          if (!set?.size) continue;
          const msg = { t: "state", view: playerView(s, pid, now) };
          for (const c of set) if (!this.send(c, msg)) s.dirtyPlayers.add(pid);
        }
      }
      const ins = this.instructors.get(code)!;
      const due = now - (this.lastInstructorPush.get(code) ?? 0) >= this.opts.instructorPushMs;
      if (s.instructorDirty && ins.size && (due || force)) {
        s.instructorDirty = false;
        this.lastInstructorPush.set(code, now);
        const msg = { t: "istate", view: instructorView(s, this.connectedSet(code), now) };
        for (const c of ins) this.send(c, msg);
      }
    }
  }

  private connectedSet(code: string) {
    const m = this.players.get(code)!;
    return new Set([...m.entries()].filter(([, set]) => set.size > 0).map(([id]) => id));
  }

  tick() {
    const now = Date.now();
    if (now - this.lastEvict > 10 * 60_000) {
      this.lastEvict = now;
      const n = this.evictIdle(now);
      if (n) console.log(`[hub] unloaded ${n} idle session(s) from memory`);
    }
    for (const s of this.sessions.values()) {
      try {
        s.tick(now);
      } catch (err) {
        console.error(`[tick] session ${s.code}`, err);
      }
    }
    this.flush();
  }

  // ---------- connections ----------

  onConnection(ws: WebSocket) {
    const conn: Conn = { ws, ctx: { kind: "none" }, tokens: RATE_BURST, last: Date.now() };
    ws.on("message", (raw, isBinary) => {
      const now = Date.now();
      conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.last) / 1000) * RATE_PER_SEC);
      conn.last = now;
      if (conn.tokens < 1) return this.send(conn, { t: "error", msg: "slow down" });
      conn.tokens -= 1;
      if (isBinary || (raw as Buffer).length > MAX_MSG_BYTES) return ws.close(1009, "message too large");
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(conn, { t: "error", msg: "bad json" });
      }
      try {
        this.handle(conn, msg);
      } catch (err) {
        if (err instanceof CommandError) this.send(conn, { t: "error", msg: err.message, ref: msg?.ref });
        else {
          console.error("[handle]", err);
          this.send(conn, { t: "error", msg: "server error", ref: msg?.ref });
        }
      }
      this.flush(conn.ctx.kind === "instructor");
    });
    ws.on("close", () => this.detach(conn));
    ws.on("error", () => this.detach(conn));
  }

  private detach(conn: Conn) {
    const ctx = conn.ctx;
    if (ctx.kind === "player") {
      this.players.get(ctx.code)?.get(ctx.playerId)?.delete(conn);
      const s = this.sessions.get(ctx.code);
      if (s) s.instructorDirty = true;
    } else if (ctx.kind === "instructor") {
      this.instructors.get(ctx.code)?.delete(conn);
    }
    conn.ctx = { kind: "none" };
  }

  private bindPlayer(conn: Conn, s: Session, playerId: string) {
    this.detach(conn);
    conn.ctx = { kind: "player", code: s.code, playerId };
    const m = this.players.get(s.code)!;
    if (!m.has(playerId)) m.set(playerId, new Set());
    m.get(playerId)!.add(conn);
    s.dirtyPlayers.add(playerId);
    s.instructorDirty = true;
  }

  private session(code: unknown): Session {
    const s = this.sessions.get(String(code ?? "").trim().toUpperCase());
    if (!s) throw new CommandError("no session with that code");
    return s;
  }

  private handle(conn: Conn, m: any) {
    const ctx = conn.ctx;
    switch (m?.t) {
      // --- entry ---
      case "join": {
        const s = this.session(m.session);
        const { playerId, token } = s.join(m.name);
        this.bindPlayer(conn, s, playerId);
        this.send(conn, { t: "welcome", ref: m.ref, playerId, token, session: s.code });
        return;
      }
      case "resume": {
        const s = this.session(m.session);
        const p = s.playerByToken(String(m.token ?? ""));
        if (!p) throw new CommandError("unknown or expired player token");
        this.bindPlayer(conn, s, p.id);
        this.send(conn, { t: "welcome", ref: m.ref, playerId: p.id, token: m.token, session: s.code });
        return;
      }
      case "instructor": {
        const s = this.session(m.session);
        if (!s.checkInstructor(String(m.token ?? ""))) throw new CommandError("bad instructor token");
        this.detach(conn);
        conn.ctx = { kind: "instructor", code: s.code };
        this.instructors.get(s.code)!.add(conn);
        s.instructorDirty = true;
        this.send(conn, { t: "iwelcome", ref: m.ref, session: s.code });
        return;
      }
    }

    // --- player commands ---
    if (ctx.kind === "player") {
      const s = this.sessions.get(ctx.code)!;
      const pid = ctx.playerId;
      switch (m.t) {
        case "createTeam":
          return void this.send(conn, { t: "ok", ref: m.ref, teamCode: s.createTeam(pid) });
        case "joinTeam":
          s.joinTeam(pid, m.code);
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "leaveTeam":
          s.leaveTeam(pid);
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "submit":
          s.submit(pid, Number(m.round), !!m.release, Number(m.price));
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "plan":
          s.plan(pid, Number(m.round), !!m.on);
          return void this.send(conn, { t: "ok", ref: m.ref });
      }
    }

    // --- instructor commands ---
    if (ctx.kind === "instructor") {
      const s = this.sessions.get(ctx.code)!;
      switch (m.t) {
        case "autoPair":
          return void this.send(conn, { t: "ok", ref: m.ref, paired: s.autoPair() });
        case "start":
          s.startPhase(m.phase as PhaseName);
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "pause":
          s.pause();
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "resume":
          s.resume();
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "end":
          s.endPhase();
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "config":
          s.updateConfig(m.config);
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "removePlayer":
          s.removePlayer(String(m.playerId));
          return void this.send(conn, { t: "ok", ref: m.ref });
        case "movePlayer":
          s.movePlayer(String(m.playerId), m.teamCode ? String(m.teamCode) : null);
          return void this.send(conn, { t: "ok", ref: m.ref });
      }
    }
    throw new CommandError(ctx.kind === "none" ? "join or resume first" : `unknown command ${m?.t}`);
  }

  // ---------- HTTP ----------

  // Brute-force guard for the instructor password: 10 wrong tries per IP per 15 minutes.
  private loginFails = new Map<string, { n: number; until: number }>();
  private clientIp(req: http.IncomingMessage) {
    const fwd = this.opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  }
  private loginBlocked(ip: string) {
    const f = this.loginFails.get(ip);
    if (f && f.until < Date.now()) this.loginFails.delete(ip);
    return (this.loginFails.get(ip)?.n ?? 0) >= 10;
  }
  private loginFailed(ip: string) {
    const f = this.loginFails.get(ip) ?? { n: 0, until: Date.now() + 15 * 60_000 };
    f.n++;
    this.loginFails.set(ip, f);
    if (this.loginFails.size > 10_000) this.loginFails.clear(); // bound memory
  }

  private passwordOk(given: unknown) {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(this.opts.instructorPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/healthz") return json(200, { ok: true, sessions: this.sessions.size });

      if (req.method === "POST" && url.pathname === "/api/sessions") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return json(413, { error: "too large" });
        }
        let password: unknown;
        try {
          password = JSON.parse(body || "{}").password;
        } catch {
          return json(400, { error: "bad json" });
        }
        const ip = this.clientIp(req);
        if (this.loginBlocked(ip)) return json(429, { error: "Too many wrong passwords. Try again in 15 minutes." });
        if (!this.passwordOk(password)) {
          this.loginFailed(ip);
          return json(401, { error: "wrong instructor password" });
        }
        return json(201, this.createSession());
      }

      const api = url.pathname.match(/^\/api\/sessions\/([A-Z0-9]+)\/(export\.csv|debrief|games\/(practice|game1|game2)\/([A-Z0-9]+))$/);
      if (req.method === "GET" && api) {
        const s = this.sessions.get(api[1]);
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (!s || !s.checkInstructor(token)) return json(404, { error: "not found" });
        if (api[2] === "debrief") return json(200, debriefData(s));
        if (api[3]) {
          const d = gameDetail(s, api[3] as PhaseName, api[4]);
          return d ? json(200, d) : json(404, { error: "no such game" });
        }
        res.writeHead(200, {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="session-${s.code}.csv"`,
        });
        return res.end(exportCsv(s));
      }

      if ((req.method === "GET" || req.method === "HEAD") && this.opts.staticDir) return this.serveStatic(url.pathname, res);
      json(404, { error: "not found" });
    } catch (err) {
      console.error("[http]", err);
      if (!res.headersSent) json(500, { error: "server error" });
    }
  }

  private async serveStatic(pathname: string, res: http.ServerResponse) {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
    };
    const routes: Record<string, string> = { "/": "/index.html", "/play": "/index.html", "/instructor": "/instructor.html" };
    const rel = normalize(routes[pathname] ?? pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(this.opts.staticDir, rel);
    if (!file.startsWith(this.opts.staticDir)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      // File names aren't content-hashed, so make browsers revalidate: a redeploy is picked up on next load.
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

export function startServer(port: number, hub: Hub) {
  const server = http.createServer((req, res) => void hub.onHttp(req, res));
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG_BYTES });
  wss.on("connection", (ws) => hub.onConnection(ws));
  // Drop dead connections (laptops that slept, dropped Wi-Fi) so "connected" counts stay honest.
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 15_000);
  const tick = setInterval(() => hub.tick(), 100);
  return new Promise<{ server: http.Server; close: () => Promise<void> }>((resolve) => {
    server.listen(port, () =>
      resolve({
        server,
        close: async () => {
          clearInterval(ping);
          clearInterval(tick);
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          await new Promise<void>((r) => server.close(() => r()));
        },
      }),
    );
  });
}
