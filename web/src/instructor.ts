// Instructor console: create/open a session, pair students, run phases, watch games, see results.
import type { GameConfig, Role, RoundResult } from "../../engine/src/engine.ts";
import { Net, type Msg } from "./net.ts";
import { attachTooltips, histogramSvg, scatterSvg } from "./charts-debrief.ts";

type Phase = "practice" | "game1" | "game2";
const PHASES: Phase[] = ["practice", "game1", "game2"];
const PHASE: Record<Phase, string> = { practice: "Practice", game1: "Game 1", game2: "Game 2" };

interface RoleRow { teamCode: string; playerId: string; name: string; cumProfit: number; rounds: number }
interface TeamRow { teamCode: string; intel: string; ms: string; joint: number; rounds: number }
interface Board { intel: RoleRow[]; ms: RoleRow[]; teams: TeamRow[] }
interface GameRow {
  team: string; round: number; over: boolean; hasBot: boolean; deadline: number | null;
  intel: { name: string; connected: boolean; submitted: boolean; cum: number; version: number };
  ms: { name: string; connected: boolean; submitted: boolean; cum: number; version: number };
}
interface IView {
  serverNow: number;
  session: { code: string; status: "lobby" | "running" | "paused" | "between" | "done"; phase: Phase | null; played: Phase[] };
  config: GameConfig;
  counts: { players: number; connected: number; teams: number; unpaired: number };
  players: { id: string; name: string; team: string | null; connected: boolean }[];
  teams: { code: string; members: string[]; bot: boolean }[];
  games: GameRow[];
  boards: Partial<Record<Phase, Board>>;
  overall: { playerId: string; name: string; score: number; intelPct: number | null; msPct: number | null }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const int = (x: number) => Math.round(x).toLocaleString("en-US");
const mm = (x: number) => `<span class="${x < 0 ? "neg" : ""}">${x < 0 ? "−" : ""}$${int(Math.abs(x))}M</span>`;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

interface Saved { code: string; token: string; created: number }
const saved = (): Saved[] => {
  try { return JSON.parse(store.get("ci:sessions") ?? "[]"); } catch { return []; }
};
const saveSession = (s: Saved) => store.set("ci:sessions", JSON.stringify([s, ...saved().filter((x) => x.code !== s.code)].slice(0, 20)));

const net = new Net(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
let current: Saved | null = null;
let view: IView | null = null;
let offset = 0;
let tab = store.get("ci:tab") ?? "lobby";
const ui = { rosterQ: "", gamesQ: "", gamesFilter: "all", boardPhase: "" as Phase | "overall" | "", debriefPhase: "" as Phase | "" };
let debrief: Record<Phase, any[]> | null = null;

function toast(msg: string, kind: "error" | "info" = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.className = "toast"), 3500);
}
async function cmd(m: Msg) {
  try {
    return await net.call(m);
  } catch (e) {
    toast((e as Error).message);
    throw e;
  }
}
async function api(path: string) {
  const r = await fetch(`/api/sessions/${current!.code}/${path}`, { headers: { authorization: `Bearer ${current!.token}` } });
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r;
}

// ---------- connection ----------
net.onStatus = (s) => {
  $("conn").hidden = s === "open";
  $("conn").textContent = s === "connecting" ? "Connecting…" : "Connection lost. Reconnecting…";
};
net.onUnsolicitedError = (m) => toast(m);
net.onOpen = () => {
  if (current) net.call({ t: "instructor", session: current.code, token: current.token }).catch((e) => {
    toast(e.message);
    current = null;
    view = null;
    renderAuth();
  });
};
net.onMessage = (m) => {
  if (m.t !== "istate" || !current) return;
  view = m.view;
  offset = view!.serverNow - Date.now();
  renderConsole();
};

// ---------- auth screen ----------
function renderAuth() {
  document.body.dataset.screen = "auth";
  $("hdr-info").innerHTML = "";
  const list = saved();
  $("app").innerHTML = `
    <section class="card narrow stack">
      <h1>Instructor console</h1>
      <form id="create-form" class="stack">
        <h2>New session</h2>
        <label>Instructor password<input id="pw" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Create session</button>
      </form>
      ${list.length ? `<div class="stack"><h2>Your recent sessions</h2><ul class="saved">${list.map((s) => `<li><button class="secondary" data-open="${esc(s.code)}">${esc(s.code)}</button><span class="muted small">created ${new Date(s.created).toLocaleString()}</span></li>`).join("")}</ul></div>` : ""}
      <p class="muted small">Sessions you create are remembered in this browser. To run a session from another computer, create it there.</p>
    </section>`;
  $("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = (e.target as HTMLFormElement).querySelector("button")!;
    btn.disabled = true;
    try {
      const r = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $<HTMLInputElement>("pw").value }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Could not create session");
      open({ code: body.code, token: body.instructorToken, created: Date.now() });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      btn.disabled = false;
    }
  });
  $("app").querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => (b.onclick = () => open(list.find((s) => s.code === b.dataset.open)!)));
}

function open(s: Saved) {
  current = s;
  saveSession(s);
  history.replaceState(null, "", `/instructor?s=${s.code}`);
  view = null;
  mountConsole();
  net.connect();
  net.call({ t: "instructor", session: s.code, token: s.token }).catch((e) => {
    toast(e.message);
    current = null;
    renderAuth();
  });
}

// ---------- console ----------
function mountConsole() {
  document.body.dataset.screen = "console";
  $("app").innerHTML = `
    <section class="card controlbar">
      <ol class="stepper" id="stepper"></ol>
      <div class="controls" id="controls"></div>
    </section>
    <div class="stats" id="stats"></div>
    <nav class="tabs" role="tablist">
      ${[["lobby", "Lobby"], ["games", "Live games"], ["results", "Leaderboards"], ["debrief", "Debrief"], ["settings", "Settings"]].map(([id, label]) => `<button role="tab" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}">${label}</button>`).join("")}
    </nav>
    <section class="card panel" id="panel-lobby" role="tabpanel">
      <div class="row between">
        <div><h2>Students</h2><p class="muted small">Students go to <strong id="join-url"></strong> and enter code <strong id="join-code"></strong>, then form teams of two.</p></div>
        <div class="row"><button class="secondary" id="project">Show join screen</button><button class="primary" id="autopair">Auto-pair unpaired students</button></div>
      </div>
      <input id="roster-q" class="search" type="search" placeholder="Search name or team code" aria-label="Search students">
      <div class="table-wrap tall" id="roster"></div>
    </section>
    <section class="card panel" id="panel-games" role="tabpanel">
      <div class="row between">
        <h2 id="games-title">Live games</h2>
        <div class="chips" id="games-filter">
          ${[["all", "All"], ["waiting", "Waiting on a decision"], ["offline", "Someone offline"], ["bot", "Has a bot"], ["over", "Finished"]].map(([v, l]) => `<button class="chip" data-f="${v}">${l}</button>`).join("")}
        </div>
      </div>
      <input id="games-q" class="search" type="search" placeholder="Search name or team code" aria-label="Search games">
      <div class="table-wrap tall" id="games"></div>
    </section>
    <section class="card panel" id="panel-results" role="tabpanel">
      <div class="row between"><h2>Leaderboards</h2><div class="chips" id="board-phase"></div></div>
      <div id="boards"></div>
    </section>
    <section class="card panel" id="panel-debrief" role="tabpanel">
      <div class="row between"><h2>Debrief</h2><div class="row"><div class="chips" id="debrief-phase"></div><button class="secondary" id="debrief-refresh">Refresh</button><button class="secondary" id="csv">Download CSV</button></div></div>
      <div id="debrief"></div>
    </section>
    <section class="card panel" id="panel-settings" role="tabpanel">
      <h2>Settings</h2>
      <p class="muted small" id="settings-note"></p>
      <form id="settings" class="settings"></form>
    </section>
    <div class="overlay" id="overlay" hidden></div>
    <aside class="drawer" id="drawer" hidden aria-labelledby="drawer-title"></aside>`;

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab!)));
  $("autopair").onclick = async () => {
    const r = await cmd({ t: "autoPair" });
    toast(r.paired ? `Paired ${r.paired} team${r.paired === 1 ? "" : "s"}.` : "Everyone already has a partner.", "info");
  };
  $("project").onclick = showJoinScreen;
  $("roster-q").addEventListener("input", (e) => ((ui.rosterQ = (e.target as HTMLInputElement).value.toLowerCase()), renderRoster()));
  $("games-q").addEventListener("input", (e) => ((ui.gamesQ = (e.target as HTMLInputElement).value.toLowerCase()), renderGames()));
  $("games-filter").addEventListener("click", (e) => {
    const f = (e.target as HTMLElement).dataset.f;
    if (f) (ui.gamesFilter = f), renderGames();
  });
  $("roster").addEventListener("click", onRosterAction);
  $("games").addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest("tr[data-team]") as HTMLElement | null;
    if (tr && view?.session.phase) openGame(view.session.phase, tr.dataset.team!);
  });
  $("boards").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-game]") as HTMLElement | null;
    if (b) openGame(b.dataset.phase as Phase, b.dataset.game!);
  });
  $("board-phase").addEventListener("click", (e) => {
    const p = (e.target as HTMLElement).dataset.p;
    if (p) (ui.boardPhase = p as Phase), renderBoards();
  });
  $("debrief-phase").addEventListener("click", (e) => {
    const p = (e.target as HTMLElement).dataset.p;
    if (p) (ui.debriefPhase = p as Phase), renderDebrief();
  });
  $("debrief-refresh").onclick = () => void loadDebrief();
  $("csv").onclick = downloadCsv;
  $("settings").addEventListener("submit", saveSettings);
  attachTooltips($("debrief"));
  selectTab(tab);
}

function selectTab(t: string) {
  tab = t;
  store.set("ci:tab", t);
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  document.querySelectorAll<HTMLElement>(".panel").forEach((p) => (p.hidden = p.id !== `panel-${t}`));
  if (t === "debrief" && !debrief) void loadDebrief();
  if (t === "settings") renderSettings(true);
  renderConsole();
}

function renderConsole() {
  if (!view || !current || document.body.dataset.screen !== "console") return;
  const v = view;
  $("hdr-info").innerHTML = `<span class="pill">Session ${esc(v.session.code)}</span><span class="pill status-${v.session.status}">${statusLabel()}</span>`;
  renderControls();
  renderStats();
  if (tab === "lobby") renderRoster();
  if (tab === "games") renderGames();
  if (tab === "results") renderBoards();
  if (tab === "settings") renderSettings(false);
  // Refresh the debrief whenever a phase starts or ends, so it never shows stale results.
  const phaseKey = `${v.session.status}:${v.session.phase}`;
  if (phaseKey !== lastPhaseKey) {
    lastPhaseKey = phaseKey;
    debrief = null;
    if (tab === "debrief") void loadDebrief();
  }
}
let lastPhaseKey = "";

function statusLabel() {
  const s = view!.session;
  if (s.status === "lobby") return "Lobby";
  if (s.status === "done") return "Session finished";
  const p = s.phase ? PHASE[s.phase] : "";
  return s.status === "running" ? `${p} running` : s.status === "paused" ? `${p} paused` : `${p} finished`;
}

function nextPhase(): Phase | null {
  return PHASES.find((p) => !view!.session.played.includes(p)) ?? null;
}

function renderControls() {
  const s = view!.session;
  $("stepper").innerHTML = PHASES.map((p) => {
    const state = s.phase === p && (s.status === "running" || s.status === "paused") ? "active" : s.played.includes(p) ? "done" : "todo";
    return `<li class="step ${state}"><span class="bullet" aria-hidden="true">${state === "done" ? "✓" : PHASES.indexOf(p) + 1}</span>${PHASE[p]}${p === "game2" ? `<span class="muted small"> · roles swap</span>` : ""}</li>`;
  }).join("");
  const next = nextPhase();
  const live = s.status === "running" || s.status === "paused";
  const ready = view!.counts.teams > 0;
  $("controls").innerHTML = live
    ? `${s.status === "running" ? `<button class="secondary" id="c-pause">Pause all games</button>` : `<button class="primary" id="c-resume">Resume</button>`}
       <button class="danger" id="c-end">End ${PHASE[s.phase!]} now</button>`
    : next
      ? `<button class="primary" id="c-start" ${ready ? "" : "disabled"}>Start ${PHASE[next]}</button>
         ${ready ? (view!.counts.unpaired ? `<span class="warn small">${view!.counts.unpaired} student${view!.counts.unpaired === 1 ? " has" : "s have"} no partner and won't play. Auto-pair first.</span>` : "") : `<span class="muted small">Waiting for at least one complete team.</span>`}`
      : `<span class="muted">All three phases are done. See Leaderboards and Debrief.</span>`;
  $("c-pause")?.addEventListener("click", () => void cmd({ t: "pause" }));
  $("c-resume")?.addEventListener("click", () => void cmd({ t: "resume" }));
  $("c-end")?.addEventListener("click", () => {
    if (confirm(`End ${PHASE[s.phase!]} for every team now? Players can't continue this phase afterwards.`)) {
      void cmd({ t: "end" }).then(() => (debrief = null));
    }
  });
  $("c-start")?.addEventListener("click", () => {
    const n = view!.counts.unpaired;
    if (n && !confirm(`${n} student${n === 1 ? " has" : "s have"} no partner and will sit out. Start anyway?`)) return;
    void cmd({ t: "start", phase: next });
  });
}

function renderStats() {
  const v = view!;
  const live = v.session.status === "running" || v.session.status === "paused";
  const tiles: [string, string, string?][] = [
    ["Students", int(v.counts.players)],
    ["Online", int(v.counts.connected), v.counts.connected < v.counts.players ? "warn" : ""],
    ["Teams", int(v.counts.teams)],
    ["Without a partner", int(v.counts.unpaired), v.counts.unpaired ? "warn" : ""],
  ];
  if (live || v.games.length) {
    const g = v.games;
    const active = g.filter((x) => !x.over);
    const waiting = active.filter((x) => !x.intel.submitted || !x.ms.submitted).length;
    const rounds = g.map((x) => x.round);
    tiles.push(
      ["Games", int(g.length)],
      ["Avg. round", rounds.length ? (rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1) : "0"],
      ["Waiting on a decision", int(waiting)],
    );
  }
  $("stats").innerHTML = tiles.map(([l, val, cls]) => `<div class="stat ${cls ?? ""}"><span class="muted small">${l}</span><strong>${val}</strong></div>`).join("");
}

// ---------- lobby ----------
function renderRoster() {
  const v = view!;
  $("join-url").textContent = `${location.host}/play`;
  $("join-code").textContent = v.session.code;
  const q = ui.rosterQ;
  const teamSize = new Map(v.teams.map((t) => [t.code, t.members.length + (t.bot ? 1 : 0)]));
  const rows = v.players
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.team ?? "").toLowerCase().includes(q))
    .sort((a, b) => (a.team ?? "~").localeCompare(b.team ?? "~") || a.name.localeCompare(b.name));
  const editable = v.session.status === "lobby" || v.session.status === "between" || v.session.status === "done";
  const mate = (p: IView["players"][number]) => {
    const t = v.teams.find((x) => x.code === p.team);
    if (!t) return "";
    const others = t.members.filter((m) => m !== p.name);
    return others.length ? esc(others.join(", ")) : t.bot ? "Bot" : `<span class="warn">waiting for partner</span>`;
  };
  $("roster").innerHTML = rows.length
    ? `<table class="grid-table left">
        <thead><tr><th>Student</th><th>Team</th><th>Partner</th><th>Status</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody>${rows.map((p) => `<tr class="${!p.team || teamSize.get(p.team) === 1 ? "flag" : ""}">
          <td>${esc(p.name)}</td><td>${p.team ? `<code>${esc(p.team)}</code>` : `<span class="warn">no team</span>`}</td><td>${p.team ? mate(p) : ""}</td>
          <td><span class="dot ${p.connected ? "ok" : "off"}"></span>${p.connected ? "Online" : "Offline"}</td>
          <td class="actions">${editable ? `
            <button class="link" data-act="move" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Move…</button>
            ${p.team ? `<button class="link" data-act="unpair" data-id="${esc(p.id)}">Unpair</button>` : ""}
            <button class="link danger-text" data-act="remove" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Remove</button>` : `<span class="muted small">Edit between phases</span>`}</td>
        </tr>`).join("")}</tbody></table>`
    : `<p class="muted pad">${v.players.length ? "No students match." : "No students yet. Share the join screen."}</p>`;
}

async function onRosterAction(e: Event) {
  const b = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
  if (!b) return;
  const id = b.dataset.id!;
  if (b.dataset.act === "unpair") await cmd({ t: "movePlayer", playerId: id, teamCode: null });
  if (b.dataset.act === "remove" && confirm(`Remove ${b.dataset.name} from the session?`)) await cmd({ t: "removePlayer", playerId: id });
  if (b.dataset.act === "move") {
    const code = prompt(`Move ${b.dataset.name} into which team? Enter the 4-letter team code.`)?.trim().toUpperCase();
    if (code) await cmd({ t: "movePlayer", playerId: id, teamCode: code });
  }
}

function showJoinScreen() {
  const o = $("overlay");
  o.hidden = false;
  o.innerHTML = `<div class="projector" role="dialog" aria-label="Join screen">
      <p>Go to</p><p class="proj-url">${esc(location.host)}/play</p>
      <p>and enter session code</p><p class="proj-code">${esc(current!.code)}</p>
      <p class="muted">Then create a team, or join your teammate's team with their code.</p>
      <button class="secondary" id="proj-close">Close</button></div>`;
  $("proj-close").onclick = () => (o.hidden = true);
  $("proj-close").focus();
}

// ---------- live games ----------
function secondsLeft(g: GameRow) {
  if (g.over || g.deadline === null) return null;
  return Math.max(0, Math.ceil((g.deadline - (Date.now() + offset)) / 1000));
}

function renderGames() {
  const v = view!;
  document.querySelectorAll<HTMLButtonElement>("#games-filter .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === ui.gamesFilter)));
  $("games-title").textContent = v.session.phase ? `${PHASE[v.session.phase]}: live games` : "Live games";
  const q = ui.gamesQ;
  const f = ui.gamesFilter;
  const rows = v.games.filter((g) => {
    if (q && !`${g.team} ${g.intel.name} ${g.ms.name}`.toLowerCase().includes(q)) return false;
    if (f === "waiting") return !g.over && (!g.intel.submitted || !g.ms.submitted);
    if (f === "offline") return !g.intel.connected || !g.ms.connected;
    if (f === "bot") return g.hasBot;
    if (f === "over") return g.over;
    return true;
  });
  const who = (s: GameRow["intel"], over: boolean) =>
    `<span class="dot ${s.connected ? "ok" : "off"}" title="${s.connected ? "Online" : "Offline"}"></span>${esc(s.name)}${over ? "" : s.submitted ? ` <span class="ok-text" title="Submitted">✓</span>` : ""}`;
  $("games").innerHTML = v.games.length
    ? `<table class="grid-table left clickable">
        <thead><tr><th>Team</th><th class="role-intel">Intel</th><th class="role-ms">Microsoft</th><th class="num">Round</th><th class="num">Time left</th><th class="num">Intel profit</th><th class="num">MS profit</th></tr></thead>
        <tbody>${rows.map((g) => {
          const left = secondsLeft(g);
          return `<tr data-team="${esc(g.team)}" tabindex="0">
            <td><code>${esc(g.team)}</code>${g.hasBot ? ` <span class="tag">bot</span>` : ""}</td>
            <td>${who(g.intel, g.over)}</td><td>${who(g.ms, g.over)}</td>
            <td class="num">${g.round + (g.over ? 0 : 1)}${g.over ? " (done)" : ""}</td>
            <td class="num">${left === null ? (g.over ? "–" : "paused") : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</td>
            <td class="num">${mm(g.intel.cum)}</td><td class="num">${mm(g.ms.cum)}</td></tr>`;
        }).join("")}</tbody></table>
        ${rows.length ? "" : `<p class="muted pad">No games match this filter.</p>`}`
    : `<p class="muted pad">No games are running. Start a phase from the bar above.</p>`;
}

async function openGame(phase: Phase, team: string) {
  const d = $("drawer");
  d.hidden = false;
  d.innerHTML = `<p class="muted pad">Loading…</p>`;
  try {
    const g = await (await api(`games/${phase}/${team}`)).json();
    const h: RoundResult[] = g.history;
    const star = (r: RoundResult, role: Role) => (r.released[role] ? "★" : "");
    d.innerHTML = `
      <div class="row between"><h2 id="drawer-title">Team ${esc(team)} · ${PHASE[phase]}</h2><button class="secondary" id="drawer-close">Close</button></div>
      <p><span class="role-intel"><strong>Intel:</strong></span> ${esc(g.intel)} · <span class="role-ms"><strong>Microsoft:</strong></span> ${esc(g.ms)}</p>
      <div class="result-stats">
        <div><span class="muted">Intel profit</span><strong>${mm(g.sides.intel.cumProfit)}</strong><span class="small">${g.sides.intel.releases} releases</span></div>
        <div><span class="muted">Microsoft profit</span><strong>${mm(g.sides.ms.cumProfit)}</strong><span class="small">${g.sides.ms.releases} releases</span></div>
        <div><span class="muted">Rounds</span><strong>${g.round}</strong><span class="small">${g.over ? "finished" : "in progress"}</span></div>
      </div>
      <div class="table-wrap">
        <table class="grid-table">
          <thead><tr><th>Round</th><th>Intel rel.</th><th>MS rel.</th><th>Intel price</th><th>MS price</th><th>PCs (M)</th><th>Intel profit</th><th>MS profit</th></tr></thead>
          <tbody>${h.map((r) => `<tr><td>${r.round + 1}</td><td><span class="star">${star(r, "intel")}</span></td><td><span class="star">${star(r, "ms")}</span></td>
            <td>$${int(r.prices.intel)}${r.timedOut.intel ? " ⏱" : ""}</td><td>$${int(r.prices.ms)}${r.timedOut.ms ? " ⏱" : ""}</td><td>${r.q.toFixed(1)}</td>
            <td>${mm(r.profit.intel)}</td><td>${mm(r.profit.ms)}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">No rounds played yet.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="muted small">★ release · ⏱ timed out (kept last price, no release)</p>`;
    $("drawer-close").onclick = () => (d.hidden = true);
    $("drawer-close").focus();
  } catch (e) {
    d.innerHTML = `<p class="pad">${esc((e as Error).message)}</p><button class="secondary" id="drawer-close">Close</button>`;
    $("drawer-close").onclick = () => (d.hidden = true);
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("drawer") && ($("drawer").hidden = true);
    $("overlay") && ($("overlay").hidden = true);
  }
  if (e.key === "Enter" && (e.target as HTMLElement).matches?.("tr[data-team]")) (e.target as HTMLElement).click();
});

// ---------- leaderboards ----------
function phaseChips(el: HTMLElement, phases: string[], cur: string) {
  el.innerHTML = phases.map((p) => `<button class="chip" data-p="${p}" aria-pressed="${p === cur}">${p === "overall" ? "Overall" : PHASE[p as Phase]}</button>`).join("");
}

function renderBoards() {
  const v = view!;
  const played = v.session.played;
  const options: string[] = [...played, ...(v.overall.length ? ["overall"] : [])];
  if (!options.length) {
    $("board-phase").innerHTML = "";
    $("boards").innerHTML = `<p class="muted pad">Leaderboards appear once a phase starts.</p>`;
    return;
  }
  if (!ui.boardPhase || !options.includes(ui.boardPhase)) ui.boardPhase = (played[played.length - 1] ?? "overall") as Phase;
  phaseChips($("board-phase"), options, ui.boardPhase);
  if (ui.boardPhase === "overall") {
    $("boards").innerHTML = `
      <p class="muted small">Each student's rank among players of the same role in Game 1 and Game 2, as a percentile (100 = top), averaged.</p>
      <div class="table-wrap tall"><table class="grid-table left">
        <thead><tr><th>#</th><th>Student</th><th class="num">Score</th><th class="num role-intel">As Intel</th><th class="num role-ms">As Microsoft</th></tr></thead>
        <tbody>${v.overall.map((o, i) => `<tr><td>${i + 1}</td><td>${esc(o.name)}</td><td class="num"><strong>${o.score.toFixed(0)}</strong></td>
          <td class="num">${o.intelPct === null ? "–" : o.intelPct.toFixed(0)}</td><td class="num">${o.msPct === null ? "–" : o.msPct.toFixed(0)}</td></tr>`).join("")}</tbody>
      </table></div>`;
    return;
  }
  const b = v.boards[ui.boardPhase as Phase]!;
  const ph = ui.boardPhase;
  const list = (title: string, cls: string, rows: string[]) => `
    <div class="board"><h3 class="${cls}">${title}</h3>
      <div class="table-wrap"><table class="grid-table left"><tbody>${rows.join("") || `<tr><td class="muted">No players</td></tr>`}</tbody></table></div></div>`;
  const roleRows = (rows: RoleRow[]) => rows.slice(0, 50).map((r, i) => `<tr data-game="${esc(r.teamCode)}" data-phase="${ph}" class="clickable-row"><td>${i + 1}</td><td>${esc(r.name)}</td><td class="num">${mm(r.cumProfit)}</td></tr>`);
  $("boards").innerHTML = `
    <div class="boards">
      ${list("Intel", "role-intel", roleRows(b.intel))}
      ${list("Microsoft", "role-ms", roleRows(b.ms))}
      ${list("Teams (joint profit)", "", b.teams.slice(0, 50).map((t, i) => `<tr data-game="${esc(t.teamCode)}" data-phase="${ph}" class="clickable-row"><td>${i + 1}</td><td>${esc(t.intel)} &amp; ${esc(t.ms)}</td><td class="num">${mm(t.joint)}</td></tr>`))}
    </div>
    <p class="muted small">Top 50 shown. Click a row to see that game round by round. The CSV in Debrief has everything.</p>`;
}

// ---------- debrief ----------
async function loadDebrief() {
  try {
    debrief = await (await api("debrief")).json();
    renderDebrief();
  } catch (e) {
    toast((e as Error).message);
  }
}

function median(a: number[]) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function renderDebrief() {
  if (!debrief) return;
  const played = PHASES.filter((p) => debrief![p]?.length);
  if (!played.length) {
    $("debrief-phase").innerHTML = "";
    $("debrief").innerHTML = `<p class="muted pad">Play a phase first.</p>`;
    return;
  }
  if (!ui.debriefPhase || !played.includes(ui.debriefPhase)) ui.debriefPhase = played[played.length - 1];
  phaseChips($("debrief-phase"), played, ui.debriefPhase);
  const games = debrief[ui.debriefPhase].filter((g) => !g.hasBot);
  const joint = games.map((g) => g.joint);
  const withRel = games.filter((g) => g.coordination !== null);
  const coordinated = withRel.filter((g) => g.coordination >= 0.5);
  const solo = withRel.filter((g) => g.coordination < 0.5);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const roleAvg = (p: Phase, k: "intelCum" | "msCum") => avg((debrief![p] ?? []).filter((g) => !g.hasBot).map((g) => g[k]));
  $("debrief").innerHTML = `
    <div class="stats compact">
      <div class="stat"><span class="muted small">Teams (no bots)</span><strong>${games.length}</strong></div>
      <div class="stat"><span class="muted small">Median team profit</span><strong>${mm(median(joint))}</strong></div>
      <div class="stat"><span class="muted small">Teams that mostly coordinated</span><strong>${withRel.length ? Math.round((100 * coordinated.length) / withRel.length) : 0}%</strong></div>
      <div class="stat"><span class="muted small">Avg. profit: coordinated vs not</span><strong>${mm(avg(coordinated.map((g) => g.joint)))} vs ${mm(avg(solo.map((g) => g.joint)))}</strong></div>
    </div>
    <div class="debrief-grid">
      <figure class="fig"><figcaption><strong>Did coordinating releases pay?</strong><span class="muted small">One dot per team. Right = more of their releases were matched by the other company within a round.</span></figcaption>
        <div class="dchart" id="d-scatter"></div></figure>
      <figure class="fig"><figcaption><strong>Spread of team profit</strong><span class="muted small">Number of teams in each profit range.</span></figcaption>
        <div class="dchart" id="d-hist"></div></figure>
    </div>
    ${debrief.game1?.length && debrief.game2?.length ? `
    <h3>Same students, switched roles</h3>
    <table class="grid-table compare"><thead><tr><th></th><th class="num">Game 1</th><th class="num">Game 2</th></tr></thead><tbody>
      <tr><th scope="row" class="role-intel">Average Intel profit</th><td class="num">${mm(roleAvg("game1", "intelCum"))}</td><td class="num">${mm(roleAvg("game2", "intelCum"))}</td></tr>
      <tr><th scope="row" class="role-ms">Average Microsoft profit</th><td class="num">${mm(roleAvg("game1", "msCum"))}</td><td class="num">${mm(roleAvg("game2", "msCum"))}</td></tr>
      <tr><th scope="row">Average team profit</th><td class="num">${mm(roleAvg("game1", "intelCum") + roleAvg("game1", "msCum"))}</td><td class="num">${mm(roleAvg("game2", "intelCum") + roleAvg("game2", "msCum"))}</td></tr>
    </tbody></table>` : ""}
    <details class="tableview"><summary>Show as a table (${games.length} teams)</summary>
      <div class="table-wrap tall"><table class="grid-table left"><thead><tr><th>Team</th><th>Intel</th><th>Microsoft</th><th class="num">Rounds</th><th class="num">Releases (I/M)</th><th class="num">Matched</th><th class="num">Team profit</th><th class="num">Timeouts</th></tr></thead>
      <tbody>${[...games].sort((a, b) => b.joint - a.joint).map((g) => `<tr><td><code>${esc(g.team)}</code></td><td>${esc(g.intel)}</td><td>${esc(g.ms)}</td><td class="num">${g.rounds}</td><td class="num">${g.releasesIntel}/${g.releasesMs}</td><td class="num">${g.coordination === null ? "–" : `${Math.round(g.coordination * 100)}%`}</td><td class="num">${mm(g.joint)}</td><td class="num">${g.timeouts}</td></tr>`).join("")}</tbody></table></div>
    </details>`;
  fillDebriefCharts(games);
}
function fillDebriefCharts(games: any[]) {
  const withRel = games.filter((g) => g.coordination !== null);
  // Size each chart to its own box so text stays at its real size.
  $("d-scatter").innerHTML = scatterSvg(
    withRel.map((g) => ({ x: g.coordination, y: g.joint, tip: `Team ${g.team} (${g.intel} & ${g.ms}): ${Math.round(g.coordination * 100)}% matched, ${g.releasesIntel + g.releasesMs} releases, ${fmt(g.joint)} profit` })),
    $("d-scatter").clientWidth,
  );
  $("d-hist").innerHTML = histogramSvg(games.map((g) => g.joint), $("d-hist").clientWidth);
}
const fmt = (x: number) => `${x < 0 ? "−" : ""}$${int(Math.abs(x))}M`;

async function downloadCsv() {
  try {
    const blob = await (await api("export.csv")).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `session-${current!.code}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast((e as Error).message);
  }
}

// ---------- settings ----------
const FIELDS: { key: string; label: string; unit?: string; pct?: boolean; step?: string; group: string }[] = [
  { key: "timing.startSec", label: "First round length", unit: "sec", group: "Timing" },
  { key: "timing.endSec", label: "Last round length", unit: "sec", group: "Timing" },
  { key: "timing.releaseBonusSec", label: "Extra time after a release", unit: "sec", group: "Timing" },
  { key: "maxRounds", label: "Maximum rounds", group: "Timing" },
  { key: "initialPrices.intel", label: "Intel starting price", unit: "$", group: "Prices and costs" },
  { key: "initialPrices.ms", label: "Microsoft starting price", unit: "$", group: "Prices and costs" },
  { key: "intelMC", label: "Intel cost per CPU", unit: "$", group: "Prices and costs" },
  { key: "releaseCost0", label: "First release cost", unit: "$M", group: "Prices and costs" },
  { key: "releaseCostGrowth", label: "Release cost rise per release", pct: true, group: "Prices and costs" },
  { key: "msRevNewPC", label: "MS revenue per installed PC, current OS", unit: "$", group: "Microsoft installed base" },
  { key: "msRevOldPC", label: "MS revenue per installed PC, older OS", unit: "$", group: "Microsoft installed base" },
  { key: "installedBaseWindow", label: "Installed base counts the last", unit: "rounds", group: "Microsoft installed base" },
  { key: "discountRate", label: "Discount rate per round", pct: true, step: "0.1", group: "Microsoft installed base" },
  { key: "demand.A0", label: "Starting max combined price", unit: "$", group: "Demand (advanced)" },
  { key: "demand.Q0", label: "Starting max PCs", unit: "M", group: "Demand (advanced)" },
  { key: "demand.alpha", label: "Boost per version (α)", step: "0.0001", group: "Demand (advanced)" },
  { key: "demand.gamma", label: "Value of a release the partner hasn't matched (γ). 0 = counts only once matched (default); 0.3677 = guide example", step: "0.0001", group: "Demand (advanced)" },
  { key: "demand.rho", label: "Diminishing returns per version (ρ)", step: "0.01", group: "Demand (advanced)" },
  { key: "demand.delta", label: "Ageing per round (δ)", step: "0.0001", group: "Demand (advanced)" },
  { key: "demand.k", label: "Share of boost that adds PCs (k)", step: "0.01", group: "Demand (advanced)" },
];
const getPath = (o: any, p: string) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o: any, p: string, v: number) => {
  const ks = p.split(".");
  ks.slice(0, -1).reduce((a, k) => a[k], o)[ks[ks.length - 1]] = v;
};
let settingsDirty = false;
let settingsSig = "";

function renderSettings(force: boolean) {
  const v = view;
  if (!v) return;
  const locked = v.session.status === "running" || v.session.status === "paused";
  $("settings-note").textContent = locked
    ? "Settings are locked while a phase is running. Changes apply from the next phase."
    : "Changes apply to the next phase you start. Games already played keep their settings.";
  const form = $<HTMLFormElement>("settings");
  // Don't rebuild the form under the instructor's cursor unless the saved settings actually changed.
  const sig = JSON.stringify(v.config) + locked;
  if (!force && form.childElementCount && (settingsDirty || sig === settingsSig)) {
    form.querySelectorAll("input,button").forEach((el) => ((el as HTMLInputElement).disabled = locked));
    return;
  }
  settingsSig = sig;
  const groups = [...new Set(FIELDS.map((f) => f.group))];
  form.innerHTML = groups.map((g) => `
    <fieldset class="${g.includes("advanced") ? "advanced" : ""}"><legend>${g}</legend>
      ${FIELDS.filter((f) => f.group === g).map((f) => {
        const raw = getPath(v.config, f.key) as number;
        const val = f.pct ? +(raw * 100).toFixed(4) : raw;
        return `<label><span>${f.label}${f.unit || f.pct ? ` <span class="muted small">(${f.pct ? "%" : f.unit})</span>` : ""}</span><input type="number" name="${f.key}" value="${val}" step="${f.step ?? "1"}" min="0" ${locked ? "disabled" : ""} required></label>`;
      }).join("")}
    </fieldset>`).join("") + `<div class="row"><button class="primary" type="submit" ${locked ? "disabled" : ""}>Save settings</button><button class="secondary" type="button" id="settings-reset" ${locked ? "disabled" : ""}>Discard changes</button></div>`;
  form.oninput = () => (settingsDirty = true);
  $("settings-reset").onclick = () => ((settingsDirty = false), renderSettings(true));
  settingsDirty = false;
}

async function saveSettings(e: Event) {
  e.preventDefault();
  const cfg = structuredClone(view!.config);
  for (const f of FIELDS) {
    const n = Number((document.querySelector(`[name="${f.key}"]`) as HTMLInputElement).value);
    setPath(cfg, f.key, f.pct ? n / 100 : n);
  }
  if (cfg.timing.endSec > cfg.timing.startSec) return toast("The last round can't be longer than the first.");
  await cmd({ t: "config", config: cfg });
  settingsDirty = false;
  toast("Settings saved. They apply from the next phase.", "info");
  renderSettings(true);
}

// ---------- boot ----------
setInterval(() => {
  if (tab === "games" && view && document.body.dataset.screen === "console") renderGames();
}, 1000);
window.addEventListener("resize", () => tab === "debrief" && renderDebrief());

const want = new URLSearchParams(location.search).get("s")?.toUpperCase();
const found = want ? saved().find((s) => s.code === want) : undefined;
if (found) open(found);
else renderAuth();
