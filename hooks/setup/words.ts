import type { Lang } from '../../types'
import type { DocIssue, Finding, Gate, GateFailure, StepId, Term } from '../../types/setup'

// What /setup-project found installed, as its first line says it.
type Ready = { missing: string[]; openspec: string | null; isInitialised: boolean; ci: string[] }
// What a step's prompt is told of the project: the skills of Matt's there are, whether OpenSpec runs,
// where the CI is, the rules every project's settings get.
type Ctx = { skills: string[]; hasOpenspec: boolean; ci: string[]; deny: string[] }

// The files and what each holds, as the docs agent is told them.
const ROLES = `- CLAUDE.md: pointers to the files below, and the few rules every turn needs. 120 lines at most.
- GLOSSARY.md: the project's own domain terms, a definition of a sentence or two each and the words to avoid. No paths, code or decisions.
- ARCHITECTURE.md: the map: modules, their bounds, who calls whom, where the data lives. 150 lines at most.
- docs/adr/NNNN-slug.md: one decision each that is hard to reverse, surprising, and the result of a trade-off, and why.
- CODING_STANDARDS.md: rules for code a reviewer can check an edit against. 300 lines at most.
- LENSES.md: the kinds of mistake this project's reviews catch, beyond the mod's own lenses, each with where to look for it; not rules of one edit, which go to CODING_STANDARDS.md. 150 lines at most.
- docs/agents/workflow.md: how work goes, step by step, and where the person decides.`

// Russian plural: 1 проблема, 2 проблемы, 5 проблем.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// What a step tells Claude first: which step it is, and that it adds to what is there.
const leadEn = (n: number, what: string) =>
  `Step ${n} of /setup-project, which prepares this project for work with the agent: ${what}. Add to what is there; never write over it, and ask me before taking out anything I wrote.`
const leadRu = (n: number, what: string) =>
  `Шаг ${n} из /setup-project, который готовит проект к работе с агентом: ${what}. Дополняй то, что есть; ничего не перезаписывай и спроси меня, прежде чем убрать что-то, что написал я. Вопросы, варианты ответов и итоги — по-русски.`

const EN = {
  description: 'Prepare the project for work with the agent: the glossary and the map, the coding standards, the checks and the gate on them, how work goes; check: the check of those files; baseline: what is red now, kept as red before the agent',
  title: 'Setup',
  // What is installed: recommended, never required.
  ready: (found: Ready): string =>
    [
      found.missing.length === 0 ? '✓ Matt’s skills installed' : `○ Matt’s skills recommended (${found.missing.join(', ')} missing): /plugin install mattpocock-skills`,
      found.openspec === null ? '○ OpenSpec recommended: npm install -g @fission-ai/openspec' : `✓ OpenSpec ${found.openspec}${found.isInitialised ? ', openspec/ is here' : ', a step initialises openspec/'}`,
      found.ci.length > 0 ? `✓ CI: ${found.ci.join(', ')}` : '○ no CI: its step is left out',
    ].join(' · ') + (found.missing.length > 0 || found.openspec === null ? '\nThe steps that need what is missing are left out; installed later, /setup-project once the run is done brings them in.' : ''),
  needsMatt: 'left out: Matt’s skills are not installed (/plugin install mattpocock-skills)',
  needsOpenspec: 'left out: the OpenSpec CLI is not installed (npm install -g @fission-ai/openspec)',
  needsCi: 'left out: the project has no CI to add a job to',
  opened: 'Opened the setup: the steps go to Claude one at a time.',
  // The pane.
  steps: {
    matt: 'Matt’s skills: the tracker, the labels, the domain layout',
    openspec: 'OpenSpec in the project',
    existing: 'What is already written',
    map: 'The map: glossary, architecture, ADRs',
    standards: 'The coding standards',
    checks: 'The checks, and the gate at each turn’s end',
    run: 'Bringing the project up, and its smoke test',
    permissions: 'What the agent may and may not run',
    workflow: 'How work goes, and CLAUDE.md',
    config: 'OpenSpec reads the files',
    ci: 'The checks in CI',
  } as Record<StepId, string>,
  status: { waiting: 'waiting', sent: 'with Claude', done: 'done', skipped: 'skipped', failed: 'check failed' },
  fixSent: 'what failed went back to Claude',
  next: 'send the next step',
  skip: 'skip',
  again: 'send again',
  fix: 'send what failed',
  allDone: 'Every step is done. The files are checked at each session’s start and at the end of each turn that edits them; the fast checks at the end of each turn that changes the project.',
  commit: 'commit the setup',
  commitHint: 'Commit what the steps wrote: the map is checked for staleness against its last commit.',
  commitPrompt:
    'Commit the files /setup-project wrote (CLAUDE.md, GLOSSARY.md, ARCHITECTURE.md, CODING_STANDARDS.md, docs/, openspec/, .claude/agent-lens.json, .claude/settings.json, the CI job, the smoke test, and what openspec init put in .claude/). First show me git status; commit only those, with a message in the style of the project’s commits.',
  checkTitle: 'The check of the files',
  checkClean: 'The files pass the check.',
  notSetUp: 'This project is not set up yet: /setup-project.',
  // The row above the prompt.
  band: (n: number) => `docs: ${n} ${n === 1 ? 'issue' : 'issues'}`,
  // /setup-project check.
  checked: (issues: DocIssue[]) => (issues.length === 0 ? 'The files pass the check.' : `The check found ${issues.length}:\n${issues.map(i => `  ${EN.issue(i)}`).join('\n')}`),
  issue: (i: DocIssue): string => {
    const at = `${i.file}${i.line ? `:${i.line}` : ''}`
    const what: Record<DocIssue['kind'], string> = {
      size: `past its size (${i.detail} lines): move what another file holds there`,
      path: `names \`${i.detail}\`, which is not there`,
      'glossary-shape': 'not a term entry: **Term**:, a definition, _Avoid_:',
      'glossary-name': `the glossary by its old name, which Matt’s skills no longer read: git mv it to ${i.detail}, and name ${i.detail} in docs/agents/domain.md`,
      'glossary-long': 'a definition longer than two sentences',
      'glossary-path': 'a path in the glossary: it holds terms, not code',
      'glossary-code': 'code in the glossary',
      'adr-name': 'an ADR not named NNNN-slug.md',
      'adr-numbers': `the ADR numbers skip or repeat (at ${i.detail})`,
      'adr-title': 'an ADR with no # title',
      duplicate: `the same line as in ${i.detail}: keep it in one file`,
      'stale-map': `may be stale: ${i.detail} commits to it since the map was last edited`,
      'stale-term': `the docs agent found the term "${i.detail}" nowhere outside the glossaries, in any form or name: still in use?`,
      'checks-shape': `out of its form: ${i.detail}`,
      'checks-start': `the fast check \`${i.detail}\` does not start: not found or not executable from its folder`,
      'checks-slow': `the fast check ${i.detail} is too slow for every turn’s end: move it to full, or give it {files}`,
      'permissions-shape': `out of its form: ${i.detail}`,
      'permissions-deny': `permissions.deny lacks what cannot be taken back: ${i.detail}`,
    }
    return `${at}: ${what[i.kind]}`
  },
  // The gate.
  gateTitle: 'The gate: the fast checks at the turn’s end',
  gateStatus: (g: Gate, max: number): string =>
    g.status === 'green' ? '✓ green at the last turn’s end'
    : g.status === 'base' ? '○ red as on this commit before the agent: not sent back (/setup-project baseline once fixed)'
    : g.status === 'released' ? `✗ red after ${g.rounds} rounds: let go, yours to look at`
    : g.status === 'answered' ? '○ red, held by Claude as not of its changes: let go (/setup-project baseline keeps it)'
    : `✗ red: sent back to Claude (round ${g.rounds} of ${max})`,
  gateBand: (n: number) => `checks: ${n} red`,
  gateBase: 'The fast checks are red as on this commit before the agent: the gate lets the turn end. Fix the base first, then /setup-project baseline, or the gate holds no turn to them.',
  gateReleased: (rounds: number) => `The fast checks are still red after ${rounds} rounds: the gate let the turn end. /setup-project shows what.`,
  gateAnswered: 'Sent back, Claude changed nothing: it holds the red is not of its changes. The gate let the turn end; /setup-project baseline keeps it as red before the agent.',
  gateBlock: (failures: GateFailure[], round: number, max: number, known: 'same' | 'other' | 'none'): string =>
    `The project's fast checks (.claude/agent-lens.json) are red after this turn (round ${round} of ${max}). Fix what your changes broke, run the command again to see it green, then end the turn. Where a failure is not of your changes, say so in a line and end the turn without changing anything; do not weaken a check or a test to pass it.${known === 'other' ? ' What was red before you is known for another commit only, so this red may be older than your changes.' : known === 'none' ? ' What was red before you was never taken, so this red may be older than your changes.' : ''}\n\n${failures
      .map(f => `$ ${f.folder === '.' ? '' : `(in ${f.folder}) `}${f.command}   → exit ${f.exitCode}\n${f.output}`)
      .join('\n\n')}`,
  noChecks: 'The project has no fast checks in .claude/agent-lens.json: /setup-project writes them.',
  // OpenSpec's config with no rule for the tasks to name their rules and lenses.
  rulesOffer: 'OpenSpec’s config has the tasks name no rules or lenses of the code, so the agent that builds a change meets them only once it broke them: add the rule?',
  rulesPrompt: (lenses: string[]): string =>
    `Add one rule to this project's \`openspec/config.yaml\`, as OpenSpec gives the agent that builds a change the rules of the artifacts only while it writes them, and \`tasks.md\` is what it reads as it builds.

Find the artifact of the config's schema that writes the tasks (\`tasks\` in most; \`openspec schemas\` or the schema's file says), and add to its list under \`rules\`, creating the list where there is none and keeping all that is there, in the file's language and form: each task names, by their names, the rules of the code it touches, from the files the project keeps them in (CLAUDE.md, AGENTS.md, CODING_STANDARDS.md, the rule files of its parts: read which there are and name those), and the lenses it touches, from LENSES.md where the project has one, and from these of agent-lens: ${lenses.join('; ')}. Change nothing else. Then run \`openspec validate --all --strict\`, and show me the rule as you wrote it.`,
  baselineKept: (failures: GateFailure[]): string =>
    failures.length === 0 ? 'The fast checks are green on this commit: nothing kept as red before the agent.' : `Kept as red before the agent on this commit: ${failures.map(f => f.command).join(', ')}. The gate does not send these back until the commit changes.`,
  // The docs agent.
  judgeTask: 'The docs in this turn',
  judgePrompt: (root: string, edits: string): string =>
    `Read what this turn changed in the files the agent and the person of the project at ${root} work by, and report what should not be there. The files and what each holds:
${ROLES}

For each change, check it against the code (read it): is it true of the code now; is it in the file it belongs in; does it change what an agent does or would it change nothing (a no-op, a wish, a truism); does it repeat what another of the files already says; does it pass what its file may hold. A blocker: untrue, in the wrong file, or repeated. A minor one: a no-op, or wordier than it needs. CLAUDE.md is read into every turn of every agent, so it must not grow: each line added to it is a pointer, or a rule every turn needs; anything else is a blocker, and its fix names the file it belongs in (GLOSSARY.md, CODING_STANDARDS.md, docs/agents/workflow.md, an ADR, a skill of the project). Report only what the change added or altered, not what was there before; none is a good answer. Do not change any file.

${edits}

End your answer with JSON alone: [{"file": "the file", "problem": "what is wrong, one sentence", "fix": "what to do, one sentence", "severity": "blocker" or "minor"}], or [] when there is nothing.`,
  judgeTitle: 'What the docs agent found in the last edits',
  judgeRunning: 'The docs agent is reading the last edits against the code…',
  judgeFailed: 'The docs agent gave no list.',
  judgeNone: 'The docs agent found nothing to take out.',
  judgeSend: (n: number) => `send to Claude (${n})`,
  judgeSent: 'sent to Claude',
  judgeFix: (findings: Finding[]): string =>
    `The docs agent found these in what was just written to the project's docs. Fix each in its file, or say why it stands; change nothing else:\n${findings.map(f => `- ${f.file}: ${f.text}${f.fix ? ` Fix: ${f.fix}` : ''}`).join('\n')}`,
  // The terms git finds nowhere, read by the docs agent before the person is asked.
  termsTask: 'The glossary terms found nowhere',
  termsPrompt: (root: string, terms: Term[]): string =>
    `In the project at ${root}, git grep found these glossary terms, as the glossary writes them, nowhere outside the glossaries. Find out whether each is still in use. Read its definition in its glossary first, then search the code, the docs and the specs, files not yet committed too, for the thing it names: in any form of the word (another case, number or gender, as Russian inflects it), by a synonym, or by the name the code gives it (often English, or a word its _Avoid_ line lists). It is in use where you find the thing under any of these; it is not where you find it nowhere. Do not change any file.

${terms.map(t => `- "${t.term}" (${t.file})`).join('\n')}

End your answer with JSON alone, an entry for each term: [{"file": "its glossary", "term": "the term", "inUse": true or false, "where": "file: the word you found it by, or empty"}]`,
  termsBand: (n: number) => `glossary: ${n} ${n === 1 ? 'question' : 'questions'}`,
  termsTitle: 'Glossary terms found nowhere',
  termsRunning: (n: number) => `The docs agent is looking for ${n} ${n === 1 ? 'term' : 'terms'} in other forms and names…`,
  // `isUnjudged`: the docs agent did not start, or gave no list; it looks again next session.
  termQuestion: (t: Term, isUnjudged: boolean) =>
    isUnjudged
      ? `"${t.term}" (${t.file}): git found it nowhere outside the glossaries, and the docs agent could not look for its other forms and names. Still in use?`
      : `"${t.term}" (${t.file}): neither git nor the docs agent found it outside the glossaries, in any form or name. Still in use?`,
  termsMore: (n: number) => `${n} more`,
  termKept: 'in use',
  termDrop: 'take it out of the glossary',
  termLater: 'later',
  termUndo: 'undo',
  termAnswered: (t: Term, answer: 'kept' | 'later') => `"${t.term}": ${answer === 'kept' ? 'in use, not asked again' : 'asked again next session or after /clear'}`,
  termDropPrompt: (t: Term) =>
    `The glossary term "${t.term}" in ${t.file} is found nowhere outside the glossaries, in any form or name, by git and the docs agent, and I hold it out of use. Take its entry out of ${t.file}, and where the other docs (ARCHITECTURE.md, the ADRs, CLAUDE.md) name it as a term, say what they mean without it; change nothing else, and show me what you took out.`,
  minor: 'minor',
  // After an archive.
  retroOffer: (change: string): string => `"${change}" is archived: a retro of the work?`,
  retroArgs: (change: string): string => `the work in this session on the OpenSpec change "${change}", up to its archive`,
  // What Matt's skills, written in English, are told beside their task: none where the mod speaks it.
  speak: '',
  // What each step tells Claude.
  prompts: {
    existing: (n: number, _: Ctx): string =>
      `${leadEn(n, 'what is already written')}

Find every document this project's agents and people work by: CLAUDE.md and the files it imports with \`@\`, AGENTS.md, a glossary by its old name (CONTEXT.md, CONTEXT-MAP.md), notes on the architecture and on decisions wherever they lie, the rules of other agents (.cursor/rules, .cursorrules, .github/copilot-instructions.md), the project's skills (.claude/skills, .agents/skills), and the parts of README.md written for those who change the code.

Cut each into pieces (a section, a rule, a fact) and give each piece one home:
${ROLES}
- a rule a tool can check: the linter, at the step of the coding standards; until then it stays where it is.
- where it is: a project skill, the README for people, Matt's docs/agents/.
- out: untrue of the code now, a second copy, or what an agent does anyway.

Put the plan to me with AskUserQuestion, file by file, a few pieces a question with multiSelect, each with its home, and move only what I pick. A piece moves word for word and leaves its old place, so each fact stays in one file. A glossary by its old name moves with \`git mv\` (CONTEXT.md to GLOSSARY.md, CONTEXT-MAP.md to GLOSSARY-MAP.md, with the glossaries it links), and docs/agents/domain.md then names the new name. ADRs kept elsewhere move to docs/adr/, numbered on in order. The steps after this one add what is still missing, so this one writes nothing new.

Done when every piece of every file found has my answer. End with a table: the piece, where it was, where it went.`,
    map: (n: number, _: Ctx): string =>
      `${leadEn(n, 'the map')}

Read the code: its entry points, its modules and what each owns, its data, how they call each other. Then write, adding to each file where it is there:
- \`GLOSSARY.md\` at the root: the project's own domain terms and nothing else. The form: \`# {Context}\` and a sentence or two on what it is; \`## Language\`; for each term \`**Term**:\` on a line, a definition of one or two sentences on the next (what it is, not what it does), and \`_Avoid_: other words\` where the code or people use other words for it. No paths, no code, no decisions, no general programming terms.
- \`ARCHITECTURE.md\` at the root, 150 lines at most: the modules and what each owns, their bounds, who calls whom, where the data lives, where to start reading. Name each module by its path in backticks. Leave out what the code says better.
- \`docs/adr/NNNN-slug.md\`, numbered on from the last number in docs/adr/ (0001 where there is none): one for each decision the code shows that is hard to reverse, would surprise a reader, came from a real trade-off, and no ADR records yet. A \`# title\` and one to three sentences: the context, the decision, why. None where none qualifies.
Where the project has parts with domains of their own (repositories or packages), write a GLOSSARY.md in each part's folder and a GLOSSARY-MAP.md at the root that links them. Where a term or a decision is not clear from the code, ask me instead of guessing. End with what you wrote, file by file.`,
    standards: (n: number, _: Ctx): string =>
      `${leadEn(n, 'the coding standards')}

Read the code and find the rules it keeps: how errors are raised and returned, how files and modules are named and laid out, how the layers call each other, how input is validated, how tests are written and where they go. Take only rules a reviewer can check one edit against; leave out general advice. The rules CODING_STANDARDS.md and the linter's config already hold count as found: put to me only the rules they lack, and offer to move to the linter those in CODING_STANDARDS.md it could check.

Sort each rule:
- mechanical (a banned API or pattern, the shape of an import, where a file lives, a fixed syntactic form): a tool checks it, not prose. Where the project has a linter (eslint, stylelint, ruff, …), it goes to the linter's config as an existing rule, or a small custom one with a test of its own, and the lint script runs it. A rule the linter already enforces is left out.
- a judgement (consistency across files, the right layer, a name that says what it is): it goes to \`CODING_STANDARDS.md\`.
Each rule in a line or two: what, why (the mistake it prevents, in a clause), where it shows (a path), and how it is checked (\`eslint: <rule>\`, \`stylelint: <rule>\`, or \`review\`).

Put the rules to me with AskUserQuestion, a few at a time with multiSelect, saying for each whether it goes to the linter or to the file, and write only those I pick: to the linter's config, and to \`CODING_STANDARDS.md\` at the root, 300 lines at most, grouped by area. Then run the lint script and say what the new rules found.`,
    checks: (n: number, _: Ctx): string =>
      `${leadEn(n, 'the checks')}

Read how this project is checked, whatever its stack: its manifests and scripts (package.json, pyproject.toml, Cargo.toml, go.mod, a Makefile or justfile, the build files), its linters and type checkers, its test runners, what its CI runs. Sort what you find into two tiers:
- fast: runs at the end of each of my agent's turns that changed the project, so seconds, a minute or two at most: lint and the type check, and the tests of the changed files where the runner can take files. Where a command takes files, put \`{files}\` where they go (\`eslint {files}\`, \`vitest related --run {files}\`, \`ruff check {files}\`): it then runs on the files changed against the commit, and not at all where there are none. A tool that fails on a file it does not read takes only its own, by extension: \`{files:py,pyi}\`. A command with no \`{files}\` runs on its whole folder.
- full: before a commit, push or merge: everything (lint, types, all tests, e2e, the build).
Where the project has parts with tools of their own (a monorepo, packages, repositories in folders), give each part's commands by its folder.
Put both tiers to me with AskUserQuestion, then write them to \`.claude/agent-lens.json\`, keeping what else is there: \`{"checks": {"fast": ["…"], "full": ["…"]}}\`, or by folder, \`{"checks": {"fast": {"api": ["…"], "web": ["…"]}, "full": {…}}}\`. Each command is a line for the shell, run from its folder as a person would type it; the project's own scripts where it has them. Do not run them yourself: agent-lens runs the fast tier once the file is written, keeps what is red now as red before you, and tells you what does not start or is too slow.`,
    run: (n: number, _: Ctx): string =>
      `${leadEn(n, 'bringing the project up, and its smoke test')}

Find out what this project is: a service or a web app that is brought up, a command-line tool, a library. A library has nothing to bring up: write \`{"run": null}\` to \`.claude/agent-lens.json\`, keeping what else is there, and stop.
Otherwise find how it is brought up and tried, from what it has (compose files, scripts, a Procfile, the README):
- up: one command that brings it up and returns once it answers, waiting for its health; a server left in the foreground never returns, so use the tool's detach or wait flag, or a script that starts it and waits.
- smoke: one command that tries the main path end to end: an e2e test tagged smoke, a request to its health and one real endpoint, the CLI with \`--help\` and one real command.
- down: what takes it down, where up leaves something running.
Where there is no smoke test, propose to me the smallest one that proves the main path works, in the project's own test runner, and write it only on my yes.
Put the commands to me with AskUserQuestion, write them under \`"run"\` in \`.claude/agent-lens.json\`, keeping what else is there, then run up, smoke and down once and tell me what each did.`,
    permissions: (n: number, ctx: Ctx): string =>
      `${leadEn(n, 'what the agent may and may not run')}

In \`.claude/settings.json\` (create it where there is none; keep all that is there), under \`"permissions"\`:
- \`"deny"\`: always these, which cannot be taken back: ${ctx.deny.map(r => `\`${r}\``).join(', ')}. Then propose to me what else of this project should be off limits: files with real secrets (keys, certificates, an env file with real values; read a file before naming it, as one with local values only is no secret), commands that publish, deploy or reach production.
- \`"allow"\`: the commands of \`.claude/agent-lens.json\` (checks and run) as Bash rules by their prefix (\`Bash(npm run lint:*)\`), git that only reads (status, diff, log, show), the project's test runners.
Put what else to deny and what to allow to me with AskUserQuestion with multiSelect, and write the rules above and what I pick.`,
    workflow: (n: number, ctx: Ctx): string => {
      const has = (skill: string) => ctx.skills.includes(skill)
      const steps = [
        has('grilling') ? 'An idea is grilled with the `grilling` skill before it is proposed.' : 'An idea is talked through with me before it is written down.',
        `${ctx.hasOpenspec ? '`openspec propose` writes it as a change, in the glossary\'s terms' : 'It is written down as a plan in the issue, in the glossary\'s terms'}; ${has('domain-modeling') ? 'while designing, the `domain-modeling` skill: ' : 'while designing, '}a new term to GLOSSARY.md as it settles, a decision that qualifies to docs/adr/.`,
        `${has('tdd') ? 'The tasks are done with the `tdd` skill at the seams the design names' : 'The tasks are done test first where the project has tests, at the seams the design names'}${has('diagnosing-bugs') ? '; a bug with `diagnosing-bugs`' : ''}.`,
        `agent-lens checks each edit against CLAUDE.md and CODING_STANDARDS.md, runs the fast checks at each turn's end and reviews each turn's diff; before a commit or a merge request, the branch through lenses with \`/changes lenses\`${has('code-review') ? ', and the whole change with `code-review`' : ''}.`,
        `${ctx.hasOpenspec ? 'On archive' : 'Once done'}, the change's terms go to GLOSSARY.md and its decisions to docs/adr/${has('retro') ? '; then `/mattpocock-skills:retro`' : ''}.`,
      ]
      return `${leadEn(n, 'how work goes, and CLAUDE.md')}

Write \`docs/agents/workflow.md\` (adding to it where it is there), 120 lines at most, the way work goes in this project, saying at each step where I decide:
${steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}
Then, in the same file:
- When a task is done here: the full tier of \`.claude/agent-lens.json\` green, and the smoke test where it has one; a line each for what else the project has (stories, accessibility checks).
- How the work is shared: the main agent orchestrates (takes the task apart, plans, hands the parts to subagents, keeps their order, decides the architecture, puts the results together and answers me) and does by hand only what is cheaper than explaining it; reading code, implementing, running checks, the browser and reviews go to subagents, started in parallel in one message where the parts are independent, each with its own files (a shared contract first where they depend on each other; \`isolation: "worktree"\` where their files may meet), each prompt self-contained (the goal, the files and what not to touch, these rules, when it is done, what to answer), the answers short; what they report is checked (the full tier) before it is told to me.

Then \`CLAUDE.md\` (create it where there is none), 120 lines at most:
- the language I am spoken to in, as its first rule, where it is not English;
- a short section of pointers to ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md and docs/agents/workflow.md, a line each on when to read it; GLOSSARY.md imported with a line \`@GLOSSARY.md\` where it is under 80 lines, so its terms hold on every turn, else pointed to;
- the rules every turn needs, read from the project's scripts and config: how to install and run (the \`run\` of \`.claude/agent-lens.json\` where it has one); the checks in a line: the fast tier runs by itself at each turn's end, the full tier before a commit, push or merge, sending only on green; their commands are in \`.claude/agent-lens.json\`, not copied here;
- how to commit.
Anything else in it that one of those files holds moves there.`
    },
    config: (n: number, _: Ctx): string =>
      `${leadEn(n, 'OpenSpec reads the files')}

In \`openspec/config.yaml\`, add to \`context\`, keeping what is there, a pointer to each of GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md, LENSES.md where it is there, and docs/agents/workflow.md, a line each on what it holds, never a copy of its text. Add to \`rules\`: the proposal and the specs use the glossary's terms and none of the words it lists under _Avoid_; the design names the ADRs it touches, and a new decision hard to reverse goes to docs/adr/; each task names the test seam it is built at, and the rules of CODING_STANDARDS.md and the lenses it touches, by their names, so they are before the agent that builds it, not found once it broke them (OpenSpec gives the agent the rules of the artifacts only while it writes them, and tasks.md is what it reads as it builds). Then run \`openspec validate --all --strict\` and say what it found.`,
    ci: (n: number, ctx: Ctx): string =>
      `${leadEn(n, 'the checks in CI')}

The project's CI is in ${ctx.ci.map(f => `\`${f}\``).join(', ')}. Add a job that runs on each merge or pull request and on each push to the main branch, so what the gate holds for my agent holds for everyone:
- the check of the docs: \`npx -y github:Darvl-52/agent-lens check\`;
- the full tier: \`npx -y github:Darvl-52/agent-lens checks full\`, in the image the project's own jobs build and test in.
Both read \`.claude/agent-lens.json\` and need Node 20 or later in the job's image. Where the project's image has no Node, give the docs check a job of its own on a Node image, and leave the full tier to the project's jobs that run the same commands; do not copy the commands into the CI. Write the job the way the jobs there are written (stages, images, caches, rules), and show it to me with AskUserQuestion before writing it, saying what it costs: the Node it needs in the image, a job of its own where the image has none. Write it on my yes.`,
    fix: (step: string, issues: DocIssue[]): string =>
      `The check of the files of /setup-project's step "${step}" found these. Fix each in its file and change nothing else:\n${issues.map(i => `- ${EN.issue(i)}`).join('\n')}`,
  },
  openspecFailed: (why: string) => `openspec init did not run: ${why}. Run \`openspec init --tools claude\` yourself, then send the step again.`,
}

const RU: typeof EN = {
  description: 'Подготовить проект к работе с агентом: глоссарий и карта, стандарты кода, проверки и гейт на них, как идёт работа; check: проверка этих файлов; baseline: что красное сейчас, запомнить как красное до агента',
  title: 'Подготовка',
  ready: found =>
    [
      found.missing.length === 0 ? '✓ Скиллы Мэтта установлены' : `○ Рекомендуем скиллы Мэтта (нет: ${found.missing.join(', ')}): /plugin install mattpocock-skills`,
      found.openspec === null ? '○ Рекомендуем OpenSpec: npm install -g @fission-ai/openspec' : `✓ OpenSpec ${found.openspec}${found.isInitialised ? ', openspec/ уже есть' : ', openspec/ создаст один из шагов'}`,
      found.ci.length > 0 ? `✓ CI: ${found.ci.join(', ')}` : '○ CI нет: его шаг пропущен',
    ].join(' · ') + (found.missing.length > 0 || found.openspec === null ? '\nШаги, которым нужно недостающее, пропущены; поставишь позже — /setup-project после конца прогона их добавит.' : ''),
  needsMatt: 'пропущен: не установлены скиллы Мэтта (/plugin install mattpocock-skills)',
  needsOpenspec: 'пропущен: не установлен OpenSpec CLI (npm install -g @fission-ai/openspec)',
  needsCi: 'пропущен: в проекте нет CI, куда добавить задачу',
  opened: 'Открыл подготовку: шаги уходят Claude по одному.',
  steps: {
    matt: 'Скиллы Мэтта: трекер, метки, раскладка домена',
    openspec: 'OpenSpec в проекте',
    existing: 'Что уже написано',
    map: 'Карта: глоссарий, архитектура, ADR',
    standards: 'Стандарты кода',
    checks: 'Проверки и гейт в конце каждого хода',
    run: 'Как поднять проект, и его смоук-тест',
    permissions: 'Что агенту можно и нельзя запускать',
    workflow: 'Как идёт работа, и CLAUDE.md',
    config: 'OpenSpec читает эти файлы',
    ci: 'Проверки в CI',
  },
  status: { waiting: 'ждёт', sent: 'у Claude', done: 'готово', skipped: 'пропущен', failed: 'проверка не прошла' },
  fixSent: 'что не прошло, ушло Claude',
  next: 'отправить следующий шаг',
  skip: 'пропустить',
  again: 'отправить снова',
  fix: 'отправить, что не прошло',
  allDone: 'Все шаги готовы. Файлы проверяются при каждом запуске сессии и в конце каждого хода, который их правит; быстрые проверки — в конце каждого хода, который меняет проект.',
  commit: 'закоммитить подготовку',
  commitHint: 'Закоммить то, что написали шаги: карта сверяется на устаревание с её последним коммитом.',
  commitPrompt:
    'Закоммить файлы, которые написал /setup-project (CLAUDE.md, GLOSSARY.md, ARCHITECTURE.md, CODING_STANDARDS.md, docs/, openspec/, .claude/agent-lens.json, .claude/settings.json, задачу CI, смоук-тест и то, что openspec init положил в .claude/). Сначала покажи мне git status; закоммить только их, сообщением в стиле коммитов проекта.',
  checkTitle: 'Проверка файлов',
  checkClean: 'Файлы проходят проверку.',
  notSetUp: 'Проект ещё не подготовлен: /setup-project.',
  band: n => `docs: ${n} ${plural(n, 'проблема', 'проблемы', 'проблем')}`,
  checked: issues => (issues.length === 0 ? 'Файлы проходят проверку.' : `Проверка нашла ${issues.length}:\n${issues.map(i => `  ${RU.issue(i)}`).join('\n')}`),
  issue: i => {
    const at = `${i.file}${i.line ? `:${i.line}` : ''}`
    const what: Record<DocIssue['kind'], string> = {
      size: `больше своего размера (${i.detail} строк): перенеси то, что место другому файлу`,
      path: `называет \`${i.detail}\`, которого нет`,
      'glossary-shape': 'не запись термина: **Термин**:, определение, _Avoid_:',
      'glossary-name': `глоссарий под старым именем, которое скиллы Мэтта больше не читают: git mv в ${i.detail} и ${i.detail} в docs/agents/domain.md`,
      'glossary-long': 'определение длиннее двух предложений',
      'glossary-path': 'путь в глоссарии: в нём термины, а не код',
      'glossary-code': 'код в глоссарии',
      'adr-name': 'ADR назван не как NNNN-slug.md',
      'adr-numbers': `номера ADR пропущены или повторяются (на ${i.detail})`,
      'adr-title': 'ADR без заголовка #',
      duplicate: `та же строка, что в ${i.detail}: держи её в одном файле`,
      'stale-map': `возможно, устарело: ${i.detail} коммитов в это место с последней правки карты`,
      'stale-term': `агент документов не нашёл термин «${i.detail}» нигде, кроме глоссариев, ни в какой форме и ни под каким именем: он ещё в ходу?`,
      'checks-shape': `не по форме: ${i.detail}`,
      'checks-start': `быстрая проверка \`${i.detail}\` не запускается: не найдена или не исполняется из своей папки`,
      'checks-slow': `быстрая проверка ${i.detail} слишком медленная для конца каждого хода: перенеси её в full или дай ей {files}`,
      'permissions-shape': `не по форме: ${i.detail}`,
      'permissions-deny': `в permissions.deny нет того, что нельзя отменить: ${i.detail}`,
    }
    return `${at}: ${what[i.kind]}`
  },
  gateTitle: 'Гейт: быстрые проверки в конце хода',
  gateStatus: (g, max) =>
    g.status === 'green' ? '✓ зелёные в конце последнего хода'
    : g.status === 'base' ? '○ красные так же, как на этом коммите до агента: назад не отправлены (/setup-project baseline, когда починишь)'
    : g.status === 'released' ? `✗ красные после ${g.rounds} ${plural(g.rounds, 'круга', 'кругов', 'кругов')}: отпущены, посмотри сам`
    : g.status === 'answered' ? '○ красные, но Claude считает, что не из-за его правок: отпущены (/setup-project baseline запомнит)'
    : `✗ красные: отправлены Claude (круг ${g.rounds} из ${max})`,
  gateBand: n => `проверки: ${n} ${plural(n, 'красная', 'красные', 'красных')}`,
  gateBase: 'Быстрые проверки красные так же, как на этом коммите до агента: гейт отпускает ход. Сначала почини базу, потом /setup-project baseline, иначе гейт не держит ход по этим проверкам.',
  gateReleased: rounds => `Быстрые проверки красные и после ${rounds} ${plural(rounds, 'круга', 'кругов', 'кругов')}: гейт отпустил ход. Что именно — в /setup-project.`,
  gateAnswered: 'Ход вернули, а Claude ничего не поменял: он считает, что красное не из-за его правок. Гейт отпустил ход; /setup-project baseline запомнит это как красное до агента.',
  gateBlock: (failures, round, max, known) =>
    `Быстрые проверки проекта (.claude/agent-lens.json) красные после этого хода (круг ${round} из ${max}). Почини то, что сломали твои правки, запусти команду снова и убедись, что она зелёная, потом закончи ход. Если падение не из-за твоих правок, скажи об этом одной строкой и закончи ход, ничего не меняя; не ослабляй проверку или тест, чтобы пройти.${known === 'other' ? ' Что было красным до тебя, известно только для другого коммита, так что это красное может быть старше твоих правок.' : known === 'none' ? ' Что было красным до тебя, никто не запомнил, так что это красное может быть старше твоих правок.' : ''} Отвечай по-русски.\n\n${failures
      .map(f => `$ ${f.folder === '.' ? '' : `(в ${f.folder}) `}${f.command}   → exit ${f.exitCode}\n${f.output}`)
      .join('\n\n')}`,
  noChecks: 'В .claude/agent-lens.json нет быстрых проверок: их пишет /setup-project.',
  rulesOffer: 'В конфиге OpenSpec задачи не называют ни правил кода, ни линз, и агент, который строит change, встречает их, только когда нарушил: дописать правило?',
  rulesPrompt: lenses =>
    `Добавь одно правило в \`openspec/config.yaml\` этого проекта: правила артефактов OpenSpec даёт агенту, который строит change, только пока он их пишет, а \`tasks.md\` — то, что он читает, пока строит.

Найди артефакт схемы конфига, который пишет задачи (\`tasks\` у большинства; скажет \`openspec schemas\` или файл схемы), и добавь в его список под \`rules\` — создай список, если его нет, и сохрани всё, что там есть, на языке и в виде файла: каждая задача называет по именам правила кода, которые задевает, из файлов, где проект их держит (CLAUDE.md, AGENTS.md, CODING_STANDARDS.md, файлы правил его частей: прочитай, какие есть, и назови их), и линзы, которые задевает, — из LENSES.md, если он есть в проекте, и из этих линз agent-lens: ${lenses.join('; ')}. Больше ничего не меняй. Потом запусти \`openspec validate --all --strict\` и покажи мне правило, как ты его записал. Отвечай по-русски.`,
  baselineKept: failures =>
    failures.length === 0 ? 'Быстрые проверки на этом коммите зелёные: красного до агента не запомнено.' : `Запомнено как красное до агента на этом коммите: ${failures.map(f => f.command).join(', ')}. Гейт не отправляет их назад, пока коммит не сменится.`,
  judgeTask: 'Документы в этом ходе',
  judgePrompt: (root, edits) =>
    `Прочитай, что этот ход поменял в файлах, по которым работают агент и человек в проекте ${root}, и сообщи, чему там не место. Файлы и что в каждом:
${ROLES}

Каждое изменение сверь с кодом (прочитай его): верно ли оно для кода сейчас; в том ли файле, где ему место; меняет ли оно то, что делает агент, или ничего не меняет (пустая фраза, пожелание, очевидность); не повторяет ли то, что уже сказано в другом из этих файлов; не выходит ли за то, что может держать его файл. Блокер: неверно, не в том файле или повтор. Мелочь: пустая фраза или многословнее, чем нужно. CLAUDE.md читается в каждый ход каждого агента, поэтому ему нельзя разрастаться: каждая добавленная в него строка — указатель или правило, нужное каждому ходу; всё остальное — блокер, и его fix называет файл, где ему место (GLOSSARY.md, CODING_STANDARDS.md, docs/agents/workflow.md, ADR, скилл проекта). Сообщай только о том, что изменение добавило или поменяло, а не о том, что было раньше; если ничего нет, так и ответь. Файлы не меняй. Пиши по-русски.

${edits}

Закончи ответ только JSON: [{"file": "файл", "problem": "что не так, одним предложением", "fix": "что сделать, одним предложением", "severity": "blocker" или "minor"}], или [], если ничего нет.`,
  judgeTitle: 'Что агент нашёл в последних правках документов',
  judgeRunning: 'Агент сверяет последние правки документов с кодом…',
  judgeFailed: 'Агент не вернул список.',
  judgeNone: 'Агент не нашёл, что убрать.',
  judgeSend: n => `отправить Claude (${n})`,
  judgeSent: 'ушло Claude',
  judgeFix: findings =>
    `Агент нашёл это в том, что только что записано в документы проекта. Исправь каждое в его файле или скажи, почему оно остаётся; больше ничего не меняй:\n${findings.map(f => `- ${f.file}: ${f.text}${f.fix ? ` Как: ${f.fix}` : ''}`).join('\n')}`,
  termsTask: 'Термины глоссария, которых нигде нет',
  termsPrompt: (root, terms) =>
    `В проекте ${root} git grep не нашёл эти термины глоссария в том виде, как их пишет глоссарий, нигде, кроме глоссариев. Выясни, в ходу ли каждый. Сначала прочитай его определение в глоссарии, потом ищи в коде, документах и спеках, в том числе в файлах, которые ещё не закоммичены, то, что он называет: в любой форме слова (другой падеж, число, род), синонимом или под именем, которое ему дал код (часто английским или словом из его строки _Avoid_). Он в ходу, если нашёл это под любым из этих имён; не в ходу, если не нашёл нигде. Файлы не меняй. Пиши по-русски.

${terms.map(t => `- "${t.term}" (${t.file})`).join('\n')}

Закончи ответ только JSON, по записи на каждый термин: [{"file": "его глоссарий", "term": "термин", "inUse": true или false, "where": "файл: слово, по которому нашёл, или пусто"}]`,
  termsBand: n => `глоссарий: ${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')}`,
  termsTitle: 'Термины глоссария, которых нигде нет',
  termsRunning: n => `Агент документов ищет ${n} ${plural(n, 'термин', 'термина', 'терминов')} в других формах и под другими именами…`,
  termQuestion: (t, isUnjudged) =>
    isUnjudged
      ? `«${t.term}» (${t.file}): git не нашёл его нигде, кроме глоссариев, а агент документов не смог поискать другие формы и имена. Он ещё в ходу?`
      : `«${t.term}» (${t.file}): ни git, ни агент документов не нашли его нигде, кроме глоссариев, ни в какой форме и ни под каким именем. Он ещё в ходу?`,
  termsMore: n => `ещё ${n}`,
  termKept: 'в ходу',
  termDrop: 'убрать из глоссария',
  termLater: 'позже',
  termUndo: 'отменить',
  termAnswered: (t, answer) => `«${t.term}»: ${answer === 'kept' ? 'в ходу, больше не спрошу' : 'спрошу в следующей сессии или после /clear'}`,
  termDropPrompt: t =>
    `Термин «${t.term}» из ${t.file} ни git, ни агент документов не нашли нигде, кроме глоссариев, ни в какой форме и ни под каким именем, и я считаю, что он не в ходу. Убери его запись из ${t.file}, а где другие документы (ARCHITECTURE.md, ADR, CLAUDE.md) называют его как термин, скажи то, что они имеют в виду, без него; больше ничего не меняй и покажи мне, что убрал.`,
  minor: 'мелочь',
  retroOffer: change => `«${change}» в архиве: ретро по работе?`,
  retroArgs: change => `работа в этой сессии над изменением OpenSpec «${change}», до его архива. Говори со мной по-русски: вопросы, варианты и итоги`,
  speak: 'Говори со мной по-русски: вопросы, варианты ответов, черновики на подтверждение и итоги.',
  prompts: {
    existing: n =>
      `${leadRu(n, 'что уже написано')}

Найди все документы, по которым работают агенты и люди этого проекта: CLAUDE.md и файлы, которые он подключает через \`@\`, AGENTS.md, глоссарий под старым именем (CONTEXT.md, CONTEXT-MAP.md), записи об архитектуре и о решениях, где бы они ни лежали, правила других агентов (.cursor/rules, .cursorrules, .github/copilot-instructions.md), скиллы проекта (.claude/skills, .agents/skills) и части README.md для тех, кто меняет код.

Разрежь каждый на куски (раздел, правило, факт) и дай каждому куску один дом:
${ROLES}
- правило, которое может проверить инструмент: линтер, на шаге стандартов кода; до него остаётся, где есть.
- где есть: скилл проекта, README для людей, docs/agents/ Мэтта.
- вон: неверно для кода сейчас, вторая копия или то, что агент и так делает.

Предложи план мне через AskUserQuestion, по файлу, по нескольку кусков в вопросе с multiSelect, у каждого — его дом, и переноси только выбранное. Кусок переезжает слово в слово и уходит со старого места, чтобы каждый факт жил в одном файле. Глоссарий под старым именем переезжает через \`git mv\` (CONTEXT.md в GLOSSARY.md, CONTEXT-MAP.md в GLOSSARY-MAP.md, вместе с глоссариями, на которые он ссылается), и docs/agents/domain.md потом называет новое имя. ADR, что лежат в другом месте, переезжают в docs/adr/ с номерами по порядку. Чего не хватает, допишут следующие шаги, поэтому этот нового не пишет.

Готово, когда у каждого куска каждого найденного файла есть мой ответ. В конце — таблица: кусок, где был, куда ушёл.`,
    map: n =>
      `${leadRu(n, 'карта')}

Прочитай код: точки входа, модули и чем владеет каждый, данные, кто кого вызывает. Потом напиши, дополняя файл, если он уже есть:
- \`GLOSSARY.md\` в корне: только термины предметной области проекта. Вид: \`# {Контекст}\` и одно-два предложения, что это; \`## Language\`; для каждого термина \`**Термин**:\` на строке, определение в одно-два предложения на следующей (что это, а не что делает) и \`_Avoid_: другие слова\`, где код или люди называют это иначе. Без путей, кода, решений и общих понятий программирования.
- \`ARCHITECTURE.md\` в корне, не больше 150 строк: модули и чем владеет каждый, их границы, кто кого вызывает, где живут данные, с чего начинать читать. Каждый модуль назови его путём в обратных кавычках. Не пиши то, что лучше скажет код.
- \`docs/adr/NNNN-slug.md\` с номерами дальше последнего в docs/adr/ (0001, если там пусто): по одному на каждое решение, которое видно в коде, трудно отменить, удивит читателя, принято из реального выбора и ещё не записано ни в одном ADR. \`# заголовок\` и одно-три предложения: контекст, решение, почему. Ни одного, если таких нет.
Если у проекта есть части со своим доменом (репозитории или пакеты), напиши GLOSSARY.md в папке каждой части и GLOSSARY-MAP.md в корне со ссылками на них. Где термин или решение по коду не ясны, спроси меня, а не угадывай. В конце скажи, что написал, по файлам.`,
    standards: n =>
      `${leadRu(n, 'стандарты кода')}

Прочитай код и найди правила, которые он соблюдает: как бросаются и возвращаются ошибки, как называются и раскладываются файлы и модули, как слои вызывают друг друга, как проверяется ввод, как пишутся тесты и где лежат. Бери только правила, по которым ревьюер может проверить одну правку; общие советы не бери. Правила, что уже есть в CODING_STANDARDS.md и в конфиге линтера, считаются найденными: предложи мне только те, которых там нет, и перенос в линтер тех правил из CODING_STANDARDS.md, которые он может проверить.

Раздели правила:
- механическое (запрещённый API или приём, форма импорта, где лежит файл, фиксированная синтаксическая форма): его проверяет инструмент, а не текст. Если в проекте есть линтер (eslint, stylelint, ruff, …), правило идёт в его конфиг — готовым правилом или небольшим своим, со своим тестом, — и его запускает скрипт линта. Правило, которое линтер уже проверяет, не бери.
- на суждение (согласованность между файлами, верный слой, имя, которое говорит, что это): идёт в \`CODING_STANDARDS.md\`.
Каждое правило в одну-две строки: что, почему (какую ошибку предотвращает, одной фразой), где видно (путь) и чем проверяется (\`eslint: <правило>\`, \`stylelint: <правило>\` или \`ревью\`).

Предложи правила мне через AskUserQuestion, по нескольку с multiSelect, у каждого скажи, идёт оно в линтер или в файл, и запиши только выбранные: в конфиг линтера и в \`CODING_STANDARDS.md\` в корне, не больше 300 строк, по разделам. Потом запусти скрипт линта и скажи, что нашли новые правила.`,
    checks: n =>
      `${leadRu(n, 'проверки')}

Прочитай, чем проверяется этот проект, на чём бы он ни был написан: манифесты и скрипты (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile или justfile, файлы сборки), линтеры и проверка типов, тест-раннеры, что запускает его CI. Разложи найденное на две ступени:
- fast: идёт в конце каждого хода моего агента, который поменял проект, поэтому секунды, минута-две самое большее: линт и проверка типов, и тесты изменённых файлов, если раннер умеет брать файлы. Где команда берёт файлы, поставь \`{files}\` на их место (\`eslint {files}\`, \`vitest related --run {files}\`, \`ruff check {files}\`): тогда она идёт по файлам, изменённым относительно коммита, и не идёт вовсе, если их нет. Инструменту, который падает на чужих файлах, дай только его файлы, по расширению: \`{files:py,pyi}\`. Команда без \`{files}\` идёт по всей своей папке.
- full: перед коммитом, пушем или мержем: всё (линт, типы, все тесты, e2e, сборка).
Если у проекта есть части со своими инструментами (монорепо, пакеты, репозитории в папках), дай команды каждой части по её папке.
Предложи мне обе ступени через AskUserQuestion, потом запиши их в \`.claude/agent-lens.json\`, сохранив, что там есть: \`{"checks": {"fast": ["…"], "full": ["…"]}}\` или по папкам, \`{"checks": {"fast": {"api": ["…"], "web": ["…"]}, "full": {…}}}\`. Каждая команда — строка для шелла, которая запускается из своей папки так, как её набрал бы человек; где у проекта есть свои скрипты — они. Сам их не запускай: agent-lens прогонит быструю ступень, как только файл записан, запомнит красное сейчас как красное до тебя и скажет, что не запускается или слишком медленно.`,
    run: n =>
      `${leadRu(n, 'как поднять проект, и его смоук-тест')}

Выясни, что это за проект: сервис или веб-приложение, которое поднимают, утилита командной строки, библиотека. Библиотеку поднимать не нужно: запиши \`{"run": null}\` в \`.claude/agent-lens.json\`, сохранив, что там есть, и остановись.
Иначе найди, как его поднимают и пробуют, по тому, что в нём есть (compose-файлы, скрипты, Procfile, README):
- up: одна команда, которая поднимает проект и возвращается, когда он отвечает, дождавшись здоровья; сервер на переднем плане не вернётся никогда, поэтому нужен флаг detach или wait у инструмента или скрипт, который запускает и ждёт.
- smoke: одна команда, которая пробует главный путь насквозь: e2e-тест с тегом smoke, запрос к здоровью и к одной настоящей ручке, утилита с \`--help\` и одной настоящей командой.
- down: что его останавливает, если up оставляет что-то запущенным.
Если смоук-теста нет, предложи мне самый маленький, который доказывает, что главный путь работает, в тест-раннере проекта, и пиши его только после моего «да».
Предложи команды мне через AskUserQuestion, запиши их в \`"run"\` в \`.claude/agent-lens.json\`, сохранив, что там есть, потом один раз запусти up, smoke и down и скажи, что сделала каждая.`,
    permissions: (n, ctx) =>
      `${leadRu(n, 'что агенту можно и нельзя запускать')}

В \`.claude/settings.json\` (создай, если нет; всё, что там есть, сохрани) в \`"permissions"\`:
- \`"deny"\`: всегда эти, их не отменить: ${ctx.deny.map(r => `\`${r}\``).join(', ')}. Потом предложи мне, что ещё в этом проекте должно быть под запретом: файлы с настоящими секретами (ключи, сертификаты, env-файл с настоящими значениями; прочитай файл, прежде чем его назвать: файл только с локальными значениями — не секрет), команды, которые публикуют, деплоят или ходят в прод.
- \`"allow"\`: команды из \`.claude/agent-lens.json\` (проверки и run) правилами Bash по префиксу (\`Bash(npm run lint:*)\`), git только на чтение (status, diff, log, show), тест-раннеры проекта.
Что ещё запретить и что разрешить, предложи мне через AskUserQuestion с multiSelect, и запиши правила выше и то, что я выберу.`,
    workflow: (n, ctx) => {
      const has = (skill: string) => ctx.skills.includes(skill)
      const steps = [
        has('grilling') ? 'Идею прожимают скиллом `grilling` до того, как её предложить.' : 'Идею обсуждают со мной до того, как её записать.',
        `${ctx.hasOpenspec ? '`openspec propose` пишет её как изменение, терминами глоссария' : 'Её записывают планом в issue, терминами глоссария'}; ${has('domain-modeling') ? 'при проектировании — скилл `domain-modeling`: ' : 'при проектировании '}новый термин в GLOSSARY.md, как только он устоялся, подходящее решение в docs/adr/.`,
        `${has('tdd') ? 'Задачи делаются скиллом `tdd` на швах, которые называет design' : 'Задачи делаются через тест сначала, где в проекте есть тесты, на швах, которые называет design'}${has('diagnosing-bugs') ? '; баг — `diagnosing-bugs`' : ''}.`,
        `agent-lens проверяет каждую правку по CLAUDE.md и CODING_STANDARDS.md, гоняет быстрые проверки в конце каждого хода и ревьюит diff каждого хода; перед коммитом или merge request — ветка через линзы, \`/changes lenses\`${has('code-review') ? ', и всё изменение — `code-review`' : ''}.`,
        `${ctx.hasOpenspec ? 'При архиве' : 'Когда готово,'} термины изменения уходят в GLOSSARY.md, решения в docs/adr/${has('retro') ? '; потом `/mattpocock-skills:retro`' : ''}.`,
      ]
      return `${leadRu(n, 'как идёт работа, и CLAUDE.md')}

Напиши \`docs/agents/workflow.md\` (дополни, если он уже есть), не больше 120 строк, как идёт работа в этом проекте, и на каждом шаге скажи, где решаю я:
${steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}
Потом в том же файле:
- Когда задача здесь готова: полная ступень из \`.claude/agent-lens.json\` зелёная и смоук-тест, где он есть; по строке на то, что ещё есть в проекте (сторис, проверки доступности).
- Как делится работа: основной агент — оркестратор (разбирает задачу, планирует, отдаёт части саб-агентам, следит за их порядком, решает архитектуру, сводит результаты и отвечает мне) и руками делает только то, что дешевле, чем объяснить; чтение кода, реализация, прогон проверок, браузер и ревью уходят саб-агентам, независимые части — параллельно одним сообщением, у каждого свои файлы (где части зависят друг от друга — сначала общий контракт; \`isolation: "worktree"\`, если их файлы могут пересечься), промпт самодостаточный (цель, файлы и чего не трогать, эти правила, когда готово, что ответить), ответы короткие; что они доложили, проверяется (полная ступень), прежде чем сказать мне.

Потом \`CLAUDE.md\` (создай, если нет), не больше 120 строк:
- первым правилом — язык, на котором со мной говорят: «Отвечай и задавай вопросы по-русски»;
- короткий раздел указателей на ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md и docs/agents/workflow.md, по строке, когда его читать; GLOSSARY.md подключи строкой \`@GLOSSARY.md\`, если в нём меньше 80 строк, чтобы термины действовали в каждом ходе, иначе дай указатель;
- правила, нужные каждому ходу, из скриптов и конфигов проекта: как поставить и запустить (\`run\` из \`.claude/agent-lens.json\`, где он есть); проверки одной строкой: быстрая ступень идёт сама в конце каждого хода, полная — перед коммитом, пушем или мержем, и заливать только при зелёном; их команды — в \`.claude/agent-lens.json\`, сюда не копируются;
- как коммитить.
Всё остальное в нём, чему место в одном из этих файлов, переезжает туда.`
    },
    config: n =>
      `${leadRu(n, 'OpenSpec читает эти файлы')}

В \`openspec/config.yaml\` добавь в \`context\`, сохранив, что там есть, указатель на каждый из GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md, LENSES.md, где он есть, и docs/agents/workflow.md, по строке, что в нём, без копии его текста. Добавь в \`rules\`: proposal и спеки пишутся терминами глоссария, без слов из его _Avoid_; design называет ADR, которые задевает, а новое трудно отменимое решение идёт в docs/adr/; каждая задача называет тестовый шов, на котором её строят, и правила CODING_STANDARDS.md и линзы, которые она задевает, по именам, чтобы они были перед агентом, который её строит, а не нашлись, когда он их нарушил (правила артефактов OpenSpec даёт агенту только пока он их пишет, а tasks.md — то, что он читает, пока строит). Потом запусти \`openspec validate --all --strict\` и скажи, что он нашёл.`,
    ci: (n, ctx) =>
      `${leadRu(n, 'проверки в CI')}

CI проекта — в ${ctx.ci.map(f => `\`${f}\``).join(', ')}. Добавь задачу, которая идёт на каждом merge или pull request и на каждом пуше в основную ветку, чтобы то, что гейт держит для моего агента, держалось для всех:
- проверка документов: \`npx -y github:Darvl-52/agent-lens check\`;
- полная ступень: \`npx -y github:Darvl-52/agent-lens checks full\`, в том образе, где собирают и тестируют свои задачи проекта.
Обе читают \`.claude/agent-lens.json\` и требуют Node 20 или новее в образе задачи. Если в образе проекта Node нет, дай проверке документов свою задачу на образе с Node, а полную ступень оставь задачам проекта, которые гоняют те же команды; команды в CI не копируй. Пиши задачу так, как написаны задачи там (стадии, образы, кэши, правила), и покажи её мне через AskUserQuestion до записи, сказав, чего она стоит: Node, нужный в образе, своя задача, где его нет. Запиши после моего «да».`,
    fix: (step, issues) =>
      `Проверка файлов шага «${step}» из /setup-project нашла это. Исправь каждое в его файле и больше ничего не меняй:\n${issues.map(i => `- ${RU.issue(i)}`).join('\n')}`,
  },
  openspecFailed: why => `openspec init не запустился: ${why}. Запусти \`openspec init --tools claude\` сам и отправь шаг снова.`,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
