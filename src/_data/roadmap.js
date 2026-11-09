// Roadmap data for the templates, from the committed daily snapshots in data/snapshots/.
// The latest snapshot drives the Roadmap, Overview and Dependencies pages; all of them
// together give the burn-up.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { burnupSvg, roadmapSvg } from '../../scripts/lib/svg.ts'

const DIR = 'data/snapshots'
const STALE_AFTER_DAYS = 3 // the job runs Mon–Fri, so allow for a weekend

export default function () {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []
  if (!files.length) return { latest: null, stale: true }

  const snapshots = files.map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')))
  const latest = snapshots.at(-1)
  const today = new Date().toISOString().slice(0, 10)
  const ageDays = (Date.now() - Date.parse(latest.generatedAt)) / 86_400_000
  const points = snapshots.map((s) => ({ date: s.date, items: s.totals.items, itemsDone: s.totals.itemsDone }))

  return {
    latest,
    stale: ageDays > STALE_AFTER_DAYS,
    pdf: existsSync('build/roadmap.pdf'),
    svg: latest.totals.epics ? roadmapSvg(latest, today) : '',
    burnup: points.length > 1 && points.some((p) => p.items) ? burnupSvg(points) : '',
    rows: latest.lanes.flatMap((l) => l.rows.map((r) => ({ ...r, lane: l.title }))),
  }
}
