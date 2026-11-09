// Reads the roadmap from Jira and writes today's snapshot and the A3 PDF.
//
//   node scripts/fetch-roadmap.ts [--config config/roadmap.json] [--today YYYY-MM-DD]
//
// Writes data/snapshots/<today>.json (committed by the scheduled workflow) and
// build/roadmap.pdf (published with the site, not committed). Jira is read through `twg`,
// so it needs a twg sign-in: your own `twg login` locally, or the one the workflow
// restores from Key Vault.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildModel, fetchIssues, loadConfig, renderPdf } from './lib/roadmap-runner.ts'
import { toSnapshot } from './lib/snapshot.ts'
import { publicRunner } from './public-twg.ts'

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config/roadmap.json' },
    today: { type: 'string' },
  },
})

const now = new Date()
const today = values.today ?? now.toISOString().slice(0, 10)
const cfg = loadConfig(values.config!)
const { issues, epics } = fetchIssues(cfg, publicRunner())
const model = buildModel(cfg, issues, today)
const snapshot = toSnapshot(cfg, model, now)

mkdirSync('data/snapshots', { recursive: true })
const out = join('data/snapshots', `${today}.json`)
writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')

mkdirSync('build', { recursive: true })
await renderPdf(model, 'build/roadmap.pdf')

const t = snapshot.totals
console.error(`${epics} epics fetched, ${t.epics} on the roadmap, ${t.undated} undated, ` +
  `${snapshot.clashes.length} clashes, ${snapshot.dependencies.length} external dependencies`)
console.log(out)
