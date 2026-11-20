// Append-only event log. Writes are batched (flushed every ~50ms) so a busy round costs one DB round-trip.
import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import pg from "pg";
import type { SessionEvent } from "./session.ts";

export interface StoredEvent {
  session: string;
  seq: number;
  ts: number;
  event: SessionEvent;
}

export interface LoadResult {
  events: StoredEvent[]; // only sessions active since `activeSince`
  known: Set<string>; // every session code ever used, so codes are never reused
}

export interface EventStore {
  load(activeSince?: number): Promise<LoadResult>;
  append(e: StoredEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

abstract class BatchingStore implements EventStore {
  private queue: StoredEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();
  abstract load(activeSince?: number): Promise<LoadResult>;
  protected abstract write(batch: StoredEvent[]): Promise<void>;

  append(e: StoredEvent) {
    this.queue.push(e);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 50);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    // Serialise writes so events land in order.
    this.inflight = this.inflight.then(async () => {
      if (!batch.length) return;
      try {
        await this.write(batch);
      } catch (err) {
        console.error(`[store] write failed for ${batch.length} events; retrying next flush`, err);
        this.queue.unshift(...batch);
        if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1000);
      }
    });
    return this.inflight;
  }
  async close() {
    await this.flush();
  }
}

/** JSON-lines file: zero setup, fine for development and small classes. */
export class FileStore extends BatchingStore {
  private path: string;
  constructor(path: string) {
    super();
    this.path = path;
  }
  /** Two streaming passes: find each session's last activity cheaply, then parse only the sessions to keep. */
  async load(activeSince = 0): Promise<LoadResult> {
    await mkdir(dirname(this.path), { recursive: true });
    const known = new Set<string>();
    const events: StoredEvent[] = [];
    if (!existsSync(this.path)) return { events, known };
    const head = /^\{"session":"([A-Z0-9]+)","seq":\d+,"ts":(\d+)/;
    const lines = () => createInterface({ input: createReadStream(this.path, "utf8"), crlfDelay: Infinity });
    const last = new Map<string, number>();
    for await (const line of lines()) {
      const m = head.exec(line);
      if (!m) continue;
      known.add(m[1]);
      last.set(m[1], Math.max(last.get(m[1]) ?? 0, Number(m[2])));
    }
    const keep = new Set([...last].filter(([, ts]) => ts >= activeSince).map(([code]) => code));
    for await (const line of lines()) {
      const m = head.exec(line);
      if (!m || !keep.has(m[1])) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        console.warn("[store] skipping corrupt line (likely a torn write at crash)");
      }
    }
    return { events, known };
  }
  protected async write(batch: StoredEvent[]) {
    await appendFile(this.path, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

/** Postgres: one table, one multi-row INSERT per batch. */
export class PgStore extends BatchingStore {
  private pool: pg.Pool;
  constructor(url: string) {
    super();
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }
  async load(activeSince = 0): Promise<LoadResult> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        session text NOT NULL,
        seq integer NOT NULL,
        ts bigint NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (session, seq)
      )`);
    const known = new Set<string>((await this.pool.query("SELECT DISTINCT session FROM events")).rows.map((x) => x.session));
    const r = await this.pool.query(
      `SELECT session, seq, ts, data FROM events
       WHERE session IN (SELECT session FROM events GROUP BY session HAVING max(ts) >= $1)
       ORDER BY session, seq`,
      [activeSince],
    );
    return { known, events: r.rows.map((x) => ({ session: x.session, seq: x.seq, ts: Number(x.ts), event: x.data })) };
  }
  protected async write(batch: StoredEvent[]) {
    for (let start = 0; start < batch.length; start += 1000) {
      const chunk = batch.slice(start, start + 1000);
      const vals: unknown[] = [];
      const rows = chunk.map((e, i) => {
        vals.push(e.session, e.seq, e.ts, JSON.stringify(e.event));
        return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
      });
      // ON CONFLICT DO NOTHING makes a retried batch harmless.
      await this.pool.query(`INSERT INTO events (session, seq, ts, data) VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`, vals);
    }
  }
  async close() {
    await super.close();
    await this.pool.end();
  }
}

export class MemoryStore extends BatchingStore {
  events: StoredEvent[] = [];
  async load(activeSince = 0): Promise<LoadResult> {
    const last = new Map<string, number>();
    for (const e of this.events) last.set(e.session, Math.max(last.get(e.session) ?? 0, e.ts));
    return {
      known: new Set(last.keys()),
      events: this.events.filter((e) => (last.get(e.session) ?? 0) >= activeSince),
    };
  }
  protected async write(batch: StoredEvent[]) {
    this.events.push(...batch);
  }
}
