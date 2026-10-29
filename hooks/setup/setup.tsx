import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, TurnCompleteReason } from 'claude-code'

import type { Baseline, DocIssue, Finding, Gate, Judge, Run, StepId, StepState, Term, TermCheck, TermVerdict } from '../../types/setup'
import type { PaneHook, StopNext } from '../core/hooks'
import { langIn } from '../core/lang'
import { WORDS as LENS_WORDS } from '../lenses/words'
import { below, joinPath, parentOf } from '../review/diff'
import { diffLines } from '../spec/spec'
import { baselineOf, CONFIG, DENY, type Exec, fingerprintOf, joinRel, newRed, parseConfig, permissionIssues, runTier, SETTINGS, timingIssues, whereOf } from './checks'
import { ADR_DIR, type Disk, hasTaskRules, issuesIn as issuesOf, LIMITS, OLD_GLOSSARIES, parseFindings, parseTermsInUse, pathsIn, readDocs as readDocsOf, termsOf } from './docs'
import { WORDS } from './words'

// The mod's own lenses by their names in a language, by the names /changes lenses gives them: the
// step of the lenses leaves them out of LENSES.md, a rule of the tasks names them.
const lensTitles = (lang: keyof typeof LENS_WORDS) => [...LENS_WORDS[lang].lenses.matchAll(/^\d+\. ([^.]+)\./gm)].map(m => m[1]!)

// /setup-project: prepares a project for work with the agent, one step at a time, each sent to the
// session once the turn before it has ended, and keeps the files those steps write to their form.
// The way of it is docs/setup-project.md.

const runAtom = atom({ plugin: 'agent-lens', key: 'setup.run' } as const, null)
const issuesAtom = atom({ plugin: 'agent-lens', key: 'setup.issues' } as const, null)
const judgeAtom = atom({ plugin: 'agent-lens', key: 'setup.judge' } as const, null)
const retroAtom = atom({ plugin: 'agent-lens', key: 'setup.retro' } as const, null)
const gateAtom = atom({ plugin: 'agent-lens', key: 'setup.gate' } as const, null)
const rulesOfferAtom = atom({ plugin: 'agent-lens', key: 'setup.rulesOffer' } as const, null)
const termsAtom = atom({ plugin: 'agent-lens', key: 'setup.terms' } as const, null)
const questionsAtom = atom({ plugin: 'agent-lens', key: 'setup.questions' } as const, null)
// What is known of the terms git finds nowhere in a project, each by its glossary and the term.
const termsKey = (root: string) => `setup:terms:${root}`
const termKey = (t: Term) => `${t.file}\n${t.term}`
const rulesDismissedKey = (root: string) => `setup:rules-dismissed:${root}`
// The project whose rule went to Claude: not offered again there while Claude is at it; offered
// again after a /clear where it is still missing.
let rulesSentIn: string | null = null
export const PANE = 'agent-lens-setup'
const runKey = (root: string) => `setup:${root}`
// What the fast checks were red on, by folder, on the commit they ran on before the agent.
const baseKey = (root: string) => `setup:base:${root}`

// The lenses come once the standards hold what one edit can be checked against; the checks once the
// linter has the standards' rules; how work goes once there are commands to point to; CI last, as
// it runs what the steps before it wrote.
const STEPS: StepId[] = ['matt', 'openspec', 'existing', 'map', 'standards', 'lenses', 'checks', 'run', 'permissions', 'workflow', 'config', 'ci']
// The skills of Matt's the way of working stands on; the first sets the project up for the rest.
const MATT = 'mattpocock-skills'
const MATT_SKILLS = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro']
// The skills of his how work goes names, each only where it is installed.
const WORKFLOW_SKILLS = ['grilling', 'domain-modeling', 'tdd', 'diagnosing-bugs', 'code-review', 'retro']
// A project is set up once this file is there: from then on its files are checked.
const MARK = 'docs/agents/workflow.md'
// Docs a project wrote for its agents before /setup-project, beside a CLAUDE.md of its own: where
// one is there, what is written is sorted before the steps write more.
const OWN_DOCS = ['AGENTS.md', ...Object.keys(OLD_GLOSSARIES), '.cursorrules', '.cursor/rules', '.github/copilot-instructions.md']

// The files each step writes: the step is done once they are there and pass the check. Matt's
// skill writes its own and keeps them to its own form. Sorting what is written writes none of its
// own, and the lenses none where the project's reviews show no kind beyond the mod's: each is done
// with the turn that answers it.
const WRITES: Record<StepId, string[]> = {
  matt: ['docs/agents/issue-tracker.md', 'docs/agents/domain.md'],
  openspec: ['openspec/config.yaml'],
  existing: [],
  map: ['GLOSSARY.md', 'ARCHITECTURE.md'],
  standards: ['CODING_STANDARDS.md'],
  lenses: ['LENSES.md'],
  checks: [CONFIG],
  run: [CONFIG],
  permissions: [SETTINGS],
  workflow: ['docs/agents/workflow.md', 'CLAUDE.md'],
  config: ['openspec/config.yaml'],
  ci: [],
}
const CHECKED: Record<StepId, (file: string) => boolean> = {
  matt: () => false,
  openspec: () => false,
  existing: f => f in OLD_GLOSSARIES,
  map: f => /(^|\/)GLOSSARY(-MAP)?\.md$/.test(f) || f === 'ARCHITECTURE.md' || f.startsWith(`${ADR_DIR}/`),
  standards: f => f === 'CODING_STANDARDS.md',
  lenses: f => f === 'LENSES.md',
  checks: f => f === CONFIG,
  run: f => f === CONFIG,
  permissions: f => f === SETTINGS,
  workflow: f => f === 'docs/agents/workflow.md' || f === 'CLAUDE.md',
  config: () => false,
  ci: () => false,
}
// Where a project keeps its CI: a step that adds a job there has nothing to add to where there is none.
const CI_FILES = ['.gitlab-ci.yml', '.github/workflows', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml', 'Jenkinsfile']
// The step each stands on: OpenSpec reads the files only of an openspec/ that is initialised.
const STANDS_ON: Partial<Record<StepId, StepId>> = { config: 'openspec' }
// The steps being run again from their rows: a press meanwhile runs nothing more.
const rerunning = new Set<StepId>()
// How often the gate sends a turn back for the same red before it lets it go to the person.
const GATE_ROUNDS = 3

// Whether the main loop is in a turn: a step waits for its end.
let isMainTurn = false
// The tree of each folder the fast checks run in, and its commit, by the folder.
type Trees = Record<string, { head: string; tree: string }>
// The rounds the gate sent the same work back, and the trees at its last run: a turn sent back that
// changes nothing since is let go. A chain of them is one piece of work: the person's turn starts one.
type GateChain = { rounds: number; last: Trees | null }
// What the gate knows of the main turn: its trees as it found them, the files it edited through a
// tool, how many of those its last run had seen, its chain, and which turn of the session it is.
// It runs only where the turn changed something.
type GateTurn = { before: Promise<Trees>; edited: string[]; seen: number; chain: GateChain; generation: number }
let gateTurn: GateTurn | null = null
let generation = 0
// Whether a classic Stop saw this turn's end: where none runs, the gate goes as a prompt instead,
// and the turn that prompt starts, told by its text, goes on with its chain. A prompt of the
// person's queued while the gate ran starts a chain of its own.
let isStopSeen = false
let gatePrompt: { text: string; chain: GateChain } | null = null
// The files as the turn found them, by their path from the root: all of them in a project set up,
// CLAUDE.md alone elsewhere. What the docs agent is shown the turn changed, whatever wrote them
// (Write, Edit, or the shell, which no edit hook sees).
let turnBefore: Promise<Record<string, string>> | null = null
// While /setup-project's steps go, the files as the run found them, each as it was before the first
// turn that changed it (undefined: not there): the docs agent reads them once, at the run's end.
const runBefore = new Map<string, string | undefined>()
// What may have gone stale, as last looked for: at the session's start, on /setup-project check,
// and after a turn while some is found.
let drift: DocIssue[] = []
// The glossary terms git found nowhere else, as last looked for with what may have gone stale: the
// docs agent reads them before the person is asked.
let unfound: Term[] = []
// The terms the person put off, or sent to Claude to take out: not asked again in this session.
const later = new Set<string>()
// The person's last answer on a term, while it may be undone, and what was known of the term before.
let lastAnswer: { term: Term; answer: 'kept' | 'later'; was?: TermVerdict } | null = null
// The terms the docs agent gave no word on, as it did not start or gave no list: the person's
// questions in this session, the agent's again in the next.
const unjudged = new Set<string>()
// The terms whose answer is being taken: a key pressed again meanwhile answers nothing more.
const answering = new Set<string>()
// Whether the docs agent is being started on the terms: not yet kept as running.
let isSpawningTerms = false
// The docs agents this module started, by id, as long as it runs.
const judges = new Set<string>()
const JUDGE_MODEL = 'sonnet'
// Looking for a term in other forms and names is a search, not a reading of edits.
const TERMS_MODEL = 'haiku'
// How long the docs agent's word on a term holds before it looks again; the person's holds for good.
const TERM_MS = 30 * 86_400_000
const JUDGE_STALE_MS = 20 * 60_000
// What each file the agent is shown keeps of each side of an edit.
const EDIT_LIMIT = 12_000
// A part of the map with this many commits since the map was edited may have moved on from it.
const STALE_COMMITS = 15
// How many of the map's paths and the glossary's terms are looked up, at most.
const DRIFT_PATHS = 40
const DRIFT_TERMS = 80
const DOC_PATH = /(?:^|[\\/])(?:CLAUDE|AGENTS|GLOSSARY|GLOSSARY-MAP|CONTEXT|CONTEXT-MAP|ARCHITECTURE|CODING_STANDARDS|LENSES|workflow)\.md$|[\\/]docs[\\/]adr[\\/][^\\/]+\.md$/

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

async function exists($: EngineInterface, root: string, rel: string) {
  return $.fs.exists(joinPath(root, rel)).catch(() => false)
}

async function readRel($: EngineInterface, root: string, rel: string) {
  return $.fs.read(joinPath(root, rel)).catch(() => undefined)
}

// The project as the check reads it, through the engine.
function diskOf($: EngineInterface, root: string): Disk {
  return {
    read: rel => readRel($, root, rel),
    exists: rel => exists($, root, rel),
    list: async rel => (await $.fs.list(joinPath(root, rel)).catch(() => [])).flatMap(f => (f.kind === 'other' ? [] : [{ name: f.name, kind: f.kind }])),
  }
}

// The host's commands, as the checks run them.
function execOf($: EngineInterface): Exec {
  return (argv, cwd, timeoutMs) => $.process.run(argv, { cwd, timeoutMs })
}

async function configIn($: EngineInterface, root: string) {
  const text = await readRel($, root, CONFIG)
  return text === undefined ? undefined : parseConfig(text).config
}

// The CLI's version, or null where it does not run. npm installs it on Windows as `openspec.cmd`.
async function openspecVersion($: EngineInterface, root: string) {
  const run = (cli: string) => $.process.run([cli, '--version'], { cwd: root, timeoutMs: 15_000 })
  const r = await run('openspec')
    .catch(() => run('openspec.cmd'))
    .catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim().split('\n').at(-1)!.trim() : null
}

// What the steps stand on: Matt's skills by the name each runs by, the OpenSpec CLI, and the CI the
// project keeps. None of them stops /setup-project: a step that needs what is missing is left out,
// and the person is told what to install for it.
async function preflight($: EngineInterface, root: string) {
  const commands = await $.command.list().catch(() => [])
  const named = (skill: string) => commands.find(c => c.name === `${MATT}:${skill}` || (c.plugin === MATT && c.name.endsWith(skill)))?.name
  const missing = MATT_SKILLS.filter(s => !named(s))
  const openspec = await openspecVersion($, root)
  const ci = (await Promise.all(CI_FILES.map(async f => ((await exists($, root, f)) ? f : null)))).filter((f): f is string => f !== null)
  return {
    missing,
    skills: WORKFLOW_SKILLS.filter(s => named(s)),
    setupCommand: named('setup-matt-pocock-skills'),
    openspec,
    isInitialised: await exists($, root, 'openspec'),
    ci,
  }
}
type Found = Awaited<ReturnType<typeof preflight>>

// What a step needs that is not there, in the words that say how to get it; none where it can go.
function needsOf(step: StepId, found: Found, w: Awaited<ReturnType<typeof wordsIn>>) {
  if (step === 'matt' && !found.setupCommand) return w.needsMatt
  if ((step === 'openspec' || step === 'config') && found.openspec === null) return w.needsOpenspec
  if (step === 'ci' && found.ci.length === 0) return w.needsCi
  return undefined
}

function readDocs($: EngineInterface, root: string) {
  return readDocsOf(diskOf($, root))
}

function issuesIn($: EngineInterface, root: string) {
  return issuesOf(diskOf($, root))
}

// The check of the files, kept for the row and the pane, in a project set up or being set up.
export async function checkProject($: EngineInterface) {
  const root = await $.session.root()
  const run = await read($, runAtom)
  if (!run && !(await exists($, root, MARK))) {
    await update($, issuesAtom, () => null)
    return null
  }
  const issues = [...(await issuesIn($, root)), ...drift]
  await update($, issuesAtom, () => issues)
  return issues
}

// What may have gone stale: each part of the map git shows much changed since the map was last
// edited, and each glossary term found nowhere else in its repository, which the docs agent reads
// before it is the person's question. Looked for beside the session's start, as it runs git once
// per path and term.
async function driftIn($: EngineInterface, root: string): Promise<{ issues: DocIssue[]; terms: Term[] }> {
  const files = await readDocs($, root)
  // A UTF-8 locale: in C, `-i` matches no letter beyond ASCII, and a term in Cyrillic is found only as written.
  const git = (cwd: string, args: string[]) => $.process.run(['git', '-C', cwd, ...args], { cwd, env: { LC_ALL: 'C.UTF-8' }, timeoutMs: 15_000 }).catch(() => null)
  const found: DocIssue[] = []
  const terms: Term[] = []
  if (files['ARCHITECTURE.md']) {
    const since = (await git(root, ['log', '-1', '--format=%H', '--', 'ARCHITECTURE.md']))?.stdout.trim()
    if (since) {
      const paths = pathsIn(files['ARCHITECTURE.md'])
        .map(p => p.replace(/^\.\//, '').replace(/\/$/, ''))
        .filter(p => p.includes('/') || !p.includes('.'))
        .slice(0, DRIFT_PATHS)
      for (const path of paths) {
        const n = Number((await git(root, ['rev-list', '--count', `${since}..HEAD`, '--', path]))?.stdout.trim())
        if (n >= STALE_COMMITS) found.push({ file: 'ARCHITECTURE.md', kind: 'stale-map', detail: `${path} (${n})` })
      }
    }
  }
  for (const [file, text] of Object.entries(files).filter(([f]) => /(^|\/)GLOSSARY\.md$/.test(f)))
    for (const term of termsOf(text).slice(0, DRIFT_TERMS)) {
      const at = parentOf(joinPath(root, file))
      // The whole repository, not the glossary's folder alone; with the files not committed yet, as
      // what the agent just wrote often is.
      const r = await git(at, ['grep', '--untracked', '-I', '-q', '-i', '-F', '-e', term, '--', ':/', ':(top,exclude,glob)**/GLOSSARY*.md'])
      // 1: none found; anything else (no repository, an error) says nothing.
      if (r?.exitCode === 1) terms.push({ file, term })
    }
  return { issues: found, terms }
}

async function lookForDrift($: EngineInterface) {
  const root = await $.session.root()
  if (!(await read($, runAtom)) && !(await exists($, root, MARK))) return
  await keepDrift($, await driftIn($, root))
  await checkProject($)
}

async function keepDrift($: EngineInterface, found: { issues: DocIssue[]; terms: Term[] }) {
  drift = found.issues
  unfound = found.terms
  await checkTerms($)
}

// What is known of the terms, as long as it holds.
async function verdictsIn($: EngineInterface, root: string) {
  const kept = ((await $.store.get(termsKey(root)).catch(() => undefined)) ?? {}) as Record<string, TermVerdict>
  const now = await $.clock.now()
  return Object.fromEntries(Object.entries(kept).filter(([, v]) => v.verdict === 'kept' || now - v.at < TERM_MS))
}

async function keepVerdicts($: EngineInterface, root: string, verdicts: Record<string, TermVerdict>) {
  await $.store.set(termsKey(root), { ...(await verdictsIn($, root)), ...verdicts })
}

// The terms git finds nowhere go to the docs agent, one look at a time: in another form of the word
// or by the code's name for it, a term is in use, and the person is not asked. Its word holds for a
// while; what it did not find either is the person's question.
async function checkTerms($: EngineInterface) {
  const root = await $.session.root()
  const known = await verdictsIn($, root)
  const was = await read($, termsAtom)
  const at = await $.clock.now()
  const unread = unfound.filter(t => !known[termKey(t)] && !unjudged.has(termKey(t)))
  if (unread.length > 0 && !isSpawningTerms && !(was?.status === 'running' && at - was.at < JUDGE_STALE_MS)) {
    // The session's start and a check may both get here before the agent is kept as running.
    isSpawningTerms = true
    try {
      const w = await wordsIn($)
      const agentId = await spawnAgent($, w.termsPrompt(root, unread), w.termsTask, TERMS_MODEL)
      await update($, termsAtom, (): TermCheck => ({ status: agentId ? 'running' : 'failed', at, terms: unread, ...(agentId ? { agentId } : {}) }))
      if (!agentId) for (const t of unread) unjudged.add(termKey(t))
    } finally {
      isSpawningTerms = false
    }
  }
  await askTerms($)
}

// The terms neither git nor the docs agent found, put to the person.
async function askTerms($: EngineInterface) {
  const known = await verdictsIn($, await $.session.root())
  // Not found by the agent, or not looked at by it, and not answered in use or put off.
  const isAsked = (t: Term) => {
    const verdict = known[termKey(t)]?.verdict
    return (verdict === 'unused' || (verdict === undefined && unjudged.has(termKey(t)))) && !later.has(termKey(t))
  }
  const questions = unfound.filter(isAsked)
  await update($, questionsAtom, () => (questions.length > 0 ? questions : null))
}

// The person's word on the term asked: in use, kept for good; out, which Claude takes out of the
// glossary; or later, asked again at the next session's start or after /clear.
async function answerTerm($: EngineInterface, term: Term, answer: 'kept' | 'drop' | 'later') {
  const key = termKey(term)
  if (answering.has(key) || later.has(key)) return
  answering.add(key)
  try {
    await answerOnce($, term, answer)
  } finally {
    answering.delete(key)
  }
}

async function answerOnce($: EngineInterface, term: Term, answer: 'kept' | 'drop' | 'later') {
  const root = await $.session.root()
  const key = termKey(term)
  const was = (await verdictsIn($, root))[key]
  if (was?.verdict === 'kept') return
  if (answer === 'kept') await keepVerdicts($, root, { [key]: { verdict: 'kept', at: await $.clock.now() } })
  else if (answer === 'later') later.add(key)
  else {
    const r = await $.prompt.submit({ text: (await wordsIn($)).termDropPrompt(term), asUser: true }).catch(() => undefined)
    if (!r || r.drop !== undefined) return
    later.add(key)
  }
  // What went to Claude is not taken back here.
  lastAnswer = answer === 'drop' ? null : { term, answer, ...(was ? { was } : {}) }
  await askTerms($)
}

async function undoTerm($: EngineInterface) {
  if (!lastAnswer) return
  const { term, answer, was } = lastAnswer
  lastAnswer = null
  const root = await $.session.root()
  if (answer === 'later') later.delete(termKey(term))
  else if (was) await keepVerdicts($, root, { [termKey(term)]: was })
  // Held in use where the agent gave no word on it: nothing was known before.
  else await $.store.set(termsKey(root), Object.fromEntries(Object.entries(await verdictsIn($, root)).filter(([k]) => k !== termKey(term))))
  await askTerms($)
}

async function keepRun($: EngineInterface, run: Run) {
  await update($, runAtom, () => run)
  await $.store.set(runKey(run.root), run)
}

const setStep = (run: Run, step: StepId, state: StepState): Run => ({ ...run, steps: { ...run.steps, [step]: state } })

// Whether the project has docs of its own to sort: one of another tool's, or a CLAUDE.md the steps
// did not write.
async function hasOwnDocs($: EngineInterface, root: string) {
  const there = await Promise.all(OWN_DOCS.map(f => exists($, root, f)))
  return there.some(Boolean) || ((await exists($, root, 'CLAUDE.md')) && !(await exists($, root, MARK)))
}

// The texts of the project's CI: the files at its places, and those of a folder of them.
async function ciTexts($: EngineInterface, root: string) {
  const texts: string[] = []
  for (const rel of CI_FILES) {
    const text = await readRel($, root, rel)
    if (text !== undefined) texts.push(text)
    else for (const f of await $.fs.list(joinPath(root, rel)).catch(() => [])) if (f.kind === 'file') texts.push((await readRel($, root, `${rel}/${f.name}`)) ?? '')
  }
  return texts
}

async function isWritten($: EngineInterface, root: string, step: StepId) {
  if (step === 'existing') return !(await hasOwnDocs($, root))
  if (step === 'config') {
    const config = (await readRel($, root, 'openspec/config.yaml')) ?? ''
    return config.includes('GLOSSARY.md') && hasTaskRules(config)
  }
  // Written out of its form, the step goes back with what is wrong, as a file of any other step does.
  if (step === 'checks' || step === 'run') {
    const text = await readRel($, root, CONFIG)
    if (text === undefined) return false
    const { config, issues } = parseConfig(text)
    const checks = config.checks
    return issues.length > 0 || (step === 'checks' ? checks !== undefined && [...Object.values(checks.fast), ...Object.values(checks.full)].some(list => list.length > 0) : config.run !== undefined)
  }
  if (step === 'ci') return (await ciTexts($, root)).some(t => t.includes('agent-lens'))
  const there = await Promise.all(WRITES[step].map(f => exists($, root, f)))
  return there.every(Boolean)
}

// What a step's own check finds beyond the files' form, once its files are there: the fast checks
// run once (what does not start, what is too slow), what is red on this commit kept as the
// baseline; the rules every project's settings get.
async function stepIssues($: EngineInterface, root: string, step: StepId): Promise<DocIssue[]> {
  if (step === 'checks') {
    const taken = await takeBaseline($, root)
    const found = timingIssues(taken?.timings ?? [])
    if (taken && found.length === 0) await $.store.set(baseKey(root), taken.baseline)
    return found
  }
  if (step === 'permissions') return permissionIssues((await readRel($, root, SETTINGS)) ?? '{}')
  return []
}

// The fast tier run now, and what is red on each folder's commit: the gate does not send back what
// was red before. Undefined where the project has no fast checks.
async function takeBaseline($: EngineInterface, root: string) {
  const fast = (await configIn($, root))?.checks?.fast
  if (!fast) return undefined
  const trees = await treesOf($, root, fast)
  const { failures, timings } = await runTier(execOf($), root, fast, { isFast: true, now: () => $.clock.now() })
  return { failures, timings, baseline: baselineOf(failures, headsOf(trees)) }
}

// The run changed one change at a time, each on the run as it is then, and kept: two at once (a key
// pressed twice, a press beside a turn's end) would each read it before the other kept its change,
// and send the same step twice, or one undo the other. The change waits on nothing, so none holds up
// the next; undefined keeps the run as it is.
let changing: Promise<unknown> = Promise.resolve()
function changeRun($: EngineInterface, change: (run: Run) => Run | undefined): Promise<Run | undefined> {
  const next = changing.then(async () => {
    const run = await read($, runAtom)
    const changed = run ? change(run) : undefined
    if (changed) await keepRun($, changed)
    return changed
  })
  // A failed change is its caller's to hear of, and lets the next one go.
  changing = next.catch(() => {})
  return next
}

function changeStep($: EngineInterface, step: StepId, state: StepState) {
  return changeRun($, run => setStep(run, step, state))
}

// Sends the next step not done, unless one is with Claude or a turn runs; openspec init the mod
// runs itself.
async function advance($: EngineInterface) {
  if (isMainTurn) return
  const run = await changeRun($, now => {
    if (now.current && now.steps[now.current].status === 'sent') return undefined
    const next = STEPS.find(s => now.steps[s].status === 'waiting')
    // A step that goes writes more: its commit is offered again once the run is done.
    return next ? { ...setStep(now, next, { status: 'sent' }), current: next, isCommitDone: undefined } : { ...now, current: null }
  })
  const step = run?.current
  if (!run || !step) return
  const w = await wordsIn($)
  if (step === 'openspec') {
    const r = await $.process
      .run(['openspec', 'init', '--tools', 'claude', '--no-animation'], { cwd: run.root, timeoutMs: 120_000 })
      .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    const isDone = r.exitCode === 0 && (await exists($, run.root, 'openspec'))
    const why = (r.stderr || r.stdout).trim().split('\n').at(-1) || `exit ${r.exitCode}`
    await changeStep($, step, isDone ? { status: 'done' } : { status: 'failed', error: w.openspecFailed(why) })
    if (isDone) await advance($)
    return
  }
  const found = await preflight($, run.root)
  if (step === 'matt') {
    const command = found.setupCommand ?? `${MATT}:setup-matt-pocock-skills`
    // In the mod's language, which the skill does not know of.
    const ran = await $.command.run({ command, ...(w.speak ? { args: w.speak } : {}) }).then(
      () => true,
      () => false,
    )
    if (!ran) await changeStep($, step, { status: 'failed', error: `/${command}` })
    return
  }
  const text = w.prompts[step](STEPS.indexOf(step) + 1, { skills: found.skills, hasOpenspec: found.openspec !== null, ci: found.ci, deny: DENY, lenses: lensTitles(await langIn($)) })
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) await changeStep($, step, { status: 'failed', error: r.drop })
}

// A main turn ended with an answer: the step with Claude is done once its files are there and pass
// the check; where they fail, what failed goes back once, then it waits for the person.
async function afterTurn($: EngineInterface) {
  await lookForTaskRules($).catch(() => {})
  // What was found stale, looked for again: the turn may have settled it.
  if (drift.length > 0 || unfound.length > 0) {
    const found = await driftIn($, await $.session.root()).catch(() => undefined)
    if (found) await keepDrift($, found)
  }
  const issues = await checkProject($)
  await settleStep($, issues)
  await startJudge($).catch(() => {})
}

async function settleStep($: EngineInterface, issues: DocIssue[] | null) {
  const run = await read($, runAtom)
  const step = run?.current
  if (!run || !step || run.steps[step].status !== 'sent') return void (await advance($))
  if (step !== 'existing' && step !== 'lenses' && !(await isWritten($, run.root, step))) return
  const failing = await failingOf($, run.root, step, issues)
  // Only while the step is still with Claude: the person may have skipped or sent it again meanwhile.
  const settle = (state: StepState) => changeRun($, now => (now.current === step && now.steps[step].status === 'sent' ? setStep(now, step, state) : undefined))
  if (failing.length === 0) {
    await settle({ status: 'done' })
    return void (await advance($))
  }
  if (run.steps[step].isFixSent) {
    await settle({ status: 'failed', isFixSent: true })
    return
  }
  await sendFix($, step, failing)
}

// What fails of a step: the check of its files, and its own. The step of permissions checks the
// settings whole: the check of the files holds them only once they have one of the rules. What may
// have gone stale is a question for the person, not a failure: no edit of the step settles it.
async function failingOf($: EngineInterface, root: string, step: StepId, issues: DocIssue[] | null) {
  return [...(issues ?? []).filter(i => CHECKED[step](i.file) && i.kind !== 'stale-map' && step !== 'permissions'), ...(await stepIssues($, root, step))]
}

async function sendFix($: EngineInterface, step: StepId, failing: DocIssue[]) {
  const w = await wordsIn($)
  // Only to the current step: one skipped meanwhile has nothing to fix.
  if (!(await changeRun($, now => (now.current === step ? setStep(now, step, { status: 'sent', isFixSent: true }) : undefined)))) return
  const r = await $.prompt.submit({ text: w.prompts.fix(w.steps[step], failing), asUser: true })
  if (r.drop !== undefined) await changeStep($, step, { status: 'failed', error: r.drop })
}

export function startSetupTurn($: EngineInterface, text: string) {
  isMainTurn = true
  turnBefore = watched($).catch(() => ({}))
  generation += 1
  const chain = gatePrompt && text.includes(gatePrompt.text.slice(0, 200)) ? gatePrompt.chain : { rounds: 0, last: null }
  gatePrompt = null
  gateTurn = { before: treesNow($).catch(() => ({})), edited: [], seen: 0, chain, generation }
  isStopSeen = false
}

export function endSetupTurn($: EngineInterface, reason: TurnCompleteReason) {
  isMainTurn = false
  // Taken now: the next turn may start, and take its own, while this one's gate runs.
  const turn = gateTurn
  gateTurn = null
  if (reason === 'answer') {
    if (!isStopSeen) void gateAfterTurn($, turn).catch(() => {})
    void afterTurn($).catch(() => {})
  } else turnBefore = null
}

// An edit to one of the files is checked beside the turn; any edit is a change the gate looks at.
export function afterSetupEdit($: EngineInterface, path: string) {
  gateTurn?.edited.push(path)
  if (DOC_PATH.test(path)) void checkProject($).catch(() => {})
}

// The tree of each folder the fast checks run in, by the folder.
async function treesOf($: EngineInterface, root: string, fast: Record<string, string[]>): Promise<Trees> {
  const exec = execOf($)
  return Object.fromEntries(await Promise.all(Object.keys(fast).map(async f => [f, await fingerprintOf(exec, joinRel(root, f))] as const)))
}

async function treesNow($: EngineInterface) {
  const root = await $.session.root()
  return treesOf($, root, (await configIn($, root))?.checks?.fast ?? {})
}

const headsOf = (trees: Trees) => Object.fromEntries(Object.entries(trees).map(([f, t]) => [f, t.head]))

// The gate: at the end of a main turn that changed the project, the fast checks of
// `.claude/agent-lens.json` run, and what is red that was not red on the commit before goes back to
// Claude to fix, a few times at most, then to the person. Sent back, a turn that changes nothing has
// said the red is not of its changes: it is let go, not sent back again for the same red. While
// /setup-project's steps go, it waits: they write the docs and the checks themselves, and the
// baseline is taken at the end of theirs.
async function runGate($: EngineInterface, turn: GateTurn | null) {
  const root = await $.session.root()
  const fast = (await configIn($, root))?.checks?.fast
  if (!fast || Object.values(fast).every(list => list.length === 0)) return undefined
  if (!turn || isRunning(await read($, runAtom))) return undefined
  const chain = turn.chain
  const isContinued = chain.rounds > 0
  const since = chain.last ?? (await turn.before)
  const now = await treesOf($, root, fast)
  const isEdited = turn.edited.slice(turn.seen).some(p => below(p, root) !== undefined)
  turn.seen = turn.edited.length
  const w = await wordsIn($)
  if (!isEdited && Object.keys(now).every(f => since[f]?.tree === now[f]?.tree)) {
    if (!isContinued) return undefined
    await update($, gateAtom, (g): Gate => ({ status: 'answered', rounds: chain.rounds, failures: g?.failures ?? [] }))
    chain.rounds = 0
    await $.ui.toast(w.gateAnswered)
    return undefined
  }
  chain.last = now
  const { failures } = await runTier(execOf($), root, fast, { isFast: true, now: () => $.clock.now() })
  if (failures.length === 0) {
    chain.rounds = 0
    await update($, gateAtom, (): Gate => ({ status: 'green', rounds: 0, failures: [] }))
    return undefined
  }
  const heads = headsOf(now)
  const baseline = ((await $.store.get(baseKey(root)).catch(() => undefined)) ?? {}) as Record<string, Baseline>
  const red = newRed(failures, baseline, heads)
  if (red.length === 0) {
    const was = await read($, gateAtom)
    chain.rounds = 0
    await update($, gateAtom, (): Gate => ({ status: 'base', rounds: 0, failures }))
    if (was?.status !== 'base') await $.ui.toast(w.gateBase)
    return undefined
  }
  if (chain.rounds >= GATE_ROUNDS) {
    await update($, gateAtom, (): Gate => ({ status: 'released', rounds: chain.rounds, failures: red }))
    await $.ui.toast(w.gateReleased(chain.rounds))
    chain.rounds = 0
    return undefined
  }
  chain.rounds += 1
  await update($, gateAtom, (): Gate => ({ status: 'red', rounds: chain.rounds, failures: red }))
  // What was red before the agent, as far as it is known: on this commit, on another, or never taken.
  const known = red.some(f => !baseline[f.folder]?.sha) ? 'none' : red.some(f => baseline[f.folder]!.sha !== heads[f.folder]) ? 'other' : 'same'
  return w.gateBlock(red, chain.rounds, GATE_ROUNDS, known)
}

// Where classic hooks run, the gate keeps the same turn going; one another hook keeps going already
// is checked at its next stop.
export async function gateStop($: Parameters<Hook<'classic.Stop'>>[0], e: Parameters<Hook<'classic.Stop'>>[1], next: StopNext) {
  isStopSeen = true
  const result = await next(e)
  if (result.block !== undefined) return result
  const text = await runGate($, gateTurn).catch(() => undefined)
  return text ? { ...result, block: text } : result
}

// Where none runs, what is red goes as the next prompt.
async function gateAfterTurn($: EngineInterface, turn: GateTurn | null) {
  const text = await runGate($, turn)
  if (!text || !turn) return
  // Not where the person started a turn while the checks ran: that turn's end is checked in its turn,
  // and the row does not say this red went back.
  if (turn.generation !== generation) return void (await update($, gateAtom, () => null))
  gatePrompt = { text, chain: turn.chain }
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) gatePrompt = null
}

// The files the docs agent watches: all of them in a project set up; elsewhere CLAUDE.md, kept
// from growing.
async function watched($: EngineInterface): Promise<Record<string, string>> {
  const root = await $.session.root()
  if (await isSetUp($)) return readDocs($, root)
  const claude = await $.fs.read(joinPath(root, 'CLAUDE.md')).catch(() => undefined)
  return claude === undefined ? {} : { 'CLAUDE.md': claude }
}

const lineCount = (text: string) => text.trimEnd().split('\n').length

// A step with Claude: the run goes on. One stopped on a failed check, waiting for the person, does not.
const isRunning = (run: Run | null) => run !== null && STEPS.some(s => run.steps[s].status === 'sent')

const clipped = (text: string) => (text.length > EDIT_LIMIT ? `${text.slice(0, EDIT_LIMIT)}\n[... ${text.length - EDIT_LIMIT} more characters]` : text)

// Once a turn edited the files of a project set up, an agent reads the edits against the code:
// one at a time, a run past its time taken as gone.
async function startJudge($: EngineInterface) {
  // A turn whose start was not seen (a reload under it) has nothing to compare with.
  const snapshot = turnBefore
  turnBefore = null
  if (!snapshot) return
  const turn = await snapshot
  const root = await $.session.root()
  const isProject = await isSetUp($)
  const after = await watched($)
  const changed = [...new Set([...Object.keys(turn), ...Object.keys(after)])].filter(rel => turn[rel] !== after[rel])
  for (const rel of changed) if (!runBefore.has(rel)) runBefore.set(rel, turn[rel])
  // Steps still to go write more of the files: read once the run has ended, not after each.
  if (isRunning(await read($, runAtom))) return
  const before = new Map(runBefore)
  runBefore.clear()
  // Elsewhere, only a CLAUDE.md that grew.
  const edited = [...before.keys()]
    .filter(rel => before.get(rel) !== after[rel])
    .filter(rel => isProject || (rel === 'CLAUDE.md' && lineCount(after[rel] ?? '') > lineCount(before.get(rel) ?? '')))
    .sort()
  if (edited.length === 0) return
  const at = await $.clock.now()
  const was = await read($, judgeAtom)
  if (was?.status === 'running' && at - was.at < JUDGE_STALE_MS) return
  const w = await wordsIn($)
  // What changed, line by line, rather than both sides whole: the agent reads the file for the rest.
  const edits = edited
    .map(rel => {
      const [then, now] = [before.get(rel), after[rel]]
      const head = `=== ${rel} ===${LIMITS[rel] !== undefined && now !== undefined ? ` (${lineCount(now)} lines of its ${LIMITS[rel]})` : ''}`
      if (then === undefined) return `${head}\nWritten anew:\n<<<\n${clipped(now ?? '')}\n>>>`
      if (now === undefined) return `${head}\nDeleted.`
      const { added, removed } = diffLines(then, now)
      const said = (list: string[], mark: string) => list.filter(l => l.trim() !== '').map(l => `${mark} ${l}`)
      const [plus, minus] = [said(added, '+'), said(removed, '-')]
      return [head, ...(plus.length > 0 ? ['Added:', clipped(plus.join('\n'))] : []), ...(minus.length > 0 ? ['Removed:', clipped(minus.join('\n'))] : [])].join('\n')
    })
    .join('\n\n')
  const agentId = await spawnAgent($, w.judgePrompt(root, edits), w.judgeTask, JUDGE_MODEL)
  await update($, judgeAtom, (): Judge => ({ status: agentId ? 'running' : 'failed', at, findings: [], ...(agentId ? { agentId } : {}) }))
}

// The docs agent, started on a task: its id, or none where it did not start.
async function spawnAgent($: EngineInterface, prompt: string, task: string, model: string) {
  const spawned = await $.agent.spawn({ prompt, description: task, subagentType: 'Explore', model }).catch(() => undefined)
  const agentId =
    spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === task)?.id : undefined)
  if (agentId) judges.add(agentId)
  return agentId
}

// A subagent's run ended: the docs agent's, its findings are read, or its word on the terms kept.
export async function endSetupAgent($: EngineInterface, agentId: string, answer: string) {
  const check = await read($, termsAtom)
  if (check?.status === 'running' && check.agentId === agentId) return endTermCheck($, check, answer)
  const judge = await read($, judgeAtom)
  if (judge?.status !== 'running' || judge.agentId !== agentId) return
  const findings = parseFindings(answer)
  await update($, judgeAtom, (): Judge => ({ ...judge, status: findings ? 'done' : 'failed', findings: findings ?? [] }))
  if (findings && findings.some(f => !f.isMinor)) await $.ui.toast((await wordsIn($)).band(findings.filter(f => !f.isMinor).length))
}

// The docs agent's word on the terms, matched whatever its spelling of them: a term it left out of
// its list it did not find; with no list, the terms are unjudged.
async function endTermCheck($: EngineInterface, check: TermCheck, answer: string) {
  const inUse = parseTermsInUse(answer)
  if (inUse) {
    const used = new Set(inUse)
    const at = await $.clock.now()
    await keepVerdicts($, await $.session.root(), Object.fromEntries(check.terms.map(t => [termKey(t), { verdict: used.has(t.term.toLowerCase()) ? 'used' : 'unused', at }])))
  } else for (const t of check.terms) unjudged.add(termKey(t))
  await update($, termsAtom, (): TermCheck => ({ ...check, status: inUse ? 'done' : 'failed' }))
  // Terms git found while it read go to it next.
  await checkTerms($)
  const n = (await read($, questionsAtom))?.length ?? 0
  if (n > 0) await $.ui.toast((await wordsIn($)).termsBand(n))
}

// The docs agent's report the engine hands back as it ends is the pane's, not Claude's to read.
export async function judgeReport($: EngineInterface, text: string) {
  const terms = (await read($, termsAtom))?.agentId
  if (terms && text.includes(terms)) return (await wordsIn($)).termsTitle
  const kept = (await read($, judgeAtom))?.agentId
  return [...judges, ...(kept ? [kept] : [])].some(id => text.includes(id)) ? (await wordsIn($)).judgeTitle : undefined
}

async function sendFindings($: EngineInterface) {
  const judge = await read($, judgeAtom)
  if (!judge || judge.status !== 'done' || judge.isSent || judge.findings.length === 0) return
  await update($, judgeAtom, () => ({ ...judge, isSent: true as const }))
  const r = await $.prompt.submit({ text: (await wordsIn($)).judgeFix(judge.findings), asUser: true })
  if (r.drop !== undefined) await update($, judgeAtom, () => judge)
}

export async function registerSetup($: EngineInterface) {
  await $.command.register({ name: 'setup-project', description: (await wordsIn($)).description, argumentHint: '[check]' })
}

// At the session's start, and after a /clear: the run of this project back, its files checked.
export async function startSetup($: EngineInterface) {
  await registerSetup($)
  const root = await $.session.root()
  const kept = (await $.store.get(runKey(root)).catch(() => undefined)) as Run | undefined
  // A run kept by a version with fewer steps: the steps it has not, skipped.
  const steps = kept && (Object.fromEntries(STEPS.map(s => [s, kept.steps[s] ?? { status: 'skipped' }])) as Run['steps'])
  await update($, runAtom, () => (kept && steps ? { ...kept, steps } : null))
  await checkProject($).catch(() => {})
  unfound = []
  later.clear()
  unjudged.clear()
  lastAnswer = null
  void lookForDrift($).catch(() => {})
  rulesSentIn = null
  void lookForTaskRules($).catch(() => {})
}

// In any project with OpenSpec, set up or not: OpenSpec gives the agent that builds a change the
// rules of the artifacts only while it writes them, so a config whose tasks do not name the rules
// and lenses they touch leaves the agent to find them once it broke them. Offered to be added, once
// it is sent; let go for good where the person says so. A row and no toast: it stands until it is
// answered, and a toast at every session of a project would be noise. While /setup-project's steps
// go, its own step adds it.
async function lookForTaskRules($: EngineInterface) {
  const root = await $.session.root()
  const config = await readRel($, root, 'openspec/config.yaml')
  const isMissing = config !== undefined && config.trim() !== '' && !hasTaskRules(config)
  if (!isMissing && rulesSentIn === root) rulesSentIn = null
  const isDismissed = (await $.store.get(rulesDismissedKey(root)).catch(() => undefined)) === true
  const isOffered = isMissing && !isDismissed && rulesSentIn !== root && !isRunning(await read($, runAtom))
  await update($, rulesOfferAtom, () => (isOffered ? {} : null))
}

export async function rulesLine($: EngineInterface) {
  return (await read($, rulesOfferAtom)) ? (await wordsIn($)).rulesOffer : null
}

export async function addTaskRules($: EngineInterface) {
  if (!(await read($, rulesOfferAtom)) || isRunning(await read($, runAtom))) return
  const lang = await langIn($)
  const r = await $.prompt.submit({ text: WORDS[lang].rulesPrompt(lensTitles(lang)), asUser: true })
  if (r.drop !== undefined) return
  rulesSentIn = await $.session.root()
  await update($, rulesOfferAtom, () => null)
}

export async function dismissTaskRules($: EngineInterface) {
  await $.store.set(rulesDismissedKey(await $.session.root()), true)
  await update($, rulesOfferAtom, () => null)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: (await wordsIn($)).title, focus: true, closeOnEscape: true })
}

export async function openSetup($: EngineInterface) {
  await checkProject($).catch(() => {})
  await openPane($)
}

// `/setup-project`: what it needs, said in a line; the run started, or the one under way shown.
// `/setup-project check`: the check of the files.
export async function setupCommand($: EngineInterface, args: string) {
  const w = await wordsIn($)
  const root = await $.session.root()
  if (args.trim().toLowerCase() === 'check') {
    await keepDrift($, await driftIn($, root).catch(() => ({ issues: [], terms: [] })))
    const issues = (await checkProject($)) ?? [...(await issuesIn($, root)), ...drift]
    const asked = ((await read($, questionsAtom)) ?? []).map((t): DocIssue => ({ file: t.file, kind: 'stale-term', detail: t.term }))
    const check = await read($, termsAtom)
    return { text: [w.checked([...issues, ...asked]), ...(check?.status === 'running' ? [w.termsRunning(check.terms.length)] : [])].join('\n') }
  }
  // What is red now on each folder's commit, kept as the baseline: the person's word that it was
  // red before the agent.
  if (args.trim().toLowerCase() === 'baseline') {
    const taken = await takeBaseline($, root)
    if (!taken) return { text: w.noChecks }
    await $.store.set(baseKey(root), taken.baseline)
    await update($, gateAtom, () => null)
    return { text: w.baselineKept(taken.failures) }
  }
  const found = await preflight($, root)
  let run = await read($, runAtom)
  if (!run || STEPS.every(s => ['done', 'skipped'].includes(run!.steps[s].status))) {
    const steps = {} as Record<StepId, StepState>
    for (const s of STEPS) {
      const needs = needsOf(s, found, w)
      steps[s] = needs ? { status: 'skipped', needs } : { status: (await isWritten($, root, s)) ? 'done' : 'waiting' }
    }
    // A run again with nothing to send has written nothing new to commit since the last.
    const isCommitDone = run?.isCommitDone === true && STEPS.every(s => steps[s].status !== 'waiting')
    run = { root, steps, current: null, ...(isCommitDone ? { isCommitDone } : {}) }
    await keepRun($, run)
  }
  await openSetup($)
  // The run's own step adds the rule: the row does not offer it beside.
  await lookForTaskRules($).catch(() => {})
  void advance($).catch(() => {})
  return { text: `${w.ready(found)}\n${w.opened}` }
}

// Whether this project was prepared by /setup-project, or is being.
export async function isSetUp($: EngineInterface) {
  return (await read($, runAtom)) !== null || (await exists($, await $.session.root(), MARK))
}

// A change was archived: where Matt's retro is installed, the row offers it, the person's to run.
export async function offerRetro($: EngineInterface, change: string) {
  const command = (await $.command.list().catch(() => [])).find(c => c.name === `${MATT}:retro` || (c.plugin === MATT && c.name.endsWith('retro')))?.name
  if (!command) return
  await update($, retroAtom, () => ({ change, command }))
  await $.ui.toast((await wordsIn($)).retroOffer(change))
}

// Matt's retro, run as if the person typed it, on the work of the change; or the offer let go.
export async function runRetro($: EngineInterface) {
  const retro = await read($, retroAtom)
  if (!retro) return
  await update($, retroAtom, () => null)
  await $.command.run({ command: retro.command, args: (await wordsIn($)).retroArgs(retro.change) }).catch(async () => {
    await update($, retroAtom, () => retro)
  })
}

export async function dismissRetro($: EngineInterface) {
  await update($, retroAtom, () => null)
}

export async function retroLine($: EngineInterface) {
  const retro = await read($, retroAtom)
  return retro ? (await wordsIn($)).retroOffer(retro.change) : null
}

// The row above the prompt: the files' issues and the docs agent's blockers not sent, the terms that
// wait for the person, and the gate's red, while there are some.
export async function setupLine($: EngineInterface) {
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
  const blockers = judge?.status === 'done' && !judge.isSent ? judge.findings.filter(f => !f.isMinor).length : 0
  const n = issues.length + blockers
  const w = await wordsIn($)
  const gate = await read($, gateAtom)
  const asked = (await read($, questionsAtom))?.length ?? 0
  const parts = [...(n > 0 ? [w.band(n)] : []), ...(asked > 0 ? [w.termsBand(asked)] : []), ...(gate && (gate.status === 'red' || gate.status === 'released' || gate.status === 'answered') ? [w.gateBand(gate.failures.length)] : [])]
  return parts.length > 0 ? parts.join(' · ') : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const run = await read($, runAtom)
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
  const gate = await read($, gateAtom)
  const termCheck = await read($, termsAtom)
  const questions = (await read($, questionsAtom)) ?? []
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})
  const keyed = (key: string, text: string, hotkey: string, onPress: () => void, isPrimary = false) => (
    <Button key={key} label={text} hotkey={hotkey} {...(isPrimary ? { variant: 'primary' as const } : { dimColor: true as const })} onPress={onPress}>
      <Text dimColor>{hotkey}</Text>
      {` ${text}`}
    </Button>
  )
  const icon: Record<StepState['status'], [string, 'success' | 'warning' | 'error' | undefined]> = {
    waiting: ['○', undefined],
    sent: ['◌', 'warning'],
    done: ['✓', 'success'],
    skipped: ['–', undefined],
    failed: ['✗', 'error'],
  }
  const current = run?.current ?? null
  const state = current ? run!.steps[current] : null
  const isIdle = !state || state.status !== 'sent'
  const hasWaiting = run ? STEPS.some(s => run.steps[s].status === 'waiting') : false
  // The current step stopped on a failed check has its own buttons below the steps.
  const isRerunnable = (s: StepState, step: StepId) => !rerunning.has(step) && (s.status === 'skipped' || (s.status === 'failed' && step !== current))
  const skip = (step: StepId) => act(async () => {
    await changeRun($, now => ({ ...setStep(now, step, { status: 'skipped' }), current: null }))
    await advance($)
  })
  const again = (step: StepId) => act(async () => {
    await changeRun($, now => ({ ...setStep(now, step, { status: 'waiting' }), current: null }))
    await advance($)
  })
  // A step left out, or stopped on a failed check once the run went past it, started again from its
  // row: it waits in its turn among the others, and the step with Claude, if any, stays its current.
  // One left out for what was missing is checked for it again, and waits only once it is there; a
  // step that stands on another left out brings that one back with it.
  const rerun = (step: StepId) => act(async () => {
    if (rerunning.has(step)) return
    rerunning.add(step)
    try {
      const was = await read($, runAtom)
      if (!was) return
      const under = STANDS_ON[step]
      // What the step stands on left out for what is missing is missing for the step too.
      const isNeeded = was.steps[step].needs !== undefined || (under !== undefined && was.steps[under].needs !== undefined)
      const needs = isNeeded ? needsOf(step, await preflight($, was.root), w) : undefined
      // On the run as it is now: it may have moved on while what is installed was looked for.
      const changed = await changeRun($, now => {
        if (!['skipped', 'failed'].includes(now.steps[step].status)) return undefined
        const next = setStep(now, step, needs ? { status: 'skipped', needs } : { status: 'waiting' })
        // Not the one stopped on its check as the current: its error and buttons stay the person's.
        const isUnderBack = !needs && under !== undefined && (next.steps[under].status === 'skipped' || (next.steps[under].status === 'failed' && next.current !== under))
        return under && isUnderBack ? setStep(next, under, { status: 'waiting' }) : next
      })
      if (!changed) return
      if (needs) return void (await $.ui.toast(needs))
      await advance($)
    } finally {
      rerunning.delete(step)
    }
  })
  // The commit of what the steps wrote, sent or let go: not offered again until a step goes again.
  // Kept before it is sent, so a key pressed twice sends it once; back where it did not go.
  const commitDone = () => changeRun($, now => (now.isCommitDone ? undefined : { ...now, isCommitDone: true }))
  const commit = act(async () => {
    if (!(await commitDone())) return
    const r = await $.prompt.submit({ text: w.commitPrompt, asUser: true })
    if (r.drop !== undefined) await changeRun($, ({ isCommitDone: _, ...now }) => now)
  })
  const fix = (step: StepId) => act(async () => {
    const now = await read($, runAtom)
    if (!now) return
    await sendFix($, step, await failingOf($, now.root, step, await checkProject($)))
  })
  return (
    <Box flexDirection="column" gap={1}>
      {run ? (
        <Box flexDirection="column">
          {STEPS.map((step, i) => {
            const s = run.steps[step]
            const [mark, color] = icon[s.status]
            return (
              <Box key={`step-${step}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={color}>{mark}</Text>
                  <Text bold={step === current}>{`${i + 1}. ${w.steps[step]}`}</Text>
                  <Text dimColor>{`· ${w.status[s.status]}${s.isFixSent && s.status === 'sent' ? ` · ${w.fixSent}` : ''}`}</Text>
                  {isRerunnable(s, step) ? <Button key={`setup-rerun-${step}`} label={w.rerun} plain dimColor onPress={rerun(step)} /> : null}
                </Box>
                {s.error ? (
                  <Text color="error" wrap="wrap">
                    {`  ${s.error}`}
                  </Text>
                ) : null}
                {s.needs && s.status === 'skipped' ? (
                  <Text dimColor wrap="wrap">
                    {`  ${s.needs}`}
                  </Text>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Text dimColor>{w.notSetUp}</Text>
      )}
      {run ? (
        <Box flexDirection="row" gap={1}>
          {isIdle && hasWaiting ? keyed('setup-next', w.next, 'n', act(() => advance($)), true) : null}
          {current && state?.status === 'failed' ? keyed('setup-fix', w.fix, 'f', fix(current), true) : null}
          {current && state && state.status !== 'done' && state.status !== 'skipped' ? keyed('setup-again', w.again, 'a', again(current)) : null}
          {current && state && state.status !== 'done' && state.status !== 'skipped' ? keyed('setup-skip', w.skip, 's', skip(current)) : null}
        </Box>
      ) : null}
      {run && STEPS.every(s => ['done', 'skipped'].includes(run.steps[s].status)) ? (
        <Box flexDirection="column">
          <Text color="success">{`✓ ${w.allDone}`}</Text>
          {run.isCommitDone ? null : (
            <Box flexDirection="row" gap={1}>
              {keyed('setup-commit', w.commit, 'c', commit, true)}
              <Text dimColor>{w.commitHint}</Text>
              {keyed('setup-commit-skip', w.skip, 's', act(commitDone))}
            </Box>
          )}
        </Box>
      ) : null}
      {judge ? (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{w.judgeTitle}</Text>
            {judge.status === 'done' && judge.findings.length > 0 && !judge.isSent ? keyed('setup-judge-send', w.judgeSend(judge.findings.length), 'j', act(() => sendFindings($)), true) : null}
            {judge.isSent ? <Text dimColor>{`→ ${w.judgeSent}`}</Text> : null}
          </Box>
          {judge.status === 'running' ? (
            <Text color="warning">{`◌ ${w.judgeRunning}`}</Text>
          ) : judge.status === 'failed' ? (
            <Text color="error">{`✗ ${w.judgeFailed}`}</Text>
          ) : judge.findings.length === 0 ? (
            <Text color="success">{`✓ ${w.judgeNone}`}</Text>
          ) : (
            judge.findings.map((f: Finding, i) => (
              <Box key={`finding-${i}`} flexDirection="column" paddingLeft={2}>
                <Text color={f.isMinor ? undefined : 'warning'} wrap="wrap">{`• ${f.file}: ${f.text}${f.isMinor ? ` (${w.minor})` : ''}`}</Text>
                {f.fix ? <Text dimColor wrap="wrap">{`  → ${f.fix}`}</Text> : null}
              </Box>
            ))
          )}
        </Box>
      ) : null}
      {questions.length > 0 || termCheck?.status === 'running' || lastAnswer ? (
        <Box flexDirection="column">
          <Text bold>{w.termsTitle}</Text>
          {termCheck?.status === 'running' ? <Text color="warning">{`◌ ${w.termsRunning(termCheck.terms.length)}`}</Text> : null}
          {questions[0] ? (
            <Box flexDirection="column">
              <Text color="warning" wrap="wrap">
                {w.termQuestion(questions[0], unjudged.has(termKey(questions[0])))}
              </Text>
              <Box flexDirection="row" gap={1}>
                {keyed('setup-term-kept', w.termKept, 'u', act(() => answerTerm($, questions[0]!, 'kept')), true)}
                {keyed('setup-term-drop', w.termDrop, 'r', act(() => answerTerm($, questions[0]!, 'drop')))}
                {keyed('setup-term-later', w.termLater, 'l', act(() => answerTerm($, questions[0]!, 'later')))}
                {questions.length > 1 ? <Text dimColor>{w.termsMore(questions.length - 1)}</Text> : null}
              </Box>
            </Box>
          ) : null}
          {lastAnswer ? (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{`→ ${w.termAnswered(lastAnswer.term, lastAnswer.answer)}`}</Text>
              {keyed('setup-term-undo', w.termUndo, 'z', act(() => undoTerm($)))}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {gate ? (
        <Box flexDirection="column">
          <Text bold>{w.gateTitle}</Text>
          <Text color={gate.status === 'green' ? 'success' : gate.status === 'base' || gate.status === 'answered' ? undefined : 'error'} wrap="wrap">
            {w.gateStatus(gate, GATE_ROUNDS)}
          </Text>
          {gate.failures.map((f, i) => (
            <Text key={`gate-${i}`} dimColor wrap="wrap">
              {`  • ${whereOf(f)} (exit ${f.exitCode})`}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column">
        <Text bold>{w.checkTitle}</Text>
        {issues.length === 0 ? (
          <Text color="success">{`✓ ${w.checkClean}`}</Text>
        ) : (
          issues.map((issue, i) => (
            <Text key={`issue-${i}`} color="warning" wrap="wrap">
              {`• ${w.issue(issue)}`}
            </Text>
          ))
        )}
      </Box>
    </Box>
  )
}
