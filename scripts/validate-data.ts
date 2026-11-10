// Validates the hand-edited data files. Run before every build: npm run validate
import { loadYaml, validateNfrs, validateOverview, validateRaid } from './lib/data.ts'

const errors = [
  ...validateOverview(loadYaml('src/_data/overview.yaml')),
  ...validateRaid(loadYaml('src/_data/raid.yaml')),
  ...validateNfrs(loadYaml('src/_data/nfrs.yaml')),
]
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.error('✓ overview.yaml, raid.yaml and nfrs.yaml are valid')
