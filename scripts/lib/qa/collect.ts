// Runs every source reader and files their findings under the layout's rows. A reader that
// fails outright leaves its rows without evidence, which the report shows as "To confirm".
//
// A feature has no candidate commits of its own. scopeFeature picks, per repo, the commit its
// service-wide rows are read at (the latest default-branch commit with a finished Jenkins build,
// or the config's pinned SHA) and makes that the one candidate, "service-wide", so the
// per-commit readers work as they do for a release. The E2E rows come from the Jenkins reader.

import type { Layout, ReleaseConfig, RepoConfig } from './config.ts'
import { type CosmosQuery, cosmosReader, cveRulesFor, STAGE_RULES } from './sources/cosmos.ts'
import { CHECK_RULES, defaultGitHubApi, type GitHubApi, type GitHubTarball, githubReader, latestFinished, LOOKBACK } from './sources/github.ts'
import { type JenkinsGet, jenkinsReader } from './sources/jenkins.ts'
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
  jenkins?: JenkinsGet
  now?: () => Date
}

export function readers(cfg: ReleaseConfig, s: Sources = {}): Record<string, () => Promise<Item[]>> {
  return {
    sonarcloud: sonarReader(cfg, s.http, s.now),
    cosmos: cosmosReader(cfg, s.cosmos, s.now),
    github: githubReader(cfg, s.githubApi, s.tarball, s.now),
    jira: jiraReader(cfg, s.twg ?? quietRunnerAsync, s.now),
    ria: riaReader(cfg, s.twg ?? quietRunnerAsync, s.now),
    ...(cfg.kind === 'feature' ? { jenkins: jenkinsReader(cfg, s.jenkins, s.tarball, s.now) } : {}),
  }
}

export const SERVICE_WIDE = 'service-wide'

/** Repos whose commits are picked at once; each pick makes several GitHub calls. */
export const SCOPE_CONCURRENCY = 4

/** Every rule the per-commit readers answer for a repo. */
export function serviceRules(rc: RepoConfig): string[] {
  return [...new Set([...SONAR_RULES, ...Object.keys(STAGE_RULES), ...Object.keys(CHECK_RULES), 'ignored-tests', ...cveRulesFor(rc)])]
}

/**
 * A feature config with its service-wide commits: one candidate, "service-wide", with a commit
 * per repo, and the evidence of how each was picked. A repo whose commit can't be picked is left
 * out of the candidate, and its service-wide rules answered unknown here instead.
 */
export async function scopeFeature(cfg: ReleaseConfig, api: GitHubApi = defaultGitHubApi(), now?: () => Date): Promise<{ cfg: ReleaseConfig; items: Item[] }> {
  if (cfg.kind !== 'feature') return { cfg, items: [] }
  const pick = async ([repo, rc]: [string, RepoConfig]): Promise<{ sha?: string; items: Item[] }> => {
    const base = { source: 'github', repo, rule: 'service-revision' }
    const link = (sha: string) => [{ text: `${repo} ${short(sha)}`, url: `https://github.com/${rc.github}/commit/${sha}` }]
    const missing = (note: string, unreachable: boolean) => ({ items: [item({ ...base, status: 'unknown', value: `${repo}: not known`, note, unreachable }, now),
      ...serviceRules(rc).map((rule) => item({ source: 'github', repo, rule, status: 'unknown', value: 'not checked', note, unreachable }, now))] })
    if (rc.commit && SHA.test(rc.commit)) {
      return { sha: rc.commit, items: [item({ ...base, status: 'pass', sha: rc.commit, value: `${repo}: ${short(rc.commit)}, pinned in the config`, links: link(rc.commit) }, now)] }
    }
    try {
      const branch = rc.commit ?? (str((await api(`repos/${rc.github}`) as Record<string, unknown>).default_branch) || 'master')
      const hit = await latestFinished(api, rc.github, branch)
      if (!hit) return missing(`none of the last ${LOOKBACK} ${branch} commits has a finished Jenkins build`, false)
      return { sha: hit.sha, items: [item({ ...base, status: 'pass', sha: hit.sha, links: link(hit.sha), data: { branch },
        value: `${repo}: ${short(hit.sha)}, the latest ${branch} commit with a finished Jenkins build${hit.date ? ` (${day(hit.date)})` : ''}` }, now)] }
    } catch (e) {
      return missing(`GitHub could not be read to pick the commit: ${reason(e)}`, true)
    }
  }
  const repos = Object.entries(cfg.repos)
  const picked = await mapLimit(repos, SCOPE_CONCURRENCY, pick)
  const shas: Record<string, string> = {}
  picked.forEach((p, n) => {
    if (p.sha) shas[repos[n][0]] = p.sha
  })
  return { cfg: { ...cfg, candidates: [{ name: SERVICE_WIDE, shas }] }, items: picked.flatMap((p) => p.items) }
}

/** Gives each item the row(s) its rule answers in this layout; items no row asks for are dropped. */
export function fileUnderRows(layout: Layout, items: Item[]): EvidenceItem[] {
  const rows = [...(layout.info?.rows ?? []).map((r) => ({ ...r, table: 'info' })), ...layout.checklist.rows.map((r) => ({ ...r, table: 'checklist' }))]
  const out: EvidenceItem[] = []
  for (const it of items) {
    if (it.rule === 'human') {
      const row = str(it.data?.row)
      if (layout.checklist.rows.some((r) => r.key === row)) out.push({ ...it, row })
      continue
    }
    for (const r of rows.filter((r) => r.rule === it.rule)) out.push({ ...it, row: r.table === 'info' ? `info:${r.key}` : r.key })
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
 * config pins is the one used.
 */
export function evidenceFor(doc: unknown, cfg: ReleaseConfig): Evidence {
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
    const fits = !!shas && doc.candidates.length === 1
      && Object.keys(shas).every((r) => Object.hasOwn(cfg.repos, r))
      && Object.keys(cfg.repos).every((r) => Object.hasOwn(shas, r) && SHA.test(str(shas[r])) && (!pinned(r) || pinned(r) === shas[r]))
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
