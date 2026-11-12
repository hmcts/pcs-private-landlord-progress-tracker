// A person's (or their agent's) answers for checklist rows nothing can answer mechanically:
//
//   '16': { status: 'Yes', comment: 'Regression run on V2 passed.', links: [{ text: HDPI-8908, url: … }] }
//
// The file says what someone is vouching for, so it is theirs, not the generator's: its cells are
// written without the ownership marker and the pipeline never touches them again. It holds
// internal detail, so it lives in the cache directory like the evidence, never in the repo.

import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadYaml } from '../data.ts'
import { QaError } from './errors.ts'
import type { RowResult } from './render.ts'
import type { Answer, Link } from './types.ts'
import { isRec, str } from './util.ts'

export interface Judgement {
  status: Answer
  comment: string
  links?: Link[]
}

export type Judgements = Record<string, Judgement>

const ANSWERS = ['Yes', 'No', 'N/A']
const FIELDS = ['status', 'comment', 'links']

export function validateJudgements(doc: unknown, checklist: RowResult[], name = 'judgement'): string[] {
  if (!isRec(doc)) return [`${name}: expected a mapping of row keys`]
  const errors: string[] = []
  for (const [key, j] of Object.entries(doc)) {
    const w = `${name}.${key}`
    const row = checklist.find((r) => r.key === key)
    if (!row) errors.push(`${w}: the checklist has no row ${key}`)
    else if (!row.needsJudgement && row.answer !== 'To confirm') errors.push(`${w}: row ${key} is answered from evidence, so it takes no judgement`)
    if (!isRec(j)) {
      errors.push(`${w}: expected { status, comment }`)
      continue
    }
    for (const k of Object.keys(j)) if (!FIELDS.includes(k)) errors.push(`${w}: unknown field "${k}"`)
    if (!ANSWERS.includes(str(j.status))) errors.push(`${w}: "status" must be Yes, No or N/A (leave the row out to keep it To confirm)`)
    if (typeof j.comment !== 'string' || !j.comment.trim()) errors.push(`${w}: "comment" is required`)
    if (j.links !== undefined && !(Array.isArray(j.links) && j.links.every((l) =>
      isRec(l) && typeof l.text === 'string' && l.text.trim() && /^https:\/\/\S+$/.test(str(l.url))))) {
      errors.push(`${w}: "links" must be a list of { text, url } with https urls`)
    }
  }
  return errors
}

/** The release's judgement file in its cache directory: judgement.yaml, else judgement.json. */
export function judgementFile(dir: string): string {
  const yaml = join(dir, 'judgement.yaml')
  const json = join(dir, 'judgement.json')
  return existsSync(yaml) || !existsSync(json) ? yaml : json
}

/** Reads a judgement file, refusing one inside the repo outside .cache/, where it could be committed. */
export function loadJudgements(path: string, checklist: RowResult[], root = process.cwd()): Judgements {
  const rel = relative(resolve(root), resolve(root, path))
  if (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '.cache') {
    throw new QaError('bad-path', 'the judgement file must be outside the repo or under .cache/, as it holds internal detail')
  }
  if (!existsSync(path)) throw new QaError('judgement-invalid', 'no judgement.yaml or judgement.json in the release\'s cache directory')
  let doc: unknown
  try {
    doc = loadYaml(path)
  } catch (e) {
    throw new QaError('judgement-invalid', `not valid YAML or JSON: ${(e as Error).message}`)
  }
  const errors = validateJudgements(doc, checklist, 'judgement')
  if (errors.length) throw new QaError('judgement-invalid', errors.join('\n'))
  return doc as Judgements
}
