// Demand-curve chart for the scratch pad: the line, and a bar at the quantity sold
// stacked as Intel marginal cost / Intel margin / Microsoft margin.
export interface ChartInput {
  width?: number; // rendered width in CSS px, so text stays readable on phones
  A: number; // price intercept
  Q: number; // quantity intercept
  q: number; // PCs sold
  pI: number;
  pM: number;
  mc: number;
  baseline?: { A: number; Q: number } | null; // the curve with no releases, for comparison
}

const niceCeil = (x: number) => {
  if (x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
};

export function chartSvg(c: ChartInput): string {
  const W = Math.round(Math.min(560, Math.max(300, c.width || 560)));
  const H = Math.round(W * 0.57), L = W >= 420 ? 58 : 44, R = 14, T = 14, B = 38;
  const pw = W - L - R, ph = H - T - B;
  const xMax = niceCeil(Math.max(c.Q, c.baseline?.Q ?? 0, c.q * 1.1, 10));
  const yMax = niceCeil(Math.max(c.A, c.baseline?.A ?? 0, c.pI + c.pM, 100));
  const x = (v: number) => L + (Math.max(0, v) / xMax) * pw;
  const y = (v: number) => T + ph - (Math.max(0, Math.min(v, yMax)) / yMax) * ph;
  const ticks = (max: number) => Array.from({ length: 6 }, (_, i) => (max * i) / 5);
  const money = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `$${Math.round(v)}`);

  const parts: string[] = [];
  for (const t of ticks(yMax)) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`);
    parts.push(`<text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${money(t)}</text>`);
  }
  for (const t of ticks(xMax)) {
    parts.push(`<text class="tick" x="${x(t)}" y="${H - B + 18}" text-anchor="middle">${Math.round(t)}</text>`);
  }
  parts.push(`<text class="axis" x="${L + pw / 2}" y="${H - 4}" text-anchor="middle">PCs sold (millions)</text>`);
  if (W >= 420) parts.push(`<text class="axis" transform="translate(12 ${T + ph / 2}) rotate(-90)" text-anchor="middle">Combined price</text>`);

  // Stacked bar at q
  if (c.q > 0) {
    const bx = x(0), bw = Math.max(2, x(c.q) - x(0));
    const seg = (cls: string, lo: number, hi: number) =>
      hi > lo ? `<rect class="${cls}" x="${bx}" width="${bw}" y="${y(hi)}" height="${Math.max(0, y(lo) - y(hi))}"/>` : "";
    const mc = Math.min(c.mc, c.pI);
    parts.push(seg("bar-mc", 0, mc));
    parts.push(seg("bar-intel", mc, c.pI));
    parts.push(seg("bar-ms", c.pI, c.pI + c.pM));
  }
  if (c.baseline && (c.baseline.A !== c.A || c.baseline.Q !== c.Q)) {
    parts.push(`<line class="curve-base" x1="${x(0)}" y1="${y(c.baseline.A)}" x2="${x(c.baseline.Q)}" y2="${y(0)}"/>`);
  }
  parts.push(`<line class="curve" x1="${x(0)}" y1="${y(c.A)}" x2="${x(c.Q)}" y2="${y(0)}"/>`);
  if (c.q > 0) parts.push(`<circle class="dot" cx="${x(c.q)}" cy="${y(c.pI + c.pM)}" r="5"/>`);
  parts.push(`<line class="axis-line" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Demand curve: ${c.q.toFixed(1)} million PCs sold at a combined price of $${Math.round(c.pI + c.pM)}">${parts.join("")}</svg>`;
}
