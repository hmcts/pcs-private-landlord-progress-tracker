// Shapes shared by the QA readiness report stages: collect → evidence → render → publish.

export type Status = 'pass' | 'fail' | 'unknown'
export type Answer = 'Yes' | 'No' | 'N/A'

export interface Link {
  text: string
  url: string
}

/** One finding from one source. A layout places rules in rows; `row` is filled in by collect. */
export interface EvidenceItem {
  row: string
  rule: string
  status: Status
  /** What the source said, in a few words: "96.0%", "OK", "2 ignored". */
  value: string
  links: Link[]
  source: string
  sha: string | null
  repo?: string
  candidate?: string
  fetchedAt: string
  /** Why the status is unknown, or a detail worth a reader's attention. */
  note?: string
  /** Overrides the layout's yes/no mapping, for questions where the answer isn't a verdict. */
  answer?: Answer
  /** Facts the info table shows verbatim, such as bug counts by priority. */
  data?: Record<string, unknown>
  /**
   * The status is unknown because the source couldn't be read (down, signed out, off the VPN),
   * not because what it was asked about is absent. A row unknown only for this reason leaves
   * the published cells as they are.
   */
  unreachable?: boolean
}

export interface Evidence {
  /** The release, or the feature, the evidence is for. */
  release: string
  generatedAt: string
  candidates: { name: string; shas: Record<string, string> }[]
  items: EvidenceItem[]
}

/** A source reader: never throws, and answers `unknown` with a note when it can't tell. */
export type Reader = () => Promise<Omit<EvidenceItem, 'row'>[]>
