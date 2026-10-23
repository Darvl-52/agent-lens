// The language every part speaks and its model answers in.
export type Lang = 'en' | 'ru'

// The review of what the agent changed.

// One line of a hunk: added, removed, or context around them.
export type ReviewLine = { kind: '+' | '-' | ' '; text: string }

// A run of changed lines with the context around them, where it starts in the old and the new
// file. `id` hashes the file and the lines, so it stays the same while they do. `cut`: how many of
// its lines are left out at its end, past what a diff keeps.
export type ReviewHunk = { id: string; oldStart: number; newStart: number; lines: ReviewLine[]; cut?: number }

// Where a file is shown: the repository it is in, named from the project folder (`__front`, `''`
// for the project's own), its path in it, and the two joined, which names it to the model.
export type ReviewWhere = { group: string; rel: string; shown: string }

// What changed in one file. `path` is absolute, in its one spelling (`canonical`: on Windows `\`
// and the drive upper-cased), as the engine and git both name it.
// `cut`: how many of its hunks' lines are left out, past what a diff keeps of one file or of all;
// `added` and `removed` still count them.
export type ReviewFileDiff = ReviewWhere & { path: string; isNew: boolean; isDeleted: boolean; added: number; removed: number; hunks: ReviewHunk[]; cut?: number }

// The diff in view: what the last turn with edits changed, all the session changed, or what is
// uncommitted in every repository it touched.
export type ReviewMode = 'turn' | 'session' | 'uncommitted'

// One shell command the agent ran in a turn: the command, the end of what it printed, and whether
// it failed. What it did (a push, an install, a file outside the repository) is in no diff.
export type ReviewShellRun = { command: string; output: string; isError: boolean }

export type ReviewDiff = {
  mode: ReviewMode
  files: ReviewFileDiff[]
  // What was asked for: the prompt of the turn, of every turn of the session for the others.
  request: string
  // A turn's own: the session's prompts before it, which a change may answer too, and the shell
  // commands run in it. Absent from a diff an older version kept.
  earlier?: string[]
  shell?: ReviewShellRun[]
  // Hashes every hunk: what a review, an explanation or a walkthrough is kept against.
  fingerprint: string
  at: number
}

// One thing the review found. `severity`: a likely bug, a project rule broken, or a note worth a
// look (leftover debugging, a change outside the request, a test missing).
// `lineText`: the text of its line as the review read it, so a later diff that changes that line
// is known to have looked at it.
export type ReviewFinding = { id: string; file: string; line?: number; severity: 'bug' | 'rule' | 'note'; text: string; rule?: string; lineText?: string }

// How each edit is checked against the project's rules as it is made: `warn` lets it land and
// tells Claude what it broke, `block` refuses it before it lands, `off` leaves it to the review.
export type ReviewLive = 'warn' | 'block' | 'off'

// A project rule an edit broke, caught as the edit was made, as a finding on the file at `path`.
// `evidence` is the offending text, kept only where the edit wrote it as the check quoted it, so
// whether it is still in the file can be told. `state`: found and its note not yet with Claude,
// told to Claude while the turn runs, still in the file once it ended, gone from it, or the edit
// refused before it landed.
export type ReviewCaughtRule = ReviewFinding & { path: string; evidence?: string; state: 'found' | 'told' | 'open' | 'fixed' | 'refused' }

export type ReviewAnswer = { question: string; text: string }

export type ReviewTab = 'changes' | 'findings' | 'walkthrough' | 'ask'

export type ReviewLang = 'en' | 'ru'

// What the mod's own model calls cost this session, as the API counted it: the calls, the input
// tokens, those of them the prompt cache served, and the output tokens, thinking included.
export type ReviewSpent = { calls: number; input: number; cached: number; output: number }

// What the model is working on, each shown while it runs.
export type ReviewBusy = 'review' | 'notes' | 'walkthrough' | 'answer'

// The OpenSpec change in view.

// Ticked tasks of `tasks.md` out of all of them.
export type SpecProgress = { done: number; total: number }

// One task of `tasks.md`: its number (`2.3`) where it has one, its text, whether it is ticked,
// and the heading it sits under.
export type SpecTask = { id: string | null; text: string; isDone: boolean; section: string | null }

// The test cases of `test-cases.md`: how many there are, how many say `Automated:` or `Manual:`,
// and, where the file marks its cases at all, the ids of those that say neither.
export type SpecTests = { cases: number; automated: number; manual: number; unmarked: string[] }

// One case of `test-cases.md`: its id and title, how it says it is checked, the test files its
// `Automated:` line names, and where it stands: a test with its id is in one of those files, none
// is, it is checked by hand, or it says neither where the others say.
export type SpecTestCase = {
  id: string
  title: string
  mark: 'automated' | 'manual' | 'none'
  files?: string[]
  state: 'tested' | 'untested' | 'manual' | 'unmarked'
}

// One requirement a delta spec adds, changes, removes or renames, with its scenarios' names.
export type SpecRequirement = {
  // The capability: the spec's folder under `specs/`, `employee-fe/door-access`.
  capability: string
  op: 'added' | 'modified' | 'removed' | 'renamed'
  name: string
  // A renamed requirement's old name.
  from?: string
  scenarios: string[]
  // Its scenarios no test case covers, where `test-cases.md` says what each case covers.
  uncovered?: string[]
  // Where the main spec disagrees: it already has an added requirement, or lacks one the change
  // modifies, removes or renames.
  mismatch?: 'exists' | 'missing'
}

// Another active change whose specs touch a capability this one does, and the requirements both
// name there.
export type SpecOverlap = { change: string; capability: string; shared: string[] }

// One finding of `openspec validate --strict`.
export type SpecIssue = { level: 'ERROR' | 'WARNING' | 'INFO'; path: string; message: string }

// What `openspec validate` said of a change at a fingerprint; `issues` null where the CLI could not
// be run.
// `issues` null where the CLI did not run; `isTimedOut` where it ran too long and was stopped.
export type SpecChecked = { change: string; fingerprint: string; issues: SpecIssue[] | null; isTimedOut?: true }

// What one file of a change gained and lost since it was last read.
export type SpecDelta = { file: string; added: number; removed: number }

// The OpenSpec change in view, read from disk: drawn above the prompt and in the pane.
export type SpecLens = {
  // The project's `openspec` folder.
  root: string
  // The active changes, the latest edited first.
  changes: string[]
  current: string
  tasks: SpecProgress
  taskList: SpecTask[]
  tests: SpecTests
  requirements: SpecRequirement[]
  // The capabilities the change brings that `openspec/specs` does not have yet.
  newCapabilities: string[]
  overlaps: SpecOverlap[]
  // Changes with the change's text, so a brief knows when it is stale.
  fingerprint: string
  // Whether this change was ever read here: until then there is nothing to compare with.
  isSeen: boolean
  // Each test case and where it stands; absent from a value an older version kept.
  testCases?: SpecTestCase[]
  deltas: SpecDelta[]
}

// The model's brief of a change, kept per change in the store; `options`, once asked for, the
// ways the model offers to settle each decision, in their order, the one it recommends first;
// `advice` beside them, why it recommends that one, null where it recommends none.
// `isUnsplit` where the model left out the section of what is left to decide: that is not known.
export type SpecBrief = { fingerprint: string; summary: string; decisions: string[]; at: number; options?: string[][]; advice?: (string | null)[]; isUnsplit?: true }

// What the person settled of one decision, and whether it went to Claude to write into the spec;
// `isByClaude` where the person left it for Claude to decide.
export type SpecVerdict = { answer: string; isSent: boolean; isByClaude?: boolean }

// The Decide tab's work on one brief (`at` is the brief's): the decision open, if any, and the
// verdicts by the decision's index. A new brief starts it over.
export type SpecDeciding = { at: number; open: number | null; verdicts: Record<string, SpecVerdict> }

export type SpecAnswer = { question: string; text: string }

// What the model is working on.
// A hole the critic agent found in a change: what is missing or wrong, where that shows, and how
// to close it. `isMinor`: a detail the code can settle, which in auto mode does not go to Claude;
// `isSent` once it went to Claude to close.
export type SpecHole = { text: string; where: string; fix: string; isMinor?: true; isSent?: true }

// The critic agent's last look at a change, at the version of its text it read (task ticks aside),
// started `at`. `round`: how many times its holes went to Claude to close since the person last
// asked it to look; `isSent` once the last of them went; `isCapped` once the rounds ran out and what
// the last ones changed was left to the person. `sent`: the holes each of those rounds sent to
// Claude, the first first.
export type SpecCritic = {
  change: string
  fingerprint: string
  status: 'running' | 'done' | 'failed'
  at: number
  agentId?: string
  holes: SpecHole[]
  round: number
  isSent?: true
  isCapped?: true
  sent?: { round: number; holes: SpecHole[] }[]
}

// off: no critic; button: it reads the change when asked; auto: also at the end of each turn that
// moved the change's text on, and what it finds goes to Claude to close.
export type SpecCriticMode = 'off' | 'button' | 'auto'

export type SpecBusy = 'brief' | 'explain' | 'answer' | 'options'

// A model call that gave no answer: which one, and the question where it was one.
export type SpecFailed = { what: SpecBusy; question?: string }

export type SpecTab = 'brief' | 'changes' | 'decide' | 'tasks' | 'tests' | 'spec' | 'ask'

// The language the mod speaks and the model answers in.
export type SpecLang = 'en' | 'ru'

// Which skill each prompt gets.

// How the router acts on a pick: `auto` tells Claude to load the skill, `suggest` tells Claude it may
// fit and leaves the call to it, `off` routes nothing.
export type RouterMode = 'auto' | 'suggest' | 'off'

export type RouterLang = 'en' | 'ru'

// The pane's tabs: what was picked lately, the rules, every skill, every decision.
export type RouterTab = 'overview' | 'rules' | 'skills' | 'history'

// A skill the router may pick: the name the Skill tool runs it by, and the line that says what it is for.
// `isProject`: the project's own, from its `.claude` folder, which wins where a general one fits too.
export type RouterSkill = { name: string; description: string; isProject?: boolean }

// A rule the person set: the skill runs whenever a prompt says one of `when` (a word or phrase matched
// at the start of a word, or `/a regex/`), with `args` where the skill takes them.
export type RouterRule = { skill: string; when: string[]; args?: string }

// What the person set for routing, in the store and in the project's `.claude/skill-router.json`: their
// rules, a line per skill saying when it fits, and the skills left out.
export type RouterSetup = { rules: RouterRule[]; hints: Record<string, string>; ignored: string[] }

// One skill picked for a prompt: by one of the person's rules or by the model, and why.
export type RouterPick = { skill: string; why: string; args?: string; by: 'rule' | 'model' }

// What the router made of one prompt: its start, what it picked, how long it took, and a note where it
// picked nothing for a reason worth showing (no skills, the model failed), and how it failed.
export type RouterDecision = { at: number; prompt: string; picks: RouterPick[]; ms: number; note?: string; why?: string }

// The session's prompts routed, counted whole: the decisions keep only the last few.
export type RouterStats = { prompts: number; withSkill: number; byRule: number; byModel: number; bySkill: Record<string, number> }

// The guard over each agent's turn.

// Why a call was refused as a loop: the same call with the same result again, the same call failing
// again, or two calls taken in turn with the same results.
export type GuardStuck = 'repeat' | 'error' | 'pingpong'

// An agent's turn past the soft limit, as the row shows it: who it is, how long it has worked (time a
// person was asked left out), its tool calls, and whether the hard limit stopped it.
export type GuardAlert = { who: string; minutes: number; steps: number; isStopped?: true }

// What /changes guard set: on or off, and the hard limit; the soft one is half of it.
export type GuardSetting = { isOn: boolean; minutes: number; steps: number }

// /setup-project and the check of the files the agent and the person work by.

// What a check of those files found: a file past its size, a path it names that is not there, a
// glossary entry out of its form or naming code, an ADR misnamed, misnumbered or with no title,
// a line kept in two files; and what may have gone stale: a part of the map git shows much changed
// since the map was, a glossary term found nowhere else.
export type SetupDocIssueKind =
  | 'size'
  | 'path'
  | 'glossary-shape'
  | 'glossary-name'
  | 'glossary-long'
  | 'glossary-path'
  | 'glossary-code'
  | 'adr-name'
  | 'adr-numbers'
  | 'adr-title'
  | 'duplicate'
  | 'stale-map'
  | 'stale-term'

// One issue, in the file at its path from the root and the line where there is one; `detail` what
// the kind wants named (the path, the size, the other file).
export type SetupDocIssue = { file: string; line?: number; kind: SetupDocIssueKind; detail?: string }

// What the docs agent found in a turn's edits to the files: what is wrong, where, how to fix it,
// whether it blocks.
export type SetupFinding = { file: string; text: string; fix: string; isMinor?: true }

// The docs agent's last look: running (its id), done with its findings, or failed; `isSent` once
// they went to Claude.
export type SetupJudge = { status: 'running' | 'done' | 'failed'; at: number; agentId?: string; findings: SetupFinding[]; isSent?: true }

// The steps of /setup-project, in order.
export type SetupStepId = 'matt' | 'openspec' | 'existing' | 'map' | 'standards' | 'workflow' | 'config'

// Where a step stands: not reached, sent to Claude (or run), done, skipped by the person, or done
// with its files failing the check, `isFixSent` once what failed went back to Claude.
export type SetupStepState = { status: 'waiting' | 'sent' | 'done' | 'skipped' | 'failed'; isFixSent?: true; error?: string }

// A run of /setup-project in a project: each step's state, the one under way.
export type SetupRun = { root: string; steps: Record<SetupStepId, SetupStepState>; current: SetupStepId | null }

// An OpenSpec change in progress: its folder's name and its ticked tasks out of all of them.
export type RouterChange = { name: string; done: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-lens': {
      // The language in force: what `lang` saved, else the setting's; null until it is read.
      lang: Lang | null

      // The review of what the agent changed.
      // What each file edited was before its first edit, null for a file that was not there: of the
      // session, and of the turn running. Held by the host, so a reload of the module keeps them.
      'review.before': Record<string, string | null>
      'review.turnBefore': Record<string, string | null>
      // The prompts of the session's turns, and of the turn running.
      'review.requests': string[]
      'review.turnRequest': string
      // The shell commands of the turn running.
      'review.turnShell': ReviewShellRun[]
      // The last turn with edits: what the row shows and what is reviewed by itself.
      'review.turn': ReviewDiff | null
      // What the pane shows, by the mode picked.
      'review.shown': ReviewDiff | null
      'review.mode': ReviewMode
      'review.tab': ReviewTab
      // The file picked in the Changes tab, by path.
      'review.file': string | null
      // The findings of each diff reviewed, by its fingerprint.
      'review.reviews': Record<string, ReviewFinding[]>
      // What the check of each edit caught this session, newest first.
      'review.caught': ReviewCaughtRule[]
      // What each hunk is for, by hunk id: kept across modes, as a hunk keeps its id.
      'review.notes': Record<string, string>
      'review.walkthroughs': Record<string, string>
      // How many lines of a long hunk are shown, by hunk id, where the person asked for more.
      'review.expanded': Record<string, number>
      'review.answer': ReviewAnswer | null
      // The hunk a question is asked about, by id.
      'review.askAbout': string | null
      'review.busy': ReviewBusy[]
      'review.error': string | null
      // The reviews that gave no findings to show, by the diff's fingerprint: why, as the pane says it.
      'review.failed': Record<string, string>
      // Hunk ids looked at, and finding or hunk ids sent to Claude or put aside, this session.
      'review.seen': string[]
      // The changed lines of the hunks looked at, each hashed with its file: what carries "looked
      // at" from one diff mode to another, where the hunks are cut otherwise.
      'review.seenLines': string[]
      // When each review was made, the files its diff held and the lines it took out or rewrote
      // (hashed), by the diff's fingerprint: an earlier finding whose line a later review saw change,
      // and did not find again, is closed.
      'review.reviewed': Record<string, { at: number; files: string[]; changed?: string[] }>
      'review.sent': string[]
      'review.dismissed': string[]
      'review.spent': ReviewSpent
      // Every file the session has changed as of its last turn with edits, by path and shown path:
      // an earlier review's findings stay while their file is among them.
      'review.changed': string[]
      // The files uncommitted in each repository, by path, as the turn's first shell command ran;
      // null until one does. What is uncommitted at the turn's end and was not then, the shell changed.
      'review.turnDirty': Record<string, string[]> | null

      // The OpenSpec change in view.
      'spec.lens': SpecLens | null
      'spec.brief': SpecBrief | null
      'spec.explain': string | null
      'spec.answer': SpecAnswer | null
      'spec.deciding': SpecDeciding | null
      // Decisions sent to Claude for this change, at this fingerprint: once the spec moves on from
      // it, the brief is made again. `isUnchanged` once a turn ended with the spec still at it.
      'spec.refreshing': { change: string; fingerprint: string; isUnchanged?: boolean } | null
      // The tasks sent to Claude this session, as `<change>:<task key>`.
      'spec.sentTasks': string[]
      // The test cases sent to Claude to close this session, and those picked in the pane to send,
      // each as `<change>:<case id>`.
      'spec.sentCases': string[]
      'spec.pickedCases': string[]
      'spec.checked': SpecChecked | null
      // The change whose archiving waits for a second press, and the one sent to Claude to archive.
      'spec.archive': { change: string; isSent: boolean } | null
      // What the model is working on, shown while it reads, and the calls waiting their turn.
      'spec.busy': SpecBusy | null
      'spec.queued': SpecBusy[]
      'spec.error': string | null
      // The model call that failed, so the error offers to run it again; null where there is
      // nothing to retry (a prompt the session refused).
      'spec.failed': SpecFailed | null
      'spec.tab': SpecTab
      // The critic agent's last look at each change, by its name, and the mode /spec critic set.
      'spec.critic': Record<string, SpecCritic>
      'spec.criticMode': SpecCriticMode | null

      // The guard: each agent's turn past the soft limit, by its loop ('main' for the main loop).
      'guard.alerts': Record<string, GuardAlert>

      // /setup-project's run in this project, and what the last check of the docs found (null
      // in a project not set up, where nothing is checked).
      'setup.run': SetupRun | null
      'setup.issues': SetupDocIssue[] | null
      'setup.judge': SetupJudge | null
      // A change archived, offered a retro of the work by Matt's command of that name.
      'setup.retro': { change: string; command: string } | null

      // Which skill each prompt gets.
      'router.decisions': RouterDecision[]
      // Null until the first prompt routed since the counts were kept: read from the decisions.
      'router.stats': RouterStats | null
      'router.loaded': string[]
      'router.mode': RouterMode | null
      'router.setup': RouterSetup | null
      'router.catalog': RouterSkill[]
      'router.project': RouterSetup | null
      'router.tab': RouterTab
      'router.formSkill': string | null
      'router.formWords': string
      'router.formHint': string
      'router.flash': string | null
      // Whether the line under the router's pane says a thing done, or one refused.
      'router.flashTone': 'success' | 'warning'
    }
  }
}
