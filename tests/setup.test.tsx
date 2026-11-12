import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DENY, expand, newRed, parseConfig, permissionIssues, timingIssues } from '../hooks/setup/checks'
import { checkDocs, hasSecurityLine, hasSecurityRules, hasTaskRules, parseFindings, parseTermsInUse, pathsIn, pathsNamed, termsOf } from '../hooks/setup/docs'
import { posix } from './helpers'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MATT = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro', 'diagnosing-bugs', 'code-review']
const GLOSSARY = '# Ordering\n\nTakes and tracks orders.\n\n## Language\n\n**Order**:\nA request to buy goods.\n_Avoid_: Purchase\n\n**Invoice**:\nA request for payment. Sent after delivery.\n'

const issuesOf = (files: Record<string, string>, missing: string[] = []) => checkDocs(files, new Set(missing)).map(i => [i.file, i.kind, i.detail ?? null])

test('the files are held to their size, the paths they name, and the forms of the glossary and the ADRs', () => {
  expect(issuesOf({ 'GLOSSARY.md': GLOSSARY, 'CLAUDE.md': 'Read `ARCHITECTURE.md` first.\n' })).toEqual([])
  expect(issuesOf({ 'CLAUDE.md': `${'line\n'.repeat(121)}` })).toEqual([['CLAUDE.md', 'size', '121/120']])
  // CLAUDE.md alone is read into every turn: the others grow as the project needs.
  for (const file of ['CODING_STANDARDS.md', 'ARCHITECTURE.md', 'LENSES.md', 'docs/agents/workflow.md'])
    expect(issuesOf({ [file]: Array.from({ length: 900 }, (_, i) => `- Line ${i}.`).join('\n') }).filter(i => i[1] === 'size')).toEqual([])
  // A glossary CLAUDE.md imports is read into every turn with it: it counts.
  expect(issuesOf({ 'CLAUDE.md': `${'line\n'.repeat(60)}@GLOSSARY.md\n`, 'GLOSSARY.md': `# Ordering\n\n${'x\n'.repeat(60)}` }).filter(i => i[1] === 'size')).toEqual([['CLAUDE.md', 'size', '123/120 with @GLOSSARY.md']])
  // A path a file names that is not there; a command, a glob or a placeholder is no path.
  expect(pathsIn('Run `npm test`, see `src/orders/`, `*.ts`, `src/<name>.ts` and `README.md`.')).toEqual(['src/orders/', 'README.md'])
  expect(pathsNamed({ 'ARCHITECTURE.md': '`src/orders/` holds them.', 'GLOSSARY.md': '`src/x.ts`' })).toEqual(['src/orders'])
  expect(issuesOf({ 'ARCHITECTURE.md': 'Orders: `src/orders/`.\n' }, ['src/orders'])).toEqual([['ARCHITECTURE.md', 'path', 'src/orders/']])
  // The glossary holds terms, a sentence or two each, and no code.
  expect(issuesOf({ 'GLOSSARY.md': `${GLOSSARY}\nSome loose note after the terms.\n` })).toEqual([['GLOSSARY.md', 'glossary-shape', null]])
  expect(issuesOf({ 'GLOSSARY.md': '## Language\n\n**Order**:\nOne. Two. Three.\n' })).toEqual([['GLOSSARY.md', 'glossary-long', null]])
  // A definition and the words to avoid may wrap: the lines below are theirs, and the length is the whole one's.
  expect(issuesOf({ 'GLOSSARY.md': '## Language\n\n**Order**:\nA request to buy goods,\nplaced by a customer.\n_Avoid_: Purchase,\ntransaction\n' })).toEqual([])
  expect(checkDocs({ 'GLOSSARY.md': '## Language\n\n**Order**:\nOne. Two.\nThree.\n' }, new Set()).map(i => [i.kind, i.line])).toEqual([['glossary-long', 4]])
  // A note of another label is told once, not by each line it wraps onto, and is no part of the definition.
  expect(checkDocs({ 'GLOSSARY.md': '## Language\n\n**Order**:\nOne. Two.\n_In code_: a note\nthat wraps.\n' }, new Set()).map(i => [i.kind, i.line])).toEqual([['glossary-shape', 5]])
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
type Git = (args: string[], env?: Record<string, string>) => { exitCode: number; stdout: string } | undefined
type Sh = (command: string, cwd: string) => { exitCode: number; stdout?: string } | undefined
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; noMatt?: boolean; noOpenspec?: boolean; git?: Git; sh?: Sh; reply?: string; autonomy?: 'manual' | 'auto' | 'full' } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const disk = new Map(Object.entries(opts.files ?? {}).map(([f, t]) => [`/proj/${f}`, t]))
  const isDir = (p: string) => [...disk.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  // What the checks find waits for the person, as by hand, unless `autonomy` says otherwise.
  const store = new Map<string, unknown>([['autonomy', opts.autonomy ?? 'manual']])
  const submitted: string[] = []
  const commands: string[] = []
  const runs: string[][] = []
  const opened: string[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: disk.has(posix(e.path)) || isDir(posix(e.path)) }))
  on('fs.read', ($, e) => (disk.has(posix(e.path)) ? { value: disk.get(posix(e.path))! } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const dir = posix(e.path).replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of disk.keys())
      if (p.startsWith(`${dir}/`)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/')
        names.set(name!, rest.length > 0 ? 'dir' : 'file')
      }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  // The rule files of each folder from a file up, as the check of each edit reads them.
  on('fs.ancestors', ($, e) => {
    const top = posix(e.below ?? '/').replace(/\/$/, '')
    const file = posix(e.of ?? '/proj/.')
    const dirs: string[] = []
    for (let dir = file.slice(0, file.lastIndexOf('/')); dir.length > top.length && dir.startsWith(`${top}/`); dir = dir.slice(0, dir.lastIndexOf('/'))) dirs.unshift(dir)
    const found = dirs.flatMap(dir => e.names.filter(name => disk.has(`${dir}/${name}`)).map(name => ({ dir, name, content: disk.get(`${dir}/${name}`)! })))
    return { value: found.map(f => ({ ...f, parts: [{ path: `${f.dir}/${f.name}`, content: f.content }] })) }
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
      const r = opts.git?.(e.argv.slice(e.argv.indexOf('-C') + 2), e.init?.env) ?? { exitCode: 128, stdout: '' }
      return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'sh') {
      const r = e.argv[2] === 'exit 0' ? { exitCode: 0 } : (opts.sh?.(e.argv[2]!, posix(e.init?.cwd ?? '/proj')) ?? { exitCode: 0 })
      return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.noOpenspec && e.argv[0]!.startsWith('openspec')) return { deny: 'spawn openspec ENOENT' }
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: '1.14.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'init') disk.set('/proj/openspec/config.yaml', 'schema: spec-driven\n')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
  // The review of a turn's diff asks a model: it finds nothing here, unless `reply` says otherwise.
  on('model.complete', () => ({ value: { isAnswered: true as const, text: opts.reply ?? '{"findings":[]}', usage: USAGE } }))
  const spawned: string[] = []
  const tasks: string[] = []
  const models: (string | undefined)[] = []
  on('agent.spawn', ($, e) => (spawned.push(e.prompt), tasks.push(e.description), models.push(e.model), { model: e.model ?? 'sonnet' }))
  on('agent.list', () => ({ value: tasks.map((description, i) => ({ id: `judge-${i + 1}`, description, type: 'Explore', status: 'running' as const, spawnedBy: 'agent-lens' })) }))
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', ($, e) => {
    if (e.tool !== 'Write') return { deny: 'unexpected' }
    disk.set(posix(e.file_path), e.content)
    return { result: { type: 'create' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const setup = (args = '') => $.command.run({ command: 'setup-project', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // A turn of the main loop that writes `files` as Claude would, then ends with an answer. It starts
  // with `text`, or with the last prompt sent where no turn started with it yet: the one it answers.
  let started = 0
  const turn = async (files: Record<string, string> = {}, text?: string) => {
    const at = text === undefined ? submitted.length - 1 : submitted.indexOf(text, started)
    const isNew = at >= started
    if (isNew) started = at + 1
    await $.turn.start({ text: text ?? (isNew ? submitted[at]! : 'go'), turnId: 't' })
    for (const [f, t] of Object.entries(files)) disk.set(`/proj/${f}`, t)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  }
  // Lets what a turn's end started beside it finish.
  const settle = () => clock.advance(10)
  const agentDone = (agentId: string, answer: string) =>
    $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
  const shells = () => runs.filter(r => r[0] === 'sh' && r[2] !== 'exit 0').map(r => r[2]!)
  return { clock, disk, store, submitted, commands, runs, shells, opened, spawned, models, toasts, setup, turn, settle, agentDone }
}

test('missing Matt’s skills, /setup-project recommends them and goes on, the step that needs them left out', async ($, on) => {
  const opts = { noMatt: true }
  const w = await world($, on, opts)
  expect((await w.setup()).text).toMatch(/^○ Matt’s skills recommended \(setup-matt-pocock-skills, domain-modeling, .*retro missing\): \/plugin install mattpocock-skills · ✓ OpenSpec 1\.14\.1/)
  await w.settle()
  expect(w.opened).toEqual(['agent-lens-setup'])
  expect(w.commands).toEqual([])
  // OpenSpec goes on, and the map is the first step sent.
  expect(w.runs.find(r => r[1] === 'init')).toBeDefined()
  expect(w.submitted[0]).toMatch(/^Step 4 of \/setup-project/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^  left out: Matt’s skills are not installed/ })).toBeDefined()
  // Run again while the skills are still missing, it stays left out and says why.
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-matt' })).toBeDefined()
  await pane.press({ key: 'setup-rerun-matt' })
  await w.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts).toContain('left out: Matt’s skills are not installed (/plugin install mattpocock-skills)')
  expect(await pane.find({ type: 'Text', text: /^  left out: Matt’s skills are not installed/ })).toBeDefined()
  // Installed (the world reads its options live), it waits for the map with Claude, then goes.
  opts.noMatt = false
  await pane.press({ key: 'setup-rerun-matt' })
  await w.settle()
  expect(await pane.find({ type: 'Text', text: /^  left out: Matt’s skills/ })).toBeUndefined()
  expect(w.commands).toEqual([])
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.commands).toEqual(['mattpocock-skills:setup-matt-pocock-skills'])
  await pane.unmount()
})

test('no OpenSpec CLI: it is recommended, and the two steps of OpenSpec are left out', async ($, on) => {
  const opts = { noOpenspec: true }
  const w = await world($, on, opts)
  expect((await w.setup()).text).toMatch(/^✓ Matt’s skills installed · ○ OpenSpec recommended: npm install -g @fission-ai\/openspec/)
  await w.settle()
  expect(w.commands).toEqual(['mattpocock-skills:setup-matt-pocock-skills'])
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.findAll({ type: 'Text', text: /^  left out: the OpenSpec CLI is not installed/ })).toHaveLength(2)
  // Installed, the config's step run again brings back the init it stands on, which goes first.
  opts.noOpenspec = false
  await pane.press({ key: 'setup-rerun-config' })
  await w.settle()
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-openspec' })).toBeUndefined()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  expect(w.runs.find(r => r[1] === 'init')).toBeDefined()
  await pane.unmount()
})

test('the steps go one at a time: Matt’s setup, openspec init by the mod, then each prompt once the files of the one before pass', async ($, on) => {
  const w = await world($, on)
  expect((await w.setup()).text).toBe('✓ Matt’s skills installed · ✓ OpenSpec 1.14.1, a step initialises openspec/ · ○ no CI: its step is left out\nOpened the setup: the steps go to Claude one at a time; one not sent yet may be skipped from its row, and the dear ones say so.')
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
  // The step stopped on its check has its own buttons, not the row's.
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-map' })).toBeUndefined()
  // Fixed by hand: the next turn's end finds it passing, and the standards go.
  w.disk.set('/proj/GLOSSARY.md', GLOSSARY)
  await pane.press({ key: 'setup-again' })
  await w.settle()
  expect(w.submitted).toHaveLength(3)
  expect(w.submitted[2]).toMatch(/^Step 4 of/)
  await w.turn()
  await w.settle()
  expect(w.submitted[3]).toMatch(/^Step 5 of \/setup-project[\s\S]*CODING_STANDARDS\.md/)
  // Skipped, the next goes: the security rules, and skipped too, the lenses, the mod's own named to be left out.
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[4]).toMatch(/^Step 6 of \/setup-project[\s\S]*the security rules/)
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[5]).toMatch(/^Step 7 of \/setup-project[\s\S]*The neighbouring flows[\s\S]*system`[\s\S]*user\.type`[\s\S]*`LENSES\.md` at the root[\s\S]*What to push back on/)
  // None found, it writes nothing: the turn that answers it is done, and the next goes.
  await w.turn()
  await w.settle()
  expect(w.submitted[6]).toMatch(/^Step 8 of \/setup-project[\s\S]*\.claude\/agent-lens\.json/)
  // A step skipped is run again from its row: it waits while another is with Claude, then goes first.
  await pane.press({ key: 'setup-rerun-standards' })
  await w.settle()
  expect(w.submitted).toHaveLength(7)
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-standards' })).toBeUndefined()
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[7]).toMatch(/^Step 5 of \/setup-project[\s\S]*CODING_STANDARDS\.md/)
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-checks' })).toBeDefined()
  await pane.unmount()
})

test('a step failed once the run went past it is run again from its row, after the step with Claude', async ($, on) => {
  const w = await world($, on)
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  await w.turn({ 'GLOSSARY.md': `${GLOSSARY}\nA loose note.\n`, 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  await w.turn()
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  await pane.press({ key: 'setup-next' })
  await w.settle()
  expect(w.submitted[2]).toMatch(/^Step 5 of/)
  w.disk.set('/proj/GLOSSARY.md', GLOSSARY)
  await pane.press({ key: 'setup-rerun-map' })
  await w.settle()
  expect(w.submitted).toHaveLength(3)
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[3]).toMatch(/^Step 4 of/)
  await pane.unmount()
})

test('the next step pressed twice at once goes to Claude once', async ($, on) => {
  const w = await world($, on)
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  await w.turn({ 'GLOSSARY.md': `${GLOSSARY}\nA loose note.\n`, 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  await w.turn()
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  await Promise.all([pane.press({ key: 'setup-next' }), pane.press({ key: 'setup-next' })])
  await w.settle()
  expect(w.submitted.filter(t => /^Step 5 of/.test(t))).toHaveLength(1)
  expect(w.submitted.filter(t => /^Step 6 of/.test(t))).toHaveLength(0)
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

test('the config’s step skipped by hand, run again, brings back the init only once the CLI is there; an init stopped on its check stays the person’s', async ($, on) => {
  const opts = { noOpenspec: true }
  const steps = (openspec: object) => ({
    matt: { status: 'done' }, openspec, existing: { status: 'done' }, map: { status: 'done' }, standards: { status: 'done' }, security: { status: 'done' }, lenses: { status: 'done' },
    checks: { status: 'done' }, run: { status: 'done' }, permissions: { status: 'done' }, workflow: { status: 'done' }, config: { status: 'skipped' }, ci: { status: 'done' },
  })
  const w = await world($, on, opts)
  w.store.set('setup:/proj', { root: '/proj', current: null, steps: steps({ status: 'skipped', needs: 'left out: the OpenSpec CLI is not installed (npm install -g @fission-ai/openspec)' }) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  await pane.press({ key: 'setup-rerun-config' })
  await w.settle()
  expect(w.runs.find(r => r[1] === 'init')).toBeUndefined()
  expect(w.toasts).toContain('left out: the OpenSpec CLI is not installed (npm install -g @fission-ai/openspec)')
  expect(await pane.find({ type: 'Button', key: 'setup-rerun-config' })).toBeDefined()
  await pane.unmount()
  // The init failed and is the current step: the config goes, the init keeps its error.
  opts.noOpenspec = false
  w.store.set('setup:/proj', { root: '/proj', current: 'openspec', steps: steps({ status: 'failed', error: 'openspec init did not run' }) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const again = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  await again.press({ key: 'setup-rerun-config' })
  await w.settle()
  expect(w.runs.find(r => r[1] === 'init')).toBeUndefined()
  expect(w.submitted.at(-1)).toMatch(/^Step 12 of/)
  expect(await again.find({ type: 'Text', text: /^  openspec init did not run$/ })).toBeDefined()
  await again.unmount()
})

test('the commit of the setup is offered once every step is done, until it is sent or skipped, and again once a step runs again', async ($, on) => {
  const done = Object.fromEntries(['matt', 'openspec', 'existing', 'map', 'standards', 'security', 'lenses', 'checks', 'run', 'permissions', 'workflow', 'config', 'ci'].map(s => [s, { status: 'done' }]))
  const w = await world($, on)
  w.store.set('setup:/proj', { root: '/proj', current: null, steps: { ...done, ci: { status: 'skipped' } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const mount = () => $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  let pane = await mount()
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeDefined()
  // Skipped, it is gone for good, the run still said done.
  await pane.press({ key: 'setup-commit-skip' })
  await w.settle()
  expect(w.submitted).toEqual([])
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^✓ Every step is done/ })).toBeDefined()
  await pane.unmount()
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  pane = await mount()
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeUndefined()
  // A step run again writes more: once it is done, the commit is offered again, and sent, it goes.
  await pane.press({ key: 'setup-rerun-ci' })
  await w.settle()
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeDefined()
  await Promise.all([pane.press({ key: 'setup-commit' }), pane.press({ key: 'setup-commit' })])
  await w.settle()
  expect(w.submitted.filter(t => /^Commit the files \/setup-project wrote/.test(t))).toHaveLength(1)
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeUndefined()
  await pane.unmount()
})

test('a step skipped by hand stays skipped when /setup-project runs again: nothing is sent, the commit let go stays so', async ($, on) => {
  const w = await world($, on)
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  await w.turn({ 'GLOSSARY.md': GLOSSARY, 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  for (let i = 0; i < 8; i++) {
    await pane.press({ key: 'setup-skip' })
    await w.settle()
  }
  await pane.press({ key: 'setup-commit-skip' })
  await w.settle()
  const sent = w.submitted.length
  await w.setup()
  await w.settle()
  expect(w.submitted).toHaveLength(sent)
  expect(await pane.find({ type: 'Button', key: 'setup-commit' })).toBeUndefined()
  // Brought back from its row, it goes.
  await pane.press({ key: 'setup-rerun-standards' })
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^Step 5 of/)
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
  // The terms in use, by the agent's own spelling: what is not a plain yes is no.
  expect(parseTermsInUse('[{"term": "Смена", "inUse": true}, {"term": "Invoice", "inUse": "yes"}, {"term": "", "inUse": true}, {"term": "Order", "inUse": false}]')).toEqual(['смена'])
  expect(parseTermsInUse('None found.')).toBeUndefined()
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
  await w.settle()
  const map = 'ARCHITECTURE.md: may be stale: src/orders (20) commits to it since the map was last edited'
  expect((await w.setup('check')).text).toBe(`The check found 1:\n  ${map}\nThe docs agent is looking for 1 term in other forms and names…`)
  // The term is the person's question once the docs agent did not find it either.
  await w.agentDone('judge-1', '[{"file": "GLOSSARY.md", "term": "Invoice", "inUse": false, "where": ""}]')
  expect((await w.setup('check')).text).toBe(`The check found 2:\n  ${map}\n  GLOSSARY.md: the docs agent found the term "Invoice" nowhere outside the glossaries, in any form or name: still in use?`)
})

test('what may have gone stale holds no step back, is looked for again after a turn while some is found, and the terms are matched in UTF-8', async ($, on) => {
  let isInvoiceUsed = false
  const envs: (Record<string, string> | undefined)[] = []
  const git: Git = (args, env) => {
    if (args[0] !== 'grep') return undefined
    envs.push(env)
    return { exitCode: args.includes('Invoice') && !isInvoiceUsed ? 1 : 0, stdout: '' }
  }
  const w = await world($, on, { git })
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n', 'GLOSSARY.md': GLOSSARY })
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 4 of/)
  expect((await w.setup('check')).text).toBe('The files pass the check.\nThe docs agent is looking for 1 term in other forms and names…')
  await w.agentDone(`judge-${w.spawned.length}`, '[{"file": "GLOSSARY.md", "term": "Invoice", "inUse": false, "where": ""}]')
  expect((await w.setup('check')).text).toBe('The check found 1:\n  GLOSSARY.md: the docs agent found the term "Invoice" nowhere outside the glossaries, in any form or name: still in use?')
  // A question for the person, not a failure of the step: the map passes, and the standards go.
  await w.turn({ 'ARCHITECTURE.md': '# Map\n' })
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  expect(w.submitted[1]).toMatch(/^Step 5 of/)
  // The term in use now: the next turn's end finds it, not the start of the session.
  isInvoiceUsed = true
  await w.turn()
  await w.settle()
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /^(docs|glossary): / })).toBeUndefined()
  await band.unmount()
  // A term in Cyrillic matches whatever its case only in a UTF-8 locale.
  expect(envs.every(e => e?.LC_ALL === 'C.UTF-8')).toBe(true)
})

test('a term is looked for in the whole repository of its glossary, files not yet committed too', async ($, on) => {
  const greps: string[][] = []
  const git: Git = args => (args[0] === 'grep' ? (greps.push(args), { exitCode: 0, stdout: '' }) : undefined)
  const w = await world($, on, { git, files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY-MAP.md': '- [Ordering](apps/shop/GLOSSARY.md)\n', 'apps/shop/GLOSSARY.md': GLOSSARY } })
  await w.setup('check')
  expect(greps.length).toBeGreaterThan(0)
  // From the glossary's folder, `.` would be docs/ alone; the files the agent just wrote are untracked.
  expect(greps.every(a => a.includes('--untracked') && a.includes(':/') && a.includes(':(top,exclude,glob)**/GLOSSARY*.md') && !a.includes('.'))).toBe(true)
})

test('a term git finds nowhere goes to the docs agent first: one it finds in another form or by another name is not asked of the person, and its word holds', async ($, on) => {
  const git: Git = args => (args[0] === 'grep' ? { exitCode: 1, stdout: '' } : undefined)
  const w = await world($, on, { git, files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY.md': GLOSSARY } })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/- "Order" \(GLOSSARY\.md\)\n- "Invoice" \(GLOSSARY\.md\)/)
  // A search, not a reading of edits: the small model does it.
  expect(w.models).toEqual(['haiku'])
  // While it reads, the person is asked nothing, and a check starts no second agent.
  expect((await w.setup('check')).text).toBe('The files pass the check.\nThe docs agent is looking for 2 terms in other forms and names…')
  expect(w.spawned).toHaveLength(1)
  // The agent names a term in its own spelling and the glossary by its own path: the term is matched still.
  await w.agentDone('judge-1', 'Order is `class Order` in src/orders.ts.\n[{"file": "/proj/GLOSSARY.md", "term": "order", "inUse": true, "where": "src/orders.ts: class Order"}, {"file": "GLOSSARY.md", "term": "Invoice", "inUse": false, "where": ""}]')
  await w.settle()
  expect((await w.setup('check')).text).toBe('The check found 1:\n  GLOSSARY.md: the docs agent found the term "Invoice" nowhere outside the glossaries, in any form or name: still in use?')
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: 'glossary: 1 question' })).toBeDefined()
  await band.unmount()
  // Its report stays off Claude, as the docs agent's does.
  expect(await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="judge-1">\n[Subagent hand-back] ...\n</agent-message>', origin: { kind: 'peer' }, isMeta: true, wait: false } as never)).toMatchObject({ drop: 'Glossary terms found nowhere' })
  // The next session's start finds the same terms by git, and the agent's word on them stands.
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
})

test('a docs agent that gives no list leaves the terms the person’s questions for this session only: the next session has the agent look again', async ($, on) => {
  const git: Git = args => (args[0] === 'grep' ? { exitCode: args.includes('Invoice') ? 1 : 0, stdout: '' } : undefined)
  const w = await world($, on, { git, files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY.md': GLOSSARY } })
  await w.settle()
  await w.agentDone('judge-1', 'I could not finish.')
  await w.settle()
  expect((await w.setup('check')).text).toMatch(/the term "Invoice"/)
  expect(w.spawned).toHaveLength(1)
  // The question says the agent did not look; held in use and undone, nothing is kept of it.
  const mount = () => $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  let pane = await mount()
  expect(await pane.find({ type: 'Text', text: /^"Invoice" \(GLOSSARY\.md\): git found it nowhere outside the glossaries, and the docs agent could not look/ })).toBeDefined()
  await pane.press({ key: 'setup-term-kept' })
  await w.settle()
  await pane.unmount()
  pane = await mount()
  expect(await pane.find({ type: 'Text', text: /^"Invoice" \(GLOSSARY\.md\): / })).toBeUndefined()
  await pane.press({ key: 'setup-term-undo' })
  await w.settle()
  await pane.unmount()
  expect(w.store.get('setup:terms:/proj')).toEqual({})
  expect((await w.setup('check')).text).toMatch(/the term "Invoice"/)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  expect(w.spawned).toHaveLength(2)
})

test('the terms the docs agent did not find are asked one at a time: in use is kept for good and may be undone, later asks again next session, out goes to Claude', async ($, on) => {
  const git: Git = args => (args[0] === 'grep' ? { exitCode: 1, stdout: '' } : undefined)
  const w = await world($, on, { git, files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY.md': GLOSSARY } })
  await w.settle()
  await w.agentDone('judge-1', '[{"file": "GLOSSARY.md", "term": "Order", "inUse": false}, {"file": "GLOSSARY.md", "term": "Invoice", "inUse": false}]')
  await w.settle()
  const mount = () => $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  const asked = async () => {
    const pane = await mount()
    const q = (await pane.find({ type: 'Text', text: /^"\w+" \(GLOSSARY\.md\): / }))?.text
    await pane.unmount()
    return q?.match(/^"(\w+)"/)?.[1]
  }
  let pane = await mount()
  expect(await pane.find({ type: 'Text', text: '"Order" (GLOSSARY.md): neither git nor the docs agent found it outside the glossaries, in any form or name. Still in use?' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 more' })).toBeDefined()
  // In use: the next is asked, and the answer may be undone.
  await pane.press({ key: 'setup-term-kept' })
  await w.settle()
  await pane.unmount()
  expect(await asked()).toBe('Invoice')
  pane = await mount()
  expect(await pane.find({ type: 'Text', text: '→ "Order": in use, not asked again' })).toBeDefined()
  await pane.press({ key: 'setup-term-undo' })
  await w.settle()
  await pane.unmount()
  expect(await asked()).toBe('Order')
  pane = await mount()
  await pane.press({ key: 'setup-term-kept' })
  await w.settle()
  await pane.unmount()
  // Later: nothing is asked in this session.
  pane = await mount()
  await pane.press({ key: 'setup-term-later' })
  await w.settle()
  await pane.unmount()
  expect(await asked()).toBeUndefined()
  expect((await w.setup('check')).text).toBe('The files pass the check.')
  // The next session asks it again, and not the one held in use.
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  expect(await asked()).toBe('Invoice')
  // Out of the glossary: Claude takes it out, and it is not asked while it does.
  pane = await mount()
  await pane.press({ key: 'setup-term-drop' })
  await w.settle()
  await pane.unmount()
  expect(w.submitted.at(-1)).toMatch(/^The glossary term "Invoice" in GLOSSARY\.md is found nowhere/)
  expect(await asked()).toBeUndefined()
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
  // Sent, they are off the list; once the turn they went in ends, off the pane.
  expect(await pane.find({ type: 'Text', text: '• CLAUDE.md: A wish that changes nothing' })).toBeUndefined()
  // A turn of another prompt keeps them there.
  await w.turn({}, 'go')
  await w.settle()
  expect(await pane.find({ type: 'Text', text: 'What the docs agent found in the last edits' })).toBeDefined()
  await $.turn.start({ text: w.submitted.at(-1)!, turnId: 'fix' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'fix', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  await w.settle()
  expect(await pane.find({ type: 'Text', text: 'What the docs agent found in the last edits' })).toBeUndefined()
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
  expect(w.spawned[0]).toMatch(/=== docs\/adr\/0001-static\.md === \(\d+ lines\)\nWritten anew:\n<<<\n# Static/)
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
  // The standards, the security rules, the lenses, the checks, the run, the permissions, the workflow and OpenSpec's
  // config; CI is left out, as the project has none.
  for (const step of [5, 6, 7, 8, 9, 10, 11, 12]) {
    await pane.press({ key: 'setup-skip' })
    await w.settle()
    if (step < 12) expect(w.spawned).toHaveLength(0)
  }
  await pane.unmount()
  // The last step skipped ends the run: the next turn's end reads all it wrote, the map and the glossary among them.
  await w.turn({ 'CLAUDE.md': '# Rules\n\nSee `ARCHITECTURE.md`.\n' })
  await w.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatch(/=== ARCHITECTURE\.md ===[\s\S]*=== CLAUDE\.md ===[\s\S]*=== GLOSSARY\.md ===/)
})

const SET_UP_TO_SECURITY = { 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n', 'openspec/config.yaml': 'schema: spec-driven\n', 'GLOSSARY.md': GLOSSARY, 'ARCHITECTURE.md': '# Map\n', 'CODING_STANDARDS.md': '# Standards\n' }
const SECURITY_LINE = 'Before writing code that handles input: read Security in `CODING_STANDARDS.md` and check the edit against it.\n'

test('the security rules: Claude tells the sides from the code and writes them unasked; a CLAUDE.md that is there must send the agent to them', async ($, on) => {
  const w = await world($, on, { files: { ...SET_UP_TO_SECURITY, 'docs/agents/workflow.md': '# How\n', 'CLAUDE.md': '# Rules\n' } })
  await w.setup()
  await w.settle()
  // The standards' file there is not the step done: what it writes is a section of it.
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/^Step 6 of \/setup-project[\s\S]*Frontend \(React[\s\S]*dangerouslySetInnerHTML[\s\S]*Backend[\s\S]*server actions[\s\S]*1\. XSS[\s\S]*14\. LLM features[\s\S]*`## Security` heading in `CODING_STANDARDS\.md`[\s\S]*to `CLAUDE\.md`[\s\S]*Before writing code/)
  expect(w.submitted[0]).toMatch(/do not ask me\. Tell the sides from the code/)
  expect(w.submitted[0]).not.toContain('AskUserQuestion')
  await w.turn()
  await w.settle()
  expect(w.submitted).toHaveLength(1)
  // The rules with no line to them: the agent would meet them only once it broke them, so it goes back.
  await w.turn({ 'CODING_STANDARDS.md': '# Standards\n\n## Security\n\nBind every query.\n' })
  await w.settle()
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "The security rules[\s\S]*CLAUDE\.md: has no line[\s\S]*Before writing code/)
  await w.turn({ 'CLAUDE.md': `# Rules\n\n${SECURITY_LINE}` })
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^Step 7 of \/setup-project/)
  expect(w.submitted.filter(t => /^Step 6 of/.test(t))).toHaveLength(1)
})

test('with no CLAUDE.md yet the section is enough, and the step does not create one, which would read as the project’s own docs', async ($, on) => {
  const w = await world($, on, { files: SET_UP_TO_SECURITY })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/Where there is no such file, do not create it/)
  await w.turn({ 'CODING_STANDARDS.md': '# Standards\n\n## Security\n\nBind every query.\n' })
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  expect(w.submitted[1]).toMatch(/^Step 7 of \/setup-project/)
})

test('the security rules asked in Russian keep the floor and the line, and a section written by hand with no line to it is not taken as done', async ($, on) => {
  const w = await world($, on, { files: { ...SET_UP_TO_SECURITY, 'docs/agents/workflow.md': '# How\n', 'CODING_STANDARDS.md': '# Стандарты\n\n## Безопасность\n\n- Параметры.\n', 'CLAUDE.md': '# Rules\n\nSee `CODING_STANDARDS.md`.\n' } })
  await $.command.run({ command: 'changes', args: 'lang ru', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await w.setup()
  await w.settle()
  expect(w.submitted.at(0)).toMatch(/^Шаг 6 из \/setup-project[\s\S]*Фронтенд \(React[\s\S]*Бэкенд[\s\S]*## Безопасность[\s\S]*Прежде чем писать код/)
  expect(w.submitted.at(0)).toMatch(/меня не спрашивай\. Стороны определи по коду/)
  expect(w.submitted.at(0)).not.toContain('AskUserQuestion')
})

test('a set-up project from before the security rules gets their step with the next /setup-project, not as skipped by the person', async ($, on) => {
  const done = Object.fromEntries(['matt', 'openspec', 'existing', 'map', 'standards', 'lenses', 'checks', 'run', 'permissions', 'workflow', 'config', 'ci'].map(s => [s, { status: 'done' }]))
  const w = await world($, on, { files: SET_UP_TO_SECURITY })
  w.store.set('setup:/proj', { root: '/proj', current: null, steps: done })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  expect(w.submitted).toEqual([])
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^  new since this run: / })).toBeDefined()
  await pane.unmount()
  await w.setup()
  await w.settle()
  expect(w.submitted.filter(t => /^Step 6 of \/setup-project[\s\S]*the security rules/.test(t))).toHaveLength(1)
})

test('a kept run with steps still to go has the new step come in from its row', async ($, on) => {
  const steps = Object.fromEntries(['matt', 'openspec', 'existing', 'map', 'standards', 'lenses', 'checks', 'run', 'permissions', 'workflow', 'config'].map(s => [s, { status: 'done' }]))
  const w = await world($, on, { files: SET_UP_TO_SECURITY })
  w.store.set('setup:/proj', { root: '/proj', current: null, steps: { ...steps, ci: { status: 'waiting' } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  await pane.press({ key: 'setup-rerun-security' })
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^Step 6 of \/setup-project[\s\S]*the security rules/)
  await pane.unmount()
})

test('the section of the security rules is told by its own heading, and the line to it by saying when to read it, in either language', () => {
  expect(hasSecurityRules('# Standards\n\n## Security\n\n- Bind.\n')).toBe(true)
  expect(hasSecurityRules('# Standards\r\n\r\n## Security\r\n\r\n- Bind.\r\n')).toBe(true)
  expect(hasSecurityRules('# Стандарты\n\n## Безопасность\n\n- Параметры.\n')).toBe(true)
  expect(hasSecurityRules('# Standards\n\n## Errors\n\nNot about security in a heading.\n')).toBe(false)
  expect(hasSecurityRules('# Standards\n\n### Cookie security\n\n```sh\n# run security audit\n```\n')).toBe(false)
  // Words after the heading's own, as the review reads it: the section all the same; another word is not.
  expect(hasSecurityRules('# Standards\n\n## Security rules\n\n- Bind.\n')).toBe(true)
  expect(hasSecurityRules('# Standards\r\n\r\n## Security: the floor\r\n\r\n- Bind.\r\n')).toBe(true)
  expect(hasSecurityRules('# Стандарты\n\n## Безопасность кода\n\n- Параметры.\n')).toBe(true)
  expect(hasSecurityRules('# Standards\n\n## Securityish\n\n- Bind.\n')).toBe(false)
  expect(hasSecurityRules('# Стандарты\n\n## Безопасностью\n\n- Параметры.\n')).toBe(false)
  expect(hasSecurityLine(SECURITY_LINE)).toBe(true)
  expect(hasSecurityLine('Прежде чем писать код, прочитай раздел «Безопасность» в `CODING_STANDARDS.md`.\n')).toBe(true)
  expect(hasSecurityLine('See `CODING_STANDARDS.md`.\nSecurity matters.\n')).toBe(false)
  expect(hasSecurityLine('`CODING_STANDARDS.md`: rules for code, the security rules among them.\n')).toBe(false)
})

// What every step before the checks writes: a project where the checks are the first step to go.
const UP_TO_CHECKS = {
  'docs/agents/issue-tracker.md': 'GitLab.\n',
  'docs/agents/domain.md': 'Single context.\n',
  'openspec/config.yaml': 'schema: spec-driven\n',
  'GLOSSARY.md': GLOSSARY,
  'ARCHITECTURE.md': '# Map\n',
  'CODING_STANDARDS.md': '# Standards\n\n## Security\n\nBind every query.\n',
  'LENSES.md': '1. Paired screens. A fix on the list and not on the card. Look at: each list with a card of its own.\n',
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
  expect(w.submitted[0]).toMatch(/^Step 8 of \/setup-project[\s\S]*\{files\}[\s\S]*\.claude\/agent-lens\.json/)
  await w.turn({ '.claude/agent-lens.json': JSON.stringify({ checks: { fast: ['eslint {files}', 'missing-tool'], full: ['npm test'] } }) })
  await w.settle()
  expect(w.shells()).toEqual(["eslint 'src/a.ts'", 'missing-tool'])
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "The checks, and the gate at each turn’s end"[\s\S]*`missing-tool` does not start/)
  // Fixed: the step is done, the red of eslint kept against the commit, and the next step goes.
  await w.turn({ '.claude/agent-lens.json': JSON.stringify({ checks: { fast: ['eslint {files}'], full: ['npm test'] } }) })
  await w.settle()
  expect(w.store.get('setup:base:/proj')).toEqual({ '.': { sha: 'abc', red: ['eslint {files}'] } })
  expect(w.submitted[2]).toMatch(/^Step 9 of \/setup-project[\s\S]*smoke/)
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
  expect(w.submitted[0]).toMatch(/^Step 11 of \/setup-project[\s\S]*talked through with me[\s\S]*written down as a plan in the issue/)
  expect(w.submitted[0]).not.toMatch(/grilling|`tdd`|retro|openspec propose/)
})

test('a project with CI has a job added that runs the same checks; done once the CI names agent-lens', async ($, on) => {
  const files = {
    ...UP_TO_CHECKS,
    'openspec/config.yaml': 'context: see GLOSSARY.md\nrules:\n  tasks:\n    - each task names the rules and the lenses it touches\n',
    'CLAUDE.md': `Read \`ARCHITECTURE.md\`.\n${SECURITY_LINE}`,
    'docs/agents/workflow.md': '# How work goes\n',
    '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}',
    '.claude/settings.json': SETTINGS,
    '.gitlab-ci.yml': 'stages: [test]\n',
  }
  const w = await world($, on, { files })
  expect((await w.setup()).text).toMatch(/✓ CI: \.gitlab-ci\.yml/)
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 13 of \/setup-project[\s\S]*`\.gitlab-ci\.yml`[\s\S]*npx -y github:Darvl-52\/agent-lens check/)
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
  expect(w.submitted[0]).toMatch(/^Step 9 of/)
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
  expect(w.submitted[0]).toMatch(/^Step 11 of \/setup-project[\s\S]*`grilling`[\s\S]*`domain-modeling`[\s\S]*`tdd`[\s\S]*`diagnosing-bugs`[\s\S]*`code-review`[\s\S]*retro/)
  // A section already there and no CLAUDE.md yet: the step that writes it carries the line to the rules.
  expect(w.submitted[0]).toMatch(/has a Security section, this line too, as it stands: Before writing code that takes input/)
  // The agent as the orchestrator goes to CLAUDE.md, which every turn reads, not to the workflow.
  expect(w.submitted[0]).toMatch(/Then `CLAUDE\.md`[\s\S]*tells the agent it is the orchestrator[\s\S]*delegates by default/)
})

test('how work goes writing CLAUDE.md without the line to the security rules goes back for it', async ($, on) => {
  const files = { ...UP_TO_CHECKS, '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}', '.claude/settings.json': SETTINGS }
  const w = await world($, on, { files })
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/workflow.md': '# How work goes\n', 'CLAUDE.md': '# Rules\n' })
  await w.settle()
  expect(w.submitted[1]).toMatch(/^The check of the files of \/setup-project's step "How work goes, and CLAUDE\.md"[\s\S]*CLAUDE\.md: has no line[\s\S]*Before writing code/)
  await w.turn({ 'CLAUDE.md': `# Rules\n\n${SECURITY_LINE}` })
  await w.settle()
  expect(w.submitted[2]).toMatch(/^Step 12 of \/setup-project/)
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

test('OpenSpec’s config has each task name the rules and the lenses it touches: they are before the agent that builds it', async ($, on) => {
  const files = {
    ...UP_TO_CHECKS,
    'CLAUDE.md': `Read \`ARCHITECTURE.md\`.\n${SECURITY_LINE}`,
    'docs/agents/workflow.md': '# How work goes\n',
    '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}, "run": null}',
    '.claude/settings.json': SETTINGS,
  }
  const w = await world($, on, { files })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 12 of \/setup-project[\s\S]*LENSES\.md where it is there[\s\S]*each task names the test seam it is built at, and the rules of CODING_STANDARDS\.md and the lenses it touches/)
})

test('in any project with OpenSpec, a config whose tasks name no rules or lenses is offered the rule, and let go for good on ×', async ($, on) => {
  const w = await world($, on, { files: { 'openspec/config.yaml': 'schema: spec-driven\nrules:\n  proposal:\n    - use the glossary\n' } })
  await w.settle()
  const band = () =>
    $.ui.mount({
      plugin: 'agent-lens',
      surface: 'terminal',
      component: 'AbovePrompt' as const,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
  const row = await band()
  expect(await row.find({ type: 'Text', text: /^OpenSpec’s config has the tasks name no rules or lenses of the code/ })).toBeDefined()
  await row.press({ key: 'add-rules' })
  await row.unmount()
  expect(w.submitted.at(-1)).toMatch(/^Add one rule to this project's `openspec\/config\.yaml`[\s\S]*the artifact of the config's schema that writes the tasks[\s\S]*Code not in its layer or its folder; A form not by the project's convention;[\s\S]*Shared code\. Change nothing else/)
})

test('the rule is looked for under rules alone: a context that names LENSES.md is no rule of the tasks', async ($, on) => {
  const config = (rules: string) => `schema: spec-driven\ncontext: |\n  LENSES.md holds the lenses; agent-lens reads them.\nrules:\n${rules}`
  const w = await world($, on, { files: { 'openspec/config.yaml': config('  proposal:\n    - use the glossary\n') } })
  await w.settle()
  const band = () =>
    $.ui.mount({
      plugin: 'agent-lens',
      surface: 'terminal',
      component: 'AbovePrompt' as const,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
  const before = await band()
  expect(await before.find({ type: 'Text', text: /^OpenSpec’s config has the tasks name/ })).toBeDefined()
  await before.unmount()
  // A comment that speaks of lenses is no rule.
  w.disk.set('/proj/openspec/config.yaml', config('  # TODO: the lenses\n  proposal:\n    - use the glossary\n'))
  await w.turn()
  await w.settle()
  const commented = await band()
  expect(await commented.find({ type: 'Text', text: /^OpenSpec’s config has the tasks name/ })).toBeDefined()
  await commented.unmount()
  // Written by hand under rules, past a comment at the line's start, it is found and nothing is offered.
  w.disk.set('/proj/openspec/config.yaml', config('# the tasks\n  tasks:\n    - each task names the rules and the lenses it touches\n'))
  await w.turn()
  await w.settle()
  const after = await band()
  expect(await after.find({ type: 'Text', text: /^OpenSpec’s config has the tasks name/ })).toBeUndefined()
  await after.unmount()
})

test('in Russian the rule names the lenses as /changes lenses names them; while /setup-project goes, the row does not offer it', async ($, on) => {
  const w = await world($, on, { files: { ...UP_TO_CHECKS, 'openspec/config.yaml': 'schema: spec-driven\n' } })
  await w.settle()
  await $.command.run({ command: 'changes', args: 'lang ru', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const row = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await row.press({ key: 'add-rules' })
  await row.unmount()
  expect(w.submitted.at(-1)).toMatch(/^Добавь одно правило[\s\S]*Код не на своём слое и не в своём каталоге; Форма не по конвенции проекта;/)
  // A run of /setup-project started: its own step adds the rule, and the row offers it no more.
  await w.setup()
  await w.settle()
  const during = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await during.find({ type: 'Text', text: /^В конфиге OpenSpec задачи не называют/ })).toBeUndefined()
  await during.unmount()
})

test('the rule of the tasks turned down with × is not offered again in this project', async ($, on) => {
  const w = await world($, on, { files: { 'openspec/config.yaml': 'schema: spec-driven\n' } })
  await w.settle()
  const row = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await row.press({ key: 'dismiss-rules' })
  await row.unmount()
  expect(w.store.get('setup:rules-dismissed:/proj')).toBe(true)
  await w.turn()
  await w.settle()
  const again = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await again.find({ type: 'Text', text: /^OpenSpec’s config has the tasks name/ })).toBeUndefined()
  await again.unmount()
})

test('the rule of the tasks is read under rules as YAML holds it: comments out, quoted and block text kept', () => {
  const rules = (body: string) => `schema: x\ncontext: |\n  LENSES.md holds the lenses\nrules:\n${body}\nother: 1\n`
  expect(hasTaskRules(rules('  tasks:\n    - each task names the lenses it touches'))).toBe(true)
  expect(hasTaskRules(rules('  proposal:\n    - use the glossary'))).toBe(false)
  // A comment is no rule, wherever it stands; one at the line's start ends no section.
  expect(hasTaskRules(rules('  # TODO: the lenses\n  proposal:\n    - a rule # of lenses, later'))).toBe(false)
  expect(hasTaskRules(rules('# the tasks\n  tasks:\n    - names the lenses'))).toBe(true)
  // A `#` in quotes, or in a block scalar, is text.
  expect(hasTaskRules(rules("  tasks:\n    - 'see issue #12 about lenses'"))).toBe(true)
  expect(hasTaskRules(rules('  tasks: |\n    # Lenses: each task names them'))).toBe(true)
  // The next key of the top level ends it.
  expect(hasTaskRules('rules:\n  tasks:\n    - x\nnotes: the lenses\n')).toBe(false)
  expect(hasTaskRules('rules: {tasks: [name the lenses]}\n')).toBe(true)
  expect(hasTaskRules('schema: x\n')).toBe(false)
  // The comment on the line of rules itself, an apostrophe of plain text, a block on its own dash, an escaped quote.
  expect(hasTaskRules('rules: # lens TODO\n  proposal:\n    - x\n')).toBe(false)
  expect(hasTaskRules(rules("  tasks:\n    - Don't skip tests # see lenses"))).toBe(false)
  expect(hasTaskRules(rules('  tasks:\n    - |\n      # Lenses each task names'))).toBe(true)
  expect(hasTaskRules(rules('  tasks:\n    - "a \\"quoted\\" word # and the lenses"'))).toBe(true)
  expect(hasTaskRules(rules("  tasks:\n    - 'it''s # the lenses'"))).toBe(true)
  expect(hasTaskRules(rules('  tasks:\n    - a -> b\n    # lenses later'))).toBe(false)
})

// What the audit of 0.19.0 found, written as it should be.

type KeptRun = { current: string | null; steps: Record<string, { status: string }> }
type World = Awaited<ReturnType<typeof world>>
const runIn = (w: World) => w.store.get('setup:/proj') as KeptRun
const bandOf = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} } })
const endTurn = ($: Parameters<TestBody>[0], turnId: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, reason, usage: { ...USAGE, model: 'test' } })
// A project whose fast check is red whatever is written.
const redLint = (files: Record<string, string> = {}) => ({ files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}', ...files }, git: REPO, sh: (c: string) => (c === 'lint' ? { exitCode: 1, stdout: 'bad' } : undefined) })
const gateRed = (round: number) => new RegExp(`^The project's fast checks[\\s\\S]*round ${round} of 3`)
const TASK_RULES_OFFER = /^OpenSpec’s config has the tasks name/

// Up to the map's step sent back once: its files fail the check, the fix is the prompt returned.
const mapFixSent = async (w: World) => {
  await w.setup()
  await w.settle()
  await w.turn({ 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n' })
  await w.settle()
  await w.turn({ 'GLOSSARY.md': `${GLOSSARY}\nA loose note.\n`, 'ARCHITECTURE.md': '# Map\n' }, w.submitted[0])
  await w.settle()
  expect(w.submitted[1]).toMatch(/^The check of the files/)
  return w.submitted[1]!
}

// Then the fix's own turn leaves the glossary failing: the step stops and waits for the person.
const mapStopped = async (w: World) => {
  await w.turn({}, await mapFixSent(w))
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  expect(runIn(w).steps.map!.status).toBe('failed')
}

test('past the turns the parts may start by themselves, the gate sends no red back: the row says it was held, the next prompt of the person’s starts the count again', { options: { autoTurns: 1 } }, async ($, on) => {
  const w = await world($, on, redLint())
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  await endTurn($, 't')
  await w.settle()
  // The one turn: the red goes as the next prompt.
  expect(w.submitted.filter(s => gateRed(1).test(s))).toHaveLength(1)
  // Its turn, still red: neither a classic stop nor a prompt takes it further.
  await $.turn.start({ text: w.submitted.at(-1)!, turnId: 'gate' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'y' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await endTurn($, 'gate')
  await w.settle()
  expect(w.submitted.filter(s => /^The project's fast checks/.test(s))).toHaveLength(1)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^✗ red: not sent back, as the turns agent-lens may start by itself/ })).toBeDefined()
  await pane.unmount()
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: /checks: 1 red/ })).toBeDefined()
  await band.unmount()
  // The person's next prompt: the gate holds the turn again.
  await $.turn.start({ text: 'go on', turnId: 'u' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'z' })
  await w.settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/round 1 of 3/)
})

test('a step stopped on its failed check waits for the person: a turn of another prompt does not move the run on', async ($, on) => {
  const w = await world($, on)
  await mapStopped(w)
  await w.turn({}, 'Do the next task of add-dark-mode.')
  await w.settle()
  expect(w.submitted).toHaveLength(2)
  expect(runIn(w).current).toBe('map')
  expect(runIn(w).steps.map!.status).toBe('failed')
})

test('a step’s fix is judged by its own turn, not by the turn of another prompt that ended first', async ($, on) => {
  const w = await world($, on)
  const fix = await mapFixSent(w)
  // Another prompt, queued before the fix, has its turn first: the glossary still fails.
  await w.turn({}, 'Do the next task of add-dark-mode.')
  await w.settle()
  expect(runIn(w).steps.map!.status).toBe('sent')
  // The fix's own turn mends it.
  await w.turn({ 'GLOSSARY.md': GLOSSARY }, fix)
  await w.settle()
  expect(runIn(w).steps.map!.status).toBe('done')
  expect(runIn(w).current).toBe('standards')
})

test('a step answered by Claude alone is not taken as done by a turn of another prompt while its own waits', async ($, on) => {
  const w = await world($, on, { files: { 'CLAUDE.md': '# Rules\n\nUse BEM.\n', 'CONTEXT.md': GLOSSARY, 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Read `CONTEXT.md`.\n', 'openspec/config.yaml': 'schema: spec-driven\n' } })
  await w.setup()
  await w.settle()
  expect(w.submitted[0]).toMatch(/^Step 3 of \/setup-project/)
  await w.turn({}, 'Do the next task of add-dark-mode.')
  await w.settle()
  expect(w.submitted).toHaveLength(1)
  expect(runIn(w).steps.existing!.status).toBe('sent')
})

test('the rule of the tasks is not offered beside a fresh run of /setup-project: its own step adds it', async ($, on) => {
  const w = await world($, on, { files: { 'openspec/config.yaml': 'schema: spec-driven\n' } })
  await w.settle()
  await w.setup()
  await w.settle()
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: TASK_RULES_OFFER })).toBeUndefined()
  await band.unmount()
})

test('the rule of the tasks is not offered while a run of /setup-project waits on a failed step, in the next session too', async ($, on) => {
  const w = await world($, on)
  await mapStopped(w)
  // openspec init wrote a config whose tasks name no rules: the run's own step 12 is still to come.
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.settle()
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: TASK_RULES_OFFER })).toBeUndefined()
  await band.unmount()
})

test('the rule of the tasks is read under tasks alone: a rule of the proposal or the design that names the lenses is none', () => {
  const rules = (body: string) => `schema: x\nrules:\n${body}\n`
  expect(hasTaskRules(rules('  proposal:\n    - name the lenses the change touches'))).toBe(false)
  expect(hasTaskRules(rules('  tasks:\n    - each task is small\n  design:\n    - the lenses of the change'))).toBe(false)
  expect(hasTaskRules(rules('  design:\n    - x\n  tasks:\n    - each task names the lenses it touches'))).toBe(true)
})

test('a step whose turn the person stopped waits for them, says so above the prompt, and does not hold the gate off', async ($, on) => {
  const w = await world($, on, redLint())
  await w.setup()
  await w.settle()
  // Matt's setup runs as a command: the turn it starts is the step's.
  expect(runIn(w).steps.matt!.status).toBe('sent')
  await $.turn.start({ text: 'go', turnId: 'stopped' })
  await endTurn($, 'stopped', 'aborted')
  await w.settle()
  expect(runIn(w).steps.matt!.status).toBe('failed')
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: /^setup: step 1 stopped/ })).toBeDefined()
  await band.unmount()
  // The person's next turn leaves the checks red: the gate sends it back.
  await $.turn.start({ text: 'fix the cart', turnId: 'person' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  await endTurn($, 'person')
  await w.settle()
  expect(w.submitted.some(s => gateRed(1).test(s))).toBe(true)
})

test('where no classic hook runs, the gate’s rounds go on past a turn of the review’s notes that ran first', { options: { autoTurns: 5 } }, async ($, on) => {
  const caught = JSON.stringify({ findings: [], violations: [{ rule: 'No comments in code', evidence: '// x', fix: 'Remove the comment.' }] })
  const w = await world($, on, { ...redLint({ 'CLAUDE.md': 'No comments in code.\n' }), reply: caught })
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: '// x' })
  await w.settle()
  await endTurn($, 't')
  await w.settle()
  const gate = w.submitted.find(s => gateRed(1).test(s))
  const notes = w.submitted.find(s => s.startsWith('agent-lens: your edit'))
  expect(gate).toBeDefined()
  expect(notes).toBeDefined()
  // The notes' turn runs first and edits nothing; then the gate's turn, still red.
  await $.turn.start({ text: notes!, turnId: 'notes' })
  await endTurn($, 'notes')
  await w.settle()
  await $.turn.start({ text: gate!, turnId: 'gate' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'y' })
  await w.settle()
  await endTurn($, 'gate')
  await w.settle()
  expect(w.submitted.some(s => gateRed(2).test(s))).toBe(true)
})

test('the setup turned off in /agent-lens mid-turn sends nothing at that turn’s end', async ($, on) => {
  const w = await world($, on, redLint())
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  await w.settle()
  await $.command.run({ command: 'agent-lens', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const parts = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane', requestId: 'agent-lens-parts', props: { title: 'agent-lens', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await parts.press({ key: 'toggle-setup' })
  expect((await parts.find({ key: 'toggle-setup' }))?.props.label).toBe('○ off')
  await parts.unmount()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await endTurn($, 't')
  await w.settle()
  expect(w.submitted.filter(s => /fast checks/.test(s))).toEqual([])
})

test('in auto, the docs agent’s blockers go to Claude by themselves, with no j, and the minor ones stay on the pane', async ($, on) => {
  const w = await world($, on, { files: { 'docs/agents/workflow.md': '# How work goes\n', 'CLAUDE.md': '# Rules\n' }, autonomy: 'auto' })
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/CLAUDE.md', content: '# Rules\n\nWrite clean code.\n' })
  await w.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
  await w.settle()
  await w.agentDone(
    'judge-1',
    '[{"file": "CLAUDE.md", "problem": "A wish that changes nothing", "fix": "Take it out", "severity": "blocker"}, {"file": "CLAUDE.md", "problem": "A heading could be shorter", "severity": "minor"}]',
  )
  await w.settle()
  const sent = w.submitted.filter(s => s.startsWith('agent-lens: the checks of your work found these'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatch(/#1 CLAUDE\.md — A wish that changes nothing Fix: Take it out/)
  expect(sent[0]).not.toMatch(/A heading could be shorter/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: '• CLAUDE.md: A wish that changes nothing' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /A heading could be shorter/ })).toBeDefined()
  await pane.unmount()
})

test('in auto, a term the docs agent found nowhere goes to Claude to take out unasked, and one it could not look at is still the person’s question', async ($, on) => {
  const git: Git = args => (args[0] === 'grep' ? { exitCode: 1, stdout: '' } : undefined)
  const w = await world($, on, { git, files: { 'docs/agents/workflow.md': '# How work goes\n', 'GLOSSARY.md': GLOSSARY }, autonomy: 'auto' })
  await w.settle()
  await w.agentDone('judge-1', '[{"file": "GLOSSARY.md", "term": "Order", "inUse": true, "where": "src/orders.ts"}, {"file": "GLOSSARY.md", "term": "Invoice", "inUse": false, "where": ""}]')
  await w.settle()
  const sent = w.submitted.filter(s => s.startsWith('agent-lens: the checks of your work found these'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatch(/#1 GLOSSARY\.md — the term "Invoice" is found nowhere outside the glossaries/)
  expect(sent[0]).not.toMatch(/"Order"/)
  // The person is asked nothing of it.
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^"Invoice" \(GLOSSARY\.md\)/ })).toBeUndefined()
  await pane.unmount()
})

test('the docs a step of /setup-project writes in its turn are not checked edit by edit: the step’s check and the docs agent read them', async ($, on) => {
  const caught = JSON.stringify({ findings: [], violations: [{ rule: 'No comments in code', evidence: '// x', fix: 'Remove the comment.' }] })
  const w = await world($, on, { files: { 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n', 'openspec/config.yaml': 'schema: spec-driven\n', 'CLAUDE.md': 'No comments in code.\n' }, git: REPO, reply: caught })
  await w.setup()
  await w.settle()
  const step = w.submitted.at(-1)!
  expect(step).toMatch(/^Step \d+ of \/setup-project/)
  const writes = async (text: string, files: Record<string, string>) => {
    await $.turn.start({ text, turnId: text.slice(0, 9) })
    for (const [f, t] of Object.entries(files)) await $.tool.call({ tool: 'Write', file_path: `/proj/${f}`, content: t })
    await w.settle()
    await endTurn($, text.slice(0, 9))
    await w.settle()
  }
  await writes(step, { 'GLOSSARY.md': '# Shop\n\n// x\n', 'docs/adr/0001-x.md': '# X\n// x\n' })
  expect(w.submitted.some(s => s.startsWith('agent-lens: your edit'))).toBe(false)
  // The person's own turn is checked as ever.
  await writes('add a cart', { 'src/a.ts': '// x' })
  expect(w.submitted.some(s => s.startsWith('agent-lens: your edit'))).toBe(true)
})

test('a step not sent yet is skipped ahead from its row, the one with Claude kept, and the dear ones say what they cost', async ($, on) => {
  const w = await world($, on, { files: { 'docs/agents/issue-tracker.md': 'GitLab.\n', 'docs/agents/domain.md': 'Single context.\n', 'openspec/config.yaml': 'schema: spec-driven\n' } })
  await w.setup()
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^Step 4 of \/setup-project/)
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-setup', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: /^· waiting · reads some fifty merge requests: the dearest step$/ })).toBeDefined()
  // The step with Claude has no skip of its own row: its buttons are below.
  expect(await pane.find({ key: 'setup-skip-map' })).toBeUndefined()
  await pane.press({ key: 'setup-skip-lenses' })
  await w.settle()
  await pane.unmount()
  expect(runIn(w).steps.lenses!.status).toBe('skipped')
  expect(runIn(w).current).toBe('map')
  expect(runIn(w).steps.map!.status).toBe('sent')
})

test('a config the gate cannot read says the checks are off, on the row', async ($, on) => {
  await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"],}}' } })
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: /^checks off: \.claude\/agent-lens\.json does not read \(not JSON\)/ })).toBeDefined()
  await band.unmount()
})

test('the config is read for the row at the start, on an edit to it and at a turn’s end, not at each draw', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint"]}}' } })
  const isOff = async () => {
    const band = await bandOf($)
    const off = (await band.find({ type: 'Text', text: /^checks off/ })) !== undefined
    await band.unmount()
    return off
  }
  expect(await isOff()).toBe(false)
  // Broken on the disk behind the mod's back: the row stands as read until the next turn's end.
  w.disk.set('/proj/.claude/agent-lens.json', '{')
  expect(await isOff()).toBe(false)
  await w.turn({}, 'go')
  await w.settle()
  expect(await isOff()).toBe(true)
  // Mended by an edit: read again at once.
  await $.tool.call({ tool: 'Write', file_path: '/proj/.claude/agent-lens.json', content: '{"checks": {"fast": ["lint"]}}' })
  await w.settle()
  expect(await isOff()).toBe(false)
})

test('the agent taking a command out of the fast checks waits for the person', async ($, on) => {
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["lint", "tsc --noEmit"]}}' }, git: REPO })
  await $.turn.start({ text: 'the build is slow', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/.claude/agent-lens.json', content: '{"checks": {"fast": ["lint"]}}' })
  await w.settle()
  const band = await bandOf($)
  expect(await band.find({ type: 'Text', text: '1 to decide' })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane', requestId: 'agent-lens-decide', props: { title: 'To decide', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: '#1 .claude/agent-lens.json — the agent took out of the fast checks: `tsc --noEmit`' })).toBeDefined()
  await pane.unmount()
})

test('after a turn that commits, the fast checks that take files get the files it changed since its start', async ($, on) => {
  let head = 'h1'
  const git: Git = args =>
    args[0] === 'rev-parse' ? { exitCode: 0, stdout: `${head}\n` }
    : args[0] === 'diff' && args.includes('--name-only') ? { exitCode: 0, stdout: args[1] === 'h1' ? 'src/a.ts\n' : '' }
    : args[0] === 'diff' ? { exitCode: 0, stdout: head }
    : args[0] === 'ls-files' ? { exitCode: 0, stdout: '' }
    : undefined
  const w = await world($, on, { files: { '.claude/agent-lens.json': '{"checks": {"fast": ["eslint {files}"]}}' }, git })
  await $.turn.start({ text: 'fix and commit', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  head = 'h2'
  await w.settle()
  await endTurn($, 't')
  await w.settle()
  expect(w.shells()).toContain(`eslint 'src/a.ts'`)
})
