# Complements Sim: Spec (v0.1)

A classroom game about two complementary firms: a CPU maker ("Intel") and an OS maker ("Microsoft").
It follows the published mechanics of the HBS Wintel V2 user guide. It is our own build, with our own UI and name, and no HBS branding or assets.

Target scale: **1000 concurrent players** running **~500 independent games** at the same time.

---

## 1. Session structure

A **team is two students who play each other**: one is Intel, the other is Microsoft. ~1000 players means ~500 teams, and each team is one game.

Each class session runs three phases, in order. The instructor controls when each one starts and ends.

| Phase | Counts for score? | Partner | Roles |
|---|---|---|---|
| **Practice** | No | Teammate | As in Game 1 |
| **Game 1** | Yes | Teammate | Player A = Intel, Player B = Microsoft |
| **Game 2** | Yes | Same teammate | **Swapped**: A = Microsoft, B = Intel |

- **Forming teams:** a student joins the session and either creates a team (and gets a 4-character team code) or enters a teammate's code. Before Practice starts, the instructor can auto-pair anyone without a team, and can edit pairs by hand.
- Roles are assigned at random in Game 1. The swap for Game 2 happens automatically.
- Each player plays one game as each company. **Leaderboards:**
  - **by role, per game:** best Intel and best Microsoft in Game 1 and in Game 2
  - **per player:** Intel result plus Microsoft result, each normalized within its role
  - **per team:** joint profit, which shows how well each pair cooperated
- A student left without a partner plays a bot. The instructor can see which games include a bot.

## 2. Rules for a single game

- At the start, both sides are on **version 1**. Starting prices: Intel $400, MS $50.
- **Each round**, each side submits: release a new version (yes/no) and a price.
- **Timeout default:** no release, last round's price.
- **Release signalling:** a side can tick a future round as a planned release. The opponent sees it as a star. It does not commit anyone.
- Both sides see the same public information. Each side's scratch pad is private.

### Profit per round
- **Intel:** `q·(p_I − mc_I) − rc_I·[released]`. `mc_I` is **constant** ($150).
- **MS:** `q·p_M + q_newPCs·r_new + q_oldPCs·r_old − rc_M·[released]`
  - Installed base = PCs sold in the previous **5** rounds (configurable).
  - "New" PCs are those sold while the current OS version was on sale. When MS releases a version, the whole existing base becomes "old".
  - `r_new` = $40, `r_old` = $20.
- **Release cost:** starts at $2,300MM for each side. It grows by `g` per release that side makes. The cost is paid in full in the release round.
- **Cumulative profit:** `π_cum(n) = π_cum(n−1)·(1+r) + π_n`, with r = 1.2% per round.

### Demand (our model, since the guide doesn't publish one)
Demand is a straight line, `q = Q·(1 − (p_I + p_M)/A)`, where:
- `T(v) = 1 + ρ + … + ρ^(v−2)`. This is the tech value of version v; each newer version is worth ρ times the previous one.
- `tech = T(min version) + γ·(T(max version) − T(min version))`. A lead that the other side hasn't matched counts only γ (37%).
- `A = 500·(1 + α·tech − δ·(age_I + age_M))`, and `Q = 50·(1 + k·α·tech)`.
- `age` = rounds since that product's last release.

The parameters (α = 0.334, γ = 0.368, δ = 0.0184, k = 0.5) are fitted so that the guide's example sequence matches **exactly**: 5.0 → 9.82 → 8.33 → 17.86 MM PCs, along with every profit figure in that example.

**Default γ = 0 (coordination tuning).** With the fitted γ = 0.368, being out of step barely mattered. Controlled bot runs used the same number of releases with best-response pricing over 20 rounds:
- A partner lagging 2 rounds cost only 7%.
- Releasing alone *raised* the releaser's profit by 37%.

The default is therefore γ = 0: a new version only lifts demand once both companies are on it. Fully synced play is unchanged. With γ = 0:
- lagging 1 / 2 / 3 rounds costs 5% / 11% / 16%, and both firms lose
- releasing alone leaves the releaser 23% worse off than never releasing

The trade-off is that the guide's round 1 (Intel releases alone) now sells 4.2M instead of 9.8M. Setting γ = 0.3677 in Settings restores the guide's numbers exactly; a test covers both. Below zero, a solo release crashes sales towards zero, which reads as a bug, so the floor is 0. The comparison is in `engine/sim/coordination.ts` and `sim/tune-gamma.ts`.

The parameters ρ = 0.7 and g = 20% come from the bot simulations:
- With these values, **coordinated releases every 4–5 rounds** score highest.
- Staggered or uncoordinated releases score about 5% lower.
- Releasing alone, never releasing, or releasing every round all lose badly.
- The guide's own example of 10% growth plus linear tech made "release every round" the best strategy, which breaks the game.

### Timing and end
- Round length shrinks exponentially from a start time to an end time, both set by the instructor. The default is 150s → 40s.
- A round right after any release gets **+45s**.
- Each pair moves at its own pace: once both sides submit, the round resolves straight away.
- The instructor ends a phase for **all games at once**. Players never know the round count in advance. The hard cap is 60 rounds.

## 3. Screens

### Player page (`/play`)
- Join with a session code and display name, create a team or join one with a teammate's code, then wait in a lobby until the phase starts. Each screen shows your role in this phase and your teammate's name.
- Decision panel: release yes/no, price, submit button, countdown.
- Values panel: release costs, Intel MC, MS revenue per new/old PC, installed base, discount rate, cumulative profits.
- **Scratch pad:** a demand-curve chart with sliders for both prices and both release toggles. It uses the same engine code in the browser and only shows what-ifs; nothing is submitted.
- Rounds table: past prices, PCs sold and profits, stars for past releases, and checkboxes for planned releases.
- End-of-phase screen: your rank within your role and your team's joint profit. Before Game 2 it says "you're switching to Microsoft/Intel", then shows a "waiting for next phase" screen.

### Instructor page (`/instructor`, separate login)
- **Setup:** create a session (join code + QR), set parameters (all of §2), set round timings, and choose practice length (rounds or minutes).
- **Lobby:** live count of joined players and teams, unpaired students highlighted, an **Auto-pair remaining** button, and controls to edit pairs, remove players or rename them.
- **Run:** start Practice / Game 1 / Game 2, pause or resume all games, and **End phase now**.
- **Monitor:** a live grid of every game showing current round, who has or hasn't submitted, releases, and cumulative profit. Flags for disconnected players and bot games.
- **Leaderboards:** per role and per phase, plus the combined ranking.
- **Debrief:** profit distribution by role, release-timing patterns (coordinated vs not), the effect of signalling, best and worst pairs, and a replay of any single game. CSV export of everything.

## 4. Architecture

- **Engine** (`engine/src/engine.ts`): pure TypeScript with no I/O, shared by the server and the browser. ✅ Built and tested.
- **Server:** Node with WebSockets.
  - Each session holds its games in memory as small independent state machines.
  - Timers run on the server, so the server's result is final.
  - Every decision and round result is appended to Postgres. On restart, games are rebuilt by replaying those rows.
  - Submissions carry `(gameId, round)` so a resent submission isn't counted twice.
  - Reconnecting sends the player the full current state.
- **Web:** Next.js (React) for the player and instructor pages; chart library for the scratch pad and debrief.
- **Scale:** 1000 sockets and ~500 games is light load for one Node process. There is no state shared across games, so nothing locks the whole session. The instructor dashboard gets a summary every 1–2 seconds, not every event.
- **Load test:** 1000 bot players run Practice → Game 1 → Game 2 in one session, checking latency and correctness.
- **Deploy:** one app server plus managed Postgres, over HTTPS.

## 5. Build order
1. ✅ Engine + tests + bot simulator (`engine/`)
2. ✅ Server: sessions, team formation, phases (including the role swap), timers, persistence (`server/`). Load-tested with 1001 players.
3. ✅ Player page with scratch pad (`web/`)
4. ✅ Instructor page (`web/src/instructor.ts`)
5. ✅ Load test with 1000 bots; deployment setup (`Dockerfile`, `render.yaml`, `DEPLOY.md`)
