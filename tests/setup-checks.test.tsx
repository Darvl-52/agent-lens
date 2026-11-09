import { expect, test } from 'claude-code/testing'

import { type Exec, runTier, timingIssues } from '../hooks/setup/checks'

// A shell whose commands each take the time `took` gives them on a clock kept here, a command past
// the time it was given rejecting as the engine's run does; `asked` keeps the time each was given.
const shellOf = (took: Record<string, number>) => {
  let now = 0
  const asked: Record<string, number> = {}
  const exec: Exec = async (argv, cwd, timeoutMs) => {
    if (argv[2] === 'exit 0') return { exitCode: 0, stdout: '', stderr: '' }
    const command = argv.at(-1)!
    asked[command] = timeoutMs
    const ms = took[command] ?? 0
    if (ms > timeoutMs) {
      now += timeoutMs
      throw new Error(`process timed out after ${timeoutMs} ms`)
    }
    now += ms
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, asked, now: () => now }
}

test('a fast check past its time is red and said cut; the full tier keeps its longer time', async () => {
  const s = shellOf({ lint: 1_000, test: 500_000 })
  const fast = await runTier(s.exec, '/proj', { '.': ['lint', 'test'] }, { isFast: true, now: s.now })
  expect(s.asked.lint).toBeLessThanOrEqual(120_000)
  expect(fast.failures.map(f => [f.command, f.exitCode])).toEqual([['test', -1]])
  expect(fast.failures[0]!.output).toMatch(/^timed out: cut at \d+s/)
  // The validation of the step of the checks takes a command cut as too slow for every turn's end.
  expect(timingIssues(fast.timings).map(i => i.kind)).toEqual(['checks-slow'])
  const t = shellOf({ test: 200_000 })
  const full = await runTier(t.exec, '/proj', { '.': ['test'] }, { isFast: false, now: t.now })
  expect(full.failures).toEqual([])
  expect(t.asked.test).toBe(300_000)
})

test('the fast tier as a whole has its time: a command given what is left, those past it red as not run', async () => {
  const s = shellOf({ a: 100_000, b: 100_000, c: 1_000 })
  const { failures, timings } = await runTier(s.exec, '/proj', { '.': ['a', 'b', 'c'] }, { isFast: true, now: s.now })
  // b had what was left of the tier's time, not a whole command's, and was cut there.
  expect(s.asked.b).toBe(80_000)
  expect(failures.map(f => f.command)).toEqual(['b', 'c'])
  expect(failures[1]!.output).toMatch(/^not run: the fast checks ran past their 180s/)
  expect(s.asked.c).toBeUndefined()
  expect(timingIssues(timings).map(i => i.detail)).toEqual(['b (80s)', 'c (not run in time)'])
})
