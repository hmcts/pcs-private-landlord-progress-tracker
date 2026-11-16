// The QA readiness reports, from config/qa-readiness/. Eleventy merges this with reports.yaml,
// which holds the performance test reports.
import { qaReports } from '../../scripts/lib/data.ts'

export default function () {
  return { qa: qaReports() }
}
