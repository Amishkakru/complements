// Debrief charts: a histogram of team profit and a coordination-vs-profit scatter.
// Single series each, so no legend; every mark carries a hover tooltip via data-tip.

const niceStep = (span: number, target: number) => {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
};
const fmtM = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}B` : `$${Math.round(a)}M`;
  return v < 0 ? `−${s}` : s;
};
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function histogramSvg(values: number[], width: number): string {
  const W = Math.max(260, Math.min(720, width)), H = 240, L = 44, R = 12, T = 12, B = 40;
  if (!values.length) return `<p class="muted">No games yet.</p>`;
  const lo = Math.min(...values), hi = Math.max(...values);
  const step = niceStep(Math.max(hi - lo, 1), 10);
  const start = Math.floor(lo / step) * step;
  const nb = Math.max(1, Math.ceil((hi - start) / step + 1e-9));
  const bins = Array.from({ length: nb }, (_, i) => ({ from: start + i * step, to: start + (i + 1) * step, n: 0 }));
  for (const v of values) bins[Math.min(nb - 1, Math.floor((v - start) / step))].n++;
  const yStep = Math.max(1, niceStep(Math.max(...bins.map((b) => b.n)), 4));
  const yMax = Math.ceil(Math.max(...bins.map((b) => b.n)) / yStep) * yStep;
  const pw = W - L - R, ph = H - T - B, bw = pw / nb;
  const y = (n: number) => T + ph - (n / yMax) * ph;
  const parts: string[] = [];
  for (let n = 0; n <= yMax; n += yStep) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(n)}" y2="${y(n)}"/><text class="tick" x="${L - 6}" y="${y(n) + 4}" text-anchor="end">${n}</text>`);
  }
  bins.forEach((b, i) => {
    const x = L + i * bw + 1, w = Math.max(1, bw - 2);
    if (b.n) {
      const top = y(b.n), h = T + ph - top;
      const r = Math.min(4, w / 2, h);
      // rounded data-end at the top, square at the baseline
      parts.push(`<path class="hbar" d="M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${T + ph} Z"/>`);
    }
    parts.push(`<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}" data-tip="${esc(`${fmtM(b.from)} to ${fmtM(b.to)}: ${b.n} team${b.n === 1 ? "" : "s"}`)}"/>`);
  });
  const labelEvery = Math.ceil(nb / Math.max(2, Math.floor(pw / 70)));
  bins.forEach((b, i) => {
    if (i % labelEvery === 0) parts.push(`<text class="tick" x="${L + i * bw}" y="${T + ph + 16}" text-anchor="middle">${fmtM(b.from)}</text>`);
  });
  parts.push(`<line class="axis-line" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`);
  parts.push(`<text class="axis" x="${L + pw / 2}" y="${H - 4}" text-anchor="middle">Team profit (Intel + Microsoft)</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of team profit across ${values.length} teams">${parts.join("")}</svg>`;
}

export interface ScatterPoint { x: number; y: number; tip: string }

export function scatterSvg(points: ScatterPoint[], width: number): string {
  const W = Math.max(260, Math.min(720, width)), H = 260, L = 56, R = 14, T = 12, B = 40;
  if (!points.length) return `<p class="muted">No releases yet, so there's nothing to compare.</p>`;
  const ys = points.map((p) => p.y);
  const step = niceStep(Math.max(Math.max(...ys) - Math.min(...ys), 1), 5);
  const y0 = Math.floor(Math.min(...ys) / step) * step, y1 = Math.ceil(Math.max(...ys) / step) * step || step;
  const pw = W - L - R, ph = H - T - B;
  const x = (v: number) => L + v * pw;
  const y = (v: number) => T + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const parts: string[] = [];
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtM(v)}</text>`);
  }
  for (const t of [0, 0.25, 0.5, 0.75, 1]) parts.push(`<text class="tick" x="${x(t)}" y="${T + ph + 16}" text-anchor="middle">${t * 100}%</text>`);
  parts.push(`<line class="axis-line" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`);
  parts.push(`<text class="axis" x="${L + pw / 2}" y="${H - 4}" text-anchor="middle">${W < 520 ? "Releases matched within one round" : "Share of releases matched by the other company within one round"}</text>`);
  for (const p of points) {
    parts.push(`<circle class="pt" cx="${x(p.x)}" cy="${y(p.y)}" r="5"/><circle class="hit" cx="${x(p.x)}" cy="${y(p.y)}" r="10" data-tip="${esc(p.tip)}"/>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of release coordination against team profit for ${points.length} teams">${parts.join("")}</svg>`;
}

/** One floating tooltip for every [data-tip] mark inside `root`. */
export function attachTooltips(root: HTMLElement) {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  document.body.appendChild(tip);
  root.addEventListener("pointermove", (e) => {
    const t = (e.target as Element).closest?.("[data-tip]") as SVGElement | null;
    if (!t) return void (tip.hidden = true);
    tip.textContent = t.getAttribute("data-tip");
    tip.hidden = false;
    const pad = 12;
    const r = tip.getBoundingClientRect();
    let left = e.clientX + pad, top = e.clientY + pad;
    if (left + r.width > innerWidth - 8) left = e.clientX - r.width - pad;
    if (top + r.height > innerHeight - 8) top = e.clientY - r.height - pad;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  root.addEventListener("pointerleave", () => (tip.hidden = true));
}
