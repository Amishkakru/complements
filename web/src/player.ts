// Player page. Screens: join -> team -> waiting -> game (with results between phases).
import { demandCurve, previewRound, type GameConfig, type GameState, type Role, type RoundResult } from "../../engine/src/engine.ts";
import { chartSvg } from "./chart.ts";
import { Net, type Msg } from "./net.ts";

// ---------- types for the server's player view ----------
interface Side {
  version: number; lastReleaseRound: number; releases: number; price: number; cumProfit: number;
  plannedReleases: number[]; nextReleaseCost: number;
}
interface GameView {
  phase: Phase; role: Role; partnerName: string; partnerIsBot: boolean; round: number; over: boolean;
  deadline: number | null; remainingMs: number | null; config: GameConfig; sides: Record<Role, Side>;
  installedBase: { newPCs: number; oldPCs: number }; history: RoundResult[];
  submitted: Record<Role, boolean>; mySubmission: { release: boolean; price: number } | null;
  result: { rankInRole: number; ofInRole: number; teamRank: number; ofTeams: number; teamJoint: number } | null;
}
type Phase = "practice" | "game1" | "game2";
interface PlayerView {
  removed?: true; serverNow: number;
  session: { code: string; status: "lobby" | "running" | "paused" | "between" | "done"; phase: Phase | null; nextPhase: Phase | null };
  you: { id: string; name: string };
  team: { code: string; teammate: string | null } | null;
  game: GameView | null;
}

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ROLE: Record<Role, string> = { intel: "Intel", ms: "Microsoft" };
const ROLE_WHAT: Record<Role, string> = { intel: "CPU maker", ms: "OS maker" };
const PHASE: Record<Phase, string> = { practice: "Practice", game1: "Game 1", game2: "Game 2" };
const other = (r: Role): Role => (r === "intel" ? "ms" : "intel");
const int = (x: number) => Math.round(x).toLocaleString("en-US");
const dollars = (x: number) => `${x < 0 ? "−" : ""}$${int(Math.abs(x))}`;
const mm = (x: number) => `<span class="${x < 0 ? "neg" : ""}">${dollars(x)}M</span>`;
const pcs = (x: number) => `${x.toFixed(1)}M`;

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- state ----------
const net = new Net(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
let view: PlayerView | null = null;
let clockOffset = 0;
let sessionCode: string | null = null;
let screen = "";
let roundKey = ""; // phase:round currently shown in the decision form
const scratch = { pI: 400, pM: 50, rI: false, rM: false, touched: false };

function toast(msg: string, kind: "error" | "info" = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.className = "toast"), 3500);
}
async function call(m: Msg) {
  try {
    return await net.call(m);
  } catch (e) {
    toast((e as Error).message);
    throw e;
  }
}

// ---------- connection ----------
net.onStatus = (s) => {
  const b = $("conn");
  b.hidden = s === "open";
  b.textContent = s === "connecting" ? "Connecting…" : "Connection lost. Reconnecting…";
};
net.onUnsolicitedError = (m) => toast(m);
net.onOpen = () => {
  const token = sessionCode ? store.get(`cs:${sessionCode}`) : null;
  if (sessionCode && token) {
    net.call({ t: "resume", session: sessionCode, token }).catch(() => {
      store.del(`cs:${sessionCode}`);
      view = null;
      render();
    });
  }
};
net.onMessage = (m) => {
  if (m.t !== "state") return;
  view = m.view as PlayerView;
  clockOffset = view.serverNow - Date.now();
  render();
};

// ---------- header ----------
function renderHeader() {
  const v = view;
  const info = $("hdr-info");
  if (!v || v.removed) {
    info.innerHTML = "";
    return;
  }
  const g = v.game;
  const bits = [`<span class="pill">Session ${esc(v.session.code)}</span>`];
  if (g) bits.push(`<span class="pill">${PHASE[g.phase]}</span>`, `<span class="pill role-${g.role}">You: ${ROLE[g.role]}</span>`);
  info.innerHTML = bits.join("");
}
function tickTimer() {
  const el = $("timer");
  const g = view?.game;
  if (!g || g.over) {
    el.textContent = "";
    el.className = "timer";
    return;
  }
  if (view!.session.status === "paused" || g.deadline === null) {
    el.textContent = "Paused";
    el.className = "timer paused";
    return;
  }
  const left = Math.max(0, Math.ceil((g.deadline - (Date.now() + clockOffset)) / 1000));
  el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  el.className = `timer${left <= 10 ? " urgent" : ""}`;
  el.setAttribute("aria-label", `${left} seconds left in this round`);
}
setInterval(tickTimer, 250);

// ---------- screens ----------
function whichScreen(): string {
  if (!view) return "join";
  if (view.removed) return "removed";
  if (view.game) return "game";
  if (!view.team || !view.team.teammate) return "team";
  return "waiting";
}

function render() {
  renderHeader();
  const s = whichScreen();
  if (s !== screen) {
    screen = s;
    roundKey = "";
    mount[s]();
  }
  update[s]?.();
  tickTimer();
}

const mount: Record<string, () => void> = {
  join() {
    const params = new URLSearchParams(location.search);
    $("app").innerHTML = `
      <section class="card narrow">
        <h1>Join the simulation</h1>
        <p class="muted">You and a teammate run two companies that need each other: one makes the CPU, the other the operating system. Every PC needs both.</p>
        <form id="join-form" class="stack">
          <label>Session code<input id="j-code" autocomplete="off" autocapitalize="characters" maxlength="6" required value="${esc(params.get("s") ?? store.get("cs:last") ?? "")}"></label>
          <label>Your name<input id="j-name" autocomplete="name" maxlength="40" required value="${esc(store.get("cs:name") ?? "")}"></label>
          <button class="primary" type="submit">Join</button>
        </form>
      </section>`;
    $("join-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = $<HTMLInputElement>("j-code").value.trim().toUpperCase();
      const name = $<HTMLInputElement>("j-name").value.trim();
      const btn = (e.target as HTMLFormElement).querySelector("button")!;
      btn.disabled = true;
      try {
        const w = await call({ t: "join", session: code, name });
        sessionCode = w.session;
        store.set(`cs:${w.session}`, w.token);
        store.set("cs:last", w.session);
        store.set("cs:name", name);
        history.replaceState(null, "", `/play?s=${w.session}`);
      } finally {
        btn.disabled = false;
      }
    });
  },

  removed() {
    $("app").innerHTML = `<section class="card narrow"><h1>You've been removed from this session</h1><p class="muted">Ask your instructor if this is a mistake.</p><button id="rejoin" class="primary">Join again</button></section>`;
    $("rejoin").onclick = () => {
      if (sessionCode) store.del(`cs:${sessionCode}`);
      view = null;
      render();
    };
  },

  team() {
    $("app").innerHTML = `<section class="card narrow" id="team-card"></section>`;
  },

  waiting() {
    $("app").innerHTML = `<section class="card narrow" id="wait-card"></section>`;
  },

  game() {
    $("app").innerHTML = `
      <div class="game">
        <section class="card result" id="result" hidden></section>
        <div class="col col-left">
        <section class="card decision" aria-labelledby="d-title">
          <div class="row between">
            <h2 id="d-title"></h2>
            <span id="d-status" class="status" aria-live="polite"></span>
          </div>
          <form id="d-form" class="stack">
            <fieldset class="seg" id="d-release">
              <legend>Release a new version this round?</legend>
              <label><input type="radio" name="rel" value="no" checked><span>No</span></label>
              <label><input type="radio" name="rel" value="yes"><span>Yes, release</span></label>
            </fieldset>
            <p class="hint" id="d-relcost"></p>
            <label>Your price ($ per unit)<input id="d-price" type="number" min="0" max="100000" step="1" inputmode="numeric" required></label>
            <p class="hint" id="d-pricehint"></p>
            <button class="primary" id="d-submit" type="submit">Submit decision</button>
          </form>
          <p class="partner" id="d-partner" aria-live="polite"></p>
        </section>
        <section class="card scratch" aria-labelledby="s-title">
          <div class="row between"><h2 id="s-title">Scratch pad</h2><span class="muted small">Try scenarios here. Nothing is submitted.</span></div>
          <div id="chart" class="chart"></div>
          <div class="legend"><span class="sw sw-mc"></span>Intel cost <span class="sw sw-intel"></span>Intel margin <span class="sw sw-ms"></span>Microsoft margin <span class="sw sw-base"></span>Curve with no releases</div>
          <div class="sp-controls">
            ${(["intel", "ms"] as Role[]).map((r) => `
              <div class="sp-side role-${r}">
                <div class="sp-name" id="sp-name-${r}"></div>
                <label class="check"><input type="checkbox" id="sp-rel-${r}"> Releases this round</label>
                <div class="sp-price"><span>Price</span><div class="sp-inputs"><input type="range" id="sp-range-${r}" min="0" step="1" aria-label="${ROLE[r]} price slider"><input type="number" id="sp-num-${r}" min="0" step="1" inputmode="numeric" aria-label="${ROLE[r]} price"></div></div>
              </div>`).join("")}
          </div>
          <div id="sp-out" class="sp-out"></div>
          <button id="sp-copy" class="secondary" type="button">Use my scratch-pad choice in my decision</button>
        </section>
        </div>
        <div class="col col-right">
        <section class="card values" aria-labelledby="v-title">
          <h2 id="v-title">Values</h2>
          <div id="values"></div>
        </section>
        <section class="card rounds" aria-labelledby="r-title">
          <div class="row between"><h2 id="r-title">Rounds</h2><span class="muted small">★ released · ☆ planned. Tick a future round in your column to signal a release to your teammate (not binding).</span></div>
          <div class="table-wrap" id="rounds"></div>
        </section>
        </div>
      </div>`;

    $("d-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const g = view?.game;
      if (!g) return;
      const price = Number($<HTMLInputElement>("d-price").value);
      if (!Number.isFinite(price) || price < 0) return toast("Enter a price of $0 or more.");
      const release = (document.querySelector('input[name="rel"]:checked') as HTMLInputElement).value === "yes";
      const btn = $<HTMLButtonElement>("d-submit");
      btn.disabled = true;
      try {
        await call({ t: "submit", round: g.round, release, price });
      } finally {
        btn.disabled = false;
      }
    });

    for (const r of ["intel", "ms"] as Role[]) {
      const set = (v: number) => {
        if (r === "intel") scratch.pI = v;
        else scratch.pM = v;
        scratch.touched = true;
        updateScratch();
      };
      $(`sp-range-${r}`).addEventListener("input", (e) => set(Number((e.target as HTMLInputElement).value)));
      $(`sp-num-${r}`).addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v) && v >= 0) set(v);
      });
      $(`sp-rel-${r}`).addEventListener("change", (e) => {
        if (r === "intel") scratch.rI = (e.target as HTMLInputElement).checked;
        else scratch.rM = (e.target as HTMLInputElement).checked;
        scratch.touched = true;
        updateScratch();
      });
    }
    $("sp-copy").addEventListener("click", () => {
      const g = view?.game;
      if (!g) return;
      const mine = g.role === "intel" ? { p: scratch.pI, r: scratch.rI } : { p: scratch.pM, r: scratch.rM };
      $<HTMLInputElement>("d-price").value = String(Math.round(mine.p));
      (document.querySelector(`input[name="rel"][value="${mine.r ? "yes" : "no"}"]`) as HTMLInputElement).checked = true;
      updateReleaseHint();
      $("d-price").focus();
      toast("Copied into your decision. Press Submit when ready.", "info");
    });

    $("rounds").addEventListener("change", async (e) => {
      const el = e.target as HTMLInputElement;
      if (!el.dataset.plan) return;
      el.disabled = true;
      try {
        await call({ t: "plan", round: Number(el.dataset.plan), on: el.checked });
      } catch {
        el.checked = !el.checked;
      } finally {
        el.disabled = false;
      }
    });
    document.querySelectorAll('input[name="rel"]').forEach((el) => el.addEventListener("change", updateReleaseHint));
  },
};

const update: Record<string, () => void> = {
  team() {
    const v = view!;
    const card = $("team-card");
    if (v.team) {
      card.innerHTML = `
        <h1>Waiting for your teammate</h1>
        <p>Give your teammate this team code:</p>
        <p class="bigcode" aria-label="Team code ${esc(v.team.code.split("").join(" "))}">${esc(v.team.code)}</p>
        <p class="muted">They enter it after joining session <strong>${esc(v.session.code)}</strong>. If you don't have a teammate, your instructor will pair you with someone.</p>
        <button id="leave" class="secondary">Leave team</button>`;
      $("leave").onclick = () => void call({ t: "leaveTeam" });
      return;
    }
    if (card.dataset.mode === "choose") return; // keep what the student is typing
    card.dataset.mode = "choose";
    card.innerHTML = `
      <h1>Hi ${esc(v.you.name)}, find your teammate</h1>
      <p class="muted">Teams have two people: one plays Intel, the other Microsoft. In Game 2 you switch roles.</p>
      <div class="choice">
        <div>
          <h2>Start a team</h2>
          <p class="muted small">You'll get a code to give your teammate.</p>
          <button id="create" class="primary">Create team</button>
        </div>
        <form id="jt-form">
          <h2>Join a team</h2>
          <label>Teammate's code<input id="jt-code" maxlength="4" autocomplete="off" autocapitalize="characters" required></label>
          <button class="secondary" type="submit">Join team</button>
        </form>
      </div>`;
    $("create").onclick = async () => {
      card.dataset.mode = "";
      await call({ t: "createTeam" }).catch(() => (card.dataset.mode = "choose"));
    };
    $("jt-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      card.dataset.mode = "";
      await call({ t: "joinTeam", code: $<HTMLInputElement>("jt-code").value.trim().toUpperCase() }).catch(
        () => (card.dataset.mode = "choose"),
      );
    });
  },

  waiting() {
    const v = view!;
    const next = v.session.nextPhase;
    const canLeave = v.session.status === "lobby" || v.session.status === "between";
    $("wait-card").innerHTML = `
      <h1>You're teamed with ${esc(v.team!.teammate)}</h1>
      <p class="muted">Team code <strong>${esc(v.team!.code)}</strong></p>
      <p class="waiting"><span class="spinner" aria-hidden="true"></span>${
        v.session.status === "done" ? "The session is over. Thanks for playing!" : `Waiting for the instructor to start ${next ? PHASE[next] : "the next game"}…`
      }</p>
      ${canLeave ? `<button id="leave" class="secondary">Leave team</button>` : ""}`;
    if (canLeave) $("leave").onclick = () => void call({ t: "leaveTeam" });
  },

  game() {
    const v = view!;
    const g = v.game!;
    const me = g.role, opp = other(me);
    const key = `${g.phase}:${g.round}`;
    const playing = v.session.status === "running" && !g.over;

    // New round: reset the form and the scratch pad to the latest prices.
    if (key !== roundKey) {
      roundKey = key;
      $<HTMLInputElement>("d-price").value = String(g.mySubmission?.price ?? g.sides[me].price);
      (document.querySelector(`input[name="rel"][value="${g.mySubmission?.release ? "yes" : "no"}"]`) as HTMLInputElement).checked = true;
      scratch.pI = g.sides.intel.price;
      scratch.pM = g.sides.ms.price;
      scratch.rI = me === "intel" ? false : g.sides.intel.plannedReleases.includes(g.round);
      scratch.rM = me === "ms" ? false : g.sides.ms.plannedReleases.includes(g.round);
      scratch.touched = false;
      requestAnimationFrame(() => {
        const cur = document.querySelector("#rounds tr.now");
        const wrap = $("rounds");
        if (cur) wrap.scrollTop = (cur as HTMLElement).offsetTop - wrap.clientHeight / 2;
      });
    }

    $("d-title").textContent = g.over ? "Game finished" : `Round ${g.round + 1}`;
    $("d-form").hidden = g.over;
    const status = $("d-status");
    if (g.over) {
      status.textContent = "Game over";
      status.className = "status done";
    } else if (v.session.status === "paused") {
      status.textContent = "Paused by instructor";
      status.className = "status paused";
    } else if (g.mySubmission) {
      status.textContent = "Submitted ✓";
      status.className = "status ok";
    } else {
      status.textContent = "Your move";
      status.className = "status todo";
    }
    for (const el of $("d-form").querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) el.disabled = !playing;
    $("d-submit").textContent = g.mySubmission ? "Update decision" : "Submit decision";
    $("d-pricehint").textContent = `Last round: ${dollars(g.sides[me].price)}${me === "intel" ? ` · your cost per CPU: ${dollars(g.config.intelMC)}` : " · your cost per copy: $0"}`;
    updateReleaseHint();
    const partner = `${esc(g.partnerName)} (${ROLE[opp]})`;
    $("d-partner").innerHTML = g.over
      ? ""
      : g.submitted[opp]
        ? `<span class="dot ok"></span>${partner} has submitted.${g.mySubmission ? "" : " The round ends as soon as you submit."}`
        : `<span class="dot wait"></span>${partner} is still deciding.${g.mySubmission ? " You can change your decision until they submit." : ""}`;

    renderValues(g);
    updateScratch();
    renderRounds(g);
    renderResult(v, g);
  },
};

function updateReleaseHint() {
  const g = view?.game;
  if (!g) return;
  const yes = (document.querySelector('input[name="rel"]:checked') as HTMLInputElement | null)?.value === "yes";
  const cost = g.sides[g.role].nextReleaseCost;
  const matched = g.config.demand.gamma === 0 ? " A new version only lifts sales once your teammate's product is on the same version." : "";
  $("d-relcost").innerHTML = `Releasing version ${g.sides[g.role].version + 1} costs ${mm(cost)} this round${yes ? ", charged now" : ""}.${matched}`;
}

function renderValues(g: GameView) {
  const row = (label: string, i: string, m: string) => `<tr><th scope="row">${label}</th><td>${i}</td><td>${m}</td></tr>`;
  const s = g.sides;
  const pr = g.config;
  $("values").innerHTML = `
    <table class="kv">
      <thead><tr><th></th><th class="role-intel">Intel${g.role === "intel" ? " (you)" : ""}</th><th class="role-ms">Microsoft${g.role === "ms" ? " (you)" : ""}</th></tr></thead>
      <tbody>
        ${row("Cumulative profit", mm(s.intel.cumProfit), mm(s.ms.cumProfit))}
        ${row("Current version", `v${s.intel.version}`, `v${s.ms.version}`)}
        ${row("Last price", dollars(s.intel.price), dollars(s.ms.price))}
        ${row("Next release cost", mm(s.intel.nextReleaseCost), mm(s.ms.nextReleaseCost))}
        ${row("Cost per unit", dollars(pr.intelMC), "$0")}
      </tbody>
    </table>
    <dl class="facts">
      <div><dt>Microsoft revenue per installed PC</dt><dd>$${pr.msRevNewPC} on current OS · $${pr.msRevOldPC} on older OS</dd></div>
      <div><dt>Installed base (last ${pr.installedBaseWindow} rounds)</dt><dd>${pcs(g.installedBase.newPCs)} current OS · ${pcs(g.installedBase.oldPCs)} older</dd></div>
      <div><dt>Discount rate per round</dt><dd>${(pr.discountRate * 100).toFixed(1)}%</dd></div>
      <div><dt>Release costs rise per release</dt><dd>${Math.round(pr.releaseCostGrowth * 100)}%</dd></div>
    </dl>`;
}

function asState(g: GameView): GameState {
  return { round: g.round, sides: g.sides, history: g.history };
}

function curveFor(g: GameView, rI: boolean, rM: boolean) {
  const versions = { intel: g.sides.intel.version + +rI, ms: g.sides.ms.version + +rM };
  const ages = {
    intel: rI ? 0 : g.round - g.sides.intel.lastReleaseRound,
    ms: rM ? 0 : g.round - g.sides.ms.lastReleaseRound,
  };
  return demandCurve(g.config, versions, ages);
}

function updateScratch() {
  const g = view?.game;
  if (!g) return;
  const me = g.role;
  const curve = curveFor(g, scratch.rI, scratch.rM);
  const p = previewRound(g.config, asState(g), {
    intel: { release: scratch.rI, price: scratch.pI },
    ms: { release: scratch.rM, price: scratch.pM },
  });
  const max = Math.max(100, Math.ceil(curve.A / 50) * 50);
  for (const r of ["intel", "ms"] as Role[]) {
    const price = r === "intel" ? scratch.pI : scratch.pM;
    const range = $<HTMLInputElement>(`sp-range-${r}`);
    range.max = String(max);
    if (document.activeElement !== range) range.value = String(Math.round(price));
    const num = $<HTMLInputElement>(`sp-num-${r}`);
    if (document.activeElement !== num) num.value = String(Math.round(price));
    $<HTMLInputElement>(`sp-rel-${r}`).checked = r === "intel" ? scratch.rI : scratch.rM;
    const planned = g.sides[r].plannedReleases.includes(g.round);
    $(`sp-name-${r}`).innerHTML = `${ROLE[r]} ${r === me ? "(you)" : `(${esc(g.partnerName)})`}${r !== me && planned ? ` <span class="tag">signalled a release</span>` : ""}`;
  }
  $("chart").innerHTML = chartSvg({
    width: $("chart").clientWidth,
    A: curve.A, Q: curve.Q, q: p.q, pI: scratch.pI, pM: scratch.pM, mc: g.config.intelMC,
    baseline: scratch.rI || scratch.rM ? curveFor(g, false, false) : null,
  });
  const base = p.installedBase.newPCs * g.config.msRevNewPC + p.installedBase.oldPCs * g.config.msRevOldPC;
  $("sp-out").innerHTML = `
    <div><span class="muted">PCs sold</span><strong>${pcs(p.q)}</strong></div>
    <div class="role-intel"><span class="muted">Intel profit this round</span><strong>${mm(p.profit.intel)}</strong>${p.releaseCost.intel ? `<span class="small muted">incl. ${mm(-p.releaseCost.intel)} release</span>` : ""}</div>
    <div class="role-ms"><span class="muted">Microsoft profit this round</span><strong>${mm(p.profit.ms)}</strong><span class="small muted">incl. ${mm(base)} installed base${p.releaseCost.ms ? `, ${mm(-p.releaseCost.ms)} release` : ""}</span></div>`;
}

function renderRounds(g: GameView) {
  const me = g.role;
  const relCell = (r: Role, round: number, h?: RoundResult) => {
    if (h) return h.released[r] ? `<span class="star" title="Released">★</span>` : "";
    const planned = g.sides[r].plannedReleases.includes(round);
    if (r === me && round > g.round && !g.over) {
      return `<input type="checkbox" data-plan="${round}" ${planned ? "checked" : ""} aria-label="Signal a release in round ${round + 1}">`;
    }
    return planned ? `<span class="star" title="Planned">☆</span>` : "";
  };
  const rows: string[] = [];
  for (const h of g.history) {
    rows.push(`<tr>
      <td>${h.round + 1}</td><td>${relCell("intel", h.round, h)}</td><td>${relCell("ms", h.round, h)}</td>
      <td>${dollars(h.prices.intel)}</td><td>${dollars(h.prices.ms)}</td><td>${h.q.toFixed(1)}</td>
      <td>${mm(h.profit.intel)}</td><td>${mm(h.profit.ms)}</td></tr>`);
  }
  if (!g.over) {
    const last = Math.min(g.config.maxRounds - 1, g.round + 10);
    for (let r = g.round; r <= last; r++) {
      rows.push(`<tr class="${r === g.round ? "now" : "future"}"><td>${r + 1}</td><td>${relCell("intel", r)}</td><td>${relCell("ms", r)}</td>
        <td colspan="5" class="muted small">${r === g.round ? "In progress" : ""}</td></tr>`);
    }
  }
  $("rounds").innerHTML = `
    <table class="grid-table">
      <thead><tr><th>Round</th><th class="role-intel">Intel rel.</th><th class="role-ms">MS rel.</th><th>Intel price</th><th>MS price</th><th>PCs (M)</th><th>Intel profit</th><th>MS profit</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

function renderResult(v: PlayerView, g: GameView) {
  const el = $("result");
  if (!g.over || !g.result) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const r = g.result;
  const next = v.session.nextPhase;
  const nextRole = g.phase === "game1" ? other(g.role) : g.role;
  const nextLine = v.session.status === "done" || !next
    ? "That's the end of the session. Thanks for playing!"
    : `Next up: <strong>${PHASE[next]}</strong>. You'll play <strong class="role-${nextRole}">${ROLE[nextRole]}</strong>${next === "game2" ? " (you and your teammate switch)" : ""}. Waiting for your instructor to start it…`;
  el.innerHTML = `
    <h2>${PHASE[g.phase]} complete${g.phase === "practice" ? " (this one didn't count)" : ""}</h2>
    <div class="result-stats">
      <div><span class="muted">Your profit as ${ROLE[g.role]}</span><strong>${mm(g.sides[g.role].cumProfit)}</strong><span class="small">#${r.rankInRole} of ${r.ofInRole} ${ROLE[g.role]} players</span></div>
      <div><span class="muted">Team profit (you + ${esc(g.partnerName)})</span><strong>${mm(r.teamJoint)}</strong><span class="small">#${r.teamRank} of ${r.ofTeams} teams</span></div>
      <div><span class="muted">Rounds played</span><strong>${g.round}</strong></div>
    </div>
    <p>${nextLine}</p>`;
}

// ---------- boot ----------
let resizeT = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = window.setTimeout(() => screen === "game" && updateScratch(), 120);
});
sessionCode = new URLSearchParams(location.search).get("s")?.toUpperCase() ?? store.get("cs:last");
if (sessionCode && !store.get(`cs:${sessionCode}`)) sessionCode = null;
net.onMessage = ((orig) => (m: Msg) => {
  if (m.t === "welcome") sessionCode = m.session;
  orig(m);
})(net.onMessage);
render();
net.connect(); // also opened on the join screen, so joining is instant
