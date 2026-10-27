import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseLensReport, sendsOut } from '../hooks/lenses/report'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REPORT = `Read the branch.

{"lenses": [
  {"lens": "1. Code not in its layer", "status": "findings", "checked": "", "findings": [{"file": "src/orders.ts", "line": 12, "problem": "The status is checked in the service", "risk": "a second check drifts from the mapper"}]},
  {"lens": "2. A form not by the convention", "status": "clean", "checked": "4 new names against src/users.ts", "findings": []},
  {"lens": "9. Asynchrony", "status": "na", "checked": "no await in the diff", "findings": []}
], "outside": ["src/orders.ts:30 — a log line with the order's card number"], "untouched": ["src/cart.ts:3 — an old bug the diff does not touch"]}`

// A repository at /proj on a branch off origin/main, with `files` on its disk and `changed` the
// files that differ from where it forks.
const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { files?: Record<string, string>; changed?: string[]; untracked?: string[]; isRepo?: boolean; noDefault?: boolean; noSpawn?: boolean; clones?: Record<string, string[]>; rootNoBase?: boolean } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const disk = new Map(Object.entries(opts.files ?? {}))
  const store = new Map<string, unknown>()
  const spawned: { prompt: string; model?: string; description: string }[] = []
  const submitted: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  let head = 'h1'
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) || Object.keys(opts.clones ?? {}).some(c => e.path === `/proj/${c}/.git`) }))
  on('fs.read', ($, e) => (disk.has(e.path) ? { value: disk.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => ({ value: e.path.replace(/\/$/, '') === '/proj' ? Object.keys(opts.clones ?? {}).map(name => ({ name, kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false })) : [] }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', ($, e) => {
    const args = e.argv[0] === 'git' ? e.argv.slice(e.argv.indexOf('-C') + 2) : []
    const clone = e.argv[0] === 'git' ? Object.keys(opts.clones ?? {}).find(c => e.argv[e.argv.indexOf('-C') + 1] === `/proj/${c}`) : undefined
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (opts.isRepo === false || e.argv[0] !== 'git') return { value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(`${head}\n`)
    if (args[0] === 'rev-parse') return ok('/proj\n')
    if (args[0] === 'symbolic-ref' && !opts.noDefault && !(opts.rootNoBase && !clone)) return ok('origin/main\n')
    if (args[0] === 'merge-base' && args[2] === 'origin/main' && !opts.noDefault && !(opts.rootNoBase && !clone)) return ok('abc123def4567890\n')
    if (args[0] === 'merge-base' && args[2] === 'release' && !clone) return ok('d3ve10fork000000\n')
    // git would take a base like this for an option and answer something: only the guard stops it.
    if (args[0] === 'merge-base' && args[2]?.startsWith('-')) return ok('0pt10n00000000\n')
    if (args[0] === 'diff' && args.includes('--name-only')) return ok((clone ? opts.clones![clone]! : (opts.changed ?? ['src/orders.ts'])).join('\n'))
    if (args[0] === 'ls-files') return ok((clone ? [] : [...(opts.untracked ?? []), ...Object.keys(opts.clones ?? {}).map(c => `${c}/`)]).join('\n'))
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
  on('tool.call', ($, e) => (e.tool === 'Bash' ? { result: { stdout: '', stderr: '', interrupted: false } } : { deny: 'unexpected' }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const changes = (args: string) => $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const agentDone = (agentId: string, answer: string) =>
    $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
  const settle = () => clock.advance(10)
  const commit = (sha: string) => (head = sha)
  return { clock, spawned, submitted, opened, toasts, changes, agentDone, settle, commit }
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
  expect((await w.changes('lenses nope')).text).toBe('"nope" is no commit or branch of any repository of the project.')
  expect((await w.changes('lenses release')).text).toBe('The review by lenses reads 2 files against d3ve10fork00; its findings show on the pane.')
  // The new files are named, as the diff does not show them; the tracked ones are counted.
  expect(w.spawned[0]!.prompt).toMatch(/git -C \/proj diff d3ve10fork00`: 1 file, and these files git does not know of yet, which the diff does not show: src\/new\.ts/)
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
  expect((await w.changes('lenses --output=/tmp/x')).text).toBe('"--output=/tmp/x" is no commit or branch of any repository of the project.')
})

test('past 200 new files the list is cut, and the agent is told so', async ($, on) => {
  const w = await world($, on, { untracked: Array.from({ length: 203 }, (_, i) => `n${i}.ts`) })
  await w.changes('lenses')
  expect(w.spawned[0]!.prompt).toMatch(/n199\.ts, and 3 more, the list cut here\n/)
})

test('a repository of its own in a top folder, as dev-env keeps its clones, is read too, each from where it forks', async ($, on) => {
  const w = await world($, on, { clones: { __bff: ['src/doors.ts', 'src/codes.ts'], __front: [] } })
  expect((await w.changes('lenses')).text).toBe('The review by lenses reads 3 files against abc123def456, abc123def456 (__bff); its findings show on the pane.')
  const prompt = w.spawned[0]!.prompt
  expect(prompt).toMatch(/- `git -C \/proj diff abc123def456`: 1 file\n- `git -C \/proj\/__bff diff abc123def456`: 2 files\nA finding names its file by its path from \/proj\./)
  // A clone with nothing changed is not named.
  expect(prompt).not.toMatch(/__front/)
})

test('a base given in the project’s own repository and not in a clone: the clone is read from where it forks by default', async ($, on) => {
  const w = await world($, on, { clones: { __bff: ['src/doors.ts'] } })
  expect((await w.changes('lenses release')).text).toBe('The review by lenses reads 2 files against d3ve10fork00, abc123def456 (__bff); its findings show on the pane.')
  // The clone's folder, which the project's own git lists as a folder it does not know, is no new file.
  expect(w.spawned[0]!.prompt).not.toMatch(/does not show: __bff/)
})

test('a repository whose fork point is not found is said left unread, the project’s own by name', async ($, on) => {
  const w = await world($, on, { rootNoBase: true, clones: { __bff: ['src/doors.ts'] } })
  expect((await w.changes('lenses')).text).toBe('The review by lenses reads 1 file against abc123def456 (__bff); its findings show on the pane. Left unread, no fork point found: the project’s own repository.')
})

const push = ($: Parameters<TestBody>[0], command = 'git push -u origin feature/x', agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never) as Promise<{ deny?: string }>

test('what sends the work out is read by its words: quotes are text, git’s own options passed over, a dry run sends nothing', () => {
  expect(sendsOut('git push -u origin feature/x')).toBe(true)
  expect(sendsOut('git -c core.x=y --no-pager -C "a b" push')).toBe(true)
  expect(sendsOut('cd __bff && /usr/bin/git push')).toBe(true)
  expect(sendsOut('gh -R o/r pr create --fill')).toBe(true)
  expect(sendsOut('glab mr create --squash-before-merge')).toBe(true)
  expect(sendsOut('git commit -m "fix git push hook"')).toBe(false)
  expect(sendsOut("echo 'a; git push'")).toBe(false)
  expect(sendsOut('git push --dry-run')).toBe(false)
  expect(sendsOut('git push-to-checkout')).toBe(false)
  expect(sendsOut('gh pr view 1')).toBe(false)
  // Groups, prefixes and variables before the command are passed over.
  for (const c of ['(cd x && git push)', '{ git push; }', 'sudo git push', 'sudo -u root git push', 'nice -n 10 git push', 'env -i FOO=1 git push', 'time git push', 'GIT_SSH_COMMAND="ssh -i k" git push', 'git --config-env a=B push', 'if true; then git push; fi'])
    expect([c, sendsOut(c)]).toEqual([c, true])
  // Text of a heredoc, of a log, of a search is no push.
  for (const c of ['cat <<EOF > notes.md\ngit push\nEOF', "cat <<'EOF'\ngh pr create\nEOF\necho ok", 'git log --grep push', 'grep -r "git push" .', 'npm run push', 'git stash push'])
    expect([c, sendsOut(c)]).toEqual([c, false])
})

test('Lenses: auto holds a push of commits the lenses have not read: the review starts, its findings come next, then the push goes once', { options: { lenses: 'auto' } }, async ($, on) => {
  const w = await world($, on)
  expect((await push($)).deny).toMatch(/^agent-lens reads the work through the lenses before it leaves the machine \(Lenses: auto\)/)
  expect(w.spawned).toHaveLength(1)
  // Asked again while it reads: held, no second review.
  expect((await push($, 'gh pr create --fill')).deny).toMatch(/^The review by lenses is still reading the work/)
  expect(w.spawned).toHaveLength(1)
  await w.agentDone('lenses-1', REPORT)
  await w.settle()
  expect(w.submitted.at(-1)).toMatch(/^The review of the branch by lenses found these\.[\s\S]*Then push, as you meant to\.$/)
  // The fixes are a commit of their own: the push it held goes once all the same, not into another round.
  w.commit('h2')
  expect((await push($)).deny).toBeUndefined()
  // The same commits go again freely, the pull request after the push among them, and spend nothing.
  expect((await push($, 'gh pr create --fill')).deny).toBeUndefined()
  expect((await push($)).deny).toBeUndefined()
  // Work of later commits is read before its push.
  w.commit('h3')
  expect((await push($)).deny).toMatch(/^agent-lens reads the work/)
  expect(w.spawned).toHaveLength(2)
})

test('Lenses: auto lets a subagent’s push go, and a review gone past its time holds nothing', { options: { lenses: 'auto' } }, async ($, on) => {
  const w = await world($, on)
  expect((await push($, 'git push', 'sub-1')).deny).toBeUndefined()
  expect(w.spawned).toHaveLength(0)
  await w.changes('lenses')
  await w.clock.advance(31 * 60_000)
  expect((await push($)).deny).toMatch(/^agent-lens reads the work/)
  expect(w.spawned).toHaveLength(2)
})

test('Lenses: auto, a review that finds nothing sends the push on, and one that gave no list holds it no more', { options: { lenses: 'auto' } }, async ($, on) => {
  const w = await world($, on)
  await push($)
  await w.agentDone('lenses-1', '{"lenses": [{"lens": "1. Layer", "status": "clean", "checked": "2 files", "findings": []}], "outside": []}')
  await w.settle()
  expect(w.submitted.at(-1)).toBe('The review of the work by lenses found nothing. Push now, as you meant to.')
  expect((await push($)).deny).toBeUndefined()
  w.commit('h2')
  await push($)
  await w.agentDone('lenses-2', 'No list.')
  await w.settle()
  expect(w.submitted.at(-1)).toBe('The review by lenses gave no list, so nothing holds the push. Push now, as you meant to.')
  expect((await push($)).deny).toBeUndefined()
})

test('Lenses: offer leaves a push alone', async ($, on) => {
  const w = await world($, on)
  expect((await push($)).deny).toBeUndefined()
  expect(w.spawned).toHaveLength(0)
})

test('Lenses: auto, where nothing changed there is nothing to read and the push goes', { options: { lenses: 'auto' } }, async ($, on) => {
  const w = await world($, on, { changed: [] })
  expect((await push($)).deny).toBeUndefined()
  expect(w.spawned).toHaveLength(0)
})

test('Lenses: auto, the commits a review read are those it started on; a review by hand keeps the pass a held push was given', { options: { lenses: 'auto' } }, async ($, on) => {
  const w = await world($, on)
  await push($)
  // A commit made while the review reads is not among what it read.
  w.commit('h2')
  await w.agentDone('lenses-1', '{"lenses": [{"lens": "1. Layer", "status": "clean", "checked": "1 file", "findings": []}], "outside": []}')
  await w.settle()
  expect((await push($)).deny).toMatch(/^agent-lens reads the work/)
  await w.agentDone('lenses-2', REPORT)
  await w.settle()
  // A review by hand before the push does not take the pass back.
  w.commit('h3')
  await w.changes('lenses')
  await w.agentDone('lenses-3', REPORT)
  await w.settle()
  expect((await push($)).deny).toBeUndefined()
})
