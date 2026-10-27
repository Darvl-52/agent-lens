import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, TurnCompleteReason } from 'claude-code'

import type { Baseline, DocIssue, Finding, Gate, Judge, Run, StepId, StepState } from '../../types/setup'
import type { PaneHook, StopNext } from '../core/hooks'
import { langIn } from '../core/lang'
import { below, joinPath, parentOf } from '../review/diff'
import { diffLines } from '../spec/spec'
import { baselineOf, CONFIG, DENY, type Exec, fingerprintOf, joinRel, newRed, parseConfig, permissionIssues, runTier, SETTINGS, timingIssues, whereOf } from './checks'
import { ADR_DIR, type Disk, issuesIn as issuesOf, LIMITS, OLD_GLOSSARIES, parseFindings, pathsIn, readDocs as readDocsOf, termsOf } from './docs'
import { WORDS } from './words'

// /setup-project: prepares a project for work with the agent, one step at a time, each sent to the
// session once the turn before it has ended, and keeps the files those steps write to their form.
// The way of it is docs/setup-project.md.

const runAtom = atom({ plugin: 'agent-lens', key: 'setup.run' } as const, null)
const issuesAtom = atom({ plugin: 'agent-lens', key: 'setup.issues' } as const, null)
const judgeAtom = atom({ plugin: 'agent-lens', key: 'setup.judge' } as const, null)
const retroAtom = atom({ plugin: 'agent-lens', key: 'setup.retro' } as const, null)
const gateAtom = atom({ plugin: 'agent-lens', key: 'setup.gate' } as const, null)
export const PANE = 'agent-lens-setup'
const runKey = (root: string) => `setup:${root}`
// What the fast checks were red on, by folder, on the commit they ran on before the agent.
const baseKey = (root: string) => `setup:base:${root}`

// The checks come once the linter has the standards' rules; how work goes once there are commands
// to point to; CI last, as it runs what the steps before it wrote.
const STEPS: StepId[] = ['matt', 'openspec', 'existing', 'map', 'standards', 'checks', 'run', 'permissions', 'workflow', 'config', 'ci']
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
// own: it is done with the turn that answers it.
const WRITES: Record<StepId, string[]> = {
  matt: ['docs/agents/issue-tracker.md', 'docs/agents/domain.md'],
  openspec: ['openspec/config.yaml'],
  existing: [],
  map: ['GLOSSARY.md', 'ARCHITECTURE.md'],
  standards: ['CODING_STANDARDS.md'],
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
  checks: f => f === CONFIG,
  run: f => f === CONFIG,
  permissions: f => f === SETTINGS,
  workflow: f => f === 'docs/agents/workflow.md' || f === 'CLAUDE.md',
  config: () => false,
  ci: () => false,
}
// Where a project keeps its CI: a step that adds a job there has nothing to add to where there is none.
const CI_FILES = ['.gitlab-ci.yml', '.github/workflows', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml', 'Jenkinsfile']
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
// What may have gone stale, as last looked for: at the session's start and on /setup-project check.
let drift: DocIssue[] = []
// The docs agents this module started, by id, as long as it runs.
const judges = new Set<string>()
const JUDGE_MODEL = 'sonnet'
const JUDGE_STALE_MS = 20 * 60_000
// What each file the agent is shown keeps of each side of an edit.
const EDIT_LIMIT = 12_000
// A part of the map with this many commits since the map was edited may have moved on from it.
const STALE_COMMITS = 15
// How many of the map's paths and the glossary's terms are looked up, at most.
const DRIFT_PATHS = 40
const DRIFT_TERMS = 80
const DOC_PATH = /(?:^|[\\/])(?:CLAUDE|AGENTS|GLOSSARY|GLOSSARY-MAP|CONTEXT|CONTEXT-MAP|ARCHITECTURE|CODING_STANDARDS|workflow)\.md$|[\\/]docs[\\/]adr[\\/][^\\/]+\.md$/

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
// edited, and each glossary term found nowhere else in its repository. Looked for beside the
// session's start, as it runs git once per path and term.
async function driftIn($: EngineInterface, root: string) {
  const files = await readDocs($, root)
  const git = (cwd: string, args: string[]) => $.process.run(['git', '-C', cwd, ...args], { cwd, timeoutMs: 15_000 }).catch(() => null)
  const found: DocIssue[] = []
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
      const r = await git(at, ['grep', '-I', '-q', '-i', '-F', '-e', term, '--', '.', ':(exclude,glob)**/GLOSSARY*.md'])
      // 1: none found; anything else (no repository, an error) says nothing.
      if (r?.exitCode === 1) found.push({ file, kind: 'stale-term', detail: term })
    }
  return found
}

async function lookForDrift($: EngineInterface) {
  const root = await $.session.root()
  if (!(await read($, runAtom)) && !(await exists($, root, MARK))) return
  drift = await driftIn($, root)
  await checkProject($)
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
  if (step === 'config') return ((await readRel($, root, 'openspec/config.yaml')) ?? '').includes('GLOSSARY.md')
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

// Sends the next step not done, unless one is with Claude or a turn runs; openspec init the mod
// runs itself.
async function advance($: EngineInterface) {
  if (isMainTurn) return
  let run = await read($, runAtom)
  if (!run || (run.current && run.steps[run.current].status === 'sent')) return
  const step = STEPS.find(s => run!.steps[s].status === 'waiting')
  if (!step) {
    await keepRun($, { ...run, current: null })
    return
  }
  const w = await wordsIn($)
  run = { ...setStep(run, step, { status: 'sent' }), current: step }
  await keepRun($, run)
  if (step === 'openspec') {
    const r = await $.process
      .run(['openspec', 'init', '--tools', 'claude', '--no-animation'], { cwd: run.root, timeoutMs: 120_000 })
      .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    const isDone = r.exitCode === 0 && (await exists($, run.root, 'openspec'))
    const why = (r.stderr || r.stdout).trim().split('\n').at(-1) || `exit ${r.exitCode}`
    await keepRun($, setStep(run, step, isDone ? { status: 'done' } : { status: 'failed', error: w.openspecFailed(why) }))
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
    if (!ran) await keepRun($, setStep(run, step, { status: 'failed', error: `/${command}` }))
    return
  }
  const text = w.prompts[step](STEPS.indexOf(step) + 1, { skills: found.skills, hasOpenspec: found.openspec !== null, ci: found.ci, deny: DENY })
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) await keepRun($, setStep(run, step, { status: 'failed', error: r.drop }))
}

// A main turn ended with an answer: the step with Claude is done once its files are there and pass
// the check; where they fail, what failed goes back once, then it waits for the person.
async function afterTurn($: EngineInterface) {
  const issues = await checkProject($)
  await settleStep($, issues)
  await startJudge($).catch(() => {})
}

async function settleStep($: EngineInterface, issues: DocIssue[] | null) {
  const run = await read($, runAtom)
  const step = run?.current
  if (!run || !step || run.steps[step].status !== 'sent') return void (await advance($))
  if (step !== 'existing' && !(await isWritten($, run.root, step))) return
  const failing = await failingOf($, run.root, step, issues)
  if (failing.length === 0) {
    await keepRun($, setStep(run, step, { status: 'done' }))
    return void (await advance($))
  }
  if (run.steps[step].isFixSent) {
    await keepRun($, setStep(run, step, { status: 'failed', isFixSent: true }))
    return
  }
  await sendFix($, run, step, failing)
}

// What fails of a step: the check of its files, and its own. The step of permissions checks the
// settings whole: the check of the files holds them only once they have one of the rules.
async function failingOf($: EngineInterface, root: string, step: StepId, issues: DocIssue[] | null) {
  return [...(issues ?? []).filter(i => CHECKED[step](i.file) && step !== 'permissions'), ...(await stepIssues($, root, step))]
}

async function sendFix($: EngineInterface, run: Run, step: StepId, failing: DocIssue[]) {
  const w = await wordsIn($)
  await keepRun($, setStep(run, step, { status: 'sent', isFixSent: true }))
  const r = await $.prompt.submit({ text: w.prompts.fix(w.steps[step], failing), asUser: true })
  if (r.drop !== undefined) await keepRun($, setStep(run, step, { status: 'failed', error: r.drop }))
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
  const task = w.judgeTask
  const spawned = await $.agent.spawn({ prompt: w.judgePrompt(root, edits), description: task, subagentType: 'Explore', model: JUDGE_MODEL }).catch(() => undefined)
  const agentId =
    spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === task)?.id : undefined)
  if (agentId) judges.add(agentId)
  await update($, judgeAtom, (): Judge => ({ status: agentId ? 'running' : 'failed', at, findings: [], ...(agentId ? { agentId } : {}) }))
}

// A subagent's run ended: the docs agent's, its findings are read.
export async function endSetupAgent($: EngineInterface, agentId: string, answer: string) {
  const judge = await read($, judgeAtom)
  if (judge?.status !== 'running' || judge.agentId !== agentId) return
  const findings = parseFindings(answer)
  await update($, judgeAtom, (): Judge => ({ ...judge, status: findings ? 'done' : 'failed', findings: findings ?? [] }))
  if (findings && findings.some(f => !f.isMinor)) await $.ui.toast((await wordsIn($)).band(findings.filter(f => !f.isMinor).length))
}

// The docs agent's report the engine hands back as it ends is the pane's, not Claude's to read.
export async function judgeReport($: EngineInterface, text: string) {
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
  void lookForDrift($).catch(() => {})
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
    drift = await driftIn($, root).catch(() => [])
    const issues = (await checkProject($)) ?? [...(await issuesIn($, root)), ...drift]
    return { text: w.checked(issues) }
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
    run = { root, steps, current: null }
    await keepRun($, run)
  }
  await openSetup($)
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

// The row above the prompt: the files' issues and the docs agent's blockers not sent, while there are some.
export async function setupLine($: EngineInterface) {
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
  const blockers = judge?.status === 'done' && !judge.isSent ? judge.findings.filter(f => !f.isMinor).length : 0
  const n = issues.length + blockers
  const w = await wordsIn($)
  const gate = await read($, gateAtom)
  const parts = [...(n > 0 ? [w.band(n)] : []), ...(gate && (gate.status === 'red' || gate.status === 'released' || gate.status === 'answered') ? [w.gateBand(gate.failures.length)] : [])]
  return parts.length > 0 ? parts.join(' · ') : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const run = await read($, runAtom)
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
  const gate = await read($, gateAtom)
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
  const skip = (step: StepId) => act(async () => {
    const now = await read($, runAtom)
    if (!now) return
    await keepRun($, { ...setStep(now, step, { status: 'skipped' }), current: null })
    await advance($)
  })
  const again = (step: StepId) => act(async () => {
    const now = await read($, runAtom)
    if (!now) return
    await keepRun($, { ...setStep(now, step, { status: 'waiting' }), current: null })
    await advance($)
  })
  const fix = (step: StepId) => act(async () => {
    const now = await read($, runAtom)
    if (!now) return
    await sendFix($, now, step, await failingOf($, now.root, step, await checkProject($)))
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
          <Box flexDirection="row" gap={1}>
            {keyed('setup-commit', w.commit, 'c', act(async () => $.prompt.submit({ text: w.commitPrompt, asUser: true })))}
            <Text dimColor>{w.commitHint}</Text>
          </Box>
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
