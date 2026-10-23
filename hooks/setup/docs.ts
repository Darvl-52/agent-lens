import type { DocIssue, Finding } from '../../types/setup'

// The files the agent and the person both work by, each with one job and a size it may not pass:
// the check of them, as `openspec validate --strict` checks a change. No model is asked.

// The most lines each may hold; a file not named here has no limit of its own.
export const LIMITS: Record<string, number> = {
  'CLAUDE.md': 120,
  'ARCHITECTURE.md': 150,
  'CODING_STANDARDS.md': 300,
  'docs/agents/workflow.md': 120,
}

// The files read, by their path from the project's root. The glossaries are the root's, and those
// GLOSSARY-MAP.md names; the ADRs are those of docs/adr/.
export const DOC_FILES = ['CLAUDE.md', 'GLOSSARY.md', 'GLOSSARY-MAP.md', 'ARCHITECTURE.md', 'CODING_STANDARDS.md', 'docs/agents/workflow.md']
export const ADR_DIR = 'docs/adr'

const isGlossary = (file: string) => /(^|\/)GLOSSARY\.md$/.test(file)
const isAdr = (file: string) => file.startsWith(`${ADR_DIR}/`)

// The glossaries GLOSSARY-MAP.md links to, by their path from the root.
export const mappedGlossaries = (map: string) =>
  [...map.matchAll(/\]\(\.?\/?([^)\s]+GLOSSARY\.md)\)/g)].map(m => m[1]!.replace(/^\.\//, '')).filter(p => !p.includes('..'))

// A path in backticks, as a file of these names one: a folder and a file, or a file with an
// extension a project keeps. Globs, placeholders, commands and URLs are not paths.
const PATH = /^(?:[\w.@-]+\/)+[\w.@-]*$|^[\w-]+\.(?:md|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|go|rs|rb|java|kt|swift|cs|php|sql|sh)$/
export const pathsIn = (text: string) =>
  [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]!.trim()).filter(p => PATH.test(p) && !/[*<>{}$]|:\/\//.test(p) && !p.startsWith('-') && !p.startsWith('..')))]

// The paths the files name that claim to be the project's, to be looked for from the root: one in a
// folder, and a bare name only where it is one of these files. A bare `package.json` or `tasks.md`
// names a kind of file, not this one; a path whose first folder the root has not (a repository's
// address, a package, an alias) is not the project's, which the caller tells by `firstOf`.
const DOC_NAMES = new Set(DOC_FILES.filter(f => !f.includes('/')))
export const firstOf = (path: string) => path.split('/')[0]!
export function pathsNamed(files: Record<string, string>) {
  const named = new Set<string>()
  for (const [file, text] of Object.entries(files))
    if (!isGlossary(file))
      for (const p of pathsIn(text)) {
        const path = p.replace(/^\.\//, '').replace(/\/$/, '')
        if (path.includes('/') || DOC_NAMES.has(path)) named.add(path)
      }
  return [...named]
}

const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n')
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(s => s.trim() !== '').length

// A glossary is headings, a line or two saying what the context is, and its terms: `**Term**:`, a
// definition of a sentence or two on the next line, and the words to avoid. No paths, no code.
function glossaryIssues(file: string, text: string): DocIssue[] {
  const issues: DocIssue[] = []
  let isTerms = false
  let after: 'term' | 'definition' | 'avoid' | null = null
  let isFenced = false
  lines(text).forEach((raw, i) => {
    const line = raw.trim()
    const at = { file, line: i + 1 }
    if (line.startsWith('```')) {
      isFenced = !isFenced
      if (isFenced) issues.push({ ...at, kind: 'glossary-code' })
      return
    }
    if (isFenced || line === '') return
    if (/`[^`]+`/.test(line) && pathsIn(line).length > 0) issues.push({ ...at, kind: 'glossary-path' })
    if (line.startsWith('#')) {
      if (/^##\s/.test(line)) isTerms = true
      after = null
      return
    }
    const term = line.match(/^\*\*(.+?)\*\*:\s*(.*)$/)
    if (term) {
      isTerms = true
      after = term[2] ? 'definition' : 'term'
      if (term[2] && sentences(term[2]) > 2) issues.push({ ...at, kind: 'glossary-long', detail: term[1] })
      return
    }
    if (/^_Avoid_:/i.test(line)) {
      if (after !== 'definition') issues.push({ ...at, kind: 'glossary-shape' })
      after = 'avoid'
      return
    }
    if (after === 'term') {
      if (sentences(line) > 2) issues.push({ ...at, kind: 'glossary-long' })
      after = 'definition'
      return
    }
    // Before the first term, a line or two on the context; after, every line is a term's.
    if (isTerms) issues.push({ ...at, kind: 'glossary-shape' })
  })
  return issues
}

// ADRs are `NNNN-slug.md`, numbered from 0001 with none skipped or repeated, each with a title.
function adrIssues(adrs: Record<string, string>): DocIssue[] {
  const issues: DocIssue[] = []
  const numbers: number[] = []
  for (const [file, text] of Object.entries(adrs)) {
    const name = file.slice(ADR_DIR.length + 1)
    const m = name.match(/^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)
    if (!m) issues.push({ file, kind: 'adr-name' })
    else numbers.push(Number(m[1]))
    // Its status, where it keeps one, is frontmatter before the title.
    const body = text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '')
    if (!lines(body).find(l => l.trim() !== '')?.startsWith('# ')) issues.push({ file, line: 1, kind: 'adr-title' })
  }
  const sorted = [...numbers].sort((a, b) => a - b)
  sorted.forEach((n, i) => {
    if (n !== i + 1 && !issues.some(x => x.kind === 'adr-numbers')) issues.push({ file: ADR_DIR, kind: 'adr-numbers', detail: String(n) })
  })
  return issues
}

// The same line in two files: a fact kept twice, which drifts apart. Lines short enough to be
// common (a heading, a list's label) do not count, nor a line two ADRs share (a note on how they
// were written).
function duplicateIssues(files: Record<string, string>): DocIssue[] {
  const seen = new Map<string, string>()
  const issues: DocIssue[] = []
  for (const [file, text] of Object.entries(files))
    lines(text).forEach((raw, i) => {
      const line = raw.trim().replace(/^[-*]\s+|^\d+\.\s+/, '')
      if (line.length < 60 || line.startsWith('#') || line.startsWith('|')) return
      const was = seen.get(line)
      if (was === undefined) seen.set(line, file)
      else if (was !== file && !(isAdr(was) && isAdr(file))) issues.push({ file, line: i + 1, kind: 'duplicate', detail: was })
    })
  return issues
}

// Every issue of the files there are, given the paths they name that are not there. A file that
// is not there is none: each is written once it has something to hold.
export function checkDocs(files: Record<string, string>, missing: ReadonlySet<string>): DocIssue[] {
  const issues: DocIssue[] = []
  for (const [file, text] of Object.entries(files)) {
    const limit = LIMITS[file]
    const count = lines(text.trimEnd()).length
    if (limit !== undefined && count > limit) issues.push({ file, kind: 'size', detail: `${count}/${limit}` })
    if (isGlossary(file)) issues.push(...glossaryIssues(file, text))
    else
      lines(text).forEach((line, i) => {
        for (const p of pathsIn(line)) if (missing.has(p.replace(/^\.\//, '').replace(/\/$/, ''))) issues.push({ file, line: i + 1, kind: 'path', detail: p })
      })
  }
  issues.push(...adrIssues(Object.fromEntries(Object.entries(files).filter(([f]) => isAdr(f)))))
  issues.push(...duplicateIssues(files))
  return issues
}

// The terms a glossary defines, by their name before any note in brackets.
export const termsOf = (glossary: string) =>
  [...glossary.matchAll(/^\*\*(.+?)\*\*:/gm)].map(m => m[1]!.replace(/\s*[([].*$/, '').trim()).filter(t => t.length >= 3)

// What the docs agent found in an edit to the files, from the JSON array its answer ends with: what
// is wrong, where, how to fix it, and whether it blocks; undefined where it holds no such array.
export const parseFindings = (answer: string): Finding[] | undefined => {
  const end = answer.lastIndexOf(']')
  for (let at = answer.indexOf('['); at >= 0 && at < end; at = answer.indexOf('[', at + 1)) {
    let list: unknown
    try {
      list = JSON.parse(answer.slice(at, end + 1))
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    const said = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return list
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map(f => ({ file: said(f.file), text: said(f.problem), fix: said(f.fix), ...(said(f.severity).toLowerCase() === 'minor' ? { isMinor: true as const } : {}) }))
      .filter(f => f.text !== '')
      .sort((a, b) => Number(a.isMinor ?? false) - Number(b.isMinor ?? false))
      .slice(0, 8)
  }
  return undefined
}
