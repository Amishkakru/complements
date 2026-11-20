# Game server

Node 22+ with WebSockets. The rules live in `../engine`. This folder handles sessions, teams, phases, timers, persistence and the protocol.

## Run

```bash
npm install
INSTRUCTOR_PASSWORD=choose-one npm start
```

With no database it writes an event log to `data/events.jsonl`. For a real class, use Postgres:

```bash
INSTRUCTOR_PASSWORD=choose-one DATABASE_URL=postgres://user:pass@host/db npm start
```

| Env | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `INSTRUCTOR_PASSWORD` | (required) | Needed to create a session |
| `DATABASE_URL` | (none) | Postgres; the table is created automatically |
| `DATA_FILE` | `data/events.jsonl` | File store path, used when there's no `DATABASE_URL` |
| `STATIC_DIR` | (none) | Built web client; `/` and `/play` serve `index.html`, `/instructor` serves `instructor.html` |

## How it works

- **Event-sourced.**
  - Every change (a player joins, a team forms, a phase starts, a round resolves, and so on) is an event.
  - Events are appended to the store in batches every 50 ms.
  - On startup, the server replays the events to rebuild every session.
  - Running games restart their current round with a fresh timer.
  - A crash loses at most the last ~50 ms of events.
- **One process.**
  - Each session's games live in memory.
  - A 100 ms tick resolves rounds whose timer has run out.
  - State is pushed only to the two players in a changed game.
  - The instructor gets a summary at most once per second.
- **Safety.**
  - Each submission carries its round number, so stale or repeated ones are rejected.
  - Each connection is limited to 20 messages a second and 8 KB per message.
  - Dead sockets are dropped by a ping every 15 s.
  - Slow clients are skipped and sent the full state later.

## HTTP

- `POST /api/sessions` with `{password}` returns `{code, instructorToken}`
- `GET /api/sessions/:code/export.csv` returns every round of every game
- `GET /api/sessions/:code/debrief` returns a per-team summary for each phase: profits, releases, share of releases matched within one round, timeouts
- `GET /api/sessions/:code/games/:phase/:team` returns one game's full history

All three need `Authorization: Bearer <instructorToken>`.
- `GET /healthz`

## WebSocket protocol (`/ws`, JSON)

Every request may carry a `ref`. The reply (`ok`, `welcome`, `iwelcome` or `error`) echoes it back.

**Player**

| Send | Effect |
|---|---|
| `{t:"join", session, name}` | Returns `welcome {playerId, token}`. The client saves the token so it can reconnect |
| `{t:"resume", session, token}` | Reconnect after a refresh or dropped Wi-Fi |
| `{t:"createTeam"}` | Returns `ok {teamCode}` |
| `{t:"joinTeam", code}` | |
| `{t:"leaveTeam"}` | Between phases only |
| `{t:"submit", round, release, price}` | Can be changed until the round resolves |
| `{t:"plan", round, on}` | Release signal: a star the teammate can see. Not binding |

The server pushes `{t:"state", view}` whenever anything the player can see changes. `view` contains `session`, `team`, and `game`. `game` includes:
- `role`, `round`, and `deadline` (use `serverNow` to correct for clock offset)
- `config`, `sides`, `installedBase`, `history`, `submitted`
- `result` once the game is over

**Instructor**

| Send | Effect |
|---|---|
| `{t:"instructor", session, token}` | Subscribe to `istate` pushes |
| `{t:"config", config}` | Between phases only |
| `{t:"autoPair"}` | Pair everyone without a partner; a leftover student gets a bot |
| `{t:"movePlayer", playerId, teamCode \| null}` / `{t:"removePlayer", playerId}` | Between phases only |
| `{t:"start", phase}` | `practice`, `game1` or `game2`. Game 2 swaps each team's roles automatically |
| `{t:"pause"}` / `{t:"resume"}` / `{t:"end"}` | Applies to every game in the session at once |

`istate` contains:
- counts, roster and teams
- a live grid of games
- leaderboards per phase: by role and by team
- an overall ranking: each player's percentile as Intel and as Microsoft, averaged

## Tests

```bash
npm test
```

Covers the session logic: role swap, timeouts, auto-pairing, bots, pause, late teams, replay, views and CSV.

```bash
npm run typecheck
```

### Load test

Start a server, then run:

```bash
INSTRUCTOR_PASSWORD=... npm run loadtest -- http://localhost:8080 1000 20 summary.json
```

```bash
node --experimental-strip-types loadtest/verify-restore.ts summary.json
```

The second command is for after restarting the server.

Results on a MacBook against local Postgres:
- 1001 players → 501 games, 3 phases × 20 s, ~31 rounds per game per phase
- 93.7k submissions; round-trip p50 1 ms, p99 5 ms, max 26 ms
- No rounds timed out; role swap correct for 1001/1001 players
- After `kill -9` and a restart: leaderboards, CSV and player reconnects were all identical
