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
  criticPrint,
  parseAdvice,
  parseHoles,
  parseOptions,
  parseRequirements,
  parseTaskList,
  parseTasks,
  parseTestCases,
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

test('test cases are read however the project marks them: bold, listed, a dot after the id, several files', () => {
  const md =
    '# Test Cases\n\n## TC-01. Grant\n\n- **Automated:** e2e/door.spec.ts, e2e\\api\\door.spec.ts\n\n' +
    '### TC-02 — Revoke\n\n**Manual**: needs a real lock\n\n## TC-03: Expiry\n\nSteps only.\n'
  expect(parseTestCases(md)).toEqual([
    { id: 'TC-01', title: 'Grant', mark: 'automated', files: ['e2e/door.spec.ts', 'e2e/api/door.spec.ts'] },
    { id: 'TC-02', title: 'Revoke', mark: 'manual' },
    { id: 'TC-03', title: 'Expiry', mark: 'none' },
  ])
  expect(parseTests(md)).toEqual({ cases: 3, automated: 1, manual: 1, unmarked: ['TC-03'] })
  // A tag, an abbreviation and an id with a part are no files.
  expect(parseTestCases('## TC-1.2: a\n\nAutomated: e2e/door.spec.ts, tag `@door:TC-1.2`, i.e. the smoke run\n')).toEqual([
    { id: 'TC-1.2', title: 'a', mark: 'automated', files: ['e2e/door.spec.ts'] },
  ])
})

test('the list of what is left to decide is found under its heading however the model writes it, and missed when it is not there', () => {
  const en = WORDS.en
  for (const heading of ['### Up to you:', '## **Up to you**', '## up to you'])
    expect(splitBrief(`## Gist\nA.\n${heading}\n- Pick the expiry\n`, en.decideHeading, en.none)).toEqual({ summary: '## Gist\nA.', decisions: ['Pick the expiry'] })
  expect(splitBrief('## Gist\nA.\n## Risks\nNone.\n', en.decideHeading, en.none)).toEqual({ summary: '## Gist\nA.\n## Risks\nNone.', decisions: [], isUnsplit: true })
})

test('the holes of the critic are read from the JSON its answer ends with; a task ticked is no new version', () => {
  const said = 'I read design.md [and the code].\n```json\n[{"hole": " No revoke task ", "where": "tasks.md", "fix": "Add one"}, {"where": "x"}, 3]\n```'
  expect(parseHoles(said)).toEqual([{ text: 'No revoke task', where: 'tasks.md', fix: 'Add one' }])
  expect(parseHoles('Nothing found.\n[]')).toEqual([])
  expect(parseHoles('No list at all.')).toBeUndefined()
  const many = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ hole: `h${i}` })))
  expect(parseHoles(many)).toHaveLength(5)
  // A detail the code settles is minor, and goes after the blockers; one that names none blocks.
  const graded = '[{"hole": "Initial value", "severity": "minor"}, {"hole": "Two files disagree", "severity": "blocker"}, {"hole": "No task"}]'
  expect(parseHoles(graded)!.map(h => [h.text, h.isMinor ?? false])).toEqual([
    ['Two files disagree', false],
    ['No task', false],
    ['Initial value', true],
  ])
  expect(criticPrint({ 'tasks.md': '- [x] 1.1 Do it\n' })).toBe(criticPrint({ 'tasks.md': '- [ ] 1.1 Do it\n' }))
  expect(criticPrint({ 'tasks.md': '- [ ] 1.1 Do it\n' })).not.toBe(criticPrint({ 'tasks.md': '- [ ] 1.1 Do it now\n' }))
})

test('the options the model offers are read from its JSON, fenced or not', () => {
  expect(parseOptions('```json\n[["Midnight", " A week ", "Midnight"], ["The manager"]]\n```', 2)).toEqual([['Midnight', 'A week'], ['The manager']])
  expect(parseOptions('[["Midnight"]]', 3)).toEqual([['Midnight'], [], []])
  expect(parseOptions('No idea.', 1)).toEqual([[]])
  // With the one it recommends first, and why; a point given only options, or none, has no why.
  const advised = '[{"options": ["Midnight", "A week"], "why": " It is what the design says. "}, ["The manager"], {"options": [], "why": "No way."}]'
  expect(parseOptions(advised, 3)).toEqual([['Midnight', 'A week'], ['The manager'], []])
  expect(parseAdvice(advised, 3)).toEqual(['It is what the design says.', null, null])
  expect(parseAdvice('No idea.', 1)).toEqual([null])
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
  // `slow`: the commands that run past their time.
  { root = '/proj', missing = [] as readonly string[], gone = [] as readonly string[], slow = [] as readonly string[] } = {},
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
  // A file of the project outside `openspec`, a test, say.
  const putAt = (path: string, text: string) => disk.set(at(path), text)
  const putMain = (capability: string, text: string) => disk.set(`${openspec}/specs/${capability}/spec.md`, text)
  for (const [change, files] of Object.entries(changes)) for (const [file, text] of Object.entries(files)) put(change, file, text)
  // The test TC-01 of the door change names: there, so its case has a test.
  disk.set(`${at(root).replace(/\/$/, '')}/e2e/door.spec.ts`, "test('TC-01 grant access', async () => {})\n")
  const isDir = (path: string) => [...disk.keys()].some(p => p.startsWith(`${at(path)}/`))
  const store = new Map<string, unknown>()
  const asked: ModelCompleteInput[] = []
  const opened: string[] = []
  const submitted: { text: string; asUser?: true; context?: readonly string[] }[] = []
  let held: Promise<void> | undefined
  // Set: the session refuses the next prompt, for this reason.
  let refusal: string | undefined
  const toasts: string[] = []
  // The agents the mod started, each answered by its id: the critic's run ends when a test says so.
  const spawned: { prompt: string; subagentType?: string; model?: string }[] = []
  const ran: { argv: readonly string[]; cwd?: string }[] = []
  if (validate)
    on('process.run', ($, e) => {
      ran.push({ argv: e.argv, ...(e.init?.cwd !== undefined ? { cwd: e.init.cwd } : {}) })
      if (missing.includes(e.argv[0]!)) return { deny: `spawn ${e.argv[0]} ENOENT` }
      if (slow.includes(e.argv[0]!)) return { deny: 'the process timed out after 30000 ms' }
      return { value: { exitCode: 0, stdout: validate(e.argv[2]!), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  // null: the API is down.
  let reply = (e: ModelCompleteInput): string | null => (e.prompt.includes('Question:') || e.prompt.includes('Вопрос:') ? 'It is revoked at once (design.md, Grant).' : BRIEF_EN)
  const clock = mock.clock(on, { now: 10_000 })
  // The skills the session has: OpenSpec's own, as its slash commands name them.
  on('command.list', () => ({ value: [{ name: 'opsx:apply', description: 'Implement the tasks of an OpenSpec change.', source: 'user' as const }] }))
  on('session.root', () => ({ value: root }))
  on('fs.exists', ($, e) => ({ value: disk.has(at(e.path)) || isDir(e.path) }))
  // How long listing a folder takes, on the mocked clock.
  let listDelay = 0
  on('fs.list', async ($, e) => {
    if (listDelay > 0) await clock.sleep(listDelay)
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
  const reads: string[] = []
  on('fs.read', ($, e) => {
    reads.push(at(e.path))
    return { value: disk.get(at(e.path)) ?? '' }
  })
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
  // How long the model takes to answer, on the mocked clock.
  let delay = 0
  on('model.complete', async ($, e) => {
    asked.push(e)
    if (delay > 0) await clock.sleep(delay)
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
  on('prompt.submit', async ($, e) => {
    // A prompt held in the queue while a turn runs.
    await held
    if (refusal !== undefined) return { drop: refusal }
    submitted.push({ text: e.text, ...(e.origin?.kind === 'plugin' && e.origin.asUser ? { asUser: true as const } : {}), ...(e.context?.length ? { context: e.context } : {}) })
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') return { result: { type: 'update' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
    return { deny: 'unexpected' }
  })
  on('agent.spawn', ($, e) => {
    spawned.push({ prompt: e.prompt, subagentType: e.subagentType, ...(e.model ? { model: e.model } : {}) })
    return { model: 'sonnet' }
  })
  on('agent.list', () => ({
    value: spawned.map((a, i) => ({ id: `critic-${i + 1}`, description: a.prompt.match(/change "(\w+)"/)?.[1] ? `Holes in ${a.prompt.match(/change "(\w+)"/)![1]}` : '', type: 'Explore', status: 'running' as const, spawnedBy: 'agent-lens' })),
  }))
  on('session.receive', ($, e) => ({ text: e.text }))
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
  const startTurn = () => $.turn.start({ text: 'go on', turnId: 't' })
  // A spawned agent's run ends with `answer`.
  const agentDone = (agentId: string, answer: string) =>
    $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
  return { spawned, startTurn, agentDone, store, asked, opened, submitted, toasts, ran, spec, settle, write, put, putAt, putMain, turn, clock, reads, setListDelay: (ms: number) => (listDelay = ms), setReply: (r: typeof reply) => (reply = r), setDelay: (ms: number) => (delay = ms), refuse: (why: string | undefined) => (refusal = why), hold: (until: Promise<void> | undefined) => (held = until) }
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
  expect(opened.at(-1)).toBe('Spec: door')
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
  expect(opened).toEqual(['Spec: door'])
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
  setReply(e =>
    e.prompt.includes('JSON') ? '```json\n[{"options": ["At midnight", "After a week"], "why": "The design says midnight."}, ["Only the manager", "Anyone with admin"]]\n```' : BRIEF_EN,
  )
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide (2)' } })

  // Opening the first asks for the options of all of them, once.
  await pane.press({ key: 'decide-0' })
  expect(asked.at(-1)!.prompt).toMatch(/1\. Pick the expiry \(design\.md\)\n2\. Who may revoke/)
  expect(asked.at(-1)!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect((store.get('brief:en:/proj/openspec:door') as { options?: string[][] }).options).toHaveLength(2)
  // The one the model recommends is marked, and why is said under it.
  expect(await pane.find({ key: 'option-0-0' })).toMatchObject({ props: { label: '★ At midnight' } })
  expect(await pane.find({ type: 'Text', text: /^Claude recommends it: The design says midnight\.$/ })).toBeDefined()
  expect(await pane.find({ key: 'option-0-1' })).toMatchObject({ props: { label: 'After a week' } })
  const calls = asked.length
  await pane.press({ key: 'option-0-1' })
  // The next one opens by itself; its own words go in the field.
  expect(await pane.find({ key: 'option-1-0' })).toBeDefined()
  await pane.input({ key: 'own-1', text: 'The manager and security' })
  expect(asked).toHaveLength(calls)
  expect(await pane.find({ type: 'Text', text: /^  → After a week$/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide' } })
  expect(await bandText($)).toBe('◆ door · 2 decided, not sent · tasks 1/2 · tests 1 auto, 1 manual')

  // Changed mind, then back: cleared and decided again.
  await pane.press({ key: 'decide-1' })
  await pane.press({ key: 'clear-1' })
  expect(await bandText($)).toMatch(/· 1 to decide · 1 decided, not sent ·/)
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
  // The brief made again is told what was decided, so it does not ask it again.
  expect(asked.filter(e => e.prompt.includes('## Up to you')).at(-1)!.prompt).toMatch(
    /decided already[^\n]*\n\n- Pick the expiry \(design\.md\)\n  Decision: After a week\n- Who may revoke \(proposal\.md\)\n  Decision: Only the manager/,
  )
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
  // Not done after all: it goes again as it went.
  await pane.press({ key: 'again-1' })
  expect(submitted).toHaveLength(2)
  expect(submitted[1]!.text).toBe(submitted[0]!.text)
  expect(toasts.at(-1)).toBe('Task 1.2 went to Claude.')
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
  expect(await bandText($)).toBe('◆ door · 1 spec error · 1 scenario with no case · 1 not matching the main spec · overlaps revoke · tasks 1/2 · tests 1 auto, 1 manual')
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
  // Still here after the turn: it goes again.
  await pane.press({ key: 'archive-again' })
  expect(submitted).toHaveLength(2)
  expect(submitted[1]!.text).toBe(submitted[0]!.text)
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
  expect(opened.at(-1)).toBe('Spec: mascot')
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
  expect((await spec('lang ru')).text).toBe('agent-lens теперь говорит по-русски: /changes, /spec и /router.')
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

test('a task the session refused is not kept as routed', async ($, on) => {
  const { spec, settle, refuse } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  refuse('a Stop hook stands')
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  await pane.press({ key: 'do-next' })
  expect(await pane.find({ type: 'Text', text: /^✗ The prompt was not sent: a Stop hook stands\.$/ })).toBeDefined()
  await pane.unmount()
  const router = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane', requestId: 'agent-lens-router', props: PANE.props })
  expect(await router.find({ type: 'Text', text: /sent from \/spec/ })).toBeUndefined()
  expect(await router.find({ type: 'Text', text: /^Nothing routed yet/ })).toBeDefined()
  await router.unmount()
})

test('the review reads the change in view beside the diff, and the row says both on one line', async ($, on) => {
  const { asked, spec, settle, put, putAt, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const design = '# Design\n\nThe grant is a row in door_access.\nIt expires at midnight.\nA manager may revoke it.\nRevoking is logged.\n'
  await $.tool.call({ tool: 'Write', file_path: '/proj/openspec/changes/door/design.md', content: design })
  put('door', 'design.md', design)
  // The code the turn wrote: the change's own Markdown is left to /spec, so this is what is reviewed.
  const door = 'export const grant = () => {}\nexport const revoke = () => {}\nexport const log = () => {}\n'
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/door.ts', content: door })
  putAt('/proj/src/door.ts', door)
  await settle()
  await turn()
  await settle()
  const review = asked.find(a => /Review the diff above/.test(a.prompt))
  expect(review?.prompt).toMatch(
    /The OpenSpec change in progress in this project, "door"; the diff may work on it\.\nIts tasks not done yet:\n- 1\.2 Cover it with e2e\nWhat its specs require, each requirement with its scenarios:\n- added: api\/access: grant/,
  )
  expect(review?.promptBlocks?.at(-1)?.text).toMatch(/Where the diff works on the OpenSpec change above/)
  expect(await bandText($)).toMatch(/^◆ door · .* {2}│ {2}✎ 2 files \+6 −0/)
  // Too narrow for both: each on its own row.
  const narrow = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
  // On a row of its own the change has the whole row, not what is left beside the review.
  expect(textOf(await narrow.find({ key: 'lens-row' }))).toBe('◆ door · spec changed · tasks 1/2 · +1 more')
  expect(textOf(await narrow.find({ key: 'review-row' }))).toMatch(/^✎ 2 files/)
  await narrow.unmount()
})

test('the Tests tab: each case and whether its test is there; picked ones, or all without a test, go to Claude', async ($, on) => {
  const cases =
    '# Test Cases\n\n## TC-01: Grant\n\nAutomated: e2e/door.spec.ts\n\n## TC-02: Revoke\n\nAutomated: e2e/door.spec.ts, tag `@door:TC-02`\n\n' +
    '## TC-03: Expiry\n\nManual: needs a real clock\n\n## TC-04: Unlock\n\nSteps only.\n'
  const { spec, settle, submitted, toasts, putAt } = await project($, on, { door: { ...DOOR, 'test-cases.md': cases } })
  // The test of TC-01 is there, in a repository inside the project; TC-010 is no test of TC-02's.
  putAt('/proj/__front/e2e/door.spec.ts', "test('TC-01 grant', tags(CHANGE, 'TC-01'), async () => {})\ntest('TC-010 other', async () => {})\n")
  await spec()
  await settle()
  expect(await bandText($)).toMatch(/TC-04 unmarked[\s\S]*1 case with no test/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-tests' })).toMatchObject({ props: { label: 'Tests (2)' } })
  await pane.press({ key: 'tab-tests' })
  expect(await pane.find({ type: 'Text', text: /^1 with a test · 1 without · 1 manual · 1 unmarked$/ })).toBeDefined()
  for (const said of ['✓ has a test', '● no test', '◇ manual', '✗ unmarked']) expect(await pane.find({ type: 'Text', text: new RegExp(`^${said}$`) })).toBeDefined()
  // A case with its test is closed: nothing to pick there.
  expect(await pane.find({ key: 'case-0' })).toBeUndefined()
  expect(await pane.find({ key: 'close-all' })).toMatchObject({ props: { label: 'close all without a test (2)', hotkey: 'c' } })
  expect(await pane.find({ key: 'send-picked' })).toBeUndefined()

  // One picked, the manual one: it alone goes.
  await pane.press({ key: 'case-2' })
  expect(await pane.find({ key: 'send-picked' })).toMatchObject({ props: { label: 'send picked (1)', hotkey: 'p' } })
  await pane.press({ key: 'send-picked' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ asUser: true })
  expect(submitted[0]!.text).toMatch(/^Close these test cases of the OpenSpec change "door" \(\/proj\/openspec\/changes\/door\/test-cases\.md\):\n- TC-03: Expiry \(Manual\)\n\nRead each case whole/)
  expect(toasts).toEqual(['1 test case went to Claude.'])
  expect(await pane.find({ key: 'send-picked' })).toBeUndefined()

  // Then all without a test: the two left, not the one sent.
  await pane.press({ key: 'close-all' })
  expect(submitted[1]!.text).toMatch(/:\n- TC-02: Revoke \(Automated: e2e\/door\.spec\.ts\)\n- TC-04: Unlock \(no mark yet\)\n\n/)
  expect(await pane.findAll({ type: 'Text', text: /^→ sent$/ })).toHaveLength(3)
  expect(await pane.find({ key: 'close-all' })).toBeUndefined()
  await pane.unmount()
})

test('Claude decides all the points left, one decided by hand aside, and the brief is made again once the spec moves', async ($, on) => {
  const { asked, spec, settle, setReply, submitted, toasts, put, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  setReply(e =>
    e.prompt.includes('JSON') ? '```json\n[{"options": ["At midnight", "After a week"], "why": "The design says midnight."}, ["Only the manager", "Anyone with admin"]]\n```' : BRIEF_EN,
  )
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ key: 'decide-all' })).toMatchObject({ props: { label: 'Claude decides all (2)', hotkey: 'd', variant: 'primary' } })
  await pane.press({ key: 'decide-0' })
  await pane.press({ key: 'option-0-1' })
  expect(await pane.find({ key: 'decide-all' })).toMatchObject({ props: { label: 'Claude decides all (1)' } })

  await pane.press({ key: 'decide-all' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ asUser: true })
  expect(submitted[0]!.text).toMatch(/^Decide these open points of the OpenSpec change "door" \(\/proj\/openspec\/changes\/door\) yourself:\n\n1\. Who may revoke \(proposal\.md\)\n\nFirst read/)
  expect(toasts.at(-1)).toBe('The point went to Claude to decide.')
  expect(await pane.find({ type: 'Text', text: /^  → Claude decides · sent to Claude$/ })).toBeDefined()
  expect(await pane.find({ key: 'decide-all' })).toBeUndefined()
  // The one decided by hand still waits to be written in.
  expect(await pane.find({ key: 'apply' })).toMatchObject({ props: { label: 'write 1 into the spec' } })
  expect(await bandText($)).toBe('◆ door · 1 decided, not sent · tasks 1/2 · tests 1 auto, 1 manual')

  // Claude writes it into the spec: the brief is made again from it.
  const briefs = asked.filter(a => !a.prompt.includes('JSON')).length
  put('door', 'proposal.md', '# Proposal\n\nLet managers grant door access. Only the manager may revoke it.\n')
  await turn()
  await settle()
  expect(asked.filter(a => !a.prompt.includes('JSON'))).toHaveLength(briefs + 1)
  await pane.unmount()
})

test('a scenario no test case covers is in the Tests tab, and goes to Claude to get a case and a test', async ($, on) => {
  const door = {
    ...DOOR,
    'specs/api/access/spec.md': '## ADDED Requirements\n\n### Requirement: Grant\n\n#### Scenario: By a manager\n\n#### Scenario: Expired\n',
    'test-cases.md': '# Test Cases\n\n## TC-01: Grant\n\nCovers: Requirement: Grant / Scenario: By a manager\nAutomated: e2e/door.spec.ts\n',
  }
  const { spec, settle, submitted } = await project($, on, { door })
  await spec()
  await settle()
  expect(await bandText($)).toMatch(/1 scenario with no case/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-tests' })).toMatchObject({ props: { label: 'Tests (1)' } })
  await pane.press({ key: 'tab-tests' })
  expect(await pane.find({ type: 'Text', text: /^Scenarios with no test case \(1\):$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^api\/access · Grant \/ Expired$/ })).toBeDefined()
  expect(await pane.find({ key: 'close-all' })).toMatchObject({ props: { label: 'close all without a test (1)' } })
  await pane.press({ key: 'scenario-0' })
  await pane.press({ key: 'send-picked' })
  expect(submitted[0]!.text).toMatch(
    /^Cover these scenarios of the OpenSpec change "door" \(\/proj\/openspec\/changes\/door\/test-cases\.md\), which no test case covers yet:\n- api\/access: Requirement: Grant \/ Scenario: Expired\n\nFor each, add a test case to test-cases\.md/,
  )
  expect(await pane.find({ type: 'Text', text: /^→ sent$/ })).toBeDefined()
  expect(await pane.find({ key: 'close-all' })).toBeUndefined()
  await pane.unmount()
})

test('decisions a turn did not write in are offered again, or come back to be changed', async ($, on) => {
  const { spec, settle, setReply, submitted, toasts, turn } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  setReply(e =>
    e.prompt.includes('JSON') ? '```json\n[{"options": ["At midnight", "After a week"], "why": "The design says midnight."}, ["Only the manager", "Anyone with admin"]]\n```' : BRIEF_EN,
  )
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  await pane.press({ key: 'decide-0' })
  await pane.press({ key: 'option-0-1' })
  await pane.press({ key: 'apply' })
  await pane.press({ key: 'decide-all' })
  expect(submitted).toHaveLength(2)
  expect(await pane.find({ type: 'Text', text: /^◌ Claude is writing the decisions in/ })).toBeDefined()
  expect(await pane.find({ key: 'resend' })).toBeUndefined()

  // The turn ends with the spec as it was: no waiting on it any more.
  await turn()
  await settle()
  expect(await pane.find({ type: 'Text', text: /^◌ Claude is writing/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^⚠ Claude ended the turn with the spec as it was/ })).toBeDefined()
  expect(await pane.find({ key: 'resend' })).toMatchObject({ props: { label: 'send again', hotkey: 'w', variant: 'primary' } })

  // Both go again: the one settled here to write in, the one left to Claude to decide.
  await pane.press({ key: 'resend' })
  expect(submitted).toHaveLength(3)
  expect(submitted[2]!.text).toMatch(/^I have settled open points[\s\S]*1\. Pick the expiry \(design\.md\)\n   Decision: After a week\n\nDecide these open points[\s\S]*1\. Who may revoke \(proposal\.md\)\n/)
  expect(toasts.at(-1)).toBe('2 points went to Claude again.')
  expect(await pane.find({ type: 'Text', text: /^◌ Claude is writing the decisions in/ })).toBeDefined()

  // Or they come back: the point left to Claude is open again, the answer waits to be written in.
  await turn()
  await settle()
  await pane.press({ key: 'reopen' })
  expect(await pane.find({ type: 'Text', text: /^⚠ Claude ended the turn/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^  → After a week$/ })).toBeDefined()
  expect(await pane.find({ key: 'decide-1' })).toMatchObject({ props: { label: 'decide' } })
  expect(await pane.find({ key: 'apply' })).toMatchObject({ props: { label: 'write 1 into the spec' } })
  expect(await bandText($)).toBe('◆ door · 1 to decide · 1 decided, not sent · tasks 1/2 · tests 1 auto, 1 manual')
  await pane.unmount()
})

test('model calls asked for while one runs wait their turn, each shown, and none is lost', async ($, on) => {
  const { asked, spec, setReply, setDelay, clock } = await project($, on, { door: DOOR })
  setDelay(1000)
  setReply(e => (e.prompt.includes('Question:') ? 'It is revoked at once (design.md, Grant).' : null))
  await spec()
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /^◌ Making the brief/ })).toBeDefined()
  await pane.press({ key: 'tab-ask' })
  await pane.press({ key: 'suggest-0' })
  await pane.input({ key: 'question', text: 'Who revokes?' })
  await pane.input({ key: 'question', text: 'Who revokes?' })
  expect(await pane.find({ type: 'Text', text: /^  next: your question, your question$/ })).toBeDefined()
  expect(await pane.find({ key: 'suggest-0' })).toBeUndefined()
  // Opened again while the brief of this version is being made: the same brief, not another.
  await spec()
  expect(asked).toHaveLength(1)
  await pane.press({ key: 'tab-ask' })

  await clock.advance(1000)
  expect(asked).toHaveLength(2)
  expect(await pane.find({ type: 'Text', text: /^◌ Looking for the answer/ })).toBeDefined()
  await clock.advance(1000)
  await clock.advance(1000)
  expect(asked.map(a => a.prompt.match(/Question: (.*)/)?.[1])).toEqual([undefined, 'What could go wrong?', 'Who revokes?'])
  expect(await pane.find({ type: 'Markdown', text: /revoked at once/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^◌ / })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /next:/ })).toBeUndefined()
  // The brief's failure stays offered: the answers after it do not put it away.
  expect(await pane.find({ type: 'Text', text: /^✗ The model gave no answer/ })).toBeDefined()
  expect(await pane.find({ key: 'retry' })).toBeDefined()
  await pane.unmount()
})

test('a picked case that got its test, or scenario that got a case, is no longer picked', async ($, on) => {
  const cases = '# Test Cases\n\n## TC-01: Grant\n\nAutomated: e2e/door.spec.ts\n\n## TC-02: Revoke\n\nAutomated: e2e/door.spec.ts\n'
  const { spec, settle, putAt, turn } = await project($, on, { door: { ...DOOR, 'test-cases.md': cases } })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tests' })
  await pane.press({ key: 'case-1' })
  expect(await pane.find({ key: 'send-picked' })).toMatchObject({ props: { label: 'send picked (1)' } })
  // Claude wrote its test meanwhile.
  putAt('/proj/e2e/door.spec.ts', "test('TC-01 grant', async () => {})\ntest('TC-02 revoke', async () => {})\n")
  await turn()
  await settle()
  expect(await pane.find({ key: 'send-picked' })).toBeUndefined()
  await pane.unmount()
})

test('the row, the badges and the archive agree on what wants a look', async ($, on) => {
  const done = { ...DOOR, 'tasks.md': TASKS.replace('- [ ] 1.2', '- [x] 1.2'), 'test-cases.md': `${TESTS}\n## TC-03: Expiry\n\nAutomated: e2e/expiry.spec.ts\n` }
  const { spec, settle, setReply, put, turn } = await project($, on, { door: done }, report([]))
  setReply(() => '## Gist\nManagers grant door access.\n## Up to you\nNothing.\n')
  await spec()
  await settle()
  // A case without its test: yellow, and it stands between the change and the archive.
  expect(await bandText($)).toBe('◆ door · 1 case with no test · tasks 2/2 · tests 2 auto, 1 manual')
  const band = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND })
  expect(JSON.stringify(await band.find({ key: 'row-change' }))).toMatch(/"color":"warning"/)
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-tasks' })
  expect(await pane.find({ type: 'Text', text: /^  · 1 test case has no test yet \(see Tests\)$/ })).toBeDefined()
  expect(await pane.find({ key: 'archive' })).toBeUndefined()

  // A brief older than the spec counts nothing on the Decide tab.
  setReply(() => BRIEF_EN)
  await pane.press({ key: 'tab-brief' })
  await pane.press({ key: 'refresh' })
  await settle()
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide (2)' } })
  put('door', 'design.md', '# Design\n\nThe grant is a row in door_access.\nIt expires at midnight.\n')
  await turn()
  await settle()
  expect(await pane.find({ key: 'tab-decide' })).toMatchObject({ props: { label: 'Decide' } })

  // A brief without its list of what is left: not known, not "nothing".
  setReply(() => '## Gist\nManagers grant door access.\n')
  await pane.press({ key: 'refresh' })
  await settle()
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ type: 'Text', text: /^⚠ The brief came without its "Up to you" section/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Nothing is left for you to decide/ })).toBeUndefined()
  expect(await bandText($)).toMatch(/^◆ door · what to decide unknown · /)
  await pane.unmount()
})

test('an edit to the change is read beside the tool call, the test files as last read', async ($, on) => {
  const { spec, settle, reads, turn, put, clock, setListDelay } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const tests = () => reads.filter(p => p === '/proj/e2e/door.spec.ts').length
  const was = tests()
  put('door', 'tasks.md', TASKS.replace('- [ ] 1.2', '- [x] 1.2'))
  // A slow disk: the tool call is back before the scan, and the row moves on once it ends.
  setListDelay(100)
  await $.tool.call({ tool: 'Write', file_path: '/proj/openspec/changes/door/tasks.md', content: TASKS.replace('- [ ] 1.2', '- [x] 1.2') })
  expect(await bandText($)).toMatch(/tasks 1\/2/)
  await clock.advance(5000)
  setListDelay(0)
  expect(await bandText($)).toMatch(/tasks 2\/2/)
  expect(tests()).toBe(was)
  // A turn's end reads them again.
  await turn()
  await settle()
  expect(tests()).toBe(was + 1)
})

test('openspec validate that runs past its time is said so, not taken for a CLI not installed', async ($, on) => {
  const { spec, settle } = await project($, on, { door: DOOR }, report([]), { slow: ['openspec'] })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-spec' })
  expect(await pane.find({ type: 'Text', text: /^⚠ openspec validate ran over 30 seconds and was stopped/ })).toMatchObject({ props: { color: 'warning' } })
  expect(await pane.find({ type: 'Text', text: /did not run here/ })).toBeUndefined()
  await pane.unmount()
})

test('a turn the person stops sends no holes and starts no critic: they wait for a turn that ends with an answer', async ($, on) => {
  const { spec, settle, submitted, turn, spawned, agentDone, startTurn } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await turn()
  await settle()
  expect(spawned).toHaveLength(1)
  await startTurn()
  await agentDone('critic-1', 'Read it all.\n```json\n[{"hole": "No task revokes access", "where": "tasks.md", "fix": "Add a revoke task"}]\n```')
  await settle()
  for (const reason of ['aborted', 'error'] as const) {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason, usage: { ...USAGE, model: 'test' } })
    await settle()
  }
  expect(submitted).toHaveLength(0)
  expect(spawned).toHaveLength(1)
  expect(await bandText($)).toMatch(/· 1 hole/)
  await turn()
  await settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]!.text).toMatch(/1\. No task revokes access/)
})

test('a button pressed again while its prompt waits for the turn under way goes to Claude once, and says it went', async ($, on) => {
  const { spec, settle, submitted, toasts, hold } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  let release = () => {}
  hold(new Promise<void>(r => (release = r)))
  await pane.press({ key: 'tab-tasks' })
  await pane.press({ key: 'do-next' })
  await settle()
  await pane.press({ key: 'do-next' })
  await pane.press({ key: 'tab-decide' })
  await pane.press({ key: 'decide-all' })
  await settle()
  await pane.press({ key: 'decide-all' })
  await settle()
  expect(toasts.at(-1)).toBe('Sent already: on its way to Claude.')
  hold(undefined)
  release()
  await settle()
  expect(submitted.map(x => x.text.split('\n')[0])).toHaveLength(2)
  await pane.unmount()
})

test('the critic starts once however fast f is pressed', async ($, on) => {
  const { spec, settle, spawned } = await project($, on, { door: DOOR })
  await spec('critic button')
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  await Promise.all([pane.press({ key: 'find-holes' }), pane.press({ key: 'find-holes' })])
  await settle()
  expect(spawned).toHaveLength(1)
  await pane.unmount()
})

test('the critic starts once for two turns that end close together', async ($, on) => {
  const { spec, settle, turn, spawned } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await Promise.all([turn(), turn()])
  await settle()
  expect(spawned).toHaveLength(1)
})

test('the critic in auto mode: what it finds goes to Claude to close, three rounds of a change at most', async ($, on) => {
  const { spec, settle, submitted, toasts, put, turn, spawned, agentDone, startTurn, store } = await project($, on, { door: DOOR })
  expect((await spec('critic')).text).toMatch(/^The critic is off\./)
  expect((await spec('critic auto')).text).toMatch(/after each turn that changes it/)
  expect(store.get('critic-mode')).toBe('auto')
  await turn()
  await settle()
  expect(spawned).toHaveLength(1)
  // The type it asks for, Explore, the test engine does not resolve: the model it does.
  expect(spawned[0]).toMatchObject({ model: 'sonnet' })
  expect(spawned[0]!.prompt).toMatch(/OpenSpec change "door" \(\/proj\/openspec\/changes\/door\)/)
  expect(await bandText($)).toMatch(/· looking for holes/)
  // A turn that leaves the change as it was starts no other.
  await turn()
  await settle()
  expect(spawned).toHaveLength(1)

  // Found while the main loop works: sent once its turn ends.
  await startTurn()
  await agentDone('critic-1', 'Read it all.\n```json\n[{"hole": "No task revokes access", "where": "tasks.md", "fix": "Add a revoke task"}]\n```')
  await settle()
  expect(submitted).toHaveLength(0)
  expect(await bandText($)).toMatch(/· 1 hole/)
  await turn()
  await settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ asUser: true })
  expect(submitted[0]!.text).toMatch(/found these holes[\s\S]*1\. No task revokes access \(tasks\.md\)\n   Fix: Add a revoke task/)
  // Claude is given a way through them: close, ask or decline each, and say which it did.
  expect(submitted[0]!.text).toMatch(/- close it:[\s\S]*- ask me[\s\S]*- decline it[\s\S]*End with a table/)
  expect(toasts.at(-1)).toBe('1 hole went to Claude to close.')

  // Claude closes them: the critic reads again, told what went before, and its holes go too.
  for (const round of [2, 3]) {
    put('door', 'tasks.md', `${TASKS}- [ ] 1.${round + 1} Revoke access, round ${round}\n`)
    await turn()
    await settle()
    expect(spawned).toHaveLength(round)
    expect(spawned.at(-1)!.prompt).toMatch(/reported before and sent to be closed[^\n]*\n- No task revokes access \(tasks\.md\)\n  Decision: Add a revoke task/)
    await agentDone(`critic-${round}`, `[{"hole": "Hole ${round}", "where": "design.md", "fix": "Say it"}]`)
    await settle()
    expect(submitted).toHaveLength(round)
  }
  // Three rounds went: what the last changed is left to the person.
  put('door', 'design.md', '# Design\n\nSaid.\n')
  await turn()
  await settle()
  expect(spawned).toHaveLength(3)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ type: 'Text', text: /^3 rounds of holes went to Claude/ })).toBeDefined()
  // What each round sent stays in view, by its round.
  expect(await pane.find({ type: 'Text', text: /^Sent to Claude to close:$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^round 1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• No task revokes access \(tasks\.md\)$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^round 3$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• Hole 3 \(design\.md\)$/ })).toBeDefined()
  await pane.unmount()
  // A change to the text after that starts none: the person asks again with f, and the rounds start over.
  put('door', 'design.md', '# Design\n\nSaid again.\n')
  await turn()
  await settle()
  expect(spawned).toHaveLength(3)
  const again = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await again.press({ key: 'tab-decide' })
  await again.press({ key: 'find-holes' })
  expect(spawned).toHaveLength(4)
  await agentDone('critic-4', '[{"hole": "Hole 4", "where": "design.md", "fix": "Say it"}]')
  await settle()
  expect(submitted).toHaveLength(4)
  expect(await again.find({ type: 'Text', text: /^→ sent to Claude to close · round 1 of 3$/ })).toBeDefined()
  await again.unmount()
})

test('in auto mode the details the code can settle stay on the tab, and a look with no blocker ends the rounds', async ($, on) => {
  const { spec, settle, submitted, put, turn, spawned, agentDone } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await turn()
  await settle()
  await agentDone('critic-1', '[{"hole": "No revoke task", "where": "tasks.md", "fix": "Add one", "severity": "blocker"}, {"hole": "Initial loading flag", "where": "design.md", "fix": "Say false", "severity": "minor"}]')
  await settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]!.text).toMatch(/No revoke task/)
  expect(submitted[0]!.text).not.toMatch(/Initial loading flag/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ type: 'Text', text: /^Details the code can settle/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• Initial loading flag \(design\.md\)$/ })).toBeDefined()
  expect(await bandText($)).not.toMatch(/hole/)

  // Closed: the next look finds details alone, and the change is ready; none goes by itself.
  put('door', 'tasks.md', `${TASKS}- [ ] 1.3 Revoke access\n`)
  await turn()
  await settle()
  expect(spawned).toHaveLength(2)
  await agentDone('critic-2', '[{"hole": "Toast wording", "where": "specs", "fix": "Pick one", "severity": "minor"}]')
  await settle()
  expect(submitted).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: /^✓ No blocking holes: the change can be built\.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^The critic looks again on f, not by itself\.$/ })).toBeDefined()
  // A change to the text after it starts no critic; h sends the details on the person's word.
  put('door', 'design.md', '# Design\n\nMore.\n')
  await turn()
  await settle()
  expect(spawned).toHaveLength(2)
  await pane.press({ key: 'close-holes' })
  expect(submitted).toHaveLength(2)
  expect(submitted[1]!.text).toMatch(/Toast wording/)
  expect(await pane.find({ key: 'close-holes' })).toBeUndefined()
  await pane.unmount()
})

test("the critic's report handed back to the main conversation is the Decide tab's, not read by Claude", async ($, on) => {
  const { spec, settle, turn, spawned } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await turn()
  await settle()
  expect(spawned).toHaveLength(1)
  const handBack = (from: string) =>
    $.session.receive({ origin: { kind: 'peer' }, text: `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] Found one.\n</agent-message>` })
  expect(await handBack('critic-1')).toMatchObject({ consumed: expect.any(String) })
  expect(await handBack('worker-7')).toMatchObject({ text: expect.stringMatching(/worker-7/) })
})

test("the critic's report the engine queues as a prompt once its run ended is dropped, its holes sent once", async ($, on) => {
  const { spec, settle, turn, spawned, agentDone, submitted } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await turn()
  await settle()
  expect(spawned).toHaveLength(1)
  const report = '[{"hole": "No task revokes access", "where": "tasks.md", "fix": "Add a revoke task"}]'
  await agentDone('critic-1', report)
  await settle()
  expect(submitted).toHaveLength(1)
  // As a session's transcript keeps it: the hand-back queued after the agent's end, from a peer.
  const handBack = (from: string) =>
    $.prompt.submit({
      text: `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n\n${report}\n</agent-message>`,
      origin: { kind: 'peer' },
      isMeta: true,
      wait: false,
    })
  expect(await handBack('critic-1')).toMatchObject({ drop: expect.any(String) })
  expect(submitted).toHaveLength(1)
  expect(await handBack('worker-7')).toMatchObject({ text: expect.stringMatching(/worker-7/) })
  expect(submitted).toHaveLength(2)
})

test('a critic started while the holes before wait in the queue reads the next round, and its record stands', async ($, on) => {
  const { spec, settle, submitted, put, turn, spawned, agentDone, hold } = await project($, on, { door: DOOR })
  await spec('critic auto')
  await turn()
  await settle()
  let release = () => {}
  hold(new Promise<void>(resolve => (release = resolve)))
  await agentDone('critic-1', '[{"hole": "No revoke task", "where": "tasks.md", "fix": "Add one"}]')
  await settle()
  // A turn ends while the prompt waits: the critic it starts is round 1's.
  put('door', 'tasks.md', `${TASKS}- [ ] 1.3 Revoke access\n`)
  await turn()
  await settle()
  expect(spawned).toHaveLength(2)
  hold(undefined)
  release()
  await settle()
  expect(submitted).toHaveLength(1)
  await agentDone('critic-2', '[{"hole": "Hole 2", "where": "design.md", "fix": "Say it"}]')
  await settle()
  expect(submitted).toHaveLength(2)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ type: 'Text', text: /^→ sent to Claude to close · round 2 of 3$/ })).toBeDefined()
  await pane.unmount()
})

test('the critic on a button: f looks for holes, h sends them; off, the tab says how to turn it on', async ($, on) => {
  const { spec, settle, submitted, turn, spawned, agentDone } = await project($, on, { door: DOOR })
  await spec()
  await settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-decide' })
  expect(await pane.find({ type: 'Text', text: /^An agent can read the change against the code for holes/ })).toBeDefined()
  expect(await pane.find({ key: 'find-holes' })).toBeUndefined()

  await spec('critic button')
  await turn()
  await settle()
  expect(spawned).toHaveLength(0)
  await pane.press({ key: 'find-holes' })
  expect(spawned).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: /^◌ The agent is reading the change against the code/ })).toBeDefined()
  expect(await pane.find({ key: 'find-holes' })).toBeUndefined()
  await agentDone('critic-1', 'I could not finish.')
  expect(await pane.find({ type: 'Text', text: /^✗ The agent gave no list of holes\.$/ })).toBeDefined()

  await pane.press({ key: 'find-holes' })
  await agentDone('critic-2', '[{"hole": "No revoke task", "where": "tasks.md", "fix": "Add one"}]')
  expect(await pane.find({ type: 'Text', text: /^• No revoke task \(tasks\.md\)$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^  → Add one$/ })).toBeDefined()
  expect(submitted).toHaveLength(0)
  await pane.press({ key: 'close-holes' })
  expect(submitted).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: /^→ sent to Claude to close · round 1 of 3$/ })).toBeDefined()
  expect(await pane.find({ key: 'close-holes' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^round 1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• No revoke task \(tasks\.md\)$/ })).toBeDefined()
  await pane.press({ key: 'find-holes' })
  await agentDone('critic-3', 'All closed.\n[]')
  expect(await pane.find({ type: 'Text', text: /^✓ The agent found no holes\.$/ })).toBeDefined()
  await pane.unmount()
})
