import type { CaughtRule } from '../../types/review'
import { hash } from './diff'

// One edit as the check of it reads it: the file, the change told in words, and the text it wrote.
export type Change = { file: string; text: string; added: string }

export type Violation = { rule: string; evidence: string; fix: string }

// The rule files Claude Code reads, and AGENTS.md beside them.
export const RULE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', 'AGENTS.md']

// An edit is sent to the check up to this, on each side of it.
const CHANGE_LIMIT = 20_000

// Asked in English whatever the language in force: what it answers goes to Claude, not to the person.
export const LIVE_SYSTEM = `You review one change an AI coding agent just made to a file, against the project's rules from its CLAUDE.md and AGENTS.md files.
Judge only rules about what files contain: code style, naming, comments, structure, forbidden APIs or patterns, hardcoded values, where code belongs. Ignore rules about workflow, git, communication, tools, testing process or how the agent should behave.
Report a violation only when the NEW text clearly breaks a rule. Text the change removed or kept as it was is not a violation. When unsure, report nothing.
Answer with JSON only: {"violations":[{"rule":"the rule, quoted briefly","evidence":"the offending new text, short, copied exactly","fix":"what to change, one sentence"}]}. No violations: {"violations":[]}.`

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
  `agent-lens: your edit to ${file} breaks the project's CLAUDE.md rules.\n${listed(violations)}\nFix this before moving on.`

export const refusalFor = (file: string, violations: readonly Violation[]) =>
  `agent-lens refused this edit to ${file}: it breaks the project's CLAUDE.md rules.\n${listed(violations)}\nRedo the edit following these rules.`

// The line of `text` the evidence starts on, counted from 1.
export const lineOf = (text: string, evidence: string) => {
  const at = text.indexOf(evidence)
  return at < 0 ? undefined : text.slice(0, at).split('\n').length
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
