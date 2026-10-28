import type { CommandInfo } from 'claude-code'

import type { Change, Mode, Pick, Rule, Setup, Skill } from '../../types/router'

export const NO_SETUP: Setup = { rules: [], hints: {}, ignored: [] }

// How a model call failed, for the status line: the person reads why no skill was picked.
export type Failure = { kind: 'timeout'; seconds: number } | { kind: 'api'; status: number | null; error: string } | { kind: 'unread' }

// What a request is, as the model reads it: only work gets a skill. A question about the work, an
// answer to Claude or a nod would load one for nothing, and Claude, told to, loads it.
export type Kind = 'work' | 'question' | 'continue' | 'chat'
const KINDS: readonly Kind[] = ['work', 'question', 'continue', 'chat']

// At most this many skills for one prompt: two that both fit happen (a spec and a test-first build),
// more is a guess.
export const MAX_PICKS = 2

// The skills the Skill tool can run: the person's and the project's own (`user`), and a plugin's, named
// `<plugin>:<skill>`. A command a mod registers (`$.command.register`) is a plugin's too but carries no
// plugin prefix, and the model cannot run it; built-ins and MCP prompts are not skills. Where the
// engine says which skills it lists for the model (`listed`), the rest are left out: a skill marked
// `disable-model-invocation` is the person's to type, and the Skill tool refuses it. The project's own
// skills come first, marked: a team's skill for a kind of work is the one it means.
export function catalogOf(commands: readonly CommandInfo[], ignored: readonly string[], listed: readonly Listed[] | null = null): Skill[] {
  const isProject = (name: string) => listed?.some(l => l.name === name && l.isProject) ?? false
  const skills = skillsOf(commands)
    .filter(c => listed === null || listed.some(l => l.name === c.name))
    .filter(c => !ignored.includes(c.name))
    .map(c => ({ name: c.name, description: c.description, ...(isProject(c.name) ? { isProject: true } : {}) }))

  return [...skills.filter(s => s.isProject), ...skills.filter(s => !s.isProject)]
}

// A skill the engine lists for the model, and whether it is the project's own.
export type Listed = { name: string; isProject: boolean }

// The skills the Skill tool would not run, which the person types themselves; none where the engine
// does not say.
export function manualOf(commands: readonly CommandInfo[], listed: readonly Listed[] | null): Skill[] {
  return listed === null ? [] : skillsOf(commands).filter(c => !listed.some(l => l.name === c.name)).map(c => ({ name: c.name, description: c.description }))
}

const skillsOf = (commands: readonly CommandInfo[]) => commands.filter(c => c.source === 'user' || (c.source === 'plugin' && c.name.includes(':')))

// The skill a name the person typed means: the name itself, else the one skill whose name ends in
// `:<name>` (`tdd` for `mattpocock-skills:tdd`); undefined where none or several do.
export function resolve(name: string, skills: readonly Skill[]): string | undefined {
  const wanted = name.trim().replace(/^\//, '')
  if (skills.some(s => s.name === wanted)) return wanted
  const tails = skills.filter(s => s.name.endsWith(`:${wanted}`))

  return tails.length === 1 ? tails[0]?.name : undefined
}

export const shortOf = (name: string) => name.slice(name.lastIndexOf(':') + 1)

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A rule's `when` as a regex: `/…/flags` as written, else the words matched at the start of a word in
// any case, so `тест` also finds `тесты` and `test` finds `tests` but not `latest`.
export function patternOf(when: string): RegExp | undefined {
  const literal = /^\/(.+)\/([a-z]*)$/.exec(when.trim())
  try {
    if (literal) {
      const [, source = '', flags = ''] = literal

      return new RegExp(source, flags.includes('i') ? flags : `${flags}i`)
    }
    const words = when.trim().split(/\s+/).map(escape).join('\\s+')

    return words === '' ? undefined : new RegExp(`(?:^|[^\\p{L}\\p{N}_])${words}`, 'iu')
  } catch {
    return undefined
  }
}

// The skills the person's rules pick for a prompt, in the rules' order, each once.
export function ruleHits(text: string, rules: readonly Rule[], skills: readonly Skill[]): Pick[] {
  const picks: Pick[] = []
  for (const rule of rules) {
    if (picks.length >= MAX_PICKS || picks.some(p => p.skill === rule.skill)) continue
    if (!skills.some(s => s.name === rule.skill)) continue
    const hit = rule.when.find(when => patternOf(when)?.test(text))
    if (hit !== undefined) picks.push({ skill: rule.skill, why: `rule: ${hit}`, by: 'rule', ...(rule.args ? { args: rule.args } : {}) })
  }

  return picks
}

// Whether the prompt already names a skill (`/tdd`, `mattpocock-skills:tdd`): the person chose, and
// Claude reads the name as well as the router would. A bare name (`docs`, `pdf`) counts only with its
// slash, as it is also a plain word.
export function namesSkill(text: string, skills: readonly Skill[]): boolean {
  return skills.some(
    s =>
      (s.name.includes(':') && text.includes(s.name)) ||
      new RegExp(`(?:^|\\s)/${escape(shortOf(s.name))}(?![\\w:-])`).test(text),
  )
}

// Whether a prompt says too little to route on: a nod, a yes, a word or two. Rules still run on it.
export function isTerse(text: string): boolean {
  const trimmed = text.trim()

  return trimmed.length < 25 && trimmed.split(/\s+/).length < 3
}

// The rules, hints and skills left out, from the store and from the project's file merged: the
// project's rules first, its hint over the person's for the same skill.
export function merge(own: Setup, project: Setup): Setup {
  return {
    rules: [...project.rules, ...own.rules],
    hints: { ...own.hints, ...project.hints },
    ignored: [...new Set([...own.ignored, ...project.ignored])],
  }
}

// A setup as read from JSON someone wrote by hand: what has the right shape is kept, the rest dropped.
export function setupOf(value: unknown): Setup {
  if (typeof value !== 'object' || value === null) return NO_SETUP
  const v = value as Record<string, unknown>
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  const rules = (Array.isArray(v.rules) ? v.rules : []).flatMap((r): Rule[] => {
    if (typeof r !== 'object' || r === null) return []
    const { skill, when, args } = r as Record<string, unknown>
    const words = typeof when === 'string' ? [when] : strings(when)
    if (typeof skill !== 'string' || words.length === 0) return []

    return [{ skill, when: words, ...(typeof args === 'string' && args !== '' ? { args } : {}) }]
  })
  const hints = Object.fromEntries(
    Object.entries(typeof v.hints === 'object' && v.hints !== null ? v.hints : {}).filter(([, h]) => typeof h === 'string'),
  ) as Record<string, string>

  return { rules, hints, ignored: strings(v.ignored) }
}

// A setup's skill names as the person typed them (`tdd`) put as the catalog has them, where one skill
// answers to the name; the rest stay as typed and match nothing until such a skill is installed.
export function resolveSetup(setup: Setup, skills: readonly Skill[]): Setup {
  const full = (name: string) => resolve(name, skills) ?? name

  return {
    rules: setup.rules.map(r => ({ ...r, skill: full(r.skill) })),
    hints: Object.fromEntries(Object.entries(setup.hints).map(([name, hint]) => [full(name), hint])),
    ignored: setup.ignored.map(full),
  }
}

// What the model is told it does: one stable block, so its cache holds across prompts.
export const SYSTEM = `You route a developer's request in Claude Code to the skills that fit it. A skill is a set of instructions Claude loads before doing a kind of work.

First say what kind of request it is, in "kind":
- "work": it asks Claude to do a piece of work a skill could be for: build, change, fix, debug, test, review, plan, write a spec or a document.
- "question": it asks to explain, clarify, check or tell something, however long and however much about code or the work under way ("почему так?", "а где это задаётся?", "можно ли…", "что будет, если…"). A question that also asks to change something is work.
- "continue": it answers Claude or goes on with the same work already under way: a choice between options Claude gave, a correction, "да, делай", "и ещё кнопку туда же". A follow-up that starts a different kind of work ("now write a spec for this", "теперь отревьюй") is work.
- "chat": small talk, thanks, a yes or no.

Pick skills only for "work", and only when one clearly fits the main thing the request asks for; for any other kind, no picks. Skills marked [project] are the project's own: where one fits, pick it over a general skill for the same kind of work (its spec skill over a general spec skill); where none fits, the general skills are there as before. Never pick a skill listed as already loaded. Pick at most ${MAX_PICKS}.

Where the project uses OpenSpec and the request is about one of its changes, name the change in "args" for a skill that works on a change.

Reply with JSON alone: {"kind":"work","picks":[{"skill":"<exact name from the list>","why":"<under 12 words>","args":"<optional>"}]}. No picks: {"kind":"question","picks":[]}.`

// What the model is sent, at most: a skill's description or hint, all the skills, the request. A
// pasted log or file says what it is in its first lines.
export const PROMPT_LIMITS = { description: 400, skills: 40_000, request: 4_000 }

export type Context = {
  skills: readonly Skill[]
  hints: Record<string, string>
  loaded: readonly string[]
  changes: readonly Change[] | null
  previous?: string
  answer?: string
}

// The request as the model reads it: the skills (the long part, the same from prompt to prompt, so it
// opens the message and is cached), then what is going on, then the request.
export function promptOf(text: string, c: Context): { skills: string; rest: string } {
  const cut = (s: string, room: number) => (s.length > room ? `${s.slice(0, room - 1)}…` : s)
  const skills = c.skills
    .map(s => `- ${s.name}${s.isProject ? ' [project]' : ''}: ${cut(s.description, PROMPT_LIMITS.description)}${c.hints[s.name] ? ` [The developer says: use it ${cut(c.hints[s.name]!, PROMPT_LIMITS.description)}]` : ''}`)
    .join('\n')
    .slice(0, PROMPT_LIMITS.skills)
  const changes =
    c.changes === null
      ? ''
      : c.changes.length === 0
        ? 'The project uses OpenSpec; no change is in progress.\n\n'
        : `The project uses OpenSpec. Changes in progress (tasks done/total): ${c.changes.map(ch => `${ch.name} (${ch.done}/${ch.total})`).join(', ')}.\n\n`
  const loaded = c.loaded.length > 0 ? `Already loaded: ${c.loaded.join(', ')}.\n\n` : ''
  const before = [
    c.previous ? `The developer's previous request:\n<previous>\n${c.previous}\n</previous>` : '',
    c.answer ? `The end of Claude's last answer:\n<answer>\n${c.answer}\n</answer>` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    skills: `Skills:\n${skills}`,
    rest: `${changes}${loaded}${before ? `${before}\n\n` : ''}The request to route:\n<request>\n${cut(text, PROMPT_LIMITS.request)}\n</request>`,
  }
}

// The first JSON object in a reply; undefined where there is none.
function jsonOf(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    return JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
}

// What the model took the request for; undefined where the reply does not say, and its picks stand.
export function kindOf(reply: string): Kind | undefined {
  const kind = (jsonOf(reply) as { kind?: unknown } | undefined)?.kind

  return KINDS.find(k => k === kind)
}

// The picks in a reply: the first JSON object in it, each pick naming a skill on the list, each once,
// at most MAX_PICKS; undefined where the reply holds no such object.
export function parseReply(reply: string, skills: readonly Skill[]): Pick[] | undefined {
  const raw = (jsonOf(reply) as { picks?: unknown } | undefined)?.picks
  if (!Array.isArray(raw)) return undefined
  const picks: Pick[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const { skill, why, args } = p as Record<string, unknown>
    const name = typeof skill === 'string' ? resolve(skill, skills) : undefined
    if (name === undefined || picks.some(x => x.skill === name)) continue
    picks.push({
      skill: name,
      why: typeof why === 'string' ? why.slice(0, 160) : '',
      by: 'model',
      ...(typeof args === 'string' && args.trim() !== '' ? { args: args.trim() } : {}),
    })
  }

  return picks.slice(0, MAX_PICKS)
}

// What Claude reads beside the prompt: in `auto`, load the skill first; in `suggest`, the skill may fit.
// Either way Claude can say it does not fit and go on.
export function directiveOf(mode: Exclude<Mode, 'off'>, picks: readonly Pick[]): string {
  const line = (p: Pick) =>
    `- \`${p.skill}\`${p.args ? ` with args \`${p.args}\`` : ''}${p.why ? `: ${p.why.replace(/^rule: /, 'the developer set it for prompts that say ')}` : ''}`
  const list = picks.map(line).join('\n')

  return mode === 'auto'
    ? `[skill-router] This request fits the skill${picks.length > 1 ? 's' : ''} below. Before you start, load ${picks.length > 1 ? 'each' : 'it'} with the Skill tool and follow it:\n${list}\nWhere one plainly does not fit once you read it, say so in a line and go on without it.`
    : `[skill-router] This skill may fit the request; load it with the Skill tool if it does:\n${list}`
}

// The tasks of a `tasks.md`: ticked ones out of all of them.
export function progressOf(text: string): { done: number; total: number } {
  const boxes = text.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []

  return { done: boxes.filter(b => /\[[xX]\]/.test(b)).length, total: boxes.length }
}

// A path inside a folder the engine named, joined with the separator the folder already uses; a root
// (`/`, `C:\`) stays a root.
export function join(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'

  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}
