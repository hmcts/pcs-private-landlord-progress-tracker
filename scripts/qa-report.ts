// Generates a release's or a feature's QA readiness report and merges it into its Confluence page.
//
//   node scripts/qa-report.ts --release R1.3A [--evidence] [--judgement] [--publish]
//                             [--validate] [--create-under <parentPageId>] [--config <file>]
//   node scripts/qa-report.ts --feature <name> [the same options]
//   node scripts/qa-report.ts --all-active [--publish] [--validate]
//   node scripts/qa-report.ts --all-active --collect-only
//   node scripts/qa-report.ts --all-active --answers [--publish] [--validate]
//
// Collects evidence for the release's candidate commits (SonarCloud, Jenkins results in Cosmos,
// GitHub, Jira and the Release Impact Assessment), renders the report, and merges it into
// report_page. A feature's service-wide rows are read at each repo's latest finished
// default-branch build, its Jira rows from its epics' child tickets, and its E2E rows from the
// Jenkins build its config names, as Cosmos or GitHub records it (lib/qa/sources/e2e.ts). A row whose source couldn't be read
// keeps what the page already says. It's a dry run unless --publish is given: the merged page and a diff are
// written to the cache directory (see scripts/lib/qa/cache.ts) and nothing is written to
// Confluence. --validate also has twg check the edits, without writing them. --evidence
// skips collecting and reuses the release's evidence.json from an earlier run. --judgement fills
// rows a person answers from judgement.yaml (or .json) beside it (see scripts/lib/qa/judgement.ts).
// --all-active runs every
// release and feature with `active: true` and a report_page, each on its own: one failing
// doesn't stop the rest, but fails the run.
//
// A layout's `agent` rows are answered by the QA agent (lib/qa/answers.ts). --collect-only
// collects the evidence and writes it, with agent-input.json for the agent, to each scope's cache
// directory, and stops. --answers then renders and merges from that evidence and the agent's
// answers.json beside it (it implies --evidence, so answers meet the evidence they were written
// against); an agent row with no answer keeps what the page says.
//
// This repo and its logs are public, so this prints only counts and each row's pass, fail or
// unknown. Everything else, evidence included, stays in the cache directory. A failure prints
// only a fixed message for its kind (lib/qa/errors.ts); the error itself goes to errors.log
// there. A --config file must be in config/qa-readiness or the cache directory.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { AGENT_INPUT_FILE, agentInput, agentRows, ANSWERS_FILE, answerItems, hasAgentWork, loadAnswers, type Published, type SectionAnswers } from './lib/qa/answers.ts'
import { cacheDir, releaseDir, releaseName, within } from './lib/qa/cache.ts'
import { collect, evidenceFor, fileUnderRows, readers, scopeFeature } from './lib/qa/collect.ts'
import { activeReleases, CONFIG_DIR, type Layout, loadRelease, type ReleaseConfig, releasePath, type ScopeKind } from './lib/qa/config.ts'
import { logError, publicMessage, QaError } from './lib/qa/errors.ts'
import { judgementFile, type Judgements, loadJudgements } from './lib/qa/judgement.ts'
import { createPage, getPage, published, publishToPage, type PublishResult, releaseTitle } from './lib/qa/publish.ts'
import { evaluate, genRows, renderPage, type Results } from './lib/qa/render.ts'
import { genParts } from './lib/qa/sections.ts'
import { accountName, pageId, quietRunner } from './lib/qa/twg.ts'
import type { Item } from './lib/qa/sources/common.ts'
import type { Evidence } from './lib/qa/types.ts'
import { str } from './lib/qa/util.ts'

const USAGE = 'usage: npm run qa-report -- --release <name> [--evidence] [--judgement] [--answers] [--publish] [--validate] [--create-under <pageId>]\n' +
  '       npm run qa-report -- --feature <name> [--evidence] [--judgement] [--answers] [--publish] [--validate] [--create-under <pageId>]\n' +
  '       npm run qa-report -- --feature <name> [--evidence] --collect-only\n' +
  '       npm run qa-report -- --all-active [--collect-only | --answers] [--publish] [--validate]'

const OPTIONS = {
  release: { type: 'string' },
  feature: { type: 'string' },
  config: { type: 'string' },
  evidence: { type: 'boolean', default: false },
  judgement: { type: 'boolean', default: false },
  publish: { type: 'boolean', default: false },
  validate: { type: 'boolean', default: false },
  'create-under': { type: 'string' },
  'all-active': { type: 'boolean', default: false },
  'collect-only': { type: 'boolean', default: false },
  answers: { type: 'boolean', default: false },
} as const

function args() {
  try {
    return parseArgs({ options: OPTIONS }).values
  } catch {
    console.error(USAGE)
    process.exit(2)
  }
}

const values = args()

const say = (s: string) => console.log(s)
const EVIDENCE_FILE = 'evidence.json'

interface Options {
  /** The release or feature named on the command line, and which it was. */
  name?: string
  kind?: ScopeKind
  evidence?: boolean
  judgement?: boolean
  createUnder?: string
  collectOnly?: boolean
  answers?: boolean
  publish: boolean
  validate: boolean
}

const SOURCES = ['sonarcloud', 'cosmos', 'github', 'jira', 'ria', 'e2e']

const tallyOf = (items: { status: string }[]) => {
  const n = (s: string) => items.filter((i) => i.status === s).length
  return `${items.length} items, ${n('pass')} pass, ${n('fail')} fail, ${n('unknown')} unknown`
}

/**
 * The evidence from the last collect, or a fresh collect written for next time, and the config
 * with the commits it was collected for (a feature's are picked at collection).
 */
async function gather(cfg: ReleaseConfig, layout: Layout, dir: string, reuse: boolean, allowUnpicked = false): Promise<{ cfg: ReleaseConfig; evidence: Evidence }> {
  if (reuse) {
    let doc: unknown
    try {
      doc = JSON.parse(readFileSync(join(dir, EVIDENCE_FILE), 'utf8'))
    } catch (e) {
      throw new QaError('evidence-invalid', `the evidence file could not be read as JSON: ${(e as Error).message}`)
    }
    const evidence = evidenceFor(doc, cfg, { allowUnpicked })
    say(`evidence: ${evidence.items.length} items from a file`)
    return { cfg: { ...cfg, candidates: evidence.candidates }, evidence }
  }
  const scoped = await scopeFeature(cfg)
  const extra: Record<string, () => Promise<Item[]>> = scoped.items.length ? { 'service-revision': async () => scoped.items } : {}
  const res = await collect(scoped.cfg, layout, { ...readers(scoped.cfg), ...extra })
  if (cfg.kind === 'feature') res.evidence.unpicked = scoped.unpicked
  writeFileSync(join(dir, EVIDENCE_FILE), JSON.stringify(res.evidence, null, 2) + '\n')
  for (const source of SOURCES.filter((x) => x !== 'e2e' || cfg.kind === 'feature')) {
    const its = res.evidence.items.filter((i) => i.source === source)
    const away = its.filter((i) => i.unreachable).length
    say(`${source}: ${res.errors[source] ? 'failed' : `${tallyOf(its)}${away ? ` (${away} unreachable)` : ''}`}`)
  }
  return { cfg: scoped.cfg, evidence: res.evidence }
}

/**
 * Writes agent-input.json for the layout's agent rows and sections, with what the published page
 * says now if it can be read and, for a layout with a "Created by" line, the name of the account
 * twg runs as, and removes answers.json left from an earlier collection. The name is never printed.
 */
function writeAgentInput(cfg: ReleaseConfig, layout: Layout, evidence: Evidence, dir: string): void {
  rmSync(join(dir, ANSWERS_FILE), { force: true })
  const rows = agentRows(layout)
  if (!hasAgentWork(layout)) {
    say('agent input: the layout has no agent rows, so none was written')
    return
  }
  let page: Published | null = null
  if (cfg.report_page) {
    try {
      page = published(getPage(quietRunner, pageId(cfg.report_page), false).html, layout)
    } catch (e) {
      logError(cacheDir(), cfg.release, e)
    }
  }
  const name = layout.header ? accountName(quietRunner) : null
  const input = agentInput(cfg, layout, evidence, page, name)
  writeFileSync(join(dir, AGENT_INPUT_FILE), JSON.stringify(input, null, 2) + '\n')
  const filed = evidence.items.filter((i) => rows.some((r) => r.key === i.row)).length
  const sections = layout.sections ? `, ${layout.sections.length} sections${layout.header ? `, ${name ? 'the' : 'no'} account name` : ''}` : ''
  say(`agent input: ${rows.length} rows${sections}, ${filed} evidence items, ${page ? `the page's text for ${Object.keys(page.rows).length} rows` : 'the page could not be read'}`)
}

/** The evidence with the agent's answers from answers.json added, and its section answers. */
function withAnswers(name: string, layout: Layout, evidence: Evidence, dir: string): { evidence: Evidence; sections: SectionAnswers } {
  const none = { evidence, sections: {} }
  if (!hasAgentWork(layout)) return none
  const loaded = loadAnswers(dir, layout)
  if (!loaded.found) {
    say(`agent: no ${ANSWERS_FILE}, so every agent row keeps the published answer`)
    return none
  }
  if (loaded.unreadable) {
    logError(cacheDir(), name, loaded.unreadable)
    say(`agent: ${ANSWERS_FILE} could not be read, so 0 answers were taken and every agent row keeps the published answer`)
    return none
  }
  const all = answerItems(loaded.answers, layout, undefined, loaded.sections)
  const items = all.filter((i) => !str(i.data?.row).startsWith('info:'))
  const missing = agentRows(layout).length - items.length
  const given = layout.sections ? `, ${Object.keys(loaded.sections).length} section answers` : ''
  say(`agent: ${tallyOf(items)}, ${missing} rows without an answer${given}${loaded.rejected ? ` (${loaded.rejected} rejected: see answers-rejected.txt in the cache directory)` : ''}`)
  return { evidence: { ...evidence, items: [...evidence.items, ...fileUnderRows(layout, all)] }, sections: loaded.sections }
}

function sayRows(results: Results, judgements: Judgements, judged: boolean): void {
  for (const r of results.checklist) {
    const kept = r.rule === 'agent' ? ' (no agent answer: keeps the published answer)' : ' (source unreachable: keeps the published answer)'
    const note = judgements[r.key] ? ' (judgement given)' : r.keep ? kept : r.needsJudgement ? ' (needs a person)' : ''
    say(`row ${r.key.padEnd(3)} ${r.status}${note}`)
  }
  const tally = (s: string) => results.checklist.filter((r) => r.status === s).length
  say(`${results.checklist.length} rows: ${tally('pass')} pass, ${tally('fail')} fail, ${tally('unknown')} unknown` +
    (judged ? `, ${Object.keys(judgements).length} judgements given` : ''))
}

function sayPublished(res: PublishResult): void {
  const c = res.counts
  const would = res.published ? '' : 'would be '
  const retired = c.retiredKept ? `${c.retiredKept} rows not in the layout kept as people wrote them, ` : ''
  const moved = `${c.moved ? `${c.moved} rows ${would}moved, ` : ''}${c.sections ? `${c.sections} sections ${would}added, ` : ''}`
  const tail = `${c.judged} judgement cells ${would}written, ${c.added} rows ${would}added, ${c.removed} rows ${would}removed, ${moved}${retired}${c.human} cells kept as people wrote them, ` +
    `${c.kept} kept as published (source unreachable or no agent answer), ${c.skipped} skipped`
  say(res.published ? `${c.change} cells changed, ${tail}${res.retried ? ' (after re-reading the page)' : ''}`
    : `${c.change} cells would change, ${tail}`)
  if (res.validated !== undefined) say(`twg validation: ${res.validated ? 'passed' : 'failed'}`)
}

/** 'skipped' when the page has unpublished edits, so it was left alone. */
async function report(path: string, o: Options): Promise<'done' | 'skipped'> {
  const loaded = loadRelease(path)
  const { layout } = loaded
  if (o.name && (o.name !== loaded.cfg.release || o.kind !== loaded.cfg.kind)) {
    throw new QaError('config-mismatch', `the config is for ${loaded.cfg.kind} ${loaded.cfg.release}, not ${o.kind} ${o.name}`)
  }
  if (o.publish && !loaded.cfg.active) throw new QaError('not-active', `${loaded.cfg.release} is not active`)
  const createUnder = o.createUnder === undefined ? undefined : pageId(o.createUnder)
  const dir = releaseDir(loaded.cfg.release)

  const gathered = await gather(loaded.cfg, layout, dir, !!o.evidence, !!o.answers)
  const { cfg } = gathered
  if (o.collectOnly) {
    writeAgentInput(cfg, layout, gathered.evidence, dir)
    return 'done'
  }
  const answered = o.answers ? withAnswers(cfg.release, layout, gathered.evidence, dir) : { evidence: gathered.evidence, sections: {} }
  const { evidence } = answered
  const results = evaluate(cfg, layout, evidence)
  const judgements: Judgements = o.judgement ? loadJudgements(judgementFile(dir), results.checklist) : {}
  sayRows(results, judgements, !!o.judgement)
  const rows = genRows(layout, results, judgements)
  const parts = genParts(layout, answered.sections, new Date())
  const page = renderPage(cfg, layout, results, judgements, parts)
  writeFileSync(join(dir, 'report.html'), page)

  if (cfg.report_page) {
    const res = publishToPage(quietRunner, pageId(cfg.report_page), layout, rows, dir, { publish: o.publish, validate: o.validate }, parts)
    if (res.unpublishedEdits) {
      say(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}page has unpublished edits; skipped`)
      return 'skipped'
    }
    sayPublished(res)
  } else if (createUnder) {
    const id = createPage(quietRunner, createUnder, releaseTitle(cfg, layout), page, dir, o.publish)
    say(id ? `created page ${id}: set report_page: '${id}' in the config` : `a new page with ${rows.length} rows would be created`)
  } else {
    say('no report_page in the config, so the report was only rendered (use --create-under <pageId> to create one)')
  }
  return 'done'
}

async function main(): Promise<number> {
  const collectOnly = values['collect-only']
  if (collectOnly) {
    const clash = (['answers', 'judgement', 'publish', 'validate', 'create-under'] as const).filter((k) => values[k] !== undefined && values[k] !== false)
    if (clash.length) {
      console.error(`--collect-only can't be combined with --${clash.join(', --')}`)
      return 2
    }
  }
  if (values['all-active']) {
    const only = (['release', 'feature', 'config', 'evidence', 'judgement', 'create-under'] as const).filter((k) => values[k] !== undefined && values[k] !== false)
    if (only.length) {
      console.error(`--all-active can't be combined with --${only.join(', --')}`)
      return 2
    }
    const paths = activeReleases()
    if (!paths.length) {
      say('no active releases or features with a report_page, so there is nothing to do')
      return 0
    }
    let failed = 0
    let skipped = 0
    for (const path of paths) {
      const name = basename(path, '.yaml')
      say(`report ${name}`)
      try {
        const o = { collectOnly, answers: values.answers, evidence: values.answers, publish: values.publish, validate: values.validate }
        if (await report(path, o) === 'skipped') skipped++
      } catch (e) {
        failed++
        logError(cacheDir(), name, e)
        console.error(`qa-report failed for ${name}: ${publicMessage(e)}`)
      }
    }
    say(`${paths.length} reports: ${paths.length - failed - skipped} done, ${skipped} skipped for unpublished edits, ${failed} failed`)
    return failed ? 1 : 0
  }

  if ((!values.release && !values.feature && !values.config) || (values.release && values.feature)) {
    console.error(USAGE)
    return 2
  }
  const cache = cacheDir()
  const kind: ScopeKind = values.feature === undefined ? 'release' : 'feature'
  const given = values.feature ?? values.release
  const name = given === undefined ? undefined : releaseName(given)
  const config = values.config === undefined ? releasePath(name!) : within(values.config, [CONFIG_DIR, cache])
  await report(config, {
    name, kind,
    evidence: values.evidence || values.answers, judgement: values.judgement, collectOnly, answers: values.answers,
    createUnder: values['create-under'], publish: values.publish, validate: values.validate,
  })
  return 0
}

main().then((code) => process.exit(code), (e) => {
  try {
    logError(cacheDir(), values.release ?? values.feature ?? 'qa-report', e)
  } catch {
    // No cache directory to log to; the message below is all there is.
  }
  console.error(`qa-report failed: ${publicMessage(e)}`)
  process.exit(1)
})
