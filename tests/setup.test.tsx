import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DENY, expand, newRed, parseConfig, permissionIssues, timingIssues } from '../hooks/setup/checks'
import { checkDocs, parseFindings, pathsIn, pathsNamed, termsOf } from '../hooks/setup/docs'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MATT = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro', 'diagnosing-bugs', 'code-review']
const GLOSSARY = '# Ordering\n\nTakes and tracks orders.\n\n## Language\n\n**Order**:\nA request to buy goods.\n_Avoid_: Purchase\n\n**Invoice**:\nA request for payment. Sent after delivery.\n'

const issuesOf = (files: Record<string, string>, missing: string[] = []) => checkDocs(files, new Set(missing)).map(i => [i.file, i.kind, i.detail ?? null])

test('the files are held to their size, the paths they name, and the forms of the glossary and the ADRs', () => {
  expect(issuesOf({ 'GLOSSARY.md': GLOSSARY, 'CLAUDE.md': 'Read `ARCHITECTURE.md` first.\n' })).toEqual([])
  expect(issuesOf({ 'CLAUDE.md': `${'line\n'.repeat(121)}` })).toEqual([['CLAUDE.md', 'size', '121/120']])
  // A glossary CLAUDE.md imports is read into every turn with it: it counts.
  expect(issuesOf({ 'CLAUDE.md': `${'line\n'.repeat(60)}@GLOSSARY.md\n`, 'GLOSSARY.md': `# Ordering\n\n${'x\n'.repeat(60)}` }).filter(i => i[1] === 'size')).toEqual([['CLAUDE.md', 'size', '123/120 with @GLOSSARY.md']])
  // A path a file names that is not there; a command, a glob or a placeholder is no path.
  expect(pathsIn('Run `npm test`, see `src/orders/`, `*.ts`, `src/<name>.ts` and `README.md`.')).toEqual(['src/orders/', 'README.md'])
  expect(pathsNamed({ 'ARCHITECTURE.md': '`src/orders/` holds them.', 'GLOSSARY.md': '`src/x.ts`' })).toEqual(['src/orders'])
  expect(issuesOf({ 'ARCHITECTURE.md': 'Orders: `src/orders/`.\n' }, ['src/orders'])).toEqual([['ARCHITECTURE.md', 'path', 'src/orders/']])
  // The glossary holds terms, a sentence or two each, and no code.
  expect(issuesOf({ 'GLOSSARY.md': `${GLOSSARY}\nSome loose note after the terms.\n` })).toEqual([['GLOSSARY.md', 'glossary-shape', null]])
  expect(issuesOf({ 'GLOSSARY.md': '## Language\n\n**Order**:\nOne. Two. Three.\n' })).toEqual([['GLOSSARY.md', 'glossary-long', null]])
  expect(issuesOf({ 'GLOSSARY.md': '## Language\n\n**Order**:\nKept in `src/orders/order.ts`.\n' }).map(i => i[1])).toContain('glossary-path')
  expect(issuesOf({ 'GLOSSARY.md': '## Language\n\n```ts\ntype Order = {}\n```\n' }).map(i => i[1])).toContain('glossary-code')
  // ADRs: NNNN-slug.md, from 0001 with none skipped, each with a title, frontmatter allowed.
  const adr = '# Postgres for the write model\n\nBecause.\n'
  expect(issuesOf({ 'docs/adr/0001-postgres.md': adr, 'docs/adr/0002-events.md': '---\nstatus: accepted\n---\n# Events\n' })).toEqual([])
  expect(issuesOf({ 'docs/adr/0001-postgres.md': adr, 'docs/adr/0003-events.md': adr })).toEqual([['docs/adr', 'adr-numbers', '3']])
  expect(issuesOf({ 'docs/adr/postgres.md': adr, 'docs/adr/0001-x.md': 'No title.\n' }).map(i => i[1])).toEqual(['adr-name', 'adr-title'])
  // A fact kept in two files.
  const fact = 'Every API error goes out through AppError, with its code and a message for people.'
  expect(issuesOf({ 'CLAUDE.md': `- ${fact}\n`, 'CODING_STANDARDS.md': `${fact}\n` })).toEqual([['CODING_STANDARDS.md', 'duplicate', 'CLAUDE.md']])
  // AGENTS.md that CLAUDE.md imports is read into every turn with it: it counts.
  expect(issuesOf({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': 'line\n'.repeat(130) })).toEqual([['CLAUDE.md', 'size', '131/120 with @AGENTS.md']])
  // The glossary by its old name, which Matt's skills no longer read.
  expect(issuesOf({ 'CONTEXT.md': GLOSSARY, 'CONTEXT-MAP.md': '[a](a/CONTEXT.md)\n' })).toEqual([
    ['CONTEXT.md', 'glossary-name', 'GLOSSARY.md'],
    ['CONTEXT-MAP.md', 'glossary-name', 'GLOSSARY-MAP.md'],
  ])
})

// A project on a disk of `files`, with Matt's skills listed unless `noMatt`, and the OpenSpec CLI
// unless `noOpenspec`; `openspec init` writes its folder. `sh` answers the commands the checks run
// through the shell, each green where it says nothing.
type Git = (args: string[]) => { exitCode: number; stdout: string } | undefined
type Sh = (command: string, cwd: string) => { exitCode: number; stdout?: string } | undefined
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; noMatt?: boolean; noOpenspec?: boolean; git?: Git; sh?: Sh } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const disk = new Map(Object.entries(opts.files ?? {}).map(([f, t]) => [`/proj/${f}`, t]))
  const isDir = (p: string) => [...disk.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  const store = new Map<string, unknown>()
  const submitted: string[] = []
  const commands: string[] = []
  const runs: string[][] = []
  const opened: string[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) || isDir(e.path) }))
  on('fs.read', ($, e) => (disk.has(e.path) ? { value: disk.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of disk.keys())
      if (p.startsWith(`${dir}/`)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/')
        names.set(name!, rest.length > 0 ? 'dir' : 'file')
      }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: opts.noMatt ? [] : MATT.map(s => ({ name: `mattpocock-skills:${s}`, description: s, source: 'plugin' as const, plugin: 'mattpocock-skills' })) }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('command.run', ($, e) => (commands.push(e.args ? `${e.command} ${e.args}` : e.command), {}))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'git') {
      const r = opts.git?.(e.argv.slice(e.argv.indexOf('-C') + 2)) ?? { exitCode: 128, stdout: '' }
      return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'sh') {
      const r = e.argv[2] === 'exit 0' ? { exitCode: 0 } : (opts.sh?.(e.argv[2]!, e.init?.cwd ?? '/proj') ?? { exitCode: 0 })
      return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.noOpenspec && e.argv[0]!.startsWith('openspec')) return { deny: 'spawn openspec ENOENT' }
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: '1.14.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'init') disk.set('/proj/openspec/config.yaml', 'schema: spec-driven\n')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
  // The review of a turn's diff asks a model: it finds nothing here.
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"findings":[]}', usage: USAGE } }))
  const spawned: string[] = []
  on('agent.spawn', ($, e) => (spawned.push(e.prompt), { model: 'sonnet' }))
  on('agent.list', () => ({ value: spawned.map((_, i) => ({ id: `judge-${i + 1}`, description: 'The docs in this turn', type: 'Explore', status: 'running' as const, spawnedBy: 'agent-lens' })) }))
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', ($, e) => {
    if (e.tool !== 'Write') return { deny: 'unexpected' }
    disk.set(e.file_path, e.content)
    return { result: { type: 'create' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const setup = (args = '') => $.command.run({ command: 'setup-project', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // A turn of the main loop that writes `files` as Claude would, then ends with an answer.
  const turn = async (files: Record<string, string> = {}) => {
    await $.turn.start({ text: 'go', turnId: 't' })
    for (const [f, t] of Object.entries(files)) disk.set(`/proj/${f}`, t)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  }
  // Lets what a turn's end started beside it finish.
  const settle = () => clock.advance(10)
  const agentDone = (agentId: string, answer: string) =>
    $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
  const shells = () => runs.filter(r => r[0] === 'sh' && r[2] !== 'exit 0').map(r => r[2]!)
  return { clock, disk, store, submitted, commands, runs, shells, opened, spawned, setup, turn, settle, agentDone }
}

test('missing Matt’s skills, /setup-project recommends them and goes on, the step that needs them left out', async ($, on) => {
  const w = await world($, on, { noMatt: true })
  expect((await w.setup()).text).toMatch(/^○ Matt’s skills recommended \(setup-matt-pocock-skills, domain-modeling, .*retro missing\): \/plugin install mattpocock-skills · ✓ OpenSpec 1\.14\.1/)
  await w.settle()
  expect(w.opened).toEqual(['agent-lens-setup'])
  expect(w.commands).toEqual([])
  // OpenSpec goes on, and the map is the first step sent.
  expect(w.runs.find(r => r[1] === 'init')).toBeDefined()
  expect(w.submitted[0]).toMatch(/^Step 4 of \/setup-project/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^  left out: Matt’s skills are not installed/ })).toBeDefined()
  await pane.unmount()
})

test('no OpenSpec CLI: it is recommended, and the two steps of OpenSpec are left out', async ($, on) => {
  const w = await world($, on, { noOpenspec: true })
  expect((await w.setup()).text).toMatch(/^✓ Matt’s skills installed · ○ OpenSpec recommended: npm install -g @fission-ai\/openspec/)
  await w.settle()
  expect(w.commands).toEqual(['mattpocock-skills:setup-matt-pocock-skills'])
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.findAll({ type: 'Text', text: /^  left out: the OpenSpec CLI is not installed/ })).toHaveLength(2)
  await pane.unmount()
})

test('the steps go one at a time: Matt’s setup, openspec init by the mod, then each prompt once the files of the one before pass', async ($, on) => {
  const w = await world($, on)
  expect((await w.setup()).text).toBe('✓ Matt’s skills installed · ✓ OpenSpec 1.14.1, a step initialises openspec/ · ○ no CI: its step is left out\nOpened the setup: the steps go to Claude one at a time.')
  await w.settle()
  expect(w.opened).toEqual(['agent-lens-setup'])
  expect(w.commands).toEqual(['mattpocock-skills:setup-matt-pocock-skills'])
  // Matt's skill asks first: a turn that writes none of its files leaves the step with Claude.
  await w.turn()
  await w.settle()
  expect(w.runs.filter(r => r[1] === 'init')).toEqual([])
  // Its files written, openspec init runs, and the map goes to Claude.
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  expect(w.runs.find(r => r[1] === 'init')).toEqual(['openspec', 'init', '--tools', 'claude', '--no-animation'])
  // A project with no docs of its own has nothing written to sort: the map comes next.
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/^Step 4 of \/setup-project[\s\S]*`GLOSSARY\.md` at the root/)

  // A glossary out of its form goes back once with what failed; failing again, it waits for the person.
  const bad = `${GLOSSARY}\nA loose note.\n`
  await w.turn({ 'GLOSSARY.md': bad, 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "The map: glossary, architecture, ADRs" found these\.[\s\S]*- GLOSSARY\.md:14: not a term entry/)
  await w.turn()
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^4\. The map: glossary, architecture, ADRs$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^· check failed$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• GLOSSARY\.md:14: not a term entry/ })).toBeDefined()
  // Fixed by hand: the next turn's end finds it passing, and the standards go.
  w.disk.set('/proj/GLOSSARY.md', GLOSSARY)
  await pane.press({ key: 'setup-again' })
  await w.settle()
  expect(w.submitted).toHaveLength(3)
  expect(w.submitted[2]).toMatch(/^Step 4 of/)
  await w.turn()
  await w.settle()
  expect(w.submitted[3]).toMatch(/^Step 5 of \/setup-project[\s\S]*CODING_STANDARDS\.md/)
  // Skipped, the next goes.
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[4]).toMatch(/^Step 6 of \/setup-project[\s\S]*\.claude\/agent-lens\.json/)
  await pane.unmount()
})

test('a project with docs of its own has them sorted first: each piece to its file, the glossary off its old name', async ($, on) => {
  const w = await world($, on, {
    files: {
      'CLAUDE.md': '# Rules\n\nUse BEM.\n',
      'CONTEXT.md': GLOSSARY,
      'docs/agents/issue-tracker.md': 'GitLab.\n',
      'docs/agents/domain.md': 'Read `CONTEXT.md`.\n',
      'openspec/config.yaml': 'schema: spec-driven\n',
    },
  })
  await w.setup()
  await w.settle()
  // Matt's setup and OpenSpec are there already: what is written goes first.
  expect(w.commands).toEqual([])
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/^Step 3 of \/setup-project[\s\S]*CONTEXT\.md[\s\S]*AskUserQuestion/)
  // It writes no file of its own: the glossary left by its old name goes back once.
  await w.turn()
  await w.settle()
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "What is already written" found these\.[\s\S]*CONTEXT\.md: the glossary by its old name/)
  // Renamed, the step is done and the map goes, adding to what is there.
  w.disk.delete('/proj/CONTEXT.md')
  await w.turn({ 'GLOSSARY.md': GLOSSARY, 'docs/agents/domain.md': 'Read `GLOSSARY.md`.\n' })
  await w.settle()
  expect(w.submitted[2]).toMatch(/^Step 4 of \/setup-project[\s\S]*the last number in docs\/adr\//)
})

test('a run kept from before the step of what is written goes on, that step taken as skipped', async ($, on) => {
  const kept = { root: '/proj', current: 'map', steps: { matt: { status: 'done' }, openspec: { status: 'done' }, map: { status: 'sent' }, standards: { status: 'waiting' }, workflow: { status: 'waiting' }, config: { status: 'waiting' } } }
  const w = await world($, on)
  w.store.set('setup:/proj', kept)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^3\. What is already written$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^4\. The map: glossary, architecture, ADRs$/ })).toBeDefined()
  await pane.unmount()
})

test('a project set up has its files checked at the start and on each edit, the row saying how many fail', async ($, on) => {
  const w = await world($, on, { files: { 'docs/agents/workflow.md': '# How work goes\n', 'CLAUDE.md': 'See `ARCHITECTURE.md`.\n' } })
  expect((await w.setup('check')).text).toBe('The check found 1:\n  CLAUDE.md:1: names `ARCHITECTURE.md`, which is not there')
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: 'docs: 1 issue' })).toBeDefined()
  await band.unmount()
  await $.tool.call({ tool: 'Write', file_path: '/proj/ARCHITECTURE.md', content: '# Map\n' })
  await w.settle()
  expect((await w.setup('check')).text).toBe('The files pass the check.')
})

test('the terms of a glossary and the docs agent’s findings are read, the blockers first', () => {
  expect(termsOf(GLOSSARY)).toEqual(['Order', 'Invoice'])
  expect(termsOf('**No-show (неявка)**:\nA shift missed.\n')).toEqual(['No-show'])
  const said = 'Read it.\n```json\n[{"file": "CLAUDE.md", "problem": "A wish", "fix": "Drop it", "severity": "minor"}, {"file": "GLOSSARY.md", "problem": "Untrue", "fix": "Say X"}]\n```'
  expect(parseFindings(said)).toEqual([
    { file: 'GLOSSARY.md', text: 'Untrue', fix: 'Say X' },
    { file: 'CLAUDE.md', text: 'A wish', fix: 'Drop it', isMinor: true },
  ])
  expect(parseFindings('No list.')).toBeUndefined()
})

test('what may have gone stale: a part of the map much changed since the map, a term found nowhere else', async ($, on) => {
  const git: Git = args => {
    if (args[0] === 'log') return { exitCode: 0, stdout: 'abc123\n' }
    if (args[0] === 'rev-list') return { exitCode: 0, stdout: args.at(-1) === 'src/orders' ? '20\n' : '2\n' }
    if (args[0] === 'grep') return { exitCode: args.includes('Invoice') ? 1 : 0, stdout: '' }
    return undefined
  }
  const w = await world($, on, {
    git,
    files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY.md': GLOSSARY, 'ARCHITECTURE.md': 'Orders: `src/orders/`. Billing: `src/billing/`.\n', 'src/orders/a.ts': '', 'src/billing/b.ts': '' },
  })
  expect((await w.setup('check')).text).toBe(
    'The check found 2:\n  ARCHITECTURE.md: may be stale: src/orders (20) commits to it since the map was last edited\n  GLOSSARY.md: the term "Invoice" is found nowhere outside the glossaries: still in use?',
  )
})

test('a turn that edits the docs has an agent read the edits against the code; its blockers show, go on j, and its report stays off Claude', async ($, on) => {
  const w = await world($, on, { files: { 'docs/agents/workflow.md': '# How work goes\n', 'CLAUDE.md': '# Rules\n' } })
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/CLAUDE.md', content: '# Rules\n\nWrite clean code.\n' })
  // The checks of the turn's edits run beside it, and its end waits for them.
  await w.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  // What changed, line by line, with the file's size against its own.
  expect(w.spawned[0]).toMatch(/=== CLAUDE\.md === \(3 lines of its 120\)\nAdded:\n\+ Write clean code\.\n\n/)
  await w.agentDone('judge-1', '[{"file": "CLAUDE.md", "problem": "A wish that changes nothing", "fix": "Take it out", "severity": "blocker"}]')
  await w.settle()
  // A turn that edits none of them starts none.
  await w.turn()
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: '• CLAUDE.md: A wish that changes nothing' })).toBeDefined()
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: 'docs: 1 issue' })).toBeDefined()
  await band.unmount()
  // Its hand-back, queued as a peer's prompt, does not reach Claude.
  expect(await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="judge-1">\n[Subagent hand-back] ...\n</agent-message>', origin: { kind: 'peer' }, isMeta: true, wait: false } as never)).toMatchObject({ drop: 'What the docs agent found in the last edits' })
  const before = w.submitted.length
  await pane.press({ key: 'setup-judge-send' })
  expect(w.submitted).toHaveLength(before + 1)
  expect(w.submitted.at(-1)).toMatch(/^The docs agent found these[\s\S]*- CLAUDE\.md: A wish that changes nothing Fix: Take it out/)
  expect(await pane.find({ type: 'Text', text: '→ sent to Claude' })).toBeDefined()
  await pane.unmount()
})

test('in Russian, Matt’s setup is told to speak Russian, which it does not know of', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'changes', args: 'lang ru', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect((await w.setup()).text).toMatch(/^✓ Скиллы Мэтта установлены/)
  await w.settle()
  expect(w.commands.filter(c => c.startsWith('mattpocock'))).toEqual(['mattpocock-skills:setup-matt-pocock-skills Говори со мной по-русски: вопросы, варианты ответов, черновики на подтверждение и итоги.'])
})

test('docs written through the shell, as Claude often writes them, have the docs agent read them too', async ($, on) => {
  const w = await world($, on, { files: { 'docs/agents/workflow.md': '# How work goes\n', 'CLAUDE.md': '# Rules\n' } })
  // `cat > … <<EOF` in Bash: no Write or Edit for the edit hooks to see.
  await w.turn({ 'CLAUDE.md': '# Rules\n\nAlways be careful.\n', 'docs/adr/0001-static.md': '# Static\n\nNo build.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/=== CLAUDE\.md === \(3 lines of its 120\)\nAdded:\n\+ Always be careful\.\n\n/)
  expect(w.spawned[0]).toMatch(/=== docs\/adr\/0001-static\.md ===\nWritten anew:\n<<<\n# Static/)
})

test('outside a project set up, a CLAUDE.md that grows is read by the docs agent; one edited in place is not', async ($, on) => {
  const w = await world($, on, { files: { 'CLAUDE.md': '# Rules\n\nUse yarn.\n' } })
  await w.turn({ 'CLAUDE.md': '# Rules\n\nUse pnpm.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(0)
  await w.turn({ 'CLAUDE.md': '# Rules\n\nUse pnpm.\nThe API lives in src/api and returns AppError on failure.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/=== CLAUDE\.md === \(4 lines of its 120\)\nAdded:\n\+ The API lives in src\/api/)
  expect(w.spawned[0]).toMatch(/its fix names the file it belongs in/)
})

test('while /setup-project’s steps go, the docs agent waits: it reads what they all wrote once, at the run’s end', async ($, on) => {
  const w = await world($, on)
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'Local.\n', 'docs/agents/domain.md': 'Single.\n' })
  await w.settle()
  await w.turn({ 'GLOSSARY.md': GLOSSARY, 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^Step 5 of/)
  expect(w.spawned).toHaveLength(0)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  // The standards, the checks, the run, the permissions, the workflow and OpenSpec's config; CI is
  // left out, as the project has none.
  for (const step of [5, 6, 7, 8, 9, 10]) {
    await pane.press({ key: 'setup-skip' })
    await w.settle()
    if (step < 10) expect(w.spawned).toHaveLength(0)
  }
  await pane.unmount()
  // The last step skipped ends the run: the next turn's end reads all it wrote, the map and the glossary among them.
  await w.turn({ 'CLAUDE.md': '# Rules\n\nSee `ARCHITECTURE.md`.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/=== ARCHITECTURE\.md ===[\s\S]*=== CLAUDE\.md ===[\s\S]*=== GLOSSARY\.md ===/)
})

// What every step before the checks writes: a project where the checks are the first step to go.
const UP_TO_CHECKS = {
  'docs/agents/issue-tracker.md': 'GitLab.\n',
  'docs/agents/domain.md': 'Single context.\n',
  'openspec/config.yaml': 'schema: spec-driven\n',
  'GLOSSARY.md': GLOSSARY,
  'ARCHITECTURE.md': '# Map\n',
  'CODING_STANDARDS.md': '# Standards\n',
}
const SETTINGS = JSON.stringify({ permissions: { deny: DENY } })
// A repository on commit abc whose changed file is src/a.ts.
const REPO: Git = args =>
  args[0] === 'rev-parse' ? { exitCode: 0, stdout: 'abc\n' }
  : args[0] === 'diff' && args.includes('--name-only') ? { exitCode: 0, stdout: 'src/a.ts\n' }
  : args[0] === 'ls-files' ? { exitCode: 0, stdout: '' }
  : undefined

test('the checks are read from .claude/agent-lens.json whatever the stack: a list for the root or lists by folder, the files in place of {files}', () => {
  expect(parseConfig('{"checks": {"fast": ["ruff check {files}"], "full": ["pytest"]}}')).toEqual({ config: { checks: { fast: { '.': ['ruff check {files}'] }, full: { '.': ['pytest'] } } }, issues: [] })
  expect(parseConfig('{"checks": {"fast": {"./api/": ["go vet ./..."]}}, "run": null}').config).toEqual({ checks: { fast: { api: ['go vet ./...'] }, full: {} }, run: null })
  expect(parseConfig('{"checks": {"fast": {"../x": ["a"]}}}').issues.map(i => i.kind)).toEqual(['checks-shape'])
  expect(parseConfig('not json').issues[0]!.detail).toBe('not JSON')
  expect(parseConfig('{"run": {"up": 1}}').issues).toHaveLength(1)
  // Quoted for the shell; a command that takes files and has none does not run, as it would run on all.
  expect(expand('eslint {files}', ['a.ts', "it's.ts"], 'sh')).toBe(`eslint 'a.ts' 'it'\\''s.ts'`)
  expect(expand('eslint {files}', [], 'sh')).toBeNull()
  expect(expand('tsc --noEmit', [], 'sh')).toBe('tsc --noEmit')
  expect(expand('ruff check {files}', ['a b.py'], 'cmd')).toBe('ruff check "a b.py"')
  // A tool that reads only some files takes those of its extensions, and none of others runs it not.
  expect(expand('ruff check {files:py,.pyi}', ['a.py', 'b.pyi', 'README.md'], 'sh')).toBe(`ruff check 'a.py' 'b.pyi'`)
  expect(expand('ruff check {files:py}', ['README.md'], 'sh')).toBeNull()
  expect(expand('ruff check {files:py, pyi}', ['a.pyi'], 'sh')).toBe(`ruff check 'a.pyi'`)
  expect(expand('ruff check {files:py pyi}', ['a.pyi'], 'sh')).toBe(`ruff check 'a.pyi'`)
  expect(parseConfig('{"checks": {"fast": {"api": ["a"], "api/": ["b"]}}}').issues[0]!.detail).toBe('checks.fast: the folder "api" is named twice')
  // A misspelt tier, an empty run, checks that are no object: each said, none taken as nothing to run.
  expect(parseConfig('{"checks": {"fats": ["lint"]}}').issues).toHaveLength(1)
  expect(parseConfig('{"checks": null}').issues).toHaveLength(1)
  expect(parseConfig('{"run": {}}').issues).toHaveLength(1)
  expect(
    timingIssues([
      { folder: '.', command: 'lint', ms: 1000, exitCode: 127 },
      { folder: 'api', command: 'test', ms: 130_000, exitCode: 0 },
      { folder: '.', command: 'ok', ms: 10, exitCode: 1 },
      // Cut at the timeout, a command is too slow, not one that does not start.
      { folder: '.', command: 'e2e', ms: 300_000, exitCode: -1 },
    ]).map(i => [i.kind, i.detail]),
  ).toEqual([
    ['checks-start', 'lint'],
    ['checks-slow', 'api: test (130s)'],
    ['checks-slow', 'e2e (300s)'],
  ])
  // What was red on the same commit before the agent is not sent back; on another commit it is.
  const red = [
    { folder: '.', command: 'lint', exitCode: 1, output: '' },
    { folder: '.', command: 'types', exitCode: 2, output: '' },
  ]
  expect(newRed(red, { '.': { sha: 'abc', red: ['lint'] } }, { '.': 'abc' }).map(f => f.command)).toEqual(['types'])
  expect(newRed(red, { '.': { sha: 'abc', red: ['lint'] } }, { '.': 'def' })).toHaveLength(2)
  expect(permissionIssues('{"permissions": {"deny": []}}').map(i => i.kind)).toEqual(['permissions-deny'])
  expect(permissionIssues(SETTINGS)).toEqual([])
})

test('the step of the checks: the fast tier runs once written, what does not start goes back, what is red is kept as red before the agent', async ($, on) => {
  const w = await world($, on, { files: UP_TO_CHECKS, git: REPO, sh: c => (c === 'missing-tool' ? { exitCode: 127 } : c.startsWith('eslint') ? { exitCode: 1, stdout: 'error' } : undefined) })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 6 of \/setup-project[\s\S]*\{files\}[\s\S]*\.claude\/agent-lens\.json/)
  await w.turn({ '.claude/agent-lens.json': JSON.stringify({ checks: { fast: ['eslint {files}', 'missing-tool'], full: ['npm test'] } }) })
  await w.settle()
  expect(w.shells()).toEqual(["eslint 'src/a.ts'", 'missing-tool'])
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "The checks, and the gate at each turn’s end"[\s\S]*`missing-tool` does not start/)
  // Fixed: the step is done, the red of eslint kept against the commit, and the next step goes.
  await w.turn({ '.claude/agent-lens.json': JSON.stringify({ checks: { fast: ['eslint {files}'], full: ['npm test'] } }) })
  await w.settle()
  expect(w.store.get('setup:base:/proj')).toEqual({ '.': { sha: 'abc', red: ['eslint {files}'] } })
  expect(w.submitted[2]).toMatch(/^Step 7 of \/setup-project[\s\S]*smoke/)
})

test('the gate: a turn that changed the project and leaves the fast checks red is kept going, three rounds at most, then let go', async ($, on) => {
  let isRed = true
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git: REPO, sh: c => (c === 'lint' && isRed ? { exitCode: 1, stdout: 'src/a.ts:1 unused' } : undefined) })
  const edit = async (content: string) => {
    await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content })
    await w.settle()
  }
  await $.turn.start({ text: 'go', turnId: 't' })
  await edit('x')
  // No baseline was ever taken: Claude is told the red may be older than its changes.
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/^The project's fast checks \(\.claude\/agent-lens\.json\) are red after this turn \(round 1 of 3\)[\s\S]*was never taken[\s\S]*\$ lint {3}→ exit 1\nsrc\/a\.ts:1 unused$/)
  await edit('x1')
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toMatch(/round 2 of 3/)
  await edit('x2')
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toMatch(/round 3 of 3/)
  await edit('x3')
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /checks: 1 red/ })).toBeDefined()
  await band.unmount()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  // Green, the turn ends.
  isRed = false
  await $.turn.start({ text: 'go', turnId: 'u' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'y' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'u', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  // A turn that changed nothing runs nothing.
  const ran = w.shells().length
  await $.turn.start({ text: 'why?', turnId: 'v' })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(w.shells()).toHaveLength(ran)
})

test('what is red on this commit before the agent, kept by /setup-project baseline, is not sent back', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git: REPO, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  expect((await w.setup('baseline')).text).toBe('Kept as red before the agent on this commit: lint. The gate does not send these back until the commit changes.')
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('where no classic hook runs, the gate sends what is red as the next prompt', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git: REPO, sh: c => (c === 'lint' ? { exitCode: 1, stdout: 'bad' } : undefined) })
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^The project's fast checks[\s\S]*round 1 of 3[\s\S]*bad$/)
})

test('without Matt’s skills and OpenSpec, how work goes names none of them', async ($, on) => {
  const files = { ...UP_TO_CHECKS, '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}', '.claude/settings.json': SETTINGS }
  const w = await world($, on, { files, noMatt: true, noOpenspec: true })
  await w.setup()
  await w.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/^Step 9 of \/setup-project[\s\S]*talked through with me[\s\S]*written down as a plan in the issue/)
  expect(w.submitted[0]).not.toMatch(/grilling|`tdd`|retro|openspec propose/)
})

test('a project with CI has a job added that runs the same checks; done once the CI names agent-lens', async ($, on) => {
  const files = {
    ...UP_TO_CHECKS,
    'openspec/config.yaml': 'context: see GLOSSARY.md\n',
    'CLAUDE.md': 'Read `ARCHITECTURE.md`.\n',
    'docs/agents/workflow.md': '# How work goes\n',
    '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}',
    '.claude/settings.json': SETTINGS,
    '.gitlab-ci.yml': 'stages: [test]\n',
  }
  const w = await world($, on, { files })
  expect((await w.setup()).text).toMatch(/✓ CI: \.gitlab-ci\.yml/)
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 11 of \/setup-project[\s\S]*`\.gitlab-ci\.yml`[\s\S]*npx -y github:Darvl-52\/agent-lens check/)
  await w.turn({ '.gitlab-ci.yml': 'stages: [test]\ndocs:\n  script: npx -y github:Darvl-52/agent-lens check\n' })
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^✓ Every step is done/ })).toBeDefined()
  await pane.unmount()
})

test('sent back, a turn that changes nothing says the red is not of its changes: it is let go, the checks not run again', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git: REPO, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/round 1 of 3/)
  const ran = w.shells().length
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect(w.shells()).toHaveLength(ran)
})

test('where no classic hook runs, the turn the gate’s prompt starts goes on with its rounds, and one that changes nothing is let go', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git: REPO, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  const turn = async (id: string, content?: string, text = 'go') => {
    await $.turn.start({ text, turnId: id })
    if (content !== undefined) await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content })
    await w.settle()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await w.settle()
  }
  await turn('t', 'x')
  expect(w.submitted.at(-1)).toMatch(/round 1 of 3/)
  // The gate's prompt starts the next turn: told by its text, it goes on with the rounds.
  await turn('u', 'y', w.submitted.at(-1))
  expect(w.submitted.at(-1)).toMatch(/round 2 of 3/)
  await turn('v', undefined, w.submitted.at(-1))
  expect(w.submitted).toHaveLength(2)
  // A prompt of the person's starts them again.
  await turn('p', 'z')
  expect(w.submitted.at(-1)).toMatch(/round 1 of 3/)
})

test('an edit through the shell is a change the gate sees: the diff against the commit moved', async ($, on) => {
  let diff = ''
  const git: Git = args => (args[0] === 'diff' && args.includes('--relative') && !args.includes('--name-only') ? { exitCode: 0, stdout: diff } : REPO(args))
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  await $.turn.start({ text: 'go', turnId: 't' })
  await w.settle()
  diff = '+console.log(1)\n'
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/round 1 of 3/)
})

test('while /setup-project’s steps go, the gate waits: they write the checks themselves', async ($, on) => {
  const files = { ...UP_TO_CHECKS, '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }
  const w = await world($, on, { files, git: REPO, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 7 of/)
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('the checks written out of their form go back with what is wrong, as any step’s files do', async ($, on) => {
  const w = await world($, on, { files: UP_TO_CHECKS })
  await w.setup()
  await w.settle()
  await w.turn({ '.claude/agent-lens.json': '{"checks": {"fats": ["lint"]}}' })
  await w.settle()
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "The checks, and the gate at each turn’s end"[\s\S]*checks: an object of fast and full/)
})

test('with Matt’s skills installed, how work goes names each of those it uses', async ($, on) => {
  const files = { ...UP_TO_CHECKS, '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}', '.claude/settings.json': SETTINGS }
  const w = await world($, on, { files })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 9 of \/setup-project[\s\S]*`grilling`[\s\S]*`domain-modeling`[\s\S]*`tdd`[\s\S]*`diagnosing-bugs`[\s\S]*`code-review`[\s\S]*retro/)
})

test('a baseline of another commit says nothing of this one: the red goes back, Claude told it may be older', async ($, on) => {
  let head = 'abc'
  const git: Git = args => (args[0] === 'rev-parse' ? { exitCode: 0, stdout: `${head}\n` } : REPO(args))
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' }, git, sh: c => (c === 'lint' ? { exitCode: 1 } : undefined) })
  await w.setup('baseline')
  head = 'def'
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/known for another commit only/)
})

test('checks written with no command in them do not close the step: the gate would have nothing to run', async ($, on) => {
  const w = await world($, on, { files: UP_TO_CHECKS })
  await w.setup()
  await w.settle()
  await w.turn({ '.claude/agent-lens.json': '{"checks": {"fast": [], "full": []}}' })
  await w.settle()
  expect(w.submitted).toHaveLength(1)
})
