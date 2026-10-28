import type { DocIssue, Finding } from '../../types/setup'
import { CONFIG, DENY, parseConfig, permissionIssues, SETTINGS } from './checks'

// The files the agent and the person both work by, each with one job and a size it may not pass:
// the check of them, as `openspec validate --strict` checks a change. No model is asked.

// The most lines each may hold; a file not named here has no limit of its own.
export const LIMITS: Record<string, number> = {
  'CLAUDE.md': 120,
  'ARCHITECTURE.md': 150,
  'CODING_STANDARDS.md': 300,
  'docs/agents/workflow.md': 120,
  'LENSES.md': 150,
}

// The glossary's old names, which Matt's skills no longer read, and the names they read now.
export const OLD_GLOSSARIES: Record<string, string> = { 'CONTEXT.md': 'GLOSSARY.md', 'CONTEXT-MAP.md': 'GLOSSARY-MAP.md' }

// The files read, by their path from the project's root. The glossaries are the root's, and those
// GLOSSARY-MAP.md names; the ADRs are those of docs/adr/. AGENTS.md counts where CLAUDE.md imports it.
export const DOC_FILES = ['CLAUDE.md', 'AGENTS.md', 'GLOSSARY.md', 'GLOSSARY-MAP.md', 'ARCHITECTURE.md', 'CODING_STANDARDS.md', 'LENSES.md', 'docs/agents/workflow.md', ...Object.keys(OLD_GLOSSARIES)]
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
// definition of a sentence or two on the next line, and the words to avoid. No paths, no code. A
// definition or the words to avoid may wrap onto the lines below; a blank line ends them.
function glossaryIssues(file: string, text: string): DocIssue[] {
  const issues: DocIssue[] = []
  let isTerms = false
  let after: 'term' | 'definition' | 'avoid' | 'note' | null = null
  let isFenced = false
  let definition: { line: number, text: string, term?: string } | null = null
  const endDefinition = () => {
    if (definition && sentences(definition.text) > 2)
      issues.push({ file, line: definition.line, kind: 'glossary-long', ...(definition.term && { detail: definition.term }) })
    definition = null
  }
  lines(text).forEach((raw, i) => {
    const line = raw.trim()
    const at = { file, line: i + 1 }
    if (line.startsWith('```')) {
      endDefinition()
      isFenced = !isFenced
      if (isFenced) issues.push({ ...at, kind: 'glossary-code' })
      return
    }
    if (isFenced) return
    if (line === '') {
      endDefinition()
      if (after !== 'term') after = null
      return
    }
    if (/`[^`]+`/.test(line) && pathsIn(line).length > 0) issues.push({ ...at, kind: 'glossary-path' })
    if (line.startsWith('#')) {
      endDefinition()
      if (/^##\s/.test(line)) isTerms = true
      after = null
      return
    }
    const term = line.match(/^\*\*(.+?)\*\*:\s*(.*)$/)
    if (term) {
      endDefinition()
      isTerms = true
      after = term[2] ? 'definition' : 'term'
      if (term[2]) definition = { line: at.line, text: term[2], term: term[1] }
      return
    }
    if (/^_Avoid_:/i.test(line)) {
      endDefinition()
      if (after !== 'definition') issues.push({ ...at, kind: 'glossary-shape' })
      after = 'avoid'
      return
    }
    // A note of another label (`_In code_:`) is no part of the format: it is told once, not by each
    // line it wraps onto.
    if (/^_[^_]+_:/.test(line)) {
      endDefinition()
      if (isTerms) issues.push({ ...at, kind: 'glossary-shape' })
      after = 'note'
      return
    }
    if (after === 'term') {
      definition = { line: at.line, text: line }
      after = 'definition'
      return
    }
    if (after === 'definition' && definition) {
      definition.text += ` ${line}`
      return
    }
    if (after === 'avoid' || after === 'note') return
    // Before the first term, a line or two on the context; after, every line is a term's.
    if (isTerms) issues.push({ ...at, kind: 'glossary-shape' })
  })
  endDefinition()
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

// The files a CLAUDE.md imports, a line `@path` each, by their path from the root.
export const importsOf = (text: string) => [...text.matchAll(/^@(\S+)\s*$/gm)].map(m => m[1]!.replace(/^\.\//, ''))

// Every issue of the files there are, given the paths they name that are not there. A file that
// is not there is none: each is written once it has something to hold.
export function checkDocs(files: Record<string, string>, missing: ReadonlySet<string>): DocIssue[] {
  const issues: DocIssue[] = []
  for (const [file, text] of Object.entries(files)) {
    const renamed = OLD_GLOSSARIES[file]
    if (renamed) {
      issues.push({ file, kind: 'glossary-name', detail: renamed })
      continue
    }
    const limit = LIMITS[file]
    // What CLAUDE.md imports with `@path` is read into every turn with it, and counts against its size.
    const imported = file === 'CLAUDE.md' ? importsOf(text).filter(f => files[f] !== undefined) : []
    const count = lines(text.trimEnd()).length + imported.reduce((n, f) => n + lines(files[f]!.trimEnd()).length, 0)
    if (limit !== undefined && count > limit) issues.push({ file, kind: 'size', detail: `${count}/${limit}${imported.length > 0 ? ` with ${imported.map(f => `@${f}`).join(', ')}` : ''}` })
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

// The objects of the JSON array an agent's answer ends with; undefined where it holds no such array.
const entriesOf = (answer: string) => {
  const end = answer.lastIndexOf(']')
  for (let at = answer.indexOf('['); at >= 0 && at < end; at = answer.indexOf('[', at + 1)) {
    let list: unknown
    try {
      list = JSON.parse(answer.slice(at, end + 1))
    } catch {
      continue
    }
    if (Array.isArray(list)) return list.filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
  }
  return undefined
}

const said = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// What the docs agent found in an edit to the files: what is wrong, where, how to fix it, and
// whether it blocks.
export const parseFindings = (answer: string): Finding[] | undefined =>
  entriesOf(answer)
    ?.map(f => ({ file: said(f.file), text: said(f.problem), fix: said(f.fix), ...(said(f.severity).toLowerCase() === 'minor' ? { isMinor: true as const } : {}) }))
    .filter(f => f.text !== '')
    .sort((a, b) => Number(a.isMinor ?? false) - Number(b.isMinor ?? false))
    .slice(0, 8)

// The terms the docs agent found in use, in any form or by any name, in lower case: it may spell
// them its own way.
export const parseTermsInUse = (answer: string): string[] | undefined =>
  entriesOf(answer)
    ?.filter(t => t.inUse === true)
    .map(t => said(t.term).toLowerCase())
    .filter(t => t !== '')

// The project's files as the check reads them, by their path from the root: the engine's in the
// mod, the disk's in the CLI.
export type Disk = {
  read: (rel: string) => Promise<string | undefined>
  exists: (rel: string) => Promise<boolean>
  list: (rel: string) => Promise<{ name: string; kind: 'file' | 'dir' }[]>
}

// The files the check reads: those named, the glossaries the map links, the ADRs.
export async function readDocs(disk: Disk) {
  const files: Record<string, string> = {}
  const take = async (rel: string) => {
    const text = await disk.read(rel)
    if (text !== undefined) files[rel] = text
  }
  await Promise.all(DOC_FILES.map(take))
  if (files['GLOSSARY-MAP.md']) await Promise.all(mappedGlossaries(files['GLOSSARY-MAP.md']).map(take))
  const adrs = await disk.list(ADR_DIR)
  await Promise.all(adrs.filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => take(`${ADR_DIR}/${f.name}`)))
  return files
}

export async function issuesIn(disk: Disk) {
  const files = await readDocs(disk)
  // Missing: not there, where it claims the project's own folder.
  const named = pathsNamed(files)
  const missing = await Promise.all(named.map(async p => !(await disk.exists(p)) && (!p.includes('/') || (await disk.exists(firstOf(p))))))
  return [...checkDocs(files, new Set(named.filter((_, i) => missing[i]))), ...(await harnessIssues(disk))]
}

// The checks' file out of its form; the settings missing a rule of those every project gets, once
// they hold one of them: a settings file the permissions step has not reached is the project's.
export async function harnessIssues(disk: Disk) {
  const [config, settings] = await Promise.all([disk.read(CONFIG), disk.read(SETTINGS)])
  const issues = config === undefined ? [] : parseConfig(config).issues
  if (settings !== undefined) {
    const found = permissionIssues(settings)
    if (found.some(i => i.kind === 'permissions-shape') || DENY.some(rule => settings.includes(rule))) issues.push(...found)
  }
  return issues
}

// The `rules` of OpenSpec's config as YAML holds them, its comments taken out: a whole line of one,
// and one after a value, where the `#` stands outside quotes; the lines of a block scalar (`|`, `>`)
// are text, a `#` among them too. It ends at the next key of the top level, which no comment is.
export function rulesSection(config: string) {
  const lines = config.split(/\r?\n/)
  const at = lines.findIndex(l => /^rules:/.test(l))
  if (at < 0) return undefined
  const out: string[] = []
  let block: number | null = null
  for (const [i, line] of lines.slice(at).entries()) {
    const indent = line.length - line.trimStart().length
    if (block !== null && (line.trim() === '' || indent > block)) {
      out.push(line)
      continue
    }
    block = null
    if (i > 0 && /^[^\s#]/.test(line)) break
    if (/^\s*#/.test(line)) continue
    const value = withoutComment(i === 0 ? line.slice('rules:'.length) : line)
    if (/(^\s*|:\s+|-\s+)[|>][-+0-9]*\s*$/.test(value)) block = indent
    out.push(value)
  }
  return out.join('\n')
}

// A line of YAML up to its comment: a `#` after a space, outside quotes. A quote opens a scalar only
// where one starts (after a key, a dash, a bracket, a comma, or at the start), so the apostrophe of
// plain text opens none; a double-quoted one takes its escapes.
function withoutComment(line: string) {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote === '"' && c === '\\') i++
    else if (quote === "'" && c === "'" && line[i + 1] === "'") i++
    else if (quote) quote = c === quote ? null : quote
    else if ((c === "'" || c === '"') && /(^|[:\-[{,]\s*|^\s*)$/.test(line.slice(0, i))) quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

// A rule that has OpenSpec's tasks name the lenses they touch: told by the word, in whatever language
// the config is written, under `rules` only, as its `context` names LENSES.md and agent-lens whatever
// its rules say.
export const hasTaskRules = (config: string) => /lens|линз/i.test(rulesSection(config) ?? '')
