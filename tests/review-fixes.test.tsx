import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { below, canonical, samePath, whereIn } from '../hooks/review/diff'
import { clipRules } from '../hooks/review/rules'
import { isReadOnly } from '../hooks/review/shell'

// The fake disk is kept by the POSIX spelling, whichever the mod asks by.
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const APP = 'export const theme = "light"\nexport const size = 12\nexport const name = "app"\n'
const DARK = APP.replace('export const theme = "light"\n', 'export const theme = "dark"\nexport const contrast = "high"\nexport const accent = "blue"\n')
// The id git gives a text as a blob.
const blobId = async (text: string) => {
  const body = new TextEncoder().encode(text)
  const head = new TextEncoder().encode(`blob ${body.length}\0`)
  const all = new Uint8Array(head.length + body.length)
  all.set(head)
  all.set(body, head.length)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(b => b.toString(16).padStart(2, '0')).join('')
}

// A project in /proj, one repository: the disk, git and the model answered here, what the mod ran kept.
const project = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], files: Record<string, string>, reviewed: string) => {
  let probing = true
  let root = '/proj'
  const native = (path: string) => `${root}${path.slice('/proj'.length).replace(/\//g, root.includes('\\') ? '\\' : '/')}`
  const disk = new Map(Object.entries(files).map(([path, text]) => [`/proj/${path}`, text]))
  const head = new Map(disk)
  // The objects `git hash-object -w` wrote, by id.
  const objects = new Map<string, string>()
  const asked: ModelCompleteInput[] = []
  const runs: string[][] = []
  const shells: ((disk: Map<string, string>) => void)[] = []
  const clock = mock.clock(on, { now: 10_000 })
  const store = new Map<string, unknown>([['autonomy', 'manual']])
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = { value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
  on('state.set', ($, e, next) => (probing ? { value: { isSet: true as const, version: 0 } } : next(e)))
  on('session.root', () => ({ value: root }))
  on('fs.exists', ($, e) => {
    if (probing) root = e.path.replace(/[\\/]probe$/, '')
    return { value: disk.has(posix(e.path)) }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => ({ value: disk.get(posix(e.path)) ?? '' }))
  on('fs.ancestors', () => ({ value: [] }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const sub = argv.slice(argv.indexOf('-C') + 2)
    if (sub[0] === 'rev-parse' && sub[1] === '--show-toplevel') return ok(`${root.replace(/\\/g, '/')}\n`)
    if (sub[0] === 'status')
      return ok(
        [...new Set([...head.keys(), ...disk.keys()])]
          .filter(p => head.get(p) !== disk.get(p))
          .map(p => `${!head.has(p) ? '??' : disk.has(p) ? ' M' : ' D'} ${p.slice('/proj/'.length)}\0`)
          .join(''),
      )
    if (sub[0] === 'hash-object') {
      const paths = sub.slice(sub.indexOf('--') + 1)
      const ids: string[] = []
      for (const p of paths) {
        const text = disk.get(posix(p)) ?? ''
        const id = await blobId(text)
        objects.set(id, text)
        ids.push(id)
      }
      return ok(`${ids.join('\n')}\n`)
    }
    if (sub[0] === 'cat-file') return objects.has(sub.at(-1)!) ? ok(objects.get(sub.at(-1)!)!) : fail
    if (sub[0] === 'show') {
      const committed = head.get(`/proj/${sub.at(-1)!.replace(/^HEAD:/, '')}`)
      return committed === undefined ? fail : ok(committed)
    }
    return ok('')
  })
  on('model.complete', ($, e) => {
    asked.push(e)
    const text = /A first look at this diff|Первый взгляд на этот дифф/.test(e.prompt) ? 'All hold. [1]' : /Review the diff|Проверь дифф/.test(e.prompt) ? reviewed : '{}'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') {
      shells.shift()?.(disk)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    }
    if (e.tool !== 'Write' || probing) return { deny: 'unexpected' }
    disk.set(posix(e.file_path), e.content)
    return { result: { type: 'update' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: 'Write', file_path: '/proj/probe', content: '' })
  probing = false
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // One main turn: each of `commands` run in the shell, its effect on the disk with it, then `edits` written.
  const turn = async (text: string, edits: Record<string, string>, commands: [string, (disk: Map<string, string>) => void][] = []) => {
    await $.turn.start({ text, turnId: text })
    for (const [command, run] of commands) {
      shells.push(run)
      await $.tool.call({ tool: 'Bash', command })
    }
    for (const [path, content] of Object.entries(edits)) await $.tool.call({ tool: 'Write', file_path: native(`/proj/${path}`), content })
    await clock.advance(1)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: text, reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await clock.advance(10)
  }
  const review = () => $.command.run({ command: 'changes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  return { disk, asked, runs, turn, review, objects }
}

const BUG = '[{"file":"src/app.ts","line":1,"severity":"bug","text":"The theme no longer follows the system."}]'
const NOTE = '[{"file":"src/app.ts","severity":"note","text":"No test for the dark theme."}]'
const isReview = (a: ModelCompleteInput) => /Review the diff/.test(a.prompt)
const isDoubt = (a: ModelCompleteInput) => /A first look at this diff/.test(a.prompt)

test('Git Bash names a drive as a folder at the root: beside a Windows path, it is that path', () => {
  expect(canonical('/d/proj/src/a.ts', 'D:\\proj')).toBe('D:\\proj\\src\\a.ts')
  expect(canonical('/d', 'D:\\proj')).toBe('D:\\')
  // On its own, or beside a POSIX path, it may be a folder of its own: it stays one.
  expect([canonical('/d/proj'), canonical('/d/proj', '/proj'), canonical('/data/x', 'D:\\proj')]).toEqual(['/d/proj', '/d/proj', '/data/x'])
  expect(below('/d/Proj/src/a.ts', 'D:\\proj')).toBe('src/a.ts')
  expect(below('D:\\proj\\src\\a.ts', '/d/proj')).toBe('src/a.ts')
  expect(below('/d/proj/a.ts', '/d/proj')).toBe('a.ts')
  expect([samePath('/d/proj/a.ts', 'D:\\Proj\\a.ts'), samePath('/c/proj/a.ts', 'D:\\proj\\a.ts')]).toEqual([true, false])
  // Shown from the project, not by the whole path.
  expect(whereIn('/d/proj/src/a.ts', 'D:\\proj', 'D:\\proj')).toEqual({ group: '', rel: 'src/a.ts', shown: 'src/a.ts' })
  expect(whereIn('/d/proj/__front/x.ts', 'D:\\proj', canonical('D:/proj/__front'))).toEqual({ group: '__front', rel: 'x.ts', shown: '__front/x.ts' })
  expect(whereIn('/d/proj/notes/a.md', 'D:\\proj', null)).toEqual({ group: '', rel: 'notes/a.md', shown: 'notes/a.md' })
  // `map(canonical)` hands an index as the second word: no spelling of its own.
  expect(['/d/x', 'd:/y'].map(canonical)).toEqual(['/d/x', 'D:\\y'])
})

test('a rule file cut short keeps its security section whole, its heading saying more after its word', () => {
  const filler = `${'- a rule of style\n'.repeat(400)}`
  for (const heading of ['## Security', '## Security rules', '## Безопасность', '## Безопасность (OWASP)', '## SECURITY: OWASP top 10']) {
    const text = `# Standards\n\n${filler}\n${heading}\n\n- Never log a token.\n\n## Naming\n\n- camelCase.\n${filler}`
    const clipped = clipRules(text, 4_000)
    expect([heading, clipped.includes(`${heading}\n\n- Never log a token.\n\n`)]).toEqual([heading, true])
    expect(clipped.length).toBeLessThanOrEqual(4_000 + 100)
  }
  // A heading the word only begins, or one level down, is no security section: it gives way.
  for (const heading of ['## Securityfoo', '### Cookie security', '## Безопасностьх']) {
    const text = `# Standards\n\n${filler}\n${heading}\n\n- Never log a token.\n`
    expect([heading, clipRules(text, 4_000).includes('Never log a token.')]).toEqual([heading, false])
  }
  expect(clipRules('short', 4_000)).toBe('short')
})

test('a command that plainly writes nothing is read-only; anything that may write, or is not plain, is not', () => {
  for (const c of ['ls -la', 'cat src/a.ts', 'grep -rn "x" src', 'git log --oneline -5', 'git diff HEAD', 'git status', 'ls src 2>/dev/null', 'cd src && ls', 'git diff 2>&1 | head -40', 'find . -name "*.ts"', 'rg foo hooks', 'wc -l a b'])
    expect([c, isReadOnly(c)]).toEqual([c, true])
  for (const c of ['sed -i s/a/b/ x', 'cat > a.ts', 'echo x >> a', 'ls; rm a', 'git commit -m x', 'git -C x log', 'find . -delete', 'find . -exec rm {} +', 'git diff --output=x', 'ls &', 'cat $(ls)', 'cat `ls`', 'npm test', 'cat <<EOF\nx\nEOF', 'grep "a; rm -rf b" .', 'env FOO=1 node x', 'FOO=1 ls', 'rg --pre ./x foo', 'ls | xargs rm', 'git branch new', 'git stash'])
    expect([c, isReadOnly(c)]).toEqual([c, false])
})

test('a turn whose review finds notes alone asks for no second, doubting look', async ($, on) => {
  const { asked, turn } = await project($, on, { 'src/app.ts': APP }, NOTE)
  await turn('dark mode', { 'src/app.ts': DARK })
  expect(asked.filter(isReview)).toHaveLength(1)
  expect(asked.filter(isDoubt)).toHaveLength(0)
})

test('a turn whose review finds a likely bug has it looked at again, by the review model the settings name', { options: { reviewModel: 'opus' } }, async ($, on) => {
  const { asked, turn } = await project($, on, { 'src/app.ts': APP }, BUG)
  await turn('dark mode', { 'src/app.ts': DARK })
  expect(asked.filter(isDoubt)).toHaveLength(1)
  expect([...new Set(asked.filter(a => isReview(a) || isDoubt(a)).map(a => a.model))]).toEqual(['opus'])
})

test('the review model is sonnet where the settings name none', async ($, on) => {
  const { asked, turn } = await project($, on, { 'src/app.ts': APP }, BUG)
  await turn('dark mode', { 'src/app.ts': DARK })
  expect(asked.find(isReview)?.model).toBe('sonnet')
})

test('a long file is kept by its blob, and the session diff reads it back from git', async ($, on) => {
  const long = `${'export const row = [1, 2, 3]\n'.repeat(400)}`
  const { asked, runs, turn, review, objects } = await project($, on, { 'src/data.ts': long, 'src/app.ts': APP }, NOTE)
  await turn('add a row and dark mode', { 'src/data.ts': `${long}export const last = 4\nexport const more = 5\nexport const end = 6\n`, 'src/app.ts': DARK })
  // Written once, by its path, the short file not.
  const written = runs.filter(r => r.includes('hash-object'))
  expect(written).toHaveLength(1)
  expect(written[0]!.at(-1)).toMatch(/data\.ts$/)
  expect([...objects.values()]).toEqual([long])
  expect(asked.find(isReview)?.prompt).toMatch(/\+export const last = 4/)
  // The session diff, the next turn, reads the file as it was from its blob.
  await turn('one more row', { 'src/data.ts': `${long}export const last = 4\nexport const more = 5\nexport const end = 6\nexport const tail = 7\n` })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane', requestId: 'agent-lens-review', props: { title: 'Review', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
  await pane.select({ key: 'mode', value: 'session' })
  expect(await pane.find({ type: 'Text', text: /^\+4$/ })).toBeDefined()
  await pane.unmount()
  expect(runs.some(r => r.includes('cat-file'))).toBe(true)
})

test('a read-only shell command is not looked around; one that writes is, its after the next one’s before', async ($, on) => {
  const { runs, turn } = await project($, on, { 'src/app.ts': APP }, NOTE)
  await turn('dark mode', { 'src/app.ts': DARK })
  const statuses = () => runs.filter(r => r.includes('status')).length
  let was = statuses()
  await turn('look around', {}, [
    ['ls -la src', () => {}],
    ['git log --oneline -3', () => {}],
  ])
  expect(statuses() - was).toBe(0)
  was = statuses()
  await turn('write twice', {}, [
    ['sed -i s/a/b/ src/app.ts', d => d.set('/proj/src/app.ts', `${DARK}// b\n`)],
    ['sed -i s/b/c/ src/app.ts', d => d.set('/proj/src/app.ts', `${DARK}// c\n`)],
  ])
  // The turn's first takes what is uncommitted once, for the turn and the command both; each command
  // reads it once after, the second taking the first's after as its before; the turn's end once.
  expect(statuses() - was).toBe(4)
})
