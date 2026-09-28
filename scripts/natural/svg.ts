/** Shared static-SVG chart helpers (dataviz reference palette, light/dark). */
// Reference palette (dataviz skill): validated light/dark categorical slots 1-5, emphasis = slot 1 vs context gray.
export const style = `<style>
svg{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--context:#b0aea6}
@media (prefers-color-scheme:dark){svg{--surface:#1a1a19;--ink:#ffffff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--context:#5a5955}}
.bg{fill:var(--surface)}text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink2);font-size:12px}
.title{fill:var(--ink);font-size:15px;font-weight:600}.subtitle{fill:var(--ink2);font-size:12px}.panel{fill:var(--ink);font-size:13px;font-weight:600}
.value{fill:var(--ink);font-size:12px;font-variant-numeric:tabular-nums}.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.s1{fill:var(--s1)}.s2{fill:var(--s2)}.s3{fill:var(--s3)}.s4{fill:var(--s4)}.s5{fill:var(--s5)}.context{fill:var(--context)}
.l1{stroke:var(--s1)}.l2{stroke:var(--s2)}.l3{stroke:var(--s3)}.l4{stroke:var(--s4)}.l5{stroke:var(--s5)}.lc{stroke:var(--context)}.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.dot{stroke:var(--surface);stroke-width:2}
</style>`
export const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const svg = (width: number, height: number, title: string, subtitle: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">`
  + `<title id="t">${esc(title)}</title><desc id="d">${esc(subtitle)}</desc>${style}<rect class="bg" width="${width}" height="${height}"/>`
  + `<text class="title" x="24" y="30">${esc(title)}</text><text class="subtitle" x="24" y="50">${esc(subtitle)}</text>${body}</svg>\n`
/** Horizontal bar: square at the baseline, 4px rounded data end. */
export function bar(x: number, y: number, length: number, thickness: number, cls: string, tip: string) {
  const r = Math.min(4, length / 2, thickness / 2), w = Math.max(0, length)
  const d = w <= 0 ? '' : `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${thickness - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`
  return `<path class="${cls}" d="${d}"><title>${esc(tip)}</title></path>`
}
export interface Row { label: string; value: number; emphasis?: boolean; cls?: string; display?: string }
/** One small-multiple panel: labelled horizontal bars on a shared 0..max axis. */
export function panel(x: number, y: number, width: number, title: string, data: Row[], max: number, format: (value: number) => string, ticks: number[], labelWidth = 150) {
  const thickness = 16, gap = 10, plotX = x + labelWidth, plotW = width - labelWidth - 56, top = y + 28
  const scale = (value: number) => Math.max(0, Math.min(1, value / max)) * plotW
  let body = `<text class="panel" x="${x}" y="${y + 12}">${esc(title)}</text>`
  const bottom = top + data.length * (thickness + gap) - gap
  for (const tick of ticks) body += `<line class="grid" x1="${plotX + scale(tick)}" x2="${plotX + scale(tick)}" y1="${top - 6}" y2="${bottom + 4}"/><text class="tick" x="${plotX + scale(tick)}" y="${bottom + 18}" text-anchor="middle">${esc(format(tick))}</text>`
  body += `<line class="axis" x1="${plotX}" x2="${plotX}" y1="${top - 6}" y2="${bottom + 4}"/>`
  data.forEach((row, i) => {
    const barY = top + i * (thickness + gap), length = scale(row.value), shown = row.display ?? format(row.value)
    body += `<text x="${plotX - 8}" y="${barY + thickness / 2 + 4}" text-anchor="end"${row.emphasis ? ' class="value"' : ''}>${esc(row.label)}</text>`
    body += bar(plotX, barY, length, thickness, row.cls ?? (row.emphasis ? 's1' : 'context'), `${row.label}: ${shown}`)
    body += `<text class="value" x="${plotX + length + 6}" y="${barY + thickness / 2 + 4}">${esc(shown)}</text>`
  })
  return { body, height: bottom + 24 - y }
}

export interface Series { label: string; cls: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'lc'; points: Array<[number, number]> }
/**
 * Line chart on one y axis: 2px lines, a legend row, the series name at each line's end, and a hover title on
 * every point (a hit circle larger than the mark). Series keep their slot whatever the others do.
 */
export function lines(x: number, y: number, width: number, height: number, title: string, series: Series[], xMax: number, yMax: number,
  xTicks: number[], yTicks: number[], formatY: (value: number) => string, xLabel: string, labelWidth = 120, yMin?: number, formatX: (value: number) => string = String) {
  const plotX = x + 44, plotW = width - 44 - labelWidth, top = y + 48, plotH = height - 48 - 30
  // With `yMin` the y axis is logarithmic from yMin to yMax (for series that differ by orders of magnitude).
  const fraction = (value: number) => yMin === undefined ? value / yMax : (Math.log10(Math.max(value, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))
  const sx = (value: number) => plotX + value / xMax * plotW, sy = (value: number) => top + plotH - Math.max(0, Math.min(1, fraction(value))) * plotH
  const fill = (cls: Series['cls']) => cls === 'lc' ? 'context' : 's' + cls.slice(1)
  let body = `<text class="panel" x="${x}" y="${y + 12}">${esc(title)}</text>`
  let lx = x
  for (const item of series) {
    body += `<rect class="${fill(item.cls)}" x="${lx}" y="${y + 22}" width="10" height="10" rx="2"/><text x="${lx + 14}" y="${y + 31}">${esc(item.label)}</text>`
    lx += 30 + [...item.label].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 12 : 7), 0)
  }
  for (const tick of yTicks) body += `<line class="grid" x1="${plotX}" x2="${plotX + plotW}" y1="${sy(tick)}" y2="${sy(tick)}"/><text class="tick" x="${plotX - 6}" y="${sy(tick) + 4}" text-anchor="end">${esc(formatY(tick))}</text>`
  for (const tick of xTicks) body += `<text class="tick" x="${sx(tick)}" y="${top + plotH + 16}" text-anchor="middle">${esc(formatX(tick))}</text>`
  body += `<line class="axis" x1="${plotX}" x2="${plotX + plotW}" y1="${top + plotH}" y2="${top + plotH}"/><text class="tick" x="${plotX + plotW}" y="${top + plotH + 28}" text-anchor="end">${esc(xLabel)}</text>`
  // Series labels at the line ends, nudged apart so they never overlap.
  const ends = series.map(item => ({ item, at: item.points.at(-1) })).filter((end): end is { item: Series; at: [number, number] } => end.at !== undefined).map(end => ({ ...end, y: sy(end.at[1]) })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 14) ends[i]!.y = ends[i - 1]!.y + 14
  for (const item of series) {
    if (!item.points.length) continue
    body += `<path class="line ${item.cls}" d="${item.points.map(([px, py], i) => `${i ? 'L' : 'M'}${sx(px).toFixed(1)},${sy(py).toFixed(1)}`).join('')}"/>`
    for (const [px, py] of item.points) body += `<circle cx="${sx(px).toFixed(1)}" cy="${sy(py).toFixed(1)}" r="7" fill="transparent"><title>${esc(`${item.label} · ${xLabel} ${formatX(px)}: ${formatY(py)}`)}</title></circle>`
  }
  for (const end of ends) body += `<circle class="${fill(end.item.cls)} dot" cx="${sx(end.at[0])}" cy="${sy(end.at[1])}" r="4"/><text class="value" x="${sx(end.at[0]) + 8}" y="${end.y + 4}">${esc(end.item.label)}</text>`
  return { body, height }
}

export interface Part { value: number; cls: string; label: string }
/** Stacked horizontal bars on one axis: 2px surface gaps between segments, rounded end on the last one, total at the tip. */
export function stacked(x: number, y: number, width: number, title: string, rows: Array<{ label: string; parts: Part[]; emphasis?: boolean | undefined }>, max: number,
  format: (value: number) => string, ticks: number[], legend: Array<{ cls: string; label: string }>, labelWidth = 190) {
  const thickness = 16, gap = 10, plotX = x + labelWidth, plotW = width - labelWidth - 70, top = y + 48
  const scale = (value: number) => Math.max(0, Math.min(1, value / max)) * plotW
  let body = `<text class="panel" x="${x}" y="${y + 12}">${esc(title)}</text>`
  let lx = x
  for (const item of legend) {
    body += `<rect class="${item.cls}" x="${lx}" y="${y + 22}" width="10" height="10" rx="2"/><text x="${lx + 14}" y="${y + 31}">${esc(item.label)}</text>`
    lx += 30 + [...item.label].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 12 : 7), 0)
  }
  const bottom = top + rows.length * (thickness + gap) - gap
  for (const tick of ticks) body += `<line class="grid" x1="${plotX + scale(tick)}" x2="${plotX + scale(tick)}" y1="${top - 6}" y2="${bottom + 4}"/><text class="tick" x="${plotX + scale(tick)}" y="${bottom + 18}" text-anchor="middle">${esc(format(tick))}</text>`
  body += `<line class="axis" x1="${plotX}" x2="${plotX}" y1="${top - 6}" y2="${bottom + 4}"/>`
  rows.forEach((row, i) => {
    const barY = top + i * (thickness + gap), total = row.parts.reduce((n, part) => n + part.value, 0)
    body += `<text x="${plotX - 8}" y="${barY + thickness / 2 + 4}" text-anchor="end"${row.emphasis ? ' class="value"' : ''}>${esc(row.label)}</text>`
    let at = plotX
    const visible = row.parts.filter(part => scale(part.value) >= 1)
    visible.forEach((part, j) => {
      const length = scale(part.value), tip = `${row.label} · ${part.label}: ${format(part.value)}`
      if (j === visible.length - 1) body += bar(at, barY, length, thickness, part.cls, tip)
      else body += `<rect class="${part.cls}" x="${at}" y="${barY}" width="${Math.max(0, length - 2)}" height="${thickness}"><title>${esc(tip)}</title></rect>`
      at += length
    })
    body += `<text class="value" x="${plotX + scale(total) + 6}" y="${barY + thickness / 2 + 4}">${esc(format(total))}</text>`
  })
  return { body, height: bottom + 24 - y }
}

