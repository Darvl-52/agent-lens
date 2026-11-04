import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { spanned, stuckOf } from '../hooks/guard/guard'
import { loosens } from '../hooks/parts/parts'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
const MIN = 60_000

// A session with no project around it: each tool call answers by `answer`, a permission is put to
// the person for the tools in `asking`, who takes `askMs` to answer, and a subagent is listed by its task.
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const notified: string[] = []
  const ran: string[] = []
  let answer = (e: { tool: string }) => `${e.tool} ran`
  let callMs = 0
  const asking = new Set<string>()
  let askMs = 0
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '' }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', () => ({ deny: 'spawn git ENOENT' }))
  on('agent.list', () => ({ value: [{ id: 'worker-1', description: 'Backend tasks', type: 'general-purpose', status: 'running' as const }] }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', ($, e) => (notified.push(e.text), { value: { channel: 'terminal' } as never }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.check', async ($, e) => {
    if (!asking.has(e.tool)) return { decision: 'allow' as const }
    await clock.advance(askMs)
    return { decision: 'ask' as const }
  })
  on('tool.call', async ($, e) => {
    if (callMs > 0) await clock.advance(callMs)
    ran.push(e.tool)
    const text = answer(e)
    return { result: text, text } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const start = (agentId?: string) => $.turn.start({ text: 'go', turnId: agentId ?? 'main', ...(agentId ? { agentId } : {}) })
  const end = (agentId?: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: agentId ?? 'main', reason: 'answer', usage: { ...USAGE, model: 'test' }, ...(agentId ? { agentId } : {}) })
  const grep = (pattern: string, agentId?: string) => $.tool.call({ tool: 'Grep', pattern, ...(agentId ? { agentId } : {}) } as never)
  const changes = (args: string) => $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND })
    const texts: string[] = []
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Text') texts.push((node.children ?? []).join(''))
      else for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    await ui.unmount()
    return texts
  }
  return {
    clock,
    store,
    toasts,
    notified,
    ran,
    start,
    end,
    grep,
    changes,
    band,
    asking,
    setAnswer: (f: typeof answer) => (answer = f),
    setCallMs: (ms: number) => (callMs = ms),
    setAskMs: (ms: number) => (askMs = ms),
  }
}

const done = (key: string, result = 'r', isError = false) => ({ key, result, isError })

test('a call is stuck when it repeats with nothing changing, fails again, or goes back and forth', () => {
  expect(stuckOf([done('a'), done('a'), done('a')], 'a')).toEqual({ why: 'repeat', n: 3 })
  // The result moved on: a poll that sees something new each time is no loop.
  expect(stuckOf([done('a', '1'), done('a', '2'), done('a', '3')], 'a')).toBeUndefined()
  expect(stuckOf([done('a'), done('a')], 'a')).toBeUndefined()
  expect(stuckOf([done('a', 'x', true), done('a', 'y', true)], 'a')).toEqual({ why: 'error', n: 2 })
  expect(stuckOf([done('b'), done('a'), done('b'), done('a'), done('b')], 'a')).toEqual({ why: 'pingpong', n: 6 })
  expect(stuckOf([done('b'), done('a'), done('b'), done('a', 'new'), done('b')], 'a')).toBeUndefined()
  expect(stuckOf([done('b'), done('a'), done('b'), done('a'), done('b')], 'c')).toBeUndefined()
})

test('the same call with the same result is refused the fourth time; another call goes through', async ($, on) => {
  const w = await world($, on)
  await w.start()
  for (let i = 0; i < 3; i++) expect(await w.grep('todo')).toMatchObject({ text: 'Grep ran' })
  expect(await w.grep('todo')).toMatchObject({ deny: expect.stringMatching(/same call with the same input, 3 times in a row[\s\S]*Try another way/) })
  expect(w.ran).toHaveLength(3)
  expect(await w.grep('fixme')).toMatchObject({ text: 'Grep ran' })
  // A new turn starts the count over.
  await w.end()
  await w.start()
  expect(await w.grep('fixme')).toMatchObject({ text: 'Grep ran' })
})

test('past half the steps the agent is told to wrap up; past the limit every tool is refused, the person told', async ($, on) => {
  const w = await world($, on)
  await w.changes('guard 60 6')
  await w.start()
  expect(await w.grep('1')).not.toHaveProperty('context')
  await w.grep('2')
  expect(await w.grep('3')).toMatchObject({ context: [expect.stringMatching(/^agent-lens: you have been on this for 0 min and 3 tool calls\. If the end is not near, stop now and report/)] })
  expect(w.toasts.at(-1)).toBe('Claude has run 0 min · 3 steps: told to wrap up.')
  expect(await w.band()).toContain('⏱ Claude · 0 min · 3 steps')
  // The note goes once.
  expect(await w.grep('4')).not.toHaveProperty('context')
  await w.grep('5')
  await w.grep('6')
  expect(await w.grep('7')).toMatchObject({ deny: expect.stringMatching(/past the limit\. Call no more tools\. Answer now: what is done/) })
  expect(await w.grep('8')).toMatchObject({ deny: expect.any(String) })
  expect(w.ran).toHaveLength(6)
  expect(w.notified).toEqual(['Claude stopped at 0 min · 7 steps: it reports what it did.'])
  expect(await w.band()).toContain('■ Claude stopped · 0 min · 7 steps')
  // Its answer ends the turn; the next one starts with a clean count and no row.
  await w.end()
  expect((await w.band()).some(t => /Claude/.test(t))).toBe(false)
  await w.start()
  expect(await w.grep('9')).toMatchObject({ text: 'Grep ran' })
})

test('time counts the agent’s own work: a question to the person and a subagent it waits on are left out', async ($, on) => {
  const w = await world($, on)
  await w.start()
  w.setCallMs(40 * MIN)
  // Forty minutes waiting on the person, and forty on a subagent: none of it the main loop's.
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await $.tool.call({ tool: 'Agent', prompt: 'do it', description: 'Backend tasks' } as never)
  w.asking.add('Bash')
  w.setAskMs(40 * MIN)
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(w.toasts.filter(t => /wrap up/.test(t))).toEqual([])
  // Its own work is counted: thirty minutes in one call passes half the limit.
  w.setCallMs(31 * MIN)
  expect(await w.grep('slow')).toMatchObject({ context: [expect.stringMatching(/for 31 min and 4 tool calls/)] })
})

test('each subagent has its own count, shown by its task; the guard turned off holds none', async ($, on) => {
  const w = await world($, on)
  await w.changes('guard 60 4')
  await w.start()
  await w.start('worker-1')
  for (const p of ['a', 'b']) await w.grep(p, 'worker-1')
  expect(w.toasts.at(-1)).toBe('«Backend tasks» has run 0 min · 2 steps: told to wrap up.')
  // The main loop's count is its own.
  expect(await w.grep('main')).not.toHaveProperty('context')
  for (const p of ['c', 'd']) await w.grep(p, 'worker-1')
  expect(await w.grep('e', 'worker-1')).toMatchObject({ deny: expect.any(String) })
  expect(await w.band()).toContain('■ «Backend tasks» stopped · 0 min · 5 steps')
  await w.end('worker-1')
  expect((await w.band()).some(t => /Backend/.test(t))).toBe(false)

  expect((await w.changes('guard off')).text).toBe('The guard is off: no agent is held to a limit.')
  expect(w.store.get('guard')).toMatchObject({ isOn: false })
  for (let i = 0; i < 6; i++) expect(await w.grep('same')).toMatchObject({ text: 'Grep ran' })
  expect((await w.changes('guard nonsense')).text).toMatch(/^Usage: \/changes guard on/)
  expect((await w.changes('guard on')).text).toMatch(/^The guard is on\. Past 30 min or 2 tool calls/)
})

test('subagents side by side take their time once, not once each', () => {
  expect(spanned([[0, 40], [0, 40]])).toBe(40)
  expect(spanned([[0, 40], [30, 50], [60, 70]])).toBe(60)
  expect(spanned([])).toBe(0)
})

test('a call retried under another name or pace is the same call; a command that polls is no loop', async ($, on) => {
  const w = await world($, on)
  await w.start()
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', description: `try ${i}`, timeout: 1000 * (i + 1) } as never)
  expect(await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'once more' } as never)).toMatchObject({ deny: expect.stringMatching(/same call with the same input/) })
  for (let i = 0; i < 6; i++) expect(await $.tool.call({ tool: 'Bash', command: 'sleep 30 && gh pr checks 12' } as never)).toMatchObject({ text: 'Bash ran' })
  for (let i = 0; i < 6; i++) expect(await $.tool.call({ tool: 'Bash', command: 'until curl -sf localhost:3000/health; do sleep 2; done' } as never)).toMatchObject({ text: 'Bash ran' })
  for (let i = 0; i < 6; i++) expect(await $.tool.call({ tool: 'Bash', command: 'cd app && while true\ndo\n  GH_PAGER= gh run view 7 | tail -3\n  sleep 20\ndone' } as never)).toMatchObject({ text: 'Bash ran' })
  // A wait before the same work is the work again.
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'sleep 5 && npm run build' } as never)
  expect(await $.tool.call({ tool: 'Bash', command: 'sleep 5 && npm run build' } as never)).toMatchObject({ deny: expect.stringMatching(/same call with the same input/) })
})

test('a subagent continued by a message goes on with its count', async ($, on) => {
  const w = await world($, on)
  await w.changes('guard 60 4')
  await w.start('worker-1')
  for (const p of ['a', 'b', 'c']) await w.grep(p, 'worker-1')
  await w.end('worker-1')
  await w.start('worker-1')
  expect(await w.grep('d', 'worker-1')).toMatchObject({ text: 'Grep ran' })
  expect(await w.grep('e', 'worker-1')).toMatchObject({ deny: expect.any(String) })
})

test('the guard is turned off only by the person: the same command from the model or a plugin changes nothing', async ($, on) => {
  const w = await world($, on)
  const run = (kind: string) => $.command.run({ command: 'changes', args: 'guard off', origin: { kind } as never, presentation: { isFullscreen: false, columns: 100 } })
  expect((await run('unclassified')).text).toBe('Only you can change this: a command the agent or another plugin ran does not loosen the checks.')
  expect((await run('plugin')).text).toMatch(/^Only you can change this/)
  expect(w.store.get('guard')).toBeUndefined()
  expect((await run('composer')).text).toMatch(/off/i)
  expect(w.store.get('guard')).toMatchObject({ isOn: false })
})

test('what loosens a check: the guard and the critic set, the baseline kept, the router changed or off', () => {
  for (const [command, args] of [['changes', 'guard off'], ['spec', 'critic off'], ['setup-project', 'baseline'], ['router', 'rm x'], ['router', 'off']] as const) expect([command, args, loosens(command, args)]).toEqual([command, args, true])
  for (const [command, args] of [['changes', 'guard'], ['spec', 'critic'], ['router', 'list'], ['router', 'auto'], ['setup-project', 'check']] as const) expect([command, args, loosens(command, args)]).toEqual([command, args, false])
})
