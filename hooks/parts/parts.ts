import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Part } from '../../types'
import { langIn } from '../core/lang'
import { WORDS } from './words'

// Which parts are off, kept for every session. Every hook asks before it does its part's work, and
// a hook cannot wait on a read for that, so the module keeps its own copy, read back like the language.
const offAtom = atom({ plugin: 'agent-lens', key: 'parts.off' } as const, null)
const OFF_KEY = 'parts.off'

export const PARTS: readonly Part[] = ['review', 'live', 'spec', 'router', 'guard', 'lenses', 'setup']
export const PANE = 'agent-lens-parts'
const COMMAND = 'agent-lens'

let off: readonly Part[] = []

const partsOf = (value: unknown): Part[] => (Array.isArray(value) ? PARTS.filter(p => value.includes(p)) : [])

// The edit check is the review's: with the review off it is off too.
export const isOn = (part: Part) => !off.includes(part) && (part !== 'live' || !off.includes('review'))

// The switch itself, whatever the review: what the menu shows and turns.
export const isSwitchedOn = (part: Part) => !off.includes(part)

export async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({ name: COMMAND, description: (await wordsIn($)).summary })
}

// What a command of a part turned off answers instead of doing its work.
export async function offText($: EngineInterface, part: Part) {
  const words = await wordsIn($)

  return { text: words.isOff(words.parts[part].name) }
}

export async function offIn($: EngineInterface): Promise<readonly Part[]> {
  return (await read($, offAtom)) ?? off
}

export async function restoreParts($: EngineInterface) {
  off = partsOf(await $.store.get(OFF_KEY).catch(() => undefined))
  await update($, offAtom, () => [...off])
}

export async function setPart($: EngineInterface, part: Part, isOnNow: boolean) {
  off = isOnNow ? off.filter(p => p !== part) : [...off.filter(p => p !== part), part]
  await update($, offAtom, () => [...off])
  await $.store.set(OFF_KEY, off)
}
