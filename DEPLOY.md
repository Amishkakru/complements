# Deploying Complements

The whole app is one container: the game server, the player page (`/play`) and the instructor console (`/instructor`). The recommended host is **Render**. `render.yaml` sets everything up, including a persistent disk for the event log. There's no separate database to run.

> **Run exactly one instance.** Live games are held in memory. The persistent disk also makes Render stop the old server before starting the new one on each deploy, so two servers never write the log at the same time.

## 1. Put the code on GitHub

Use a private repository. From the project folder:

```bash
git init
```

```bash
git add -A && git commit -m "Complements classroom simulation"
```

```bash
gh repo create complements --private --source . --push
```

`.gitignore` already leaves out `node_modules`, build output and local event logs.

## 2. Create the service on Render

1. Sign up at render.com and connect your GitHub account.
2. **New → Blueprint**, then pick the repository. Render reads `render.yaml` and proposes:
   - a **web service** `complements`, on the Starter plan, built from the `Dockerfile`, health-checked at `/healthz`
   - a **1 GB disk** mounted at `/var/data`, which holds the event log
3. Enter **INSTRUCTOR_PASSWORD** when asked. Use at least 12 characters: the server refuses anything shorter in production. Anyone with this password can create sessions.
4. Click **Apply**. The first build takes a few minutes. You get a URL like `https://complements-xxxx.onrender.com`.

**Region:** `render.yaml` says `singapore`. Change it to the region closest to your classroom before the first deploy; Render can't move an existing service.

**Cost:** roughly $7/month for Starter, plus about $0.25/month for the 1 GB disk at the time of writing. Check Render's pricing page. The free plan is unsuitable: it sleeps when idle and has no persistent disk.

**Optional:** add a custom domain under the service's **Settings**. HTTPS is automatic, and the pages switch to secure WebSockets on their own.

## 3. Check it works

1. Open `https://<your-url>/healthz`. It should show `{"ok":true,…}`.
2. Open `/instructor`, enter the password, and create a session.
3. On two phones, open `/play`, join, and form a team. Start Practice and play a few rounds.

## 4. Dress rehearsal: 1000 simulated students

Do this before your first big class, from a laptop on a decent connection, not the classroom Wi-Fi. From the `server/` folder:

```bash
INSTRUCTOR_PASSWORD='<your password>' npm run loadtest -- https://<your-url> 1000 20
```

It creates its own session and runs Practice, Game 1 and Game 2 with 1000 bots. On a laptop against a local server, submit round-trip was p99 7 ms. Over the internet, expect your network latency on top of that. Look for:
- `role swap … 1000/1000`
- no errors other than the expected late submits after a phase ends

## 5. On class day

- **Don't deploy during a class.** A deploy restarts the server, which takes about a minute. Games aren't lost: students' pages reconnect by themselves, and every game resumes on its current round with a fresh timer. It's still disruptive.
- Project the join screen from the Lobby tab (**Show join screen**).
- After class, use **Debrief → Download CSV**.
- Sessions untouched for 14 days are unloaded from memory, to keep the server small. Their data stays in the log, but they no longer appear in the console. `SESSION_RETENTION_DAYS` changes the window.

## 6. Updating

Push to the main branch and Render rebuilds and redeploys automatically. You can turn that off under **Settings → Auto-Deploy** if you'd rather deploy by hand.

## 7. Backups

Render snapshots persistent disks daily. The CSV export is the per-class record. The raw log is `/var/data/events.jsonl` (about 8 MB per 1000-student session). Download it from Render's **Shell** if you need it.

## Other hosts

Any Docker host works:

```bash
docker build -t complements .
```

```bash
docker run -p 8080:8080 -e INSTRUCTOR_PASSWORD=… -e DATA_FILE=/var/data/events.jsonl -e ALLOW_FILE_STORE=1 -v complements-data:/var/data complements
```

| Variable | Purpose |
|---|---|
| `INSTRUCTOR_PASSWORD` | Required. At least 12 characters in production |
| `DATA_FILE` + `ALLOW_FILE_STORE=1` | Event log on a persistent volume |
| `DATABASE_URL` | Use Postgres instead of the file. The table is created automatically |
| `TRUST_PROXY=1` | Set when behind a load balancer, so the password lockout sees real client IPs |
| `SESSION_RETENTION_DAYS` | How long idle sessions stay loaded (default 14) |
| `PORT` | Default 8080 |

Keep it to one instance. If your host does zero-downtime deploys by starting the new copy first (Fly.io, Railway, Kubernetes rolling updates), switch to a stop-first strategy. Otherwise moves made during the overlap can be lost.

## What was verified before this guide was written

Docker isn't installed on the machine this was built on, so the image itself hasn't been built yet; Render's first build will be the first real one. Instead, the Dockerfile's exact steps were run in a clean copy of the project: `npm ci` from the lockfiles, production-only server dependencies, then the web build. The server then ran with `NODE_ENV=production`, file store and `TRUST_PROXY=1`:

- **Startup checks:** it refuses a short password, and refuses to start with no durable storage.
- **Pages and headers:** `/healthz`, `/play` and `/instructor` serve with security headers. The browser shows no content-security-policy violations.
- **Password lockout:** 10 wrong passwords from one IP gives a 429 on the 11th. Other IPs are unaffected.
- **1000 bots, all three phases:** role swap correct for 1000/1000 players, p99 submit 7 ms.
- **Graceful stop and restart:** the session comes back identical (leaderboards, CSV, player reconnect). About 100 MB of memory with two 1000-player sessions loaded; Starter has 512 MB.
