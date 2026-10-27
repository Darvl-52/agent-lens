import type { LensFinding, LensResult } from '../../types'

// The agent's answer, from the JSON object it ends with; undefined where it holds none.
export function parseLensReport(answer: string): { results: LensResult[]; outside: string[]; untouched: string[] } | undefined {
  const end = answer.lastIndexOf('}')
  for (let at = answer.indexOf('{'); at >= 0 && at < end; at = answer.indexOf('{', at + 1)) {
    let raw: unknown
    try {
      raw = JSON.parse(answer.slice(at, end + 1))
    } catch {
      continue
    }
    const lenses = (raw as { lenses?: unknown } | null)?.lenses
    if (!Array.isArray(lenses)) continue
    const said = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const findingOf = (f: Record<string, unknown>): LensFinding => ({
      file: said(f.file),
      ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
      problem: said(f.problem),
      risk: said(f.risk),
    })
    const results = lenses
      .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
      .map((l): LensResult => {
        const findings = (Array.isArray(l.findings) ? l.findings : [])
          .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
          .map(findingOf)
          .filter(f => f.problem !== '')
        const status = findings.length > 0 ? 'findings' : said(l.status) === 'na' ? 'na' : 'clean'
        return { lens: said(l.lens), status, checked: said(l.checked), findings }
      })
      .filter(r => r.lens !== '')
    const listOf = (v: unknown) => (Array.isArray(v) ? v.map(said).filter(Boolean) : [])
    const r = raw as { outside?: unknown; untouched?: unknown }
    return { results, outside: listOf(r.outside), untouched: listOf(r.untouched) }
  }
  return undefined
}
