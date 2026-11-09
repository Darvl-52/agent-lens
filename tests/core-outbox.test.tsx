import { expect, test } from 'claude-code/testing'

import { clearFaults, failed, faultsNow } from '../hooks/core/faults'
import { positive } from '../hooks/core/numbers'
import { autoNow, clearOutbox, configureOutbox, expectTurn, hasAutoLeft, isPerson, noteSubmit, send, sendAuto, startTurn } from '../hooks/core/outbox'
import { verdictsIn } from '../hooks/ledger/verdicts'

// The engine as the outbox meets it, no more: each prompt a part submits is kept, and enters, or is
// dropped; the language, unread, is English.
const world = (drop?: string) => {
  const submitted: string[] = []
  const submit = async ({ text }: { text: string }) => (submitted.push(text), drop !== undefined ? { drop } : { text })
  clearOutbox()
  configureOutbox({ autoTurns: 2 } as never)
  return { submitted, engine: { prompt: { submit } } as never }
}

test('a command waiting for its turn does not take the person’s prompt typed meanwhile', () => {
  clearOutbox()
  expectTurn({ from: 'setup', tag: 'matt' })
  noteSubmit(false)
  expect(isPerson(startTurn('fix the cart'))).toBe(true)
  // The command's own turn is still its.
  noteSubmit(true)
  expect(startTurn('Set up the skills of this repository')).toEqual({ from: 'setup', tag: 'matt' })
  // Where no submission was seen (a command that raised none), the next turn is the command's, as before.
  expectTurn({ from: 'setup', tag: 'retro' })
  expect(startTurn('anything')).toEqual({ from: 'setup', tag: 'retro' })
})

test('the parts start so many turns by themselves after a prompt of the person’s; the rest is dropped till the next', async () => {
  const w = world()
  expect(isPerson(startTurn('fix the cart'))).toBe(true)
  for (const n of [1, 2]) expect(await sendAuto(w.engine, { from: 'ledger' }, `points ${n}`)).not.toHaveProperty('drop')
  expect(autoNow()).toEqual({ used: 2, max: 2, isHeld: false })
  expect(hasAutoLeft()).toBe(false)
  expect(await sendAuto(w.engine, { from: 'spec' }, 'holes')).toEqual({ drop: expect.stringMatching(/^agent-lens started 2 turns by itself/) })
  expect(w.submitted).toEqual(['points 1', 'points 2'])
  expect(autoNow().isHeld).toBe(true)
  // A send the person asked for goes whatever is spent.
  expect(await send(w.engine, { from: 'ledger', tag: 'insist' }, 'fix #3')).not.toHaveProperty('drop')
  // The parts' own turns start no new count; the person's next prompt does.
  expect(startTurn('points 1')).toMatchObject({ from: 'ledger' })
  expect(autoNow().used).toBe(2)
  expect(isPerson(startTurn('and the checkout'))).toBe(true)
  expect(autoNow()).toEqual({ used: 0, max: 2, isHeld: false })
  expect(await sendAuto(w.engine, { from: 'spec' }, 'holes')).not.toHaveProperty('drop')
})

test('a send the engine drops is not counted; 0 turns is no limit', async () => {
  const w = world('busy')
  expect(await sendAuto(w.engine, { from: 'ledger' }, 'points')).toEqual({ drop: 'busy' })
  expect(autoNow().used).toBe(0)
  configureOutbox({ autoTurns: 0 } as never)
  expect(hasAutoLeft()).toBe(true)
  configureOutbox({} as never)
  expect(autoNow().max).toBe(3)
})

test('Claude’s verdicts are read in each form it writes them, the Russian short ones too', () => {
  const said = verdictsIn(
    ['#1 fixed', '#2 rejected: the test covers it', '#3 исправлено', '#4 исправлен', '**#5 Исправлена**', '#6 отклонён: так задумано', '#7 отклонен — нет вызова', '#8 отклонено', '- #9 исправил', '#10 отклонила: дубль', '#11 исправленный текст'].join('\n'),
  )
  expect([...said.entries()].map(([n, v]) => [n, v.isFixed, v.reason])).toEqual([
    [1, true, ''],
    [2, false, 'the test covers it'],
    [3, true, ''],
    [4, true, ''],
    [5, true, ''],
    [6, false, 'так задумано'],
    [7, false, 'нет вызова'],
    [8, false, ''],
    [9, true, ''],
    [10, false, 'дубль'],
  ])
})

test('a setting’s number: whole and above zero, or the default', () => {
  expect(positive(60)).toBe(60)
  expect(positive('7', 1)).toBe(7)
  expect(positive(2.6)).toBe(3)
  expect(positive(0.3, 5)).toBe(5)
  expect(positive(0, 5)).toBe(5)
  expect(positive(-3)).toBe(0)
  expect(positive('soon', 9)).toBe(9)
})

test('what a part let fail is counted as its, the last error kept, and what goes on in its place returned', async () => {
  clearFaults()
  expect(await Promise.reject(new Error('no git')).catch(failed('review'))).toBeUndefined()
  expect(await Promise.reject(new TypeError('x is undefined\nat line 3')).catch(failed('review', null))).toBeNull()
  expect(await Promise.reject('gone').catch(failed('spec', []))).toEqual([])
  expect(faultsNow()).toEqual([
    ['review', { count: 2, last: 'TypeError: x is undefined' }],
    ['spec', { count: 1, last: 'gone' }],
  ])
  clearFaults()
  expect(faultsNow()).toEqual([])
})
