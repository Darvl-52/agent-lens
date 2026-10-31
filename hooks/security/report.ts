import type { SecurityFinding } from '../../types'
import { hideValues, redact } from './scan'

export const EVIDENCE_LIMIT = 160
const NAMES_A_SECRET = /secret|credential|password|token|key/i

// The agent's answer, from the JSON object it ends with; undefined where it holds none. A finding
// with no problem said, or no file, cannot be acted on and is left out; `file`: the one it can only be
// about, where the answer was of one file.
export function parseSecurityReport(answer: string, file = ''): { findings: SecurityFinding[]; checked: string } | undefined {
  const end = answer.lastIndexOf('}')
  for (let at = answer.indexOf('{'); at >= 0 && at < end; at = answer.indexOf('{', at + 1)) {
    let raw: unknown
    try {
      raw = JSON.parse(answer.slice(at, end + 1))
    } catch {
      continue
    }
    const list = (raw as { findings?: unknown } | null)?.findings
    if (!Array.isArray(list)) continue
    // The agent is told not to quote a secret; a slip of a known shape, or under a kind that says it
    // is one, goes no further.
    const said = (v: unknown) => (typeof v === 'string' ? redact(v.trim()) : '')
    const findings = list
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f): SecurityFinding => ({
        severity: /^(?:high|critical)$/i.test(said(f.severity)) ? 'high' : 'low',
        kind: said(f.kind) || 'security',
        file: said(f.file) || file,
        ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
        problem: said(f.problem),
        fix: said(f.fix),
        ...(said(f.evidence) ? { evidence: (NAMES_A_SECRET.test(said(f.kind)) ? hideValues(said(f.evidence)) : said(f.evidence)).slice(0, EVIDENCE_LIMIT) } : {}),
      }))
      .filter(f => f.problem !== '' && f.file !== '')
      // What can be attacked now first.
      .sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'))
    return { findings, checked: said((raw as { checked?: unknown }).checked) }
  }
  return undefined
}
