import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, MatchedHook } from 'claude-code'

import type { Brief, Deciding, Failed, Lens, Overlap, Tab, Task, Verdict, TestCase } from '../../types/spec'
import type { AbovePromptEvent, PaneHook } from '../core/hooks'
import { langIn, restoreLang } from '../core/lang'
import { specSkill } from '../router/catalog'
import {
  annotateRequirements,
  blocksArchive,
  capabilityOf,
  changesText,
  deltasOf,
  fingerprintOf,
  hasCase,
  lf,
  parseCovers,
  parseIssues,
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
const errorAtom = atom({ plugin: 'agent-lens', key: 'spec.error' } as const, null)
const failedAtom = atom({ plugin: 'agent-lens', key: 'spec.failed' } as const, null)
const tabAtom = atom({ plugin: 'agent-lens', key: 'spec.tab' } as const, 'brief')

export const PANE = 'agent-lens-spec'
const TABS: readonly Tab[] = ['brief', 'changes', 'decide', 'tasks', 'tests', 'spec', 'ask']
// A brief and an answer want reading, not speed: the session's mid-sized model.
const MODEL = 'sonnet'
const TIMEOUT_MS = 180_000

// Store keys, per project folder and change: the change picked in the pane, the text read last
// time (what changes are counted from), and the brief in each language.
const pickedKey = (root: string) => `picked:${keyOf(root)}`
const seenKey = (root: string, change: string) => `seen:${keyOf(root)}:${change}`
const briefKey = (root: string, lang: string, change: string) => `brief:${lang}:${keyOf(root)}:${change}`

// The files of the change in view as last read: what the model is sent. Kept out of state, as
// they can run to a few hundred kilobytes.
let files: Files = {}
// The scan running, and whether something asked for one meanwhile: it then reads again before it
// resolves, so whoever waits on it gets what is on disk now.
let scanning: Promise<void> | undefined
let isScanStale = false
// The change and fingerprint `openspec validate` is running on, so a scan does not start it twice.
let checking = ''

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
      .catch((err: unknown) => (/abort/i.test(String(err)) ? null : undefined))
    if (r === null) return
    const issues = (r && parseIssues(r.stdout)) ?? null
    await update($, checkedAtom, () => ({ change: lens.current, fingerprint: lens.fingerprint, issues }))
  } finally {
    if (checking === at) checking = ''
  }
}

// Reads the project's OpenSpec changes from disk: the active ones, latest edited first, the one
// in view (the one picked, else the latest) and its files.
function scan($: EngineInterface): Promise<void> {
  if (scanning) {
    isScanStale = true
    return scanning
  }
  scanning = (async () => {
    do {
      isScanStale = false
      await scanOnce($)
    } while (isScanStale)
  })().finally(() => {
    scanning = undefined
  })
  return scanning
}

async function scanOnce($: EngineInterface) {
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
    fingerprint: fingerprintOf(files),
    isSeen: seen !== undefined,
    deltas: seen ? deltasOf(seen, files) : [],
  }
  const lang = await langIn($)
  const brief = (await $.store.get(briefKey(root, lang, current)).catch(() => undefined)) as Brief | undefined
  await update($, lensAtom, () => lens)
  await update($, briefAtom, () => brief ?? null)
  await forgetArchived($, root, changes)
  void check($, lens).catch(() => {})
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
  const texts = new Map<string, string | null>()
  const out: TestCase[] = []
  for (const c of cases) {
    if (c.file !== undefined && !texts.has(c.file)) {
      let text: string | null = null
      for (const at of [join(project, c.file), ...folders.map(d => join(project, d, c.file!))])
        if (await $.fs.exists(at).catch(() => false)) {
          text = ((await $.fs.read(at).catch(() => '')) as string) ?? ''
          break
        }
      texts.set(c.file, text)
    }
    const text = c.file === undefined ? null : (texts.get(c.file) ?? null)
    const state: TestCase['state'] =
      c.mark === 'manual' ? 'manual' : c.mark === 'none' && isMarked ? 'unmarked' : text !== null && hasCase(text, c.id) ? 'tested' : 'untested'
    out.push({ ...c, state })
  }
  return out
}

// A change archived or deleted leaves its read text and briefs behind: dropped, so the store
// keeps to the active ones.
async function forgetArchived($: EngineInterface, root: string, changes: readonly string[]) {
  const at = keyOf(root)
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    const change = key.startsWith(`seen:${at}:`)
      ? key.slice(`seen:${at}:`.length)
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

async function retry($: EngineInterface) {
  const failed = await read($, failedAtom)
  await clearError($)
  if (failed?.what === 'brief') await makeBrief($)
  else if (failed?.what === 'explain') await explainChanges($)
  else if (failed?.what === 'options') await makeOptions($)
  else if (failed?.what === 'answer' && failed.question !== undefined) await ask($, failed.question)
}

async function makeBrief($: EngineInterface) {
  const lens = await read($, lensAtom)
  if (!lens || (await read($, busyAtom)) !== null) return
  const w = await wordsIn($)
  const lang = await langIn($)
  const text = specText(lens.current, files)
  await update($, busyAtom, () => 'brief')
  await clearError($)
  try {
    const r = await $.model.complete({
      model: MODEL,
      system: w.system,
      // The change first and marked, so a question asked soon after reads it from the cache.
      prompt: [{ text, cache: true }, { text: w.briefPrompt(lens.current) }],
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
  } finally {
    await update($, busyAtom, () => null)
  }
}

async function explainChanges($: EngineInterface) {
  const lens = await read($, lensAtom)
  if (!lens || lens.deltas.length === 0 || (await read($, busyAtom)) !== null) return
  const seen = (await $.store.get(seenKey(lens.root, lens.current)).catch(() => undefined)) as Files | undefined
  if (!seen) return
  const w = await wordsIn($)
  await update($, busyAtom, () => 'explain')
  await clearError($)
  try {
    const r = await $.model.complete({
      model: MODEL,
      system: w.system,
      prompt: `${w.explainPrompt(lens.current)}\n\n${changesText(seen, files)}`,
      maxTokens: 1500,
      timeoutMs: TIMEOUT_MS,
    })
    if (r.isAnswered) await update($, explainAtom, () => r.text)
    else await fail($, w.failed(whyNot(w, r)), { what: 'explain' })
  } finally {
    await update($, busyAtom, () => null)
  }
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

// The model's options for every decision at once, asked for when the first one is opened.
async function makeOptions($: EngineInterface) {
  const lens = await read($, lensAtom)
  const brief = await read($, briefAtom)
  if (!lens || !brief || brief.options || brief.decisions.length === 0 || (await read($, busyAtom)) !== null) return
  const w = await wordsIn($)
  const lang = await langIn($)
  await update($, busyAtom, () => 'options')
  await clearError($)
  try {
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
    const withOptions: Brief = { ...brief, options: parseOptions(r.text, brief.decisions.length) }
    await $.store.set(briefKey(lens.root, lang, lens.current), withOptions)
    if ((await read($, briefAtom))?.at === brief.at) await update($, briefAtom, () => withOptions)
  } finally {
    await update($, busyAtom, () => null)
  }
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
  const skill = await specSkill($, kind, text).catch(() => undefined)
  const w = await wordsIn($)
  return $.prompt.submit({ text: skill ? `${text}\n\n${w.withSkill(skill)}` : text, asUser: true })
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
  await update($, sentTasksAtom, sent => [...sent, `${lens.current}:${key}`])
  await $.ui.toast(w.taskSentToast(key))
}

const caseKey = (lens: Lens, id: string) => `${lens.current}:${id}`

async function togglePick($: EngineInterface, id: string) {
  const lens = await read($, lensAtom)
  if (!lens) return
  const key = caseKey(lens, id)
  await update($, pickedCasesAtom, picked => (picked.includes(key) ? picked.filter(k => k !== key) : [...picked, key]))
}

// The test cases go to the session as the person's prompt: Claude writes their tests, runs them
// and marks what is unmarked.
async function closeCases($: EngineInterface, ids: readonly string[]) {
  const lens = await read($, lensAtom)
  const cases = (lens?.testCases ?? []).filter(c => ids.includes(c.id))
  if (!lens || cases.length === 0) return
  const w = await wordsIn($)
  const r = await $.prompt.submit({ text: w.closePrompt(lens.current, join(lens.root, 'changes', lens.current, 'test-cases.md'), cases), asUser: true })
  if (r.drop !== undefined) {
    await fail($, w.notSent(r.drop))
    return
  }
  const keys = cases.map(c => caseKey(lens, c.id))
  await update($, sentCasesAtom, sent => [...new Set([...sent, ...keys])])
  await update($, pickedCasesAtom, picked => picked.filter(k => !keys.includes(k)))
  await $.ui.toast(w.casesSentToast(cases.length))
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
  if (brief && brief.fingerprint === lens.fingerprint) {
    const verdicts = (await decidingOf($, brief)).verdicts
    const undecided = brief.decisions.filter((_, i) => !verdicts[i]).length
    const toApply = Object.values(verdicts).filter(v => !v.isSent).length
    if (undecided > 0) blockers.push(w.blockDecide(undecided))
    if (toApply > 0) blockers.push(w.blockApply(toApply))
  } else blockers.push(w.blockBrief)
  if (lens.tests.unmarked.length > 0) blockers.push(w.blockUnmarked(lens.tests.unmarked))
  const untested = untestedIn(lens)
  if (untested > 0) blockers.push(w.blockUntested(untested))
  const archive = await read($, archiveAtom)
  return { isOffered, blockers, isReady: isOffered && blockers.length === 0, archive: archive?.change === lens.current ? archive : null }
}

const untestedIn = (lens: Lens) => lens.requirements.reduce((n, r) => n + (r.uncovered?.length ?? 0), 0)

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

// After a turn the row follows what agents ticked and rewrote; a spec that moved on from the
// decisions sent gets its brief made again, so the Decide tab shows what is left.
async function afterTurn($: EngineInterface) {
  await scan($)
  const lens = await read($, lensAtom)
  const refreshing = await read($, refreshingAtom)
  if (!lens || !refreshing || refreshing.change !== lens.current || refreshing.fingerprint === lens.fingerprint) return
  await update($, refreshingAtom, () => null)
  await makeBrief($)
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
  const lens = await read($, lensAtom)
  if (!lens) return
  await $.store.set(seenKey(lens.root, lens.current), files)
  await update($, explainAtom, () => null)
  await update($, lensAtom, () => ({ ...lens, isSeen: true, deltas: [] }))
}

async function ask($: EngineInterface, question: string) {
  const lens = await read($, lensAtom)
  const q = question.trim()
  if (!lens || q === '' || (await read($, busyAtom)) !== null) return
  const w = await wordsIn($)
  await update($, busyAtom, () => 'answer')
  await clearError($)
  await update($, answerAtom, () => null)
  try {
    const r = await $.model.complete({
      model: MODEL,
      system: w.system,
      prompt: [{ text: specText(lens.current, files), cache: true }, { text: w.askPrompt(q) }],
      maxTokens: 1500,
      timeoutMs: TIMEOUT_MS,
    })
    if (r.isAnswered) await update($, answerAtom, () => ({ question: q, text: r.text }))
    else await fail($, w.failed(whyNot(w, r)), { what: 'answer', question: q })
  } finally {
    await update($, busyAtom, () => null)
  }
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

async function afterEdit($: EngineInterface, path: string) {
  if (new RegExp(String.raw`[\\/]openspec[\\/]changes[\\/]`, isWindowsPath(path) ? 'i' : '').test(path)) await scan($)
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
  const ready = await readiness($, lens)
  const tone: Tone =
    lens.tests.unmarked.length > 0 || errors > 0
      ? 'error'
      : decisions > 0 || toApply > 0 || warnings > 0 || untested > 0 || overlapping.length > 0 || lens.deltas.length > 0
        ? 'warning'
        : 'success'
  return { decisions, toApply, errors, warnings, overlapping, untested, isReady: ready.isReady && !ready.archive?.isSent, tone }
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({ name: 'spec', description: (await wordsIn($)).description, argumentHint: '[<change> | lang en|ru]' })
}

// What the model said in another language is not this one's: the explanation and the answer go,
// the brief of the change is read in the new one.
export async function forgetSaid($: EngineInterface) {
  await update($, explainAtom, () => null)
  await update($, answerAtom, () => null)
  await scan($)
}

export async function startSpec($: EngineInterface, isInteractive: boolean) {
  await restoreLang($)
  await registerCommand($)
  if (isInteractive) await scan($).catch(() => {})
}

// A /clear or /resume empties the session's values: the change in view is read again, so the row
// is back before the first prompt. Heard as the old session's end, which runs where an
// organization manages Claude Code (classic.SessionStart does not there).
export async function rescanSpec($: EngineInterface) {
  await restoreLang($)
  await scan($).catch(() => {})
}

// Agents tick tasks and rewrite the spec as they go: the row follows them.
export function endSpecTurn($: EngineInterface) {
  void afterTurn($).catch(() => {})
}

export async function afterSpecEdit($: EngineInterface, path: string) {
  await afterEdit($, path)
}

export async function command($: Parameters<MatchedHook<'command.run', { command: 'spec' }>>[0], e: Parameters<MatchedHook<'command.run', { command: 'spec' }>>[1]) {
  const [verb = ''] = e.args.trim().split(/\s+/)
  const w = await wordsIn($)
  await scan($)
  const lens = await read($, lensAtom)
  if (!lens) return { text: w.noSpec }
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
  add(s.toApply > 0, 'apply', () => w.toApply(s.toApply), 'decide', 'warning')
  add(lens.deltas.length > 0, 'changed', () => w.changed, 'changes', 'warning')
  add(s.warnings > 0, 'warnings', () => w.specWarnings(s.warnings), 'spec', 'warning')
  add(s.untested > 0, 'untested', () => w.untested(s.untested), 'spec', 'warning')
  const withoutTest = (lens.testCases ?? []).filter(c => c.state === 'untested').length
  add(withoutTest > 0, 'nocase', () => w.withoutTest(withoutTest), 'tests', 'warning')
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
  const error = await read($, errorAtom)
  const failed = await read($, failedAtom)
  const s = await statusOf($, lens)
  const isStale = brief !== null && brief.fingerprint !== lens.fingerprint
  const decisions = brief?.decisions ?? []
  const deciding = brief ? await decidingOf($, brief) : null
  const undecided = decisions.filter((_, i) => !deciding?.verdicts[i]).length
  const tasksLeft = lens.tasks.total - lens.tasks.done
  const run = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})

  // What each tab holds that wants a look, coloured as the worst of it.
  const specRed = s.errors + lens.tests.unmarked.length
  const specYellow = s.warnings + s.untested + s.overlapping.length
  const badges: Record<Tab, { n: number; color?: Tone }> = {
    brief: { n: 0 },
    changes: { n: lens.deltas.length, color: 'warning' },
    decide: { n: undecided, color: 'warning' },
    tasks: { n: tasksLeft },
    tests: { n: (lens.testCases ?? []).filter(c => c.state === 'untested' || c.state === 'unmarked').length, color: lens.tests.unmarked.length > 0 ? 'error' : 'warning' },
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
    const isRefreshing = (await read($, refreshingAtom))?.change === lens.current && busy !== 'brief'
    body = (
      <Box flexDirection="column" gap={1}>
        {staleRow}
        {!brief ? (
          busy === 'brief' ? null : <Text dimColor>{w.noBrief}</Text>
        ) : decisions.length === 0 ? (
          <Text color="success">{`✓ ${w.nothingToDecide}`}</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={undecided > 0 ? 'warning' : 'success'}>{w.decidedOf(decisions.length - undecided, decisions.length)}</Text>
              {toApply > 0 ? keyed('apply', w.apply(toApply), 'a', run(() => applyDecisions($)), { variant: 'primary' }) : null}
            </Box>
            <Text dimColor>{w.decideNote}</Text>
            {decisions.map((d, i) => {
              const verdict = deciding?.verdicts[i]
              const isOpen = deciding?.open === i
              const options = brief?.options?.[i]
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color={verdict ? 'success' : 'warning'}>{verdict ? '✓ ' : `${i + 1}. `}</Text>
                    {d}
                  </Text>
                  {verdict ? (
                    <Text>
                      <Text color="success">{`  → ${verdict.answer}`}</Text>
                      {verdict.isSent ? <Text dimColor>{` · ${w.sent}`}</Text> : null}
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
                        options.map((o, j) => <Button key={`option-${i}-${j}`} label={o} onPress={run(() => settle($, i, o))} />)
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
        {isRefreshing ? <Text color="warning">{w.refreshing}</Text> : null}
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
            {next ? keyed('do-next', w.doNext(taskKey(next)), 'n', run(() => doTask($, next)), { variant: 'primary' }) : null}
          </Box>
          {/* Every task ticked: what is left is the archive, so it comes before the list. */}
          {ready.isOffered ? (
            <Box flexDirection="column" marginTop={1}>
              {ready.archive?.isSent ? (
                <Text color="success">{w.archiveSent}</Text>
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
                    <Button key="archive-confirm" label={w.archiveConfirm} variant="primary" onPress={run(() => archiveChange($))} />
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
                  <Text wrap="truncate" dimColor={t.isDone}>
                    {t.isDone ? <Text color="success">✓ </Text> : isSent(t) ? <Text color="warning">→ </Text> : <Text>○ </Text>}
                    {t.id ? `${t.id} ${t.text}` : t.text}
                  </Text>
                </Box>
                {t.isDone ? null : isSent(t) ? (
                  <Text color="warning">{w.taskSent}</Text>
                ) : (
                  <Button key={`task-${i}`} label={w.doTask} dimColor onPress={run(() => doTask($, t))} />
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
  } else if (tab === 'tests') {
    const cases = lens.testCases ?? []
    const sent = await read($, sentCasesAtom)
    const picked = (await read($, pickedCasesAtom)).filter(k => k.startsWith(`${lens.current}:`)).map(k => k.slice(lens.current.length + 1))
    const isSent = (c: TestCase) => c.state !== 'tested' && sent.includes(caseKey(lens, c.id))
    const toClose = cases.filter(c => (c.state === 'untested' || c.state === 'unmarked') && !isSent(c))
    const counts = { tested: 0, untested: 0, manual: 0, unmarked: 0 }
    for (const c of cases) counts[c.state]++
    const TONE = { tested: 'success', untested: 'warning', manual: 'suggestion', unmarked: 'error' } as const
    const ICON = { tested: '✓', untested: '●', manual: '◇', unmarked: '✗' } as const
    body =
      cases.length === 0 ? (
        <Text dimColor>{w.noCases}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text>{w.casesSummary(counts)}</Text>
            {picked.length > 0 ? keyed('send-picked', w.sendPicked(picked.length), 'p', run(() => closeCases($, picked)), { variant: 'primary' }) : null}
            {toClose.length > 0
              ? keyed('close-all', w.closeAll(toClose.length), 'c', run(() => closeCases($, toClose.map(c => c.id))), picked.length > 0 ? {} : { variant: 'primary' })
              : null}
          </Box>
          <Text dimColor>{`${w.casesNote} ${w.pickHint}`}</Text>
          <Box flexDirection="column" marginTop={1}>
            {cases.map((c, i) => {
              const isPicked = picked.includes(c.id)
              return (
                <Box flexDirection="row" gap={1}>
                  {c.state === 'tested' ? (
                    <Text color="success">✓</Text>
                  ) : (
                    <Button key={`case-${i}`} label={c.id} plain onPress={run(() => togglePick($, c.id))}>
                      <Text {...(isPicked ? { color: 'claude' as const, bold: true } : { dimColor: true })}>{isPicked ? '[x]' : '[ ]'}</Text>
                    </Button>
                  )}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate" {...(c.state === 'tested' ? { dimColor: true } : {})}>{`${c.id} ${c.title}`}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    {isSent(c) ? <Text color="warning">{`→ ${w.taskSent}`}</Text> : <Text color={TONE[c.state]}>{`${ICON[c.state]} ${w.caseState[c.state]}`}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
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
          ) : checked.issues === null ? (
            <Text dimColor>{w.checkMissing}</Text>
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
        {answer || busy === 'answer' ? null : (
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
      <Box flexDirection="row" gap={1}>
        <Text wrap="truncate">
          <Text color={s.tone}>◆ </Text>
          <Text bold>{lens.current}</Text>
        </Text>
        {Select && lens.changes.length > 1 ? <Text dimColor>{`· ${w.activeChanges(lens.changes.length)}`}</Text> : null}
      </Box>
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
