// Validates the hand-edited data files. Run before every build: npm run validate
import { loadYaml, validateDependencies, validateOverview, validateRaid } from './lib/data.ts'

const errors = [
  ...validateOverview(loadYaml('src/_data/overview.yaml')),
  ...validateRaid(loadYaml('src/_data/raid.yaml')),
  ...validateDependencies(loadYaml('src/_data/dependencies.yaml')),
]
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.error('✓ overview.yaml, raid.yaml and dependencies.yaml are valid')
