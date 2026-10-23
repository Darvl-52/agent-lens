import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { checkDocs, parseFindings, pathsIn, pathsNamed, termsOf } from '../hooks/setup/docs'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MATT = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro']
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
// unless `noOpenspec`; `openspec init` writes its folder.
type Git = (args: string[]) => { exitCode: number; stdout: string } | undefined
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; noMatt?: boolean; noOpenspec?: boolean; git?: Git } = {}) => {
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
      const r = opts.git?.(e.argv.slice(3)) ?? { exitCode: 128, stdout: '' }
      return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { disk, store, submitted, commands, runs, opened, spawned, setup, turn, settle, agentDone }
}

test('missing Matt’s skills or the OpenSpec CLI, /setup-project says so and does not run', async ($, on) => {
  const w = await world($, on, { noMatt: true })
  expect((await w.setup()).text).toMatch(/^Matt’s skills are not installed \(setup-matt-pocock-skills, domain-modeling, .*retro missing\), so \/setup-project does not run\. Install them with \/plugin install mattpocock-skills/)
  expect(w.opened).toEqual([])
})

test('no OpenSpec CLI: it says how to install it', async ($, on) => {
  const w = await world($, on, { noOpenspec: true })
  expect((await w.setup()).text).toMatch(/^The OpenSpec CLI is not installed/)
  expect(w.commands).toEqual([])
})

test('the steps go one at a time: Matt’s setup, openspec init by the mod, then each prompt once the files of the one before pass', async ($, on) => {
  const w = await world($, on)
  expect((await w.setup()).text).toBe('✓ Matt’s skills installed · ✓ OpenSpec 1.14.1, the project has no openspec/ yet: a step initialises it\nOpened the setup: the steps go to Claude one at a time.')
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
  expect(w.submitted[4]).toMatch(/^Step 6 of \/setup-project[\s\S]*docs\/agents\/workflow\.md/)
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
  for (const step of [5, 6, 7]) {
    await pane.press({ key: 'setup-skip' })
    await w.settle()
    if (step < 7) expect(w.spawned).toHaveLength(0)
  }
  await pane.unmount()
  // The last step skipped ends the run: the next turn's end reads all it wrote, the map and the glossary among them.
  await w.turn({ 'CLAUDE.md': '# Rules\n\nSee `ARCHITECTURE.md`.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/=== ARCHITECTURE\.md ===[\s\S]*=== CLAUDE\.md ===[\s\S]*=== GLOSSARY\.md ===/)
})
