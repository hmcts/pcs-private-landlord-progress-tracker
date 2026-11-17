// Runs every source reader and files their findings under the layout's rows. A reader that
// fails outright leaves its rows without evidence, which the report shows as unknown.
//
// A feature has no candidate commits of its own. scopeFeature picks, per repo, the commit its
// service-wide rows are read at (the latest default-branch commit with a finished Jenkins build,
// the config's pinned SHA, or for a repo with `pr`, the commit of the PR's latest finished
// Jenkins build) and makes that the one candidate, "service-wide", so the per-commit readers work
// as they do for a release. The E2E rows come from the E2E reader (e2e.ts).

import { type Layout, prOfRepo, type ReleaseConfig, type RepoConfig } from './config.ts'
import { BRANCH_DAYS, branchBuilds, type CosmosQuery, cosmosReader, cveRulesFor, defaultCosmosQuery, latestBuild, STAGE_RULES } from './sources/cosmos.ts'
import { CHECK_RULES, defaultGitHubApi, type GitHubApi, type GitHubTarball, githubReader, latestFinished, LOOKBACK } from './sources/github.ts'
import { e2eReader, fromGitHub } from './sources/e2e.ts'
import { jiraReader } from './sources/jira.ts'
import { riaReader } from './sources/ria.ts'
import { day, type HttpJson, item, type Item, reason, short } from './sources/common.ts'
import { SONAR_RULES, sonarReader } from './sources/sonar.ts'
import { type AsyncTwgRunner, quietRunnerAsync } from './twg.ts'
import type { Evidence, EvidenceItem } from './types.ts'
import { QaError } from './errors.ts'
import { isRec, mapLimit, SHA, str } from './util.ts'

export interface Sources {
  http?: HttpJson
  cosmos?: CosmosQuery
  githubApi?: GitHubApi
  tarball?: GitHubTarball
  twg?: AsyncTwgRunner
  now?: () => Date
}

export function readers(cfg: ReleaseConfig, s: Sources = {}): Record<string, () => Promise<Item[]>> {
  return {
    sonarcloud: sonarReader(cfg, s.http, s.now),
    cosmos: cosmosReader(cfg, s.cosmos, s.now, s.githubApi),
    github: githubReader(cfg, s.githubApi, s.tarball, s.now),
    jira: jiraReader(cfg, s.twg ?? quietRunnerAsync, s.now),
    ria: riaReader(cfg, s.twg ?? quietRunnerAsync, s.now),
    ...(cfg.kind === 'feature' ? { e2e: e2eReader(cfg, s.cosmos, s.githubApi, s.tarball, s.now) } : {}),
  }
}

export const SERVICE_WIDE = 'service-wide'

/** Repos whose commits are picked at once; each pick makes several GitHub calls. */
export const SCOPE_CONCURRENCY = 4

/** Every rule the per-commit readers answer for a repo. */
export function serviceRules(rc: RepoConfig): string[] {
  return [...new Set([...SONAR_RULES, ...Object.keys(STAGE_RULES), ...Object.keys(CHECK_RULES), 'ignored-tests', ...cveRulesFor(rc)])]
}

type Picked = { sha?: string; items: Item[] }

/** The Jenkins states of a finished build, as latestFinished counts them for a branch: passed or failed. */
const FINISHED = new Set(['success', 'failure'])

type Missing = (note: string, unreachable: boolean, head?: { sha: string; data: Record<string, unknown> }) => Picked

/**
 * A repo's commit at its pull request: the commit of the PR job's latest finished Jenkins build
 * (Cosmos pipeline-metrics, branch PR-<n>), else, when Cosmos has none or can't be read, the PR's
 * head commit from GitHub, if the Jenkins status on it says its build finished. data.from says
 * which. A head whose build is still running, errored or has no status is not picked: its rules
 * are unknown, and unreachable while Cosmos, which may have a finished build, can't be read.
 */
async function prCommit(rc: RepoConfig, pr: number, api: GitHubApi, cosmos: CosmosQuery, now: () => Date,
  picked: (sha: string, note: string, data: Record<string, unknown>) => Picked, missing: Missing): Promise<Picked> {
  const branch = `PR-${String(pr)}`
  const url = `https://github.com/${rc.github}/pull/${String(pr)}`
  let why = 'no Jenkins product and component are configured for the repo'
  let down = false
  if (rc.cosmos_product) {
    try {
      const b = latestBuild(await branchBuilds(cosmos, rc, branch, rc.e2e?.jenkins.job, null, now))
      if (b && SHA.test(b.sha)) {
        return picked(b.sha, `the commit of ${branch} #${b.number}, the PR's latest finished Jenkins build (${b.outcome.toLowerCase()}${b.started ? `, ${day(b.started)}` : ''}), from Cosmos`,
          { from: 'cosmos', pr, url, branch, number: b.number, outcome: b.outcome, ...(b.url.startsWith('https://') ? { build: b.url } : {}) })
      }
      why = b ? `Cosmos recorded no commit for ${branch} #${b.number}` : `Cosmos records no finished build of ${branch} in the last ${BRANCH_DAYS} days`
    } catch (e) {
      why = `Cosmos pipeline-metrics could not be read: ${reason(e)}`
      down = true
    }
  }
  try {
    const head = await fromGitHub(api, rc.github, branch)
    if (!head) return missing(`${why}, and GitHub has no head commit for ${branch}`, false)
    const build = head.number ? `${branch} #${head.number}` : branch
    const status = head.state ? `its Jenkins status (${build}) is ${head.state}` : 'it has no Jenkins status'
    const data = { from: 'github', pr, url, branch, number: head.number ?? null, state: head.state ?? null, ...(head.url ? { build: head.url } : {}) }
    if (!FINISHED.has(head.state ?? '')) {
      return missing(`the PR's head commit ${short(head.sha)} has no finished Jenkins build: ${status}; ${why}`, down, { sha: head.sha, data })
    }
    return picked(head.sha, `the PR's head commit, from GitHub, where ${status}: ${why}`, data)
  } catch (e) {
    return missing(`${why}, and GitHub could not be read: ${reason(e)}`, true)
  }
}

/**
 * A feature config with its service-wide commits: one candidate, "service-wide", with a commit
 * per repo, and the evidence of how each was picked. A repo whose commit can't be picked is left
 * out of the candidate, listed in `unpicked`, and its service-wide rules answered unknown here
 * instead.
 */
export async function scopeFeature(cfg: ReleaseConfig, api: GitHubApi = defaultGitHubApi(), now?: () => Date,
  cosmos: CosmosQuery = defaultCosmosQuery()): Promise<{ cfg: ReleaseConfig; items: Item[]; unpicked: string[] }> {
  if (cfg.kind !== 'feature') return { cfg, items: [], unpicked: [] }
  const pick = async ([repo, rc]: [string, RepoConfig]): Promise<Picked> => {
    const base = { source: 'github', repo, rule: 'service-revision' }
    // The GIT Revision cell, as the template writes it: "<repo> = <sha7>", linked to the commit.
    const shown = (sha: string) => ({ sha, value: `${repo} = ${short(sha)}`, links: [{ text: `${repo} = ${short(sha)}`, url: `https://github.com/${rc.github}/commit/${sha}` }] })
    const picked = (sha: string, note: string, data?: Record<string, unknown>): Picked => ({ sha, items: [item({ ...base, status: 'pass', ...shown(sha), note, data }, now)] })
    // A head that wasn't picked is still named in the cell, but its status is unknown.
    const missing: Missing = (note, unreachable, head) => ({ items: [
      item({ ...base, status: 'unknown', ...(head ? { ...shown(head.sha), data: head.data } : { value: `${repo}: not known` }), note, unreachable }, now),
      ...serviceRules(rc).map((rule) => item({ source: 'github', repo, rule, status: 'unknown', value: 'not checked', note, unreachable }, now))] })
    const pr = prOfRepo(cfg, repo)
    if (pr) return prCommit(rc, pr, api, cosmos, now ?? (() => new Date()), picked, missing)
    if (rc.commit && SHA.test(rc.commit)) return picked(rc.commit, 'pinned in the config')
    try {
      const branch = rc.commit ?? (str((await api(`repos/${rc.github}`) as Record<string, unknown>).default_branch) || 'master')
      const hit = await latestFinished(api, rc.github, branch)
      if (!hit) return missing(`none of the last ${LOOKBACK} ${branch} commits has a finished Jenkins build`, false)
      return picked(hit.sha, `the latest ${branch} commit with a finished Jenkins build${hit.date ? ` (${day(hit.date)})` : ''}`, { branch })
    } catch (e) {
      return missing(`GitHub could not be read to pick the commit: ${reason(e)}`, true)
    }
  }
  const repos = Object.entries(cfg.repos)
  const picked = await mapLimit(repos, SCOPE_CONCURRENCY, pick)
  const shas: Record<string, string> = {}
  const unpicked: string[] = []
  picked.forEach((p, n) => {
    if (p.sha) shas[repos[n][0]] = p.sha
    else unpicked.push(repos[n][0])
  })
  return { cfg: { ...cfg, candidates: [{ name: SERVICE_WIDE, shas }] }, items: picked.flatMap((p) => p.items), unpicked }
}

/** Rules whose items name the row they answer, in `data.row` (`info:<key>` for an agent info row). */
const ROW_TARGETED = new Set(['human', 'agent'])

/**
 * Gives each item the row(s) its rule answers in this layout, or gives evidence to as an
 * `agent` row's `evidence`; items no row asks for are dropped.
 */
export function fileUnderRows(layout: Layout, items: Item[]): EvidenceItem[] {
  const rows = [...(layout.info?.rows ?? []).map((r) => ({ ...r, table: 'info' })), ...layout.checklist.rows.map((r) => ({ ...r, table: 'checklist' }))]
  const out: EvidenceItem[] = []
  for (const it of items) {
    if (ROW_TARGETED.has(it.rule)) {
      const row = str(it.data?.row)
      const info = it.rule === 'agent' && row.startsWith('info:') && layout.info?.rows.some((r) => `info:${r.key}` === row && r.rule === 'agent')
      if (info || layout.checklist.rows.some((r) => r.key === row && (it.rule === 'human' || r.rule === 'agent'))) out.push({ ...it, row })
      continue
    }
    for (const r of rows.filter((r) => r.rule === it.rule || r.evidence?.includes(it.rule))) out.push({ ...it, row: r.table === 'info' ? `info:${r.key}` : r.key })
  }
  return out
}

export async function collect(cfg: ReleaseConfig, layout: Layout, rs: Record<string, () => Promise<Item[]>>,
  now: () => Date = () => new Date()): Promise<{ evidence: Evidence; errors: Record<string, string> }> {
  const items: Item[] = []
  const errors: Record<string, string> = {}
  await Promise.all(Object.entries(rs).map(async ([name, read]) => {
    try {
      items.push(...await read())
    } catch (e) {
      errors[name] = reason(e)
    }
  }))
  const order = Object.keys(rs)
  items.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))
  return {
    evidence: { release: cfg.release, generatedAt: now().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) },
    errors,
  }
}

/**
 * An evidence file read back, checked to be this release's, for exactly its candidate commits.
 * A feature's commits were picked when the evidence was collected, so they are taken from it,
 * as long as there is one for every repo of the feature, none for any other, and any commit the
 * config pins is the one used. With `allowUnpicked` (the agent's answers are being applied to the
 * evidence collected for them), a repo the evidence records as `unpicked` may have no commit;
 * its service-wide rows are unknown in the evidence itself.
 */
export function evidenceFor(doc: unknown, cfg: ReleaseConfig, opts: { allowUnpicked?: boolean } = {}): Evidence {
  if (!isRec(doc) || !Array.isArray(doc.items) || !Array.isArray(doc.candidates)) {
    throw new QaError('evidence-invalid', 'expected { release, candidates, items }')
  }
  if (cfg.kind === 'feature') {
    const [c] = doc.candidates as unknown[]
    const shas = isRec(c) && c.name === SERVICE_WIDE && isRec(c.shas) ? c.shas : null
    const pinned = (r: string) => {
      const commit = cfg.repos[r].commit
      return commit && SHA.test(commit) ? commit : null
    }
    const listed = opts.allowUnpicked && doc.unpicked !== undefined ? doc.unpicked : []
    const unpicked = Array.isArray(listed) && listed.every((r) => typeof r === 'string') ? listed as string[] : null
    const fits = !!shas && !!unpicked && doc.candidates.length === 1
      && Object.keys(shas).every((r) => Object.hasOwn(cfg.repos, r))
      && new Set(unpicked).size === unpicked.length
      && unpicked.every((r) => Object.hasOwn(cfg.repos, r) && !Object.hasOwn(shas, r) && !pinned(r))
      && Object.keys(cfg.repos).every((r) => unpicked.includes(r)
        || (Object.hasOwn(shas, r) && SHA.test(str(shas[r])) && (!pinned(r) || pinned(r) === shas[r])))
    if (doc.release !== cfg.release || !fits) throw new QaError('evidence-mismatch', `the evidence is for ${str(doc.release)}, or other commits than the config's`)
    return doc as unknown as Evidence
  }
  const same = (a: unknown, b: { name: string; shas: Record<string, string> }) => {
    if (!isRec(a) || a.name !== b.name || !isRec(a.shas)) return false
    const shas = a.shas
    return Object.keys(shas).length === Object.keys(b.shas).length && Object.entries(b.shas).every(([r, sha]) => shas[r] === sha)
  }
  const given: unknown[] = doc.candidates
  if (doc.release !== cfg.release || given.length !== cfg.candidates.length || !cfg.candidates.every((c, n) => same(given[n], c))) {
    throw new QaError('evidence-mismatch', `the evidence is for ${str(doc.release)}, or other candidates than the config's`)
  }
  return doc as unknown as Evidence
}
