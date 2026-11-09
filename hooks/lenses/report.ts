import type { LensFinding, LensPlace, LensResult } from '../../types'

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
    // A place as {file, line} or as "path:line".
    const placeOf = (p: unknown): LensPlace | undefined => {
      if (typeof p === 'string') {
        const m = p.trim().match(/^(.+?)(?::(\d+))?$/)
        return m?.[1] ? { file: m[1], ...(m[2] && Number(m[2]) > 0 ? { line: Number(m[2]) } : {}) } : undefined
      }
      if (typeof p !== 'object' || p === null) return undefined
      const o = p as Record<string, unknown>
      return said(o.file) ? { file: said(o.file), ...(typeof o.line === 'number' && o.line > 0 ? { line: o.line } : {}) } : undefined
    }
    const findingOf = (f: Record<string, unknown>): LensFinding => {
      const places = (Array.isArray(f.places) ? f.places : []).map(placeOf).filter((p): p is LensPlace => p !== undefined)
      const first = placeOf({ file: f.file, line: f.line }) ?? places[0] ?? { file: '' }
      const rest = places.filter(p => p.file !== first.file || p.line !== first.line)
      const confidence = said(f.confidence).toLowerCase()
      return {
        ...first,
        problem: said(f.problem),
        risk: said(f.risk),
        ...(rest.length > 0 ? { places: rest } : {}),
        ...(said(f.evidence) ? { evidence: said(f.evidence) } : {}),
        ...(confidence === 'confirmed' || confidence === 'likely' ? { confidence } : {}),
      }
    }
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
// take a value of their own. `timeout` takes its time too, before the command.
const PREFIXES = new Set(['command', 'exec', 'sudo', 'env', 'time', 'nohup', 'nice', 'then', 'do', 'else', '!', 'eval', 'timeout'])
// Each prefix's own: `sudo -k` takes none, `timeout -k 5` does.
const PREFIX_VALUED: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k']),
}
// A shell handed a command as text: `sh -c '…'`, `bash -lc "…"`, `bash --login -c '…'`; and `eval '…'`.
const INNER = /(?:^|[\s;&|(])(?:(?:\/\S*\/)?(?:ba|z|da|k)?sh\s+(?:--?[a-z-]+\s+)*?-[a-z]*c[a-z]*|eval)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
// A heredoc: its marker, the rest of its first line (commands still), its body and end (text).
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2)([^\n]*\n)([\s\S]*?\n\s*\3\s*)(?=\n|$)/g
// The heredocs' bodies blanked, the length kept, so what is found in the text is where it stands.
const blankHeredocs = (command: string) => command.replace(HEREDOC, (_m, marker: string, _quote: string, _tag: string, rest: string, body: string) => `${' '.repeat(marker.length)}${rest}${body.replace(/[^\n]/g, ' ')}`)

// git's aliases, as `git config --get-regexp ^alias\.` gives them: by name, what each runs.
export type Aliases = Record<string, string>
export const aliasesOf = (out: string): Aliases =>
  Object.fromEntries(
    out
      .split('\n')
      .map(l => l.match(/^alias\.(\S+)\s+(.+)$/))
      .flatMap(m => (m ? [[m[1]!, m[2]!.trim()]] : [])),
  )

type Run = { tool: string; words: string[] }

// Each command a shell command line runs, by its tool and the words after its own options: what is in
// quotes is text, a heredoc's body too, save a command handed to a shell or eval as text, which is
// read as a command line of its own; a git alias is read as what it runs.
function runsOf(command: string, aliases: Aliases, depth = 0): Run[] {
  if (depth > 3) return []
  // A shell named inside the text of another quote (a commit message) runs nothing.
  // A heredoc's body is text: blanked where it stands, so its apostrophes open no quote.
  const plain = blankHeredocs(command)
  const quoted = [...plain.matchAll(QUOTED)].map(q => [q.index, q.index + q[0].length] as const)
  const inner = [...plain.matchAll(INNER)]
    .filter(m => !quoted.some(([from, to]) => m.index > from && m.index < to))
    .flatMap(m => runsOf((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'), aliases, depth + 1))
  // A heredoc's body is text, not commands; a quoted word stays one word, so an option's value or a
  // variable's in quotes is still taken whole.
  const bare = plain.replace(QUOTED, '_')
  const runs = bare.split(/&&|\|\||[;|&\n]/).flatMap((part): Run[] => {
    const words = part
      .replace(/[(){}]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    // A prefix's own options go with it (env -i, sudo -u root, nice -n 10, timeout -s INT 60).
    let prefix = ''
    while (words.length > 0 && (PREFIXES.has(words[0]!) || /^\w+=/.test(words[0]!) || words[0]!.startsWith('-'))) {
      const word = words.shift()!
      if (PREFIXES.has(word)) prefix = word
      else if (word.startsWith('-') && PREFIX_VALUED[prefix]?.has(word)) words.shift()
      if (word === 'timeout') {
        while (words[0]?.startsWith('-')) if (PREFIX_VALUED.timeout!.has(words.shift()!)) words.shift()
        words.shift()
      }
    }
    // By its name alone, as Windows names it too: `/usr/bin/git`, `C:\Git\cmd\git.exe`.
    const tool = (words.shift() ?? '')
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, '')
    const valued = tool ? VALUED[tool] : undefined
    if (!tool || !valued) return []
    while (words[0]?.startsWith('-')) {
      const option = words.shift()!
      if (valued.has(option)) words.shift()
    }
    const alias = tool === 'git' && words[0] ? aliases[words[0]] : undefined
    if (alias !== undefined && depth <= 3) {
      if (alias.startsWith('!')) return runsOf(alias.slice(1), aliases, depth + 1)
      return [{ tool, words: [...alias.split(/\s+/).filter(Boolean), ...words.slice(1)] }]
    }
    return [{ tool, words }]
  })
  return [...inner, ...runs]
}

const isOut = ({ tool, words }: Run) =>
  tool === 'git' ? words[0] === 'push' && !words.includes('--dry-run') && !words.includes('-n') : words[0] === (tool === 'gh' ? 'pr' : 'mr') && words[1] === 'create'

// Whether a shell command sends the work out of the machine, to people: a push that is not a dry
// run, a pull or merge request opened. Read by its words, not by a pattern: what is in quotes is
// text (a commit message that speaks of a push pushes nothing), the prefixes, groups and variables
// before a command are passed over, and so are the options git and gh take before theirs.
export function sendsOut(command: string, aliases: Aliases = {}) {
  return runsOf(command, aliases).some(isOut)
}

// The branches or commits a push sends, by the refs it names (`git push origin feature`,
// `HEAD:main`); none named, or all of them (`--all`), is what is checked out.
export function pushedRefs(command: string, aliases: Aliases = {}) {
  return runsOf(command, aliases)
    .filter(r => r.tool === 'git' && isOut(r))
    .flatMap(r => {
      const args = r.words.slice(1).filter(w => !w.startsWith('-'))
      return args.slice(1).flatMap(spec => {
        const src = spec.replace(/^\+/, '').split(':')[0]!
        return src === '' || src === '_' ? [] : [src]
      })
    })
}

// A tool of an MCP server that sends the work out: files pushed, a pull or merge request opened.
export const isMcpPush = (tool: string) => /^mcp__.+__(push_files|create_or_update_file|create_pull_request|create_merge_request|push)$/i.test(tool)
