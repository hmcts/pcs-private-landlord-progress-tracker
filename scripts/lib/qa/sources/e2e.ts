// A feature's E2E rows, for the Jenkins build its config names in repos.<repo>.e2e: usually a PR
// build run with the E2E labels, the latest finished one or a given build number.
//
// - Cosmos pipeline-metrics: the branch's builds, read as cosmos.ts reads master builds (finished
//   builds only, from both databases, with the same rule for which stage failed). The E2E row is
//   the outcome of the build's E2E stages: cnp-jenkins-library's functionalTest:<env> (a PR
//   build's default, where pcs-frontend's Playwright suite runs), fullFunctionalTest:<env> (the
//   enable_full_functional_tests label, and nightly) and E2eTest:<env> (the enable_e2e_test
//   label, and nightly), all :preview on a PR. A build that finished without one fails the row.
//   Cosmos keeps no per-test results, so the row says which stages passed, not which tests.
// - When Cosmos can't be read, or has no finished build of the branch: the Jenkins status on the
//   head commit of the PR (continuous-integration/jenkins/pr-head) or branch, which is the whole
//   build's result only. Its target URL names the build, so a configured build number is checked
//   against it.
//
// The scan for ignored or pending tests (github.ts) is run again over the feature's specs only,
// at the commit the build ran (Cosmos's git_commit), or else the head commit.

import type { E2eConfig, ReleaseConfig, RepoConfig } from '../config.ts'
import { mapLimit, SHA, str } from '../util.ts'
import { item, type Item, reason, short } from './common.ts'
import { type Build, BRANCH_QUERY, byBuild, completedBuild, type CosmosQuery, defaultCosmosQuery, everywhere, type StageEvent } from './cosmos.ts'
import { BRANCH_STATUS, defaultGitHubApi, defaultTarball, type GitHubApi, type GitHubTarball, ignoredItem, type Scan, scanTarball } from './github.ts'

const SOURCE = 'e2e'
export const E2E_RULES = ['e2e-feature', 'e2e-build', 'ignored-tests-feature']
/** Repos whose E2E builds are read at once. */
export const E2E_CONCURRENCY = 4

/** The stages that run a repo's E2E or functional tests against a deployment. */
export const E2E_STAGE = /^(functionalTest|fullFunctionalTest|E2eTest)(:[\w-]+)?$/

/** The status Jenkins sets on a PR build's head commit. */
export const PR_STATUS = 'continuous-integration/jenkins/pr-head'

export interface Deps {
  cosmos: CosmosQuery
  api: GitHubApi
  tarball: GitHubTarball
  now?: () => Date
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

/** Which spec files the feature's ignored-tests scan covers: under its paths, or carrying one of its tags. */
export function specScope(e2e: E2eConfig): (path: string, text: string) => boolean {
  const paths = (e2e.paths ?? []).map(trimSlash)
  return (path, text) => paths.some((p) => path === p || path.startsWith(`${p}/`)) || (e2e.tags ?? []).some((t) => hasTag(text, t))
}

/** The PR number of a PR-<n> branch, else null. */
export function prNumber(branch: string): number | null {
  if (!branch.startsWith('PR-')) return null
  const digits = branch.slice(3)
  const n = Number.parseInt(digits, 10)
  return Number.isSafeInteger(n) && n > 0 && String(n) === digits ? n : null
}

/** The configured build number, or null for the latest finished build. */
export function wantedBuild(build: E2eConfig['jenkins']['build']): number | null {
  const n = typeof build === 'number' ? build : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The build number in a Jenkins build URL: the path segment after the branch's job. */
export function buildNumberOf(url: string, branch: string): number | null {
  let parts: string[]
  try {
    parts = new URL(url).pathname.split('/')
  } catch {
    return null
  }
  // A multibranch job is named by the branch URL-encoded, and that name is encoded again in its URL.
  const at = parts.indexOf(encodeURIComponent(encodeURIComponent(branch)))
  const digits = at >= 0 ? (parts[at + 1] ?? '') : ''
  const n = Number.parseInt(digits, 10)
  return Number.isSafeInteger(n) && n > 0 && String(n) === digits ? n : null
}

type CosmosFind =
  | { kind: 'found'; build: Build }
  | { kind: 'pending'; number: number; sha: string }
  | { kind: 'missing' | 'unset' | 'down'; note: string }

/** The configured build in Cosmos: found, not finished, or not there and why. */
async function fromCosmos(query: CosmosQuery, rc: RepoConfig, branch: string, wanted: number | null): Promise<CosmosFind> {
  if (!rc.cosmos_product) return { kind: 'unset', note: 'no Jenkins product and component are configured for the repo' }
  let events: StageEvent[]
  try {
    events = await everywhere(query, 'pipeline-metrics', BRANCH_QUERY, [{ name: '@b', value: branch },
      { name: '@p', value: rc.cosmos_product }, { name: '@c', value: rc.cosmos_component }]) as StageEvent[]
  } catch (e) {
    return { kind: 'down', note: `Cosmos pipeline-metrics could not be read: ${reason(e)}` }
  }
  const groups = byBuild(events.filter((e) => e.branch_name === branch && !e.job_name.split('/')[0].endsWith('_Nightly')))
  if (wanted !== null) {
    const ev = groups.find((g) => Number(g[0].build_number) === wanted)
    if (!ev) return { kind: 'missing', note: `Cosmos records no build #${wanted} of ${branch}` }
    const build = completedBuild(ev)
    return build ? { kind: 'found', build } : { kind: 'pending', number: wanted, sha: str(ev.find((e) => e.git_commit)?.git_commit) }
  }
  const builds = groups.map(completedBuild).filter((b): b is Build => !!b).sort((a, b) => b.number - a.number)
  return builds.length ? { kind: 'found', build: builds[0] } : { kind: 'missing', note: `Cosmos records no finished build of ${branch}` }
}

interface Head {
  sha: string
  pr: number | null
  /** The Jenkins status on the head commit, if it has one. */
  state?: string
  url?: string
  number?: number | null
}

/** The head commit of the branch (a PR's head, for PR-<n>) and its Jenkins status. */
async function fromGitHub(api: GitHubApi, gh: string, branch: string): Promise<Head | null> {
  const pr = prNumber(branch)
  const res = await api(pr === null ? `repos/${gh}/commits/${encodeURIComponent(branch)}` : `repos/${gh}/pulls/${String(pr)}`) as
    { sha?: unknown; head?: { sha?: unknown } }
  const sha = str(pr === null ? res?.sha : res?.head?.sha)
  if (!SHA.test(sha)) return null
  const st = await api(`repos/${gh}/commits/${sha}/status?per_page=100`) as { statuses?: { context?: unknown; state?: unknown; target_url?: unknown }[] }
  const context = pr === null ? BRANCH_STATUS : PR_STATUS
  const hit = (Array.isArray(st?.statuses) ? st.statuses : []).find((s) => s?.context === context)
  if (!hit) return { sha, pr }
  const url = str(hit.target_url)
  return { sha, pr, state: str(hit.state), url: url.startsWith('https://') ? url : undefined, number: buildNumberOf(url, branch) }
}

const outcomeOf = (s: 'pass' | 'fail' | undefined) => (s === 'pass' ? 'passed' : s === 'fail' ? 'failed' : 'outcome not recorded')

/** The E2E row from a finished build's stages. */
function stageItem(repo: string, branch: string, b: Build, links: Item['links'], now?: () => Date): Item {
  const label = `${branch} #${b.number}`
  const sha = SHA.test(b.sha) ? b.sha : null
  const base = { source: SOURCE, rule: 'e2e-feature', repo, sha, links }
  const names = b.ran.filter((n) => E2E_STAGE.test(n))
  const data = { from: 'cosmos', branch, number: b.number, outcome: b.outcome, stages: Object.fromEntries(names.map((n) => [n, b.stages.get(n) ?? 'unknown'])) }
  if (!names.length) {
    const why = b.outcome === 'FAILURE' && b.suspects.length ? `the build failed at ${b.suspects.join(' or ')} first` : 'the E2E labels were not set'
    return item({ ...base, status: 'fail', value: `${label}: no E2E stage ran`, data,
      note: `${label} finished without running an E2E or functional stage: ${why}` }, now)
  }
  const results = names.map((n) => [n, b.stages.get(n)] as const)
  const failed = results.filter(([, s]) => s === 'fail')
  const status = failed.length ? 'fail' : results.some(([, s]) => !s) ? 'unknown' : 'pass'
  const notes = ['the stage outcome only: Cosmos keeps no per-test results']
  if (failed.length && b.suspects.length > 1 && failed.some(([n]) => b.suspects.includes(n))) notes.unshift(`Jenkins can't tell whether ${b.suspects.join(' or ')} failed`)
  if (status === 'unknown') notes.unshift('an E2E stage ran after the stage that failed, so its outcome is not recorded')
  return item({ ...base, status, value: `${label}: ${results.map(([n, s]) => `${n} ${outcomeOf(s)}`).join(', ')}`, note: notes.join('; '), data }, now)
}

/**
 * The E2E row from the head commit's Jenkins status: the whole build's result. With no status,
 * a build Cosmos doesn't have is absent, and one it couldn't be asked about is unknown.
 */
function statusItem(repo: string, branch: string, head: Head, wanted: number | null, cosmos: { kind: string; note: string }, now?: () => Date): Item {
  const at = head.pr === null ? `the ${branch} head` : 'the PR head'
  const why = cosmos.note
  const base = { source: SOURCE, rule: 'e2e-feature', repo, sha: head.sha }
  const unknown = (note: string) => item({ ...base, status: 'unknown', value: 'not checked', note, unreachable: cosmos.kind === 'down' }, now)
  if (!head.state && cosmos.kind === 'missing') return item({ ...base, status: 'fail', value: 'no build', note: `${why}, and ${at} has no Jenkins status` }, now)
  if (!head.state) return unknown(`${why}, and ${at} has no Jenkins status`)
  if (wanted !== null && head.number !== wanted) return unknown(`${why}, and the Jenkins status on ${at} is not for build #${wanted}`)
  const build = head.number ? `${branch} #${head.number}` : branch
  const links = head.url ? [{ text: `${repo} ${build}`, url: head.url }] : []
  const note = `GitHub's Jenkins status on ${at}: the whole build's result, not the E2E stage's (${why})`
  const data = { from: 'github', branch, number: head.number ?? null, state: head.state }
  if (head.state === 'success') return item({ ...base, status: 'pass', value: `${build}: the build passed`, links, note, data }, now)
  if (head.state === 'failure' || head.state === 'error') return item({ ...base, status: 'fail', value: `${build}: the build failed`, links, note, data }, now)
  return item({ ...base, status: 'unknown', value: `${build}: still running`, links, note, data }, now)
}

/** The feature's spec files at the E2E build's commit, and the ignored-tests finding for them. */
async function scopedScan(repo: string, rc: RepoConfig, e2e: E2eConfig, sha: string | null, tarball: GitHubTarball, unreachable: boolean,
  now?: () => Date): Promise<Item> {
  const rule = 'ignored-tests-feature'
  const base = { source: 'github', rule, repo, sha, status: 'unknown' as const, value: 'not checked' }
  if (!sha) return item({ ...base, note: 'neither Cosmos nor GitHub said which commit the E2E build ran', unreachable }, now)
  let scan: Scan
  try {
    scan = scanTarball(await tarball(rc.github, sha), rc.test_paths, specScope(e2e))
  } catch (e) {
    return item({ ...base, note: `the source at ${short(sha)} could not be read: ${reason(e)}`, unreachable: true }, now)
  }
  if (!scan.files) return item({ ...base, note: `no spec file at ${short(sha)} matches the feature's tags or paths` }, now)
  return ignoredItem(repo, rc.github, sha, null, scan, now, rule)
}

async function one(repo: string, rc: RepoConfig, e2e: E2eConfig, d: Deps): Promise<Item[]> {
  const { branch } = e2e.jenkins
  const wanted = wantedBuild(e2e.jenkins.build)
  const header = (a: Omit<Parameters<typeof item>[0], 'source' | 'rule' | 'repo'>) => item({ source: SOURCE, rule: 'e2e-build', repo, ...a }, d.now)
  const found = await fromCosmos(d.cosmos, rc, branch, wanted)

  if (found.kind === 'found') {
    const b = found.build
    const label = `${branch} #${b.number}`
    const links = b.url.startsWith('https://') ? [{ text: `${repo} ${label}`, url: b.url }] : []
    let sha = SHA.test(b.sha) ? b.sha : null
    let away = false
    if (!sha) {
      try {
        sha = (await fromGitHub(d.api, rc.github, branch))?.sha ?? null
      } catch {
        away = true
      }
    }
    return [stageItem(repo, branch, b, links, d.now),
      header({ sha, status: 'pass', links, value: `${repo}: ${label}${SHA.test(b.sha) ? ` at ${short(b.sha)}` : ''}, ${b.outcome.toLowerCase()}`,
        data: { from: 'cosmos', branch, number: b.number, outcome: b.outcome, sha } }),
      await scopedScan(repo, rc, e2e, sha, d.tarball, away, d.now)]
  }

  if (found.kind === 'pending') {
    const note = `${branch} #${found.number} has not finished, or was aborted`
    const sha = SHA.test(found.sha) ? found.sha : null
    return [item({ source: SOURCE, rule: 'e2e-feature', repo, sha, status: 'unknown', value: 'not checked', note }, d.now),
      header({ sha, status: 'unknown', value: 'not checked', note }), await scopedScan(repo, rc, e2e, sha, d.tarball, false, d.now)]
  }

  // Cosmos has no answer: the configured build isn't there, or Cosmos can't be read.
  const unknown = (note: string, unreachable: boolean) => E2E_RULES.map((rule) =>
    item({ source: rule === 'ignored-tests-feature' ? 'github' : SOURCE, rule, repo, status: 'unknown', value: 'not checked', note, unreachable }, d.now))
  let head: Head | null
  try {
    head = await fromGitHub(d.api, rc.github, branch)
  } catch (e) {
    return unknown(`${found.note}, and GitHub could not be read: ${reason(e)}`, true)
  }
  if (!head) return unknown(`${found.note}, and GitHub has no head commit for ${branch}`, found.kind === 'down')
  const at = head.pr === null ? 'branch head' : 'PR head'
  const build = head.number ? `${branch} #${head.number}` : branch
  const links = [{ text: `${repo} ${short(head.sha)}`, url: `https://github.com/${rc.github}/commit/${head.sha}` },
    ...(head.url ? [{ text: `${repo} ${build}`, url: head.url }] : [])]
  return [statusItem(repo, branch, head, wanted, found, d.now),
    header({ sha: head.sha, status: 'pass', links, value: `${repo}: ${build}, ${at} ${short(head.sha)}${head.state ? `, Jenkins status ${head.state}` : ''}`,
      data: { from: 'github', branch, sha: head.sha, number: head.number ?? null, state: head.state ?? null } }),
    await scopedScan(repo, rc, e2e, head.sha, d.tarball, false, d.now)]
}

export function e2eReader(cfg: ReleaseConfig, cosmos: CosmosQuery = defaultCosmosQuery(), api: GitHubApi = defaultGitHubApi(),
  tarball: GitHubTarball = defaultTarball(), now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const repos = Object.entries(cfg.repos).filter(([, rc]) => rc.e2e)
    if (!repos.length) {
      return E2E_RULES.map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note: 'no repo has an E2E build configured' }, now))
    }
    const deps = { cosmos, api, tarball, now }
    return (await mapLimit(repos, E2E_CONCURRENCY, ([repo, rc]) => one(repo, rc, rc.e2e!, deps))).flat()
  }
}
