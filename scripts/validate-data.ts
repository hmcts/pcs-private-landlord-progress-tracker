// Validates the hand-edited data files. Run before every build: npm run validate
import { loadYaml, validateDecisions, validateNfrs, validateOverview, validateRaid, validateReports } from './lib/data.ts'
import { validateAll } from './lib/qa/config.ts'

const errors = [
  ...validateOverview(loadYaml('src/_data/overview.yaml')),
  ...validateRaid(loadYaml('src/_data/raid.yaml')),
  ...validateNfrs(loadYaml('src/_data/nfrs.yaml')),
  ...validateDecisions(loadYaml('src/_data/decisions.yaml')),
  ...validateReports(loadYaml('src/_data/reports.yaml')),
  ...validateAll(),
]
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.error('✓ overview.yaml, raid.yaml, nfrs.yaml, decisions.yaml, reports.yaml and config/qa-readiness are valid')
