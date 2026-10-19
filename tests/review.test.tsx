import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { below, canonical, changedSpan, fileDiff, fileText, filesText, fingerprintOf, joinPath, keptFindings, nameOf, parentOf, parseFindings, parseNotes, parseStatus, parseUnified, samePath, whereIn, withWhere } from '../hooks/review/diff'
import { WORDS } from '../hooks/review/words'

// Where a file of the project's own repository is shown.
const at = (rel: string) => ({ group: '', rel, shown: rel })
// A line of code as the pane draws it: the two line numbers, the sign, the text, the row filled.
const code = (sign: '+' | '-', text: string) => new RegExp(`^[ \\d]{10}\\${sign} ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} *$`)

const lines = (n: number, at = 1) => Array.from({ length: n }, (_, i) => `line ${i + at}`).join('\n')

test('a file diff keeps three lines of context, joins near runs and numbers them as git does', () => {
  const before = `${lines(20)}\n`
  const after = `${before.replace('line 5\n', 'line five\n').replace('line 7\n', 'line seven\n').replace('line 18\n', '')}`
  const d = fileDiff('/p/a.ts', at('a.ts'), before, after)
  expect(d).toMatchObject({ isNew: false, isDeleted: false, added: 2, removed: 3 })
  expect(d.hunks.map(h => [h.oldStart, h.newStart, h.lines.length])).toEqual([
    [2, 2, 11],
    [15, 15, 6],
  ])
  expect(d.hunks[0]!.lines.slice(3, 5)).toEqual([
    { kind: '-', text: 'line 5' },
    { kind: '+', text: 'line five' },
  ])
  // The same lines give the same ids; a new file is added whole.
  expect(fileDiff('/p/a.ts', at('a.ts'), before, after).hunks[0]!.id).toBe(d.hunks[0]!.id)
  expect(fileDiff('/p/b.ts', at('b.ts'), null, 'x\ny\n')).toMatchObject({ isNew: true, added: 2, removed: 0 })
  expect(fileDiff('/p/b.ts', at('b.ts'), 'same\n', 'same\n').hunks).toEqual([])
})

const UNIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,3 +3,3 @@ export const a = 1
 keep
-old
+new
 keep
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
\\ No newline at end of file
`

test('git diff output is read file by file, hunk by hunk', () => {
  const files = parseUnified(UNIFIED, '/proj/__front', p => whereIn(p, '/proj', '/proj/__front'))
  expect(files.map(f => [f.path, f.shown, f.isDeleted, f.added, f.removed])).toEqual([
    ['/proj/__front/src/a.ts', '__front/src/a.ts', false, 1, 1],
    ['/proj/__front/gone.ts', '__front/gone.ts', true, 0, 1],
  ])
  expect(files[0]).toMatchObject({ group: '__front', rel: 'src/a.ts' })
  expect(files[0]!.hunks[0]).toMatchObject({ oldStart: 3, newStart: 3 })
  expect(fingerprintOf(files)).toBe(fingerprintOf(parseUnified(UNIFIED, '/proj/__front', p => at(p))))
})

test('a file is shown under its repository, and a rewritten line split around what changed', () => {
  expect(whereIn('/proj/src/a.ts', '/proj', '/proj')).toEqual({ group: '', rel: 'src/a.ts', shown: 'src/a.ts' })
  expect(whereIn('/proj/__lib/core/x.ts', '/proj', '/proj/__lib/core')).toEqual({ group: '__lib/core', rel: 'x.ts', shown: '__lib/core/x.ts' })
  expect(whereIn('/tmp/demo/src/a.ts', '/proj', '/tmp/demo')).toEqual({ group: 'demo', rel: 'src/a.ts', shown: 'demo/src/a.ts' })
  expect(whereIn('/proj/notes/a.md', '/proj', null)).toEqual({ group: '', rel: 'notes/a.md', shown: 'notes/a.md' })
  // A file kept by an earlier version, named by its shown path alone, is given the rest.
  const old = { path: '/proj/src/a.ts', shown: 'src/a.ts', isNew: false, isDeleted: false, added: 1, removed: 0, hunks: [] }
  expect(withWhere([old as unknown as Parameters<typeof withWhere>[0][number]], '/proj')[0]).toMatchObject({ group: '', rel: 'src/a.ts', shown: 'src/a.ts' })
  expect(changedSpan('const a = "light"', 'const a = "dark"')).toEqual({ head: 'const a = "', was: 'light', now: 'dark', tail: '"' })
})

test('a path is read by either separator, a Windows one case-folded, a drive root kept a root', () => {
  // One spelling: git's `d:/proj` is the engine's `D:\proj`; a POSIX path stays as it is.
  expect(canonical('d:/proj/src/')).toBe('D:\\proj\\src')
  expect([canonical('C:\\'), canonical('C:/'), canonical('/'), canonical('/proj/')]).toEqual(['C:\\', 'C:\\', '/', '/proj'])
  expect(below('D:\\Proj\\src\\a.ts', 'd:/proj')).toBe('src/a.ts')
  expect(below('C:\\a\\b.ts', 'C:\\')).toBe('a/b.ts')
  expect(below('/proj/src/a.ts', '/proj')).toBe('src/a.ts')
  // A POSIX path keeps its case; a folder is not below itself, nor one whose name runs on.
  expect([below('/Proj/a.ts', '/proj'), below('/proj', '/proj'), below('/projects/a.ts', '/proj'), below('D:\\projects\\a.ts', 'D:\\proj')]).toEqual([undefined, undefined, undefined, undefined])
  expect([parentOf('D:\\proj\\a.ts'), parentOf('D:\\a.ts'), parentOf('C:\\'), parentOf('/proj/a.ts'), parentOf('/a.ts')]).toEqual(['D:\\proj', 'D:\\', 'C:\\', '/proj', '/'])
  expect([nameOf('D:\\work\\proj'), nameOf('/home/me/proj/'), nameOf('C:\\')]).toEqual(['proj', 'proj', 'C:'])
  expect([joinPath('D:/proj', 'src/a b.ts'), joinPath('C:\\', 'x/y.ts'), joinPath('/proj', 'src/a.ts'), joinPath('/', 'a.ts')]).toEqual(['D:\\proj\\src\\a b.ts', 'C:\\x\\y.ts', '/proj/src/a.ts', '/a.ts'])
  expect([samePath('D:\\Proj', 'd:/proj/'), samePath('/Proj', '/proj')]).toEqual([true, false])
})

test('a Windows file is shown under its repository by `/`, as on macOS and Linux', () => {
  expect(whereIn('D:\\proj\\src\\a.ts', 'D:\\proj', canonical('D:/proj'))).toEqual({ group: '', rel: 'src/a.ts', shown: 'src/a.ts' })
  expect(whereIn('D:\\proj\\__lib\\core\\x.ts', 'D:\\proj', canonical('d:/proj/__lib/core'))).toEqual({ group: '__lib/core', rel: 'x.ts', shown: '__lib/core/x.ts' })
  expect(whereIn('C:\\tmp\\demo\\src\\a.ts', 'D:\\proj', 'C:\\tmp\\demo')).toEqual({ group: 'demo', rel: 'src/a.ts', shown: 'demo/src/a.ts' })
  // Outside any repository: inside the project by its path from it, else by its folder's name.
  expect(whereIn('D:\\proj\\notes\\a.md', 'D:\\proj', null)).toEqual({ group: '', rel: 'notes/a.md', shown: 'notes/a.md' })
  expect(whereIn('C:\\tmp\\x\\a.md', 'D:\\proj', null)).toEqual({ group: 'x', rel: 'a.md', shown: 'x/a.md' })
  // git's diff on Windows, its lines ended CRLF: each path made the engine's under the repository.
  const files = parseUnified(UNIFIED.replace(/\n/g, '\r\n'), 'D:/proj/__front', p => whereIn(p, 'D:\\proj', canonical('D:/proj/__front')))
  expect(files.map(f => [f.path, f.shown, f.isDeleted, f.added, f.removed])).toEqual([
    ['D:\\proj\\__front\\src\\a.ts', '__front/src/a.ts', false, 1, 1],
    ['D:\\proj\\__front\\gone.ts', '__front/gone.ts', true, 0, 1],
  ])
  expect(files[0]!.hunks[0]!.lines).toEqual([
    { kind: ' ', text: 'keep' },
    { kind: '-', text: 'old' },
    { kind: '+', text: 'new' },
    { kind: ' ', text: 'keep' },
  ])
})

test('git diff paths: a space with its tab after, a quote in C quotes, a byte past ASCII as it is', () => {
  const text = [
    'diff --git a/new file.md b/new file.md',
    '--- a/new file.md\t',
    '+++ b/new file.md\t',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git "a/say \\"hi\\".ts" "b/say \\"hi\\".ts"',
    '--- "a/say \\"hi\\".ts"',
    '+++ "b/say \\"hi\\".ts"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/café.ts b/café.ts',
    '--- /dev/null',
    '+++ b/café.ts',
    '@@ -0,0 +1 @@',
    '+b',
    '',
  ].join('\n')
  expect(parseUnified(text, '/proj', p => whereIn(p, '/proj', '/proj')).map(f => [f.path, f.shown, f.isNew])).toEqual([
    ['/proj/new file.md', 'new file.md', false],
    ['/proj/say "hi".ts', 'say "hi".ts', false],
    ['/proj/café.ts', 'café.ts', true],
  ])
})

test('a file Windows wrote, its lines ended CRLF, compares line for line; its line ends alone are no change', () => {
  const d = fileDiff('D:\\proj\\a.ts', at('a.ts'), 'one\r\ntwo\r\nthree\r\n', 'one\r\n2\r\nthree\r\n')
  expect(d.hunks[0]!.lines).toEqual([
    { kind: ' ', text: 'one' },
    { kind: '-', text: 'two' },
    { kind: '+', text: '2' },
    { kind: ' ', text: 'three' },
  ])
  expect(fileText(d, 'one\r\n2\r\nthree\r\n', { lines: 100, chars: 1000 })).toBe('1  one\n2  2\n3  three')
  expect(fileDiff('D:\\proj\\a.ts', at('a.ts'), 'one\r\ntwo\r\n', 'one\ntwo\n').hunks).toEqual([])
})

test('the model replies are read from their JSON, what is not usable dropped', () => {
  const findings = parseFindings('```json\n[{"file":"a.ts","line":4,"severity":"bug","text":"Off by one."},{"file":"b.ts","severity":"odd","text":"Left a log.","rule":" No logs "},{"text":"no file"}]\n```')
  expect(findings?.map(f => [f.file, f.line, f.severity, f.rule])).toEqual([
    ['a.ts', 4, 'bug', undefined],
    ['b.ts', undefined, 'note', 'No logs'],
  ])
  expect(parseFindings('Looks fine to me.')).toBeUndefined()
  // What the model reasoned before the JSON is passed over, brackets and all; a fenced block wins.
  expect(parseFindings('The loop reads a[i] past [hunk 1f]; so:\n[{"file":"a.ts","line":2,"severity":"bug","text":"Reads past the end."}]')?.map(f => f.line)).toEqual([2])
  expect(parseFindings('Nothing here: [] is the answer.\n```json\n[]\n```')).toEqual([])
  expect(parseNotes('{"h1":"Adds the toggle.","h9":"not sent","h2":""}', ['h1', 'h2'])).toEqual({ h1: 'Adds the toggle.' })
})

test('a changed file is sent numbered: whole, or around its hunks, never once it has moved on', () => {
  const before = `${lines(100)}\n`
  const after = before.replace('line 50\n', 'line fifty\n')
  const d = fileDiff('/p/a.ts', at('a.ts'), before, after)
  const whole = fileText(d, after, { lines: 100, chars: 10_000 })!
  expect(whole.split('\n')).toHaveLength(100)
  expect(whole.split('\n')[49]).toBe(' 50  line fifty')
  // Past either limit, the lines around each hunk alone.
  const around = fileText(d, after, { lines: 100, chars: 100 }, 5)!.split('\n')
  expect([around[0], around.at(-1), around.length]).toEqual([' 42  line 42', ' 58  line 58', 17])
  expect(fileText(d, after, { lines: 99, chars: 10_000 }, 5)!.split('\n')).toHaveLength(17)
  // Edited since the diff was taken: its numbers would not be the diff's.
  expect(fileText(d, after.replace('line 2\n', ''), { lines: 100, chars: 10_000 })).toBeUndefined()
  expect(filesText([d], { '/p/a.ts': whole }, 50)).toMatch(/^=== a\.ts ===\n  1  line 1[\s\S]*\n… \(cut\)$/)
  expect(filesText([d], {}, 50)).toBe('')
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
const PANE = {
  component: 'Pane' as const,
  requestId: 'agent-lens-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// What one model call costs here: written to the cache, then read from it.
const CALL = { input_tokens: 300, output_tokens: 700, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 }
const APP = 'export const theme = "light"\nexport const size = 12\nexport const name = "app"\n'
// Dark mode in three lines where the theme was one: enough to be reviewed by itself.
const DARK = APP.replace('export const theme = "light"\n', 'export const theme = "dark"\nexport const contrast = "high"\nexport const accent = "blue"\n')
const REVIEWED =
  '[{"file":"src/app.ts","line":1,"severity":"bug","text":"The theme no longer follows the system."},{"file":"src/app.ts","severity":"note","text":"No test for the dark theme."}]'

// The engine hands the mod each path as the platform spells it: on Windows `D:\proj\src\app.ts` for
// `/proj/src/app.ts`. The disk here is kept by the POSIX spelling, whichever the mod asks by.
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// A project in /proj, one repository, its files on a disk kept here; Write edits it, and the model,
// git, the prompts sent and the toasts are answered and kept here, so a test reads what the mod did.
const project = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], files: Record<string, string>) => {
  // The project folder as the platform spells it, answered as the session's root: learned from an
  // edit the mod is handed before the session starts, none of whose writes is kept.
  let probing = true
  let root = '/proj'
  const native = (path: string) => `${root}${path.slice('/proj'.length).replace(/\//g, root.includes('\\') ? '\\' : '/')}`
  const disk = new Map(Object.entries(files).map(([path, text]) => [`/proj/${path}`, text]))
  // What is committed: the files as the project starts.
  const head = new Map(disk)
  // What each Bash call does to the disk, in turn.
  const shells: ((disk: Map<string, string>) => void)[] = []
  const asked: ModelCompleteInput[] = []
  // What the check of each edit was asked, apart from the review's calls, and what it answers.
  const checked: ModelCompleteInput[] = []
  let violations = '{"violations":[]}'
  const submitted: string[] = []
  const toasts: string[] = []
  let gitDiff = ''
  let reviewed = REVIEWED
  // What the second look keeps of the first's findings, by number: all of REVIEWED's two.
  let kept = '[1, 2]'
  // Every command the mod ran.
  const runs: string[][] = []
  const clock = mock.clock(on, { now: 10_000 })
  const store = new Map<string, unknown>()
  on('state.set', ($, e, next) => (probing ? { value: { isSet: true as const, version: 0 } } : next(e)))
  on('session.root', () => ({ value: root }))
  on('fs.exists', ($, e) => {
    if (probing) root = e.path.replace(/[\\/]probe$/, '')
    return { value: disk.has(posix(e.path)) }
  })
  on('fs.read', ($, e) => ({ value: disk.get(posix(e.path)) ?? '' }))
  // The engine's walk for nested rules: each folder strictly inside `below`, down to the one `of`
  // is in, root first, and the names asked for that each holds.
  on('fs.ancestors', ($, e) => {
    const top = posix(e.below ?? '/')
    const file = posix(e.of ?? '/proj/.')
    const dirs: string[] = []
    for (let dir = file.slice(0, file.lastIndexOf('/')); dir.length > top.length && dir.startsWith(top === '/' ? '/' : `${top}/`); dir = dir.slice(0, dir.lastIndexOf('/')))
      dirs.unshift(dir)
    const found = dirs.flatMap(dir => e.names.filter(name => disk.has(`${dir}/${name}`)).map(name => ({ dir, name, content: disk.get(`${dir}/${name}`)! })))
    return { value: found.map(f => ({ dir: native(f.dir), name: f.name, content: f.content, parts: [{ path: native(`${f.dir}/${f.name}`), content: f.content }] })) }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // As git for Windows says it: `D:/proj`, never `D:\proj`.
    if (e.argv.includes('rev-parse')) return ok(`${root.replace(/\\/g, '/')}\n`)
    if (e.argv.includes('status'))
      return ok(
        [...new Set([...head.keys(), ...disk.keys()])]
          .filter(p => head.get(p) !== disk.get(p))
          .map(p => `${!head.has(p) ? '??' : disk.has(p) ? ' M' : ' D'} ${p.slice('/proj/'.length)}\0`)
          .join(''),
      )
    if (e.argv.includes('show')) {
      const committed = head.get(`/proj/${e.argv.at(-1)!.replace(/^HEAD:/, '')}`)
      if (committed === undefined) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not in HEAD', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(committed)
    }
    if (e.argv.includes('diff')) return ok(gitDiff)
    if (e.argv.includes('ls-files') && e.argv.includes('--cached'))
      return ok([...disk.keys()].map(p => p.slice('/proj/'.length)).sort().join('\n'))
    return ok('')
  })
  // How long the review's model takes to answer, on the mocked clock.
  let delay = 0
  on('model.complete', async ($, e) => {
    if (delay > 0 && !e.system?.startsWith('You review one change')) await clock.sleep(delay)
    if (e.system?.startsWith('You review one change')) {
      checked.push(e)
      return { value: { isAnswered: true as const, text: violations, usage: USAGE } }
    }
    asked.push(e)
    const ids = [...e.prompt.matchAll(/\[hunk (\w+)\]/g)].map(m => m[1]!)
    const text = /A first look at this diff|Первый взгляд на этот дифф/.test(e.prompt)
      ? `Both hold up. ${kept}`
      : /Review the diff|Проверь дифф/.test(e.prompt)
      ? reviewed
      : /For each hunk|Для каждого куска/.test(e.prompt)
        ? JSON.stringify(Object.fromEntries(ids.map(id => [id, 'Turns the theme dark.'])))
        : /Walk the developer|Проведи разработчика/.test(e.prompt)
          ? '## In short\nThe app goes dark.'
          : 'Because the request asked for it (src/app.ts:1).'
    return { value: { isAnswered: true as const, text, usage: CALL } }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
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
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: 'Write', file_path: '/proj/probe', content: '' })
  probing = false
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // One turn of the main loop that writes `edits`, each file whole, by its path as the platform
  // spells it; `agentId` writes them as a subagent, `spell` names each path its own way.
  const turn = async (text: string, edits: Record<string, string>, agentId?: string, spell = (path: string) => path) => {
    await $.turn.start({ text, turnId: text })
    for (const [path, content] of Object.entries(edits))
      await $.tool.call({ tool: 'Write', file_path: spell(native(`/proj/${path}`)), content, ...(agentId ? { agentId } : {}) })
    // The checks of the turn's edits run beside it, and its end waits for them.
    await clock.advance(1)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: text, reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await clock.advance(10)
  }
  // One turn of the main loop that runs a shell command for each of `commands`, then writes `edits`.
  const shellTurn = async (text: string, commands: ((disk: Map<string, string>) => void)[], edits: Record<string, string> = {}) => {
    await $.turn.start({ text, turnId: text })
    for (const run of commands) {
      shells.push(run)
      await $.tool.call({ tool: 'Bash', command: 'sed -i … && git push' })
    }
    for (const [path, content] of Object.entries(edits)) await $.tool.call({ tool: 'Write', file_path: native(`/proj/${path}`), content })
    await clock.advance(1)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: text, reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await clock.advance(10)
  }
  const review = (args = '') =>
    $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  return {
    disk,
    store,
    native,
    asked,
    checked,
    submitted,
    toasts,
    runs,
    turn,
    shellTurn,
    review,
    settle: () => clock.advance(10),
    setGitDiff: (d: string) => (gitDiff = d),
    setReviewed: (r: string) => (reviewed = r),
    setKept: (k: string) => (kept = k),
    setViolations: (v: string) => (violations = v),
    setDelay: (ms: number) => (delay = ms),
    clock,
  }
}

const bandText = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND })
  const row = await ui.find({ type: 'Text', text: /^✎/ })
  await ui.unmount()
  return row?.text
}

const RULES = { 'CLAUDE.md': '# Project\nNo comments in code.\n', 'src/CLAUDE.md': '# Source\nStrict types.\n' }

test('a turn that edits a file is reviewed by itself, and the row says what is left', async ($, on) => {
  const { asked, turn, review } = await project($, on, { ...RULES, 'src/app.ts': APP })
  expect(await bandText($)).toBeUndefined()
  expect((await review()).text).toBe(WORDS.en.nothing)
  // A turn with no edits leaves no row.
  await turn('what does it do?', {})
  expect(await bandText($)).toBeUndefined()

  await turn('add dark mode', { 'src/app.ts': DARK })
  // The review, then a second look at what it found.
  expect(asked).toHaveLength(2)
  // The rules of every folder up from the file, first and cached; then the request and the diff.
  expect(asked[0]!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect(asked[0]!.promptBlocks?.[0]?.text).toMatch(/=== src\/CLAUDE\.md ===\n# Source[\s\S]*=== CLAUDE\.md ===\n# Project/)
  expect(asked[0]!.prompt).toMatch(/add dark mode[\s\S]*=== src\/app\.ts ===\n\[hunk \w+\]\n@@ -1 \+1 @@\n-export const theme = "light"\n\+export const theme = "dark"/)
  // Then the request, the file as it is now, numbered, and the diff, cached too; the ask last.
  const [, context, ask] = asked[0]!.promptBlocks ?? []
  expect(context).toMatchObject({ cache: true })
  // What was asked before in the session leads, so a change it asked for is not called unasked for;
  // the files of the repository follow the changed ones, so a path is checked, not guessed.
  expect(context?.text).toMatch(
    /^What the developer asked earlier in this session[^\n]*\n\n- what does it do\?\n\nWhat the developer asked the agent for:\nadd dark mode\n\nThe changed files[^\n]*\n\n=== src\/app\.ts ===\n1  export const theme = "dark"\n2  export const contrast = "high"\n[\s\S]*The files in the project, tracked or new and not ignored:\nCLAUDE\.md\nsrc\/CLAUDE\.md\nsrc\/app\.ts\n\nThe diff, each hunk under its id:/,
  )
  expect(ask).toEqual({ text: WORDS.en.reviewPrompt })
  expect(asked[0]!.effort).toBe('high')
  // The second look reads the same cached text, then the findings by number.
  expect(asked[1]!.promptBlocks?.slice(0, 2)).toEqual(asked[0]!.promptBlocks?.slice(0, 2))
  expect(asked[1]!.promptBlocks?.[2]?.text).toMatch(/^A first look at this diff found these:\n\n1\. src\/app\.ts:1: The theme no longer follows the system\.\n2\. src\/app\.ts: No test/)
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · 1 likely bug · 1 finding · 1 piece not looked at')
})

test('a turn that touched a line or two is not reviewed by itself; r on Findings reviews it', async ($, on) => {
  const { asked, turn, review } = await project($, on, { 'src/app.ts': APP })
  await turn('a bigger font', { 'src/app.ts': APP.replace('12', '14') })
  expect(asked).toHaveLength(0)
  expect(await bandText($)).toBe('✎ 1 file +1 −1 · not reviewed: small change · 1 piece not looked at')
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ type: 'Text', text: /^A change of a line or two: not reviewed by itself\.$/ })).toBeDefined()
  await pane.press({ key: 'check' })
  expect(asked.filter(a => /Review the diff above/.test(a.prompt))).toHaveLength(1)
  expect(await bandText($)).toBe('✎ 1 file +1 −1 · 1 likely bug · 1 finding · 1 piece not looked at')
  await pane.unmount()
})

test('the pane: each piece said what it is for, looked at, asked about, taken back; findings fixed or put aside', async ($, on) => {
  const { asked, native, turn, review, submitted, toasts } = await project($, on, { ...RULES, 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect((await review()).text).toBe('Opened the review.')
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  // Opening Changes asks what each piece is for, once.
  expect(asked.at(-1)!.prompt).toMatch(/For each hunk above, say/)
  expect(asked.at(-1)!.effort).toBe('low')
  // The same rules and diff as the review, so the cache serves them.
  expect(asked.at(-1)!.promptBlocks?.slice(0, 2)).toEqual(asked[0]!.promptBlocks?.slice(0, 2))
  expect(await pane.find({ type: 'Text', text: /^src\/app\.ts:1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Turns the theme dark\.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: code('-', 'export const theme = "light"') })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: code('+', 'export const theme = "dark"') })).toBeDefined()
  // What the review found on these lines stands by them.
  expect(await pane.find({ type: 'Text', text: /^✗ likely bug: The theme no longer follows the system\.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^1 file · \+3 −1 · looked at 0 of 1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^proj$/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-changes' })).toMatchObject({ props: { label: 'Changes (1)', autoFocus: true } })
  expect(await pane.find({ type: 'Text', text: /^Asked for: add dark mode$/ })).toBeDefined()
  // What the review, the explanations and the check of the edit cost, as the API counted it.
  expect(await pane.find({ type: 'Text', text: /^Spent this session: 4 calls · 5\.4k in \(4\.5k from cache\) · 2\.1k out$/ })).toBeDefined()

  const hunk = fileDiff(native('/proj/src/app.ts'), at('src/app.ts'), APP, DARK).hunks[0]!.id
  await pane.press({ key: `revert-${hunk}` })
  expect(submitted.at(-1)).toMatch(/^Take this piece of your change back out of src\/app\.ts[\s\S]*```diff\n--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n@@ -1 \+1 @@\n-export const theme = "light"/)
  expect(toasts).toEqual(['Sent to Claude.'])
  await pane.press({ key: `seen-${hunk}` })
  expect(await pane.find({ key: 'tab-changes' })).toMatchObject({ props: { label: 'Changes' } })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · 1 likely bug · 1 finding')

  // A question about one piece carries it.
  await pane.press({ key: `ask-${hunk}` })
  expect(await pane.find({ type: 'Text', text: /^About src\/app\.ts:1$/ })).toBeDefined()
  await pane.input({ key: 'question', text: 'Why dark by default?' })
  expect(asked.at(-1)!.prompt).toMatch(/The question is about this hunk:\n--- a\/src\/app\.ts[\s\S]*Question: Why dark by default\?/)
  expect(await pane.find({ type: 'Markdown', text: /Because the request asked/ })).toBeDefined()

  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ type: 'Text', text: /^likely bug$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^src\/app\.ts:1$/ })).toBeDefined()
  const [bug, note] = parseFindings(REVIEWED)!.map(f => f.id)
  // From a finding to its code, and back.
  await pane.press({ key: `code-${bug}` })
  expect(await pane.find({ type: 'Text', text: code('+', 'export const theme = "dark"') })).toBeDefined()
  await pane.press({ key: 'tab-findings' })
  await pane.press({ key: `fix-${bug}` })
  expect(submitted.at(-1)).toBe(
    'A review of your last changes found this in src/app.ts:1: The theme no longer follows the system.. Fix it. If it is not a problem, say why and change nothing.',
  )
  await pane.press({ key: `dismiss-${note}` })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · looked at')

  await pane.press({ key: 'tab-walkthrough' })
  expect(await pane.find({ type: 'Markdown', text: /The app goes dark/ })).toBeDefined()
  await pane.unmount()
})

test('fix all sends every finding still open in one prompt', async ($, on) => {
  const { turn, review, submitted, toasts } = await project($, on, { 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ key: 'fix-all' })).toMatchObject({ props: { label: 'fix all (2)', hotkey: 'f' } })
  await pane.press({ key: 'fix-all' })
  expect(submitted).toEqual([
    'A review of your last changes found these:\n\n1. src/app.ts:1: The theme no longer follows the system.\n2. src/app.ts: No test for the dark theme.\n\nFix each. Where one is not a problem, say why and leave it as it is.',
  ])
  expect(toasts).toEqual(['Sent to Claude.'])
  expect(await pane.findAll({ type: 'Text', text: /^sent to Claude$/ })).toHaveLength(2)
  expect(await pane.find({ key: 'fix-all' })).toBeUndefined()
  await pane.unmount()
})

test('fix all stays away while one finding or none is open', async ($, on) => {
  const { turn, review } = await project($, on, { 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  const [, note] = parseFindings(REVIEWED)!.map(f => f.id)
  await pane.press({ key: `dismiss-${note}` })
  expect(await pane.find({ key: 'fix-all' })).toBeUndefined()
  await pane.unmount()
})

test('a finding stays open over later turns until it is fixed or put aside, while its file is still changed', async ($, on) => {
  const { asked, turn, review, setReviewed } = await project($, on, { 'src/app.ts': APP, 'src/b.ts': 'b\n' })
  await turn('add dark mode', { 'src/app.ts': DARK })
  // A later turn on another file: what the first one's review found is still there to answer.
  await turn('rename b', { 'src/b.ts': 'bee\n' })
  expect(asked.filter(a => /Review the diff/.test(a.prompt))).toHaveLength(1)
  expect(await bandText($)).toBe('✎ 1 file +1 −1 · not reviewed: small change · 1 likely bug · 1 finding · 1 piece not looked at')
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ type: 'Text', text: /^From earlier reviews, still open:$/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-findings' })).toMatchObject({ props: { label: 'Findings (2)' } })
  expect(await pane.find({ key: 'fix-all' })).toMatchObject({ props: { label: 'fix all (2)' } })
  const [bug, note] = parseFindings(REVIEWED)!.map(f => f.id)
  await pane.press({ key: `fix-${bug}` })
  expect(await bandText($)).toBe('✎ 1 file +1 −1 · not reviewed: small change · 1 finding · 1 piece not looked at')
  // Its file is not in the last turn: to the code goes by the session's diff.
  await pane.press({ key: `code-${note}` })
  expect(await pane.find({ type: 'Text', text: code('+', 'export const theme = "dark"') })).toBeDefined()
  // Once the file is as it was before the session, what was found on it goes.
  setReviewed('[]')
  await turn('take dark mode back', { 'src/app.ts': APP })
  expect(await bandText($)).toBe('✎ 1 file +1 −3 · 1 piece not looked at')
  await pane.unmount()
})

test('the second look drops what it finds no problem, and keeps all when its answer is no list of numbers', async ($, on) => {
  const { turn, setKept } = await project($, on, { 'src/app.ts': APP })
  setKept('[2]')
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · 1 finding · 1 piece not looked at')

  setKept('no list here')
  await turn('and a border', { 'src/app.ts': `${DARK}export const border = 1\nexport const radius = 4\nexport const shadow = "soft"\n` })
  expect(await bandText($)).toMatch(/1 likely bug · \d findings?/)
})

test("a turn's shell commands, with the end of their output, reach the review", async ($, on) => {
  const { asked, shellTurn } = await project($, on, { 'src/app.ts': APP })
  await shellTurn('dark mode and push it', [() => {}], { 'src/app.ts': DARK })
  const review = asked.find(a => /Review the diff above/.test(a.prompt))
  expect(review?.prompt).toMatch(/What the developer asked the agent for:\ndark mode and push it\n\nThe shell commands the agent ran in this turn[^\n]*\n\n\$ sed -i … && git push\n\n/)
})

test('the second look keeps the findings by their numbers alone', () => {
  const found = parseFindings('[{"file":"a.ts","severity":"bug","text":"One."},{"file":"b.ts","text":"Two."}]')!
  expect(keptFindings('Only the second holds. [2]', found)?.map(f => f.file)).toEqual(['b.ts'])
  expect(keptFindings('[]', found)).toEqual([])
  expect(keptFindings('[{"file":"a.ts"}]', found)).toBeUndefined()
  expect(keptFindings('none', found)).toBeUndefined()
})

test('a long hunk is cut at 40 lines and opened further on a press', async ($, on) => {
  const long = Array.from({ length: 300 }, (_, i) => `export const n${i} = ${i}\n`).join('')
  const { native, turn, review } = await project($, on, { 'src/long.ts': '' })
  await turn('add the numbers', { 'src/long.ts': long })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  const hunk = fileDiff(native('/proj/src/long.ts'), at('src/long.ts'), '', long).hunks[0]!.id
  const shown = async () => (await pane.findAll({ type: 'Text', text: /^[ \d]{10}\+ export const n\d+ = / })).length
  expect(await shown()).toBe(40)
  expect(await pane.find({ key: `more-${hunk}` })).toMatchObject({ props: { label: 'show 200 more' } })
  expect(await pane.find({ type: 'Text', text: /… 260 more lines · $/ })).toBeDefined()
  await pane.press({ key: `more-${hunk}` })
  expect(await shown()).toBe(240)
  expect(await pane.find({ key: `more-${hunk}` })).toMatchObject({ props: { label: 'show them' } })
  await pane.press({ key: `more-${hunk}` })
  expect(await shown()).toBe(300)
  expect(await pane.find({ key: `more-${hunk}` })).toBeUndefined()
  await pane.press({ key: `less-${hunk}` })
  expect(await shown()).toBe(40)
  expect(await pane.find({ key: `less-${hunk}` })).toBeUndefined()
  await pane.unmount()
})

test('the session and the uncommitted diff, a subagent counted with its turn', async ($, on) => {
  const { turn, review, setGitDiff, settle } = await project($, on, { 'src/app.ts': APP, 'src/b.ts': 'b\n' })
  await turn('add dark mode', { 'src/app.ts': DARK })
  // Named as a model may name it on Windows, `d:/proj/src/app.ts`: still the one file.
  await turn('and a bigger font', { 'src/app.ts': DARK.replace('12', '14') }, 'agent-1', p => p.replace(/\\/g, '/').replace(/^[A-Z]:/, d => d.toLowerCase()))
  // The last turn: the font alone; the row counts it.
  expect(await bandText($)).toMatch(/^✎ 1 file \+1 −1/)
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: code('+', 'export const size = 14') })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: code('-', 'export const theme = "light"') })).toBeUndefined()
  await pane.select({ key: 'mode', value: 'session' })
  expect(await pane.find({ type: 'Text', text: code('-', 'export const theme = "light"') })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Asked for: add dark mode and a bigger font$/ })).toBeDefined()
  expect(await pane.find({ key: 'file-1' })).toBeUndefined()

  setGitDiff(UNIFIED.replace(/__front\//g, ''))
  await pane.select({ key: 'mode', value: 'uncommitted' })
  await settle()
  expect(await pane.find({ key: 'file-0' })).toMatchObject({ props: { label: 'gone.ts' } })
  expect(await pane.find({ type: 'Text', text: /^deleted$/ })).toBeDefined()
  await pane.press({ key: 'file-1' })
  expect(await pane.find({ type: 'Text', text: code('+', 'new') })).toBeDefined()
  setGitDiff('')
  await pane.select({ key: 'mode', value: 'turn' })
  await pane.select({ key: 'mode', value: 'uncommitted' })
  expect(await pane.find({ type: 'Text', text: /^Nothing uncommitted/ })).toBeDefined()
  await pane.unmount()
})

test('/changes lang ru: the row, the pane and the model speak Russian', async ($, on) => {
  const { asked, turn, review } = await project($, on, { 'src/app.ts': APP })
  expect((await review('lang de')).text).toBe('Usage: /changes lang en, /changes lang ru')
  expect((await review('lang ru')).text).toBe('Язык: русский.')
  await turn('сделай тёмную тему', { 'src/app.ts': DARK })
  expect(asked.at(-1)!.system).toMatch(/Отвечай по-русски/)
  expect(await bandText($)).toBe('✎ 1 файл +3 −1 · 1 вероятная ошибка · 1 замечание · 1 кусок не просмотрено')
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-changes' })).toMatchObject({ props: { label: 'Изменения (1)' } })
  await pane.unmount()
})

test('every piece of every file looked at in one press, the button there only for more than one file', async ($, on) => {
  const { turn, review } = await project($, on, { 'src/app.ts': APP, 'src/b.ts': 'b\n' })
  await turn('add dark mode', { 'src/app.ts': DARK, 'src/b.ts': 'bee\n' })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /^2 files · \+4 −2 · looked at 0 of 2$/ })).toBeDefined()
  expect(await pane.find({ key: 'seen-all' })).toMatchObject({ props: { label: 'all changes looked at', hotkey: 'a' } })
  await pane.press({ key: 'seen-all' })
  expect(await pane.find({ type: 'Text', text: /^2 files · \+4 −2 · looked at 2 of 2$/ })).toBeDefined()
  expect(await pane.find({ key: 'seen-all' })).toBeUndefined()
  expect(await pane.find({ key: 'seen-file' })).toBeUndefined()
  expect(await bandText($)).toMatch(/^✎ 2 files \+4 −2 · 1 likely bug · 1 finding$/)
  await pane.unmount()
})

test('a narrow pane gives the path its room, never the buttons', async ($, on) => {
  const { native, turn, review } = await project($, on, { 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'seen-all' })).toBeUndefined()
  const hunk = fileDiff(native('/proj/src/app.ts'), at('src/app.ts'), APP, DARK).hunks[0]!.id
  expect(await pane.find({ key: `actions-${hunk}` })).toMatchObject({ props: { flexShrink: 0 } })
  await pane.press({ key: 'tab-findings' })
  for (const id of parseFindings(REVIEWED)!.map(f => f.id)) expect(await pane.find({ key: `actions-${id}` })).toMatchObject({ props: { flexShrink: 0 } })
  await pane.unmount()
})

test('git status is read path by path, a rename by both its paths', () => {
  expect(parseStatus(' M src/a.ts\0?? new file.md\0R  b.ts\0old b.ts\0 D gone.ts\0')).toEqual(['src/a.ts', 'new file.md', 'b.ts', 'old b.ts', 'gone.ts'])
  expect(parseStatus('')).toEqual([])
})

test('what a shell command changes is in the turn and the session, as it was before the command', async ($, on) => {
  const { asked, disk, shellTurn, review } = await project($, on, { 'src/app.ts': APP, 'src/words.ts': 'a\nb\n', 'src/old.ts': 'old\n' })
  // Changed by hand before the turn: what the shell changes is counted from there, not from HEAD.
  disk.set('/proj/src/old.ts', 'old, edited by hand\n')
  await shellTurn(
    'add the label',
    [
      d => d.set('/proj/src/words.ts', 'a\nb\nlabel\nmore\n'),
      d => {
        d.set('/proj/src/new.ts', 'export const n = 1\n')
        d.set('/proj/src/old.ts', 'old, edited by hand\nand by sed\n')
      },
    ],
    { 'src/app.ts': DARK },
  )
  // Reviewed with the files the shell changed, each from what it was before the turn.
  const prompt = asked.find(a => /Review the diff/.test(a.prompt))!.prompt
  expect(prompt).toMatch(/=== src\/words\.ts ===\n\[hunk \w+\]\n@@ -1 \+1 @@\n a\n b\n\+label\n\+more/)
  expect(prompt).toMatch(/=== src\/new\.ts ===[\s\S]*\+export const n = 1/)
  expect(prompt).toMatch(/=== src\/old\.ts ===[\s\S]* old, edited by hand\n\+and by sed/)
  expect(prompt).not.toMatch(/-old\n/)
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  // Each once: what git names and what the edit tools name are one path, on Windows too.
  const labels = async () => Promise.all([0, 1, 2, 3, 4].map(async i => (await pane.find({ key: `file-${i}` }))?.props.label))
  expect(await labels()).toEqual(['src/app.ts', 'src/new.ts', 'src/old.ts', 'src/words.ts', undefined])
  await pane.select({ key: 'mode', value: 'session' })
  expect(await labels()).toEqual(['src/app.ts', 'src/new.ts', 'src/old.ts', 'src/words.ts', undefined])
  await pane.unmount()
})

test('a turn with no shell command reads no git status', async ($, on) => {
  const { disk, turn, runs } = await project($, on, { 'src/app.ts': APP })
  disk.set('/proj/src/other.ts', 'changed outside the session\n')
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(runs.some(argv => argv.includes('status'))).toBe(false)
  expect(await bandText($)).toMatch(/^✎ 1 file \+3 −1/)
})

test('every git command the mod runs prints a path past ASCII as it is', async ($, on) => {
  const { turn, shellTurn, review, runs } = await project($, on, { 'src/app.ts': APP })
  await shellTurn('dark mode', [d => d.set('/proj/src/café.ts', 'export const c = 1\n')], { 'src/app.ts': DARK })
  await turn('and a font', { 'src/app.ts': DARK.replace('12', '14') })
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.select({ key: 'mode', value: 'uncommitted' })
  await pane.unmount()
  const git = runs.filter(argv => argv[0] === 'git')
  expect(new Set(git.map(argv => argv.find(a => ['rev-parse', 'status', 'show', 'diff', 'ls-files'].includes(a))))).toEqual(new Set(['rev-parse', 'status', 'show', 'diff', 'ls-files']))
  for (const argv of git) expect(argv.slice(0, 3)).toEqual(['git', '-c', 'core.quotePath=false'])
})

test('after a /clear the language is read again from the store, with no classic hook', async ($, on) => {
  const { store, turn } = await project($, on, { 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(await bandText($)).toMatch(/^✎ 1 file/)
  // Another session switched it meanwhile.
  store.set('lang', 'ru')
  await $.session.end({ reason: 'clear', sessionId: 'one', resume: { id: 'one' } })
  expect(await bandText($)).toMatch(/^✎ 1 файл/)
})

test('a review that fails turns the row red, says why on Findings, and r runs it again', async ($, on) => {
  const { turn, setReviewed } = await project($, on, { 'src/app.ts': APP })
  setReviewed('I could not finish the review.')
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · review failed · 1 piece not looked at')
  const band = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND })
  // Red, the part and the mark before the files both.
  const row = JSON.stringify(await band.find({ key: 'row-review' }))
  expect(row).toMatch(/"color":"error"\},"children":\["review failed"\]/)
  expect(row).toMatch(/"color":"error"\},"children":\["✎ "\]/)
  // Pressed, the row opens on Findings, where the failure is said and offered again.
  await band.press({ key: 'row-review' })
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'tab-findings' })).toMatchObject({ props: { variant: 'primary' } })
  expect(await pane.find({ type: 'Text', text: /^✗ The model gave no answer: the reply was not JSON\. Press r to review it again\.$/ })).toBeDefined()
  // Another call clearing the pane's error leaves the row as it was.
  await pane.press({ key: 'tab-walkthrough' })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · review failed · 1 piece not looked at')
  setReviewed(REVIEWED)
  await pane.press({ key: 'tab-findings' })
  await pane.press({ key: 'check' })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · 1 likely bug · 1 finding · 1 piece not looked at')
  await pane.unmount()
})

test('a review a reload cut short leaves the turn not reviewed, yellow, until one is made', async ($, on) => {
  const { turn, setDelay, clock } = await project($, on, { 'src/app.ts': APP })
  setDelay(1000)
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · reviewing… · 1 piece not looked at')
  // A reload: the module that ran the review is gone, and the session starts it again.
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · not reviewed · 1 piece not looked at')
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ type: 'Text', text: /^Not reviewed: the review stopped before it finished\. Press r to run it\.$/ })).toMatchObject({ props: { color: 'warning' } })
  await pane.unmount()
  await clock.advance(5000)
  expect(await bandText($)).toBe('✎ 1 file +3 −1 · 1 likely bug · 1 finding · 1 piece not looked at')
})

test('after a /clear, what a check found in the conversation before is not told in the new one', async ($, on) => {
  const { native, settle, setViolations, toasts } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  await $.turn.start({ text: 'add dark mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED })
  await $.session.end({ reason: 'clear', sessionId: 'one', resume: { id: 'one' } })
  await settle()
  await $.turn.start({ text: 'a bigger font', turnId: 't2' })
  const ran = await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED.replace('12', '14') })
  expect(ran.context ?? []).toEqual([])
  expect(toasts.filter(t => /rule|правил/i.test(t))).toEqual([])
})

// The check of each edit, as it is made: a comment where the rules forbid one.
const COMMENT = JSON.stringify({ violations: [{ rule: 'No comments in code', evidence: '// dark by default', fix: 'Remove the comment above the theme.' }] })
const COMMENTED = DARK.replace('export const theme = "dark"\n', '// dark by default\nexport const theme = "dark"\n')
const DONE = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: { ...USAGE, model: 'test' } } as const

test('each edit is checked against the rules beside the turn, and Claude told what it broke with the next tool result', async ($, on) => {
  const { checked, native, settle, setViolations, toasts } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  await $.turn.start({ text: 'add dark mode', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED })
  // The edit is not held for the check.
  expect(ran.context ?? []).toEqual([])
  expect(checked).toHaveLength(0)
  await settle()
  expect(checked).toHaveLength(1)
  expect(checked[0]!.model).toBe('haiku')
  // The same rules as the review's, nearest first, cached.
  expect(checked[0]!.promptBlocks?.[0]).toMatchObject({ cache: true })
  expect(checked[0]!.promptBlocks?.[0]?.text).toMatch(/^=== src\/CLAUDE\.md ===\n# Source[\s\S]*=== CLAUDE\.md ===\n# Project/)
  expect(toasts).toEqual(['CLAUDE.md: 1 rule broken in app.ts'])
  const next = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(next.context?.join('\n')).toMatch(
    /^agent-lens: your edit to .*app\.ts breaks the project's CLAUDE\.md rules\.\n- No comments in code\n {2}found: \/\/ dark by default\n {2}fix: Remove the comment above the theme\.\nFix this before moving on\.$/,
  )
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
})

test('a rule caught and still in the code once the turn ends is a finding the review does not repeat; gone, it is fixed', async ($, on) => {
  const { asked, turn, review, setViolations, submitted } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  await turn('add dark mode', { 'src/app.ts': COMMENTED })
  // Never read with a tool result: the turn's end sends it back, once.
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^agent-lens: your edit to .*app\.ts breaks/)
  expect(asked[0]!.promptBlocks?.[2]?.text).toMatch(/do not report them again:\n- src\/app\.ts:1: No comments in code$/)
  expect(await bandText($)).toBe('✎ 1 file +4 −1 · 1 likely bug · 2 findings · 1 piece not looked at')
  await review()
  const pane = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-findings' })
  expect(await pane.find({ type: 'Text', text: /^Caught while Claude edited:$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Remove the comment above the theme\.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^found: \/\/ dark by default$/ })).toBeDefined()
  expect(await pane.find({ key: 'fix-all' })).toMatchObject({ props: { label: 'fix all (3)' } })

  setViolations('{"violations":[]}')
  await turn('drop the comment', { 'src/app.ts': DARK })
  expect(await pane.find({ type: 'Text', text: /^fixed$/ })).toBeDefined()
  expect(await bandText($)).toBe('✎ 1 file +0 −1 · not reviewed: small change · 1 likely bug · 1 finding · 1 piece not looked at')
  await pane.unmount()
})

test('where classic hooks run, the turn is kept going to fix what was caught, and no prompt is sent', async ($, on) => {
  const { native, settle, setViolations, submitted } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  await $.turn.start({ text: 'add dark mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED })
  await settle()
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED })
  await settle()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('Remove the comment above the theme.')
  await $.turn.complete(DONE)
  expect(submitted).toEqual([])
})

test("a subagent's unread note goes to the main loop when it ends", async ($, on) => {
  const { native, settle, setViolations } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  await $.turn.start({ text: 'add dark mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED, ...{ agentId: 'a1' } })
  await settle()
  await $.turn.complete({ ...DONE, agentId: 'a1' })
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.join('\n')).toMatch(/^A subagent left this unfixed:\nagent-lens: your edit/)
})

test('block refuses an edit that breaks a rule before it lands', { options: { live: 'block' } }, async ($, on) => {
  const { disk, native, setViolations, toasts } = await project($, on, { ...RULES, 'src/app.ts': APP })
  setViolations(COMMENT)
  const ran = await $.tool.call({ tool: 'Write', file_path: native('/proj/src/app.ts'), content: COMMENTED })
  expect(ran.deny).toMatch(/^agent-lens refused this edit to .*app\.ts[\s\S]*Redo the edit following these rules\.$/)
  expect(disk.get('/proj/src/app.ts')).toBe(APP)
  expect(toasts).toEqual(['CLAUDE.md: 1 rule broken in app.ts'])
})

test('off leaves the rules to the review after the turn', { options: { live: 'off' } }, async ($, on) => {
  const { asked, checked, turn } = await project($, on, { ...RULES, 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': COMMENTED })
  expect(checked).toHaveLength(0)
  expect(asked.some(a => /Review the diff above/.test(a.prompt))).toBe(true)
})

test('an edit where no rule applies, or to a rule file, is not checked; an AGENTS.md is a rule file', async ($, on) => {
  const { checked, turn } = await project($, on, { 'src/app.ts': APP })
  await turn('add dark mode', { 'src/app.ts': DARK })
  expect(checked).toHaveLength(0)
  await turn('a rule for the agents', { 'AGENTS.md': 'No comments in code.\n' })
  expect(checked).toHaveLength(0)
  await turn('say why', { 'src/app.ts': COMMENTED })
  expect(checked).toHaveLength(1)
  expect(checked[0]!.promptBlocks?.[0]?.text).toMatch(/^=== AGENTS\.md ===\nNo comments in code\./)
})

test('/changes rules says how each edit is checked and which rule files apply here', async ($, on) => {
  const { review } = await project($, on, { ...RULES, 'src/app.ts': APP })
  expect((await review('rules')).text).toMatch(/^Rules while Claude edits: Claude is told what an edit breaks, checked by haiku\.\n\nThe rules here come from:\n {2}\S*CLAUDE\.md$/)
})
