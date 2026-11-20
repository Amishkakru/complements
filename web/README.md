# Web client

Plain TypeScript and DOM with no framework. It's bundled by esbuild into `dist/`, which the game server serves.

## Build and run

From `web/`:

```bash
npm install
```

```bash
npm run build
```

Then from `server/`:

```bash
STATIC_DIR=../web/dist INSTRUCTOR_PASSWORD=choose-one npm start
```

Students open `http://<host>:8080/play?s=<SESSION CODE>`, or just `/`, and type the code.

## Player page (`src/player.ts`)

| Screen | When |
|---|---|
| Join | No saved token for this session |
| Team | Create a team (shows a 4-letter code) or join with a teammate's code |
| Waiting | Teamed up; waiting for the instructor to start the next phase |
| Game | Decision, values, scratch pad, rounds table. A results card shows once the phase ends, saying which role you'll play next |

**Decision panel**
- Release yes/no and a price.
- You can change your decision until your teammate submits. The round resolves the moment both have submitted.

**Values**
- Cumulative profit, versions, prices and next release cost for both sides.
- Intel's cost per unit, Microsoft's installed-base revenue, the installed base, the discount rate and release-cost growth.

**Scratch pad**
- Runs the same engine code as the server (`../engine/src/engine.ts`), so its what-ifs match the real results exactly.
- The demand line is drawn with a stacked bar: Intel cost, Intel margin, Microsoft margin.
- A dashed line shows the curve with no releases, for comparison.
- One button copies your scratch-pad choice into the decision form.

**Rounds table**
- ★ marks past releases and ☆ marks planned ones.
- Ticking a future round in your own column sends a non-binding release signal, which your teammate sees live.

**Connection**
- The token is kept in `localStorage`, so a refresh or a laptop waking from sleep resumes straight back into the game.
- A banner shows while reconnecting.
- The timer uses the server's clock, so a wrong laptop clock doesn't matter.

Works at phone width and in light and dark mode.

## Instructor page (`src/instructor.ts`, served at `/instructor`)

**Start**
- Enter the instructor password to create a session.
- Sessions you create are remembered in this browser, with a list to reopen them.
- `/instructor?s=CODE` reopens a session directly.

**Control bar**
- The three phases with their status (done ✓ / running / next), plus Start, Pause/Resume and End now.
- It warns before starting if any student has no partner.
- Ending a phase asks for confirmation.

**Tiles:** students, online, teams, without a partner, games, average round, games waiting on a decision.

**Lobby**
- How to join, plus a full-screen join screen for the projector.
- **Auto-pair**: a leftover student gets a bot.
- A searchable roster with partner and online status. Unpaired students are highlighted.
- Move / Unpair / Remove, available between phases.

**Live games**
- One row per team: both players' online and submitted status, the round, time left, and profits.
- Filters: waiting on a decision, someone offline, has a bot, finished.
- Click a row to see that game round by round.

**Leaderboards**
- Per phase: top Intel, top Microsoft, and top teams by joint profit.
- Overall: each student's percentile as Intel and as Microsoft, averaged.

**Debrief**
- "Did coordinating releases pay?": a scatter with one dot per team.
- A histogram of team profit.
- Game 1 vs Game 2 averages by role, with the same students in switched roles.
- A table view, and a CSV download of every round.

**Settings**
- Timing, prices, costs, installed base and the demand parameters.
- Locked while a phase is running; changes apply from the next phase.

Tested with 1000 simulated students and 500 live games: no main-thread stalls over 50 ms while the page refreshes every second.
