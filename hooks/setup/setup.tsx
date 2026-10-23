import { atom, read, update } from 'claude-code'
import type { EngineInterface, TurnCompleteReason } from 'claude-code'

import type { DocIssue, Finding, Judge, Run, StepId, StepState } from '../../types/setup'
import type { PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { below, joinPath, parentOf } from '../review/diff'
import { ADR_DIR, checkDocs, DOC_FILES, firstOf, mappedGlossaries, parseFindings, pathsIn, pathsNamed, termsOf } from './docs'
import { WORDS } from './words'

// /setup-project: prepares a project for work with the agent, one step at a time, each sent to the
// session once the turn before it has ended, and keeps the files those steps write to their form.
// The way of it is docs/setup-project.md.

const runAtom = atom({ plugin: 'agent-lens', key: 'setup.run' } as const, null)
const issuesAtom = atom({ plugin: 'agent-lens', key: 'setup.issues' } as const, null)
const judgeAtom = atom({ plugin: 'agent-lens', key: 'setup.judge' } as const, null)
export const PANE = 'agent-lens-setup'
const runKey = (root: string) => `setup:${root}`

const STEPS: StepId[] = ['matt', 'openspec', 'map', 'standards', 'workflow', 'config']
// The skills of Matt's the way of working stands on; the first sets the project up for the rest.
const MATT = 'mattpocock-skills'
const MATT_SKILLS = ['setup-matt-pocock-skills', 'domain-modeling', 'writing-for-agents', 'grilling', 'tdd', 'retro']
// A project is set up once this file is there: from then on its files are checked.
const MARK = 'docs/agents/workflow.md'

// The files each step writes: the step is done once they are there and pass the check. Matt's
// skill writes its own and keeps them to its own form.
const WRITES: Record<StepId, string[]> = {
  matt: ['docs/agents/issue-tracker.md', 'docs/agents/domain.md'],
  openspec: ['openspec/config.yaml'],
  map: ['GLOSSARY.md', 'ARCHITECTURE.md'],
  standards: ['CODING_STANDARDS.md'],
  workflow: ['docs/agents/workflow.md', 'CLAUDE.md'],
  config: ['openspec/config.yaml'],
}
const CHECKED: Record<StepId, (file: string) => boolean> = {
  matt: () => false,
  openspec: () => false,
  map: f => /(^|\/)GLOSSARY(-MAP)?\.md$/.test(f) || f === 'ARCHITECTURE.md' || f.startsWith(`${ADR_DIR}/`),
  standards: f => f === 'CODING_STANDARDS.md',
  workflow: f => f === 'docs/agents/workflow.md' || f === 'CLAUDE.md',
  config: () => false,
}

// Whether the main loop is in a turn: a step waits for its end.
let isMainTurn = false
// What each of the files was before the turn's first edit to it, by its path from the root (null
// for one it wrote anew): what the docs agent is shown the turn changed.
const turnBefore = new Map<string, string | null>()
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
const DOC_PATH = /(?:^|[\\/])(?:CLAUDE|GLOSSARY|GLOSSARY-MAP|ARCHITECTURE|CODING_STANDARDS|workflow)\.md$|[\\/]docs[\\/]adr[\\/][^\\/]+\.md$/

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

async function exists($: EngineInterface, root: string, rel: string) {
  return $.fs.exists(joinPath(root, rel)).catch(() => false)
}

// The CLI's version, or null where it does not run. npm installs it on Windows as `openspec.cmd`.
async function openspecVersion($: EngineInterface, root: string) {
  const run = (cli: string) => $.process.run([cli, '--version'], { cwd: root, timeoutMs: 15_000 })
  const r = await run('openspec')
    .catch(() => run('openspec.cmd'))
    .catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim().split('\n').at(-1)!.trim() : null
}

// What /setup-project needs: Matt's skills by the name each runs by, and the OpenSpec CLI.
async function preflight($: EngineInterface, root: string) {
  const commands = await $.command.list().catch(() => [])
  const named = (skill: string) => commands.find(c => c.name === `${MATT}:${skill}` || (c.plugin === MATT && c.name.endsWith(skill)))?.name
  const missing = MATT_SKILLS.filter(s => !named(s))
  const openspec = await openspecVersion($, root)
  return { missing, setupCommand: named('setup-matt-pocock-skills') ?? `${MATT}:setup-matt-pocock-skills`, openspec, isInitialised: await exists($, root, 'openspec') }
}

// The files the check reads: those named, the glossaries the map links, the ADRs.
async function readDocs($: EngineInterface, root: string) {
  const files: Record<string, string> = {}
  const take = async (rel: string) => {
    const text = await $.fs.read(joinPath(root, rel)).catch(() => undefined)
    if (text !== undefined) files[rel] = text
  }
  await Promise.all(DOC_FILES.map(take))
  if (files['GLOSSARY-MAP.md']) await Promise.all(mappedGlossaries(files['GLOSSARY-MAP.md']).map(take))
  const adrs = await $.fs.list(joinPath(root, ADR_DIR)).catch(() => [])
  await Promise.all(adrs.filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => take(`${ADR_DIR}/${f.name}`)))
  return files
}

async function issuesIn($: EngineInterface, root: string) {
  const files = await readDocs($, root)
  // Missing: not there, where it claims the project's own folder.
  const named = pathsNamed(files)
  const missing = await Promise.all(named.map(async p => !(await exists($, root, p)) && (!p.includes('/') || (await exists($, root, firstOf(p))))))
  return checkDocs(files, new Set(named.filter((_, i) => missing[i])))
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

async function isWritten($: EngineInterface, root: string, step: StepId) {
  if (step === 'config') return (await $.fs.read(joinPath(root, 'openspec/config.yaml')).catch(() => '')).includes('GLOSSARY.md')
  const there = await Promise.all(WRITES[step].map(f => exists($, root, f)))
  return there.every(Boolean)
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
  if (step === 'matt') {
    const command = (await preflight($, run.root)).setupCommand
    const ran = await $.command.run({ command }).then(
      () => true,
      () => false,
    )
    if (!ran) await keepRun($, setStep(run, step, { status: 'failed', error: `/${command}` }))
    return
  }
  const r = await $.prompt.submit({ text: w.prompts[step](), asUser: true })
  if (r.drop !== undefined) await keepRun($, setStep(run, step, { status: 'failed', error: r.drop }))
}

// A main turn ended with an answer: the step with Claude is done once its files are there and pass
// the check; where they fail, what failed goes back once, then it waits for the person.
async function afterTurn($: EngineInterface) {
  const issues = await checkProject($)
  await startJudge($).catch(() => {})
  const run = await read($, runAtom)
  const step = run?.current
  if (!run || !step || run.steps[step].status !== 'sent') return void (await advance($))
  if (!(await isWritten($, run.root, step))) return
  const failing = (issues ?? []).filter(i => CHECKED[step](i.file))
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

async function sendFix($: EngineInterface, run: Run, step: StepId, failing: DocIssue[]) {
  const w = await wordsIn($)
  await keepRun($, setStep(run, step, { status: 'sent', isFixSent: true }))
  const r = await $.prompt.submit({ text: w.prompts.fix(w.steps[step], failing), asUser: true })
  if (r.drop !== undefined) await keepRun($, setStep(run, step, { status: 'failed', error: r.drop }))
}

export function startSetupTurn() {
  isMainTurn = true
  turnBefore.clear()
}

export function endSetupTurn($: EngineInterface, reason: TurnCompleteReason) {
  isMainTurn = false
  if (reason === 'answer') void afterTurn($).catch(() => {})
  else turnBefore.clear()
}

// Before an edit to one of the files, what it was: the first edit of the turn keeps it.
export async function beforeSetupEdit($: EngineInterface, path: string) {
  if (!DOC_PATH.test(path)) return
  const rel = below(path, await $.session.root())
  if (rel === undefined || turnBefore.has(rel)) return
  turnBefore.set(rel, await $.fs.read(path).catch(() => null))
}

// An edit to one of the files is checked beside the turn.
export function afterSetupEdit($: EngineInterface, path: string) {
  if (DOC_PATH.test(path)) void checkProject($).catch(() => {})
}

const clipped = (text: string) => (text.length > EDIT_LIMIT ? `${text.slice(0, EDIT_LIMIT)}\n[... ${text.length - EDIT_LIMIT} more characters]` : text)

// Once a turn edited the files of a project set up, an agent reads the edits against the code:
// one at a time, a run past its time taken as gone.
async function startJudge($: EngineInterface) {
  const root = await $.session.root()
  const edited = [...turnBefore]
  turnBefore.clear()
  if (edited.length === 0 || (!(await read($, runAtom)) && !(await exists($, root, MARK)))) return
  const at = await $.clock.now()
  const was = await read($, judgeAtom)
  if (was?.status === 'running' && at - was.at < JUDGE_STALE_MS) return
  const w = await wordsIn($)
  const sides = await Promise.all(
    edited.map(async ([rel, before]) => {
      const after = await $.fs.read(joinPath(root, rel)).catch(() => null)
      if (after === before) return ''
      return `=== ${rel} ===\n${before === null ? 'Written anew:' : `Before:\n<<<\n${clipped(before)}\n>>>\nAfter:`}\n<<<\n${clipped(after ?? '(deleted)')}\n>>>`
    }),
  )
  const edits = sides.filter(Boolean).join('\n\n')
  if (edits === '') return
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
  await update($, runAtom, () => kept ?? null)
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
  const found = await preflight($, root)
  if (found.missing.length > 0) return { text: w.noMatt(found.missing) }
  if (found.openspec === null) return { text: w.noOpenspec }
  let run = await read($, runAtom)
  if (!run || STEPS.every(s => ['done', 'skipped'].includes(run!.steps[s].status))) {
    const steps = {} as Record<StepId, StepState>
    for (const s of STEPS) steps[s] = { status: (await isWritten($, root, s)) ? 'done' : 'waiting' }
    run = { root, steps, current: null }
    await keepRun($, run)
  }
  await openSetup($)
  void advance($).catch(() => {})
  return { text: `${w.ready(found.openspec, found.isInitialised)}\n${w.opened}` }
}

// The row above the prompt: the files' issues and the docs agent's blockers not sent, while there are some.
export async function setupLine($: EngineInterface) {
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
  const blockers = judge?.status === 'done' && !judge.isSent ? judge.findings.filter(f => !f.isMinor).length : 0
  const n = issues.length + blockers
  return n > 0 ? (await wordsIn($)).band(n) : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const run = await read($, runAtom)
  const issues = (await read($, issuesAtom)) ?? []
  const judge = await read($, judgeAtom)
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
    await sendFix($, now, step, ((await checkProject($)) ?? []).filter(i => CHECKED[step](i.file)))
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
      {run && STEPS.every(s => ['done', 'skipped'].includes(run.steps[s].status)) ? <Text color="success">{`✓ ${w.allDone}`}</Text> : null}
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
