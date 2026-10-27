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

// The options of git, gh and glab that take a value of their own, as the next word.
const VALUED: Record<string, Set<string>> = {
  git: new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']),
  gh: new Set(['-R', '--repo']),
  glab: new Set(['-R', '--repo']),
}
// Words that run the command after them: a prefix, not the tool; and those of their options that
// take a value of their own.
const PREFIXES = new Set(['command', 'exec', 'sudo', 'env', 'time', 'nohup', 'nice', 'then', 'do', 'else', '!'])
const PREFIX_VALUED = new Set(['-u', '-g', '-n', '-C', '-S', '-h', '-p', '-U'])

// Whether a shell command sends the work out of the machine, to people: a push that is not a dry
// run, a pull or merge request opened. Read by its words, not by a pattern: what is in quotes is
// text (a commit message that speaks of a push pushes nothing), the prefixes, groups and variables
// before a command are passed over, and so are the options git and gh take before theirs.
export function sendsOut(command: string) {
  // A heredoc's body is text, not commands; a quoted word stays one word, so an option's value or a
  // variable's in quotes is still taken whole.
  const bare = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '_')
  return bare.split(/&&|\|\||[;|&\n]/).some(part => {
    const words = part
      .replace(/[(){}]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    // A prefix's own options go with it (env -i, sudo -u root, nice -n 10).
    while (words.length > 0 && (PREFIXES.has(words[0]!) || /^\w+=/.test(words[0]!) || words[0]!.startsWith('-')))
      if (PREFIX_VALUED.has(words.shift()!)) words.shift()
    const tool = (words.shift() ?? '').split('/').at(-1)
    const valued = tool ? VALUED[tool] : undefined
    if (!tool || !valued) return false
    while (words[0]?.startsWith('-')) {
      const option = words.shift()!
      if (valued.has(option)) words.shift()
    }
    if (tool === 'git') return words[0] === 'push' && !words.includes('--dry-run') && !words.includes('-n')
    return words[0] === (tool === 'gh' ? 'pr' : 'mr') && words[1] === 'create'
  })
}
