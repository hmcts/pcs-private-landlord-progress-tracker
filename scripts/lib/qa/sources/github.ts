// GitHub, for the candidate commits (the repos are public):
//
// - check runs and statuses on the commit. Jenkins reports each stage as a check run, and
//   GitHub Actions runs pcs-api's integration tests, so these answer the build rows when Cosmos
//   can't, and add the GitHub Actions results when it can.
// - the ignored or pending tests scan: the commit's source tarball, read in memory, searched for
//   JUnit's @Disabled and @Ignore, and the skip, pending and fix-me markers of the Node test runners.
//
// Uses GITHUB_TOKEN when set (CI), else `gh api` when it's installed, else anonymous requests.

import { gunzipSync } from 'node:zlib'
import type { Candidate, ReleaseConfig } from '../config.ts'
import { mapLimit, runCommand } from '../util.ts'
import { HttpError, item, type Item, reason, short } from './common.ts'

const SOURCE = 'github'

/** GET a GitHub REST path (no host), returning parsed JSON. Injected in tests. */
export type GitHubApi = (path: string) => Promise<unknown>
/** The gzipped tarball of a repo at a commit. Injected in tests. */
export type GitHubTarball = (repo: string, sha: string) => Promise<Buffer>

let gh: Promise<boolean> | undefined
const hasGh = () => (gh ??= runCommand('gh', ['--version']).then(() => true, () => false))

export function defaultGitHubApi(env: NodeJS.ProcessEnv = process.env): GitHubApi {
  return async (path) => {
    if (!env.GITHUB_TOKEN && await hasGh()) return JSON.parse(await runCommand('gh', ['api', path], { maxBuffer: 64 * 1024 * 1024 }))
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`
    const res = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, { headers, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
    return res.json()
  }
}

export function defaultTarball(env: NodeJS.ProcessEnv = process.env): GitHubTarball {
  return async (repo, sha) => {
    const headers: Record<string, string> = {}
    if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`
    const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { headers, signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}

// ------------------------------------------------------------------ check runs

interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  completed_at?: string | null
  details_url?: string | null
  html_url?: string | null
}

/** Which check runs answer which rule, by name. */
export const CHECK_RULES: Record<string, RegExp> = {
  'integration-contract': /integration tests|cftlib tests|pact consumer|pact provider|contract test/i,
  functional: /functional test - aat|smoke test - aks aat|jenkins - nightly|e2e test|cross ?browser/i,
  'deployed-aat': /smoke test - aks aat|functional test - aat/i,
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])

export async function checkRuns(api: GitHubApi, repo: string, sha: string): Promise<CheckRun[]> {
  const out: CheckRun[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await api(`repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`) as { total_count: number; check_runs: CheckRun[] }
    out.push(...res.check_runs)
    if (out.length >= res.total_count || res.check_runs.length === 0) break
  }
  return out
}

/** A re-run adds a check run with the same name; the newest is the one that counts. */
export function latestRuns(runs: CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>()
  for (const r of runs) if (!latest.has(r.name) || latest.get(r.name)!.id < r.id) latest.set(r.name, r)
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function checkItems(repo: string, sha: string, c: Candidate, runs: CheckRun[], now?: () => Date): Item[] {
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  const out: Item[] = []
  for (const [rule, re] of Object.entries(CHECK_RULES)) {
    const hits = latestRuns(runs).filter((r) => re.test(r.name) && r.conclusion !== 'skipped' && r.conclusion !== 'neutral')
    if (!hits.length) {
      out.push(item({ ...base, rule, status: 'unknown', value: 'no check', note: `no matching GitHub check on ${short(sha)}` }, now))
      continue
    }
    const fail = hits.some((r) => r.conclusion && FAILED.has(r.conclusion))
    const pending = hits.some((r) => r.status !== 'completed' || !r.conclusion)
    const links: { text: string; url: string }[] = []
    for (const r of hits) {
      const url = r.details_url || r.html_url
      if (url && !links.some((l) => l.url === url)) links.push({ text: `${repo}: ${r.name}`, url })
    }
    out.push(item({ ...base, rule, status: fail ? 'fail' : pending ? 'unknown' : 'pass',
      value: hits.map((r) => `${r.name}: ${r.conclusion ?? r.status}`).join('; '), links,
      note: pending && !fail ? 'some checks had not finished' : undefined }, now))
  }
  return out
}

// ------------------------------------------------------------------ ignored tests

/** Directory names Gradle and Node projects keep tests in, and test file names. */
export const DEFAULT_TEST_PATHS = String.raw`(^|/)(test|tests|spec|specs|e2e|__tests__|[a-z0-9]+Tests?)/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.(java|kt)$`

const SCANNED = /\.(java|kt|groovy|[cm]?[jt]sx?|feature)$/

interface Pattern {
  kind: string
  re: RegExp
  files: RegExp
}

export const PATTERNS: Pattern[] = [
  { kind: '@Disabled', re: /^\s*@Disabled(If\w*)?\b/, files: /\.(java|kt|groovy)$/ },
  { kind: '@Ignore', re: /^\s*@Ignore\b/, files: /\.(java|kt|groovy)$/ },
  { kind: 'skip', re: /\b(test|it|describe|context|suite)(\.describe)?(\.(serial|parallel))?\.skip\s*\(/, files: /\.[cm]?[jt]sx?$/ },
  { kind: 'fixme', re: /\b(test|it|describe)(\.describe)?\.fixme\s*\(/, files: /\.[cm]?[jt]sx?$/ },
  { kind: 'todo', re: /\b(test|it)\.todo\s*\(/, files: /\.[cm]?[jt]sx?$/ },
  { kind: 'xit', re: /(^|[^\w.])(xit|xdescribe|xtest|xcontext)\s*\(/, files: /\.[cm]?[jt]sx?$/ },
  { kind: '@ignore tag', re: /^\s*@(ignore|skip|wip|pending)\b/i, files: /\.feature$/ },
]

export interface Finding {
  path: string
  line: number
  kind: string
  /** test.skip(condition, …) inside a test or hook skips at run time, depending on the condition. */
  conditional?: boolean
}

const UNCONDITIONAL = /\.(skip|fixme)\s*\(\s*(['"`)]|$)/

const untilNul = (s: string) => {
  const n = s.indexOf('\0')
  return n < 0 ? s : s.slice(0, n)
}

/** The path record of a pax header: lines of "<length> <key>=<value>". */
function paxPath(records: string): string | null {
  for (const line of records.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp > 0 && line.startsWith('path=', sp + 1)) return line.slice(sp + 6)
  }
  return null
}

/** Entries of a ustar/pax tarball, as GitHub's codeload serves them. */
export function* untar(tar: Buffer): Generator<{ path: string; body: Buffer }> {
  let off = 0
  let longName: string | null = null
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return
    const str = (a: number, n: number) => untilNul(h.subarray(a, a + n).toString('utf8'))
    const size = Number.parseInt(str(124, 12).trim() || '0', 8)
    const type = String.fromCodePoint(h[156] || 48)
    const body = tar.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const path = paxPath(body.toString('utf8'))
      if (path !== null) longName = path
      continue
    }
    if (type === 'L') {
      longName = untilNul(body.toString('utf8'))
      continue
    }
    if (type === 'g') continue
    const prefix = str(345, 155)
    const path = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100))
    longName = null
    if (type === '0') yield { path, body }
  }
}

/** Picks the files a scan covers, from a repo-relative path and the file's text. */
export type ScanScope = (path: string, text: string) => boolean

/** The test files under `testPaths` (a regex over repo-relative paths), or those `scope` picks. */
export function scanTarball(gz: Buffer, testPaths = DEFAULT_TEST_PATHS, scope?: ScanScope): { files: number; findings: Finding[] } {
  const isTest = new RegExp(testPaths)
  const findings: Finding[] = []
  let files = 0
  for (const e of untar(gunzipSync(gz))) {
    const path = e.path.replace(/^[^/]+\//, '') // codeload puts everything under <owner>-<repo>-<sha>/
    if (!SCANNED.test(path) || path.includes('node_modules/') || (!scope && !isTest.test(path))) continue
    const body = e.body.toString('utf8')
    if (scope && !scope(path, body)) continue
    files++
    const pats = PATTERNS.filter((p) => p.files.test(path))
    body.split('\n').forEach((text, n) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(text) && !path.endsWith('.feature')) return
      for (const p of pats) {
        if (!p.re.test(text)) continue
        const f: Finding = { path, line: n + 1, kind: p.kind }
        if ((p.kind === 'skip' || p.kind === 'fixme') && !UNCONDITIONAL.test(text)) f.conditional = true
        findings.push(f)
      }
    })
  }
  return { files, findings }
}

/** The ignored-tests finding for a scan; `c` is null for a scan that belongs to no candidate (a feature's E2E specs). */
export function ignoredItem(repo: string, gh: string, sha: string, c: Candidate | null, scan: { files: number; findings: Finding[] },
  now?: () => Date, rule = 'ignored-tests'): Item {
  const fixed = scan.findings.filter((f) => !f.conditional)
  const kinds = new Map<string, number>()
  for (const f of fixed) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1)
  const n = fixed.length
  const cond = scan.findings.length - n
  const value = (n ? `${n} ignored or pending (${[...kinds].map(([k, v]) => `${k} ×${v}`).join(', ')}) in ${new Set(fixed.map((f) => f.path)).size} files`
    : `none in ${scan.files} test files`) + (cond ? `, and ${cond} skipped at run time by a condition` : '')
  return item({ source: SOURCE, sha, repo, candidate: c?.name, rule, status: n ? 'fail' : 'pass', answer: n || cond ? 'Yes' : 'No', value,
    links: [...fixed, ...scan.findings.filter((f) => f.conditional)].slice(0, 10).map((f) => ({ text: `${f.path.split('/').pop()}:${f.line}`, url: `https://github.com/${gh}/blob/${sha}/${f.path}#L${f.line}` })),
    data: { files: scan.files, findings: scan.findings } }, now)
}

/** Candidate commits read at once. GitHub's API and codeload both throttle bursts. */
export const GITHUB_CONCURRENCY = 4

export function githubReader(cfg: ReleaseConfig, api: GitHubApi = defaultGitHubApi(), tarball: GitHubTarball = defaultTarball(),
  now?: () => Date): () => Promise<Item[]> {
  return async () => {
    // A repo unchanged between candidates has the same commit in each: read it once.
    const runs = new Map<string, Promise<CheckRun[]>>()
    const scans = new Map<string, Promise<ReturnType<typeof scanTarball>>>()
    const once = <T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>) => {
      if (!m.has(k)) m.set(k, f())
      return m.get(k)!
    }
    const one = async ([c, repo, sha]: [Candidate, string, string]): Promise<Item[]> => {
      const gh = cfg.repos[repo].github
      const k = `${gh}@${sha}`
      const unknown = (rule: string, note: string) => item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked', note, unreachable: true }, now)
      const checks = once(runs, k, () => checkRuns(api, gh, sha)).then((r) => checkItems(repo, sha, c, r, now),
        (e) => Object.keys(CHECK_RULES).map((rule) => unknown(rule, `GitHub checks could not be read: ${reason(e)}`)))
      const ignored = once(scans, k, async () => scanTarball(await tarball(gh, sha), cfg.repos[repo].test_paths)).then(
        (scan) => ignoredItem(repo, gh, sha, c, scan, now), (e) => unknown('ignored-tests', `the source at ${short(sha)} could not be read: ${reason(e)}`))
      return [...await checks, await ignored]
    }
    const pairs = cfg.candidates.flatMap((c) => Object.entries(c.shas).map(([repo, sha]) => [c, repo, sha] as [Candidate, string, string]))
    return (await mapLimit(pairs, GITHUB_CONCURRENCY, one)).flat()
  }
}

// ------------------------------------------------------------------ latest finished build

export const SHA_RE = /^[0-9a-f]{40}$/

/** How far back from the branch head to look for a commit whose Jenkins build has finished. */
export const LOOKBACK = 30

const JENKINS_STATUS = 'continuous-integration/jenkins/'

/**
 * The newest commit on `branch` whose Jenkins build has finished, passed or failed: the
 * commit status Jenkins sets for the whole build (continuous-integration/jenkins/branch) is
 * anything but pending. Null when none of the last LOOKBACK commits has one.
 */
export async function latestFinished(api: GitHubApi, gh: string, branch: string): Promise<{ sha: string; date?: string } | null> {
  const commits = await api(`repos/${gh}/commits?sha=${encodeURIComponent(branch)}&per_page=${LOOKBACK}`) as
    { sha?: unknown; commit?: { committer?: { date?: string } } }[]
  for (const c of Array.isArray(commits) ? commits : []) {
    const sha = typeof c.sha === 'string' && SHA_RE.test(c.sha) ? c.sha : null
    if (!sha) continue
    const st = await api(`repos/${gh}/commits/${sha}/status`) as { statuses?: { context?: string; state?: string }[] }
    const jenkins = (st.statuses ?? []).filter((x) => typeof x.context === 'string' && x.context.startsWith(JENKINS_STATUS))
    if (jenkins.some((x) => x.state && x.state !== 'pending')) return { sha, date: c.commit?.committer?.date }
  }
  return null
}
