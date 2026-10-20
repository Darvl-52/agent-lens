import type { Delta, Issue, Progress, Requirement, Task, Tests, TestCase } from '../../types/spec'

// A change's Markdown files by their path inside the change folder: `proposal.md`,
// `specs/web/dark-mode/spec.md`.
export type Files = Record<string, string>

// The files a brief reads first, in the order a person would; the specs follow, by path.
const ORDER = ['proposal.md', 'design.md', 'tasks.md', 'test-cases.md', 'test-plan.md']

export const orderedPaths = (files: Files) =>
  Object.keys(files).sort((a, b) => {
    const i = ORDER.indexOf(a)
    const j = ORDER.indexOf(b)
    return (i < 0 ? ORDER.length : i) - (j < 0 ? ORDER.length : j) || a.localeCompare(b)
  })

// Text as Git on Windows checks it out (`core.autocrlf`) or an editor there saves it, CRLF, read
// as LF: the parsers below match up to a line's end.
export const lf = (text: string) => text.replace(/\r\n?/g, '\n')

export const parseTasks = (md: string): Progress => {
  const boxes = lf(md).match(/^\s*[-*] \[[ xX]\]/gm) ?? []
  return { done: boxes.filter(b => /\[[xX]\]/.test(b)).length, total: boxes.length }
}

// Every checkbox of `tasks.md` under the heading it sits in, its leading number taken apart.
export const parseTaskList = (md: string): Task[] => {
  const tasks: Task[] = []
  let section: string | null = null
  for (const line of lf(md).split('\n')) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = heading[1]!
      continue
    }
    const box = /^\s*[-*] \[([ xX])\]\s+(.*)$/.exec(line)
    if (!box) continue
    const numbered = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(box[2]!)
    tasks.push({ id: numbered ? numbered[1]! : null, text: (numbered ? numbered[2]! : box[2]!).trim(), isDone: box[1] !== ' ', section })
  }
  return tasks
}

// What a task is called when it is sent or drawn short: its number, else its text.
export const taskKey = (t: Task) => t.id ?? t.text

// The capability a delta spec belongs to, from its path in the change: `specs/a/b/spec.md` → `a/b`.
export const capabilityOf = (path: string) => /^specs\/(.+)\/spec\.md$/.exec(path)?.[1]

const OPS: Record<string, Requirement['op']> = { ADDED: 'added', MODIFIED: 'modified', REMOVED: 'removed', RENAMED: 'renamed' }

// The requirements of one delta spec under its `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`
// headings, each with its `#### Scenario:` names; a rename's `- FROM:` / `- TO:` pair as one.
export const parseRequirements = (capability: string, md: string): Requirement[] => {
  const out: Requirement[] = []
  let op: Requirement['op'] | null = null
  let from: string | undefined
  for (const line of lf(md).split('\n')) {
    const section = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\b/i.exec(line)
    if (section) {
      op = OPS[section[1]!.toUpperCase()]!
      continue
    }
    if (/^##\s/.test(line)) {
      op = null
      continue
    }
    if (op === null) continue
    const renamed = /^\s*[-*]\s*(FROM|TO):\s*`?(?:###\s*)?Requirement:\s*(.+?)`?\s*$/i.exec(line)
    if (op === 'renamed' && renamed) {
      if (renamed[1]!.toUpperCase() === 'FROM') from = renamed[2]!
      else out.push({ capability, op, name: renamed[2]!, ...(from !== undefined ? { from } : {}), scenarios: [] })
      continue
    }
    const requirement = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line)
    if (requirement) {
      out.push({ capability, op, name: requirement[1]!, scenarios: [] })
      continue
    }
    const scenario = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line)
    if (scenario && out.length > 0) out[out.length - 1]!.scenarios.push(scenario[1]!)
  }
  return out
}

// Every requirement a main spec has, by name.
export const requirementNames = (md: string) => [...lf(md).matchAll(/^###\s+Requirement:\s*(.+?)\s*$/gm)].map(m => m[1]!)

const norm = (name: string) => name.replace(/[`«»"]/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase()

// What the test cases say they cover, from their `Covers:` lines: `Requirement: X / Scenario: A;
// Scenario: B; Requirement: Y`, a capability before them or not. A requirement named with no
// scenario of its own is covered whole. Null where no case has such a line: the project keeps no
// such record.
export const parseCovers = (md: string) => {
  const lines = lf(md).split('\n').filter(l => /^\s*(?:\*\*)?Covers:/i.test(l))
  if (lines.length === 0) return null
  const scenarios: string[] = []
  const requirements: string[] = []
  for (const line of lines)
    for (const part of line.split(/(?=Requirement:)/)) {
      const named = [...part.matchAll(/Scenario:\s*(.+?)\s*(?=;|\s\/\s|$)/g)].map(m => norm(m[1]!))
      scenarios.push(...named)
      const requirement = /^Requirement:\s*(.+?)\s*(?=;|\s\/\s|$)/.exec(part)
      if (requirement && named.length === 0) requirements.push(norm(requirement[1]!))
    }
  return { scenarios, requirements }
}

// Whether `names`, as a Covers line wrote them, hold `name`: the same, or it followed by a remark
// after a dash or in brackets (`… — all scenarios of these`).
const holds = (names: readonly string[], name: string) => {
  const n = norm(name)
  return names.some(c => c === n || (c.startsWith(n) && /^\s*[—–(-]/.test(c.slice(n.length))))
}

// The requirements as the main specs and the test cases see them: `mains` holds each capability's
// main spec requirement names, null where it has none yet; `covers`, what `parseCovers` read.
export const annotateRequirements = (
  requirements: readonly Requirement[],
  mains: Record<string, readonly string[] | null>,
  covers: ReturnType<typeof parseCovers>,
): Requirement[] =>
  requirements.map(r => {
    const main = mains[r.capability]
    const has = (name: string) => main?.includes(name) ?? false
    const mismatch =
      main === null || main === undefined
        ? r.op === 'added'
          ? undefined
          : 'missing'
        : r.op === 'added'
          ? has(r.name)
            ? 'exists'
            : undefined
          : !has(r.op === 'renamed' ? (r.from ?? r.name) : r.name)
            ? 'missing'
            : undefined
    const uncovered =
      covers && (r.op === 'added' || r.op === 'modified') && !holds(covers.requirements, r.name)
        ? r.scenarios.filter(s => !holds(covers.scenarios, s))
        : []
    return { ...r, ...(uncovered.length > 0 ? { uncovered } : {}), ...(mismatch ? { mismatch } : {}) }
  })

// The findings of `openspec validate --json` for one change; undefined where the output is not it.
export const parseIssues = (stdout: string): Issue[] | undefined => {
  try {
    const items = (JSON.parse(stdout) as { items?: { issues?: Issue[] }[] }).items
    return Array.isArray(items) ? items.flatMap(i => i.issues ?? []) : undefined
  } catch {
    return undefined
  }
}

// A finding that says `openspec archive` would refuse the change, whatever its level.
export const blocksArchive = (issue: Issue) => issue.level === 'ERROR' || /archive would refuse/i.test(issue.message)

// The cases of `test-cases.md`, each under a heading that starts with its id, the title after it
// as the project writes it: `## TC-01: Title`, `### TC-02. Title`, `## TC-03 — Title`.
const casesIn = (md: string) => {
  const parts = lf(md).split(/^#{2,4}\s+(TC-\w+(?:[.-]\w+)*)/m)
  const out: { id: string; title: string; body: string }[] = []
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] ?? ''
    out.push({ id: parts[i]!, title: /^\s*[:.—–-]?\s*(.*)$/m.exec(body)?.[1]?.trim() ?? '', body })
  }
  return out
}

// How a case says it is checked, on a line of its own: `Automated: …` or `Manual: …`, bold, in a
// list item or neither (`- **Automated:** e2e/door.spec.ts`), and what follows the mark.
const markOf = (body: string) => {
  const m = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(Automated|Manual)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/im.exec(body)
  return m ? { mark: m[1]!.toLowerCase() as 'automated' | 'manual', rest: m[2]! } : { mark: 'none' as const, rest: '' }
}

// Each case may say how it is checked, `Automated: <spec>` or `Manual: <why>`. Where some cases do,
// one that says neither is unmarked; where none does, the project keeps no such marks (cases
// checked by hand, say) and nothing is unmarked.
export const parseTests = (md: string): Tests => {
  const tests: Tests = { cases: 0, automated: 0, manual: 0, unmarked: [] }
  for (const c of casesIn(md)) {
    const { mark } = markOf(c.body)
    tests.cases++
    if (mark === 'automated') tests.automated++
    else if (mark === 'manual') tests.manual++
    else tests.unmarked.push(c.id)
  }
  if (tests.automated + tests.manual === 0) tests.unmarked = []
  return tests
}

// Each case with how it says it is checked, and every test file its `Automated:` line names
// (`Automated: e2e/door.spec.ts, e2e\\api.spec.ts, tag \`@door:TC-01\``), by `/`.
export const parseTestCases = (md: string): Omit<TestCase, 'state'>[] =>
  casesIn(md).map(c => {
    const { mark, rest } = markOf(c.body)
    const files = mark === 'automated' ? [...new Set([...rest.matchAll(/[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{1,5}\b/g)].map(m => m[0].replace(/\\/g, '/')))] : []
    return { id: c.id, title: c.title, mark, ...(files.length > 0 ? { files } : {}) }
  })

// Whether a test file holds a test for `id`: the id standing alone, so `TC-1` is not found in
// `TC-10` nor `TC-1.2`.
export const hasCase = (text: string, id: string) =>
  new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-]*\\w)`).test(text)

// A task ticked off is progress, not a change to the spec: ticks are read as unticked wherever
// the spec is compared, so the brief stays fresh and the row calm while agents work through it.
const untick = (path: string, text = '') => (path === 'tasks.md' ? text.replace(/^(\s*[-*] )\[[xX]\]/gm, '$1[ ]') : text)

// FNV-1a over every file, path and text: changes whenever any of them does, ticks aside.
export const fingerprintOf = (files: Files) => {
  let h = 0x811c9dc5
  for (const path of orderedPaths(files))
    for (const ch of `${path}\0${untick(path, files[path])}\0`) {
      h ^= ch.codePointAt(0)!
      h = Math.imul(h, 0x01000193) >>> 0
    }
  return h.toString(16).padStart(8, '0')
}

// The lines `after` added to `before` and the lines it dropped, by longest common subsequence.
// Past a few million cells it falls back to comparing the lines as sets, which misses moves.
export const diffLines = (before: string, after: string) => {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 4_000_000) {
    const inA = new Set(a)
    const inB = new Set(b)
    return { added: b.filter(l => !inA.has(l)), removed: a.filter(l => !inB.has(l)) }
  }
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const added: string[] = []
  const removed: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) removed.push(a[i++]!)
    else added.push(b[j++]!)
  }
  return { added: added.concat(b.slice(j)), removed: removed.concat(a.slice(i)) }
}

const isBlank = (line: string) => line.trim() === ''

// What each file gained and lost since `seen`, blank lines aside; a file new or gone counts whole.
export const deltasOf = (seen: Files, now: Files): Delta[] => {
  const paths = orderedPaths({ ...seen, ...now })
  return paths
    .map(file => {
      const { added, removed } = diffLines(untick(file, seen[file]), untick(file, now[file]))
      return { file, added: added.filter(l => !isBlank(l)).length, removed: removed.filter(l => !isBlank(l)).length }
    })
    .filter(d => d.added > 0 || d.removed > 0)
}

// The same, line by line, for the model to explain: `-` dropped, `+` added, cut at `limit`.
export const changesText = (seen: Files, now: Files, limit = 60_000) => {
  let text = ''
  for (const file of orderedPaths({ ...seen, ...now })) {
    const { added, removed } = diffLines(untick(file, seen[file]), untick(file, now[file]))
    const lines = [...removed.filter(l => !isBlank(l)).map(l => `- ${l}`), ...added.filter(l => !isBlank(l)).map(l => `+ ${l}`)]
    if (lines.length > 0) text += `### ${file}\n${lines.join('\n')}\n\n`
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text
}

// The change whole, one file after another, for the model to read.
export const specText = (name: string, files: Files) =>
  `OpenSpec change "${name}"\n\n` + orderedPaths(files).map(path => `=== ${path} ===\n${files[path]}`).join('\n\n')

// A brief is Markdown whose last section, under `heading`, lists what is left to decide; that
// section is taken out into its own list, empty when it says `none`. The heading as a model may
// write it: any level, bold, a colon after. With no such section what is left is not known, and
// `isUnsplit` says so rather than an empty list passing for nothing to decide.
export const splitBrief = (text: string, heading: string, none: string) => {
  const at = text.search(new RegExp(`^#{1,4}\\s*(?:\\*\\*)?\\s*${heading}\\s*(?:\\*\\*)?\\s*:?\\s*(?:\\*\\*)?\\s*$`, 'im'))
  if (at < 0) return { summary: text.trim(), decisions: [] as string[], isUnsplit: true as const }
  const rest = text.slice(at).split('\n').slice(1)
  const end = rest.findIndex(l => /^#{1,4}\s/.test(l))
  const decisions = (end < 0 ? rest : rest.slice(0, end))
    .map(l => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(l => l !== '' && l.toLowerCase().replace(/[.!]$/, '') !== none.toLowerCase())
  const after = end < 0 ? '' : rest.slice(end).join('\n')
  return { summary: `${text.slice(0, at)}${after}`.trim(), decisions }
}

// The model's options for `count` decisions, from its JSON array, fenced or not: per decision an
// object of `options` and `why`, or the options alone; a decision it gave nothing usable for gets
// none.
const optionLists = (text: string, count: number) => {
  let lists: unknown = []
  try {
    lists = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
  } catch {}
  return Array.from({ length: count }, (_, i) => {
    const item: unknown = Array.isArray(lists) ? lists[i] : undefined
    return Array.isArray(item) ? { options: item, why: undefined } : typeof item === 'object' && item !== null ? (item as { options?: unknown; why?: unknown }) : {}
  })
}

export const parseOptions = (text: string, count: number): string[][] =>
  optionLists(text, count).map(({ options }) =>
    Array.isArray(options) ? [...new Set(options.filter((o): o is string => typeof o === 'string').map(o => o.trim()).filter(o => o !== ''))].slice(0, 4) : [],
  )

// Why the model recommends the first of its options for each decision; null where it gave no
// reason, or no options to recommend.
export const parseAdvice = (text: string, count: number): (string | null)[] => {
  const options = parseOptions(text, count)
  return optionLists(text, count).map(({ why }, i) => (typeof why === 'string' && why.trim() !== '' && options[i]!.length > 0 ? why.trim() : null))
}
