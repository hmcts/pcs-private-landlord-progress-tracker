// The cve-reports documents CVEPublisher.groovy writes, read the way dtsse-github-metrics reads
// them (src/evidence/cve/, checked there against the live container):
//
//   { build: { branch_name, build_display_name, build_tag, git_url, codebase_type }, report }
//
// - java (GradleBuilder): OWASP dependency-check, trimmed to vulnerable dependencies. Live findings
//   are dependencies[].vulnerabilities[], accepted ones dependencies[].suppressedVulnerabilities[],
//   and fileName names the artefact. The grade is cvssv3.baseSeverity, else cvssv2.severity: the
//   entry's own `severity` is missing on every suppressed finding.
// - node (YarnBuilder): yarn audit as { vulnerabilities, suppressed, summary }, each entry
//   { title, cves, severity, cvss, url, module_name, … }. Every report carries one placeholder
//   entry with every field null, which is not a finding. `vulnerabilities` is the whole audit
//   (yarn-audit-with-suppressions.sh publishes yarn-audit-result-formatted), so it repeats the
//   accepted ones listed in `suppressed`; those are taken out of the live count here.
// - python (PythonBuilder): uv audit, vulnerabilities[] only, with no grade and no suppression.
//
// A finding is a CVE (or advisory) against a package, listed once; the worse grade wins. A
// report of a type with no parser is unreadable, never an empty scan. There is no repo field, so
// a report is attributed by build.git_url.

import { isRec } from '../util.ts'

export const CODEBASE_TYPES = ['java', 'node', 'python'] as const
export type CodebaseType = (typeof CODEBASE_TYPES)[number]

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface Finding {
  id: string
  pkg: string
  suppressed: boolean
  severity?: Severity
}

export interface CveDoc {
  _ts?: number
  build: { branch_name?: string; build_tag?: string; build_display_name?: string; git_url?: string; codebase_type?: string }
  report?: unknown
}

/** owner/name, lower-cased, from a git remote; undefined for anything that isn't a GitHub repo. */
export function repoFromGitUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const s = url.trim().replace(/^git@github\.com:/, 'https://github.com/').replace(/^git:\/\/github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '').toLowerCase()
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(s) ? s.slice('https://github.com/'.length) : undefined
}

export function severity(raw: unknown): Severity | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (s === 'moderate') return 'medium'
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : undefined
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const rec = (v: unknown): Record<string, unknown> => (isRec(v) ? v : {})
const withGrade = (f: Finding, s: Severity | undefined): Finding => (s ? { ...f, severity: s } : f)

function dependencyCheck(report: Record<string, unknown>): Finding[] {
  return list(report.dependencies).filter(isRec).flatMap((d) => {
    const pkg = text(d.fileName)
    if (!pkg) return []
    const side = (entries: unknown, suppressed: boolean) => list(entries).filter(isRec).flatMap((v) => {
      const id = text(v.name)
      return id ? [withGrade({ id, pkg, suppressed }, severity(rec(v.cvssv3).baseSeverity) ?? severity(rec(v.cvssv2).severity))] : []
    })
    return [...side(d.vulnerabilities, false), ...side(d.suppressedVulnerabilities, true)]
  })
}

function yarnAudit(report: Record<string, unknown>): Finding[] {
  const side = (entries: unknown, suppressed: boolean) => list(entries).filter(isRec).flatMap((v) => {
    const id = list(v.cves).map(text).find((x) => x) ?? text(v.url)
    const pkg = text(v.module_name)
    return id && pkg ? [withGrade({ id, pkg, suppressed }, severity(v.severity))] : []
  })
  const suppressed = side(report.suppressed, true)
  const accepted = new Set(suppressed.map((f) => `${f.id} ${f.pkg}`))
  return [...side(report.vulnerabilities, false).filter((f) => !accepted.has(`${f.id} ${f.pkg}`)), ...suppressed]
}

function uvAudit(report: Record<string, unknown>): Finding[] {
  return list(report.vulnerabilities).filter(isRec).flatMap((v) => {
    const id = text(v.display_id) ?? text(v.id) ?? list(v.aliases).map(text).find((x) => x)
    const pkg = text(v.package) ?? text(rec(v.dependency).name)
    return id && pkg ? [{ id, pkg, suppressed: false }] : []
  })
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

/** One entry per CVE, package and side; the worse grade wins. */
export function distinct(findings: Finding[]): Finding[] {
  const kept = new Map<string, Finding>()
  for (const f of findings) {
    const k = `${f.id} ${f.pkg} ${f.suppressed}`
    const had = kept.get(k)
    if (!had || (RANK[f.severity ?? ''] ?? 0) > (RANK[had.severity ?? ''] ?? 0)) kept.set(k, f)
  }
  return [...kept.values()]
}

export const isCodebaseType = (t: unknown): t is CodebaseType => typeof t === 'string' && (CODEBASE_TYPES as readonly string[]).includes(t)

/** A report's findings, or undefined when nothing here can read it. */
export function findings(type: unknown, report: unknown): Finding[] | undefined {
  if (!isCodebaseType(type) || !isRec(report)) return undefined
  const all = type === 'java' ? dependencyCheck(report) : type === 'node' ? yarnAudit(report) : uvAudit(report)
  return distinct(all)
}

export interface CveSummary {
  type: CodebaseType
  open: number
  suppressed: number
  /** Open findings by grade; ungraded ones as `unrated`. */
  bySeverity: Record<string, number>
}

export function summariseCve(doc: CveDoc): CveSummary | undefined {
  const type = doc.build.codebase_type
  const fs = findings(type, doc.report)
  if (!fs || !isCodebaseType(type)) return undefined
  const open = fs.filter((f) => !f.suppressed)
  const bySeverity: Record<string, number> = {}
  for (const f of open) bySeverity[f.severity ?? 'unrated'] = (bySeverity[f.severity ?? 'unrated'] ?? 0) + 1
  return { type, open: open.length, suppressed: fs.length - open.length, bySeverity }
}
