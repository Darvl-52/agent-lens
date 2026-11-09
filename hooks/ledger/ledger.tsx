import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { LedgerEntry, LedgerPoint } from '../../types'
import type { PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { autoNow, hasAutoLeft, holdAuto, isPerson, isWaiting, type Owner, send, sendAuto } from '../core/outbox'
import { budgetNow, isOverBudget } from '../core/spend'
import { lensPoints, lensTaken } from '../lenses/lenses'
import { isOn } from '../parts/parts'
import { reviewAside, reviewPoints, reviewTaken } from '../review/review'
import { openPane as openSpec, specQuestions } from '../spec/lens'
import { docsPoints, docsTaken, termsAside, termsPoints, termsTaken } from '../setup/setup'
import { verdictsIn } from './verdicts'
import { WORDS } from './words'

// Claude's verdicts, read where the ledger's turn ends: a module of their own, so a test reads them
// without the parts around.
export { verdictsIn }

// The ledger: what the parts' checks found and nobody answered yet goes to Claude by itself, in one
// prompt, once the session is idle; Claude says of each point whether it fixed it or why it does not
// hold, and a point it rejects that held a second look waits for the person. Each part stays the
// keeper of its own findings and shows them as before; the ledger only takes them, and keeps what
// came of each.

// How much goes to Claude unasked: nothing (by hand), what holds (auto), or the minor points too.
export type Autonomy = 'manual' | 'auto' | 'full'
export type Point = LedgerPoint
type Entry = LedgerEntry
type Source = Entry['source']
const SOURCES: readonly Source[] = ['review', 'lenses', 'docs', 'terms']

const ledgerAtom = atom({ plugin: 'agent-lens', key: 'ledger' } as const, [] as Entry[])
export const PANE = 'agent-lens-decide'
const AUTONOMY_KEY = 'autonomy'
// Rounds of points sent to Claude unasked after one prompt of the person's: each fix is a diff the
// checks read again, and the rounds stop there.
const ROUNDS = 2

let configured: Autonomy = 'auto'
let autonomy: Autonomy = 'auto'
let isMainTurn = false
let rounds = 0
let isFlushing = false
// The last number given: taken before the prompt goes, so two sends at once never share one.
let lastN = 0

const autonomyOf = (value: unknown): Autonomy | undefined => (value === 'manual' || value === 'auto' || value === 'full' ? value : undefined)

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

export function configureLedger(options: PluginOptions) {
  configured = autonomyOf(options.autonomy) ?? 'auto'
  autonomy = configured
}

// Each part keeps its own findings: what it has open, taken to Claude, or put aside by the person.
async function openIn($: EngineInterface, source: Source): Promise<Point[]> {
  if (source === 'review') return isOn('review') ? reviewPoints($) : []
  if (source === 'terms') return isOn('setup') ? termsPoints($) : []
  if (source === 'lenses') return isOn('lenses') ? lensPoints($) : []
  if (source === 'rules') return []
  return isOn('setup') ? docsPoints($) : []
}
async function takenIn($: EngineInterface, source: Source, ids: readonly string[]) {
  if (source === 'review') await reviewTaken($, ids)
  else if (source === 'terms') await termsTaken($, ids)
  else if (source === 'lenses') await lensTaken($, ids)
  else if (source === 'docs') await docsTaken($, ids)
}
async function asideIn($: EngineInterface, source: Source, ids: readonly string[]) {
  if (source === 'review') await reviewAside($, ids)
  else if (source === 'terms') await termsAside($, ids)
  else if (source === 'lenses') await lensTaken($, ids)
  else if (source === 'docs') await docsTaken($, ids)
}

// The setting the person last picked in /agent-lens, over the plugin's, for every session.
export async function restoreLedger($: EngineInterface) {
  autonomy = autonomyOf(await $.store.get(AUTONOMY_KEY).catch(() => undefined)) ?? configured
}

export const autonomyNow = () => autonomy
// Whether what the checks find goes to Claude unasked now: not by hand, and not past the budget.
export const isAutoNow = () => autonomy !== 'manual' && !isOverBudget()

export async function setAutonomy($: EngineInterface, next: Autonomy) {
  autonomy = next
  await $.store.set(AUTONOMY_KEY, next)
  if (next !== 'manual') await flush($)
}

// What is open in every part and not yet sent goes to Claude in one prompt: not during a turn, not
// while a prompt of the mod's waits for its turn (the gate's, a step's, the last one), so the turns
// go one by one, and not past the rounds of the person's last prompt, nor the turns every part may
// start by itself after it.
export async function flush($: EngineInterface) {
  if (!isAutoNow() || isMainTurn || isFlushing || rounds >= ROUNDS || isWaiting()) return
  isFlushing = true
  try {
    const log = await read($, ledgerAtom)
    const known = new Set(log.map(e => e.key))
    const picked: (Point & { source: Source })[] = []
    for (const source of SOURCES)
      for (const p of await openIn($, source).catch(() => [])) if (!known.has(`${source}:${p.id}`) && (autonomy === 'full' || !p.isMinor)) picked.push({ ...p, source })
    if (picked.length === 0) return
    if (!hasAutoLeft()) return void holdAuto()
    if (await dispatch($, picked, { from: 'ledger' }, '', true)) rounds += 1
  } finally {
    isFlushing = false
  }
}

// `count` numbers of the conversation's, the first of them: after the last given and those kept.
async function numbers($: EngineInterface, count: number) {
  const kept = (await read($, ledgerAtom)).reduce((n, e) => Math.max(n, e.n), 0)
  const first = Math.max(lastN, kept) + 1
  lastN = first + count - 1
  return first
}

// The points go to Claude in one numbered prompt, kept as sent, and each part told what it gave;
// unasked, as one of the turns the parts may start by themselves.
async function dispatch($: EngineInterface, picked: readonly (Point & { source: Source })[], owner: Owner, after = '', isAuto = false) {
  const first = await numbers($, picked.length)
  const entries = picked.map((p, i): Entry => ({ ...p, key: `${p.source}:${p.id}`, n: first + i, status: 'sent', batch: first }))
  // Kept as sent before the prompt goes: its turn may end before the send returns.
  const keys = new Set(entries.map(e => e.key))
  const before = (await read($, ledgerAtom)).filter(e => keys.has(e.key))
  await update($, ledgerAtom, all => [...all.filter(e => !keys.has(e.key)), ...entries])
  const putBack = () => update($, ledgerAtom, all => [...all.filter(e => !(keys.has(e.key) && e.batch === first)), ...before])
  const sent = { ...owner, batch: first }
  const text = `${(await wordsIn($)).prompt(entries)}${after}`
  const r = await (isAuto ? sendAuto($, sent, text) : send($, sent, text)).catch(async (err: unknown) => {
    await putBack()
    throw err
  })
  if (r.drop !== undefined) {
    await putBack()
    return false
  }
  for (const source of SOURCES) {
    const ids = picked.filter(p => p.source === source).map(p => p.id)
    if (ids.length > 0) await takenIn($, source, ids).catch(() => {})
  }
  return true
}

// A part's points sent now, whatever the autonomy and the rounds: the person pressed its key, or a
// push waits on them. Whether they went.
export async function sendPoints($: EngineInterface, source: Source, points: readonly Point[], opts: { tag?: string; after?: string } = {}) {
  if (points.length === 0) return false
  return dispatch($, points.map(p => ({ ...p, source })), { from: 'ledger', ...(opts.tag !== undefined ? { tag: opts.tag } : {}) }, opts.after)
}

// A point that is the person's to decide straight away, as Claude went past it: an edit let through
// after its refusals, a rule taken out of a rule file. Agreed, it is put aside; insisted, Claude is
// told to fix it.
export async function toDecide($: EngineInterface, source: Source, point: Point, reason: string) {
  const key = `${source}:${point.id}`
  const was = (await read($, ledgerAtom)).find(e => e.key === key)
  if (was?.status === 'rejected') return
  const n = was?.n ?? (await numbers($, 1))
  await update($, ledgerAtom, (all): Entry[] => {
    if (all.find(e => e.key === key)?.status === 'rejected') return all
    const entry: Entry = { ...point, source, key, n, status: 'rejected', reason, byMod: true }
    return [...all.filter(e => e.key !== key), entry]
  })
}

// What Claude showed does not hold and the person did not overrule: told to the next look, so it is
// not raised again.
export async function settledPoints($: EngineInterface) {
  return (await read($, ledgerAtom)).filter(e => !e.byMod && (e.status === 'rejected' || e.status === 'agreed')).map(e => `${e.where} — ${e.text}${e.reason ? ` (${e.reason})` : ''}`)
}

// Of a part's points Claude answered: how many held, fixed by Claude or by the person's word.
export async function acceptanceOf($: EngineInterface, source: Source) {
  const answered = (await read($, ledgerAtom)).filter(e => e.source === source && e.status !== 'sent')
  return { answered: answered.length, held: answered.filter(e => e.status === 'fixed' || e.status === 'insisted').length }
}

export function startLedgerTurn(owner: Owner) {
  isMainTurn = true
  if (isPerson(owner)) rounds = 0
}

// A main turn ended: a turn of the ledger's prompt says what came of each point; then what the
// checks found meanwhile goes.
export async function endLedgerTurn($: EngineInterface, owner: Owner, answer: string, reason: string) {
  isMainTurn = false
  if (owner.from === 'ledger') {
    // A point the turn left with no word (stopped, or Claude ended with no line for it) waits for
    // the person, as one Claude disputes: sent again by itself it would be the same turn again.
    const said = reason === 'answer' ? verdictsIn(answer) : new Map<number, { isFixed: boolean; reason: string }>()
    const w = await wordsIn($)
    await update($, ledgerAtom, all =>
      all.map((e): Entry => {
        if (e.status !== 'sent' && e.status !== 'insisted') return e
        const v = said.get(e.n)
        if (v) return { ...e, status: v.isFixed ? 'fixed' : 'rejected', ...(v.reason ? { reason: v.reason } : {}) }
        // Only the points of this turn's prompt: another may wait for its own turn.
        return e.status === 'sent' && owner.batch !== undefined && e.batch === owner.batch ? { ...e, status: 'rejected', reason: reason === 'answer' ? w.noWord : w.stopped, isUnanswered: true } : e
      }),
    )
  }
  if (reason === 'answer') await flush($)
}

// Rejected, a point waits for the person; one only likely, of a look that did not show it from the
// code, is closed by Claude's word and stays in the log.
// A point the mod put to the person itself, or one Claude gave no word on: no reason of Claude's to
// weigh, only whether it stays.
const isRaisedByMod = (e: Entry) => e.byMod === true || e.isUnanswered === true
const isDisputed = (e: Entry) => e.status === 'rejected' && (isRaisedByMod(e) || e.confidence !== 'likely')

// The questions of the spec Claude left the person's, where the part is on.
async function questionsIn($: EngineInterface) {
  return isOn('spec') ? specQuestions($).catch(() => 0) : 0
}

export async function decideLine($: EngineInterface) {
  const n = (await read($, ledgerAtom)).filter(isDisputed).length + (await questionsIn($))
  const w = await wordsIn($)
  const { budget, isOver } = budgetNow()
  // The turns the parts started by themselves since the person's prompt, once one more was held back.
  const auto = autoNow()
  const parts = [...(isOver ? [w.overBudget(budget)] : []), ...(auto.isHeld ? [w.autoHeld(auto.used, auto.max)] : []), ...(n > 0 ? [w.band(n)] : [])]
  return parts.length > 0 ? parts.join(' · ') : null
}

export async function openDecide($: EngineInterface) {
  const w = await wordsIn($)
  await $.ui.open({ id: PANE, title: w.title, focus: true, closeOnEscape: true })
  return { text: w.opened }
}

async function agree($: EngineInterface, key: string) {
  const entry = (await read($, ledgerAtom)).find(e => e.key === key)
  if (!entry || !isDisputed(entry)) return
  await update($, ledgerAtom, all => all.map(e => (e.key === key ? { ...e, status: 'agreed' } : e)))
  await asideIn($, entry.source, [entry.id]).catch(() => {})
}

async function insist($: EngineInterface, key: string) {
  const entry = (await read($, ledgerAtom)).find(e => e.key === key)
  if (!entry || !isDisputed(entry)) return
  const w = await wordsIn($)
  const r = await send($, { from: 'ledger', tag: 'insist' }, isRaisedByMod(entry) ? w.insistMod(entry) : w.insist(entry, entry.reason ?? ''))
  if (r.drop === undefined) await update($, ledgerAtom, all => all.map(e => (e.key === key ? { ...e, status: 'insisted' } : e)))
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const w = await wordsIn($)
  const log = await read($, ledgerAtom)
  const disputed = log.filter(isDisputed)
  const sent = log.filter(x => !x.byMod)
  const fixed = sent.filter(x => x.status === 'fixed').length
  const rejected = sent.filter(x => x.status === 'rejected' || x.status === 'agreed' || x.status === 'insisted').length
  const questions = await questionsIn($)
  return (
    <Box flexDirection="column">
      {disputed.length === 0 && questions === 0 ? <Text color="success">{`✓ ${autonomy === 'manual' ? w.noneByHand : w.none}`}</Text> : null}
      {questions > 0 ? (
        <Box flexDirection="row" gap={1}>
          <Text color="warning" wrap="wrap">{w.specQuestions(questions)}</Text>
          <Button key="decide-spec" label={w.openSpec} hotkey="o" onPress={() => void openSpec($, 'decide').catch(() => {})} />
        </Box>
      ) : null}
      {disputed.map((x, i) => (
        <Box key={`decide-${x.n}`} flexDirection="column">
          <Text color="warning" wrap="wrap">{`#${x.n} ${x.where} — ${x.text}`}</Text>
          {x.reason ? <Text dimColor wrap="wrap">{`  ${isRaisedByMod(x) ? x.reason : w.claude(x.reason)}`}</Text> : null}
          <Box flexDirection="row" gap={1} paddingLeft={2}>
            <Button key={`agree-${x.n}`} label={isRaisedByMod(x) ? w.leave : w.agree} {...(i === 0 ? { hotkey: 'y' } : {})} onPress={() => void agree($, x.key).catch(() => {})} />
            <Button key={`insist-${x.n}`} label={isRaisedByMod(x) ? w.fixIt : w.fixAnyway} dimColor {...(i === 0 ? { hotkey: 'f' } : {})} onPress={() => void insist($, x.key).catch(() => {})} />
          </Box>
        </Box>
      ))}
      {sent.length > 0 ? <Text dimColor>{w.stats(sent.length, fixed, rejected)}</Text> : null}
      <Text dimColor>{`${w.autonomy}: ${w.modes[autonomy]}`}</Text>
      {disputed.length > 0 ? <Text dimColor>{w.keys}</Text> : null}
    </Box>
  )
}

// A /clear or /resume: the points of the conversation before are its own.
// What the mod raised itself (a rule taken out, an edit let through) is in the files still: it waits.
export async function clearLedger($: EngineInterface) {
  rounds = 0
  lastN = 0
  isMainTurn = false
  await update($, ledgerAtom, all => all.filter(e => e.byMod && e.status === 'rejected'))
}
