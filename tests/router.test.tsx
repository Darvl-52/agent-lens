import { expect, mock, test } from 'claude-code/testing'
import type { CommandInfo, ModelCompleteInput, On, PromptAutocompleteInput, PromptAutocompleteResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const COMMANDS: CommandInfo[] = [
  { name: 'mattpocock-skills:tdd', description: 'Test-driven development.', source: 'plugin', plugin: 'mattpocock-skills' },
  { name: 'mattpocock-skills:diagnosing-bugs', description: 'Diagnosis loop for hard bugs.', source: 'plugin', plugin: 'mattpocock-skills' },
  { name: 'opsx:apply', description: 'Implement the tasks of an OpenSpec change.', source: 'user' },
  { name: 'context-bar', description: 'Toggle the context bar.', source: 'plugin', plugin: 'context-bar-compact' },
  { name: 'help', description: 'Help.', source: 'builtin' },
]
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE = {
  component: 'Pane',
  requestId: 'agent-lens-router',
  props: { title: 'Skill router', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine hands hooks native paths (C:\proj\openspec for /proj/openspec on Windows): the fake disk
// compares them with '/' for separators and without what leads up to a drive letter.
const key = (path: string) => path.replace(/\\/g, '/').replace(/^.*[A-Za-z]:(?=\/)/, '')

type Setup = { files?: Record<string, string>; reply?: string | null; stored?: Record<string, unknown> }

async function router($: Engine, on: On, setup: Setup = {}) {
  const files = new Map(Object.entries(setup.files ?? {}).map(([p, text]) => [key(p), text]))
  const asked: ModelCompleteInput[] = []
  const entered: { text: string; context: readonly string[] }[] = []
  const status: (string | undefined)[] = []
  const opened: string[] = []
  mock.clock(on, { now: 1_000 })
  // The store, kept here so a test can change it as another session would.
  const store = new Map<string, unknown>(Object.entries(setup.stored ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  let commands = COMMANDS
  const reads: string[] = []
  on('command.list', () => ({ value: commands }))
  on('command.register', () => ({ value: { command: 'router' } }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.read', ($, e) => {
    reads.push(key(e.path))
    return files.has(key(e.path)) ? { value: files.get(key(e.path))! } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const dir = key(e.path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys())
      if (p.startsWith(`${dir}/`)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/')
        names.set(name!, rest.length > 0 ? 'dir' : 'file')
      }
    if (names.size === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('model.complete', ($, e) => {
    asked.push(e)
    const reply = setup.reply === undefined ? '{"picks":[]}' : setup.reply
    return reply === null
      ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    entered.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const send = (text: string, origin: { kind: 'composer' | 'sdk' } | { kind: 'plugin'; name: string } = { kind: 'composer' }) =>
    $.prompt.submit({ text, origin, wait: false })
  const run = (args: string) =>
    $.command.run({ command: 'router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  return { asked, entered, status, opened, store, reads, send, run, install: (c: CommandInfo) => (commands = [...commands, c]) }
}

test('with no rule, the model picks and Claude is told to load the skill', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd","why":"a new feature, test-first"}]}' })
  await r.send('Добавь в корзину скидку по промокоду')
  expect(r.asked).toHaveLength(1)
  expect(r.asked[0]!.model).toBe('haiku')
  expect(r.asked[0]!.prompt).toContain('- mattpocock-skills:tdd: Test-driven development.')
  expect(r.asked[0]!.prompt).not.toContain('context-bar')
  expect(r.entered[0]!.context.at(-1)).toContain('`mattpocock-skills:tdd`: a new feature, test-first')
  expect(r.entered[0]!.context.at(-1)).toContain('Before you start, load it with the Skill tool')
  expect(r.status.at(-1)).toBe('skill: tdd')
})

test('a prompt through an SDK host (claude -p, the desktop app) is routed like a typed one', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"diagnosing-bugs","why":"flaky total"}]}' })
  await r.send('В корзине иногда итог считается неправильно, разберись', { kind: 'sdk' })
  expect(r.entered[0]!.context.at(-1)).toContain('`mattpocock-skills:diagnosing-bugs`')
})

test('a rule picks without asking the model; /router add makes one from short names', async ($, on) => {
  const r = await router($, on)
  expect((await r.run('add diagnosing-bugs баг, падает')).text).toBe('Rule added: diagnosing-bugs ← баг, падает')
  await r.send('Тест падает после мержа, разберись')
  expect(r.asked).toHaveLength(0)
  expect(r.entered[0]!.context.at(-1)).toContain('`mattpocock-skills:diagnosing-bugs`')
  expect((await r.run('add nope x')).text).toContain('No skill answers to "nope"')
})

test('the project file adds its rules and when each skill fits', async ($, on) => {
  const r = await router($, on, {
    files: {
      'C:\\proj\\.claude\\skill-router.json': JSON.stringify({ rules: [{ skill: 'apply', when: ['продолжи'], args: 'add-auth' }], hints: { tdd: 'for every new endpoint' } }),
    },
  })
  await r.send('продолжи')
  expect(r.entered[0]!.context.at(-1)).toContain('`opsx:apply` with args `add-auth`')
  await r.send('Сделай новый эндпоинт для заказов')
  expect(r.asked[0]!.prompt).toContain('[The developer says: use it for every new endpoint]')
})

test('OpenSpec changes in progress reach the model, CRLF tasks counted', async ($, on) => {
  const r = await router($, on, {
    files: {
      '/proj/openspec/changes/add-auth/tasks.md': '- [x] a\r\n- [ ] b\r\n',
      '/proj/openspec/changes/archive/old/tasks.md': '- [x] a\n',
    },
  })
  await r.send('Давай дальше по задачам изменения')
  expect(r.asked[0]!.prompt).toContain('Changes in progress (tasks done/total): add-auth (1/2).')
  expect(r.asked[0]!.prompt).not.toContain('old')
})

test('a nod, a slash command, a named skill and a plugin prompt go through untouched and unasked', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd"}]}' })
  await r.send('да давай')
  await r.send('сделай через /tdd корзину')
  await r.send('Implement the next feature please', { kind: 'plugin', name: 'other' })
  expect(r.asked).toHaveLength(0)
  expect(r.entered.every(e => e.context.length === 0)).toBe(true)
})

test('a skill already loaded is not picked again until a /clear', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd","why":"feature"}]}' })
  await $.skill.prompt({ skill: 'tdd', pluginName: 'mattpocock-skills', text: 'TDD.', frontmatter: {}, source: 'plugin' } as any)
  await r.send('Добавь фильтр по цене в каталог')
  expect(r.asked[0]!.prompt).toContain('Already loaded: mattpocock-skills:tdd.')
  expect(r.entered[0]!.context).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's', resume: undefined } as any)
  await r.send('Добавь фильтр по цене в каталог')
  expect(r.entered[1]!.context.at(-1)).toContain('mattpocock-skills:tdd')
})

test('a /clear or /resume forgets what was said and the pick on the status line, and reads the mode again', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd","why":"feature"}]}' })
  await r.send('Добавь фильтр по цене в каталог')
  expect(r.status.at(-1)).toBe('skill: tdd')
  // Another session turned it off meanwhile.
  r.store.set('mode', 'off')
  await $.session.end({ reason: 'resume', sessionId: 'one', resume: { id: 'two' } })
  expect(r.status.at(-1)).toBeUndefined()
  await r.send('Сделай регистрацию через email')
  expect(r.asked).toHaveLength(1)
  expect(r.entered[1]!.context).toEqual([])
  // On again: the prompt before the resume is not read as the previous one.
  await r.run('auto')
  await r.send('Сделай регистрацию через телефон')
  expect(r.asked).toHaveLength(2)
  expect(r.asked[1]!.prompt).not.toContain('фильтр по цене')
})

test('a model that fails lets the prompt through as typed', async ($, on) => {
  const r = await router($, on, { reply: null })
  await r.send('Почини выгрузку отчёта в Excel')
  expect(r.entered[0]).toEqual({ text: 'Почини выгрузку отчёта в Excel', context: [] })
  // Said where the pick would be, so no pick is not read as nothing fitting.
  expect(r.status.at(-1)).toBe('skill: model failed')
})

test('suggest leaves the call to Claude; off routes nothing', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd"}]}' })
  expect((await r.run('suggest')).text).toBe('Skill router set to suggest: Claude decides.')
  await r.send('Сделай регистрацию через email')
  expect(r.entered[0]!.context.at(-1)).toContain('may fit')
  await r.run('off')
  await r.send('Сделай регистрацию через телефон')
  expect(r.asked).toHaveLength(1)
  expect(r.entered[1]!.context).toEqual([])
})

test('ignore leaves a skill out of the list the model reads; rm drops a rule', async ($, on) => {
  const r = await router($, on)
  expect((await r.run('ignore tdd')).text).toBe('tdd is left out of routing.')
  await r.send('Сделай экспорт заказов в CSV')
  expect(r.asked[0]!.prompt).not.toContain('mattpocock-skills:tdd')
  await r.run('add tdd тест')
  expect((await r.run('rm 1')).text).toBe('Rule 1 removed.')
  expect((await r.run('rm 5')).text).toBe('No rule 5.')
})

test('/router list shows every skill it routes among, ignored ones marked', async ($, on) => {
  const r = await router($, on)
  await r.run('ignore apply')
  const list = (await r.run('list')).text
  expect(list).toContain('· mattpocock-skills:tdd — Test-driven development.')
  expect(list).toContain('✗ opsx:apply')
  expect(list).not.toContain('context-bar')
})

test('the language option speaks Russian in /router and the status line', { options: { language: 'ru' } }, async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd"}]}' })
  await r.send('Сделай корзину для гостей')
  expect(r.status.at(-1)).toBe('скилл: tdd')
  expect((await r.run('off')).text).toBe('Роутер скиллов переключён: выкл.')
})

test('the model option names the model that picks', { options: { routerModel: 'sonnet' } }, async ($, on) => {
  const r = await router($, on)
  await r.send('Сделай корзину для гостей')
  expect(r.asked[0]!.model).toBe('sonnet')
})

test('with useModel off only rules route', { options: { routerUseModel: false } }, async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd"}]}' })
  await r.run('add tdd корзин')
  await r.send('Сделай корзину для гостей')
  await r.send('Сделай вишлист для гостей')
  expect(r.asked).toHaveLength(0)
  expect(r.entered[0]!.context.at(-1)).toContain('mattpocock-skills:tdd')
  expect(r.entered[1]!.context).toEqual([])
})

test('/router add <Tab> offers skill names, short where they are unique', async ($, on) => {
  await router($, on)
  // The test kit's `$` raises the event though its typings leave it out.
  const prompt = $.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> }
  const at = (text: string) =>
    prompt.autocomplete({ text, cursor: text.length, token: text.split(' ').at(-1) ?? '', start: text.lastIndexOf(' ') + 1 })
  expect((await at('/router add dia')).suggestions.map(s => s.text)).toEqual(['diagnosing-bugs'])
  expect((await at('/router ignore ')).suggestions.map(s => s.text)).toEqual(['tdd', 'diagnosing-bugs', 'apply'])
  expect((await at('/router list ')).suggestions).toEqual([])
})

test('/router lang ru switches /router and the status line to Russian', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd"}]}' })
  expect((await r.run('')).text).toBe('Skill router pane opened.')
  expect((await r.run('lang ru')).text).toBe('agent-lens теперь говорит по-русски: /changes, /spec и /router.')
  expect((await r.run('')).text).toBe('Панель роутера открыта.')
  await r.send('Сделай корзину для гостей')
  expect(r.status.at(-1)).toBe('скилл: tdd')
  expect((await r.run('lang de')).text).toBe('Как вызвать: /router lang en, /router lang ru')
  expect((await r.run('lang en')).text).toBe('agent-lens speaks English now: /changes, /spec and /router.')
})

// Whether any element of the drawing shows text matching `re`.
const shows = async (ui: { findAll: (query: {}) => Promise<{ text: string }[]> }, re: RegExp) => (await ui.findAll({})).some(el => re.test(el.text))

test('the pane opens on the overview: the last prompt, what it got and why, the session at a glance', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd","why":"a new feature, test-first"}]}' })
  await r.send('Добавь избранное в каталог товаров')
  expect((await r.run('')).text).toBe('Skill router pane opened.')
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-lens', surface, ...PANE })
    expect(await shows(ui, /«Добавь избранное в каталог товаров»/)).toBe(true)
    expect(await shows(ui, /^tdd$/)).toBe(true)
    expect(await shows(ui, /a new feature, test-first/)).toBe(true)
    expect(await shows(ui, /This session: 1 prompts, 1 with a skill \(0 by rule, 1 by model\)/)).toBe(true)
    expect(await ui.find({ key: 'tab-overview' })).toBeDefined()
    await ui.unmount()
  }
})

test('tabs, mode and language switch by their buttons', async ($, on) => {
  const r = await router($, on)
  await r.run('')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'tab-overview' }))?.props.label).toBe('[Overview]')
  await ui.press({ key: 'tab-rules' })
  expect((await ui.find({ key: 'tab-rules' }))?.props.label).toBe('[Rules]')
  expect((await ui.find({ key: 'tab-rules' }))?.props.hotkey).toBe('2')
  await ui.press({ key: 'mode-off' })
  expect((await ui.find({ key: 'mode-off' }))?.props.label).toBe('● off')
  await r.send('Сделай корзину для гостей')
  expect(r.asked).toHaveLength(0)
  await ui.press({ key: 'mode-auto' })
  await ui.press({ key: 'lang' })
  expect((await ui.find({ key: 'tab-rules' }))?.props.label).toBe('[Правила]')
  expect((await r.run('off')).text).toBe('Роутер скиллов переключён: выкл.')
  await ui.unmount()
})

test('the rules tab adds a rule from the form, removes one with ✕, keeps hints', async ($, on) => {
  const r = await router($, on)
  await r.run('rules')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await shows(ui, /No rules yet\./)).toBe(true)
  await ui.select({ key: 'form-skill', value: 'mattpocock-skills:diagnosing-bugs' })
  await ui.input({ key: 'form-words', text: 'баг, падает' })
  expect(await shows(ui, /Rule added: diagnosing-bugs ← баг, падает/)).toBe(true)
  expect(await shows(ui, /← баг, падает/)).toBe(true)
  expect((await ui.find({ key: 'form-words' }))?.props.value).toBe('')
  await ui.input({ key: 'form-hint', text: 'for flaky failures' })
  expect(await shows(ui, /: for flaky failures/)).toBe(true)

  await r.send('Тест падает после мержа')
  expect(r.asked).toHaveLength(0)
  expect(r.entered[0]!.context.at(-1)).toContain('mattpocock-skills:diagnosing-bugs')

  await ui.press({ key: 'rm-0' })
  expect(await shows(ui, /Rule 1 removed\./)).toBe(true)
  expect(await shows(ui, /No rules yet\./)).toBe(true)
  await ui.press({ key: 'unhint-mattpocock-skills:diagnosing-bugs' })
  expect(await shows(ui, /: for flaky failures/)).toBe(false)
  await ui.unmount()
})

test('the rules tab on mobile, which draws no fields, says how to add one', async ($, on) => {
  const r = await router($, on)
  await r.run('rules')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'mobile', ...PANE })
  expect(await shows(ui, /\/router add <skill> <words>/)).toBe(true)
  await ui.unmount()
})

test('the skills tab lists skills by plugin; a press leaves one out and back in', async ($, on) => {
  const r = await router($, on)
  await r.run('skills')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await shows(ui, /^mattpocock-skills$/)).toBe(true)
  expect(await shows(ui, /^opsx$/)).toBe(true)
  expect(await ui.find({ key: 'skill-context-bar' })).toBeUndefined()
  await ui.press({ key: 'skill-mattpocock-skills:tdd' })
  expect(await shows(ui, /tdd is left out of routing\./)).toBe(true)
  await r.send('Сделай экспорт заказов в CSV')
  expect(r.asked[0]!.prompt).not.toContain('mattpocock-skills:tdd')
  await ui.press({ key: 'skill-mattpocock-skills:tdd' })
  expect(await shows(ui, /tdd is routed again\./)).toBe(true)
  await ui.unmount()
})

test('the history tab lists every decision; + rule takes a model pick to the rule form', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"diagnosing-bugs","why":"flaky total"}]}' })
  await r.send('В корзине иногда неверный итог')
  await r.send('да')
  await r.run('history')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await shows(ui, /«В корзине иногда неверный итог»/)).toBe(true)
  expect(await shows(ui, /nothing fit/)).toBe(true)
  const key = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('rule-from-'))?.key
  expect(key).toBeDefined()
  await ui.press({ key: key! })
  expect((await ui.find({ key: 'tab-rules' }))?.props.label).toBe('[Rules]')
  expect((await ui.find({ key: 'form-skill' }))?.props.value).toBe('mattpocock-skills:diagnosing-bugs')
  expect(await shows(ui, /Type the words for a rule that runs diagnosing-bugs\./)).toBe(true)
  await ui.unmount()
})

const SPEC_FILES = { '/proj/openspec/changes/door/tasks.md': '- [x] 1.1 a\n- [ ] 1.2 b\n' }
const RULES = { setup: { rules: [{ skill: 'tdd', when: ['фильтр'] }], hints: {}, ignored: [] } }

test('a rule that fires settles the prompt even where its skill is loaded: the model is not asked, the changes not read', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"diagnosing-bugs"}]}', stored: RULES, files: SPEC_FILES })
  await r.send('Добавь фильтр по цене в каталог')
  expect(r.entered[0]!.context.at(-1)).toContain('mattpocock-skills:tdd')
  await $.skill.prompt({ skill: 'tdd', pluginName: 'mattpocock-skills', text: 'TDD.', frontmatter: {}, source: 'plugin' } as any)
  await r.send('Ещё фильтр по бренду')
  expect(r.asked).toHaveLength(0)
  expect(r.entered[1]!.context).toEqual([])
  expect(r.reads.filter(p => p.endsWith('tasks.md'))).toEqual([])
  // Asked, the model is told the changes.
  await r.send('Почини выгрузку отчёта в Excel, она падает на больших файлах')
  expect(r.asked[0]!.prompt).toContain('door (1/2)')
})

test('the model reads at most so much of a pasted prompt', async ($, on) => {
  const r = await router($, on)
  await r.send(`Почини это: ${'x'.repeat(20_000)}`)
  expect(r.asked[0]!.prompt.length).toBeLessThan(6_000)
  expect(r.asked[0]!.prompt).toMatch(/x…\n<\/request>$/)
})

test("a skill the project leaves out is said so by list, and unignore sends to the project's file", async ($, on) => {
  const r = await router($, on, { files: { '/proj/.claude/skill-router.json': JSON.stringify({ ignored: ['tdd'] }) } })
  expect((await r.run('list')).text).toMatch(/^✗ mattpocock-skills:tdd — Test-driven development\. \(left out by the project\)$/m)
  expect((await r.run('unignore tdd')).text).toBe("tdd is left out by the project's .claude/skill-router.json: change it there.")
})

test('a skill installed while the router is off can be given a rule', async ($, on) => {
  const r = await router($, on, { stored: { mode: 'off' } })
  await r.run('list')
  // Installed after the skills were listed, with no prompt routed since.
  r.install({ name: 'openspec-explore', description: 'Explore an idea before a change.', source: 'user' })
  expect((await r.run('add openspec-explore идея, explore')).text).toBe('Rule added: openspec-explore ← идея, explore')
})

test('the session counts every prompt routed, past the last 30 the history keeps', async ($, on) => {
  const r = await router($, on, { reply: '{"picks":[{"skill":"tdd","why":"feature"}]}' })
  for (let i = 0; i < 32; i++) await r.send(`Сделай фичу номер ${i} с тестами`)
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^This session: 32 prompts, 32 with a skill \(0 by rule, 32 by model\)$/ })).toBeDefined()
  await ui.unmount()
})

test('the pane is laid out for its own width, not the terminal', async ($, on) => {
  const r = await router($, on)
  await r.send('Сделай фичу с тестами')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  expect(await ui.find({ type: 'Text', text: /^─{38}$/ })).toBeDefined()
  await ui.unmount()
})

test('off is said on the status line; a skill the project leaves out says so in yellow, not as done', async ($, on) => {
  const r = await router($, on, { files: { '/proj/.claude/skill-router.json': JSON.stringify({ ignored: ['tdd'] }) } })
  await r.run('off')
  expect(r.status.at(-1)).toBe('skill router: off')
  await r.run('auto')
  expect(r.status.at(-1)).toBeUndefined()
  await r.run('skills')
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await ui.press({ key: 'skill-mattpocock-skills:tdd' })
  expect(await ui.find({ type: 'Text', text: /^⚠ tdd is left out by the project's/ })).toMatchObject({ props: { color: 'warning' } })
  await ui.unmount()
})
