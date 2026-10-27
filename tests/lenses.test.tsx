import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseLensReport } from '../hooks/lenses/report'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REPORT = `Read the branch.

{"lenses": [
  {"lens": "1. Code not in its layer", "status": "findings", "checked": "", "findings": [{"file": "src/orders.ts", "line": 12, "problem": "The status is checked in the service", "risk": "a second check drifts from the mapper"}]},
  {"lens": "2. A form not by the convention", "status": "clean", "checked": "4 new names against src/users.ts", "findings": []},
  {"lens": "9. Asynchrony", "status": "na", "checked": "no await in the diff", "findings": []}
], "outside": ["src/orders.ts:30 — a log line with the order's card number"], "untouched": ["src/cart.ts:3 — an old bug the diff does not touch"]}`

// A repository at /proj on a branch off origin/main, with `files` on its disk and `changed` the
// files that differ from where it forks.
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; changed?: string[]; untracked?: string[]; isRepo?: boolean; noDefault?: boolean; noSpawn?: boolean } = {}) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const disk = new Map(Object.entries(opts.files ?? {}))
  const store = new Map<string, unknown>()
  const spawned: { prompt: string; model?: string; description: string }[] = []
  const submitted: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) }))
  on('fs.read', ($, e) => (disk.has(e.path) ? { value: disk.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', ($, e) => {
    const args = e.argv[0] === 'git' ? e.argv.slice(e.argv.indexOf('-C') + 2) : []
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (opts.isRepo === false || e.argv[0] !== 'git') return { value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'rev-parse') return ok('/proj\n')
    if (args[0] === 'symbolic-ref' && !opts.noDefault) return ok('origin/main\n')
    if (args[0] === 'merge-base' && args[2] === 'origin/main' && !opts.noDefault) return ok('abc123def4567890\n')
    if (args[0] === 'merge-base' && args[2] === 'release') return ok('d3ve10fork000000\n')
    // git would take a base like this for an option and answer something: only the guard stops it.
    if (args[0] === 'merge-base' && args[2]?.startsWith('-')) return ok('0pt10n00000000\n')
    if (args[0] === 'diff' && args.includes('--name-only')) return ok((opts.changed ?? ['src/orders.ts']).join('\n'))
    if (args[0] === 'ls-files') return ok((opts.untracked ?? []).join('\n'))
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', ($, e) => (opts.noSpawn ? { deny: 'no agents here' } : (spawned.push({ prompt: e.prompt, model: e.model, description: e.description }), { model: e.model ?? 'sonnet' })))
  on('agent.list', () => ({ value: spawned.map((s, i) => ({ id: `lenses-${i + 1}`, description: s.description, type: 'Explore', status: 'running' as const, spawnedBy: 'agent-lens' })) }))
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"findings":[]}', usage: USAGE } }))
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.toast', ($, e) => (toasts.push(String((e as { text?: unknown }).text ?? '')), { value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const changes = (args: string) => $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const agentDone = (agentId: string, answer: string) =>
    $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
  return { spawned, submitted, opened, toasts, changes, agentDone }
}

test('the answer of the review by lenses is read from the JSON it ends with: a lens with findings is one whatever it says', () => {
  const report = parseLensReport(REPORT)!
  expect(report.results.map(r => [r.lens, r.status, r.findings.length])).toEqual([
    ['1. Code not in its layer', 'findings', 1],
    ['2. A form not by the convention', 'clean', 0],
    ['9. Asynchrony', 'na', 0],
  ])
  expect(report.results[0]!.findings[0]).toEqual({ file: 'src/orders.ts', line: 12, problem: 'The status is checked in the service', risk: 'a second check drifts from the mapper' })
  expect(report.outside).toEqual(["src/orders.ts:30 — a log line with the order's card number"])
  expect(report.untouched).toEqual(['src/cart.ts:3 — an old bug the diff does not touch'])
  expect(parseLensReport('{"lenses": [{"lens": "3. API", "status": "clean", "findings": [{"file": "a.ts", "problem": "too wide"}]}]}')!.results[0]!.status).toBe('findings')
  expect(parseLensReport('No list at all.')).toBeUndefined()
})

test('/changes lenses reads the branch from where it forks through the mod’s own lenses and the project’s, in an agent of its own', async ($, on) => {
  const w = await world($, on, { files: { '/proj/LENSES.md': '# Lenses\n\n1. **Money in floats** (4). Look at: each price.\n', '/home/me/.claude/review-lenses.md': '# Mine\n\n1. **My lens**\n' } })
  expect((await w.changes('lenses')).text).toBe('The review by lenses reads 1 file against abc123def456; its findings show on the pane.')
  expect(w.opened).toEqual(['agent-lens-lenses'])
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toMatchObject({ model: 'sonnet' })
  const prompt = w.spawned[0]!.prompt
  // The mod's own lenses and how to look go whatever the person has installed.
  expect(prompt).toMatch(/git -C \/proj diff abc123def456[\s\S]*Compare with the neighbour[\s\S]*13\. Shared code[\s\S]*The lenses of LENSES\.md[\s\S]*Money in floats/)
  // The person's own only where they turn it on.
  expect(prompt).not.toMatch(/My lens/)
  // One at a time.
  expect((await w.changes('lenses')).text).toBe('The review by lenses is still reading the branch.')
  expect(w.spawned).toHaveLength(1)
})

test('with includeUserLenses, the person’s ~/.claude/review-lenses.md is read beside them', { options: { includeUserLenses: true } }, async ($, on) => {
  const w = await world($, on, { files: { '/home/me/.claude/review-lenses.md': '# Mine\n\n1. **My lens**\n' } })
  await w.changes('lenses')
  expect(w.spawned[0]!.prompt).toMatch(/The lenses of ~\/\.claude\/review-lenses\.md[\s\S]*My lens/)
})

test('what the review found shows on the pane and the row, goes to Claude on j, and its report stays off Claude', async ($, on) => {
  const w = await world($, on)
  await w.changes('lenses')
  await w.agentDone('lenses-1', REPORT)
  const band = await $.ui.mount({
    plugin: 'agent-lens',
    surface: 'terminal',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: 'lenses: 2 findings' })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-lenses', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: '2 findings in 1 lens, against abc123def456' })).toBeDefined()
  // A bug in code the branch does not touch is shown apart, and not sent.
  expect(await pane.find({ type: 'Text', text: 'In code the branch does not touch: not sent to Claude' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '• src/orders.ts:12 — The status is checked in the service' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '  4 new names against src/users.ts' })).toBeDefined()
  await pane.press({ key: 'lenses-send' })
  await pane.unmount()
  expect(w.submitted.at(-1)).toMatch(/^The review of the branch by lenses found these\.[\s\S]*- 1\. Code not in its layer: src\/orders\.ts:12 — The status is checked in the service \(a second check drifts from the mapper\)\n- outside the lenses: src\/orders\.ts:30/)
  expect(w.submitted.at(-1)).not.toMatch(/src\/cart\.ts/)
  expect(await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="lenses-1">\n[Subagent hand-back] ...\n</agent-message>', origin: { kind: 'peer' }, isMeta: true, wait: false } as never)).toMatchObject({ drop: 'The branch through lenses' })
})

test('nothing changed against the base, and there is nothing to review', async ($, on) => {
  const w = await world($, on, { changed: [] })
  expect((await w.changes('lenses')).text).toBe('Nothing changed against abc123def456: nothing to review.')
  expect(w.spawned).toHaveLength(0)
})

test('outside a git repository the review by lenses says it reads a diff', async ($, on) => {
  const w = await world($, on, { isRepo: false })
  expect((await w.changes('lenses')).text).toBe('The project is not a git repository: the review by lenses reads a diff.')
})

test('a base given is read from where the branch forks from it; one not there, or none found, is said so', async ($, on) => {
  const w = await world($, on, { noDefault: true, untracked: ['src/new.ts'] })
  expect((await w.changes('lenses')).text).toBe('Where the branch forks from is not found: no origin/HEAD, main, master, develop or trunk. Name the base: /changes lenses <base>.')
  expect((await w.changes('lenses nope')).text).toBe('"nope" is no commit or branch of this repository.')
  expect((await w.changes('lenses release')).text).toBe('The review by lenses reads 2 files against d3ve10fork00; its findings show on the pane.')
  // The new files are named, as the diff does not show them; the tracked ones are counted.
  expect(w.spawned[0]!.prompt).toMatch(/git -C \/proj diff d3ve10fork00`, 1 file, [^\n]*these files git does not know of yet, which the diff does not show: src\/new\.ts/)
})

test('an answer with no list fails the review; r reads again, from the base it was asked for, and says how it went', async ($, on) => {
  const w = await world($, on)
  await w.changes('lenses release')
  await w.agentDone('lenses-1', 'I looked, and all is well.')
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-lenses', props: {} } as never)
  expect(await pane.find({ type: 'Text', text: '✗ The review by lenses gave no list.' })).toBeDefined()
  await pane.press({ key: 'lenses-again' })
  await pane.unmount()
  expect(w.spawned).toHaveLength(2)
  expect(w.spawned[1]!.prompt).toMatch(/diff d3ve10fork00/)
  expect(w.toasts.at(-1)).toBe('The review by lenses reads 1 file against d3ve10fork00; its findings show on the pane.')
})

test('an agent that does not start leaves the review as it was, so the next one may go', async ($, on) => {
  const w = await world($, on, { noSpawn: true })
  expect((await w.changes('lenses')).text).toBe('The agent of the review by lenses did not start.')
  expect((await w.changes('lenses')).text).toBe('The agent of the review by lenses did not start.')
  expect((await w.changes('lenses --output=/tmp/x')).text).toBe('"--output=/tmp/x" is no commit or branch of this repository.')
})

test('past 200 new files the list is cut, and the agent is told so', async ($, on) => {
  const w = await world($, on, { untracked: Array.from({ length: 203 }, (_, i) => `n${i}.ts`) })
  await w.changes('lenses')
  expect(w.spawned[0]!.prompt).toMatch(/n199\.ts, and 3 more, the list cut here\./)
})
