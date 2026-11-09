// Inline SVG charts for the site, drawn from snapshots: the roadmap timeline and the burn-up.
//
// Self-contained (no vendored generator), so the site builds from committed snapshots alone.
// Each chart is decorative-plus-summary (role="img" with a title and description); the page
// puts the same data in a table beside it, which is the accessible version.

import type { EpicRow, Snapshot } from './snapshot.ts'

const DAY = 86_400_000
const INK = '#0b0c0c'
const SUB = '#505a5f'
const GRID = '#b1b4b6'
const RED = '#d4351c'
const FONT = 'font-family="Arial, Helvetica, sans-serif"'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const t = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "2 Nov 2026" */
export function fmtDate(isoDate: string): string {
  const d = new Date(t(isoDate))
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Mixes a hex colour with white; f = 0 is the colour, 1 is white. */
function tint(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (s: number) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * f)
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`
}

function progressText(r: EpicRow): string {
  return r.total ? `${r.counts.done} of ${r.total} items done · ${r.status}` : `No child items · ${r.status}`
}

export function roadmapSvg(s: Snapshot, today: string): string {
  const W = 960
  const LABEL = 330
  const TOP = 36
  const LANE_H = 30
  const ROW_H = 40
  const right = W - 12
  const span = t(s.end) + DAY - t(s.start)
  const x = (d: string) => LABEL + ((t(d) - t(s.start)) / span) * (right - LABEL)
  const clampX = (d: string) => Math.min(right, Math.max(LABEL, x(d)))

  const rows = s.lanes.reduce((n, L) => n + L.rows.length, 0)
  const H = TOP + s.lanes.length * LANE_H + rows * ROW_H + 8
  const out: string[] = []

  // Month header and grid
  const first = new Date(t(s.start))
  for (let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); m <= t(s.end); ) {
    const d = new Date(m)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    const x0 = clampX(iso(m))
    const x1 = clampX(iso(next))
    out.push(`<line x1="${x0}" y1="${TOP - 6}" x2="${x0}" y2="${H}" stroke="${GRID}" stroke-width="1"/>`)
    if (x1 - x0 > 30) {
      const label = d.getUTCMonth() === 0 || m === Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)
        ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()]
      out.push(`<text x="${(x0 + x1) / 2}" y="${TOP - 14}" text-anchor="middle" font-size="13" fill="${SUB}">${label}</text>`)
    }
    m = next
  }

  let y = TOP
  for (const L of s.lanes) {
    out.push(`<rect x="0" y="${y}" width="${W}" height="${LANE_H}" fill="${tint(L.colour, 0.85)}"/>`,
      `<rect x="0" y="${y}" width="6" height="${LANE_H}" fill="${L.colour}"/>`,
      `<text x="14" y="${y + 20}" font-size="15" font-weight="bold" fill="${INK}">${esc(L.title)}</text>`)
    y += LANE_H
    for (const r of L.rows) {
      const mid = y + ROW_H / 2
      out.push(`<line x1="0" y1="${y + ROW_H}" x2="${W}" y2="${y + ROW_H}" stroke="#f3f2f1"/>`,
        `<text x="14" y="${y + 17}" font-size="13" fill="${INK}"><tspan font-weight="bold">${esc(r.key)}</tspan> ${esc(truncate(r.summary, 32))}</text>`,
        `<text x="14" y="${y + 33}" font-size="11" fill="${SUB}">${esc(progressText(r))}</text>`)
      const clash = r.clashes.length > 0
      const stroke = clash ? ` stroke="${RED}" stroke-width="2"` : ''
      let barEnd = LABEL
      if (!r.start || !r.due) {
        out.push(`<text x="${LABEL + 6}" y="${mid + 4}" font-size="12" font-style="italic" fill="${SUB}">No dates in Jira</text>`)
      } else if (t(r.due) < t(s.start)) {
        out.push(`<text x="${LABEL + 6}" y="${mid + 4}" font-size="12" fill="${SUB}">Ended ${fmtDate(r.due)}</text>`)
      } else if (r.start === r.due) {
        const cx = x(r.start)
        barEnd = cx + 9
        out.push(`<path d="M${cx} ${mid - 9} L${cx + 9} ${mid} L${cx} ${mid + 9} L${cx - 9} ${mid} Z" fill="${L.colour}"${stroke}/>`)
      } else {
        const x0 = clampX(r.start)
        const x1 = Math.max(x0 + 4, clampX(iso(t(r.due) + DAY)))
        const done = r.total ? r.counts.done / r.total : r.category === 'done' ? 1 : 0
        barEnd = x1
        const dash = r.derived ? ' stroke-dasharray="5 3"' : ''
        out.push(`<rect x="${x0}" y="${mid - 9}" width="${x1 - x0}" height="18" rx="3" fill="${tint(L.colour, 0.6)}"` +
          `${clash ? stroke : ` stroke="${L.colour}" stroke-width="1"`}${dash}/>`)
        if (done > 0) out.push(`<rect x="${x0}" y="${mid - 9}" width="${(x1 - x0) * done}" height="18" rx="3" fill="${L.colour}"/>`)
      }
      if (clash) {
        // After the bar, or just inside its end when the bar reaches the right-hand edge.
        const after = barEnd < right - 60
        out.push(`<text x="${after ? barEnd + 6 : barEnd - 6}" y="${mid + 5}" text-anchor="${after ? 'start' : 'end'}" ` +
          `font-size="12" font-weight="bold" fill="${RED}">${r.clashes.map((n) => `⚠${n}`).join(' ')}</text>`)
      }
      y += ROW_H
    }
  }

  if (t(today) >= t(s.start) && t(today) <= t(s.end) + DAY) {
    const tx = x(today)
    out.push(`<line x1="${tx}" y1="${TOP - 4}" x2="${tx}" y2="${H}" stroke="${RED}" stroke-width="2"/>`,
      `<text x="${tx + 4}" y="${TOP - 2}" font-size="11" font-weight="bold" fill="${RED}">Today</text>`)
  }

  const desc = `${s.totals.epics} epics from ${fmtDate(s.start)} to ${fmtDate(s.end)}; ` +
    `${s.totals.epicsDone} done, ${s.totals.undated} without dates, ${s.clashes.length} dependency clashes.`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" ` +
    `aria-labelledby="roadmap-title roadmap-desc" ${FONT}>` +
    `<title id="roadmap-title">${esc(s.title)}</title><desc id="roadmap-desc">${esc(desc)}</desc>` +
    `${out.join('')}</svg>`
}

export interface BurnupPoint { date: string; items: number; itemsDone: number }

/** Scope (all child items) and done items over time, one point per snapshot. */
export function burnupSvg(points: BurnupPoint[]): string {
  const W = 960
  const H = 260
  const L = 48
  const R = W - 16
  const T = 16
  const B = H - 32
  const max = Math.max(1, ...points.map((p) => p.items))
  const t0 = t(points[0].date)
  const t1 = Math.max(t0 + DAY, t(points.at(-1)!.date))
  const px = (d: string) => L + ((t(d) - t0) / (t1 - t0)) * (R - L)
  const py = (v: number) => B - (v / max) * (B - T)
  const line = (k: 'items' | 'itemsDone') => points.map((p, i) => `${i ? 'L' : 'M'}${px(p.date)} ${py(p[k])}`).join(' ')

  const out: string[] = []
  for (const v of [0, Math.round(max / 2), max]) {
    out.push(`<line x1="${L}" y1="${py(v)}" x2="${R}" y2="${py(v)}" stroke="${GRID}"/>`,
      `<text x="${L - 6}" y="${py(v) + 4}" text-anchor="end" font-size="12" fill="${SUB}">${v}</text>`)
  }
  out.push(`<text x="${L}" y="${H - 8}" font-size="12" fill="${SUB}">${fmtDate(points[0].date)}</text>`,
    `<text x="${R}" y="${H - 8}" text-anchor="end" font-size="12" fill="${SUB}">${fmtDate(points.at(-1)!.date)}</text>`,
    `<path d="${line('items')}" fill="none" stroke="${SUB}" stroke-width="2" stroke-dasharray="6 4"/>`,
    `<path d="${line('itemsDone')}" fill="none" stroke="#00703c" stroke-width="3"/>`)
  const last = points.at(-1)!
  const desc = `On ${fmtDate(last.date)}, ${last.itemsDone} of ${last.items} child items were done.`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" ` +
    `aria-labelledby="burnup-title burnup-desc" ${FONT}><title id="burnup-title">Burn-up</title>` +
    `<desc id="burnup-desc">${esc(desc)}</desc>${out.join('')}</svg>`
}
