import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import {
  annotateRequirements,
  blocksArchive,
  deltasOf,
  diffLines,
  fingerprintOf,
  parseCovers,
  parseIssues,
  parseOptions,
  parseRequirements,
  parseTaskList,
  parseTasks,
  parseTests,
  requirementNames,
  splitBrief,
} from '../hooks/spec/spec'
import { WORDS } from '../hooks/spec/words'

const TASKS = '# Tasks\n\n## 1. Backend\n\n- [x] 1.1 Add the endpoint\n- [ ] 1.2 Cover it with e2e\n'
const TESTS =
  '# Test Cases\n\n## TC-01: Grant access\n\nSteps…\n\nAutomated: e2e/door.spec.ts\n\n## TC-02: Revoke\n\nManual: needs a real lock\n'
const DOOR = {
  'proposal.md': '# Proposal\n\nLet managers grant door access.\n',
  'design.md': '# Design\n\nThe grant is a row in door_access.\n',
  'tasks.md': TASKS,
  'test-cases.md': TESTS,
  'specs/api/access/spec.md': '## ADDED Requirements\n\n### Requirement: grant\n',
}

test('tasks and test cases are counted from their Markdown', () => {
  expect(parseTasks(TASKS)).toEqual({ done: 1, total: 2 })
  expect(parseTests(TESTS)).toEqual({ cases: 2, automated: 1, manual: 1, unmarked: [] })
  expect(parseTests(`${TESTS}\n## TC-03: Expiry\n\nSteps only.\n`).unmarked).toEqual(['TC-03'])
  // A file that marks none of its cases keeps no such convention: nothing is unmarked.
  expect(parseTests('## TC-01: a\n\nSteps.\n\n## TC-02: b\n\nSteps.\n')).toEqual({ cases: 2, automated: 0, manual: 0, unmarked: [] })
  const many = { cases: 9, automated: 4, manual: 0, unmarked: ['TC-05', 'TC-06', 'TC-07', 'TC-08', 'TC-09'] }
  expect(WORDS.en.unmarked(many.unmarked)).toBe('5 unmarked')
  expect(WORDS.ru.tests({ cases: 3, automated: 0, manual: 0, unmarked: [] })).toBe('3 тест-кейса')
})

test('the tasks are read with their numbers and the heading they sit under', () => {
  expect(parseTaskList(`Preamble.\n\n- [ ] loose one\n${TASKS}`)).toEqual([
    { id: null, text: 'loose one', isDone: false, section: null },
    { id: '1.1', text: 'Add the endpoint', isDone: true, section: '1. Backend' },
    { id: '1.2', text: 'Cover it with e2e', isDone: false, section: '1. Backend' },
  ])
})

// The same Markdown as Git on Windows checks it out.
const crlf = (text: string) => text.replace(/\n/g, '\r\n')

test('Markdown with CRLF line ends reads as with LF', () => {
  expect(parseTaskList(crlf(TASKS))).toEqual(parseTaskList(TASKS))
  expect(parseTaskList(crlf(TASKS))).toHaveLength(2)
  expect(parseTasks(crlf(TASKS))).toEqual({ done: 1, total: 2 })
  expect(parseTests(crlf(TESTS))).toEqual(parseTests(TESTS))
  expect(parseRequirements('web/page', crlf(WEB))).toEqual(parseRequirements('web/page', WEB))
  expect(requirementNames(crlf('### Requirement: Old name\n\n### Requirement: Ask\n'))).toEqual(['Old name', 'Ask'])
  expect(parseCovers(crlf('## TC-01: a\n\nCovers: Requirement: Ask / Scenario: Any\n'))).toEqual({ scenarios: ['any'], requirements: [] })
})

const WEB = `## ADDED Requirements

### Requirement: Dark mode
The page SHALL follow the system theme.

#### Scenario: Toggle
#### Scenario: Remembered

## RENAMED Requirements
- FROM: \`### Requirement: Old name\`
- TO: \`### Requirement: New name\`

## REMOVED Requirements

### Requirement: Light only
`

test('a delta spec gives its requirements by what it does to them, with their scenarios', () => {
  expect(parseRequirements('web/page', WEB)).toEqual([
    { capability: 'web/page', op: 'added', name: 'Dark mode', scenarios: ['Toggle', 'Remembered'] },
    { capability: 'web/page', op: 'renamed', name: 'New name', from: 'Old name', scenarios: [] },
    { capability: 'web/page', op: 'removed', name: 'Light only', scenarios: [] },
  ])
  const issues = parseIssues(JSON.stringify({ items: [{ id: 'door', issues: [{ level: 'INFO', path: 'a/spec.md', message: 'Archive would refuse this delta: x' }] }] }))
  expect(issues).toHaveLength(1)
  expect(blocksArchive(issues![0]!)).toBe(true)
  expect(blocksArchive({ level: 'WARNING', path: 'a', message: 'Purpose is short' })).toBe(false)
  expect(parseIssues('command not found')).toBeUndefined()
  expect(WORDS.ru.shared(['a', 'b', 'c', 'd', 'e'])).toBe('5 общих требований: a; b; c…')
  expect(WORDS.ru.newButEdited(21)).toMatch(/^новая, но 21 требование меняется так/)
})

test('scenarios are matched to the test cases that cover them, requirements to the main spec', () => {
  const covers = parseCovers(
    '## TC-01: a\n\nCovers: web/page — Requirement: Dark mode / Scenario: Toggle; Scenario: «Remembered».\n\n' +
      // Whole requirements and one with its scenarios on a line, a remark after the last.
      '## TC-02: b\n\nCovers: Requirement: Theme / Scenario: Dim; Requirement: Ask — every scenario of these\n',
  )
  expect(parseCovers('## TC-01: a\n\nSteps.\n')).toBeNull()
  const main = requirementNames('## Requirements\n\n### Requirement: Old name\n\n### Requirement: Ask\n')
  expect(main).toEqual(['Old name', 'Ask'])
  const scenarios = (op: 'added' | 'modified', name: string, ...s: string[]) => ({ capability: 'web/page', op, name, scenarios: s })
  expect(
    annotateRequirements(
      [scenarios('added', 'Dark mode', 'Toggle', 'Remembered', 'Contrast'), scenarios('modified', 'Ask', 'Any'), scenarios('modified', 'Gone', 'x')],
      { 'web/page': main },
      covers,
    ),
  ).toEqual([
    { ...scenarios('added', 'Dark mode', 'Toggle', 'Remembered', 'Contrast'), uncovered: ['Contrast'] },
    // A case that names the requirement alone covers all of it.
    scenarios('modified', 'Ask', 'Any'),
    { ...scenarios('modified', 'Gone', 'x'), uncovered: ['x'], mismatch: 'missing' },
  ])
  // A capability with no main spec takes only added requirements; nothing is reported untested
  // where no case says what it covers.
  expect(annotateRequirements([scenarios('modified', 'Ask', 'Any')], { 'web/page': null }, null)).toEqual([{ ...scenarios('modified', 'Ask', 'Any'), mismatch: 'missing' }])
})

test('a ticked task is no change to the spec; a rewritten line is', () => {
  const ticked = { ...DOOR, 'tasks.md': TASKS.replace('- [ ] 1.2', '- [x] 1.2') }
  expect(fingerprintOf(ticked)).toBe(fingerprintOf(DOOR))
  expect(deltasOf(DOOR, ticked)).toEqual([])
  const rewritten = { ...DOOR, 'design.md': '# Design\n\nThe grant is a row in door_access.\nIt expires at midnight.\n' }
  expect(fingerprintOf(rewritten)).not.toBe(fingerprintOf(DOOR))
  expect(deltasOf(DOOR, rewritten)).toEqual([{ file: 'design.md', added: 1, removed: 0 }])
  const { [`specs/api/access/spec.md`]: _gone, ...without } = DOOR
  expect(deltasOf(DOOR, without)).toEqual([{ file: 'specs/api/access/spec.md', added: 0, removed: 2 }])
  expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual({ added: ['x'], removed: ['b'] })
})

test('the brief gives up its last section as the list of what is left to decide', () => {
  const en = WORDS.en
  const text = '## Gist\nManagers grant access.\n## Up to you\n- Pick the expiry (design.md)\n- Who may revoke (proposal.md)\n'
  expect(splitBrief(text, en.decideHeading, en.none)).toEqual({
    summary: '## Gist\nManagers grant access.',
    decisions: ['Pick the expiry (design.md)', 'Who may revoke (proposal.md)'],
  })
  const ru = WORDS.ru
  expect(splitBrief('## Суть\nВыдача доступа.\n## Решить тебе\nНичего.\n', ru.decideHeading, ru.none).decisions).toEqual([])
  expect(ru.toDecide(1)).toBe('1 вопрос решить')
  expect(ru.toDecide(3)).toBe('3 вопроса решить')
  expect(ru.toDecide(5)).toBe('5 вопросов решить')
})

test('the options the model offers are read from its JSON, fenced or not', () => {
  expect(parseOptions('```json\n[["Midnight", " A week ", "Midnight"], ["The manager"]]\n```', 2)).toEqual([['Midnight', 'A week'], ['The manager']])
  expect(parseOptions('[["Midnight"]]', 3)).toEqual([['Midnight'], [], []])
  expect(parseOptions('No idea.', 1)).toEqual([[]])
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
const PANE = {
  component: 'Pane' as const,
  requestId: 'agent-lens-spec',
  props: { title: 'OpenSpec', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BRIEF_EN = '## Gist\nManagers grant door access.\n## Up to you\n- Pick the expiry (design.md)\n- Who may revoke (proposal.md)\n'

// A project whose openspec folder holds the changes given, each a map of its files; the store, the
// model and the opened panes are kept here so a test reads what the mod did.
const project = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  changes: Record<string, Record<string, string>>,
  // What `openspec validate` prints for the change; left out, the CLI is not there.
  validate?: (change: string) => string,
  // The project's folder as the engine spells it; the commands not on the PATH by that name; the
  // changes whose folder is gone by the time the scan lists it.
  { root = '/proj', missing = [] as readonly string[], gone = [] as readonly string[] } = {},
) => {
  // The disk is kept by POSIX path, however the engine spells one: on Windows it hands the hooks
  // `C:\proj\openspec\changes` for `/proj/openspec/changes`, and elsewhere a `C:\proj` the mod was
  // given reaches them under the working directory. What follows the last drive is the path, in
  // any case where it is a Windows one.
  const at = (path: string) => {
    const parts = path.split(/[\\/]/).filter(p => p !== '')
    const posix = `/${parts.slice(parts.map(p => /^[A-Za-z]:$/.test(p)).lastIndexOf(true) + 1).join('/')}`
    return /^[A-Za-z]:|\\/.test(path) ? posix.toLowerCase() : posix
  }
  const openspec = `${at(root).replace(/\/$/, '')}/openspec`
  const disk = new Map<string, string>()
  const put = (change: string, file: string, text: string) => disk.set(`${openspec}/changes/${change}/${file}`, text)
  const putMain = (capability: string, text: string) => disk.set(`${openspec}/specs/${capability}/spec.md`, text)
  for (const [change, files] of Object.entries(changes)) for (const [file, text] of Object.entries(files)) put(change, file, text)
  const isDir = (path: string) => [...disk.keys()].some(p => p.startsWith(`${at(path)}/`))
  const store = new Map<string, unknown>()
  const asked: ModelCompleteInput[] = []
  const opened: string[] = []
  const submitted: { text: string; asUser?: true; context?: readonly string[] }[] = []
  const toasts: string[] = []
  const ran: { argv: readonly string[]; cwd?: string }[] = []
  if (validate)
    on('process.run', ($, e) => {
      ran.push({ argv: e.argv, ...(e.init?.cwd !== undefined ? { cwd: e.init.cwd } : {}) })
      if (missing.includes(e.argv[0]!)) return { deny: `spawn ${e.argv[0]} ENOENT` }
      return { value: { exitCode: 0, stdout: validate(e.argv[2]!), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  // null: the API is down.
  let reply = (e: ModelCompleteInput): string | null => (e.prompt.includes('Question:') || e.prompt.includes('Вопрос:') ? 'It is revoked at once (design.md, Grant).' : BRIEF_EN)
  const clock = mock.clock(on, { now: 10_000 })
  // The skills the session has: OpenSpec's own, as its slash commands name them.
  on('command.list', () => ({ value: [{ name: 'opsx:apply', description: 'Implement the tasks of an OpenSpec change.', source: 'user' as const }] }))
  on('session.root', () => ({ value: root }))
  on('fs.exists', ($, e) => ({ value: disk.has(at(e.path)) || isDir(e.path) }))
  on('fs.list', ($, e) => {
    const dir = at(e.path)
    if (gone.some(change => dir === `${openspec}/changes/${change}`)) return { deny: `ENOENT: no such file or directory, scandir '${e.path}'` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of disk.keys())
      if (p.startsWith(`${dir}/`)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/')
        names.set(name!, rest.length > 0 ? 'dir' : 'file')
      }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: name === 'archive' ? 99 : 1, isLink: false })) }
  })
  on('fs.read', ($, e) => ({ value: disk.get(at(e.path)) ?? '' }))
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
  on('model.complete', ($, e) => {
    asked.push(e)
    const text = reply(e)
    return text === null
      ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.title ?? e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('command.register', () => ({ value: { command: 'spec' } }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, ...(e.origin?.kind === 'plugin' && e.origin.asUser ? { asUser: true as const } : {}), ...(e.context?.length ? { context: e.context } : {}) })
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    e.tool === 'Write'
      ? { result: { type: 'update' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
      : { deny: 'unexpected' },
  )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  const spec = (args = '') =>
    $.command.run({ command: 'spec', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // Settles the brief the pane starts making without waiting for it.
  const settle = () => clock.advance(10)
  const write = async (change: string, file: string, text: string) => {
    put(change, file, text)
    await $.tool.call({ tool: 'Write', file_path: `/proj/openspec/changes/${change}/${file}`, content: text })
  }
  const turn = () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  return { store, asked, opened, submitted, toasts, ran, spec, settle, write, put, putMain, turn, setReply: (r: typeof reply) => (reply = r) }
}

// The text of a found element and everything under it.
const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : typeof node === 'object' && node !== null ? ((node as { children?: unknown[] }).children ?? []).map(textOf).join('') : ''

// The row's text, the /spec button left out (it draws its label, not children).
const bandText = async ($: Parameters<TestBody>[0], bodyColumns = 140) => {
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns } })
  const row = await ui.find({ key: 'lens-row' })
  await ui.unmount()
  return row ? textOf(row) : undefined
}

test('the row shows the latest change, its tasks and test cases; none where there is no OpenSpec', async ($, on) => {
  await project($, on, { door: DOOR, 'older-one': { 'tasks.md': '- [ ] 1.1 x\n' }, archive: { 'x/tasks.md': '' } })
  expect(await bandText($)).toBe('◆ door · tasks 1/2 · tests 1 auto, 1 manual')
})

test('a test case marked neither way turns the row red and is named', async ($, on) => {
  await project($, on, { door: { ...DOOR, 'test-cases.md': `${TESTS}\n## TC-03: Expiry\n\nSteps only.\n` } })
  expect(await bandText($)).toBe('◆ door · TC-03 unmarked · tasks 1/2 · tests 1 auto, 1 manual')
})

test('a narrow row drops progress before problems, says how much it dropped, and opens the tab of a part', async ($, on) => {
  const { spec, settle, opened } = await project($, on, { door: { ...DOOR, 'test-cases.md': `${TESTS}\n## TC-03: Expiry\n\nSteps only.\n` } })
  await spec()
  await settle()
  expect(await bandText($, 60)).toBe('◆ door · TC-03 unmarked · 2 to decide · +2 more')
  expect(await bandText($, 30)).toBe('◆ door · +4 more')
  // The parts it drops hold a problem: it says so in their colour.
  const narrow = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 30 } })
  expect(textOf(await narrow.find({ key: 'row-more' }))).toBe('+4 more')
  expect(JSON.stringify(await narrow.find({ key: 'row-more' }))).toMatch(/"color":"error"/)
  await narrow.unmount()
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND })
  await ui.press({ key: 'row-decide' })
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { variant: 'primary', label: 'Decide (2)' } })
  expect(await pane.find({ key: 'tab-spec' })).toMatchObject({ props: { label: 'Spec (1)' } })
  await pane.press({ key: 'tab-spec' })
  expect(await pane.find({ type: 'Text', text: /^✗ TC-03 says neither "Automated:" nor "Manual:"/ })).toBeDefined()
  await pane.unmount()
  expect(opened.at(-1)).toBe('OpenSpec · door')
})

test('a model call that failed is offered again, and the error can be put away', async ($, on) => {
  const { asked, spec, settle, setReply } = await project($, on, { door: DOOR })
  const answer = (e: ModelCompleteInput) => (e.prompt.includes('Question:') ? 'It is revoked at once (design.md, Grant).' : BRIEF_EN)
  setReply(() => null)
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /^✗ The model gave no answer: the API is overloaded, try again in a minute\.$/ })).toBeDefined()
  expect(await pane.find({ key: 'refresh' })).toMatchObject({ props: { label: 'make the brief', variant: 'primary' } })
  setReply(answer)
  await pane.press({ key: 'retry' })
  expect(asked).toHaveLength(2)
  expect(await pane.find({ key: 'retry' })).toBeUndefined()
  expect(await pane.find({ type: 'Markdown', text: /Managers grant door access/ })).toBeDefined()

  // A question that failed is asked again as it was.
  setReply(() => null)
  await pane.press({ key: 'tab-ask' })
  await pane.press({ key: 'suggest-0' })
  await pane.press({ key: 'dismiss' })
  expect(await pane.find({ key: 'retry' })).toBeUndefined()
  await pane.input({ key: 'question', text: 'Who revokes?' })
  setReply(answer)
  await pane.press({ key: 'retry' })
  expect(asked.at(-1)!.prompt).toMatch(/Question: Who revokes\?/)
  expect(await pane.find({ type: 'Markdown', text: /revoked at once/ })).toBeDefined()
  await pane.unmount()
})

test('no OpenSpec changes: no row, and /spec says so', async ($, on) => {
  const { spec } = await project($, on, {})
  expect(await bandText($)).toBeUndefined()
  expect((await spec()).text).toBe(WORDS.en.noSpec)
})

test('/spec opens the brief once per version of the change, and the row counts what is left to decide', async ($, on) => {
  const { asked, opened, spec, settle, store } = await project($, on, { door: DOOR })
  expect((await spec()).text).toBe('Opened door.')
  await settle()
  expect(opened).toEqual(['OpenSpec · door'])
  expect(asked).toHaveLength(1)
  expect(asked[0]!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect(asked[0]!.prompt).toMatch(/=== proposal\.md ===[\s\S]*=== design\.md ===[\s\S]*=== specs\/api\/access\/spec\.md ===/)
  expect(store.has('brief:en:/proj/openspec:door')).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'agent-lens', surface, ...PANE })
    expect(await pane.find({ type: 'Markdown', text: /Managers grant door access/ })).toBeDefined()
    // The ring starts on the open tab, not on the change list.
    expect(await pane.find({ key: 'tab-brief' })).toMatchObject({ props: { autoFocus: true } })
    await pane.press({ key: 'tab-decide' })
    expect(await pane.find({ type: 'Text', text: /^1\. Pick the expiry \(design\.md\)$/ })).toBeDefined()
    await pane.press({ key: 'tab-brief' })
    await pane.unmount()
  }
  expect(await bandText($)).toBe('◆ door · 2 to decide · tasks 1/2 · tests 1 auto, 1 manual')

  // Ticking tasks off leaves the brief fresh: opening again asks the model nothing.
  await spec()
  await settle()
  expect(asked).toHaveLength(1)
})

test('what changed since it was read: shown, explained by the model, then marked read', async ($, on) => {
  const { asked, spec, settle, write, put, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  // Agents tick tasks: progress, not a change.
  put('door', 'tasks.md', TASKS.replace('- [ ] 1.2', '- [x] 1.2'))
  await turn()
  await settle()
  expect(await bandText($)).toBe('◆ door · 2 to decide · tasks 2/2 · tests 1 auto, 1 manual')

  await write('door', 'design.md', '# Design\n\nThe grant is a row in door_access.\nIt expires at midnight.\n')
  expect(await bandText($)).toMatch(/· spec changed ·/)

  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-changes' })).toMatchObject({ props: { label: 'Changes (1)' } })
  await pane.press({ key: 'tab-changes' })
  expect(await pane.find({ type: 'Text', text: /^design\.md$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\+1 −0$/ })).toBeDefined()
  await pane.press({ key: 'explain' })
  expect(asked.at(-1)!.prompt).toMatch(/\+ It expires at midnight\./)
  await pane.press({ key: 'mark-read' })
  expect(await pane.find({ type: 'Text', text: /^✓ Nothing changed since you last read it\.$/ })).toBeDefined()
  await pane.unmount()
  expect(await bandText($)).not.toMatch(/spec changed/)
})

test('what is left to decide is settled in the pane and goes to Claude to write into the spec', async ($, on) => {
  const { asked, spec, settle, setReply, submitted, toasts, store, put, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  setReply(e => (e.prompt.includes('JSON') ? '```json\n[["At midnight", "After a week"], ["Only the manager", "Anyone with admin"]]\n```' : BRIEF_EN))
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide (2)' } })

  // Opening the first asks for the options of all of them, once.
  await pane.press({ key: 'decide-0' })
  expect(asked.at(-1)!.prompt).toMatch(/1\. Pick the expiry \(design\.md\)\n2\. Who may revoke/)
  expect(asked.at(-1)!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect((store.get('brief:en:/proj/openspec:door') as { options?: string[][] }).options).toHaveLength(2)
  const calls = asked.length
  await pane.press({ key: 'option-0-1' })
  // The next one opens by itself; its own words go in the field.
  expect(await pane.find({ key: 'option-1-0' })).toBeDefined()
  await pane.input({ key: 'own-1', text: 'The manager and security' })
  expect(asked).toHaveLength(calls)
  expect(await pane.find({ type: 'Text', text: /^  → After a week$/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide' } })
  expect(await bandText($)).toBe('◆ door · 2 not in the spec · tasks 1/2 · tests 1 auto, 1 manual')

  // Changed mind, then back: cleared and decided again.
  await pane.press({ key: 'decide-1' })
  await pane.press({ key: 'clear-1' })
  expect(await bandText($)).toMatch(/· 1 to decide · 1 not in the spec ·/)
  await pane.press({ key: 'option-1-0' })

  await pane.press({ key: 'apply' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]!.asUser).toBe(true)
  expect(submitted[0]!.text).toMatch(/OpenSpec change "door" \(\/proj\/openspec\/changes\/door\)/)
  expect(submitted[0]!.text).toMatch(/1\. Pick the expiry \(design\.md\)\n   Decision: After a week\n2\. Who may revoke \(proposal\.md\)\n   Decision: Only the manager/)
  expect(toasts).toEqual(['2 decisions went to Claude to write into the spec.'])
  expect(await pane.find({ key: 'apply' })).toBeUndefined()
  expect(await pane.find({ key: 'decide-0' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /· sent to Claude$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /brief is made again once the spec changes/ })).toBeDefined()
  expect(await bandText($)).toBe('◆ door · tasks 1/2 · tests 1 auto, 1 manual')

  // A turn that leaves the spec as it was changes nothing; one that writes the decisions in makes
  // the brief again, and the Decide tab starts over from it.
  const briefs = () => asked.filter(e => e.prompt.includes('## Up to you')).length
  const before = briefs()
  await turn()
  await settle()
  expect(briefs()).toBe(before)
  put('door', 'design.md', '# Design\n\nThe grant is a row in door_access.\nIt expires after a week.\n')
  await turn()
  await settle()
  expect(briefs()).toBe(before + 1)
  expect(await pane.find({ key: 'decide-0' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /brief is made again/ })).toBeUndefined()
  await pane.unmount()
})

test('a task goes to Claude from the Tasks tab, the next one first', async ($, on) => {
  const { spec, settle, submitted, toasts, put, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-tasks' })).toMatchObject({ props: { label: 'Tasks (1)' } })
  await pane.press({ key: 'tab-tasks' })
  expect(await pane.find({ type: 'Text', text: /^1\. Backend$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✓ 1\.1 Add the endpoint$/ })).toBeDefined()
  expect(await pane.find({ key: 'task-0' })).toBeUndefined()
  expect(await pane.find({ key: 'do-next' })).toMatchObject({ props: { label: 'do the next: 1.2' } })
  await pane.press({ key: 'do-next' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ asUser: true })
  expect(submitted[0]!.text).toMatch(/^Do task 1\.2 of the OpenSpec change "door" \(\/proj\/openspec\/changes\/door\): "Cover it with e2e"\./)
  expect(toasts).toEqual(['Task 1.2 went to Claude.'])
  // Sent: marked so, and not offered as the next one again.
  expect(await pane.find({ type: 'Text', text: /^→ 1\.2 Cover it with e2e$/ })).toBeDefined()
  expect(await pane.find({ key: 'task-1' })).toBeUndefined()
  expect(await pane.find({ key: 'do-next' })).toBeUndefined()
  // Claude ticks it.
  put('door', 'tasks.md', TASKS.replace('- [ ] 1.2', '- [x] 1.2'))
  await turn()
  await settle()
  expect(await pane.find({ type: 'Text', text: /^All tasks are done\.$/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-tasks' })).toMatchObject({ props: { label: 'Tasks' } })
  await pane.unmount()
})

const report = (issues: object[]) => () => JSON.stringify({ items: [{ id: 'door', type: 'change', valid: true, issues }] })

test('openspec validate, the requirements, and other changes in the same specs', async ($, on) => {
  const issues = [
    { level: 'ERROR', path: 'api/access/spec.md', message: 'ADDED "grant" must include at least one scenario' },
    { level: 'INFO', path: 'web/page/spec.md', message: 'Archive would refuse this delta: target spec does not exist' },
  ]
  const revoke = { 'specs/api/access/spec.md': '## MODIFIED Requirements\n\n### Requirement: grant\n\n#### Scenario: x\n' }
  const covered = TESTS.replace('Automated: e2e/door.spec.ts', 'Covers: web/page — Requirement: Dark mode / Scenario: Toggle\n\nAutomated: e2e/door.spec.ts')
  const door = { ...DOOR, 'specs/web/page/spec.md': WEB, 'test-cases.md': covered }
  const { settle, ran, spec, putMain, turn } = await project($, on, { door, revoke }, report(issues))
  putMain('web/page', '## Requirements\n\n### Requirement: Old name\n\n### Requirement: Light only\n\n### Requirement: Dark mode\n')
  await turn()
  await settle()
  expect(ran[0]).toEqual({ argv: ['openspec', 'validate', 'door', '--strict', '--json', '--no-interactive'], cwd: '/proj' })
  expect(await bandText($)).toBe('◆ door · 1 spec error · 1 scenario untested · overlaps revoke · tasks 1/2 · tests 1 auto, 1 manual')
  await spec()
  await settle()
  // Checked once per version of the change, not on every scan.
  expect(ran).toHaveLength(1)

  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-spec' })
  expect(await pane.find({ type: 'Text', text: /^✗ api\/access\/spec\.md: ADDED "grant" must include/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^i web\/page\/spec\.md: Archive would refuse/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^⚠ revoke · api\/access · both name grant$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\+ grant$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^New: api\/access\. Archiving adds it to openspec\/specs\.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^api\/access · new$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^web\/page$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\+ Dark mode · already in the main spec$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^    2 scenarios: Toggle; Remembered$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^    no test case: Remembered$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^→ Old name → New name$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^− Light only$/ })).toBeDefined()
  await pane.unmount()
})

test('a change with every task ticked, a clean check and nothing to decide goes to the archive', async ($, on) => {
  const done = { ...DOOR, 'tasks.md': TASKS.replace('- [ ] 1.2', '- [x] 1.2') }
  let issues: object[] = [{ level: 'ERROR', path: 'api/access/spec.md', message: 'broken' }]
  const { spec, settle, setReply, submitted, toasts, put, turn } = await project($, on, { door: done }, () => report(issues)())
  setReply(() => '## Gist\nManagers grant door access.\n## Up to you\nNothing.\n')
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  expect(await pane.find({ type: 'Text', text: /^Before archiving:$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^  · 1 spec error to fix$/ })).toBeDefined()
  expect(await pane.find({ key: 'archive' })).toBeUndefined()

  // Fixed: the check runs again on the new version, and the change is ready.
  issues = []
  put('door', 'specs/api/access/spec.md', '## ADDED Requirements\n\n### Requirement: grant\n\n#### Scenario: a manager grants\n')
  await turn()
  await spec()
  await settle()
  await pane.press({ key: 'tab-tasks' })
  expect(await bandText($)).toBe('◆ door · spec changed · ready to archive · tasks 2/2 · tests 1 auto, 1 manual')
  // Asked twice: the first press only offers it.
  await pane.press({ key: 'archive' })
  expect(submitted).toHaveLength(0)
  await pane.press({ key: 'archive-cancel' })
  await pane.press({ key: 'archive' })
  await pane.press({ key: 'archive-confirm' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ asUser: true })
  expect(submitted[0]!.text).toMatch(/^Archive the OpenSpec change "door" \(\/proj\/openspec\/changes\/door\)\. Where the project has its own skill/)
  expect(toasts).toEqual(['Sent to Claude to archive.'])
  expect(await pane.find({ type: 'Text', text: /^Sent to Claude to archive\.$/ })).toBeDefined()
  await pane.unmount()
  expect(await bandText($)).not.toMatch(/ready to archive/)
})

test('a question about the change is answered from it', async ($, on) => {
  const { asked, spec, settle } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-ask' })
  // On Ask the question field holds the ring, not the tab.
  expect(await pane.find({ key: 'tab-ask' })).not.toMatchObject({ props: { autoFocus: true } })
  expect(await pane.find({ key: 'question' })).toMatchObject({ props: { autoFocus: true } })
  await pane.input({ key: 'question', text: 'What if the guest is fired?' })
  expect(asked.at(-1)!.prompt).toMatch(/Question: What if the guest is fired\?/)
  expect(asked.at(-1)!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect(await pane.find({ type: 'Markdown', text: /revoked at once/ })).toBeDefined()
  await pane.unmount()
})

test('another change is picked in the pane and stays picked', async ($, on) => {
  const { spec, settle, store, opened } = await project($, on, { door: DOOR, mascot: { 'tasks.md': '- [x] 1.1 Draw it\n' } })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.select({ key: 'change', value: 'mascot' })
  await pane.unmount()
  await settle()
  expect(store.get('picked:/proj/openspec')).toBe('mascot')
  expect(opened.at(-1)).toBe('OpenSpec · mascot')
  // Its own brief, made on picking it: the model's stand-in answers every change alike.
  expect(await bandText($)).toBe('◆ mascot · 2 to decide · tasks 1/1')
  expect((await spec('nope')).text).toBe('No change nope. Active: door, mascot.')
})

test('after /clear the language is read again from the store and the row is back', async ($, on) => {
  const { store } = await project($, on, { door: DOOR })
  // Set by another session meanwhile; a /clear reads what the store holds now.
  store.set('lang', 'ru')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as Parameters<typeof $.session.end>[0])
  expect(await bandText($)).toBe('◆ door · задачи 1/2 · тесты 1 авто, 1 вручную')
})

test('/spec lang ru: the row, the pane and the model speak Russian', async ($, on) => {
  const { asked, spec, settle, setReply } = await project($, on, { door: DOOR })
  setReply(() => '## Суть\nВыдача доступа к дверям.\n## Решить тебе\n- Срок доступа (design.md)\n')
  expect((await spec('lang de')).text).toBe('Usage: /spec lang en, /spec lang ru')
  expect((await spec('lang ru')).text).toBe('Язык: русский.')
  expect(await bandText($)).toBe('◆ door · задачи 1/2 · тесты 1 авто, 1 вручную')
  await spec()
  await settle()
  expect(asked.at(-1)!.system).toMatch(/Отвечай по-русски/)
  expect(asked.at(-1)!.prompt).toMatch(/## Решить тебе/)
  expect(await bandText($)).toMatch(/· 1 вопрос решить ·/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-brief' })).toMatchObject({ props: { label: 'Выжимка' } })
  await pane.unmount()
})

test('a change checked out with CRLF line ends: its tasks are listed, the row and the brief as with LF', async ($, on) => {
  const door = Object.fromEntries(Object.entries(DOOR).map(([file, text]) => [file, crlf(text)]))
  const { spec, settle, asked } = await project($, on, { door })
  expect(await bandText($)).toBe('◆ door · tasks 1/2 · tests 1 auto, 1 manual')
  await spec()
  await settle()
  expect(asked[0]!.prompt).not.toMatch(/\r/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  expect(await pane.find({ type: 'Text', text: /^✓ 1\.1 Add the endpoint$/ })).toBeDefined()
  expect(await pane.find({ key: 'do-next' })).toMatchObject({ props: { label: 'do the next: 1.2' } })
  await pane.unmount()
})

test('a project on a Windows drive: its paths keep the drive and backslashes, its keys any case of them', async ($, on) => {
  const { spec, settle, store, submitted, ran, turn, put } = await project($, on, { door: DOOR }, report([]), { root: 'C:\\Proj' })
  await turn()
  expect(await bandText($)).toBe('◆ door · tasks 1/2 · tests 1 auto, 1 manual')
  expect(ran[0]).toEqual({ argv: ['openspec', 'validate', 'door', '--strict', '--json', '--no-interactive'], cwd: 'C:\\Proj' })
  await spec()
  await settle()
  expect(store.has('brief:en:c:\\proj\\openspec:door')).toBe(true)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  await pane.press({ key: 'do-next' })
  await pane.unmount()
  expect(submitted[0]!.text).toMatch(/\(C:\\Proj\\openspec\\changes\\door\)/)
  // An edit there, however the path is cased, is followed.
  const design = '# Design\n\nIt expires at midnight.\n'
  put('door', 'design.md', design)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Proj\\OpenSpec\\Changes\\door\\design.md', content: design })
  expect(await bandText($)).toMatch(/· spec changed ·/)
})

test('a drive root as the project folder stays a root', async ($, on) => {
  const { submitted, spec, settle } = await project($, on, { door: DOOR }, undefined, { root: 'D:\\' })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  await pane.press({ key: 'do-next' })
  await pane.unmount()
  expect(submitted[0]!.text).toMatch(/\(D:\\openspec\\changes\\door\)/)
})

test('openspec installed by npm on Windows, as openspec.cmd, is run by that name', async ($, on) => {
  const { ran, turn } = await project($, on, { door: DOOR }, report([{ level: 'WARNING', path: 'a/spec.md', message: 'short' }]), { missing: ['openspec'] })
  await turn()
  expect(ran.map(r => r.argv[0])).toEqual(['openspec', 'openspec.cmd'])
  expect(await bandText($)).toBe('◆ door · 1 warning · tasks 1/2 · tests 1 auto, 1 manual')
})

test('without the openspec CLI the Spec tab says it is missing', async ($, on) => {
  const { ran, turn } = await project($, on, { door: DOOR }, report([]), { missing: ['openspec', 'openspec.cmd'] })
  await turn()
  expect(ran).toHaveLength(2)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-spec' })
  expect(await pane.find({ type: 'Text', text: WORDS.en.checkMissing })).toBeDefined()
  await pane.unmount()
})

test('a change whose folder is gone mid-scan is passed over, the others still read', async ($, on) => {
  await project($, on, { door: DOOR, gone: { 'tasks.md': '- [ ] 1.1 x\n' } }, undefined, { gone: ['gone'] })
  expect(await bandText($)).toBe('◆ door · tasks 1/2 · tests 1 auto, 1 manual')
})

// The parts together: the router, the review and the row above the prompt know the change in view.

test('a task sent from /spec gets OpenSpec\'s own skill from the router, no model asked', async ($, on) => {
  const { asked, spec, settle, submitted } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  const before = asked.length
  await pane.press({ key: 'do-next' })
  expect(submitted[0]!.text).toMatch(/^Do task 1\.2 of the OpenSpec change "door"[\s\S]*\n\nLoad the `opsx:apply` skill with the Skill tool first and follow it\.$/)
  expect(asked).toHaveLength(before)
  await pane.unmount()
})

test('the review reads the change in view beside the diff, and the row says both on one line', async ($, on) => {
  const { asked, spec, settle, put, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const design = '# Design\n\nThe grant is a row in door_access.\nIt expires at midnight.\nA manager may revoke it.\nRevoking is logged.\n'
  await $.tool.call({ tool: 'Write', file_path: '/proj/openspec/changes/door/design.md', content: design })
  put('door', 'design.md', design)
  await settle()
  await turn()
  await settle()
  const review = asked.find(a => /Review the diff above/.test(a.prompt))
  expect(review?.prompt).toMatch(
    /The OpenSpec change in progress in this project, "door"; the diff may work on it\.\nIts tasks not done yet:\n- 1\.2 Cover it with e2e\nWhat its specs require, each requirement with its scenarios:\n- added: api\/access: grant/,
  )
  expect(review?.promptBlocks?.at(-1)?.text).toMatch(/Where the diff works on the OpenSpec change above/)
  expect(await bandText($)).toMatch(/^◆ door · .* {2}│ {2}✎ 1 file \+3 −0/)
  // Too narrow for both: each on its own row.
  const narrow = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
  expect(textOf(await narrow.find({ key: 'lens-row' }))).toMatch(/^◆ door/)
  expect(textOf(await narrow.find({ key: 'review-row' }))).toMatch(/^✎ 1 file/)
  await narrow.unmount()
})
