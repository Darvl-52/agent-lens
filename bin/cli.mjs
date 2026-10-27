#!/usr/bin/env node
// The checks of agent-lens outside Claude Code, for CI: the same check of the docs the mod runs, and
// the tiers of `.claude/agent-lens.json`, from the folder it is run in. `bun run build` bundles it
// with the mod's code into bin/agent-lens.mjs, which is what npx runs: Node strips no types from a
// package's own files.
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { CONFIG, parseConfig, runTier, whereOf } from '../hooks/setup/checks'
import { issuesIn } from '../hooks/setup/docs'
import { WORDS } from '../hooks/setup/words'

const root = process.cwd()
const w = WORDS.en

const disk = {
  read: rel => readFile(join(root, rel), 'utf8').catch(() => undefined),
  exists: rel => stat(join(root, rel)).then(() => true, () => false),
  list: rel =>
    readdir(join(root, rel), { withFileTypes: true }).then(
      entries => entries.filter(e => e.isFile() || e.isDirectory()).map(e => ({ name: e.name, kind: e.isFile() ? 'file' : 'dir' })),
      () => [],
    ),
}

// The groups of the commands running now: a CI job cancelled sends its signal to this process
// alone, so it is passed on to each, and the CLI exits as a process the signal ended.
const live = new Set()
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]])
  process.once(signal, () => {
    for (const pid of live)
      try {
        process.kill(-pid, signal)
      } catch {}
    process.exit(code)
  })

// A command run as the mod runs it, what it writes passed through as it comes, so the CI log has
// all of it, and kept for the summary at the end. It runs in a group of its own: past its time the
// whole group goes, as a test runner the shell started would hold the pipes open after the shell.
const exec = (argv, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const isShown = argv[0] !== 'git' && !(argv[0] === 'sh' && argv[2] === 'exit 0')
    const isGroup = process.platform !== 'win32'
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: isGroup })
    if (isGroup && child.pid) live.add(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => ((stdout += d), isShown && process.stdout.write(d)))
    child.stderr.on('data', d => ((stderr += d), isShown && process.stderr.write(d)))
    const timer = setTimeout(() => {
      try {
        if (isGroup) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
    }, timeoutMs)
    const done = () => (clearTimeout(timer), live.delete(child.pid))
    child.on('error', err => (done(), reject(err)))
    child.on('close', code => (done(), resolve({ exitCode: code ?? -1, stdout, stderr })))
  })

async function check() {
  const issues = await issuesIn(disk)
  console.log(w.checked(issues))
  return issues.length === 0 ? 0 : 1
}

async function checks(tierName) {
  if (tierName !== 'fast' && tierName !== 'full') return usage()
  const text = await disk.read(CONFIG)
  if (text === undefined) {
    console.error(`${CONFIG} is not here: /setup-project writes it.`)
    return 1
  }
  const { config, issues } = parseConfig(text)
  if (issues.length > 0) {
    console.error(issues.map(i => w.issue(i)).join('\n'))
    return 1
  }
  const tier = config.checks?.[tierName] ?? {}
  if (Object.values(tier).every(list => list.length === 0)) {
    console.log(`No ${tierName} checks in ${CONFIG}.`)
    return 0
  }
  const { failures, timings, skipped } = await runTier(exec, root, tier, { isFast: tierName === 'fast', now: () => Date.now() })
  // A command that takes the changed files has none on a clean tree, as in CI: said, not hidden.
  const lines = [...timings.map(t => `${t.exitCode === 0 ? '✓' : '✗'} ${whereOf(t)} (${Math.round(t.ms / 1000)}s)`), ...skipped.map(t => `– ${whereOf(t)} (no changed files for it)`)]
  console.log(`\n${lines.join('\n')}`)
  return failures.length === 0 ? 0 : 1
}

function usage() {
  console.error('agent-lens check          the check of the docs /setup-project writes\nagent-lens checks fast    the fast tier of .claude/agent-lens.json\nagent-lens checks full    the full tier')
  return 2
}

const [verb, arg] = process.argv.slice(2)
const code = verb === 'check' ? await check() : verb === 'checks' ? await checks(arg) : usage()
process.exit(code)
