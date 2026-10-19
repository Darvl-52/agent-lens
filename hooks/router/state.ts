import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Decision, Mode, Setup, Skill, Tab } from '../../types/router'
import { langIn } from '../core/lang'
import { setupOf } from './route'
import { WORDS } from './words'
import type { Words } from './words'

// The session's values live here alone, each read and written through the functions below.

// The router's last few decisions, newest first, for the pane.
const decisionsAtom = atom({ plugin: 'agent-lens', key: 'router.decisions' } as const, [] as Decision[])
// The skills loaded in this conversation so far: the router does not pick them again.
const loadedAtom = atom({ plugin: 'agent-lens', key: 'router.loaded' } as const, [] as string[])
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

export const PANE = 'agent-lens-router'
export const COMMAND = 'router'
const MODE_KEY = 'mode'
const SETUP_KEY = 'setup'
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
  if (mode === 'off') $.ui.status(undefined)
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

export async function addDecision($: EngineInterface, decision: Decision, kept: number) {
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
  const [tab, mode, said, own, project, catalog, decisions, loaded, lang, formSkill, formWords, formHint] = await Promise.all([
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
  ])

  return { tab, mode, said, own, project, catalog, decisions, loaded, lang, formSkill, formWords, formHint }
}

export async function flash($: EngineInterface, text: string | null) {
  await update($, flashAtom, () => text)
}

// The person's setup changed from the pane: saved, and the line under the pane says what was done.
export async function changeSetup($: EngineInterface, change: (own: Setup) => Setup, said: string) {
  await saveSetup($, change(await ownSetup($)))
  await flash($, said)
}
