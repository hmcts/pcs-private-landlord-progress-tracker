// Checks shared by the QA report's config, judgement and evidence readers, which all take YAML
// or JSON whose shape isn't known until it's checked.

export type Rec = Record<string, unknown>

export const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

export const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** A string or number as text; anything else (an object, a list) as ''. */
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
