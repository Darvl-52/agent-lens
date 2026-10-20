import type { EngineInterface } from 'claude-code'

import type { Lang } from '../types'
import { langIn, langOf, setLang } from './core/lang'
import { registerCommand as registerReviewCommand } from './review/review'
import { WORDS as REVIEW_WORDS } from './review/words'
import { registerCommand as registerRouterCommand } from './router/state'
import { WORDS as ROUTER_WORDS } from './router/words'
import { forgetSaid, registerCommand as registerSpecCommand } from './spec/lens'
import { WORDS as SPEC_WORDS } from './spec/words'

// One language for every part: switched by any of the three commands or the router's pane, each
// command is said again in it, and what the spec's model said in the other goes.
export async function switchLang($: EngineInterface, lang: Lang) {
  await setLang($, lang)
  await registerReviewCommand($).catch(() => {})
  await registerSpecCommand($).catch(() => {})
  await registerRouterCommand($).catch(() => {})
  await forgetSaid($).catch(() => {})
}

// `/changes lang ru`, `/spec lang ru`, `/router lang ru`; undefined for anything else the command
// is given, which is the part's own to answer.
export async function langCommand($: EngineInterface, command: 'changes' | 'spec' | 'router', args: string) {
  const [verb = '', arg = ''] = args.trim().split(/\s+/)
  if (verb.toLowerCase() !== 'lang') return undefined
  const lang = langOf(arg.toLowerCase())
  const words = (l: Lang) => (command === 'changes' ? REVIEW_WORDS[l] : command === 'spec' ? SPEC_WORDS[l] : ROUTER_WORDS[l])
  if (lang === undefined) {
    const now = words(await langIn($))
    return { text: now.langUsage }
  }
  await switchLang($, lang)
  return { text: words(lang).langSet }
}
