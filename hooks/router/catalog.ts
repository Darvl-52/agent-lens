import type { EngineInterface } from 'claude-code'

import type { Change, Pick, Setup, Skill } from '../../types/router'
import { catalogOf, join, merge, NO_SETUP, progressOf, resolve, resolveSetup, setupOf, shortOf } from './route'
import { addDecision, holdCatalog, loadedIn, modeIn, ownSetup, wordsIn } from './state'

export const KEPT_DECISIONS = 30

// The skills as last listed, for the typeahead after `/router add `: listing them on each key is
// wasted work.
let catalog: Skill[] = []

export function catalogNow() {
  return catalog
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
async function changesIn($: EngineInterface, root: string): Promise<Change[] | null> {
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
// handed the whole list and the project's setup.
export async function lookAround($: EngineInterface) {
  const root = await $.session.root()
  const [commands, own, project, changes] = await Promise.all([
    $.command.list(),
    ownSetup($),
    projectSetup($, root),
    changesIn($, root),
  ])
  const all = catalogOf(commands, [])
  const setup = resolveSetup(merge(own, project), all)
  catalog = all
  await holdCatalog($, all, resolveSetup(project, all))

  return { skills: all.filter(s => !setup.ignored.includes(s.name)), setup, changes }
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
// not loaded yet, and the router is not off. Kept with the router's decisions, with no rule and no
// model asked.
export async function specSkill($: EngineInterface, kind: 'task' | 'archive', prompt: string) {
  if ((await modeIn($)) === 'off') return undefined
  const startedAt = await $.clock.now()
  const { skills } = await lookAround($)
  const skill = SPEC_SKILLS[kind].map(name => resolve(name, skills)).find(name => name !== undefined)
  if (skill === undefined || isLoaded(skill, await loadedIn($))) return undefined
  const picks: Pick[] = [{ skill, why: 'sent from /spec', by: 'rule' }]
  await addDecision($, { at: startedAt, prompt: oneLine(prompt, 200), picks, ms: (await $.clock.now()) - startedAt }, KEPT_DECISIONS)
  $.ui.status((await wordsIn($)).status(shortOf(skill)))
  return skill
}
