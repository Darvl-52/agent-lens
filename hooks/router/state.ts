import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Decision, Feedback, Mode, Setup, Skill, Stats, Tab } from '../../types/router'
import { langIn } from '../core/lang'
import { setupOf } from './route'
import { WORDS } from './words'
import type { Words } from './words'

// The session's values live here alone, each read and written through the functions below.

// The router's last few decisions, newest first, for the pane.
const decisionsAtom = atom({ plugin: 'agent-lens', key: 'router.decisions' } as const, [] as Decision[])
// Every prompt routed this session, counted: the decisions keep the last few alone.
const statsAtom = atom({ plugin: 'agent-lens', key: 'router.stats' } as const, null)
// The skills loaded in this conversation so far: the router does not pick them again.
const loadedAtom = atom({ plugin: 'agent-lens', key: 'router.loaded' } as const, [] as string[])
// The request Claude is grilling the developer about, while it does.
const grillingAtom = atom({ plugin: 'agent-lens', key: 'router.grilling' } as const, null)
// The mode and the person's own setup, as last read from the store, for the pane, which only reads;
// null until read.
const modeAtom = atom({ plugin: 'agent-lens', key: 'router.mode' } as const, null)
const setupAtom = atom({ plugin: 'agent-lens', key: 'router.setup' } as const, null)
// Every skill the Skill tool runs, ignored ones too, and the project's setup, as last looked at.
const catalogAtom = atom({ plugin: 'agent-lens', key: 'router.catalog' } as const, [] as Skill[])
const projectAtom = atom({ plugin: 'agent-lens', key: 'router.project' } as const, null)
// The pane: its tab, the skill and texts in the new-rule form, and the line saying what the last press did.
const tabAtom = atom({ plugin: 'agent-lens', key: 'router.tab' } as const, 'overview')
const formSkillAtom = atom({ plugin: 'agent-lens', key: 'router.formSkill' } as const, null)
const formWordsAtom = atom({ plugin: 'agent-lens', key: 'router.formWords' } as const, '')
const formHintAtom = atom({ plugin: 'agent-lens', key: 'router.formHint' } as const, '')
const flashAtom = atom({ plugin: 'agent-lens', key: 'router.flash' } as const, null)
const flashToneAtom = atom({ plugin: 'agent-lens', key: 'router.flashTone' } as const, 'success' as 'success' | 'warning')

export const PANE = 'agent-lens-router'
export const COMMAND = 'router'
const MODE_KEY = 'mode'
const SETUP_KEY = 'setup'
const FEEDBACK_KEY = 'feedback'
// The sure picks Claude went on without that the model is shown, newest first.
export const KEPT_DECLINED = 8
export const MODES: readonly Mode[] = ['auto', 'suggest', 'off']
export const TABS: readonly Tab[] = ['overview', 'rules', 'skills', 'history']

export const modeOf = (value: unknown): Mode | undefined => MODES.find(m => m === value)

export async function wordsIn($: EngineInterface): Promise<Words> {
  return WORDS[await langIn($)]
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({
    name: COMMAND,
    description: (await wordsIn($)).summary,
    argumentHint: '[auto|suggest|off|add|when|ignore|unignore|rm|list|lang]',
  })
}

export async function modeIn($: EngineInterface): Promise<Mode> {
  const held = await read($, modeAtom)
  if (held !== null) return held
  const mode = modeOf(await $.store.get(MODE_KEY)) ?? 'auto'
  await update($, modeAtom, () => mode)

  return mode
}

export async function setMode($: EngineInterface, mode: Mode) {
  await $.store.set(MODE_KEY, mode)
  await update($, modeAtom, () => mode)
  await showMode($, mode)
}

// Off, the router says so on the status line, so routing is not taken to be on; on, the line is the
// pick's again.
export async function showMode($: EngineInterface, mode: Mode) {
  $.ui.status(mode === 'off' ? (await wordsIn($)).offStatus : undefined)
}

export async function ownSetup($: EngineInterface): Promise<Setup> {
  return setupOf(await $.store.get(SETUP_KEY))
}

export async function saveSetup($: EngineInterface, setup: Setup) {
  await $.store.set(SETUP_KEY, setup)
  await update($, setupAtom, () => setup)
}

// What the store holds read into the session's values the pane draws from.
export async function refreshHeld($: EngineInterface) {
  const [mode, own] = await Promise.all([$.store.get(MODE_KEY), ownSetup($)])
  await update($, modeAtom, () => modeOf(mode) ?? 'auto')
  await update($, setupAtom, () => own)
}

// The skills and the project's setup as `lookAround` last found them, for the pane.
export async function holdCatalog($: EngineInterface, catalog: Skill[], project: Setup) {
  await update($, catalogAtom, () => catalog)
  await update($, projectAtom, () => project)
}

const NO_STATS: Stats = { prompts: 0, withSkill: 0, byRule: 0, byModel: 0, bySkill: {}, taken: 0, declined: 0 }

// The counts with `d` in them.
const counted = (s: Stats, d: Decision): Stats => ({
  prompts: s.prompts + 1,
  withSkill: s.withSkill + (d.picks.length > 0 ? 1 : 0),
  byRule: s.byRule + d.picks.filter(p => p.by === 'rule').length,
  byModel: s.byModel + d.picks.filter(p => p.by === 'model').length,
  bySkill: d.picks.reduce((all, p) => ({ ...all, [p.skill]: (all[p.skill] ?? 0) + 1 }), s.bySkill),
  taken: (s.taken ?? 0) + d.picks.filter(p => p.taken === true).length,
  declined: (s.declined ?? 0) + d.picks.filter(isDeclined).length,
})

// A sure pick Claude went on without: a maybe one it was free to leave.
export const isDeclined = (p: Decision['picks'][number]) => p.taken === false && p.fit !== 'maybe'

// The counts as kept, else as the decisions kept say them (oldest first).
export const statsOf = (stats: Stats | null, decisions: readonly Decision[]) => stats ?? [...decisions].reverse().reduce(counted, NO_STATS)

export async function addDecision($: EngineInterface, decision: Decision, kept: number) {
  const before = await read($, decisionsAtom)
  await update($, statsAtom, s => counted(statsOf(s, before), decision))
  await update($, decisionsAtom, list => [decision, ...list].slice(0, kept))
}

export async function loadedIn($: EngineInterface): Promise<string[]> {
  return read($, loadedAtom)
}

export async function markLoaded($: EngineInterface, skill: string) {
  await update($, loadedAtom, list => (list.includes(skill) ? list : [...list, skill]))
}

export async function forgetLoaded($: EngineInterface) {
  await update($, loadedAtom, () => [])
}

export async function grillingIn($: EngineInterface): Promise<string | null> {
  return read($, grillingAtom)
}

export async function setGrilling($: EngineInterface, request: string | null) {
  await update($, grillingAtom, () => request)
}

const NO_FEEDBACK: Feedback = { bySkill: {}, declined: [] }

// What the router learned of Claude's answers to its picks, in every session and project; a value the
// store holds in another shape is none.
export async function feedbackIn($: EngineInterface): Promise<Feedback> {
  const v = (await $.store.get(FEEDBACK_KEY).catch(() => undefined)) as Partial<Feedback> | undefined
  if (typeof v !== 'object' || v === null) return NO_FEEDBACK
  const bySkill = typeof v.bySkill === 'object' && v.bySkill !== null ? v.bySkill : {}
  const declined = Array.isArray(v.declined) ? v.declined.filter(d => typeof d?.skill === 'string' && typeof d?.prompt === 'string') : []

  return { bySkill, declined }
}

// What Claude did with the picks of the decision made at `at`, once its turn ended: each pick marked
// taken or not, the session's counts and what is learned for good. A maybe pick left is no miss: it
// was offered, not asked for.
export async function recordOutcome($: EngineInterface, at: number, taken: (skill: string) => boolean, judged: readonly string[]) {
  const decisions = await read($, decisionsAtom)
  // The newest decision of that start: the history is newest first.
  const index = decisions.findIndex(d => d.at === at)
  const decision = decisions[index]
  if (decision === undefined) return
  const picks = decision.picks.map(p => (judged.includes(p.skill) ? { ...p, taken: taken(p.skill) } : p))
  const marked = picks.filter(p => p.taken !== undefined)
  if (marked.length === 0) return
  await update($, decisionsAtom, list => list.map((d, i) => (i === index && d.at === at ? { ...d, picks } : d)))
  await update($, statsAtom, s => {
    const now = statsOf(s, decisions)
    return { ...now, taken: (now.taken ?? 0) + marked.filter(p => p.taken).length, declined: (now.declined ?? 0) + marked.filter(isDeclined).length }
  })
  const learned = await feedbackIn($)
  const bySkill = { ...learned.bySkill }
  for (const p of marked.filter(p => p.fit !== 'maybe')) {
    const was = bySkill[p.skill] ?? { offered: 0, taken: 0 }
    bySkill[p.skill] = { offered: was.offered + 1, taken: was.taken + (p.taken ? 1 : 0) }
  }
  const missed = marked.filter(isDeclined).map(p => ({ skill: p.skill, prompt: decision.prompt, at }))
  await $.store.set(FEEDBACK_KEY, { bySkill, declined: [...missed, ...learned.declined].slice(0, KEPT_DECLINED) })
}

export async function setTab($: EngineInterface, tab: Tab) {
  await update($, tabAtom, () => tab)
}

export async function setFormSkill($: EngineInterface, skill: string) {
  await update($, formSkillAtom, () => skill)
}

export async function setFormWords($: EngineInterface, text: string) {
  await update($, formWordsAtom, () => text)
}

export async function setFormHint($: EngineInterface, text: string) {
  await update($, formHintAtom, () => text)
}

// Everything the pane draws, read at once; drawing only reads.
export async function paneState($: EngineInterface) {
  const [tab, mode, said, own, project, catalog, decisions, loaded, lang, formSkill, formWords, formHint, stats, saidTone] = await Promise.all([
    read($, tabAtom),
    read($, modeAtom),
    read($, flashAtom),
    read($, setupAtom),
    read($, projectAtom),
    read($, catalogAtom),
    read($, decisionsAtom),
    read($, loadedAtom),
    langIn($),
    read($, formSkillAtom),
    read($, formWordsAtom),
    read($, formHintAtom),
    read($, statsAtom),
    read($, flashToneAtom),
  ])

  return { tab, mode, said, own, project, catalog, decisions, loaded, lang, formSkill, formWords, formHint, stats: statsOf(stats, decisions), saidTone: saidTone ?? 'success' }
}

export async function flash($: EngineInterface, text: string | null, tone: 'success' | 'warning' = 'success') {
  await update($, flashAtom, () => text)
  await update($, flashToneAtom, () => tone)
}

// The person's setup changed from the pane: saved, and the line under the pane says what was done.
export async function changeSetup($: EngineInterface, change: (own: Setup) => Setup, said: string) {
  await saveSetup($, change(await ownSetup($)))
  await flash($, said)
}
