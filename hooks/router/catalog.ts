import type { EngineInterface } from 'claude-code'

import type { Change, Pick, Setup, Skill } from '../../types/router'
import { catalogOf, join, manualOf, merge, NO_SETUP, progressOf, resolve, resolveSetup, setupOf, shortOf } from './route'
import type { Listed } from './route'
import { addDecision, holdCatalog, loadedIn, modeIn, ownSetup, wordsIn } from './state'

export const KEPT_DECISIONS = 30

// The skills as last listed, for the typeahead after `/router add `: listing them on each key is
// wasted work.
let catalog: Skill[] = []
// The skills the person alone runs, as last listed, for `/router list` and `/router add`.
let manual: Skill[] = []
// What the pane was last handed, so a prompt that finds the same skills writes nothing.
let held = ''

export function catalogNow() {
  return catalog
}

export function manualNow() {
  return manual
}

// The skills the engine lists for the model, the ones the Skill tool runs, as /context counts them,
// each marked where it is the project's own (its `.claude/skills` or `.claude/commands`); null where
// it does not say, or the listing is cut to its budget and leaves runnable ones out. Asked
// again only when the commands change, as counting the context is not free.
let listedFor = ''
let listed: Listed[] | null = null
async function listedSkills($: EngineInterface, commands: string, isForced: boolean) {
  if (!isForced && commands === listedFor) return listed
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const skills = usage?.context.breakdown?.skills
  listed = skills && skills.includedSkills >= skills.totalSkills ? skills.skillFrontmatter.map(s => ({ name: s.name, isProject: s.source === 'projectSettings' })) : null
  listedFor = commands

  return listed
}

// The project's `.claude/skill-router.json`, where a team keeps the rules everyone routes by; none,
// or one that does not parse, is no rules.
async function projectSetup($: EngineInterface, root: string): Promise<Setup> {
  const text = await $.fs.read(join(join(root, '.claude'), 'skill-router.json')).catch(() => '')
  if (text === '') return NO_SETUP
  try {
    return setupOf(JSON.parse(text))
  } catch {
    return NO_SETUP
  }
}

// The OpenSpec changes in progress, with their tasks; null where the project has no OpenSpec folder.
// Read only for the model, which alone is told of them.
export async function changesIn($: EngineInterface): Promise<Change[] | null> {
  const root = await $.session.root()
  const dir = join(join(root, 'openspec'), 'changes')
  const entries = await $.fs.list(dir).catch(() => null)
  if (entries === null) return null
  const folders = entries.filter(f => f.kind === 'dir' && f.name !== 'archive').slice(0, 12)

  return Promise.all(
    folders.map(async f => {
      const tasks = await $.fs.read(join(join(dir, f.name), 'tasks.md')).catch(() => '')

      return { name: f.name, ...progressOf(tasks.replace(/\r\n/g, '\n')) }
    }),
  )
}

// The skills to route among and the setup in force, the setup's short names made full; the pane is
// handed the whole list and the project's setup where they changed, or `isForced` where its values
// were emptied (a /clear).
export async function lookAround($: EngineInterface, isForced = false) {
  const root = await $.session.root()
  const [commands, own, project] = await Promise.all([$.command.list(), ownSetup($), projectSetup($, root)])
  const listed = await listedSkills($, JSON.stringify(commands), isForced)
  const all = catalogOf(commands, [], listed)
  manual = manualOf(commands, listed)
  const setup = resolveSetup(merge(own, project), all)
  const projects = resolveSetup(project, all)
  catalog = all
  const now = JSON.stringify([all, projects])
  if (isForced || now !== held) {
    held = now
    // The pane's copy: a write refused mid-render leaves it as it was, and routing goes on.
    await holdCatalog($, all, projects).catch(() => {})
  }

  return { skills: all.filter(s => !setup.ignored.includes(s.name)), setup, project: projects }
}

export const isLoaded = (skill: string, loaded: readonly string[]) =>
  loaded.includes(skill) || loaded.includes(shortOf(skill))


export const oneLine = (text: string, room: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > room ? `${line.slice(0, room - 1)}…` : line
}

// OpenSpec's skills for a task and for an archiving, by the names its versions give them.
const SPEC_SKILLS = { task: ['openspec-apply-change', 'opsx:apply'], archive: ['openspec-archive-change', 'opsx:archive'] } as const

// The skill for a task or an archiving the spec's pane sends, which the prompt it sends names, as a
// plugin's own prompt passes by the router: OpenSpec's own, where one is installed, routed among and
// not loaded yet, and the router is not off. No rule and no model asked.
export async function specSkill($: EngineInterface, kind: 'task' | 'archive') {
  if ((await modeIn($)) === 'off') return undefined
  const { skills } = await lookAround($)
  const skill = SPEC_SKILLS[kind].map(name => resolve(name, skills)).find(name => name !== undefined)
  return skill === undefined || isLoaded(skill, await loadedIn($)) ? undefined : skill
}

// Once the prompt naming it went to the session, it is kept with the router's decisions.
export async function sentWithSkill($: EngineInterface, skill: string, prompt: string) {
  const picks: Pick[] = [{ skill, why: (await wordsIn($)).fromSpec, by: 'rule' }]
  await addDecision($, { at: await $.clock.now(), prompt: oneLine(prompt, 200), picks, ms: 0 }, KEPT_DECISIONS)
  $.ui.status((await wordsIn($)).status(shortOf(skill)))
}
