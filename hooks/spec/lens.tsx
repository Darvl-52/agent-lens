import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, MatchedHook, PluginOptions, TurnCompleteReason } from 'claude-code'

import type { Brief, Busy, Critic, CriticMode, Deciding, Failed, Hole, Lens, Overlap, Tab, Task, Verdict, TestCase } from '../../types/spec'
import type { AbovePromptEvent, PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { sentWithSkill, specSkill } from '../router/catalog'
import {
  annotateRequirements,
  blocksArchive,
  capabilityOf,
  changesText,
  criticPrint,
  deltasOf,
  fingerprintOf,
  hasCase,
  lf,
  parseAdvice,
  parseCovers,
  parseIssues,
  parseHoles,
  parseOptions,
  parseRequirements,
  parseTaskList,
  parseTestCases,
  parseTasks,
  parseTests,
  requirementNames,
  specText,
  splitBrief,
  taskKey,
} from './spec'
import type { Files } from './spec'
import { WORDS } from './words'
import type { Words } from './words'

// The change in view and what was read of it; null where the project has no OpenSpec change.
const lensAtom = atom({ plugin: 'agent-lens', key: 'spec.lens' } as const, null)
// The brief of the change in view, in the language in force, as kept in the store.
const briefAtom = atom({ plugin: 'agent-lens', key: 'spec.brief' } as const, null)
const explainAtom = atom({ plugin: 'agent-lens', key: 'spec.explain' } as const, null)
const answerAtom = atom({ plugin: 'agent-lens', key: 'spec.answer' } as const, null)
const decidingAtom = atom({ plugin: 'agent-lens', key: 'spec.deciding' } as const, null)
const refreshingAtom = atom({ plugin: 'agent-lens', key: 'spec.refreshing' } as const, null)
const sentTasksAtom = atom({ plugin: 'agent-lens', key: 'spec.sentTasks' } as const, [] as string[])
const sentCasesAtom = atom({ plugin: 'agent-lens', key: 'spec.sentCases' } as const, [] as string[])
const pickedCasesAtom = atom({ plugin: 'agent-lens', key: 'spec.pickedCases' } as const, [] as string[])
const checkedAtom = atom({ plugin: 'agent-lens', key: 'spec.checked' } as const, null)
const archiveAtom = atom({ plugin: 'agent-lens', key: 'spec.archive' } as const, null)
const busyAtom = atom({ plugin: 'agent-lens', key: 'spec.busy' } as const, null)
const queuedAtom = atom({ plugin: 'agent-lens', key: 'spec.queued' } as const, [] as Busy[])
const errorAtom = atom({ plugin: 'agent-lens', key: 'spec.error' } as const, null)
const failedAtom = atom({ plugin: 'agent-lens', key: 'spec.failed' } as const, null)
const tabAtom = atom({ plugin: 'agent-lens', key: 'spec.tab' } as const, 'brief')
const criticAtom = atom({ plugin: 'agent-lens', key: 'spec.critic' } as const, {} as Record<string, Critic>)
const criticModeAtom = atom({ plugin: 'agent-lens', key: 'spec.criticMode' } as const, null)

export const PANE = 'agent-lens-spec'
const TABS: readonly Tab[] = ['brief', 'changes', 'decide', 'tasks', 'tests', 'spec', 'ask']
// A brief and an answer want reading, not speed: the session's mid-sized model.
const MODEL = 'sonnet'
const TIMEOUT_MS = 180_000
// The most decided points of a change the next brief is told of.
const DECIDED_KEPT = 40
// The critic agent: how many times in a row what it finds goes to Claude to close, and how long one
// that never answered is taken as still reading (a session that ended took it with it).
const CRITIC_ROUNDS = 3
const CRITIC_STALE_MS = 20 * 60_000

// Store keys, per project folder and change: the change picked in the pane, the text read last
// time (what changes are counted from), and the brief in each language.
const pickedKey = (root: string) => `picked:${keyOf(root)}`
const seenKey = (root: string, change: string) => `seen:${keyOf(root)}:${change}`
const briefKey = (root: string, lang: string, change: string) => `brief:${lang}:${keyOf(root)}:${change}`
// The points of a change sent to Claude decided, or for it to decide, the latest last.
const decidedKey = (root: string, change: string) => `decided:${keyOf(root)}:${change}`
// The critic agent's last look at a change, and the mode /spec critic set, for every project.
const criticKey = (root: string, change: string) => `critic:${keyOf(root)}:${change}`
const CRITIC_MODE_KEY = 'critic-mode'

// The files of the change in view as last read: what the model is sent. Kept out of state, as
// they can run to a few hundred kilobytes.
let files: Files = {}
// The scan running, and whether something asked for one meanwhile: it then reads again before it
// resolves, so whoever waits on it gets what is on disk now.
let scanning: Promise<void> | undefined
let isScanStale = false
// Whether a scan asked for meanwhile wants the test files read again, not only the change's.
let isTestsStale = false
// What the scans read that rarely changes between them: the test files the cases name, kept from
// one full scan to the next (an edit to the spec does not touch them), and the last deltas, by the
// version read and the version on disk.
const testTexts = new Map<string, string | null>()
let deltasHeld: { key: string; deltas: Lens['deltas'] } | undefined
// The change and fingerprint `openspec validate` is running on, so a scan does not start it twice.
let checking = ''
// The pane's model calls run one at a time, so a question asked during the brief reads the change
// from its cache: each waits its turn, and one asked again while it waits is the same call.
let queue: Promise<void> = Promise.resolve()
const waiting = new Map<string, Promise<void>>()
let jobs = 0
// The brief being made and the version it reads: asked for that version again, it is the same call.
let briefing: { fingerprint: string; done: Promise<void> } | undefined

// The critic's mode as /config sets it; /spec critic overrides it.
let criticDefault: CriticMode = 'off'
// Whether the main loop is in a turn: holes found meanwhile wait for its end to go to Claude, for
// the change named here.
let isMainTurn = false
let holesWaiting: string | undefined
// The critic agents this mod started, by id, as long as it runs.
const critics = new Set<string>()
// A critic being started: its record is written once the spawn resolves, and a press or a turn's
// end meanwhile would start another for the same text. A press meanwhile is kept for after it, as
// the start under way may be a turn's end that started none.
let critiquing = false
let isAskedAgain = false
// What the pane's buttons sent and is on its way, by button: until the prompt is in the queue the
// button is still there, so a press again is told so and sends nothing.
const pressing = new Set<string>()

async function pressOnce($: EngineInterface, key: string, fn: () => Promise<unknown>) {
  if (pressing.has(key)) {
    const w = await wordsIn($)
    await $.ui.toast(key === 'critic' ? w.criticStarting : w.sentAlready)
    return
  }
  pressing.add(key)
  try {
    await fn()
  } finally {
    pressing.delete(key)
  }
}

const criticModeOf = (value: unknown): CriticMode | undefined => (value === 'off' || value === 'button' || value === 'auto' ? value : undefined)

export function configureSpec(options: PluginOptions) {
  criticDefault = criticModeOf(options.specCritic) ?? 'off'
}

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

const timeOf = (at: number, lang: string) => {
  try {
    return new Date(at).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
}

// A path under `dir`, joined with the separator `dir` itself uses (`C:\proj` on Windows, `/proj`
// elsewhere); a part may hold `/` (`web/page`), and a root (`C:\`, `/`) stays one.
const join = (dir: string, ...parts: string[]) =>
  [dir.replace(/[\\/]+$/, ''), ...parts.flatMap(p => p.split(/[\\/]/))].join(dir.includes('\\') ? '\\' : '/')

// A Windows path (a drive letter or a `\`) names the same folder in any case: keyed and compared
// lower-cased there, as given elsewhere.
const isWindowsPath = (path: string) => /^[A-Za-z]:|\\/.test(path)
const keyOf = (path: string) => (isWindowsPath(path) ? path.toLowerCase() : path)

// Every Markdown file under `dir`, by its path inside it, line ends as LF. A folder or file gone
// while it is read is left out, not the whole read.
async function readTree($: EngineInterface, dir: string, prefix = ''): Promise<Files> {
  const out: Files = {}
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind === 'dir') Object.assign(out, await readTree($, join(dir, entry.name), `${prefix}${entry.name}/`))
    else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      const text = (await $.fs.read(join(dir, entry.name)).catch(() => undefined)) as string | undefined
      if (text !== undefined) out[`${prefix}${entry.name}`] = lf(text)
    }
  }
  return out
}

// The capabilities whose delta specs sit under `dir`, by their path below it.
async function capabilitiesIn($: EngineInterface, dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind === 'dir') out.push(...(await capabilitiesIn($, join(dir, entry.name), `${prefix}${entry.name}/`)))
    else if (entry.name === 'spec.md' && prefix !== '') out.push(prefix.slice(0, -1))
  }
  return out
}

// The other active changes whose specs touch a capability this one does, and the requirements
// both name there: the ones that will collide on archiving.
async function overlapsOf($: EngineInterface, dir: string, current: string, changes: readonly string[], mine: Lens['requirements']) {
  const capabilities = new Set(mine.map(r => r.capability))
  const out: Overlap[] = []
  for (const other of changes) {
    if (other === current) continue
    for (const capability of await capabilitiesIn($, join(dir, other, 'specs'))) {
      if (!capabilities.has(capability)) continue
      const theirs = parseRequirements(capability, ((await $.fs.read(join(dir, other, 'specs', capability, 'spec.md')).catch(() => '')) as string) ?? '')
      const names = new Set(theirs.map(r => r.name))
      const shared = mine.filter(r => r.capability === capability && names.has(r.name)).map(r => r.name)
      out.push({ change: other, capability, shared })
    }
  }
  return out
}

// `openspec validate --strict` on the change in view, once per version of it; where the CLI does
// not run, the result says so and nothing is held up by it.
async function check($: EngineInterface, lens: Lens) {
  const at = `${lens.root}:${lens.current}:${lens.fingerprint}`
  const checked = await read($, checkedAtom)
  if (checking === at || (checked?.change === lens.current && checked.fingerprint === lens.fingerprint)) return
  checking = at
  try {
    const args = ['validate', lens.current, '--strict', '--json', '--no-interactive']
    const init = { cwd: await $.session.root(), timeoutMs: 30_000 }
    // npm installs the CLI on Windows as `openspec.cmd`, which a command run with no shell does not
    // find by its bare name: tried by that name where the bare one did not start. A run cut short
    // (a /clear's end of the session under it) says nothing of the CLI: the next scan runs it again.
    const run = (cli: string) => $.process.run([cli, ...args], init)
    const r = await run('openspec')
      .catch((err: unknown) => (/time|abort/i.test(String(err)) ? Promise.reject(err) : run('openspec.cmd')))
      .catch((err: unknown) => (/abort/i.test(String(err)) ? null : /time/i.test(String(err)) ? ('timeout' as const) : undefined))
    if (r === null) return
    // A run past its time says nothing of whether the CLI is there: said so, not as missing.
    if (r === 'timeout') {
      await update($, checkedAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint, issues: null, isTimedOut: true as const }))
      return
    }
    const issues = (r && parseIssues(r.stdout)) ?? null
    await update($, checkedAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint, issues }))
  } finally {
    if (checking === at) checking = ''
  }
}

// Reads the project's OpenSpec changes from disk: the active ones, latest edited first, the one
// in view (the one picked, else the latest) and its files. `isEdit`: an edit to the change asked
// for it, and the test files are taken as last read.
function scan($: EngineInterface, isEdit = false): Promise<void> {
  if (!isEdit) isTestsStale = true
  if (scanning) {
    isScanStale = true
    return scanning
  }
  scanning = (async () => {
    do {
      isScanStale = false
      const isFresh = isTestsStale
      isTestsStale = false
      await scanOnce($, isFresh)
    } while (isScanStale)
  })().finally(() => {
    scanning = undefined
  })
  return scanning
}

async function scanOnce($: EngineInterface, isTestsFresh: boolean) {
  if (isTestsFresh) testTexts.clear()
  const root = join(await $.session.root(), 'openspec')
  const dir = join(root, 'changes')
  const active: { name: string; at: number }[] = []
  if (await $.fs.exists(dir).catch(() => false))
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      if (entry.kind !== 'dir' || entry.name === 'archive') continue
      // A change archived or removed while the folder is read is passed over.
      const inside = await $.fs.list(join(dir, entry.name)).catch(() => undefined)
      if (inside === undefined) continue
      active.push({ name: entry.name, at: Math.max(entry.mtimeMs, ...inside.map(f => f.mtimeMs)) })
    }
  if (active.length === 0) {
    files = {}
    await update($, lensAtom, () => null)
    return
  }
  const changes = active.sort((a, b) => b.at - a.at).map(c => c.name)
  const picked = (await $.store.get(pickedKey(root)).catch(() => undefined)) as string | undefined
  const current = picked !== undefined && changes.includes(picked) ? picked : changes[0]!
  files = await readTree($, join(dir, current))
  const seen = (await $.store.get(seenKey(root, current)).catch(() => undefined)) as Files | undefined
  const fingerprint = fingerprintOf(files)
  const deltas = Object.keys(files).flatMap(path => {
    const capability = capabilityOf(path)
    return capability === undefined ? [] : parseRequirements(capability, files[path]!)
  })
  // Each capability's main spec, by its requirements' names; null where `openspec/specs` has none.
  const mains: Record<string, string[] | null> = {}
  for (const capability of new Set(deltas.map(r => r.capability))) {
    const main = join(root, 'specs', capability, 'spec.md')
    mains[capability] = (await $.fs.exists(main).catch(() => false)) ? requirementNames(((await $.fs.read(main).catch(() => '')) as string) ?? '') : null
  }
  const requirements = annotateRequirements(deltas, mains, parseCovers(files['test-cases.md'] ?? ''))
  const lens: Lens = {
    root,
    changes,
    current,
    tasks: parseTasks(files['tasks.md'] ?? ''),
    taskList: parseTaskList(files['tasks.md'] ?? ''),
    tests: parseTests(files['test-cases.md'] ?? ''),
    testCases: await testCasesOf($, files['test-cases.md'] ?? ''),
    requirements,
    newCapabilities: Object.keys(mains).filter(c => mains[c] === null),
    overlaps: await overlapsOf($, dir, current, changes, requirements),
    fingerprint,
    isSeen: seen !== undefined,
    deltas: seen ? deltasHeldOf(seen, fingerprint) : [],
  }
  const lang = await langIn($)
  const brief = (await $.store.get(briefKey(root, lang, current)).catch(() => undefined)) as Brief | undefined
  await update($, lensAtom, () => lens)
  await update($, briefAtom, () => brief ?? null)
  await prunePicks($, lens)
  await forgetArchived($, root, changes)
  void check($, lens).catch(() => {})
}

// What changed since `seen`, by line: worked out once per pair of versions, as a scan on each edit
// would otherwise diff every file again.
function deltasHeldOf(seen: Files, fingerprint: string) {
  const key = `${fingerprintOf(seen)}:${fingerprint}`
  if (deltasHeld?.key !== key) deltasHeld = { key, deltas: deltasOf(seen, files) }
  return deltasHeld.deltas
}

// Each test case and where it stands. Its test is looked for in the file its Automated line names,
// under the project folder or a folder in it (`__front/e2e/…`), each file read once.
async function testCasesOf($: EngineInterface, md: string): Promise<TestCase[]> {
  const cases = parseTestCases(md)
  if (cases.length === 0) return []
  const isMarked = cases.some(c => c.mark !== 'none')
  const project = await $.session.root()
  const folders = (await $.fs.list(project).catch(() => []))
    .filter(f => f.kind === 'dir' && !f.name.startsWith('.') && f.name !== 'node_modules')
    .map(f => f.name)
  const texts = testTexts
  const out: TestCase[] = []
  for (const c of cases) {
    for (const file of c.files ?? []) {
      if (texts.has(file)) continue
      let text: string | null = null
      for (const at of [join(project, file), ...folders.map(d => join(project, d, file))])
        if (await $.fs.exists(at).catch(() => false)) {
          text = ((await $.fs.read(at).catch(() => '')) as string) ?? ''
          break
        }
      texts.set(file, text)
    }
    // Tested where any file its line names holds a test with its id.
    const isTested = (c.files ?? []).some(file => {
      const text = texts.get(file) ?? null
      return text !== null && hasCase(text, c.id)
    })
    const state: TestCase['state'] = c.mark === 'manual' ? 'manual' : c.mark === 'none' && isMarked ? 'unmarked' : isTested ? 'tested' : 'untested'
    out.push({ ...c, state })
  }
  return out
}

// A change archived or deleted leaves its read text and briefs behind: dropped, so the store
// keeps to the active ones.
async function forgetArchived($: EngineInterface, root: string, changes: readonly string[]) {
  const at = keyOf(root)
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    const kept = ['seen', 'decided', 'critic'].find(kind => key.startsWith(`${kind}:${at}:`))
    const change = kept
      ? key.slice(`${kept}:${at}:`.length)
      : /^brief:\w+:/.test(key) && key.includes(`:${at}:`)
        ? key.slice(key.indexOf(`:${at}:`) + at.length + 2)
        : undefined
    if (change !== undefined && !changes.includes(change)) await $.store.delete(key)
  }
}

// Why a call found no answer, in words that say what to do about it.
const whyNot = (w: Words, r: { reason: string; status?: number | null; error?: string }) =>
  r.reason === 'empty-reply'
    ? w.why.empty
    : r.reason === 'aborted'
      ? w.why.aborted
      : r.error === 'rate_limit' || r.error === 'overloaded' || r.error === 'authentication_failed'
        ? w.why[r.error]
        : w.why.api(r.status ?? null)

// An error shown above the tab, with the model call to run again where it was one.
async function fail($: EngineInterface, text: string, failed: Failed | null = null) {
  await update($, errorAtom, () => text)
  await update($, failedAtom, () => failed)
}

async function clearError($: EngineInterface) {
  await update($, errorAtom, () => null)
  await update($, failedAtom, () => null)
}

// A call starting puts away its own last failure, and a refused prompt's, not another call's.
async function clearErrorOf($: EngineInterface, job: Busy) {
  const failed = await read($, failedAtom)
  if (failed === null || failed.what === job) await clearError($)
}

// `fn` runs once the calls before it are done, shown as `job` meanwhile; `key` names the call, so
// one asked for while the same waits is not run twice.
function inTurn($: EngineInterface, job: Busy, key: string, fn: () => Promise<void>): Promise<void> {
  const same = waiting.get(key)
  if (same) return same
  jobs++
  const queued = update($, queuedAtom, q => [...q, job])
  const run = queue.then(async () => {
    waiting.delete(key)
    try {
      await queued
      await update($, queuedAtom, q => {
        const i = q.indexOf(job)
        return i < 0 ? q : [...q.slice(0, i), ...q.slice(i + 1)]
      })
      await update($, busyAtom, () => job)
      await clearErrorOf($, job)
      await fn()
    } finally {
      jobs--
      await update($, busyAtom, () => null)
    }
  })
  waiting.set(key, run)
  queue = run.catch(() => {})
  return run
}

async function retry($: EngineInterface) {
  const failed = await read($, failedAtom)
  await clearError($)
  if (failed?.what === 'brief') await makeBrief($)
  else if (failed?.what === 'explain') await explainChanges($)
  else if (failed?.what === 'options') await makeOptions($)
  else if (failed?.what === 'answer' && failed.question !== undefined) await ask($, failed.question)
}

// The change in view with its files read. After a reload `files` starts empty while the session's
// values still hold the change: it is read again before anything is sent to the model or kept as
// read, so neither is made of nothing.
async function lensNow($: EngineInterface) {
  const lens = await read($, lensAtom)
  if (lens && fingerprintOf(files) !== lens.fingerprint) await scan($)
  return read($, lensAtom)
}

// The brief of the change as it is when its turn comes; asked for while one of that version is being
// made, it is that one.
async function makeBrief($: EngineInterface): Promise<void> {
  const lens = await read($, lensAtom)
  if (lens && briefing?.fingerprint === lens.fingerprint && !waiting.has('brief')) return briefing.done
  const run: Promise<void> = inTurn($, 'brief', 'brief', async () => {
    const now = await lensNow($)
    if (!now) return
    briefing = { fingerprint: now.fingerprint, done: run }
    try {
      await briefOf($, now)
    } finally {
      briefing = undefined
    }
  })
  return run
}

type Decided = { point: string; answer: string }

async function decidedOf($: EngineInterface, lens: Lens) {
  return ((await $.store.get(decidedKey(lens.root, lens.current)).catch(() => undefined)) as Decided[] | undefined) ?? []
}

// Kept so a brief made again does not ask them again: a point said again goes in place of what it
// said before, and only the latest are kept.
async function keepDecided($: EngineInterface, lens: Lens, items: readonly Decided[]) {
  const points = new Set(items.map(x => x.point))
  const kept = [...(await decidedOf($, lens)).filter(x => !points.has(x.point)), ...items].slice(-DECIDED_KEPT)
  await $.store.set(decidedKey(lens.root, lens.current), kept)
}

async function dropDecided($: EngineInterface, lens: Lens, points: readonly string[]) {
  const kept = (await decidedOf($, lens)).filter(x => !points.includes(x.point))
  await $.store.set(decidedKey(lens.root, lens.current), kept)
}

async function briefOf($: EngineInterface, lens: Lens) {
  // Decisions sent for an older version are in the files the brief is made from now.
  const refreshing = await read($, refreshingAtom)
  if (refreshing?.change === lens.current && refreshing.fingerprint !== lens.fingerprint) await update($, refreshingAtom, () => null)
  const w = await wordsIn($)
  const lang = await langIn($)
  const text = specText(lens.current, files)
  const decided = await decidedOf($, lens)
  const r = await $.model.complete({
    model: MODEL,
    system: w.system,
    // The change first and marked, so a question asked soon after reads it from the cache.
    prompt: [{ text, cache: true }, { text: [w.briefPrompt(lens.current), ...(decided.length > 0 ? [w.decidedPrompt(decided)] : [])].join('\n\n') }],
    maxTokens: 3000,
    timeoutMs: TIMEOUT_MS,
  })
  if (!r.isAnswered) {
    await fail($, w.failed(whyNot(w, r)), { what: 'brief' })
    return
  }
  const brief: Brief = { fingerprint: lens.fingerprint, ...splitBrief(r.text, w.decideHeading, w.none), at: await $.clock.now() }
  await $.store.set(briefKey(lens.root, lang, lens.current), brief)
  // The pane may have moved on to another change, or language, while the model read.
  if ((await read($, lensAtom))?.current === lens.current && (await langIn($)) === lang) await update($, briefAtom, () => brief)
}

function explainChanges($: EngineInterface) {
  return inTurn($, 'explain', 'explain', async () => {
    const lens = await lensNow($)
    if (!lens || lens.deltas.length === 0) return
    const seen = (await $.store.get(seenKey(lens.root, lens.current)).catch(() => undefined)) as Files | undefined
    if (!seen) return
    const w = await wordsIn($)
    const r = await $.model.complete({
      model: MODEL,
      system: w.system,
      prompt: `${w.explainPrompt(lens.current)}\n\n${changesText(seen, files)}`,
      maxTokens: 1500,
      timeoutMs: TIMEOUT_MS,
    })
    if (r.isAnswered) await update($, explainAtom, () => r.text)
    else await fail($, w.failed(whyNot(w, r)), { what: 'explain' })
  })
}

// The Decide tab's work on `brief`: what was kept for it, else a fresh start.
async function decidingOf($: EngineInterface, brief: Brief): Promise<Deciding> {
  const deciding = await read($, decidingAtom)
  return deciding?.at === brief.at ? deciding : { at: brief.at, open: null, verdicts: {} }
}

async function changeDeciding($: EngineInterface, fn: (d: Deciding, brief: Brief) => Deciding) {
  const brief = await read($, briefAtom)
  if (!brief) return
  const deciding = fn(await decidingOf($, brief), brief)
  await update($, decidingAtom, () => deciding)
}

// The model's options for every decision at once, asked for when the first one is opened; asked
// again once for a brief kept from before the model said which it recommends.
function makeOptions($: EngineInterface) {
  return inTurn($, 'options', 'options', async () => {
    const lens = await lensNow($)
    const brief = await read($, briefAtom)
    if (lens && brief && (!brief.options || !brief.advice) && brief.decisions.length > 0) await optionsOf($, lens, brief)
  })
}

async function optionsOf($: EngineInterface, lens: Lens, brief: Brief) {
  const w = await wordsIn($)
  const lang = await langIn($)
  const r = await $.model.complete({
    model: MODEL,
    system: w.system,
    prompt: [{ text: specText(lens.current, files), cache: true }, { text: w.optionsPrompt(brief.decisions) }],
    maxTokens: 1500,
    timeoutMs: TIMEOUT_MS,
  })
  if (!r.isAnswered) {
    await fail($, w.failed(whyNot(w, r)), { what: 'options' })
    return
  }
  const withOptions: Brief = { ...brief, options: parseOptions(r.text, brief.decisions.length), advice: parseAdvice(r.text, brief.decisions.length) }
  await $.store.set(briefKey(lens.root, lang, lens.current), withOptions)
  if ((await read($, briefAtom))?.at === brief.at) await update($, briefAtom, () => withOptions)
}

async function toggleDecision($: EngineInterface, index: number) {
  await changeDeciding($, d => ({ ...d, open: d.open === index ? null : index }))
  if ((await read($, decidingAtom))?.open === index) await makeOptions($)
}

// A decision settled: kept until it is sent, and the next one still open is opened.
async function settle($: EngineInterface, index: number, answer: string) {
  const a = answer.trim()
  if (a === '') return
  await changeDeciding($, (d, brief) => {
    const verdicts: Record<string, Verdict> = { ...d.verdicts, [index]: { answer: a, isSent: false } }
    const next = brief.decisions.findIndex((_, i) => i > index && !verdicts[i])
    return { ...d, open: next < 0 ? null : next, verdicts }
  })
}

async function unsettle($: EngineInterface, index: number) {
  await changeDeciding($, d => {
    const { [index]: _dropped, ...verdicts } = d.verdicts
    return { ...d, verdicts }
  })
}

// The decisions settled and not yet sent go to the session as the person's prompt: Claude writes
// them into the change's files, which makes the brief stale, and the next one is made from those.
// Every point not decided yet goes to the session for Claude to decide: it writes each answer
// into the change's files, or asks where it cannot decide alone, and the brief is made again from
// those. The points show as Claude's to decide until then.
async function decideAll($: EngineInterface) {
  const lens = await read($, lensAtom)
  const brief = await read($, briefAtom)
  if (!lens || !brief) return
  const w = await wordsIn($)
  const verdicts = (await decidingOf($, brief)).verdicts
  const open = brief.decisions.flatMap((point, i) => (verdicts[i] ? [] : [{ i, point }]))
  if (open.length === 0) return
  const r = await $.prompt.submit({ text: w.decideAllPrompt(lens.current, join(lens.root, 'changes', lens.current), open.map(x => x.point)), asUser: true })
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  await update($, refreshingAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint }))
  await keepDecided($, lens, open.map(x => ({ point: x.point, answer: w.byClaude })))
  await changeDeciding($, d => ({
    ...d,
    open: null,
    verdicts: { ...d.verdicts, ...Object.fromEntries(open.map(x => [String(x.i), { answer: w.byClaude, isSent: true, isByClaude: true }])) },
  }))
  await $.ui.toast(w.decideAllSent(open.length))
}

// The decisions sent go to Claude again as they were: those settled here to write in, the rest to
// decide.
async function resendDecisions($: EngineInterface) {
  const lens = await read($, lensAtom)
  const brief = await read($, briefAtom)
  if (!lens || !brief) return
  const w = await wordsIn($)
  const verdicts = (await decidingOf($, brief)).verdicts
  const sent = brief.decisions.flatMap((point, i) => (verdicts[i]?.isSent ? [{ point, ...verdicts[i] }] : []))
  if (sent.length === 0) return
  const dir = join(lens.root, 'changes', lens.current)
  const settled = sent.filter(x => !x.isByClaude)
  const left = sent.filter(x => x.isByClaude).map(x => x.point)
  const text = [...(settled.length > 0 ? [w.applyPrompt(lens.current, dir, settled)] : []), ...(left.length > 0 ? [w.decideAllPrompt(lens.current, dir, left)] : [])].join('\n\n')
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  await update($, refreshingAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint }))
  await $.ui.toast(w.resent(sent.length))
}

// The decisions sent come back to the pane: a point left to Claude is open again, an answer settled
// here waits to be written in, and either can be changed.
async function reopenDecisions($: EngineInterface) {
  await update($, refreshingAtom, () => null)
  const lens = await read($, lensAtom)
  const brief = await read($, briefAtom)
  if (lens && brief) {
    const verdicts = (await decidingOf($, brief)).verdicts
    await dropDecided($, lens, brief.decisions.filter((_, i) => verdicts[i]?.isSent))
  }
  await changeDeciding($, d => ({
    ...d,
    verdicts: Object.fromEntries(Object.entries(d.verdicts).flatMap(([i, v]) => (v.isByClaude ? [] : [[i, { ...v, isSent: false }]]))),
  }))
}

async function applyDecisions($: EngineInterface) {
  const lens = await read($, lensAtom)
  const brief = await read($, briefAtom)
  if (!lens || !brief) return
  const w = await wordsIn($)
  const deciding = await decidingOf($, brief)
  const ready = brief.decisions.flatMap((point, i) => {
    const v = deciding.verdicts[i]
    return v && !v.isSent ? [{ i, point, answer: v.answer }] : []
  })
  if (ready.length === 0) return
  const r = await $.prompt.submit({ text: w.applyPrompt(lens.current, join(lens.root, 'changes', lens.current), ready), asUser: true })
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  await update($, refreshingAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint }))
  await keepDecided($, lens, ready.map(x => ({ point: x.point, answer: x.answer })))
  const sent = new Set(ready.map(x => String(x.i)))
  await changeDeciding($, d => ({
    ...d,
    open: null,
    verdicts: Object.fromEntries(Object.entries(d.verdicts).map(([i, v]) => [i, sent.has(i) ? { ...v, isSent: true } : v])),
  }))
  await $.ui.toast(w.applied(ready.length))
}

// A task or an archiving goes to Claude naming OpenSpec's own skill for it, where the router has one.
async function send($: EngineInterface, kind: 'task' | 'archive', text: string) {
  const skill = await specSkill($, kind).catch(() => undefined)
  const w = await wordsIn($)
  const r = await $.prompt.submit({ text: skill ? `${text}\n\n${w.withSkill(skill)}` : text, asUser: true })
  if (skill && r.drop === undefined) await sentWithSkill($, skill, text).catch(() => {})
  return r
}

// One task goes to the session as the person's prompt: Claude does it and ticks it.
async function doTask($: EngineInterface, task: Task) {
  const lens = await read($, lensAtom)
  if (!lens || task.isDone) return
  const w = await wordsIn($)
  const key = taskKey(task)
  const r = await send($, 'task', w.taskPrompt(lens.current, join(lens.root, 'changes', lens.current), key, task.text))
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  await update($, sentTasksAtom, sent => [...new Set([...sent, `${lens.current}:${key}`])])
  await $.ui.toast(w.taskSentToast(key))
}

const caseKey = (lens: Lens, id: string) => `${lens.current}:${id}`

// The scenarios of the change's specs no test case covers, each with an id among the cases': `S:`
// then its capability, requirement and name.
const uncoveredOf = (lens: Lens) =>
  lens.requirements.flatMap(r =>
    (r.uncovered ?? []).map(scenario => ({ id: `S:${r.capability}|${r.name}|${scenario}`, capability: r.capability, requirement: r.name, scenario })),
  )

// What can be picked on the Tests tab: a case with no test yet, a scenario no case covers.
const pickableOf = (lens: Lens) => new Set([...(lens.testCases ?? []).filter(c => c.state !== 'tested').map(c => c.id), ...uncoveredOf(lens).map(s => s.id)])

// A pick whose case got its test, or whose scenario got a case, is no longer one.
async function prunePicks($: EngineInterface, lens: Lens) {
  const pickable = pickableOf(lens)
  const at = `${lens.current}:`
  const isKept = (k: string) => !k.startsWith(at) || pickable.has(k.slice(at.length))
  if ((await read($, pickedCasesAtom)).some(k => !isKept(k))) await update($, pickedCasesAtom, picked => picked.filter(isKept))
}

async function togglePick($: EngineInterface, id: string) {
  const lens = await read($, lensAtom)
  if (!lens) return
  const key = caseKey(lens, id)
  await update($, pickedCasesAtom, picked => (picked.includes(key) ? picked.filter(k => k !== key) : [...picked, key]))
}

// The test cases go to the session as the person's prompt: Claude writes their tests, runs them
// and marks what is unmarked; a scenario no case covers gets a case first, closed the same way.
async function closeCases($: EngineInterface, ids: readonly string[]) {
  const lens = await read($, lensAtom)
  if (!lens) return
  const cases = (lens.testCases ?? []).filter(c => ids.includes(c.id))
  const scenarios = uncoveredOf(lens).filter(s => ids.includes(s.id))
  if (cases.length + scenarios.length === 0) return
  const w = await wordsIn($)
  const file = join(lens.root, 'changes', lens.current, 'test-cases.md')
  const text = [
    ...(cases.length > 0 ? [w.closePrompt(lens.current, file, cases)] : []),
    ...(scenarios.length > 0 ? [w.coverPrompt(lens.current, file, scenarios, cases.length === 0)] : []),
  ].join('\n\n')
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  const keys = [...cases, ...scenarios].map(c => caseKey(lens, c.id))
  await update($, sentCasesAtom, sent => [...new Set([...sent, ...keys])])
  await update($, pickedCasesAtom, picked => picked.filter(k => !keys.includes(k)))
  await $.ui.toast(w.casesSentToast(keys.length))
}

// What stands between the change and its archive, once every task is ticked: errors and refused
// deltas `openspec validate` found, what is left to decide or not yet written in, test cases with
// no mark. `isOffered` false while tasks are left: there is nothing to archive yet.
async function readiness($: EngineInterface, lens: Lens) {
  const w = await wordsIn($)
  const isOffered = lens.tasks.total > 0 && lens.tasks.done === lens.tasks.total
  const blockers: string[] = []
  const checked = await read($, checkedAtom)
  const isChecked = checked?.change === lens.current && checked.fingerprint === lens.fingerprint
  const issues = isChecked ? (checked.issues ?? []) : []
  const errors = issues.filter(i => i.level === 'ERROR').length
  if (!isChecked) blockers.push(w.blockChecking)
  if (errors > 0) blockers.push(w.blockErrors(errors))
  if (issues.some(i => i.level !== 'ERROR' && blocksArchive(i))) blockers.push(w.blockRefused)
  const brief = await read($, briefAtom)
  if (brief && brief.fingerprint === lens.fingerprint && brief.isUnsplit) blockers.push(w.blockDecideUnknown)
  else if (brief && brief.fingerprint === lens.fingerprint) {
    const verdicts = (await decidingOf($, brief)).verdicts
    const undecided = brief.decisions.filter((_, i) => !verdicts[i]).length
    const toApply = Object.values(verdicts).filter(v => !v.isSent).length
    if (undecided > 0) blockers.push(w.blockDecide(undecided))
    if (toApply > 0) blockers.push(w.blockApply(toApply))
  } else blockers.push(w.blockBrief)
  if (lens.tests.unmarked.length > 0) blockers.push(w.blockUnmarked(lens.tests.unmarked))
  const untested = untestedIn(lens)
  if (untested > 0) blockers.push(w.blockUntested(untested))
  const withoutTest = withoutTestIn(lens)
  if (withoutTest > 0) blockers.push(w.blockWithoutTest(withoutTest))
  const mismatches = mismatchesIn(lens)
  if (mismatches > 0) blockers.push(w.blockMismatch(mismatches))
  const archive = await read($, archiveAtom)
  return { isOffered, blockers, isReady: isOffered && blockers.length === 0, archive: archive?.change === lens.current ? archive : null }
}

const untestedIn = (lens: Lens) => lens.requirements.reduce((n, r) => n + (r.uncovered?.length ?? 0), 0)
const withoutTestIn = (lens: Lens) => (lens.testCases ?? []).filter(c => c.state === 'untested').length
const mismatchesIn = (lens: Lens) => lens.requirements.filter(r => r.mismatch).length

async function askArchive($: EngineInterface, isAsked: boolean) {
  const lens = await read($, lensAtom)
  if (lens) await update($, archiveAtom, () => (isAsked ? { change: lens.current, isSent: false } : null))
}

// Archiving goes to Claude as the person's prompt: the project's own way of it, where it has one.
async function archiveChange($: EngineInterface) {
  const lens = await read($, lensAtom)
  if (!lens || !(await readiness($, lens)).isReady) return
  const w = await wordsIn($)
  const r = await send($, 'archive', w.archivePrompt(lens.current, join(lens.root, 'changes', lens.current)))
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  await update($, archiveAtom, () => ({ change: lens.current, isSent: true }))
  await $.ui.toast(w.archiveSent)
}

async function criticMode($: EngineInterface) {
  return (await read($, criticModeAtom)) ?? criticDefault
}

// The critic's last look at `change`: this session's, else the one kept from an earlier session.
async function criticOf($: EngineInterface, root: string, change: string) {
  return (await read($, criticAtom))[change] ?? ((await $.store.get(criticKey(root, change)).catch(() => undefined)) as Critic | undefined)
}

async function keepCritic($: EngineInterface, root: string, critic: Critic) {
  await update($, criticAtom, all => ({ ...all, [critic.change]: critic }))
  await $.store.set(criticKey(root, critic.change), critic)
}

// The critic agent reads the change in view against the code for holes: when asked, or in auto mode
// at a main turn's end once the change's text moved on from what it read last. Rounds whose holes
// went to Claude count up while Claude's turns close them. Auto mode stops at a look that finds no
// blocker, the change ready, or once CRITIC_ROUNDS went, what the last changed left to the person:
// either way only the person asking again starts it over.
async function critique($: EngineInterface, isAsked: boolean) {
  if (critiquing) {
    isAskedAgain ||= isAsked
    return
  }
  critiquing = true
  try {
    await startCritic($, isAsked)
    while (isAskedAgain) {
      isAskedAgain = false
      await startCritic($, true)
    }
  } finally {
    critiquing = false
  }
}

async function startCritic($: EngineInterface, isAsked: boolean) {
  const lens = await lensNow($)
  if (!lens) return
  const mode = await criticMode($)
  if (mode === 'off' || (!isAsked && mode !== 'auto')) return
  const was = await criticOf($, lens.root, lens.current)
  const at = await $.clock.now()
  if (was?.status === 'running' && at - was.at < CRITIC_STALE_MS) return
  const fingerprint = criticPrint(files)
  if (!isAsked && (was?.fingerprint === fingerprint || (was && (isReady(was) || was.isCapped)))) return
  if (!isAsked && was && was.round >= CRITIC_ROUNDS) {
    await keepCritic($, lens.root, { ...was, fingerprint, isCapped: true })
    return
  }
  const round = isAsked ? 0 : (was?.round ?? 0)
  const w = await wordsIn($)
  const dir = join(lens.root, 'changes', lens.current)
  const task = w.criticTask(lens.current)
  const spawned = await $.agent.spawn({ prompt: w.criticPrompt(lens.current, dir, await decidedOf($, lens)), description: task, subagentType: 'Explore', model: MODEL }).catch(() => undefined)
  // A spawn a hook answered carries no id: the agent is found in the list, as this mod's run of the task.
  const agentId =
    spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === task)?.id : undefined)
  if (agentId) critics.add(agentId)
  // What the rounds before sent stays in view while they go on.
  const sent = isAsked ? [] : (was?.sent ?? [])
  await keepCritic($, lens.root, { change: lens.current, fingerprint, at, holes: [], round, status: agentId ? 'running' : 'failed', ...(agentId ? { agentId } : {}), ...(sent.length > 0 ? { sent } : {}) })
}

// What the critic agent answered, once its run ends: its holes, sent to Claude to close in auto mode.
async function heardCritic($: EngineInterface, agentId: string, answer: string) {
  const lens = await read($, lensAtom)
  const critic = Object.values(await read($, criticAtom)).find(c => c.status === 'running' && c.agentId === agentId)
  if (!lens || !critic) return
  const holes = parseHoles(answer)
  // Its id stays: the engine hands its report back after this end, and it is known by the id.
  await keepCritic($, lens.root, { ...critic, status: holes ? 'done' : 'failed', holes: holes ?? [] })
  if (holes?.some(hole => !hole.isMinor) && (await criticMode($)) === 'auto') await closeHoles($, critic.change, false)
}

// A look that found nothing that blocks the work: the change is ready to be built.
const isReady = (critic: Critic) => critic.status === 'done' && !critic.holes.some(hole => !hole.isMinor)

// The holes of the last look still to go to Claude: the blockers, and the details the code can settle.
const holesLeft = (critic: Critic | undefined) => {
  const left = critic?.status === 'done' ? critic.holes.filter(hole => !hole.isSent) : []
  return { blockers: left.filter(hole => !hole.isMinor), minors: left.filter(hole => hole.isMinor) }
}

// The holes found go to the session as the person's prompt: Claude closes, asks about or declines
// each in the change's files. Kept as decided, so neither the brief nor the critic raises them again.
// In auto mode the blockers alone go; the person's h sends the details as well. While the main loop
// is in a turn they wait for its end.
async function closeHoles($: EngineInterface, change: string, isAll: boolean) {
  if (isMainTurn) {
    holesWaiting = change
    return
  }
  const lens = await read($, lensAtom)
  const critic = (await read($, criticAtom))[change]
  const { blockers, minors } = holesLeft(critic)
  const holes = isAll ? [...blockers, ...minors] : blockers
  if (!lens || !critic || holes.length === 0) return
  const w = await wordsIn($)
  // Kept sent before the prompt goes: it waits in the queue while a turn runs, and a critic that
  // turn's end starts reads the round from this, not has its own record written over after.
  const round = critic.round + 1
  const going = new Set(holes)
  const marked = critic.holes.map(hole => (going.has(hole) ? { ...hole, isSent: true as const } : hole))
  await keepCritic($, lens.root, { ...critic, holes: marked, round, isSent: true, sent: [...(critic.sent ?? []), { round, holes }] })
  const r = await $.prompt.submit({ text: w.closeHolesPrompt(change, join(lens.root, 'changes', change), holes), asUser: true })
  if (r.drop !== undefined) {
    // Taken back, unless a critic started since.
    const now = (await read($, criticAtom))[change]
    if (now?.isSent && now.round === round) await keepCritic($, lens.root, critic)
    await fail($, w.notSent(r.drop))
    return
  }
  await keepDecided($, { ...lens, current: change }, holes.map(hole => ({ point: `${hole.text} (${hole.where})`, answer: hole.fix })))
  await $.ui.toast(w.holesToast(holes.length))
}

// After a turn the row follows what agents ticked and rewrote; a spec that moved on from the
// decisions sent gets its brief made again, so the Decide tab shows what is left. One still where
// it was says so, and the decisions can be sent again or changed. Only a turn the model answered
// sends the holes waiting or starts a critic: one the person stopped, or an error ended, leaves the
// holes waiting for the next.
async function afterTurn($: EngineInterface, isAnswered: boolean) {
  await scan($)
  if (isAnswered) {
    const waiting = holesWaiting
    holesWaiting = undefined
    if (waiting !== undefined) await closeHoles($, waiting, false)
    else await critique($, false)
  }
  const lens = await read($, lensAtom)
  const refreshing = await read($, refreshingAtom)
  if (!lens || !refreshing || refreshing.change !== lens.current) return
  if (refreshing.fingerprint === lens.fingerprint) await update($, refreshingAtom, r => (r === null ? r : { ...r, isUnchanged: true }))
  else await makeBrief($)
}

// The change in view as the review reads it beside a diff: its name, the tasks not ticked yet,
// and what its specs require, each requirement with its scenarios.
export async function specInView($: EngineInterface) {
  const lens = await read($, lensAtom)
  if (!lens) return undefined
  return {
    change: lens.current,
    tasks: lens.taskList.filter(t => !t.isDone).map(t => (t.id ? `${t.id} ${t.text}` : t.text)),
    requirements: lens.requirements.map(r => ({ name: `${r.capability}: ${r.name}`, op: r.op, scenarios: r.scenarios })),
  }
}

// What is on disk now becomes what later changes are counted from.
async function markRead($: EngineInterface) {
  const lens = await lensNow($)
  if (!lens) return
  await $.store.set(seenKey(lens.root, lens.current), files)
  await update($, explainAtom, () => null)
  await update($, lensAtom, () => ({ ...lens, isSeen: true, deltas: [] }))
}

async function ask($: EngineInterface, question: string) {
  const q = question.trim()
  if (q === '') return
  await inTurn($, 'answer', `answer:${q}`, async () => {
    const lens = await lensNow($)
    if (!lens) return
    const w = await wordsIn($)
    await update($, answerAtom, () => null)
    const r = await $.model.complete({
      model: MODEL,
      system: w.system,
      prompt: [{ text: specText(lens.current, files), cache: true }, { text: w.askPrompt(q) }],
      maxTokens: 1500,
      timeoutMs: TIMEOUT_MS,
    })
    if (r.isAnswered) await update($, answerAtom, () => ({ question: q, text: r.text }))
    else await fail($, w.failed(whyNot(w, r)), { what: 'answer', question: q })
  })
}

// Opens the pane on the change in view. A change opened here for the first time is taken as read
// from now on; a brief missing or older than the change is made, which is what opening asks for.
export async function openPane($: EngineInterface, tab?: Tab) {
  await scan($)
  const lens = await read($, lensAtom)
  if (!lens) return false
  if (tab) await update($, tabAtom, () => tab)
  if (!lens.isSeen) await markRead($)
  await $.ui.open({ id: PANE, title: (await wordsIn($)).title(lens.current), focus: true, closeOnEscape: true })
  if ((await read($, briefAtom))?.fingerprint !== lens.fingerprint) void makeBrief($).catch(() => {})
  return true
}

async function pickChange($: EngineInterface, change: string) {
  const lens = await read($, lensAtom)
  if (!lens || change === lens.current) return
  await $.store.set(pickedKey(lens.root), change)
  await update($, explainAtom, () => null)
  await update($, answerAtom, () => null)
  await clearError($)
  await openPane($)
}

// An edit to the change is read beside the turn: the tool call does not wait on the scan.
function afterEdit($: EngineInterface, path: string) {
  if (new RegExp(String.raw`[\\/]openspec[\\/]changes[\\/]`, isWindowsPath(path) ? 'i' : '').test(path)) void scan($, true).catch(() => {})
}

// The colour of what is said: red is broken, yellow wants a look, green is done.
type Tone = 'error' | 'warning' | 'success'
const SEP = ' · '
// Cells of the Tasks tab's progress bar.
const BAR = 10

// What the row and the pane say of the change in view, and its colour as a whole: red while a test
// case says neither how it is automated nor why it is manual or the spec has errors; yellow while
// something is left to decide or the spec changed since it was read; green otherwise.
async function statusOf($: EngineInterface, lens: Lens) {
  const brief = await read($, briefAtom)
  const isFresh = brief !== null && brief.fingerprint === lens.fingerprint
  const verdicts = isFresh ? Object.values((await decidingOf($, brief)).verdicts) : []
  const decisions = isFresh ? brief.decisions.length - verdicts.length : 0
  const toApply = verdicts.filter(v => !v.isSent).length
  const checked = await read($, checkedAtom)
  const issues = checked?.change === lens.current && checked.fingerprint === lens.fingerprint ? (checked.issues ?? []) : []
  const errors = issues.filter(i => i.level === 'ERROR').length
  const warnings = issues.filter(i => i.level === 'WARNING').length
  const overlapping = [...new Set(lens.overlaps.map(o => o.change))]
  const untested = untestedIn(lens)
  const withoutTest = withoutTestIn(lens)
  const mismatches = mismatchesIn(lens)
  const isDecideUnknown = isFresh && brief.isUnsplit === true
  const ready = await readiness($, lens)
  const tone: Tone =
    lens.tests.unmarked.length > 0 || errors > 0
      ? 'error'
      : decisions > 0 || toApply > 0 || warnings > 0 || untested > 0 || withoutTest > 0 || mismatches > 0 || isDecideUnknown || overlapping.length > 0 || lens.deltas.length > 0
        ? 'warning'
        : 'success'
  return { decisions, toApply, errors, warnings, overlapping, untested, withoutTest, mismatches, isDecideUnknown, isReady: ready.isReady && !ready.archive?.isSent, tone }
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({ name: 'spec', description: (await wordsIn($)).description, argumentHint: '[<change> | critic off|button|auto | lang en|ru]' })
}

// What the model said in another language is not this one's: the explanation and the answer go,
// the brief of the change is read in the new one.
export async function forgetSaid($: EngineInterface) {
  await update($, explainAtom, () => null)
  await update($, answerAtom, () => null)
  await scan($)
}

export async function startSpec($: EngineInterface, isInteractive: boolean) {
  // A reload drops the calls the old code was making, while the session's values still show them.
  if (jobs === 0) {
    await update($, busyAtom, () => null)
    await update($, queuedAtom, () => [])
  }
  await registerCommand($)
  await restoreCriticMode($)
  if (isInteractive) await scan($).catch(() => {})
}

async function restoreCriticMode($: EngineInterface) {
  const mode = criticModeOf(await $.store.get(CRITIC_MODE_KEY).catch(() => undefined))
  await update($, criticModeAtom, () => mode ?? null)
}

// A /clear or /resume empties the session's values: the change in view is read again, so the row
// is back before the first prompt.
export async function rescanSpec($: EngineInterface) {
  await restoreCriticMode($)
  await scan($).catch(() => {})
}

// Agents tick tasks and rewrite the spec as they go: the row follows them.
export function startSpecTurn() {
  isMainTurn = true
}

export function endSpecTurn($: EngineInterface, reason: TurnCompleteReason) {
  isMainTurn = false
  void afterTurn($, reason === 'answer').catch(() => {})
}

// What a critic hands back to the main conversation as its run ends: the Decide tab holds it, and
// the holes go to Claude by the mod's own prompt, in auto mode or on h; read by Claude as well, they
// would be closed twice and the button would hold nothing back. By the agent's id in the text: the
// ids this module started, those the engine lists as this mod's, and each change's last critic.
// What the person is told it went to, or undefined for any other text.
export async function criticReport($: EngineInterface, text: string) {
  const listed = (await $.agent.list().catch(() => [])).filter(a => a.spawnedBy === 'agent-lens').map(a => a.id)
  const kept = Object.values(await read($, criticAtom)).flatMap(c => (c.agentId ? [c.agentId] : []))
  return [...critics, ...listed, ...kept].some(id => text.includes(id)) ? (await wordsIn($)).criticReportKept : undefined
}

// A subagent's run ended: the critic's, its answer is read.
export function endSpecAgent($: EngineInterface, agentId: string, answer: string) {
  void heardCritic($, agentId, answer).catch(() => {})
}

export function afterSpecEdit($: EngineInterface, path: string) {
  afterEdit($, path)
}

export async function command($: Parameters<MatchedHook<'command.run', { command: 'spec' }>>[0], e: Parameters<MatchedHook<'command.run', { command: 'spec' }>>[1]) {
  const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
  const w = await wordsIn($)
  await scan($)
  const lens = await read($, lensAtom)
  if (!lens) return { text: w.noSpec }
  if (verb === 'critic' && !lens.changes.includes(verb)) {
    const mode = criticModeOf(arg.toLowerCase())
    if (!mode) return { text: w.criticUsage(await criticMode($)) }
    await update($, criticModeAtom, () => mode)
    await $.store.set(CRITIC_MODE_KEY, mode)
    return { text: w.criticSet(mode) }
  }
  if (verb !== '' && !lens.changes.includes(verb)) return { text: w.unknownChange(verb, lens.changes) }
  if (verb !== '') await pickChange($, verb)
  await openPane($, 'brief')
  return { text: w.opened((await read($, lensAtom))?.current ?? lens.current) }
}

// The change in view as the row above the prompt says it, in `bodyColumns` less the `taken` the rest
// of the row holds: what wants a look, red before yellow, then its tasks and test cases, each part
// opening the pane on the tab that tells more of it. A narrow row drops progress before it drops a
// problem, and says how many parts it dropped.
export async function specLine($: EngineInterface, e: AbovePromptEvent, taken: number) {
  const lens = await read($, lensAtom)
  if (!lens) return null
  const { Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const s = await statusOf($, lens)
  const { tasks, tests } = lens
  const parts: { key: string; text: string; color?: Tone; tab: Tab }[] = []
  const add = (when: boolean, key: string, text: () => string, tab: Tab, color?: Tone) => {
    if (when) parts.push({ key, text: text(), tab, ...(color ? { color } : {}) })
  }
  add(tests.unmarked.length > 0, 'unmarked', () => w.unmarked(tests.unmarked), 'tests', 'error')
  add(s.errors > 0, 'errors', () => w.specErrors(s.errors), 'spec', 'error')
  add(s.decisions > 0, 'decide', () => w.toDecide(s.decisions), 'decide', 'warning')
  add(s.isDecideUnknown, 'decide-unknown', () => w.decideUnknown, 'decide', 'warning')
  add(s.toApply > 0, 'apply', () => w.toApply(s.toApply), 'decide', 'warning')
  const critic = (await read($, criticAtom))[lens.current]
  add(critic?.status === 'running', 'critic', () => w.criticBusy, 'decide', 'warning')
  const { blockers } = holesLeft(critic)
  add(blockers.length > 0, 'holes', () => w.holes(blockers.length), 'decide', 'warning')
  add(lens.deltas.length > 0, 'changed', () => w.changed, 'changes', 'warning')
  add(s.warnings > 0, 'warnings', () => w.specWarnings(s.warnings), 'spec', 'warning')
  add(s.untested > 0, 'untested', () => w.untested(s.untested), 'tests', 'warning')
  add(s.withoutTest > 0, 'nocase', () => w.withoutTest(s.withoutTest), 'tests', 'warning')
  add(s.mismatches > 0, 'mismatch', () => w.mismatches(s.mismatches), 'spec', 'warning')
  add(s.overlapping.length > 0, 'overlaps', () => w.overlapsWith(s.overlapping), 'spec', 'warning')
  add((await read($, busyAtom)) === 'brief', 'busy', () => w.makingBrief, 'brief', 'warning')
  add(s.isReady, 'ready', () => w.readyToArchive, 'tasks', 'success')
  add(tasks.total > 0, 'tasks', () => w.tasks(tasks), 'tasks', tasks.total > 0 && tasks.done === tasks.total ? 'success' : undefined)
  add(tests.cases > 0, 'tests', () => w.tests(tests), 'tests')

  // Cells are counted as characters: the row's words and marks are one cell each.
  const room = e.props.bodyColumns - `◆ ${lens.current}`.length - taken
  const widthOf = (n: number) => parts.slice(0, n).reduce((sum, p) => sum + SEP.length + p.text.length, 0)
  const moreOf = (n: number) => (n < parts.length ? SEP.length + w.more(parts.length - n).length : 0)
  let shown = parts.length
  while (shown > 0 && widthOf(shown) + moreOf(shown) > room) shown--
  const hidden = parts.slice(shown)
  const hiddenTone = hidden.some(p => p.color === 'error') ? 'error' : hidden.some(p => p.color === 'warning') ? 'warning' : undefined
  const open = (tab: Tab) => () => void openPane($, tab).catch(() => {})

  const row = [
    <Button key="row-change" plain onPress={open('brief')}>
      <Text color={s.tone}>◆ </Text>
      <Text bold>{lens.current}</Text>
    </Button>,
  ]
  for (const p of parts.slice(0, shown))
    row.push(
      <Text dimColor>{SEP}</Text>,
      <Button key={`row-${p.key}`} plain onPress={open(p.tab)}>
        <Text {...(p.color ? { color: p.color } : {})}>{p.text}</Text>
      </Button>,
    )
  if (hidden.length > 0)
    row.push(
      <Text dimColor>{SEP}</Text>,
      <Button key="row-more" plain onPress={open(hidden[0]!.tab)}>
        <Text {...(hiddenTone ? { color: hiddenTone } : {})}>{w.more(hidden.length)}</Text>
      </Button>,
    )
  return row
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const Input = 'Input' in elements ? elements.Input : undefined
  const w = await wordsIn($)
  const lens = await read($, lensAtom)
  if (!lens) return <Text dimColor>{w.noSpec}</Text>
  const lang = await langIn($)
  const tab = await read($, tabAtom)
  const brief = await read($, briefAtom)
  const busy = await read($, busyAtom)
  const queued = (await read($, queuedAtom)) ?? []
  const error = await read($, errorAtom)
  const failed = await read($, failedAtom)
  const s = await statusOf($, lens)
  const isStale = brief !== null && brief.fingerprint !== lens.fingerprint
  const decisions = brief?.decisions ?? []
  const deciding = brief ? await decidingOf($, brief) : null
  const undecided = decisions.filter((_, i) => !deciding?.verdicts[i]).length
  const tasksLeft = lens.tasks.total - lens.tasks.done
  const run = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})
  // A button that sends to Claude: once, however often it is pressed while that is on its way.
  const once = (key: string, fn: () => Promise<unknown>) => () => void pressOnce($, key, fn).catch(() => {})

  // What each tab holds that wants a look, coloured as the worst of it.
  const specRed = s.errors + lens.tests.unmarked.length
  const specYellow = s.warnings + s.untested + s.mismatches + s.overlapping.length
  const badges: Record<Tab, { n: number; color?: Tone }> = {
    brief: { n: 0 },
    changes: { n: lens.deltas.length, color: 'warning' },
    // A brief older than the spec says nothing of what is left now.
    decide: { n: isStale ? 0 : undecided, color: 'warning' },
    tasks: { n: tasksLeft },
    tests: { n: (lens.testCases ?? []).filter(c => c.state === 'untested' || c.state === 'unmarked').length + s.untested, color: lens.tests.unmarked.length > 0 ? 'error' : 'warning' },
    spec: specRed > 0 ? { n: specRed, color: 'error' } : { n: specYellow, color: 'warning' },
    ask: { n: 0 },
  }
  const label = (t: Tab) => (badges[t].n > 0 ? `${w.tabs[t]} (${badges[t].n})` : w.tabs[t])

  // A button with a key shows the key before its label, so it is learned by looking.
  const keyed = (key: string, text: string, hotkey: string, onPress: () => void, look: { variant?: 'primary'; dimColor?: true } = {}) => (
    <Button key={key} label={text} hotkey={hotkey} {...look} onPress={onPress}>
      <Text dimColor>{hotkey}</Text>
      {` ${text}`}
    </Button>
  )
  const remake = (look: { variant?: 'primary'; dimColor?: true }, text = w.refresh) =>
    busy === 'brief' ? null : keyed('refresh', text, 'g', run(() => makeBrief($)), look)
  const staleRow = isStale ? (
    <Box flexDirection="row" gap={1}>
      <Text color="warning">{`⚠ ${w.stale}`}</Text>
      {remake({ variant: 'primary' })}
    </Box>
  ) : null

  let body
  if (tab === 'brief')
    body = (
      <Box flexDirection="column" gap={1}>
        {staleRow}
        {brief ? (
          <Markdown text={brief.summary} />
        ) : busy === 'brief' ? null : (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{w.noBrief}</Text>
            {remake({ variant: 'primary' }, w.makeBrief)}
          </Box>
        )}
        {brief ? (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{w.briefAt(timeOf(brief.at, lang))}</Text>
            {isStale ? null : remake({ dimColor: true })}
          </Box>
        ) : null}
      </Box>
    )
  else if (tab === 'changes') {
    const explain = await read($, explainAtom)
    body = !lens.isSeen ? (
      <Text dimColor>{w.firstLook}</Text>
    ) : lens.deltas.length === 0 ? (
      <Text color="success">{`✓ ${w.nothingNew}`}</Text>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="warning">{w.changedFiles(lens.deltas.length)}</Text>
          {busy === 'explain' || explain ? null : keyed('explain', w.explain, 'e', run(() => explainChanges($)), { variant: 'primary' })}
          {keyed('mark-read', w.markRead, 's', run(() => markRead($)), explain ? { variant: 'primary' } : { dimColor: true })}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {lens.deltas.map(d => (
            <Box flexDirection="row" gap={2}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate">{d.file}</Text>
              </Box>
              <Text>
                <Text color="success">+{d.added}</Text> <Text color="error">−{d.removed}</Text>
              </Text>
            </Box>
          ))}
        </Box>
        {explain ? (
          <Box marginTop={1}>
            <Markdown text={explain} />
          </Box>
        ) : null}
      </Box>
    )
  } else if (tab === 'decide') {
    const toApply = Object.values(deciding?.verdicts ?? {}).filter(v => !v.isSent).length
    // Shown while the spec is at the version the decisions went to; once it moves on, the brief is
    // made again and says the rest.
    const refreshing = await read($, refreshingAtom)
    const isRefreshing = refreshing?.change === lens.current && refreshing.fingerprint === lens.fingerprint && busy !== 'brief'
    const hasSent = Object.values(deciding?.verdicts ?? {}).some(v => v.isSent)
    // The critic agent's last look at the change: what it found, and where that stands.
    const mode = await criticMode($)
    const critic = (await read($, criticAtom))[lens.current]
    const { blockers, minors } = holesLeft(critic)
    const holes = [...blockers, ...minors]
    const sentHoles = critic?.sent ?? []
    const holeRows = (list: readonly Hole[]) =>
      list.map(hole => (
        <Box flexDirection="column" paddingLeft={2}>
          <Text>{`• ${hole.text}${hole.where ? ` (${hole.where})` : ''}`}</Text>
          {hole.fix ? <Text dimColor>{`  → ${hole.fix}`}</Text> : null}
        </Box>
      ))
    const criticRow =
      mode === 'off' ? (
        <Text dimColor>{w.criticOff}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {critic?.status === 'running' ? (
              <Text color="warning">{`◌ ${w.criticRunning}`}</Text>
            ) : critic?.status === 'failed' ? (
              <Text color="error">{`✗ ${w.criticFailed}`}</Text>
            ) : critic?.status === 'done' && critic.holes.length === 0 ? (
              <Text color="success">{`✓ ${w.criticNone}`}</Text>
            ) : critic && isReady(critic) ? (
              <Text color="success">{`✓ ${w.criticReady}`}</Text>
            ) : blockers.length > 0 ? (
              <Text color="warning">{w.criticFound(blockers.length)}</Text>
            ) : null}
            {holes.length > 0 ? keyed('close-holes', w.closeHoles(holes.length), 'h', once('holes', () => closeHoles($, lens.current, true)), { variant: 'primary' }) : null}
            {critic?.status === 'running' ? null : keyed('find-holes', w.findHoles, 'f', once('critic', () => critique($, true)), { dimColor: true })}
          </Box>
          {holeRows(blockers)}
          {minors.length > 0 ? <Text dimColor>{w.minorHoles}</Text> : null}
          {holeRows(minors)}
          {critic?.isSent ? <Text color="warning">{`→ ${w.holesSent(critic.round, CRITIC_ROUNDS)}`}</Text> : null}
          {critic?.isCapped ? <Text dimColor>{w.criticCapped(CRITIC_ROUNDS)}</Text> : critic && isReady(critic) && mode === 'auto' ? <Text dimColor>{w.criticResting}</Text> : null}
          {sentHoles.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{w.sentHoles}</Text>
              {sentHoles.map(r => (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text bold>{w.round(r.round)}</Text>
                  {holeRows(r.holes)}
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    body = (
      <Box flexDirection="column" gap={1}>
        {staleRow}
        {criticRow}
        {!brief ? (
          busy === 'brief' ? null : <Text dimColor>{w.noBrief}</Text>
        ) : brief.isUnsplit && !isStale ? (
          <Box flexDirection="row" gap={1}>
            <Text color="warning">{`⚠ ${w.noDecideSection}`}</Text>
            {remake({ variant: 'primary' })}
          </Box>
        ) : decisions.length === 0 ? (
          <Text color="success">{`✓ ${w.nothingToDecide}`}</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={undecided > 0 ? 'warning' : 'success'}>{w.decidedOf(decisions.length - undecided, decisions.length)}</Text>
              {toApply > 0 ? keyed('apply', w.apply(toApply), 'a', once('apply', () => applyDecisions($)), { variant: 'primary' }) : null}
              {undecided > 0 ? keyed('decide-all', w.decideAll(undecided), 'd', once('decide-all', () => decideAll($)), toApply > 0 ? {} : { variant: 'primary' }) : null}
            </Box>
            <Text dimColor>{w.decideNote}</Text>
            {decisions.map((d, i) => {
              const verdict = deciding?.verdicts[i]
              const isOpen = deciding?.open === i
              const options = brief?.options?.[i]
              const why = brief?.advice?.[i]
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color={verdict ? 'success' : 'warning'}>{verdict ? '✓ ' : `${i + 1}. `}</Text>
                    {d}
                  </Text>
                  {verdict ? (
                    <Text>
                      <Text color="success">{`  → ${verdict.answer}`}</Text>
                      {verdict.isSent ? <Text color="warning">{` · ${w.sent}`}</Text> : null}
                    </Text>
                  ) : null}
                  {verdict?.isSent ? null : (
                    <Box flexDirection="row" gap={1} marginLeft={2}>
                      <Button
                        key={`decide-${i}`}
                        label={isOpen ? w.collapse : verdict ? w.redecide : w.decide}
                        dimColor={verdict !== undefined || isOpen}
                        onPress={run(() => toggleDecision($, i))}
                      />
                      {verdict && isOpen ? <Button key={`clear-${i}`} label={w.clear} dimColor onPress={run(() => unsettle($, i))} /> : null}
                    </Box>
                  )}
                  {isOpen ? (
                    <Box flexDirection="column" marginLeft={2}>
                      {options === undefined ? (
                        busy === 'options' ? <Text color="warning">{w.finding}</Text> : null
                      ) : options.length === 0 ? (
                        <Text dimColor>{w.noOptions}</Text>
                      ) : (
                        // The one the model recommends is first, and why under it.
                        options.map((o, j) => (
                          <Box flexDirection="column">
                            <Button key={`option-${i}-${j}`} label={j === 0 && why ? `★ ${o}` : o} onPress={run(() => settle($, i, o))} />
                            {j === 0 && why ? (
                              <Box paddingLeft={2}>
                                <Text dimColor>{w.recommended(why)}</Text>
                              </Box>
                            ) : null}
                          </Box>
                        ))
                      )}
                      {Input ? (
                        <Input
                          key={`own-${i}`}
                          placeholder={w.ownPlaceholder}
                          submitLabel={w.decide}
                          {...(verdict ? { value: verdict.answer } : {})}
                          onSubmit={value => void settle($, i, value).catch(() => {})}
                        />
                      ) : null}
                    </Box>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        )}
        {isRefreshing && refreshing.isUnchanged && hasSent ? (
          <Box flexDirection="column">
            <Text color="warning">{`⚠ ${w.notWritten}`}</Text>
            <Box flexDirection="row" gap={1}>
              {keyed('resend', w.sendAgain, 'w', once('resend', () => resendDecisions($)), { variant: 'primary' })}
              <Button key="reopen" label={w.reopen} dimColor onPress={run(() => reopenDecisions($))} />
            </Box>
          </Box>
        ) : isRefreshing ? (
          <Text color="warning">{`◌ ${w.refreshing}`}</Text>
        ) : null}
      </Box>
    )
  } else if (tab === 'tasks') {
    const ready = await readiness($, lens)
    const sent = await read($, sentTasksAtom)
    const isSent = (t: Task) => sent.includes(`${lens.current}:${taskKey(t)}`)
    const next = lens.taskList.find(t => !t.isDone && !isSent(t))
    const isAllDone = tasksLeft === 0
    const filled = Math.round((lens.tasks.done / Math.max(lens.tasks.total, 1)) * BAR)
    body =
      lens.taskList.length === 0 ? (
        <Text dimColor>{w.noTasks}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text>
              <Text color="success">{'━'.repeat(filled)}</Text>
              <Text dimColor>{'━'.repeat(BAR - filled)}</Text>
            </Text>
            {isAllDone ? <Text color="success">{w.allDone}</Text> : <Text>{w.tasksDone(lens.tasks)}</Text>}
            {next ? keyed('do-next', w.doNext(taskKey(next)), 'n', once(`task:${lens.current}:${taskKey(next)}`, () => doTask($, next)), { variant: 'primary' }) : null}
          </Box>
          {/* Every task ticked: what is left is the archive, so it comes before the list. */}
          {ready.isOffered ? (
            <Box flexDirection="column" marginTop={1}>
              {ready.archive?.isSent ? (
                <Box flexDirection="row" gap={1}>
                  <Text color="success">{w.archiveSent}</Text>
                  {ready.isReady ? <Button key="archive-again" label={w.sendAgain} dimColor onPress={once('archive', () => archiveChange($))} /> : null}
                </Box>
              ) : !ready.isReady ? (
                <Box flexDirection="column">
                  <Text color="warning">{w.beforeArchive}</Text>
                  {ready.blockers.map(b => (
                    <Text>{`  · ${b}`}</Text>
                  ))}
                </Box>
              ) : ready.archive ? (
                <Box flexDirection="column">
                  <Text dimColor>{w.archiveNote}</Text>
                  <Box flexDirection="row" gap={1}>
                    <Button key="archive-confirm" label={w.archiveConfirm} variant="primary" onPress={once('archive', () => archiveChange($))} />
                    <Button key="archive-cancel" label={w.cancel} dimColor onPress={run(() => askArchive($, false))} />
                  </Box>
                </Box>
              ) : (
                <Box flexDirection="row" gap={1}>
                  <Text color="success">{`✓ ${w.readyToArchive}`}</Text>
                  <Button key="archive" label={w.archive} variant="primary" onPress={run(() => askArchive($, true))} />
                </Box>
              )}
            </Box>
          ) : null}
          {lens.taskList.map((t, i) => (
            <Box flexDirection="column">
              {t.section !== null && t.section !== lens.taskList[i - 1]?.section ? (
                <Box marginTop={1}>
                  <Text bold wrap="truncate">
                    {t.section}
                  </Text>
                </Box>
              ) : null}
              <Box flexDirection="row" gap={1}>
                <Box flexShrink={1} flexGrow={1}>
                  <Text wrap="truncate">
                    {t.isDone ? <Text color="success">✓ </Text> : isSent(t) ? <Text color="warning">→ </Text> : <Text>○ </Text>}
                    {t.id ? `${t.id} ${t.text}` : t.text}
                  </Text>
                </Box>
                {t.isDone ? null : isSent(t) ? (
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    <Text color="warning">{w.taskSent}</Text>
                    <Button key={`again-${i}`} label={w.sendAgain} dimColor onPress={once(`task:${lens.current}:${taskKey(t)}`, () => doTask($, t))} />
                  </Box>
                ) : (
                  <Button key={`task-${i}`} label={w.doTask} dimColor onPress={once(`task:${lens.current}:${taskKey(t)}`, () => doTask($, t))} />
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
  } else if (tab === 'tests') {
    const cases = lens.testCases ?? []
    const sent = await read($, sentCasesAtom)
    const pickable = pickableOf(lens)
    const picked = (await read($, pickedCasesAtom))
      .filter(k => k.startsWith(`${lens.current}:`))
      .map(k => k.slice(lens.current.length + 1))
      .filter(id => pickable.has(id))
    const isSent = (c: TestCase) => c.state !== 'tested' && sent.includes(caseKey(lens, c.id))
    const scenarios = uncoveredOf(lens)
    const isScenarioSent = (id: string) => sent.includes(caseKey(lens, id))
    const toClose = [
      ...cases.filter(c => (c.state === 'untested' || c.state === 'unmarked') && !isSent(c)).map(c => c.id),
      ...scenarios.filter(sc => !isScenarioSent(sc.id)).map(sc => sc.id),
    ]
    const pick = (key: string, id: string) => {
      const isPicked = picked.includes(id)
      return (
        <Button key={key} label={id} plain onPress={run(() => togglePick($, id))}>
          <Text {...(isPicked ? { color: 'claude' as const, bold: true } : { dimColor: true })}>{isPicked ? '[x]' : '[ ]'}</Text>
        </Button>
      )
    }
    const counts = { tested: 0, untested: 0, manual: 0, unmarked: 0 }
    for (const c of cases) counts[c.state]++
    const TONE = { tested: 'success', untested: 'warning', manual: 'suggestion', unmarked: 'error' } as const
    const ICON = { tested: '✓', untested: '●', manual: '◇', unmarked: '✗' } as const
    body =
      cases.length + scenarios.length === 0 ? (
        <Text dimColor>{w.noCases}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {cases.length > 0 ? <Text>{w.casesSummary(counts)}</Text> : null}
            {picked.length > 0 ? keyed('send-picked', w.sendPicked(picked.length), 'p', once('cases', () => closeCases($, picked)), { variant: 'primary' }) : null}
            {toClose.length > 0
              ? keyed('close-all', w.closeAll(toClose.length), 'c', once('cases', () => closeCases($, toClose)), picked.length > 0 ? {} : { variant: 'primary' })
              : null}
          </Box>
          <Text dimColor>{`${w.casesNote} ${w.pickHint}`}</Text>
          <Box flexDirection="column" marginTop={1}>
            {cases.map((c, i) => {
              return (
                <Box flexDirection="row" gap={1}>
                  {c.state === 'tested' ? <Text color="success">✓</Text> : pick(`case-${i}`, c.id)}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">{`${c.id} ${c.title}`}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    {isSent(c) ? <Text color="warning">{`→ ${w.taskSent}`}</Text> : <Text color={TONE[c.state]}>{`${ICON[c.state]} ${w.caseState[c.state]}`}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
          {/* What the specs ask for and no case checks: a case is written for it, then closed. */}
          {scenarios.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{w.uncoveredHead(scenarios.length)}</Text>
              {scenarios.map((sc, i) => (
                <Box flexDirection="row" gap={1}>
                  {pick(`scenario-${i}`, sc.id)}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">
                      <Text dimColor>{`${sc.capability} · ${sc.requirement} / `}</Text>
                      {sc.scenario}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    {isScenarioSent(sc.id) ? <Text color="warning">{`→ ${w.taskSent}`}</Text> : <Text color="warning">{`● ${w.noCaseYet}`}</Text>}
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
  } else if (tab === 'spec') {
    const checked = await read($, checkedAtom)
    const isChecked = checked?.change === lens.current && checked.fingerprint === lens.fingerprint
    const OP = { added: ['+', 'success'], modified: ['~', 'warning'], removed: ['−', 'error'], renamed: ['→', 'warning'] } as const
    body = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{w.checkHeading}</Text>
          {!isChecked ? (
            <Text color="warning">{w.checking}</Text>
          ) : checked.isTimedOut ? (
            <Text color="warning">{`⚠ ${w.checkTimedOut}`}</Text>
          ) : checked.issues === null ? (
            <Text color="warning">{`⚠ ${w.checkMissing}`}</Text>
          ) : checked.issues.length === 0 ? (
            <Text color="success">{`✓ ${w.checkClean}`}</Text>
          ) : (
            checked.issues.map(i => (
              <Text>
                {i.level === 'ERROR' ? <Text color="error">✗ </Text> : i.level === 'WARNING' ? <Text color="warning">! </Text> : <Text dimColor>i </Text>}
                <Text dimColor>{`${i.path}: `}</Text>
                {blocksArchive(i) && i.level !== 'ERROR' ? <Text color="warning">{i.message}</Text> : i.message}
              </Text>
            ))
          )}
        </Box>
        {lens.tests.unmarked.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>{w.testCasesHeading}</Text>
            {lens.tests.unmarked.map(id => (
              <Text>
                <Text color="error">✗ </Text>
                {w.unmarkedCase(id)}
              </Text>
            ))}
          </Box>
        ) : null}
        {lens.overlaps.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>{w.overlapsHeading}</Text>
            {lens.overlaps.map(o => (
              <Text>
                <Text color="warning">⚠ </Text>
                <Text bold>{o.change}</Text>
                {` · ${o.capability}`}
                {o.shared.length > 0 ? <Text color="warning">{` · ${w.shared(o.shared)}`}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : null}
        {lens.requirements.length === 0 ? (
          <Text dimColor>{w.noRequirements}</Text>
        ) : (
          <Box flexDirection="column">
            {lens.newCapabilities.length > 0 ? <Text>{w.newCapabilities(lens.newCapabilities)}</Text> : null}
            <Text dimColor>{w.opLegend}</Text>
            {lens.requirements.map((r, i) => {
              const isNew = lens.newCapabilities.includes(r.capability)
              // A new capability's changed requirements are said once, by its heading.
              const edited = isNew ? lens.requirements.filter(x => x.capability === r.capability && x.mismatch).length : 0
              return (
                <Box flexDirection="column">
                  {r.capability !== lens.requirements[i - 1]?.capability ? (
                    <Box marginTop={1}>
                      <Text>
                        <Text bold>{r.capability}</Text>
                        {isNew && edited === 0 ? <Text color="success">{` · ${w.isNew}`}</Text> : null}
                        {edited > 0 ? <Text color="warning">{` · ${w.newButEdited(edited)}`}</Text> : null}
                      </Text>
                    </Box>
                  ) : null}
                  <Text wrap="truncate">
                    <Text color={OP[r.op][1]}>{`${OP[r.op][0]} `}</Text>
                    {r.from !== undefined ? `${r.from} → ${r.name}` : r.name}
                    {r.mismatch && !isNew ? <Text color="warning">{` · ${w.mismatch[r.mismatch]}`}</Text> : null}
                  </Text>
                  {r.scenarios.length > 0 ? (
                    <Text dimColor wrap="truncate">{`    ${w.scenarios(r.scenarios.length)}: ${r.scenarios.join('; ')}`}</Text>
                  ) : null}
                  {r.uncovered ? <Text color="warning">{`    ${w.uncovered(r.uncovered)}`}</Text> : null}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  } else {
    const answer = await read($, answerAtom)
    body = (
      <Box flexDirection="column">
        {Input ? (
          <Input key="question" placeholder={w.askPlaceholder} submitLabel={w.ask} autoFocus onSubmit={value => void ask($, value).catch(() => {})} />
        ) : null}
        {/* Ready questions until one is asked: nothing to think up to start. */}
        {answer || busy === 'answer' || queued.includes('answer') ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{w.trySuggestions}</Text>
            {w.suggestions.map((q, i) => (
              <Button key={`suggest-${i}`} label={q} plain onPress={run(() => ask($, q))}>
                <Text color="suggestion">{`→ ${q}`}</Text>
              </Button>
            ))}
          </Box>
        )}
        {answer ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{answer.question}</Text>
            <Markdown text={answer.text} />
          </Box>
        ) : null}
      </Box>
    )
  }

  // The change in view and its state first, then the tabs. The focus ring starts on the open tab,
  // so the arrows walk the tabs and the buttons; on Ask the question field takes it. The change
  // list comes last, out of the arrows' way, and the keys are told under it.
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={s.tone}>◆ </Text>
        <Text bold>{w.title(lens.current)}</Text>
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {TABS.map((t, i) => (
          <Button
            key={`tab-${t}`}
            label={label(t)}
            hotkey={String(i + 1)}
            plain
            variant={t === tab ? 'primary' : 'secondary'}
            {...(t === tab ? {} : { dimColor: true as const })}
            {...(t === tab && tab !== 'ask' ? { autoFocus: true as const } : {})}
            onPress={() => void update($, tabAtom, () => t)}
          >
            <Text {...(t === tab ? { bold: true, underline: true } : {})}>{w.tabs[t]}</Text>
            {badges[t].n > 0 ? <Text {...(badges[t].color ? { color: badges[t].color } : {})}>{` ${badges[t].n}`}</Text> : null}
          </Button>
        ))}
      </Box>
      {/* What the model is doing and what went wrong, above every tab: seen wherever one is. */}
      {busy && busy !== 'options' ? <Text color="warning">{`◌ ${w.busy[busy]}`}</Text> : null}
      {queued.length > 0 ? <Text color="warning">{`  ${w.queued(queued)}`}</Text> : null}
      {error ? (
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={1}>
            <Text color="error">{`✗ ${error}`}</Text>
          </Box>
          {failed ? keyed('retry', w.retry, 'r', run(() => retry($)), { variant: 'primary' }) : null}
          <Button key="dismiss" label={w.dismiss} dimColor onPress={run(() => clearError($))} />
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
      {Select && lens.changes.length > 1 ? (
        <Box marginTop={1}>
          <Select
            key="change"
            label={w.change}
            value={lens.current}
            options={lens.changes.map(c => ({ value: c, label: c }))}
            onSelect={value => void pickChange($, value).catch(() => {})}
          />
        </Box>
      ) : null}
      {e.surface === 'terminal' ? (
        <Box marginTop={1}>
          <Text dimColor>{e.props.isFocused ? w.keysFocused : w.keysUnfocused}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
