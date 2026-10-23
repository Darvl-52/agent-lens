import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, PluginOptions } from 'claude-code'

import type { Alert, Setting, Stuck } from '../../types/guard'
import { langIn } from '../core/lang'
import { WORDS } from './words'

// The guard over each agent's turn, the main loop's and every subagent's alike: a call that repeats
// with nothing changing is refused, as a stuck detector does; past the soft limit of time or tool
// calls the agent is told to wrap up, and past the hard one every tool is refused, so it answers
// with what it did. The limits are counted from the turn's start, each loop on its own.

type CallEvent = Parameters<Hook<'tool.call'>>[1]
type CallNext = Parameters<Hook<'tool.call'>>[2]

const alertsAtom = atom({ plugin: 'agent-lens', key: 'guard.alerts' } as const, {})
const SETTING_KEY = 'guard'
const MAIN = 'main'

// How many calls back a loop is read for a repeat: a repeat is refused the fourth time, a failure
// the third, two calls taken in turn the sixth.
const REPEATS = 3
const FAILURES = 2
const KEPT = 5
// The tools that wait on the person: their time is not the agent's.
const ASKING = new Set(['AskUserQuestion', 'ExitPlanMode'])
// A tool that runs another loop, which keeps its own count: its time is not the caller's.
const DELEGATING = new Set(['Agent', 'Task'])

// One call a loop made and what came of it, by a key of the tool and its input and a hash of the result.
type Done = { key: string; result: string; isError: boolean }
// A loop's turn so far: when it started, its tool calls, the time a person or another loop took,
// its last calls, and how far past its limits it went.
type Loop = { at: number; steps: number; outside: number; done: Done[]; level: 'under' | 'soft' | 'hard' }

const loops = new Map<string, Loop>()
// The calls whose permission was put to the person, by id: the wait is theirs.
const asked = new Set<string>()
let setting: Setting = { isOn: true, minutes: 60, steps: 150 }
let configured: Setting = setting

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

const positive = (value: unknown, or: number) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : or
}

export function configureGuard(options: PluginOptions) {
  configured = { isOn: options.guard !== 'off' && options.guard !== false, minutes: positive(options.guardMinutes, 60), steps: positive(options.guardSteps, 150) }
  setting = configured
}

// What /changes guard set, over the settings, for every session.
export async function restoreGuard($: EngineInterface) {
  const kept = (await $.store.get(SETTING_KEY).catch(() => undefined)) as Partial<Setting> | undefined
  setting = kept ? { isOn: kept.isOn ?? configured.isOn, minutes: positive(kept.minutes, configured.minutes), steps: positive(kept.steps, configured.steps) } : configured
}

// A turn starts: its loop's count starts over. One whose start was missed (a reload) starts at its next call.
export async function startGuardTurn($: EngineInterface, agentId: string | undefined) {
  loops.set(agentId ?? MAIN, { at: await $.clock.now(), steps: 0, outside: 0, done: [], level: 'under' })
  await clearAlert($, agentId ?? MAIN)
}

export async function endGuardTurn($: EngineInterface, agentId: string | undefined) {
  loops.delete(agentId ?? MAIN)
  await clearAlert($, agentId ?? MAIN)
}

// A /clear or /resume: no turn of the conversation before runs on.
export async function clearGuard($: EngineInterface) {
  loops.clear()
  asked.clear()
  await update($, alertsAtom, () => ({}))
}

async function clearAlert($: EngineInterface, id: string) {
  if (id in (await read($, alertsAtom))) await update($, alertsAtom, ({ [id]: _gone, ...rest }) => rest)
}

// A permission put to the person: the call it is for waits on them.
export function checkedGuard(toolUseId: string | undefined, decision: string) {
  if (toolUseId && decision === 'ask') asked.add(toolUseId)
}

// The tool and its input, as the model gave them: the engine's own keys left out.
const keyOf = (e: CallEvent) => {
  const { tool_use_id: _id, agentId: _agent, requestMeta: _meta, consent: _consent, ...input } = e as CallEvent & Record<string, unknown>
  return JSON.stringify(input)
}

const hashOf = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${text.length}:${h >>> 0}`
}

// Whether `key` called now repeats the loop's last calls with nothing changing, and how.
export function stuckOf(done: readonly Done[], key: string): { why: Stuck; n: number } | undefined {
  const last = done.slice(-REPEATS)
  if (last.length === REPEATS && last.every(d => d.key === key && d.result === last[0]!.result)) return { why: 'repeat', n: REPEATS }
  const failed = done.slice(-FAILURES)
  if (failed.length === FAILURES && failed.every(d => d.key === key && d.isError)) return { why: 'error', n: FAILURES }
  // B A B A B, the same results each time, and A now would be the sixth.
  const turns = done.slice(-KEPT)
  if (turns.length === KEPT) {
    const [b, a] = [turns[KEPT - 1]!, turns[KEPT - 2]!]
    const like = (i: number) => ((KEPT - 1 - i) % 2 === 0 ? b : a)
    if (a.key === key && a.key !== b.key && turns.every((d, i) => d.key === like(i).key && d.result === like(i).result)) return { why: 'pingpong', n: KEPT + 1 }
  }
  return undefined
}

// Who a loop is to the person: Claude, or the subagent by the task it was given.
async function whoIs($: EngineInterface, id: string) {
  const w = await wordsIn($)
  if (id === MAIN) return w.main
  const agent = (await $.agent.list().catch(() => [])).find(a => a.id === id)
  return agent?.description ? `«${agent.description}»` : id
}

const minutesOf = (ms: number) => Math.floor(ms / 60_000)

// Every tool call of every loop, before all else that runs on it: a refusal, or what its end needs.
export async function guardBefore($: EngineInterface, e: CallEvent): Promise<{ deny: string } | Held | undefined> {
  if (!setting.isOn) return undefined
  const id = e.agentId ?? MAIN
  const now = await $.clock.now()
  let loop = loops.get(id)
  if (!loop) {
    loop = { at: now, steps: 0, outside: 0, done: [], level: 'under' }
    loops.set(id, loop)
  }
  const w = await wordsIn($)
  const key = keyOf(e)
  const stuck = stuckOf(loop.done, key)
  if (stuck) return { deny: w.stuck(stuck.why, stuck.n) }
  loop.steps++
  const worked = now - loop.at - loop.outside
  if (loop.level === 'hard' || minutesOf(worked) >= setting.minutes || loop.steps > setting.steps) {
    if (loop.level !== 'hard') {
      loop.level = 'hard'
      await alert($, id, worked, loop.steps, true)
    }
    return { deny: w.hard(minutesOf(worked), loop.steps) }
  }
  return { id, key, at: now, loop }
}

// The call ran: its time and result are the loop's, and past the soft limit it carries the note.
type Held = { id: string; key: string; at: number; loop: Loop; deny?: undefined }
type Ran = Awaited<ReturnType<CallNext>>

export async function guardAfter($: EngineInterface, e: CallEvent, held: Held | undefined, ran: Ran): Promise<Ran> {
  if (!held || loops.get(held.id) !== held.loop) return ran
  const { id, key, loop } = held
  const after = await $.clock.now()
  if (ASKING.has(e.tool) || DELEGATING.has(e.tool) || (e.tool_use_id && asked.delete(e.tool_use_id))) loop.outside += after - held.at
  if (ran.deny !== undefined) return ran
  loop.done = [...loop.done, { key, result: hashOf(ran.text ?? JSON.stringify(ran.result ?? null)), isError: ran.isError === true }].slice(-KEPT)
  const worked = after - loop.at - loop.outside
  if (loop.level === 'under' && (minutesOf(worked) >= Math.round(setting.minutes / 2) || loop.steps >= Math.round(setting.steps / 2))) {
    loop.level = 'soft'
    await alert($, id, worked, loop.steps, false)
    const w = await wordsIn($)
    return { ...ran, context: [...(ran.context ?? []), w.soft(minutesOf(worked), loop.steps, setting.minutes, setting.steps)] }
  }
  // Calls run side by side: another may have passed the hard limit meanwhile.
  if (loop.level !== 'under') await alert($, id, worked, loop.steps, (loop.level as Loop['level']) === 'hard', true)
  return ran
}

// The row above the prompt shows the loop from the soft limit on; the person is told as it passes
// each limit, and by a notification once it is stopped, as they may be away.
async function alert($: EngineInterface, id: string, worked: number, steps: number, isStopped: boolean, isQuiet = false) {
  const w = await wordsIn($)
  const was = (await read($, alertsAtom))[id]
  const who = was?.who ?? (await whoIs($, id))
  const minutes = minutesOf(worked)
  const shown: Alert = { who, minutes, steps, ...(isStopped ? { isStopped: true as const } : {}) }
  await update($, alertsAtom, all => ({ ...all, [id]: shown }))
  if (isQuiet) return
  if (isStopped) {
    await $.ui.toast(w.hardToast(who, minutes, steps))
    await $.ui.notify(w.hardToast(who, minutes, steps), { title: w.hardTitle }).catch(() => {})
  } else await $.ui.toast(w.softToast(who, minutes, steps))
}

// The row's text for each loop past its soft limit, the stopped ones first.
export async function guardLines($: EngineInterface) {
  const w = await wordsIn($)
  const alerts = Object.values(await read($, alertsAtom))
  return alerts
    .sort((a, b) => Number(b.isStopped ?? false) - Number(a.isStopped ?? false))
    .map(a => ({ text: a.isStopped ? w.stopped(a.who, a.minutes, a.steps) : w.running(a.who, a.minutes, a.steps), isStopped: a.isStopped === true }))
}

// `/changes guard`, `on`, `off`, or `<minutes> <steps>`; undefined for any other verb.
export async function guardCommand($: EngineInterface, args: string) {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  if (verb.toLowerCase() !== 'guard') return undefined
  const w = await wordsIn($)
  const arg = rest.join(' ').toLowerCase()
  const numbers = arg.match(/^(\d+)\s+(\d+)$/)
  if (arg === 'on' || arg === 'off') setting = { ...setting, isOn: arg === 'on' }
  else if (numbers) setting = { isOn: true, minutes: positive(numbers[1], setting.minutes), steps: positive(numbers[2], setting.steps) }
  else if (arg !== '') return { text: w.usage }
  if (arg !== '') await $.store.set(SETTING_KEY, setting)
  const now = await $.clock.now()
  const running = await Promise.all(
    [...loops].map(async ([id, loop]) => w.running(await whoIs($, id), minutesOf(now - loop.at - loop.outside), loop.steps)),
  )
  return { text: `${w.status(setting.isOn, setting.minutes, setting.steps)}${setting.isOn ? w.loops(running) : ''}` }
}
