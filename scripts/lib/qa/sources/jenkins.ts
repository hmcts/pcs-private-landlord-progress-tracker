// Jenkins, for a feature's E2E tests: the build a feature config names in repos.<repo>.e2e,
// usually a PR build run with the E2E labels, read through Jenkins's JSON API:
//
//   <job>/lastCompletedBuild/api/json (or <job>/<n>/api/json): the build, and the commit it built
//   <job>/<n>/testReport/api/json: each test's result, as the JUnit plugin keeps it
//
// The feature's tests are picked by Playwright tag or by spec path. A tag written in a title
// ("Private landlord makes a claim @privateLandlord › …") is in the case's name, but one given as
// test('…', { tag: '@x' }) is not: Playwright's JUnit reporter writes the title path as the name
// and only annotations as properties. So a case is also the feature's when its spec file is one
// the ignored-tests scan found carrying the tag (or under the paths), which keeps the E2E row and
// the ignored-tests row about the same tests. The case's className is its spec path relative to
// Playwright's testDir; it is matched to a repo path through the spec files of that scan. Playwright's JUnit report has one case per test,
// with its last attempt's result; a test that passed only on a retry still lists its earlier
// attempt's attachments, from a "-retry<n>/" results folder, in its stdout. That is how a flaky
// test is told apart: stdout is read for that and never kept. Not every E2E stage publishes its
// results: pcs-frontend's PR builds do (in "Functional Test - preview"), but pcs-api's
// "E2E Test - AKS preview" publishes only an HTML report, so its builds' reports hold no
// Playwright cases at all, and its E2E row fails saying so.
//
// The scan for ignored or pending tests (github.ts) is run again here over the feature's specs
// only, at the commit the E2E build ran.
//
// build.hmcts.net is reachable only on the VPN: off it, Azure App Proxy answers with a redirect
// to a sign-in page. That, a refused sign-in (401, 403), a network failure and missing
// credentials all make the rows unknown and unreachable, so a publish keeps what they say.
// Basic auth, with JENKINS_USERNAME (an Entra object id) and JENKINS_PASSWORD (an API token),
// the names cft-workspace's scripts/mcp-jenkins uses. JENKINS_URL overrides the host.

import type { E2eConfig, ReleaseConfig, RepoConfig } from '../config.ts'
import { QaError } from '../errors.ts'
import { isRec, mapLimit, SEGMENT, SHA, str } from '../util.ts'
import { HttpError, item, type Item, reason, short } from './common.ts'
import { repoFromGitUrl } from './cve.ts'
import { defaultTarball, type GitHubTarball, ignoredItem, type Scan, scanTarball } from './github.ts'

const SOURCE = 'jenkins'
export const JENKINS = 'https://build.hmcts.net'
export const E2E_RULES = ['e2e-feature', 'e2e-build', 'ignored-tests-feature']
/** Repos whose E2E builds are read at once. */
export const E2E_CONCURRENCY = 4

/** GET a Jenkins path (no host), returning parsed JSON. Injected in tests. */
export type JenkinsGet = (path: string) => Promise<unknown>

/** Why Jenkins couldn't be asked. */
export type UnreachableKind = 'config' | 'no-credentials' | 'network' | 'sign-in-redirect' | 'unauthorised' | 'not-json'

/** Jenkins couldn't be asked: off the VPN, signed out, or down. */
export class Unreachable extends Error {
  kind: UnreachableKind
  constructor(message: string, kind: UnreachableKind = 'network') {
    super(message)
    this.kind = kind
  }
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  let b = env.JENKINS_URL || JENKINS
  while (b.endsWith('/')) b = b.slice(0, -1)
  let url: URL
  try {
    url = new URL(b)
  } catch {
    throw new Unreachable('JENKINS_URL is not a URL', 'config')
  }
  if (url.protocol !== 'https:') throw new Unreachable('JENKINS_URL is not an https URL', 'config')
  return b
}

/** A Jenkins response as JSON, or why it can't be read: a redirect or a web page is the App Proxy's sign-in. */
export async function readJenkins(res: Response): Promise<unknown> {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Unreachable('Jenkins redirected to a sign-in page (off the VPN?)', 'sign-in-redirect')
  if (res.status === 401 || res.status === 403) throw new Unreachable(`Jenkins refused the sign-in (${res.status})`, 'unauthorised')
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Unreachable('Jenkins answered with a web page, not JSON (a sign-in page?)', 'not-json')
  try {
    return await res.json()
  } catch {
    throw new Unreachable('Jenkins answered with something that is not JSON', 'not-json')
  }
}

export function defaultJenkins(env: NodeJS.ProcessEnv = process.env): JenkinsGet {
  return async (path) => {
    const base = baseUrl(env)
    const user = env.JENKINS_USERNAME
    const pass = env.JENKINS_PASSWORD
    if (!user || !pass) throw new Unreachable('JENKINS_USERNAME and JENKINS_PASSWORD are not set', 'no-credentials')
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        headers: { accept: 'application/json', authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
        redirect: 'manual', signal: AbortSignal.timeout(60_000),
      })
    } catch {
      throw new Unreachable('Jenkins could not be reached')
    }
    return readJenkins(res)
  }
}

const isSegment = (s: string) => SEGMENT.test(s) && s !== '.' && s !== '..'

/**
 * /job/<folder>/job/<repo>/job/<branch>, every name checked and encoded. A multibranch job names
 * a branch's job by the branch URL-encoded (feature/x is the job feature%2Fx), and that name is
 * encoded again in its URL.
 */
export function jobPath(job: string, branch: string): string {
  const folders = job.split('/')
  if (!folders.every(isSegment) || !branch.split('/').every(isSegment)) throw new QaError('bad-argument', 'a Jenkins job is folder names and a branch only')
  return [...folders, encodeURIComponent(branch)].map((s) => `/job/${encodeURIComponent(s)}`).join('')
}

/** lastCompletedBuild, or a build number rebuilt from its value. */
export function buildRef(build: unknown): string {
  if (build === undefined || build === 'last-completed') return 'lastCompletedBuild'
  const n = typeof build === 'number' ? build : Number.NaN
  if (!Number.isSafeInteger(n) || n <= 0) throw new QaError('bad-argument', 'a Jenkins build is last-completed or a build number')
  return String(n)
}

const BUILD_TREE = 'number,result,building,url,actions[_class,revision[hash,pullHash],lastBuiltRevision[SHA1],remoteUrls]'
const REPORT_TREE = 'suites[cases[className,name,status,skipped,errorDetails,flakyFailures[message],rerunFailures[message],properties,stdout]]'

/**
 * The commit the build ran: a PR build's head (pullHash), else the branch revision Jenkins
 * recorded, else the git checkout of the repo itself. A build checks out its shared libraries
 * too, so a checkout counts only when its remote is the repo.
 */
export function revisionOf(build: unknown, github: string): string | null {
  const actions = isRec(build) && Array.isArray(build.actions) ? build.actions.filter(isRec) : []
  const sha = (v: unknown) => (typeof v === 'string' && SHA.test(v) ? v : null)
  for (const key of ['pullHash', 'hash']) {
    const hit = actions.map((a) => (isRec(a.revision) ? sha(a.revision[key]) : null)).find((x) => x)
    if (hit) return hit
  }
  const own = actions.find((a) => Array.isArray(a.remoteUrls) && a.remoteUrls.some((u) => repoFromGitUrl(u) === github.toLowerCase()))
  return own && isRec(own.lastBuiltRevision) ? sha(own.lastBuiltRevision.SHA1) : null
}

/** Whether a test title carries the tag, as a whole tag (@enforcement, not @enforcementWales). */
export function hasTag(text: string, tag: string): boolean {
  for (let at = text.indexOf(tag); at >= 0; at = text.indexOf(tag, at + 1)) {
    const next = text.charAt(at + tag.length)
    if (!next || !/[\w-]/.test(next)) return true
  }
  return false
}

const trimSlash = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p)

/** The repo path of a case's spec file: the one spec file whose path ends with its className. */
export function repoPathOf(className: string, specs: string[]): string | null {
  const hits = specs.filter((s) => s === className || s.endsWith(`/${className}`))
  return hits.length === 1 ? hits[0] : null
}

/**
 * Whether a case's className, relative to Playwright's testDir, is under a repo-relative path. With
 * the repo's spec files, the className is mapped to its repo path, so the path may be a spec file,
 * a folder inside testDir, testDir itself or a folder above it. Without them, only some tail of the
 * path, from a folder boundary, can be matched: the className itself or a folder it is in.
 */
export function underPath(className: string, path: string, specs?: string[]): boolean {
  const full = specs ? repoPathOf(className, specs) : null
  if (full) {
    const p = trimSlash(path)
    return full === p || full.startsWith(`${p}/`)
  }
  const parts = trimSlash(path).split('/')
  for (let n = 0; n < parts.length; n++) {
    const tail = parts.slice(n).join('/')
    if (className === tail || className.startsWith(`${tail}/`)) return true
  }
  return false
}

export type Outcome = 'passed' | 'failed' | 'flaky' | 'skipped'

const RETRY = /-retry\d+\//
const nonEmptyList = (v: unknown) => Array.isArray(v) && v.length > 0

export function outcome(c: Record<string, unknown>): Outcome {
  const status = str(c.status).toUpperCase()
  if (c.skipped === true || status === 'SKIPPED') return 'skipped'
  if (status !== 'PASSED' && status !== 'FIXED') return 'failed'
  const stdout = str(c.stdout)
  const retried = nonEmptyList(c.flakyFailures) || nonEmptyList(c.rerunFailures) || (stdout.includes('[[ATTACHMENT|') && RETRY.test(stdout))
  return retried ? 'flaky' : 'passed'
}

export interface E2eCase {
  className: string
  name: string
  outcome: Outcome
  error?: string
}

/** Whether one of the case's JUnit properties names the tag. */
const propsHaveTag = (props: unknown, tag: string) => isRec(props) && Object.entries(props).some(([k, v]) => hasTag(k, tag) || hasTag(str(v), tag))

const allCases = (report: unknown) => {
  const suites = isRec(report) && Array.isArray(report.suites) ? report.suites.filter(isRec) : []
  return suites.flatMap((s) => (Array.isArray(s.cases) ? s.cases.filter(isRec) : []))
}

const SCRIPT = /\.[cm]?[jt]sx?$/

/** Whether a report holds any Playwright results: a case whose className is a script file, not a Java class. */
export const hasPlaywright = (report: unknown): boolean => allCases(report).some((c) => SCRIPT.test(str(c.className)))

/**
 * The report's cases that are the feature's: by tag in the title or a property, by spec path, or
 * because their spec file is one the scan found in scope (scan.scoped). Without a scan, only the
 * first two.
 */
export function featureCases(report: unknown, e2e: E2eConfig, scan?: Scan): E2eCase[] {
  const tags = e2e.tags ?? []
  const scoped = new Set(scan?.scoped ?? [])
  const picked = (c: Record<string, unknown>) => {
    const className = str(c.className)
    if (tags.some((t) => hasTag(str(c.name), t) || propsHaveTag(c.properties, t))) return true
    if ((e2e.paths ?? []).some((p) => underPath(className, p, scan?.specs))) return true
    const full = scan?.specs ? repoPathOf(className, scan.specs) : null
    return !!full && scoped.has(full)
  }
  return allCases(report).filter(picked)
    .map((c) => {
      const o = outcome(c)
      const out: E2eCase = { className: str(c.className), name: str(c.name), outcome: o }
      if (o === 'failed' && str(c.errorDetails)) out.error = str(c.errorDetails).slice(0, 500)
      return out
    })
}

/** Which spec files the feature's ignored-tests scan covers: under its paths, or carrying one of its tags. */
export function specScope(e2e: E2eConfig): (path: string, text: string) => boolean {
  const paths = (e2e.paths ?? []).map(trimSlash)
  return (path, text) => paths.some((p) => path === p || path.startsWith(`${p}/`)) || (e2e.tags ?? []).some((t) => hasTag(text, t))
}

type Now = (() => Date) | undefined

/** The feature's spec files at the E2E build's commit, and the ignored-tests finding for them. */
async function scopedScan(repo: string, rc: RepoConfig, e2e: E2eConfig, sha: string | null, tarball: GitHubTarball, now: Now): Promise<{ item: Item; scan?: Scan }> {
  const rule = 'ignored-tests-feature'
  const base = { source: 'github', rule, repo, sha, status: 'unknown' as const, value: 'not checked' }
  if (!sha) return { item: item({ ...base, note: 'Jenkins did not record the commit the E2E build ran' }, now) }
  try {
    const scan = scanTarball(await tarball(rc.github, sha), rc.test_paths, specScope(e2e))
    if (!scan.files) return { scan, item: item({ ...base, note: `no spec file at ${short(sha)} matches the feature's tags or paths` }, now) }
    return { scan, item: ignoredItem(repo, rc.github, sha, null, scan, now, rule) }
  } catch (e) {
    return { item: item({ ...base, note: `the source at ${short(sha)} could not be read: ${reason(e)}`, unreachable: true }, now) }
  }
}

function resultItem(repo: string, label: string, sha: string | null, report: unknown, e2e: E2eConfig, scan: Scan | undefined,
  links: Item['links'], now: Now): Item {
  const cases = featureCases(report, e2e, scan)
  const n = (o: Outcome) => cases.filter((c) => c.outcome === o).length
  const counts = { passed: n('passed'), failed: n('failed'), flaky: n('flaky'), skipped: n('skipped') }
  const ran = counts.passed + counts.flaky
  const none = hasPlaywright(report) ? `no test in ${label} matches the feature's tags or paths: the scope is misconfigured, or the suite did not run`
    : `the test results of ${label} hold no Playwright tests: its E2E stage did not run, or does not publish JUnit results`
  const note = !cases.length ? none
    : !counts.failed && !ran ? `every one of the feature's tests was skipped in ${label}` : label
  return item({ source: SOURCE, rule: 'e2e-feature', repo, sha, status: counts.failed || !ran ? 'fail' : 'pass',
    value: `${cases.length} of the feature's tests: ${counts.passed} passed, ${counts.failed} failed, ${counts.flaky} flaky, ${counts.skipped} skipped`,
    links, note, data: { counts, failures: cases.filter((c) => c.outcome === 'failed').slice(0, 50), flaky: cases.filter((c) => c.outcome === 'flaky').map((c) => c.name) } }, now)
}

async function one(repo: string, rc: RepoConfig, e2e: E2eConfig, get: JenkinsGet, tarball: GitHubTarball, now: Now): Promise<Item[]> {
  const { job, branch } = e2e.jenkins
  const path = jobPath(job, branch)
  const unknown = (note: string, unreachable: boolean) => E2E_RULES.map((rule) =>
    item({ source: rule === 'ignored-tests-feature' ? 'github' : SOURCE, rule, repo, status: 'unknown', value: 'not checked', note, unreachable }, now))
  let build: Record<string, unknown>
  try {
    const b = await get(`${path}/${buildRef(e2e.jenkins.build)}/api/json?tree=${BUILD_TREE}`)
    build = isRec(b) ? b : {}
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return [item({ source: SOURCE, rule: 'e2e-feature', repo, status: 'fail', value: 'no build', note: `Jenkins has no such job or build (${branch})` }, now),
        ...unknown(`Jenkins has no such job or build (${branch})`, false).slice(1)]
    }
    return unknown(`Jenkins could not be read: ${reason(e)}`, e instanceof Unreachable || !(e instanceof QaError))
  }
  const number = Number(build.number)
  if (!Number.isSafeInteger(number) || number <= 0) return unknown('Jenkins did not say which build it is', false)
  const label = `${branch} #${number}`
  if (build.building === true) return unknown(`${label} is still running`, false)
  const sha = revisionOf(build, rc.github)
  const url = str(build.url)
  const links = url.startsWith('https://') ? [{ text: `${repo} ${label}`, url }] : []
  const result = str(build.result)
  const header = item({ source: SOURCE, rule: 'e2e-build', repo, sha, status: 'pass', links,
    value: `${repo}: ${label}${sha ? ` at ${short(sha)}` : ''}${result ? `, ${result.toLowerCase()}` : ''}`, data: { job, branch, number, result, sha } }, now)

  const specs = await scopedScan(repo, rc, e2e, sha, tarball, now)
  let e2eItem: Item
  try {
    const report = await get(`${path}/${number}/testReport/api/json?tree=${REPORT_TREE}`)
    e2eItem = resultItem(repo, label, sha, report, e2e, specs.scan, links, now)
  } catch (e) {
    e2eItem = e instanceof HttpError && e.status === 404
      ? item({ source: SOURCE, rule: 'e2e-feature', repo, sha, status: 'fail', value: 'no test results', links, note: `${label} published no test results: the E2E suite did not run` }, now)
      : item({ source: SOURCE, rule: 'e2e-feature', repo, sha, status: 'unknown', value: 'not checked', links,
        note: `the test results of ${label} could not be read: ${reason(e)}`, unreachable: true }, now)
  }
  return [e2eItem, header, specs.item]
}

export function jenkinsReader(cfg: ReleaseConfig, get: JenkinsGet = defaultJenkins(), tarball: GitHubTarball = defaultTarball(),
  now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const repos = Object.entries(cfg.repos).filter(([, rc]) => rc.e2e)
    if (!repos.length) {
      return E2E_RULES.map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note: 'no repo has an E2E build configured' }, now))
    }
    return (await mapLimit(repos, E2E_CONCURRENCY, ([repo, rc]) => one(repo, rc, rc.e2e!, get, tarball, now))).flat()
  }
}

export type Reachability = 'reachable' | UnreachableKind | 'error'

/** Whether Jenkins can be read with the configured credentials, judged exactly as the reader judges it. */
export async function reachability(get: JenkinsGet = defaultJenkins()): Promise<Reachability> {
  try {
    await get('/api/json?tree=mode')
    return 'reachable'
  } catch (e) {
    return e instanceof Unreachable ? e.kind : 'error'
  }
}
