import { expect, mock, test } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { WORDS } from '../hooks/parts/words'

const COMMANDS: CommandInfo[] = [{ name: 'mattpocock-skills:tdd', description: 'Test-driven development.', source: 'plugin', plugin: 'mattpocock-skills' }]
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE = {
  component: 'Pane',
  requestId: 'agent-lens-parts',
  props: { title: 'agent-lens', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// A session with the router's model answering `tdd` to every prompt, and the store kept here so a
// later session reads what an earlier one saved.
async function session($: Engine, on: On, stored: Record<string, unknown> = {}, refused: readonly string[] = []) {
  const store = new Map<string, unknown>(Object.entries(stored))
  const asked: string[] = []
  const entered: (readonly string[])[] = []
  const toasts: string[] = []
  mock.clock(on, { now: 1_000 })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => (refused.includes(e.name) ? { deny: `no ${e.name}` } : { value: { command: e.name } }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.read', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('fs.list', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: {} } as any }))
  on('model.complete', ($, e) => {
    asked.push(e.model)
    return { value: { isAnswered: true as const, text: '{"kind":"work","picks":[{"skill":"tdd","why":"a feature"}]}', usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    entered.push(e.context ?? [])
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const send = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  const run = (command: string, args = '') =>
    $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  return { store, asked, entered, toasts, send, run }
}

test('a security part kept off from before is dropped: no row for it in the menu, nothing added to a prompt, and the rest stands', async ($, on) => {
  const s = await session($, on, { 'parts.off': ['security', 'router'] })
  expect((await s.run('agent-lens')).text).toBe('agent-lens parts opened.')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'toggle-security' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-router' }))?.props.label).toBe('○ off')
  await s.send('Добавь в корзину скидку по промокоду')
  expect(s.entered.at(-1)).toEqual([])
})

test('a part turned off in the menu does none of its work, and its command says where to turn it on', async ($, on) => {
  const s = await session($, on)
  expect((await s.run('agent-lens')).text).toBe('agent-lens parts opened.')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'toggle-router' }))?.props.label).toBe('● on ')
  await ui.press({ key: 'toggle-router' })
  expect((await ui.find({ key: 'toggle-router' }))?.props.label).toBe('○ off')
  expect(s.toasts.at(-1)).toBe('Skill router: off.')
  expect(s.store.get('parts.off')).toEqual(['router'])

  await s.send('Добавь в корзину скидку по промокоду')
  expect(s.asked).toHaveLength(0)
  expect(s.entered.at(-1)).toEqual([])
  expect((await s.run('router', 'list')).text).toBe('Skill router is off. Turn it on in /agent-lens.')

  await ui.press({ key: 'toggle-router' })
  await s.send('Добавь в корзину скидку по промокоду')
  expect(s.asked).toHaveLength(1)
  expect(s.entered.at(-1)?.at(-1)).toContain('`mattpocock-skills:tdd`')
  await ui.unmount()
})

test('what is off stays off in the next session; the review off takes its edit check with it', async ($, on) => {
  const s = await session($, on, { 'parts.off': ['review', 'guard'] })
  expect((await s.run('changes')).text).toBe('Review of changes is off. Turn it on in /agent-lens.')
  expect((await s.run('changes', 'guard')).text).toBe('Guard is off. Turn it on in /agent-lens.')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'toggle-review' }))?.props.label).toBe('○ off')
  expect((await ui.find({ key: 'toggle-live' }))?.props).toMatchObject({ label: '● on ', dimColor: true })
  await ui.press({ key: 'toggle-live' })
  expect((await ui.find({ key: 'toggle-live' }))?.props.label).toBe('○ off')
  expect(s.store.get('parts.off')).toEqual(['review', 'guard', 'live'])
  await ui.unmount()
})

test('/agent-lens counts what a part let fail, with its last error, and the turns started unasked of how many', async ($, on) => {
  await session($, on, {}, ['router'])
  await $.command.run({ command: 'agent-lens', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^router: 1 error, last: .*no router/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Turns started by itself since your prompt: 0/3' })).toBeDefined()
  await ui.unmount()
})

test('the rows of errors and unasked turns read in Russian too', () => {
  expect(WORDS.ru.fault('review', 3, 'x')).toBe('review: 3 ошибки, последняя: x')
  expect(WORDS.ru.fault('setup', 5, 'y')).toBe('setup: 5 ошибок, последняя: y')
  expect(WORDS.ru.auto(3, 3, true)).toBe('Ходов, начатых самим после вашего промпта: 3/3, остальное придержано')
  expect(WORDS.en.auto(2, 0, false)).toBe('Turns started by itself since your prompt: 2, no limit')
})
