// Validates the hand-edited data files. Run before every build: npm run validate
import { loadYaml, validateDecisions, validateNfrs, validateOverview, validateRaid } from './lib/data.ts'

const errors = [
  ...validateOverview(loadYaml('src/_data/overview.yaml')),
  ...validateRaid(loadYaml('src/_data/raid.yaml')),
  ...validateNfrs(loadYaml('src/_data/nfrs.yaml')),
  ...validateDecisions(loadYaml('src/_data/decisions.yaml')),
]
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.error('✓ overview.yaml, raid.yaml, nfrs.yaml and decisions.yaml are valid')
