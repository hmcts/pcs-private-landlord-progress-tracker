// twg for the QA report: the roadmap's runner, with stderr captured rather than passed through,
// since twg's notices can name the page or query it read and this runs in a public log.

import { execFileSync } from 'node:child_process'
import type { TwgRunner } from '../roadmap-runner.ts'

export const quietRunner: TwgRunner = (args) =>
  execFileSync('twg', args, { encoding: 'utf8', env: { ...process.env, TWG_AGENT_DEFAULTS: '1' }, maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] })
