// Entry point. Env:
//   PORT                 default 8080
//   DATABASE_URL         use Postgres (recommended for real classes); otherwise a local JSON-lines file
//   DATA_FILE            event log path when not using Postgres (default ./data/events.jsonl)
//   INSTRUCTOR_PASSWORD  required to create sessions
//   STATIC_DIR           built web client to serve (optional)
//   TRUST_PROXY          set to 1 behind a load balancer so login rate-limiting sees real client IPs
//   SESSION_RETENTION_DAYS  sessions idle longer than this aren't kept in memory (default 14; data stays in the log)
//   NODE_ENV=production  refuses unsafe setups (short password, file store on a disk that redeploys wipe)
import { resolve } from "node:path";
import { Hub, startServer } from "./server.ts";
import { FileStore, PgStore, type EventStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8080);
const password = process.env.INSTRUCTOR_PASSWORD;
if (!password) {
  console.error("Set INSTRUCTOR_PASSWORD before starting the server.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  if (password.length < 12) {
    console.error("INSTRUCTOR_PASSWORD must be at least 12 characters in production.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && process.env.ALLOW_FILE_STORE !== "1") {
    console.error("Set DATABASE_URL in production: most hosts wipe the local disk on every deploy, which would lose all sessions. (ALLOW_FILE_STORE=1 overrides this if you have a persistent disk.)");
    process.exit(1);
  }
}

const store: EventStore = process.env.DATABASE_URL
  ? new PgStore(process.env.DATABASE_URL)
  : new FileStore(resolve(process.env.DATA_FILE ?? "data/events.jsonl"));

const hub = new Hub({
  store,
  instructorPassword: password,
  staticDir: process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : "",
  trustProxy: process.env.TRUST_PROXY === "1",
  retentionDays: Number(process.env.SESSION_RETENTION_DAYS ?? 14),
});
const restored = await hub.restore();
const { close } = await startServer(port, hub);
console.log(
  `listening on :${port} (${process.env.DATABASE_URL ? "postgres" : "file"} store, ${restored} session(s) restored)`,
);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log("shutting down, flushing events…");
    await close();
    await store.close();
    process.exit(0);
  });
}
