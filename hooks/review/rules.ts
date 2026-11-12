import type { CaughtRule } from '../../types/review'
import { hash } from './diff'

// One edit as the check of it reads it: the file, the change told in words, and the text it wrote.
export type Change = { file: string; text: string; added: string }

export type Violation = { rule: string; evidence: string; fix: string }

// The rule files Claude Code reads, AGENTS.md beside them, and CODING_STANDARDS.md: the standards
// /setup-project writes, which are read at review rather than on every turn.
export const RULE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', 'AGENTS.md', 'CODING_STANDARDS.md']

// Reading code wants care more than speed: the session's mid-sized model reviews each turn and reads
// the branch through the lenses, unless the settings' `reviewModel` names another.
export const REVIEW_MODEL = 'sonnet'

// A model the settings name, an alias or a full id; none named, `fallback`.
export function modelOf(option: unknown, fallback: string) {
  return typeof option === 'string' && option.trim() !== '' ? option.trim() : fallback
}

// An edit is sent to the check up to this, on each side of it.
const CHANGE_LIMIT = 20_000

// Asked in English whatever the language in force: what it answers goes to Claude, not to the person.
export const LIVE_SYSTEM = `You review one change an AI coding agent just made to a file, against the project's rules from its CLAUDE.md, AGENTS.md and CODING_STANDARDS.md files.
Judge only rules about what files contain: code style, naming, comments, structure, forbidden APIs or patterns, hardcoded values, where code belongs. Ignore rules about workflow, git, communication, tools, testing process or how the agent should behave.
Report a violation only when the NEW text clearly breaks a rule. Text the change removed or kept as it was is not a violation. When unsure, report nothing.
Answer with JSON only: {"violations":[{"rule":"the rule, quoted briefly","evidence":"the offending new text, short, copied exactly","fix":"what to change, one sentence"}]}. No violations: {"violations":[]}.`

// A rule file past `limit` is read by its sections (`## `), each whole, so it may grow as long as the
// project needs: the security rules /setup-project writes, always; then the sections of `files`, the
// files the check is of; then what comes before the first section; then those that name no file. A
// section names its files by paths from the root in backticks (`src/api/`, `src/**/*.test.ts`,
// `*.tsx`); one whose files are none of these is left out, and said to be. The security heading may
// say more after its word (`## Security rules`, `## Безопасность (OWASP)`); `## Securityfoo` and
// `### Cookie security` are no such section.
const SECURITY_HEADING = /^##[ \t]+(?:security|безопасность)(?![\p{L}\p{N}_])[^\n]*$/iu
const KIND = /^\*(\.[\w-]+)+$/

// The paths and globs in backticks: a kind of file (`*.tsx`), or a path whose first folder `tops`,
// the root's, has, so `try/catch`, `@types/node` or `/setup-project` are none.
const filesNamed = (text: string, tops: ReadonlySet<string>) =>
  [...text.matchAll(/`([^`\n]+)`/g)]
    .map(m => m[1]!.trim().replace(/^\.?\//, ''))
    .filter(t => KIND.test(t) || (/^[\w.@*-]+(\/[\w.@*-]*)+$/.test(t) && (t.startsWith('**/') || tops.has(t.split('/')[0]!))))

// Whether a path named in the rules is of `file`, both from the root.
function isOf(named: string, file: string) {
  const glob = KIND.test(named) ? `**/${named}` : named
  const body = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\0')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '(?:.*/)?')
    .replace(/\x01/g, '.*')
  const tail = glob.endsWith('/') ? '.*' : glob.includes('*') ? '' : '(?:/.*)?'
  return new RegExp(`^${body}${tail}$`).test(file)
}

const SECURITY = 0
const OF_FILE = 1
const OF_NONE = 2
const OF_OTHERS = 3

export function clipRules(text: string, limit: number, files: readonly string[] = [], tops: ReadonlySet<string> = new Set()) {
  if (text.length <= limit) return text
  const parts = text.split(/^(?=##[ \t])/m)
  const head = /^##[ \t]/.test(parts[0]!) ? '' : parts.shift()!
  if (parts.length === 0) return `${text.slice(0, limit)}\n[... cut]`
  const rankOf = (s: string) => {
    if (SECURITY_HEADING.test(s.split('\n')[0]!)) return SECURITY
    const named = filesNamed(s, tops)
    if (named.length === 0) return OF_NONE
    return files.some(f => named.some(n => isOf(n, f))) ? OF_FILE : OF_OTHERS
  }
  const sections = parts.map(s => ({ s, rank: rankOf(s), isKept: false }))
  let room = limit
  const keep = (rank: number, isForced = false) => {
    for (const section of sections.filter(x => x.rank === rank))
      if (isForced || section.s.length <= room) {
        section.isKept = true
        room -= section.s.length
      }
  }
  keep(SECURITY, true)
  keep(OF_FILE)
  const shownHead = head.trim() === '' || head.length <= room ? head : `${head.slice(0, Math.max(0, room))}\n[... cut]\n\n`
  room -= shownHead.length
  keep(OF_NONE)
  const left = sections.filter(x => !x.isKept).map(x => x.s.split('\n')[0]!.trim())
  const body = sections.filter(x => x.isKept).map(x => x.s)
  return `${shownHead}${body.join('').trimEnd()}${left.length > 0 ? `\n\n[... left out, of other files or past the limit: ${left.join('; ')}]` : ''}\n`
}

// A drive letter or a backslash means a Windows path: compared without case.
export const isRuleFile = (path: string) => {
  const fold = (text: string) => (/^[A-Za-z]:|\\/.test(path) ? text.toLowerCase() : text)
  const at = fold(path.replace(/\\/g, '/'))
  return RULE_NAMES.map(fold).some(name => at === name || at.endsWith(`/${name}`))
}

const clip = (text: string) => (text.length > CHANGE_LIMIT ? `${text.slice(0, CHANGE_LIMIT)}\n[... ${text.length - CHANGE_LIMIT} more characters]` : text)

export const describeEdit = (file: string, before: string, after: string): Change => ({
  file,
  text: `File: ${file}\n\nThe change replaced:\n<<<\n${clip(before)}\n>>>\nwith:\n<<<\n${clip(after)}\n>>>`,
  added: after,
})

export const describeWrite = (file: string, content: string): Change => ({
  file,
  text: `File: ${file}\n\nThe change wrote the whole file:\n<<<\n${clip(content)}\n>>>`,
  added: content,
})

export const parseViolations = (reply: string): Violation[] | undefined => {
  const json = reply.match(/\{[\s\S]*\}/)
  if (!json) return undefined
  try {
    const list = (JSON.parse(json[0]) as { violations?: unknown }).violations
    if (!Array.isArray(list)) return undefined
    return list
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({ rule: String(item.rule ?? '').trim(), evidence: String(item.evidence ?? '').trim(), fix: String(item.fix ?? '').trim() }))
      .filter(item => item.rule)
  } catch {
    return undefined
  }
}

const listed = (violations: readonly Violation[]) =>
  violations.map(v => `- ${v.rule}${v.evidence ? `\n  found: ${v.evidence}` : ''}${v.fix ? `\n  fix: ${v.fix}` : ''}`).join('\n')

// What Claude is told, with the next tool result or once its turn ends.
export const noteFor = (file: string, violations: readonly Violation[]) =>
  `agent-lens: your edit to ${file} breaks the project's rules (CLAUDE.md, CODING_STANDARDS.md).\n${listed(violations)}\nFix this before moving on.`

export const refusalFor = (file: string, violations: readonly Violation[]) =>
  `agent-lens refused this edit to ${file}: it breaks the project's rules (CLAUDE.md, CODING_STANDARDS.md).\n${listed(violations)}\nRedo the edit following these rules.`

// The line of `text` the evidence starts on, counted from 1.
export const lineOf = (text: string, evidence: string) => {
  const at = text.indexOf(evidence)
  return at < 0 ? undefined : text.slice(0, at).split('\n').length
}

// Evidence shorter than this (`//`, `any`) is found in most files: looked for near its line alone.
const SHORT_EVIDENCE = 12
const NEAR_LINES = 5

// Where the evidence is in `text` now: anywhere, for evidence long enough to tell; else within a few
// lines of where it was.
export const lineNear = (text: string, evidence: string, was: number | undefined) => {
  if (evidence.trim().length >= SHORT_EVIDENCE || was === undefined) return lineOf(text, evidence)
  const lines = text.split('\n')
  for (let d = 0; d <= NEAR_LINES; d++)
    for (const n of d === 0 ? [was] : [was - d, was + d]) if (n >= 1 && lines[n - 1]?.includes(evidence)) return n
  return undefined
}

// A violation as a finding on `path`, shown as `shown`: on the line its evidence is on in `now`,
// the file as the edit left it (null where it was refused).
export const caughtOf = (path: string, shown: string, v: Violation, change: Change, now: string | null, state: CaughtRule['state']): CaughtRule => {
  const isKept = v.evidence !== '' && change.added.includes(v.evidence)
  const line = isKept && now !== null ? lineOf(now, v.evidence) : undefined
  return {
    id: hash(`live\0${shown}\0${v.rule}\0${v.evidence}`),
    file: shown,
    ...(line !== undefined ? { line } : {}),
    severity: 'rule',
    text: v.fix || v.rule,
    rule: v.rule,
    path,
    ...(isKept ? { evidence: v.evidence } : {}),
    state,
  }
}
