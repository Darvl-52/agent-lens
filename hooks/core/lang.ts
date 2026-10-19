import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Lang } from '../../types'

// The language every part speaks and its model answers in: what `lang` set last, by any of the
// commands, kept for every session; else the setting's; English where neither says.
const langAtom = atom({ plugin: 'agent-lens', key: 'lang' } as const, null)
const LANG_KEY = 'lang'

// The language as last read, kept by the module too: a /clear empties the session's values and
// the module lives on, so a read falls back here until the language is read again.
let kept: Lang = 'en'
let setting: Lang = 'en'

export const langOf = (value: unknown): Lang | undefined => (value === 'en' || value === 'ru' ? value : undefined)

export async function langIn($: EngineInterface): Promise<Lang> {
  return (await read($, langAtom)) ?? kept
}

// The language saved, read again from the store: at the start, and after a /clear, which empties
// the session's values and fires no session.start.
export async function restoreLang($: EngineInterface) {
  kept = langOf(await $.store.get(LANG_KEY).catch(() => undefined)) ?? setting
  await update($, langAtom, () => kept)
}

export async function setLang($: EngineInterface, lang: Lang) {
  kept = lang
  await update($, langAtom, () => lang)
  await $.store.set(LANG_KEY, lang)
}

export function configureLang(options: PluginOptions) {
  setting = langOf(options.language) ?? 'en'
  kept = setting
}

