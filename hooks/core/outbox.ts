import type { EngineInterface, PluginOptions } from 'claude-code'

import { langIn } from './lang'
import { positive } from './numbers'
import { WORDS } from './words'

// Every prompt a part of this mod sends to the session goes through here, so each main turn is
// known by whose prompt started it: the person's, or a part's, and what for. A part judges only the
// turns of its own prompts; another part's prompt that the engine ran first is no answer to it.

// Who sent the prompt that started a main turn, and what for (a step, the gate, the findings); and,
// where a part tells its prompts apart, which one.
export type Owner = { from: string; tag?: string; batch?: number }
// A prompt sent and not started yet. `key` is how its turn is told, the start of its text; a
// command that runs as if typed has none, and the next turn that starts is its.
type Waiting = Owner & { key: string | null; passed: number }

export const PERSON: Owner = { from: 'person' }
// The start of a prompt that tells its turn: the engine starts the turn with the text sent.
const KEY_LENGTH = 200
// The turns a prompt may see start before its own: past them, the engine dropped it or ran it within
// another, and it waits no more, so nothing waits on it for the rest of the session.
const PASSED_MAX = 5

// The main turns the parts may start by themselves after one prompt of the person's: each is a turn
// of the main model, and one prompt should not set off more than a few. A send the person asked
// for (a key, a command) is not counted. 0: no limit.
const AUTO_TURNS = 3

let waiting: Waiting[] = []
let current: Owner = PERSON
let isUnderway = false
let autoTurns = AUTO_TURNS
// The turns started unasked since the person's last prompt, and whether one more was held back.
let autoUsed = 0
let isAutoHeld = false
// Whether the prompt submitted last runs a slash command: undefined where none was seen since the
// last turn started (a command a part runs may raise none).
let isCommandSubmit: boolean | undefined

export function configureOutbox(options: PluginOptions) {
  autoTurns = options.autoTurns === 0 || options.autoTurns === '0' ? 0 : positive(options.autoTurns, AUTO_TURNS)
}

// Sends `text` as the person's prompt on behalf of `owner`, unasked: it counts against the turns the
// parts may start after one prompt of the person's, and past them it is dropped, as the engine drops
// one, so the part keeps what it would have sent for the next round.
export async function sendAuto($: EngineInterface, owner: Owner, text: string, opts: { asUser?: boolean } = { asUser: true }) {
  if (autoTurns > 0 && autoUsed >= autoTurns) {
    isAutoHeld = true
    return { drop: WORDS[await langIn($).catch(() => 'en' as const)].autoSpent(autoTurns) }
  }
  // Taken before the prompt goes, so two sends at once do not both pass; given back where it did not go.
  autoUsed += 1
  const r = await send($, owner, text, opts).catch((err: unknown) => {
    autoUsed = Math.max(0, autoUsed - 1)
    throw err
  })
  if (r.drop !== undefined) autoUsed = Math.max(0, autoUsed - 1)
  return r
}

// The turns started unasked since the person's last prompt, of how many; whether one was held back.
export const autoNow = () => ({ used: autoUsed, max: autoTurns, isHeld: isAutoHeld })
export const hasAutoLeft = () => autoTurns === 0 || autoUsed < autoTurns
// A part held back what it had to send, as none of those turns is left: the row says so.
export function holdAuto() {
  isAutoHeld = true
}

// A prompt submitted, a slash command's or not: a turn it starts is a command's only where it runs one.
export function noteSubmit(isCommand: boolean) {
  isCommandSubmit = isCommand
}

// Sends `text` as the person's prompt on behalf of `owner`. Where the engine drops it, nothing waits.
export async function send($: EngineInterface, owner: Owner, text: string, opts: { asUser?: boolean } = { asUser: true }) {
  const entry: Waiting = { ...owner, key: text.slice(0, KEY_LENGTH), passed: 0 }
  waiting.push(entry)
  const r = await $.prompt.submit({ text, ...(opts.asUser ? { asUser: true } : {}) }).catch((err: unknown) => {
    drop(entry)
    throw err
  })
  if (r.drop !== undefined) drop(entry)
  return r
}

// A command run as if typed starts a turn of its own: the next turn is `owner`'s. Taken back where
// the command did not run.
export function expectTurn(owner: Owner) {
  const entry: Waiting = { ...owner, key: null, passed: 0 }
  waiting.push(entry)
  return () => drop(entry)
}

const drop = (entry: Waiting) => {
  waiting = waiting.filter(w => w !== entry)
}

// A main turn started with `text`: whose it is. A prompt told by its text first, then a command's, not
// on a turn of a prompt known to run none: the person's own, typed while the command waited.
export function startTurn(text: string): Owner {
  let at = waiting.findIndex(w => w.key !== null && text.includes(w.key))
  if (at < 0 && isCommandSubmit !== false) at = waiting.findIndex(w => w.key === null)
  isCommandSubmit = undefined
  const [matched] = at < 0 ? [] : waiting.splice(at, 1)
  // Another prompt the engine ran within this turn is answered with it, though not one sent again
  // with the same text: that one waits for a turn of its own. The rest saw one more start, counted
  // in place, as a sender takes its own entry back by itself.
  waiting = waiting.filter(w => !(w.key !== null && w.key !== matched?.key && text.includes(w.key)))
  for (const w of waiting) w.passed += 1
  waiting = waiting.filter(w => w.passed <= PASSED_MAX)
  current = matched ? { from: matched.from, ...(matched.tag !== undefined ? { tag: matched.tag } : {}), ...(matched.batch !== undefined ? { batch: matched.batch } : {}) } : PERSON
  // The person's prompt: the parts may start their few turns again.
  if (!matched) {
    autoUsed = 0
    isAutoHeld = false
  }
  isUnderway = true
  return current
}

// The main turn ended: whose it was stays known, as the last one's.
export function endTurn() {
  isUnderway = false
}

// Whose the main turn under way, or the last one, is.
export const turnOwner = (): Owner => current
// Whose the main turn under way is; none between turns.
export const ownerNow = (): Owner | undefined => (isUnderway ? current : undefined)

export const isPerson = (owner: Owner) => owner.from === PERSON.from

// Whether a prompt of `from` (with `tag`, where given; of any part, with neither) is sent and its turn
// not started yet.
export const isWaiting = (from?: string, tag?: string) => waiting.some(w => (from === undefined || w.from === from) && (tag === undefined || w.tag === tag))

// A /clear or /resume: what was sent before is no longer queued for this conversation.
export function clearOutbox() {
  waiting = []
  current = PERSON
  isUnderway = false
  autoUsed = 0
  isAutoHeld = false
  isCommandSubmit = undefined
}
