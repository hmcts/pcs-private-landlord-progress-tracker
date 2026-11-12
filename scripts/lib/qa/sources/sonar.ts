// SonarCloud, through its public API (no sign-in): coverage, quality gate and security findings
// from the analysis of the candidate commit itself. SonarCloud thins out old analyses, so a
// commit it no longer keeps an analysis for is reported as unknown, never as the nearest one.
// Every repo of every candidate gets an item for each rule, so a repo that can't be read is
// never left out of a row's verdict.

import type { Candidate, ReleaseConfig } from '../config.ts'
import { day, type HttpJson, httpJson, item, type Item, reason, short } from './common.ts'

export const SONAR = 'https://sonarcloud.io'
const SOURCE = 'sonarcloud'
export const SONAR_RULES = ['sonar-coverage', 'sonar-quality-gate', 'sonar-security']
const MAX_PAGES = 20

interface Analysis {
  key: string
  date: string
  revision?: string
}

export async function findAnalysis(project: string, sha: string, get: HttpJson = httpJson): Promise<Analysis | null> {
  for (let p = 1; p <= MAX_PAGES; p++) {
    const page = await get(`${SONAR}/api/project_analyses/search?project=${encodeURIComponent(project)}&ps=500&p=${p}`) as
      { paging: { total: number; pageSize: number }; analyses: Analysis[] }
    const hit = page.analyses.find((a) => a.revision === sha)
    if (hit) return hit
    if (p * page.paging.pageSize >= page.paging.total || page.analyses.length === 0) return null
  }
  return null
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
    const out: Item[] = []
    for (const c of cfg.candidates) {
      for (const [repo, sha] of Object.entries(c.shas)) {
        const project = cfg.repos[repo]?.sonar
        if (!project) {
          out.push(...SONAR_RULES.map((rule) => item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked',
            note: 'no Sonar project is configured for the repo' }, now)))
          continue
        }
        out.push(...await one(repo, project, sha, c, threshold, get, now))
      }
    }
    return out
  }
}

async function one(repo: string, project: string, sha: string, c: Candidate, threshold: number, get: HttpJson,
  now?: () => Date): Promise<Item[]> {
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  const links = [{ text: `SonarCloud ${repo}`, url: `${SONAR}/summary/overall?id=${encodeURIComponent(project)}` }]
  const unknown = (note: string) => SONAR_RULES.map((rule) => item({ ...base, rule, status: 'unknown', value: 'not checked', links, note }, now))
  let analysis: Analysis | null
  try {
    analysis = await findAnalysis(project, sha, get)
  } catch (e) {
    return unknown(`SonarCloud could not be read: ${reason(e)}`)
  }
  if (!analysis) return unknown(`SonarCloud keeps no analysis of ${short(sha)}`)

  const at = `analysis of ${short(sha)} on ${day(analysis.date)}`
  const out: Item[] = []
  try {
    const m = await measuresAt(project, analysis.date, get)
    if ('coverage' in m) {
      const cov = Number(m.coverage)
      out.push(item({ ...base, rule: 'sonar-coverage', status: cov >= threshold ? 'pass' : 'fail', value: `${m.coverage}%`, links,
        note: at, data: { coverage: cov, threshold } }, now))
    } else {
      out.push(item({ ...base, rule: 'sonar-coverage', status: 'unknown', value: 'no coverage', links, note: `${at} has no coverage figure` }, now))
    }
    if ('vulnerabilities' in m) {
      const v = Number(m.vulnerabilities)
      const h = Number(m.security_hotspots ?? 0)
      out.push(item({ ...base, rule: 'sonar-security', status: v === 0 ? 'pass' : 'fail',
        value: `${v} vulnerabilit${v === 1 ? 'y' : 'ies'}, ${h} security hotspot${h === 1 ? '' : 's'}`, links, note: at,
        data: { vulnerabilities: v, hotspots: h, rating: m.security_rating } }, now))
    } else {
      out.push(item({ ...base, rule: 'sonar-security', status: 'unknown', value: 'no vulnerability count', links,
        note: `${at} has no vulnerability figure` }, now))
    }
  } catch (e) {
    for (const rule of ['sonar-coverage', 'sonar-security']) {
      out.push(item({ ...base, rule, status: 'unknown', value: 'not checked', links, note: `measures could not be read: ${reason(e)}` }, now))
    }
  }

  try {
    const qg = await get(`${SONAR}/api/qualitygates/project_status?analysisId=${encodeURIComponent(analysis.key)}`) as
      { projectStatus: { status: string; conditions?: { metricKey: string; status: string }[] } }
    const s = qg.projectStatus.status
    const failed = (qg.projectStatus.conditions ?? []).filter((x) => x.status === 'ERROR').map((x) => x.metricKey)
    out.push(item({ ...base, rule: 'sonar-quality-gate', status: s === 'OK' ? 'pass' : s === 'ERROR' ? 'fail' : 'unknown',
      value: s === 'OK' ? 'passed' : s === 'ERROR' ? 'failed' : s, links, note: at, data: failed.length ? { failed } : undefined }, now))
  } catch (e) {
    out.push(item({ ...base, rule: 'sonar-quality-gate', status: 'unknown', value: 'not checked', links,
      note: `quality gate could not be read: ${reason(e)}` }, now))
  }
  return out
}
