// SonarCloud, through its public API (no sign-in): coverage, quality gate and security findings
// from the analysis of the candidate commit itself. SonarCloud thins out old analyses, so a
// commit it no longer keeps an analysis for is reported as unknown, never as the nearest one.
// A feature's repo with `pr` is read from SonarCloud's analysis of the pull request instead
// (the pullRequest parameter), which is kept for as long as the PR is: its latest analysis, with
// the commit it covers noted when that isn't the candidate.
// Every repo of every candidate gets an item for each rule, so a repo that can't be read is
// never left out of a row's verdict.

import { type Candidate, prOfRepo, type ReleaseConfig } from '../config.ts'
import { mapLimit, SHA, str } from '../util.ts'
import { day, HttpError, type HttpJson, httpJson, item, type Item, reason, short } from './common.ts'

export const SONAR = 'https://sonarcloud.io'
const SOURCE = 'sonarcloud'
/** Candidate commits looked up at once, to stay well inside SonarCloud's anonymous rate limit. */
export const SONAR_CONCURRENCY = 4
export const SONAR_RULES = ['sonar-coverage', 'sonar-quality-gate', 'sonar-security']
const MAX_PAGES = 20

interface Analysis {
  key: string
  date: string
  revision?: string
}

/** Every analysis SonarCloud keeps for a project, newest first. */
export async function analyses(project: string, get: HttpJson = httpJson): Promise<Analysis[]> {
  const out: Analysis[] = []
  for (let p = 1; p <= MAX_PAGES; p++) {
    const page = await get(`${SONAR}/api/project_analyses/search?project=${encodeURIComponent(project)}&ps=500&p=${p}`) as
      { paging: { total: number; pageSize: number }; analyses: Analysis[] }
    out.push(...page.analyses)
    if (p * page.paging.pageSize >= page.paging.total || page.analyses.length === 0) break
  }
  return out
}

export async function findAnalysis(project: string, sha: string, get: HttpJson = httpJson): Promise<Analysis | null> {
  return (await analyses(project, get)).find((a) => a.revision === sha) ?? null
}

const METRICS = ['coverage', 'vulnerabilities', 'security_hotspots', 'security_rating']

export async function measuresAt(project: string, date: string, get: HttpJson = httpJson): Promise<Record<string, string>> {
  const at = encodeURIComponent(date)
  const res = await get(`${SONAR}/api/measures/search_history?component=${encodeURIComponent(project)}` +
    `&metrics=${METRICS.join(',')}&from=${at}&to=${at}`) as { measures: { metric: string; history: { date: string; value?: string }[] }[] }
  const out: Record<string, string> = {}
  for (const m of res.measures) {
    const v = m.history.find((h) => h.date === date)?.value
    if (v !== undefined) out[m.metric] = v
  }
  return out
}

export function sonarReader(cfg: ReleaseConfig, get: HttpJson = httpJson, now?: () => Date): () => Promise<Item[]> {
  const threshold = cfg.coverage_threshold ?? 80
  return async () => {
    // Each candidate's commits are looked up in the same history, so read it once per project.
    const history = new Map<string, Promise<Analysis[]>>()
    const find = async (project: string, sha: string) => {
      if (!history.has(project)) history.set(project, analyses(project, get))
      return (await history.get(project)!).find((a) => a.revision === sha) ?? null
    }
    const pairs = cfg.candidates.flatMap((c) => Object.entries(c.shas).map(([repo, sha]) => [c, repo, sha] as const))
    return (await mapLimit([...pairs], SONAR_CONCURRENCY, async ([c, repo, sha]) => {
      const project = cfg.repos[repo]?.sonar
      const pr = prOfRepo(cfg, repo)
      if (project && pr) return onePr(repo, project, pr, sha, c, threshold, get, now)
      if (project) return one(repo, project, sha, c, threshold, get, find, now)
      return SONAR_RULES.map((rule) => item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked',
        note: 'no Sonar project is configured for the repo' }, now))
    })).flat()
  }
}

async function one(repo: string, project: string, sha: string, c: Candidate, threshold: number, get: HttpJson,
  find: (project: string, sha: string) => Promise<Analysis | null>, now?: () => Date): Promise<Item[]> {
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  const links = [{ text: `SonarCloud ${repo}`, url: `${SONAR}/summary/overall?id=${encodeURIComponent(project)}` }]
  const unknown = (note: string, unreachable = false) => SONAR_RULES.map((rule) => item({ ...base, rule, status: 'unknown', value: 'not checked', links, note, unreachable }, now))
  let analysis: Analysis | null
  try {
    analysis = await find(project, sha)
  } catch (e) {
    return unknown(failedNote(e, 'SonarCloud', 'such project'), unreachable(e))
  }
  if (!analysis) return unknown(`SonarCloud keeps no analysis of ${short(sha)}`)

  const at = `analysis of ${short(sha)} on ${day(analysis.date)}`
  return [...await measureItems(() => measuresAt(project, analysis.date, get), { base, links, at, threshold }, now),
    await gateItem(`analysisId=${encodeURIComponent(analysis.key)}`, { base, links, at }, get, now)]
}

type ItemBase = { source: string; sha: string; repo: string; candidate: string }
type Ctx = { base: ItemBase; links: { text: string; url: string }[]; at: string }

const pct = (v: string) => `${Number(v).toFixed(1)}%`

/**
 * Whether an error means SonarCloud couldn't be read (the network, sign-in, rate limit or a 5xx),
 * rather than that what was asked for isn't there (a 404, or any other 4xx).
 */
export function unreachable(e: unknown): boolean {
  if (!(e instanceof HttpError)) return true
  return e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500
}

/** The note for an error: a 404 is something SonarCloud doesn't have; anything else, why it couldn't be read. */
const failedNote = (e: unknown, unread: string, absent: string) => (e instanceof HttpError && e.status === 404 ? `SonarCloud has no ${absent} (404)` : `${unread} could not be read: ${reason(e)}`)

/**
 * Coverage and security items from an analysis's measures. A PR analysis with only new-code
 * coverage is left unknown, its figure given for the agent to judge; with only new-code
 * vulnerability counts, it is judged by those, and says so.
 */
async function measureItems(read: () => Promise<Record<string, string>>, ctx: Ctx & { threshold: number }, now?: () => Date): Promise<Item[]> {
  const { base, links, at, threshold } = ctx
  let m: Record<string, string>
  try {
    m = await read()
  } catch (e) {
    return ['sonar-coverage', 'sonar-security'].map((rule) => item({ ...base, rule, status: 'unknown', value: 'not checked', links,
      note: failedNote(e, 'measures', 'measures for the analysis'), unreachable: unreachable(e) }, now))
  }
  const out: Item[] = []
  if ('coverage' in m) {
    const cov = Number(m.coverage)
    out.push(item({ ...base, rule: 'sonar-coverage', status: cov >= threshold ? 'pass' : 'fail', value: `${m.coverage}%`, links,
      note: at, data: { coverage: cov, threshold } }, now))
  } else if ('new_coverage' in m) {
    out.push(item({ ...base, rule: 'sonar-coverage', status: 'unknown', links, value: `${pct(m.new_coverage)} coverage of new code (no overall figure for the PR)`,
      note: at, data: { newCoverage: Number(m.new_coverage), threshold } }, now))
  } else {
    out.push(item({ ...base, rule: 'sonar-coverage', status: 'unknown', value: 'no coverage', links, note: `${at} has no coverage figure` }, now))
  }
  const vulnKey = 'vulnerabilities' in m ? 'vulnerabilities' : 'new_vulnerabilities' in m ? 'new_vulnerabilities' : null
  if (vulnKey) {
    const newCode = vulnKey === 'new_vulnerabilities'
    const v = Number(m[vulnKey])
    const h = Number((newCode ? m.new_security_hotspots : m.security_hotspots) ?? 0)
    out.push(item({ ...base, rule: 'sonar-security', status: v === 0 ? 'pass' : 'fail', links,
      value: `${v} vulnerabilit${v === 1 ? 'y' : 'ies'}, ${h} security hotspot${h === 1 ? '' : 's'}${newCode ? ' in new code' : ''}`,
      note: newCode ? `${at} has no overall vulnerability figure, only the new code's` : at,
      data: { vulnerabilities: v, hotspots: h, rating: m.security_rating, ...(newCode ? { newCode } : {}) } }, now))
  } else {
    out.push(item({ ...base, rule: 'sonar-security', status: 'unknown', value: 'no vulnerability count', links,
      note: `${at} has no vulnerability figure` }, now))
  }
  return out
}

/** The quality gate of an analysis, named by query parameters (analysisId, or projectKey and pullRequest). */
async function gateItem(params: string, ctx: Ctx, get: HttpJson, now?: () => Date): Promise<Item> {
  const { base, links, at } = ctx
  try {
    const qg = await get(`${SONAR}/api/qualitygates/project_status?${params}`) as
      { projectStatus: { status: string; conditions?: { metricKey: string; status: string }[] } }
    const s = qg.projectStatus.status
    const failed = (qg.projectStatus.conditions ?? []).filter((x) => x.status === 'ERROR').map((x) => x.metricKey)
    return item({ ...base, rule: 'sonar-quality-gate', status: s === 'OK' ? 'pass' : s === 'ERROR' ? 'fail' : 'unknown',
      value: s === 'OK' ? 'passed' : s === 'ERROR' ? 'failed' : s, links, note: at, data: failed.length ? { failed } : undefined }, now)
  } catch (e) {
    return item({ ...base, rule: 'sonar-quality-gate', status: 'unknown', value: 'not checked', links,
      note: failedNote(e, 'quality gate', 'quality gate for the analysis'), unreachable: unreachable(e) }, now)
  }
}

/** A pull request's latest analysis, as project_pull_requests/list gives it: the commit and when. */
export interface PrAnalysis {
  sha: string
  date: string
}

/** SonarCloud's latest analysis of the pull request, or null when it keeps none. */
export async function prAnalysis(project: string, pr: number, get: HttpJson = httpJson): Promise<PrAnalysis | null> {
  const res = await get(`${SONAR}/api/project_pull_requests/list?project=${encodeURIComponent(project)}`) as
    { pullRequests?: { key?: unknown; analysisDate?: unknown; commit?: { sha?: unknown } }[] }
  const hit = (Array.isArray(res?.pullRequests) ? res.pullRequests : []).find((p) => str(p?.key) === String(pr))
  return hit ? { sha: str(hit.commit?.sha), date: str(hit.analysisDate) } : null
}

export const PR_METRICS = [...METRICS, 'new_coverage', 'new_vulnerabilities', 'new_security_hotspots']

/** A PR analysis's measures: each metric's value, or for a new-code metric, its new-code period's. */
export async function prMeasures(project: string, pr: number, get: HttpJson = httpJson): Promise<Record<string, string>> {
  const res = await get(`${SONAR}/api/measures/component?component=${encodeURIComponent(project)}&pullRequest=${String(pr)}` +
    `&metricKeys=${PR_METRICS.join(',')}`) as { component?: { measures?: { metric?: unknown; value?: unknown; period?: { value?: unknown }; periods?: { value?: unknown }[] }[] } }
  const out: Record<string, string> = {}
  for (const m of res?.component?.measures ?? []) {
    const v = str(m.value) || str(m.period?.value) || str(m.periods?.[0]?.value)
    if (v) out[str(m.metric)] = v
  }
  return out
}

/** The rules from SonarCloud's analysis of the pull request. */
async function onePr(repo: string, project: string, pr: number, sha: string, c: Candidate, threshold: number, get: HttpJson,
  now?: () => Date): Promise<Item[]> {
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  const links = [{ text: `SonarCloud ${repo} PR #${String(pr)}`, url: `${SONAR}/summary/new_code?id=${encodeURIComponent(project)}&pullRequest=${String(pr)}` }]
  const unknown = (note: string, unreachable = false) => SONAR_RULES.map((rule) => item({ ...base, rule, status: 'unknown', value: 'not checked', links, note, unreachable }, now))
  let analysis: PrAnalysis | null
  try {
    analysis = await prAnalysis(project, pr, get)
  } catch (e) {
    return unknown(failedNote(e, 'SonarCloud', 'such project'), unreachable(e))
  }
  if (!analysis) return unknown(`SonarCloud keeps no analysis of PR #${String(pr)}`)
  const covers = SHA.test(analysis.sha) ? short(analysis.sha) : 'an unrecorded commit'
  const when = analysis.date ? ` on ${day(analysis.date)}` : ''
  const at = analysis.sha === sha ? `analysis of PR #${String(pr)} at ${short(sha)}${when}`
    : `the latest analysis of PR #${String(pr)}${when}, which covers ${covers}, not ${short(sha)}`
  const ctx = { base, links, at }
  return [...await measureItems(() => prMeasures(project, pr, get), { ...ctx, threshold }, now), await gateItem(`projectKey=${encodeURIComponent(project)}&pullRequest=${String(pr)}`, ctx, get, now)]
}
