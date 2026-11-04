import type { EngineInterface } from 'claude-code'

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

let waiting: Waiting[] = []
let current: Owner = PERSON
let isUnderway = false

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

// A main turn started with `text`: whose it is. A prompt told by its text first, then a command's.
export function startTurn(text: string): Owner {
  let at = waiting.findIndex(w => w.key !== null && text.includes(w.key))
  if (at < 0) at = waiting.findIndex(w => w.key === null)
  const [matched] = at < 0 ? [] : waiting.splice(at, 1)
  // Another prompt the engine ran within this turn is answered with it, though not one sent again
  // with the same text: that one waits for a turn of its own. The rest saw one more start, counted
  // in place, as a sender takes its own entry back by itself.
  waiting = waiting.filter(w => !(w.key !== null && w.key !== matched?.key && text.includes(w.key)))
  for (const w of waiting) w.passed += 1
  waiting = waiting.filter(w => w.passed <= PASSED_MAX)
  current = matched ? { from: matched.from, ...(matched.tag !== undefined ? { tag: matched.tag } : {}), ...(matched.batch !== undefined ? { batch: matched.batch } : {}) } : PERSON
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
}
