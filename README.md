# Complements: a classroom simulation of two complementary firms

Students play in teams of two: one runs the CPU maker (Intel), the other the OS maker (Microsoft). Every PC needs one of each. A session has three phases:
1. **Practice** (doesn't count)
2. **Game 1**
3. **Game 2**, in which teammates swap roles

| Folder | What's in it |
|---|---|
| `engine/` | Game rules and the demand model (pure TypeScript, tested). Shared by the server and the browser |
| `server/` | Node + WebSocket server: sessions, teams, phases, timers, bots, event log (file or Postgres). Load-tested with 1000 players |
| `web/` | Player page (`/play`) and instructor console (`/instructor`) |
| `SPEC.md` | Rules, design decisions, and how the demand model was fitted and tuned |

## Deploy

See [DEPLOY.md](DEPLOY.md). In short: push to GitHub, then create a Render Blueprint from `render.yaml`. That gives you one web service with a persistent disk, for about $7/month.

## Run a class locally

Needs Node 22+.

```bash
cd web && npm install && npm run build
```

```bash
cd server && npm install
```

```bash
cd server && STATIC_DIR=../web/dist INSTRUCTOR_PASSWORD=choose-one DATABASE_URL=postgres://… npm start
```

`DATABASE_URL` is optional: without it, the server logs to `server/data/events.jsonl`.

Then:
1. Open `/instructor`, enter the password, and create a session.
2. Click **Show join screen** for the projector.
3. Students go to `/play`, enter the code, and create or join a team.
4. **Auto-pair** anyone left without a partner.
5. Start Practice → Game 1 → Game 2. Review **Leaderboards** and **Debrief**, and download the CSV.

## Tests

```bash
cd engine && npm test
```

```bash
cd server && npm test
```

```bash
cd server && npm run loadtest
```

The load test needs a running server; see `server/README.md`.
