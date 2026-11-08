import type { CommandInfo } from 'claude-code'

import type { Change, Mode, Pick, Rule, Setup, Skill, Stage } from '../../types/router'

export const NO_SETUP: Setup = { rules: [], hints: {}, ignored: [] }

// How a model call failed, for the status line: the person reads why no skill was picked.
export type Failure = { kind: 'timeout'; seconds: number } | { kind: 'api'; status: number | null; error: string } | { kind: 'unread' }

// What a request is, as the model reads it: only work gets a skill. A question about the work, an
// answer to Claude or a nod would load one for nothing, and Claude, told to, loads it.
export type Kind = 'work' | 'question' | 'continue' | 'chat'
const KINDS: readonly Kind[] = ['work', 'question', 'continue', 'chat']
const STAGES: readonly Stage[] = ['grill', 'spec', 'go']

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

// The words of a nod, a yes or a thanks, in either language.
const NODS = new Set(
  'да ага угу ок окей ok okay yes yep no nope нет давай давайте делай го погнали поехали дальше продолжай continue go on спасибо спс thanks thx понял ясно норм хорошо ладно отлично супер good great fine sure +'.split(' '),
)

// Whether a prompt says too little to route on: a nod, a yes, a thanks. A short request that asks for
// work ("сделай авторизацию") says enough: it is the one most likely to want grilling. Rules still run
// on a nod.
export function isTerse(text: string): boolean {
  const words = text.toLowerCase().split(/[\s,.!?;:()…]+/u).filter(Boolean)

  return words.length <= 4 && words.every(w => NODS.has(w))
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
export const SYSTEM = `You route a developer's request in Claude Code. You decide what kind of request it is, where its work starts, and which skills Claude loads for it. A skill is a set of instructions Claude loads before a kind of work.

"read" comes first: one sentence on what the request asks Claude to deliver, and whether it is settled. Settled means one reading: an engineer new to the project would build the same thing from the request and the exchange before it.

"kind":
- "work": it asks Claude to do a piece of work: build, change, fix, debug, test, review, plan, design, write a spec or a document.
- "question": it asks to explain, clarify, check or tell something, however long and however much about code or the work under way ("почему так?", "а где это задаётся?", "можно ли…", "что будет, если…"). A question that also asks to change something is work.
- "continue": it answers Claude or goes on with the same work already under way: a choice between options Claude gave, an answer to Claude's questions, a correction, "да, делай", "и ещё кнопку туда же". A follow-up that starts a different kind of work ("now write a spec for this", "теперь отревьюй") is work.
- "chat": small talk, thanks, a yes or no.

"stage", for work alone: where the work starts.
- "grill": Claude would have to guess. The goal, the scope or what done looks like reads two or more ways, or the work hinges on a decision that is the developer's (a behaviour, a trade-off, a design choice). Claude questions the developer first. "Сделай авторизацию", "улучши поиск", "добавь кэширование" are grill unless the exchange before settles them.
- "spec": settled and big: a new capability, or a change across several parts of the code, in a project that uses OpenSpec. Claude writes the OpenSpec change first.
- "go": settled, and Claude can start: a bug with its symptom, a change to a named place, a small feature with its behaviour spelled out, work the exchange before has settled.
A request that says to skip the questions ("без вопросов", "сразу делай", "no questions") is spec or go.
"gaps", with grill alone: the open decisions, under 15 words.

"picks", for work in spec or go: the skills for the main thing it asks to deliver. A skill fits when its process is the first thing Claude would do for this request, as its description says when it is used. A request that names a topic ("tests", "docs", "review", "grill") while asking for other work leaves that topic's skill out. Each pick has a "fit": "sure" when the request plainly asks for the skill's kind of work, "maybe" when it might. An empty list beats a wrong pick. Skills marked [project] are the project's own: where one fits, pick it over a general skill for the same kind of work (its spec skill over a general spec skill). Skills listed as already loaded stay out. At most ${MAX_PICKS}.

Where the project uses OpenSpec and the request is about one of its changes, name the change in "args" for a skill that works on a change.

Reply with JSON alone, one of:
{"read":"…","kind":"work","stage":"go","picks":[{"skill":"<exact name from the list>","fit":"sure","why":"<under 12 words>","args":"<optional>"}]}
{"read":"…","kind":"work","stage":"grill","gaps":"<the open decisions>","picks":[]}
{"read":"…","kind":"question","picks":[]}`

// What the model is sent, at most: a skill's description or hint, all the skills, the request. A
// pasted log or file says what it is in its first lines.
export const PROMPT_LIMITS = { description: 400, skills: 40_000, request: 4_000 }

// A sure pick Claude went on without, and the prompt it was for; a skill's track: how often Claude
// loaded its sure picks.
export type Declined = { skill: string; prompt: string }
export type Track = { skill: string; offered: number; taken: number }

export type Context = {
  skills: readonly Skill[]
  hints: Record<string, string>
  loaded: readonly string[]
  changes: readonly Change[] | null
  previous?: string
  answer?: string
  // The request Claude is grilling the developer about, where it is.
  grilling?: string | null
  declined?: readonly Declined[]
  tracks?: readonly Track[]
}

// A skill Claude went on without this often, out of at least so many sure picks, is said to the model
// as one to pick only when sure.
const OFTEN_DECLINED = { offered: 3, share: 0.5 }

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
      ? 'The project does not use OpenSpec.'
      : c.changes.length === 0
        ? 'The project uses OpenSpec; no change is in progress.'
        : `The project uses OpenSpec. Changes in progress (tasks done/total): ${c.changes.map(ch => `${ch.name} (${ch.done}/${ch.total})`).join(', ')}.`
  const often = (c.tracks ?? []).filter(t => t.offered >= OFTEN_DECLINED.offered && t.taken / t.offered < OFTEN_DECLINED.share)
  const declined = c.declined ?? []
  const grilled = c.grilling ? cut(c.grilling, 600) : ''
  const parts = [
    changes,
    c.loaded.length > 0 ? `Already loaded: ${c.loaded.join(', ')}.` : '',
    often.length > 0
      ? `Claude often went on without these sure picks; pick them only for their own kind of work: ${often.map(t => `${t.skill} (loaded ${t.taken} of ${t.offered})`).join(', ')}.`
      : '',
    declined.length > 0 ? `Recent sure picks Claude went on without, as misses to learn from:\n${declined.map(d => `- ${d.skill} for «${cut(d.prompt, 160)}»`).join('\n')}` : '',
    grilled
      ? `Claude is grilling the developer about this request:\n<grilled>\n${grilled}\n</grilled>\nThe developer's answers to its questions are "continue". When the developer says the questions are settled and to go on ("ок, давай", "погнали", "всё, пиши"), it is work settled by the grilling: stage spec where the project uses OpenSpec, else go.`
      : '',
    c.previous ? `The developer's previous request:\n<previous>\n${c.previous}\n</previous>` : '',
    c.answer ? `The end of Claude's last answer:\n<answer>\n${c.answer}\n</answer>` : '',
    `The request to route:\n<request>\n${cut(text, PROMPT_LIMITS.request)}\n</request>`,
  ]

  return { skills: `Skills:\n${skills}`, rest: parts.filter(Boolean).join('\n\n') }
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
    const { skill, why, args, fit } = p as Record<string, unknown>
    const name = typeof skill === 'string' ? resolve(skill, skills) : undefined
    if (name === undefined || picks.some(x => x.skill === name)) continue
    picks.push({
      skill: name,
      why: typeof why === 'string' ? why.slice(0, 160) : '',
      by: 'model',
      ...(typeof args === 'string' && args.trim() !== '' ? { args: args.trim() } : {}),
      ...(fit === 'maybe' ? { fit: 'maybe' as const } : {}),
    })
  }

  return picks.slice(0, MAX_PICKS)
}

// Where the model says the work starts; undefined where it does not say, and the work goes.
export function stageOf(reply: string): Stage | undefined {
  const stage = (jsonOf(reply) as { stage?: unknown } | undefined)?.stage

  return STAGES.find(s => s === stage)
}

// What the model says a request to grill leaves open, cut to a line.
export function gapsOf(reply: string): string | undefined {
  const gaps = (jsonOf(reply) as { gaps?: unknown } | undefined)?.gaps

  return typeof gaps === 'string' && gaps.trim() !== '' ? gaps.trim().slice(0, 160) : undefined
}

// Whether the developer said to skip the questions: such a request is never grilled, whatever the
// model reads in it.
export function skipsQuestions(text: string): boolean {
  return /без\s+(лишних\s+)?вопросов|не\s+(за)?спрашивай|сразу\s+(делай|пиши|реализуй|в\s+код)|no\s+questions|just\s+do\s+it|skip\s+(the\s+)?(grill|questions)/iu.test(text)
}

// The skills of each stage, by the names their versions give them: Matt's grilling, with his domain
// modeling where the project keeps a glossary or ADRs (his grill-with-docs, which Claude cannot load
// itself, is these two); OpenSpec's proposal of a change.
const STAGE_SKILLS = { grill: ['grilling'], docs: ['domain-modeling'], spec: ['openspec-propose', 'opsx:propose', 'opsx-propose'] } as const

// Whether a skill is OpenSpec's proposal of a change, by any of its names.
export const isSpecSkill = (name: string) => STAGE_SKILLS.spec.some(n => name === n || (!n.includes(':') && name.endsWith(`:${n}`)))

// The files that say a project keeps its domain docs, at its root.
export const DOMAIN_DOCS = ['CONTEXT.md', 'CONTEXT-MAP.md', 'GLOSSARY.md', 'GLOSSARY-MAP.md']

// The skills a stage's work starts with, as installed and routed among; none where the stage has no
// skill here (no OpenSpec in the project, grilling not installed), and the work goes as for `go`.
export function stageSkills(stage: Stage, skills: readonly Skill[], project: { hasSpec: boolean; hasDocs: boolean }): string[] {
  const first = (names: readonly string[]) => names.map(n => resolve(n, skills)).find(n => n !== undefined)
  if (stage === 'grill') {
    const grill = first(STAGE_SKILLS.grill)
    const docs = project.hasDocs ? first(STAGE_SKILLS.docs) : undefined
    return grill === undefined ? [] : docs === undefined ? [grill] : [grill, docs]
  }
  const spec = stage === 'spec' && project.hasSpec ? first(STAGE_SKILLS.spec) : undefined

  return spec === undefined ? [] : [spec]
}

// What Claude reads beside the prompt. A stage first: grill the developer, or write the spec, before
// any code; a skill already loaded is followed again for this request. Then the work's skills: in
// `auto`, a sure one is loaded before Claude starts and a maybe one offered; in `suggest`, every one
// is offered. Either way Claude can say one does not fit and go on.
export function directiveOf(mode: Exclude<Mode, 'off'>, picks: readonly Pick[], stage?: { stage: Stage; gaps?: string; loaded: readonly string[]; afterGrilling?: boolean }): string {
  const line = (p: Pick) =>
    `- \`${p.skill}\`${p.args ? ` with args \`${p.args}\`` : ''}${p.why ? `: ${p.why.replace(/^rule: /, 'the developer set it for prompts that say ')}` : ''}`
  const staged = picks.filter(p => p.isStage)
  const work = picks.filter(p => !p.isStage)
  const sure = mode === 'auto' ? work.filter(p => p.fit !== 'maybe') : []
  const maybe = work.filter(p => !sure.includes(p))
  const s = (n: number) => (n > 1 ? 's' : '')
  const loadedNote = (names: string[]) => (names.some(n => stage?.loaded.includes(n)) ? ' (loaded before: follow it again for this request)' : '')
  const names = staged.map(p => `\`${p.skill}\``).join(' and ')
  const stageLine =
    stage === undefined || staged.length === 0
      ? ''
      : stage.stage === 'grill'
        ? mode === 'auto'
          ? `[skill-router] This request leaves decisions open${stage.gaps ? ` (${stage.gaps})` : ''}. Before any plan or code, load ${names} with the Skill tool${loadedNote(staged.map(p => p.skill))} and grill the developer until you share one reading of it${staged.length > 1 ? ', writing the terms and decisions into the project’s docs as they settle' : ''}. Where the code itself settles every open point, say so in a line and go on.`
          : `[skill-router] This request may leave decisions open${stage.gaps ? ` (${stage.gaps})` : ''}; ${names} would grill the developer first.`
        : mode === 'auto'
          ? `[skill-router] ${stage.afterGrilling ? 'The grilling is settled' : 'This request is settled and big'}: load ${names} with the Skill tool${loadedNote(staged.map(p => p.skill))} and write the OpenSpec change ${stage.afterGrilling ? 'from what the grilling settled' : 'first'}, before any code.`
          : `[skill-router] This request may want an OpenSpec change first: ${names}.`

  return [
    stageLine,
    sure.length > 0
      ? `[skill-router] This request fits the skill${s(sure.length)} below. Before you start, load ${sure.length > 1 ? 'each' : 'it'} with the Skill tool and follow it:\n${sure.map(line).join('\n')}\nWhere one plainly does not fit once you read it, say so in a line and go on without it.`
      : '',
    maybe.length > 0 ? `[skill-router] ${maybe.length > 1 ? 'These skills' : 'This skill'} may fit the request; load ${maybe.length > 1 ? 'one' : 'it'} with the Skill tool if it does:\n${maybe.map(line).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
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
