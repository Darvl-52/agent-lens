import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { checkDocs, pathsIn, pathsNamed } from '../hooks/setup/docs'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MATT = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro']
const GLOSSARY = '# Ordering\n\nTakes and tracks orders.\n\n## Language\n\n**Order**:\nA request to buy goods.\n_Avoid_: Purchase\n\n**Invoice**:\nA request for payment. Sent after delivery.\n'

const issuesOf = (files: Record<string, string>, missing: string[] = []) => checkDocs(files, new Set(missing)).map(i => [i.file, i.kind, i.detail ?? null])

test('the files are held to their size, the paths they name, and the forms of the glossary and the ADRs', () => {
  expect(issuesOf({ 'GLOSSARY.md': GLOSSARY, 'CLAUDE.md': 'Read `ARCHITECTURE.md` first.\n' })).toEqual([])
  expect(issuesOf({ 'CLAUDE.md': `${'line\n'.repeat(121)}` })).toEqual([['CLAUDE.md', 'size', '121/120']])
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
})

// A project on a disk of `files`, with Matt's skills listed unless `noMatt`, and the OpenSpec CLI
// unless `noOpenspec`; `openspec init` writes its folder.
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; noMatt?: boolean; noOpenspec?: boolean } = {}) => {
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
  on('command.run', ($, e) => (commands.push(e.command), {}))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (opts.noOpenspec && e.argv[0]!.startsWith('openspec')) return { deny: 'spawn openspec ENOENT' }
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: '1.14.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'init') disk.set('/proj/openspec/config.yaml', 'schema: spec-driven\n')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
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
  return { disk, store, submitted, commands, runs, opened, setup, turn, settle }
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
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/^Step 3 of \/setup-project[\s\S]*`GLOSSARY\.md` at the root/)

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
  expect(await pane.find({ type: 'Text', text: /^3\. The map: glossary, architecture, ADRs$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^· check failed$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^• GLOSSARY\.md:14: not a term entry/ })).toBeDefined()
  // Fixed by hand: the next turn's end finds it passing, and the standards go.
  w.disk.set('/proj/GLOSSARY.md', GLOSSARY)
  await pane.press({ key: 'setup-again' })
  await w.settle()
  expect(w.submitted).toHaveLength(3)
  expect(w.submitted[2]).toMatch(/^Step 3 of/)
  await w.turn()
  await w.settle()
  expect(w.submitted[3]).toMatch(/^Step 4 of \/setup-project[\s\S]*CODING_STANDARDS\.md/)
  // Skipped, the next goes.
  await pane.press({ key: 'setup-skip' })
  await w.settle()
  expect(w.submitted[4]).toMatch(/^Step 5 of \/setup-project[\s\S]*docs\/agents\/workflow\.md/)
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
