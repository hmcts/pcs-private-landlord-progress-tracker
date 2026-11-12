import { fmt } from '../../roadmap-runner.ts'
import type { Answer, EvidenceItem, Link, Status } from '../types.ts'

export type Item = Omit<EvidenceItem, 'row'>

/** Fetches JSON over HTTP. Injected in tests. */
export type HttpJson = (url: string, headers?: Record<string, string>) => Promise<unknown>

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const httpJson: HttpJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
  return res.json()
}

export interface ItemArgs {
  rule: string
  source: string
  status: Status
  value: string
  links?: Link[]
  sha?: string | null
  repo?: string
  candidate?: string
  note?: string
  answer?: Answer
  data?: Record<string, unknown>
}

export function item(a: ItemArgs, now: () => Date = () => new Date()): Item {
  const out: Item = { rule: a.rule, status: a.status, value: a.value, links: a.links ?? [], source: a.source,
    sha: a.sha ?? null, fetchedAt: now().toISOString() }
  if (a.repo) out.repo = a.repo
  if (a.candidate) out.candidate = a.candidate
  if (a.note) out.note = a.note
  if (a.answer) out.answer = a.answer
  if (a.data) out.data = a.data
  return out
}

/** A one-line reason for an error, safe to keep in the evidence (never the response body). */
export function reason(e: unknown): string {
  const err = e as { status?: number; statusCode?: number; code?: string | number; message?: string }
  const code = err?.statusCode ?? err?.status ?? err?.code
  if (code === 403 || code === 'Forbidden') return 'access denied (403)'
  if (code === 401) return 'not signed in (401)'
  if (code === 404) return 'not found (404)'
  const msg = (typeof err?.message === 'string' ? err.message : typeof e === 'string' ? e : 'unknown error').split('\n')[0].slice(0, 200)
  return code !== undefined ? `${msg} (${code})` : msg
}

export const short = (sha: string): string => sha.slice(0, 7)

/** "17 Sep 2026" from any ISO timestamp. */
export function day(isoTs: string): string {
  const d = new Date(isoTs)
  return Number.isNaN(d.getTime()) ? isoTs : fmt(d.toISOString(), 'd Mon yyyy')
}
