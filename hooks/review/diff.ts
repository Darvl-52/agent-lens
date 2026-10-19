import type { FileDiff, Finding, Hunk, Line, ShellRun, Where } from '../../types/review'

// FNV-1a over a text: hunk ids and fingerprints.
export const hash = (text: string) => {
  let h = 0x811c9dc5
  for (const ch of text) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// A file's lines, CRLF read as LF: a file Windows wrote compares, and shows, line for line.
const splitLines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/))

// Paths as the engine and git spell them: `/` or `\` between names, a drive (`C:\`) or `/` at the
// root. A path with a drive or a backslash is Windows's: its names compare case-folded.
const SEP = /[\\/]/
const isWindows = (path: string) => /^[A-Za-z]:/.test(path) || path.includes('\\')
const sepOf = (path: string) => (isWindows(path) ? '\\' : '/')
const isRoot = (path: string) => path === '/' || /^[A-Z]:\\$/.test(path)
const fold = (path: string) => (isWindows(path) ? path.toLowerCase() : path)

// One spelling of a path, so a file is one key whoever named it: on Windows `\` between names and
// the drive letter upper-cased (git says `d:/proj` where the engine says `D:\proj`); no separator
// at the end but a root's.
export const canonical = (path: string) => {
  const p = isWindows(path) ? path.replace(/\//g, '\\').replace(/^[a-z]:/, d => d.toUpperCase()) : path
  if (isRoot(p)) return p
  const trimmed = p.replace(/[\\/]+$/, '')
  return /^[A-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed || p
}

export const samePath = (a: string, b: string) => fold(canonical(a)) === fold(canonical(b))

// `path` below `dir`, its names joined by `/` as git and the model name them; undefined for a path
// not inside it, `dir` itself included.
export const below = (path: string, dir: string) => {
  const p = canonical(path)
  const d = canonical(dir)
  const head = isRoot(d) ? d : `${d}${sepOf(d)}`
  return p.length > head.length && fold(p).startsWith(fold(head)) ? p.slice(head.length).split(SEP).join('/') : undefined
}

// The folder `path` is in; a root's is itself.
export const parentOf = (path: string) => {
  const p = canonical(path)
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (isRoot(p) || cut < 0) return p
  const dir = p.slice(0, cut)
  return dir === '' ? '/' : /^[A-Z]:$/.test(dir) ? `${dir}\\` : dir
}

// The last name in a path; a root's is the root.
export const nameOf = (path: string) => canonical(path).split(SEP).filter(Boolean).at(-1) ?? path

// `rel`, its names joined by `/` as git prints them, under `dir`, by the separator `dir` uses.
export const joinPath = (dir: string, rel: string) => {
  const d = canonical(dir)
  return canonical(`${isRoot(d) ? d : `${d}${sepOf(d)}`}${rel.split(SEP).join(sepOf(d))}`)
}

// The edit script from `a` to `b`, line by line: common ends trimmed first, as an edit usually
// touches a few lines of a long file; the middle by longest common subsequence, or replaced whole
// past a few million cells.
const editScript = (a: string[], b: string[]): Line[] => {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map(text => ({ kind: ' ' as const, text }))
  const tail = a.slice(endA).map(text => ({ kind: ' ' as const, text }))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const middle: Line[] = []
  if (x.length * y.length > 4_000_000) {
    middle.push(...x.map(text => ({ kind: '-' as const, text })), ...y.map(text => ({ kind: '+' as const, text })))
  } else {
    const n = x.length
    const m = y.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        middle.push({ kind: ' ', text: x[i]! })
        i++
        j++
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) middle.push({ kind: '-', text: x[i++]! })
      else middle.push({ kind: '+', text: y[j++]! })
    }
    while (i < n) middle.push({ kind: '-', text: x[i++]! })
    while (j < m) middle.push({ kind: '+', text: y[j++]! })
  }
  return [...head, ...middle, ...tail]
}

// The hunks of an edit script, `context` lines kept around each run of changes; runs closer than
// twice that share a hunk, as `git diff` does.
const hunksOf = (path: string, script: Line[], context: number): Hunk[] => {
  const hunks: Hunk[] = []
  const changed = script.map((l, i) => (l.kind === ' ' ? -1 : i)).filter(i => i >= 0)
  if (changed.length === 0) return hunks
  let from = 0
  while (from < changed.length) {
    let to = from
    while (to + 1 < changed.length && changed[to + 1]! - changed[to]! <= 2 * context + 1) to++
    const first = Math.max(0, changed[from]! - context)
    const last = Math.min(script.length - 1, changed[to]! + context)
    let oldStart = 1
    let newStart = 1
    for (let k = 0; k < first; k++) {
      if (script[k]!.kind !== '+') oldStart++
      if (script[k]!.kind !== '-') newStart++
    }
    const lines = script.slice(first, last + 1)
    hunks.push({ id: hash(`${path}\0${lines.map(l => l.kind + l.text).join('\n')}`), oldStart, newStart, lines })
    from = to + 1
  }
  return hunks
}

const count = (hunks: Hunk[], kind: '+' | '-') => hunks.reduce((n, h) => n + h.lines.filter(l => l.kind === kind).length, 0)

// What changed in `path` from `before` to `after`; null for a file that was not there.
export const fileDiff = (path: string, where: Where, before: string | null, after: string | null, context = 3): FileDiff => {
  const hunks = hunksOf(path, editScript(splitLines(before ?? ''), splitLines(after ?? '')), context)
  return { path, ...where, isNew: before === null && after !== null, isDeleted: before !== null && after === null, added: count(hunks, '+'), removed: count(hunks, '-'), hunks }
}

const ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' }

// A path as `git diff` prints it after `--- ` and `+++ `: a tab after one with a space in it, and
// one with a quote, a backslash or a control character in C quotes; the rest as it is, by
// core.quotePath=false.
const diffPath = (text: string) => {
  const p = text.replace(/\t$/, '')
  if (!/^".*"$/s.test(p)) return p
  return p.slice(1, -1).replace(/\\([0-7]{3}|.)/gs, (_, e: string) => (/^[0-7]{3}$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : (ESCAPES[e] ?? e)))
}

// The files of `git diff` output, by their path in the repository; paths are made absolute by
// `repo`, with its separator, and `whereOf` says where each is shown.
export const parseUnified = (text: string, repo: string, whereOf: (path: string) => Where): FileDiff[] => {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let hunk: Hunk | undefined
  let oldPath = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = undefined
      hunk = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = diffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      const newPath = diffPath(line.slice(4))
      const isDeleted = newPath === '/dev/null'
      const path = joinPath(repo, (isDeleted ? oldPath : newPath).replace(/^[ab]\//, ''))
      file = { path, ...whereOf(path), isNew: oldPath === '/dev/null', isDeleted, added: 0, removed: 0, hunks: [] }
      files.push(file)
      continue
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header && file) {
      hunk = { id: '', oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk || !file || line.startsWith('\\')) continue
    const kind = line[0]
    if (kind === '+' || kind === '-' || kind === ' ') {
      hunk.lines.push({ kind, text: line.slice(1) })
      if (kind === '+') file.added++
      if (kind === '-') file.removed++
    }
  }
  for (const f of files) for (const h of f.hunks) h.id = hash(`${f.path}\0${h.lines.map(l => l.kind + l.text).join('\n')}`)
  return files.filter(f => f.hunks.length > 0)
}

// Where `path` is shown, given the project folder and the repository it is in (null: none). A
// repository inside the project is named by its path from it, the project's own by nothing, one
// outside by its folder's name; outside any, the file's folder from the project, or its own name.
// Each named by `/`, on Windows too: as the model reads them and git takes them.
export const whereIn = (path: string, root: string, repo: string | null): Where => {
  const top = repo ?? (below(path, root) !== undefined ? root : parentOf(path))
  const group = samePath(top, root) ? '' : (below(top, root) ?? nameOf(top))
  const rel = below(path, top) ?? path
  return { group, rel, shown: group === '' ? rel : `${group}/${rel}` }
}

// Files as kept by an earlier version of the mod, which named them by `shown` alone: each given
// where it is shown from its path. The session's values outlive a reload of the mod's code.
export const withWhere = (files: readonly FileDiff[], root: string): FileDiff[] =>
  files.map(f => (typeof f.rel === 'string' && typeof f.group === 'string' ? f : { ...f, ...whereIn(f.path, root, null) }))

// A removed line and the added one that took its place, split around what changed between them:
// the common start and end, and each one's middle.
export const changedSpan = (was: string, now: string) => {
  let start = 0
  while (start < was.length && start < now.length && was[start] === now[start]) start++
  let end = 0
  while (end < was.length - start && end < now.length - start && was[was.length - 1 - end] === now[now.length - 1 - end]) end++
  return { head: was.slice(0, start), was: was.slice(start, was.length - end), now: now.slice(start, now.length - end), tail: was.slice(was.length - end) }
}

// Every hunk id, in order: changes with any line of the diff.
export const fingerprintOf = (files: readonly FileDiff[]) => hash(files.flatMap(f => f.hunks.map(h => h.id)).join(','))

const hunkText = (h: Hunk) => `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.map(l => `${l.kind}${l.text}`).join('\n')}`

// The diff for the model to read, each hunk under its id, cut at `limit` characters.
export const diffText = (files: readonly FileDiff[], limit = 80_000) => {
  let text = ''
  for (const f of files) {
    text += `=== ${f.shown}${f.isNew ? ' (new file)' : f.isDeleted ? ' (deleted)' : ''} ===\n`
    for (const h of f.hunks) text += `[hunk ${h.id}]\n${hunkText(h)}\n`
    text += '\n'
    if (text.length > limit) return `${text.slice(0, limit)}\n… (cut)`
  }
  return text
}

// Lines `from` to `to` of a file, each after its number.
const numbered = (lines: readonly string[], from: number, to: number) => {
  const width = String(lines.length).length
  return lines
    .slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(width)}  ${l}`)
    .join('\n')
}

// Whether a file still holds each hunk's new lines where the hunk says: one edited since the diff
// was taken would number its lines otherwise.
const holds = (lines: readonly string[], hunks: readonly Hunk[]) =>
  hunks.every(h => h.lines.filter(l => l.kind !== '-').every((l, k) => lines[h.newStart - 1 + k] === l.text))

// A changed file as `text` holds it now, each line numbered: whole while within `limit`, lines and
// characters both, else the lines around each hunk, `around` on either side; undefined where it no
// longer matches the diff.
export const fileText = (f: FileDiff, text: string, limit: { lines: number; chars: number }, around = 40) => {
  const lines = splitLines(text)
  if (!holds(lines, f.hunks)) return undefined
  if (lines.length <= limit.lines && text.length <= limit.chars) return numbered(lines, 0, lines.length)
  const spans: [number, number][] = []
  for (const h of f.hunks) {
    const from = Math.max(0, h.newStart - 1 - around)
    const to = Math.min(lines.length, h.newStart - 1 + h.lines.filter(l => l.kind !== '-').length + around)
    const last = spans.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else spans.push([from, to])
  }
  return spans.map(([from, to]) => numbered(lines, from, to)).join('\n…\n')
}

// The changed files for the model to read the diff in, each under its shown path, by `texts` (from
// `fileText`, by path; a file with none is left out), cut at `limit` characters.
export const filesText = (files: readonly FileDiff[], texts: Readonly<Record<string, string>>, limit: number) => {
  let text = ''
  for (const f of files) {
    const body = texts[f.path]
    if (body === undefined) continue
    text += `=== ${f.shown} ===\n${body}\n\n`
    if (text.length > limit) return `${text.slice(0, limit)}\n… (cut)`
  }
  return text
}

// A hunk as `git apply` would read it, for Claude to take back.
export const hunkPatch = (f: FileDiff, h: Hunk) => `--- a/${f.shown}\n+++ b/${f.shown}\n${hunkText(h)}`

const parsed = (text: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

// The JSON value in a model's reply: the last fenced block that holds one, else the first span
// from an opening bracket to the last closing one that parses, so what the model reasoned before it
// is passed over; undefined where there is none.
const jsonIn = (text: string, open: '[' | '{', close: ']' | '}'): unknown => {
  for (const m of [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].reverse()) {
    const body = m[1]!.trim()
    const r = body.startsWith(open) ? parsed(body) : undefined
    if (r) return r.value
  }
  const end = text.lastIndexOf(close)
  for (let i = text.indexOf(open); i !== -1 && i < end; i = text.indexOf(open, i + 1)) {
    const r = parsed(text.slice(i, end + 1))
    if (r) return r.value
  }
  return undefined
}

const SEVERITIES = ['bug', 'rule', 'note'] as const

// The review's findings from its JSON array, each with an id made from what it says.
export const parseFindings = (text: string): Finding[] | undefined => {
  const items = jsonIn(text, '[', ']')
  if (!Array.isArray(items)) return undefined
  return items.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const { file, line, severity, text: said, rule } = item as Record<string, unknown>
    if (typeof file !== 'string' || typeof said !== 'string' || said.trim() === '') return []
    const level = SEVERITIES.find(s => s === severity) ?? 'note'
    return [
      {
        id: hash(`${file}\0${said}`),
        file,
        ...(typeof line === 'number' && line > 0 ? { line } : {}),
        severity: level,
        text: said.trim(),
        ...(typeof rule === 'string' && rule.trim() !== '' ? { rule: rule.trim() } : {}),
      },
    ]
  })
}

// The findings the second look kept, from its JSON array of their numbers (1 the first). Undefined
// when the answer is no such array: what it meant is not known, so nothing is dropped on it.
export const keptFindings = (text: string, findings: readonly Finding[]): Finding[] | undefined => {
  const numbers = jsonIn(text, '[', ']')
  if (!Array.isArray(numbers) || !numbers.every(n => typeof n === 'number')) return undefined
  return findings.filter((_, i) => numbers.includes(i + 1))
}

// The shell commands of a turn as the model reads them: each command, then the end of its output.
export const shellText = (runs: readonly ShellRun[]) =>
  runs.map(r => `$ ${r.command}${r.isError ? '  (failed)' : ''}${r.output ? `\n${r.output}` : ''}`).join('\n\n')

// What each hunk is for, from the model's JSON object by hunk id; ids it was not sent are dropped.
export const parseNotes = (text: string, ids: readonly string[]): Record<string, string> => {
  const notes = jsonIn(text, '{', '}')
  if (typeof notes !== 'object' || notes === null) return {}
  return Object.fromEntries(
    Object.entries(notes as Record<string, unknown>).filter((e): e is [string, string] => ids.includes(e[0]) && typeof e[1] === 'string' && e[1].trim() !== ''),
  )
}

// The paths `git status --porcelain -z` names, each relative to its repository: a rename or a copy
// names its old path after its new one, and both count.
export const parseStatus = (text: string): string[] => {
  const entries = text.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(entries[++i] ?? '')
  }
  return paths.filter(Boolean)
}
