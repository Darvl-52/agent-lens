#!/usr/bin/env node
// The checks of agent-lens outside Claude Code, for CI: the same check of the docs the mod runs, and
// the tiers of `.claude/agent-lens.json`, from the folder it is run in. `bun run build` bundles it
// with the mod's code into bin/agent-lens.mjs, which is what npx runs: Node strips no types from a
// package's own files.
import { spawn, spawnSync } from 'node:child_process'
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

// The whole tree of a command, killed: its group elsewhere, and on Windows, where a group is no
// such thing and a kill ends the shell alone, every process under it by taskkill.
const isWindows = process.platform === 'win32'
function killTree(pid, signal = 'SIGKILL') {
  if (!pid) return
  if (isWindows) {
    // Synchronous, so a tree is gone before the CLI exits on a signal.
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {}
}

// The commands running now: a CI job cancelled sends its signal to this process alone, so it is
// passed on to each tree, and the CLI exits as a process the signal ended.
const live = new Set()
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]])
  process.once(signal, () => {
    for (const pid of live) killTree(pid, signal)
    process.exit(code)
  })

// How long the pipes may stay open once the command exited: a process it left behind holding them
// (a watcher, a server a test started) does not hold the run.
const PIPE_GRACE_MS = 2_000

// A command run as the mod runs it, what it writes passed through as it comes, so the CI log has
// all of it, and kept for the summary at the end. It runs in a group of its own: past its time the
// whole tree goes, as a test runner the shell started would hold the pipes open after the shell.
// It ends on the exit, what is still in the pipes read for a moment; past its time it rejects, as
// the engine's run does, saying it timed out.
const exec = (argv, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const isShown = argv[0] !== 'git' && !(argv[0] === 'sh' && argv[2] === 'exit 0')
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true })
    if (child.pid) live.add(child.pid)
    let stdout = ''
    let stderr = ''
    let isTimedOut = false
    let isSettled = false
    child.stdout.on('data', d => ((stdout += d), isShown && process.stdout.write(d)))
    child.stderr.on('data', d => ((stderr += d), isShown && process.stderr.write(d)))
    let grace
    // Past its time the tree is killed; a child that does not even exit then is let go after the grace.
    const timer = setTimeout(() => {
      isTimedOut = true
      killTree(child.pid)
      setTimeout(() => settle(null), PIPE_GRACE_MS).unref()
    }, timeoutMs)
    const settle = code => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      clearTimeout(grace)
      live.delete(child.pid)
      child.stdout.destroy()
      child.stderr.destroy()
      if (isTimedOut) reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(' ')}`), { stdout, stderr }))
      else resolve({ exitCode: code ?? -1, stdout, stderr })
    }
    child.on('error', err => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      live.delete(child.pid)
      reject(err)
    })
    child.on('exit', code => {
      grace = setTimeout(() => settle(code), PIPE_GRACE_MS)
    })
    child.on('close', code => settle(code))
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
