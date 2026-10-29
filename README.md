# agent-lens

A Claude Code mod for working with the agent, in three parts that know of each other, and a guard over them all:

- **What the agent changed.** Each edit is checked against the project's `CLAUDE.md` and
  `AGENTS.md` as Claude makes it, and Claude is told what it broke before it moves on. After each
  turn that edits files, the diff across every repository it touched is reviewed against what you
  asked for and the same rules. `/changes` opens the diff, what each piece is for, the findings
  and a walkthrough. Before a commit, `/changes lenses` reads the whole branch through the kinds
  of mistake reviews catch, in an agent that made none of it.
- **The OpenSpec change.** In a project with `openspec/changes`, `/spec` gives the change's gist,
  what changed since you last looked, what is left for you to decide, its tasks and its spec, and
  answers questions about it.
- **The skill for each prompt.** Each prompt you send is read, and Claude is told which of your
  skills to load for it: your rules first, a quick model call where none fits. `/router` shows
  what it picked and why.
- **The guard.** No agent works a turn on forever: a call repeated with nothing changing is
  refused, an agent long at it is told to wrap up, and past the limit it is stopped and reports
  what it did. `/changes guard` says the limits.
- **Setting a project up.** `/setup-project` prepares any project for work with the agent, whatever
  its stack, a step at a time, and keeps the files it writes from rotting: each is checked like code.
  The project's checks run at the end of each turn that changed it, and a turn that leaves them red
  goes back to Claude.

It was four mods: review-lens, rules-watchdog, openspec-lens and skill-router.

## The row above the prompt

One row, the change in view first, then what the agent's last turn changed:

```
◆ add-dark-mode · 2 to decide · tasks 7/12  │  ✎ 3 files +120 −30 · 1 likely bug · 2 findings   /spec /changes
```

Each part opens its pane, on the tab that tells more of it. Where the row is too narrow for both,
each has a row of its own. Red is broken, yellow wants a look, green is done. The rows go above
those of the mods loaded after agent-lens, so a short band keeps them in view.

## How the parts work together

- **A task from `/spec` names OpenSpec's skill.** A task or an archiving the spec's pane sends
  tells Claude to load OpenSpec's own skill for it (`openspec-apply-change` or `opsx:apply`,
  `openspec-archive-change` or `opsx:archive`), where one is installed and not loaded yet, with no
  model asked. The router keeps it among its decisions.
- **OpenSpec's tasks name the rules.** OpenSpec gives the agent that builds a change the rules of
  the artifacts only while it writes them. In any project with OpenSpec, set up or not, a config
  whose tasks name no rules or lenses has the row offer to add the rule; `×` lets it go for good.
- **A change done is read through the lenses.** Once every task of the change in view is ticked,
  the row offers `/changes lenses` before the archive, once a change, or runs it in Lenses: auto:
  the look at the whole of it that the review of each turn does not give.
- **The review reads the change in view.** Beside the diff it is told the OpenSpec change in
  progress: its tasks not done yet and what its specs require, each requirement with its
  scenarios. It reports code that goes against a requirement or a scenario, and a task the request
  named that the diff leaves half done.
- **The rules are checked once.** What the check of each edit caught joins the findings while it
  is still in the code, and the review after the turn is told not to report it again.
- **One language.** `lang ru` after any of the three commands switches all of them.

## Setting a project up

`/setup-project` works in any project. Matt Pocock's skills (`mattpocock-skills`), the OpenSpec CLI
and a CI are recommended, not required: it says in a line what it found and how to install what is
missing, and leaves out the steps that need it. Then the steps go to Claude one at a time, each once
the turn before has ended, in a pane that shows where each stands:

1. Matt's `setup-matt-pocock-skills`, run as if you typed it: the tracker, the labels, the domain layout.
2. `openspec init --tools claude`, run by the mod, where the project has no `openspec/`.
3. What is already written, where the project has docs of its own (a `CLAUDE.md` it wrote,
   `AGENTS.md`, a glossary by its old name `CONTEXT.md`, another agent's rules): each piece is put
   to you with the file it belongs in, and what you pick moves there word for word, leaving its old
   place; `CONTEXT.md` becomes `GLOSSARY.md` by `git mv`. Without such docs the step is done already.
4. The map from the code: `GLOSSARY.md` in the form of Matt's `domain-modeling`, `ARCHITECTURE.md`,
   an ADR in `docs/adr/` for each decision that qualifies, numbered on from those there.
5. The coding standards, read from the code and each put to you before it is written: a mechanical
   rule (a banned API, an import's shape, where a file lives) goes to the project's linter, as a
   tool checks it better than prose; a judgement goes to `CODING_STANDARDS.md`. Each says what, why
   (the mistake it prevents), where it shows, and what checks it (`eslint: <rule>` or `review`).
6. The lenses, from what the project's reviewers wrote on its last fifty or so merge or pull
   requests (its history of fixes where no CLI reads them): each comment checked against the code,
   a wrong one kept as what to push back on, the rest sorted into kinds of mistake, each with how
   many comments it holds and where to look, by this project's paths; a kind the mod's lenses name
   adds only what is this project's. A table and the file go to you, and what you pick is written to
   `LENSES.md`; `/changes lenses` reads the branch through them. None found, nothing is written.
7. The checks, read from the project's own scripts and put to you, in `.claude/agent-lens.json`:
   `fast` for the end of each turn (lint, types, the tests of the changed files, `{files}` where a
   command takes them) and `full` for before a commit, push or merge; by folder in a monorepo. The
   mod runs the fast tier once: a command that does not start or is too slow goes back, and what is
   red is kept as red before the agent.
8. Bringing it up: the commands that bring the project up, try its main path and take it down, or
   nothing for a library; a smoke test proposed where there is none.
9. What the agent may run, in `.claude/settings.json`: denied always the usual forms of what cannot
   be taken back (`git push --force`, `git reset --hard`, `git clean -f`, `rm -rf`; by prefix, so a
   rail against the slip, not a sandbox), the project's secrets and
   deploys on your word, the commands of the checks allowed.
10. `docs/agents/workflow.md`: how work goes (OpenSpec and Matt's skills where they are installed),
    when a task is done here, and how the work is shared between the main agent and its subagents.
    And `CLAUDE.md`: the language you are spoken to in first, pointers to the files (`GLOSSARY.md`
    imported with `@GLOSSARY.md` while it is short, so its terms hold on every turn), the checks in a
    line that points to `.claude/agent-lens.json`.
11. `openspec/config.yaml`: its `context` points to the files, its `rules` hold the artifacts to them,
    and each task names the rules of `CODING_STANDARDS.md` and the lenses it touches: OpenSpec gives
    the agent the rules of the artifacts only while it writes them, and `tasks.md` is what it reads
    as it builds.
12. A job in the project's CI that runs the check of the docs and the full tier, as under The gate.

A step is done once its files are there and pass the check; where they fail, what failed goes back
to Claude once, then waits for you (`f` sends it again, `a` the whole step, `s` skips it). Run
again, it adds to what is there.

From then on the files are checked at each session's start, on each edit and at the end of each
turn (an edit made through the shell included), as `openspec validate
--strict` checks a change: a file past its size (`CLAUDE.md` with what it imports), a path it names that is not there, a glossary entry
out of its form or naming code, a glossary by the old name Matt's skills no longer read, an ADR misnamed or misnumbered, a line kept in two files. Beside
the session's start it also looks, with git, for what may have gone stale: a part of the map with
15 commits or more since the map was edited, a glossary term found nowhere else in its repository.
Git finds a term only as the glossary writes it, so a term it misses goes to the docs agent first
(on `haiku`), which looks for it in other forms of the word and by the code's name for it; only a
term it misses too is a question in the pane: `u` in use, `r` out of the glossary, `l` later.

A turn that edits these files, by any tool, the shell too, has an agent (Explore, on `sonnet`) read
the edits against the code: is it true of the code, in the file it belongs in, does it change what
an agent does, does it repeat another file. A line added to `CLAUDE.md` that is neither a pointer
nor a rule every turn needs is a blocker, and its fix names the file it belongs in. This one runs in
any project: a turn that grows its `CLAUDE.md` has it read so. What the agent finds, blockers and
minor ones, is on the pane; `j` sends it to Claude to fix. Its report is kept from Claude as the
spec critic's is.

It is told the lines each file gained and lost, not both sides whole, and reads the rest itself; while
`/setup-project`'s steps go it waits, and reads what they all wrote once, at the run's end.

### The gate

At the end of a main turn that changed the project, through a tool or, in a git repository, the
shell, the fast tier of `.claude/agent-lens.json` runs. What is red goes back to Claude with the
tail of its output, and the same turn goes on to fix it: three rounds at most, then the turn ends
and the row says `checks: 1 red`. A turn sent back that changes nothing has said the red is not of
its changes: it is let go then, not sent back again for the same red. Where no classic Stop hook
runs, it goes as the next prompt. What was red on the same commit before the agent is not sent
back: the step of the checks keeps it when it first runs them, and `/setup-project baseline` keeps
it again once you say so; on another commit, or with none kept, Claude is told the red may be older
than its changes. The review's notes wait while the gate keeps the turn going. A project with
`.claude/agent-lens.json` has the gate, set up or not; while `/setup-project`'s steps go, it waits.

The same file runs in CI, for everyone, the colleague with no mod included:

```sh
npx -y github:Darvl-52/agent-lens check          # the check of the docs
npx -y github:Darvl-52/agent-lens checks full    # the full tier
```

Each exits 1 on what failed; Node 20 or later. `checks fast` runs the fast tier too, but on a clean
tree, as in CI, a command that takes the changed files has none, and says it did not run.

While a check fails, or the agent's blockers wait, the row above the prompt says `docs: 2 issues`;
`/setup-project check` lists them. Why each file holds what it holds, and what comes next, is in
[docs/setup-project.md](docs/setup-project.md).

## The guard

Each turn of every agent, Claude's own and each subagent's, the ones it starts and the ones a part
of this mod starts, is held to limits counted from the turn's start, each loop on its own:

- **A loop is refused at once**, as a stuck detector finds it: the same tool call with the same
  input a fourth time in a row with the same result each time (a poll whose result moves on is no
  loop), the same call a third time after it failed twice, or two calls taken in turn a sixth time
  with the same results. The agent is told why, and to try another way or say what is in the way.
- **Past half the limit** (30 min or 75 tool calls by default) the next tool result carries a note:
  if the end is not near, stop and report what is done, what is left and what is in the way. You
  get a toast, and the row above the prompt shows `⏱ Claude · 34 min · 80 steps`.
- **Past the limit** (60 min or 150 tool calls) every tool is refused, so the agent answers with
  what it did; you get a notification, and the row shows `■ Claude stopped`. Your next prompt starts
  a new turn and a new count.

The time is the agent's own work: a question put to you, a permission waiting on you, and a
subagent it waits on (which keeps its own count) are left out. `/changes guard` says the limits and
what is running; `/changes guard 90 200` sets them, `/changes guard off` turns the guard off.

## What the agent changed

It works in any project: one repository, a folder of clones each with its own `.git` (`__front`,
`__backend`), submodules, or no git at all; on Windows, macOS and Linux, and where an organization
manages Claude Code.

### Its part of the row

Once a turn has edited a file:

```
✎ 3 files +120 −30 · 1 likely bug · 2 findings · 4 pieces not looked at   /changes
```

- `3 files +120 −30` what the last turn with edits changed, a subagent's edits included.
- `1 likely bug`, in red, `2 findings`, in yellow: what the review found, made by itself after the
  turn, and those of earlier reviews still open, with every rule an edit broke that is still in the
  code. A finding stays until it is sent to Claude or put aside, its file is back as it was
  before the session, or a later review that saw its line change does not find it again. A rule put aside and
  broken again shows again. A later review of the same file is told what was put aside or sent to
  Claude there, so it does not find it again in other words.
- `reviewing…`, in yellow, while the review runs.
- `not reviewed: small change`, as plain text: the turn touched a line or two, so it was not reviewed by
  itself; `r` on Findings reviews it.
- `not reviewed: spec edits, /spec reads them`, as plain text: the turn edited only the Markdown of
  `openspec/`; `/spec` reads that, and the review leaves it out of every turn it reviews, so the two
  do not pick at the same text. `r` on Findings reviews it anyway.
- `review failed`, in red: the model gave no review (the API failed, or its reply could not be
  read); `not reviewed`, in yellow: the review stopped before it finished, as a reload of the mod
  cuts one short. Either opens Findings, which says why, and `r` there runs it again.
- `4 pieces not looked at`, in yellow: hunks you have not marked as looked at.
- `looked at`, in green, once every piece is and nothing is left to fix.

The `✎` is red while a likely bug stands or the review failed, yellow while anything waits, green
otherwise.

### The pane

`/changes` opens it. Four tabs, `1`–`4`, and the diff's mode at the bottom: the **last turn**,
the whole **session**, or what is **uncommitted** (`git diff HEAD` and untracked files) in every
repository the session touched and the project's own. Before Claude has edited anything it opens
on what is uncommitted, and the first turn with edits switches it to that turn. A piece marked
looked at stays so in the other modes, where the turns are cut into pieces otherwise.

1. **Changes.** The files, then the picked one's hunks, each headed by a line on what it does and
   why, in terms of your request. On a hunk: `looked at`, `ask` (a question about this piece), and
   `take back` (Claude removes this piece and puts the lines back). `s` marks the whole file.
2. **Findings.** What the review found: likely bugs, project rules broken (quoted), debugging left
   in, changes nobody asked for, behaviour changed with no test. `fix` sends it to Claude, who
   fixes it or says why it is not a problem; `not a bug` puts it aside. `f`, `fix all`, sends every
   finding still open in one prompt, once two or more are. `r` reviews a diff not yet reviewed (the
   session's or the uncommitted one). What earlier reviews found and nobody has answered yet stands
   below, under its own heading: a later turn does not drop it. Under **Caught while Claude
   edited**, the rules each edit broke: still in the code, a finding like any other; else `not told
   Claude yet`, `told Claude` or `edit refused` in yellow while the turn runs, `fixed` in green once
   it is gone. A finding sent to Claude shows `→ sent to Claude` in yellow, one put aside `✓ put
   aside` in green.
3. **Walkthrough.** The change in reading order: in short, where to start, how the pieces fit,
   what it leaves out. `g` makes it again.
4. **Ask.** A question about the diff, or about one piece after `ask` on it.

Esc closes the pane.

### Rules while Claude edits

Each Edit and Write is checked against the rules for its file by a small model (`haiku`), beside
the turn, so the edit is not slowed down. Where it breaks one, a toast says so and Claude gets a
note with the next tool result:

```
agent-lens: your edit to src/button.ts breaks the project's rules (CLAUDE.md, CODING_STANDARDS.md).
- Never write comments in code.
  found: // primary button styles
  fix: Remove the comment line above the buttonStyle export.
Fix this before moving on.
```

If Claude ends its turn first, the mod waits for the checks still running (up to 8 seconds) and
sends Claude back once to fix what they caught; where an organization manages Claude Code, as a
new prompt right after the turn. A subagent's note goes to the main conversation. A note that
cannot go then (the turn was sent back already, or another hook keeps it going) is not dropped: it
rides on the next tool result, and its rule shows as told only once it has reached Claude. Once
the turn ends, what was caught is looked for again: still in the code, it joins the findings, and
the review after the turn is told not to report it a second time.

Only rules about what files contain are judged (style, naming, comments, structure, forbidden
patterns, hardcoded values); rules about git, workflow or how to talk are not. Edits to `CLAUDE.md`,
`AGENTS.md` and `CODING_STANDARDS.md` themselves are not checked here (the docs agent of
`/setup-project` reads them), nor the Markdown of an OpenSpec change, which `/spec`
reads. A check that fails or answers something unreadable lets
the edit be.

`/changes rules` says how edits are checked and which rule files apply in the project folder.

### The rules it checks against

For each file changed, the `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md` and
`CODING_STANDARDS.md` (the standards `/setup-project` writes, read here rather than on every turn) of
its folder and of every folder above it, up to the project folder (for `__front/src/app.ts`:
`__front/src/`, `__front/` and the project's own), then those Claude Code read at the start from
the folders above the project, each with its `@` imports. Your own `~/.claude/CLAUDE.md` only where
the settings ask for it. Each is read up to 16k characters, all of them up to 48k.

### The branch through lenses

A rule says what one edit must not do; a lens is a kind of mistake and where to look for it: code in
another layer's place, an API wider than its callers need, a fix in create and not in edit, a test
that would pass without the change. `/changes lenses` reads the branch, from where it forks from the
remote's default branch (or from a branch or commit you give, `/changes lenses <base>`), with what
is uncommitted, through each lens. A repository of its own in a top folder of the project, as
dev-env keeps its clones, is read too, each from where it forks. An agent that made none of the
changes reports for every lens: its findings, each a file and line, what is wrong and what it risks;
or clean, with what it checked and the numbers; or not applicable. The pane shows them, the row says
`lenses: N findings`, and `j` sends them to Claude to check against the code, fix what holds and say
why the rest does not; a bug it finds in code the branch does not touch is shown apart and not sent.
`r` reads again; `/changes lenses <commit>` reads only what changed since it.

The lenses are the mod's own, thirteen kinds in any stack, so it works for anyone. A project adds
its own in `LENSES.md` at its root, the kinds its reviews catch, 150 lines at most: a step of
`/setup-project` writes it, and it is checked with the other files of that. Your own `~/.claude/review-lenses.md` joins them only where the
settings ask for it: its kinds are of your projects, not this one. Where two name the same kind,
they are one lens with the examples of both. It reads the branch, not a turn: a look this wide is
worth its cost before a commit or a merge request.

Run by hand by default. The setting Lenses says when else: `offer` (the default), the row offers the
review once an OpenSpec change has every task ticked; `auto`, it runs by itself then, and before the
agent sends out commits the lenses have not read (`git push`, `gh pr create`, `glab mr create`, read
by their words, quotes and dry runs aside): the push is refused once, the review starts, and its
findings come to Claude as the next prompt, the push after them. That push goes once even past the
fixes the findings bring, so the review does not follow its own findings round after round; the same
commits push again freely, and a subagent's push goes. Where nothing can be read, or a review went
past its time, the push goes. `off`, only `/changes lenses`.

### The model and what it costs

The review, the lines on each piece, the walkthrough and the answers run on `sonnet` through Claude
Code's own client, so they count against your plan's limits or your API spend like any request. The
review runs once after each turn that edits more than a line or two; the rest only when you open the
tab, once per version of the diff. Each call sends the rules, then the request, the changed files as
they are now with their lines numbered (whole up to 300 lines and 12k characters each, else the 40
lines around each piece, 32k characters in all) and the diff, both marked for the prompt cache, and
what it asks last: the calls on one diff within five minutes read the rules and the files from the
cache. The review runs at `high` effort and may reason in a few sentences before its answer; the
lines on each piece at `low`, the rest at `medium`. The check of each edit is one `haiku` call
per Edit or Write, the rules sent first and cached, so the checks in one project read them from
the cache. The foot of the pane says what the mod's own calls have cost this session, as the API
counted it: input tokens, those the cache served, output. Sending a finding or a piece to Claude
is a turn of the session itself, on its own model.

The diff of a turn is taken from the edit tools (Write, Edit, NotebookEdit) and from the shell: a
file a command (`sed -i`, a generator) left uncommitted that was not before it is in the turn, from
what it was before the turn, or from what is committed. That holds in the project's repository, in
every repository a tool edited a file in, and in a repository of its own in a top folder of the
project (dev-env's `__front`, `__bff`…); a file already uncommitted there before the command is
not. The uncommitted mode shows every change in those repositories.

A diff keeps 2,000 lines of a file and 20,000 in all (400k and 2M characters): a turn that deletes
or rewrites a big file (a lockfile, a data file) shows the rest as `N lines left out` on the file's
row, in yellow, and the review is told so; its counts are whole, and a piece cut short has no `take
back`. A file over 4 MiB, which Claude Code does not read, is left out of the diff.

## The OpenSpec change

### Its part of the row

In a project with an `openspec/changes` folder, one row shows the change in view (the one you
picked, else the latest edited): first what wants a look, red before yellow, then its progress.

```
◆ add-dark-mode · 2 to decide · spec changed · tasks 7/12 · tests 9 auto, 2 manual   /spec
```

- `tasks 7/12` the ticked boxes of `tasks.md`, followed as agents tick them; green once all are.
- `tests 9 auto, 2 manual` the test cases of `test-cases.md` by their `Automated:` and `Manual:`
  lines (bold or in a list item too, `- **Automated:** e2e/a.spec.ts, e2e/b.spec.ts`); `13 test
  cases` where the file marks none of them. A case is any heading that starts with its id:
  `## TC-01: Title`, `### TC-02. Title`.
- `TC-07 unmarked`, in red, a case that says neither, where the file marks the others.
- `2 cases with no test`, in yellow, cases marked `Automated:` none of whose files holds a test
  with their id.
- `2 to decide`, in yellow, what the brief found left for a person to decide; `what to decide
  unknown`, in yellow, where the brief came without that list (`g` on Decide makes it again).
- `1 decided, not sent`, in yellow, a decision you made in the pane and have not sent to Claude yet.
- `1 spec error`, in red, `2 warnings`, in yellow: what `openspec validate --strict` found, run
  on the change each time its text changes (where the `openspec` CLI is installed).
- `3 scenarios with no case`, in yellow, scenarios of the change's specs that no test case names on
  its `Covers:` line (`Covers: Requirement: X / Scenario: A; Scenario: B`; a requirement named
  alone counts whole). Where no case has such a line, nothing is counted.
- `1 not matching the main spec`, in yellow, a requirement the change adds that the main spec
  already has, or changes that it does not have: `openspec archive` refuses those.
- `overlaps door-access-page`, in yellow, another active change whose specs touch the same
  capability: the two will collide when the second is archived.
- `spec changed`, in yellow, the change was edited since you last read it. Ticking tasks off is
  progress, not a change, and does not count.
- `ready to archive`, in green: every task ticked, the check clean, nothing left to decide, every
  test case marked and with its test, every scenario covered, every requirement matching the main
  spec.

The `◆` is red while a case is unmarked or the spec has errors, yellow while any part above waits
for you, green otherwise.
`making the brief…`, in yellow, while the model reads the change.

Each part opens the pane on the tab that tells more of it: `2 to decide` on Decide, `spec changed`
on Changes, `1 spec error` on Spec. `/spec` at the end opens the pane where you left it. Where the
row is too narrow, progress gives way first, and `+3 more` says how much was left out, in red or
yellow where that holds a problem.

### The pane

`/spec` opens it on the change in view, `/spec <change>` on another, and the pane's change list
at the bottom switches between the active ones (your pick is kept). The change and its `◆` head
the pane; under them seven tabs, `1`–`7`, each with a count of what is in it to look at. A button
pressed by a key shows the key before its label (`g refresh`), and the last row says the keys.
The model reads for one tab at a time: what you ask for while it reads (a question during the
brief, say) waits its turn, and the pane says what comes next.

1. **Brief.** The gist, what is out of scope, the key decisions with their reasons, the risks.
   Made by the model when you open a change whose brief is missing or older than the change, and
   kept, so opening it again costs nothing. `g` makes it again; a brief older than the change says
   so at its top.
2. **Changes.** Each file edited since you last read the change, lines added and removed. `e` asks
   the model what changed in substance, `s` marks it read. The first time you open a change counts
   as reading it.
3. **Decide.** The brief's list of what needs a person: open questions, TODOs, choices made without
   a reason or on an assumption, each with the file it is in. `decide` on a point opens two or three
   ways to settle it, offered by the model for all the points at once, and a field for your own;
   the one the model recommends comes first, marked `★`, with why under it. Picking one opens the next point, `change` and `clear` take it back. `a` sends what you decided
   to the session as your prompt: Claude writes it into the change's files and asks you where a
   decision contradicts the spec. `d`, `Claude decides all`, sends every point not decided yet:
   Claude takes the answer the change and the code argue for, writes it in with its reason, and
   asks you about a point it cannot settle alone. Once Claude's turn has changed the spec, the brief
   is made again by itself, told the points already decided so it does not ask them again, and the
   tab shows what is left. A turn that ends with the spec as it was
   says so: `w` sends the decisions again, `change the answers` brings them back to the tab.

   **The critic**, off unless you turn it on (`/spec critic button` or `auto`, or in Settings): an
   agent (Explore, on `sonnet`) reads the change and the code it names or will touch, and lists up to
   five holes at the top of the tab, each with where it shows and how to close it: something the
   change names that is not there, code it will touch and does not mention, its files contradicting
   each other, a requirement no task builds or no case checks, a case the specs leave undefined.
   Each hole is a **blocker** (built as the files say, the work goes wrong or a requirement goes
   unchecked) or **minor** (a detail the code settles without asking anyone, such as an initial
   value), the way an inspection sorts major and minor defects. `f` sends it to look; `h` sends what
   it found to the session as your prompt, and Claude takes the holes one at a time: closes each in
   the change's file where it belongs, asks you where only you can decide (what you leave open goes
   under Open Questions in `design.md`), or declines it in a line of `design.md` where the code shows
   the agent is wrong, and ends with a table of what it did. In `auto` it also looks after each turn
   that changed the change's text (a task ticked is not a change), and the blockers it finds go to
   Claude by itself, once the turn running has ended with an answer: a turn you stop with Esc, or
   one an error ends, leaves them waiting and starts no critic. The minor ones stay on the tab for
   `h`. Each round is told what was decided and sent before, so it does not report it again. Auto
   mode stops at a look with no blocker (`✓ No blocking holes`), or after three rounds of the change,
   what the last one changed yours to look at; either way only `f` starts it again, the rounds
   counted anew. The report the
   engine hands back to the session as the agent ends is kept from Claude: the holes reach it only
   by that prompt, so none is closed twice.
4. **Tasks.** The tasks of `tasks.md` under their headings, ticked or not. `n` sends the next one to
   the session as your prompt, `do` on a task sends that one: Claude reads the change, does the
   task alone, runs its check if it names one, and ticks it; with Matt's `tdd` installed, a task that
   changes behaviour is built test-first at the seam the design names. A task sent is marked so until it is
   ticked, and the next one skips it; `send again` sends it once more. Once every task is ticked
   the tab opens with what still stands between the change and its archive, or with `archive`: a
   second press sends it to the session, and Claude archives it the project's way (its archive
   skill or command, else `openspec archive`) and says what changed in the main specs. In a project
   `/setup-project` prepared, it first moves what the change settled into the docs: its new domain
   terms to `GLOSSARY.md`, its decisions that qualify to `docs/adr/`. While the change is still
   there, `send again` sends the archiving once more. Once it is gone, where Matt's `retro` is
   installed, the row above the prompt offers a retro of the work: `/retro` runs it as if you typed
   it, `×` lets it go.
5. **Tests.** Each test case of `test-cases.md` and where it stands: `✓ has a test` (the file its
   `Automated:` line names, under the project or a repository in it, holds a test with the case's
   id: `TC-01`, not `TC-010`), `● no test`, `◇ manual`, `✗ unmarked`. Press a case to pick it,
   `p` sends the picked ones to the session, `c` every case without a test or a mark. Claude writes
   each test from the case's steps in that file, its id in the test's name and tags, runs it and
   makes it pass; automates a manual case where it can; marks an unmarked one first. A case sent
   shows so until its test is there. Under the cases, the scenarios of the change's specs no case
   covers, picked and sent the same way: Claude adds a case for each to `test-cases.md` in the form
   the others have, then writes and runs its test. A scenario leaves the list once a case covers it.
6. **Spec.** What `openspec validate --strict` says of the change, the test cases marked neither
   way, the other active changes in the
   same specs and the requirements both name, then every requirement the change adds, changes,
   removes or renames, by capability, with its scenarios and the ones no test case covers. A
   capability `openspec/specs` does not have yet is marked new (and warned of, where the change
   modifies its requirements as if it existed); against an existing one, an added requirement it
   already has or a changed one it lacks is marked. Read from the files, no model.
7. **Ask.** Type a question, Enter, or pick one of the three offered: the model answers from the
   change alone and says where it says so, or that it does not.

What the model is doing shows under the tabs, whichever is open. Where it gives no answer, the
error says why in plain words (`the API is overloaded, try again in a minute`), `r` runs the same
call again, `dismiss` puts the error away. Esc closes the pane.

### The model and what it costs

The brief, the explanation of changes and the answers run on `sonnet` through Claude Code's own
client, so they count against your plan's limits or your API spend like any request. A brief reads
the whole change: about 10k tokens for a small one, 40k for a large one. The change is sent first
and marked for the prompt cache, so a question asked within five minutes of a brief reads it from
the cache. Nothing is sent until you open the pane, press `g` or `e`, open a point to decide, or
ask. The decisions you send with `a` are a turn of the session itself, on its own model.

The critic is an agent that reads the code, not one call: from about 100k tokens for a small change
to 300k for a large one, most of them from the cache. In `auto` mode that is once per version of the
change's text, and three rounds at most until you press `f`, each followed by Claude's turn closing
what it found; a look with no blocker ends them sooner.

## The skill for each prompt

Claude picks skills by their descriptions, and often doesn't: it goes straight to the code. The
router decides before the turn starts. Your rules come first and cost nothing. Where none fits, a
small model (`haiku`) reads the prompt, the exchange before it, the OpenSpec changes in progress
and the list of skills, and picks the one that fits, or none. Claude is then told to load it.

```
> In the cart the total is sometimes wrong, sometimes right. Find out why.
  skill: diagnosing-bugs
● Skill(mattpocock-skills:diagnosing-bugs)
```

### How it works

- Every skill the Skill tool can run is a candidate: plugin skills (`mattpocock-skills:tdd`), your `~/.claude/skills` and `~/.claude/commands`, the project's `.claude/skills` and `.claude/commands` (OpenSpec puts its own there). Install or write a skill and it is routed from the next prompt on. A skill marked `disable-model-invocation` is yours to type (`/mr`), as the Skill tool refuses it: it is never routed, `/router list` marks it `−`, and `/router add` says so.
- The project's own skills (its `.claude/skills` and `.claude/commands`) come first in what the model reads, marked `[project]`, and it picks one of them over a general skill for the same kind of work: in a project with OpenSpec's skills, "write a spec for these bugs" gets `openspec-propose`, not a general spec skill. Where none of them fits, the general skills are routed as before, in the same one call.
- Your rules are checked first; a word matches at the start of a word in any case, so `test` finds `tests` but not `latest`, and `тест` finds `тесты`. A rule that fires skips the model, its skill loaded already or not.
- Otherwise the model picks, for prompts that say more than a word or two. It sees your previous prompt and the end of Claude's last answer, so "now the tests" reads as part of the work under way, and the OpenSpec changes in progress with their tasks, so it can name the change. It reads at most the first 4,000 characters of a prompt and 400 of each skill's description.
- The model says first what the prompt is: work, a question, an answer to Claude or a step of the work under way, or small talk. Only work gets a skill: "why is the discount taken before delivery?" asks about the cart and loads nothing, however much it is about code. The pane's history says which it was (`a question, not work: no skill`).
- A skill already loaded in the conversation is not picked again until `/clear`, `/resume` or a compaction. After `/clear` or `/resume` the router also forgets your previous prompt and Claude's last answer, takes the last pick off the status line, and reads its mode and your rules again (off says so there).
- A prompt that names a skill (`/tdd`, `mattpocock-skills:tdd`), a slash command, and prompts from other plugins or scheduled runs are left alone.
- If the model fails or is slow (4 seconds; it answers in one or two), the prompt goes through as typed, and the status line says how: `skill: model failed: no answer in 4 s`, `overloaded (529)`, `rate-limited (429)`, `no connection`, `answer not read`. Once is a blip, and the next prompt asks again; after two failures in a row the model is not asked for five minutes, so the prompts after it are not kept waiting too, and the status line says when it is asked again (`skill: model failed (overloaded (529)), asked again in 4 min`). A prompt stopped with Esc is no failure.

### Add your own

```
/router add tdd test, тест, /red.?green/      run tdd when a prompt says one of these
/router when tdd for any new feature           tell the model when tdd fits
/router ignore docs                            never route to docs
/router rm 1                                   drop your rule 1
/router list                                   every skill it routes among
/router lang ru                                /router and the status line in Russian (en back)
```

Short names work where one skill ends in them (`tdd` for `mattpocock-skills:tdd`); `/router add <Tab>` completes them.

For a team, put the rules in the project's `.claude/skill-router.json` and commit it. They come before your own:

```json
{
  "rules": [
    { "skill": "openspec-apply-change", "when": ["next task", "следующая задача"] },
    { "skill": "diagnosing-bugs", "when": ["flaky", "/regress(ed|ion)/"] }
  ],
  "hints": { "tdd": "for every new API endpoint" },
  "ignored": ["morning"]
}
```

To write a new skill, ask Claude to use `skill-creator`; the router picks it up once it is saved.

### The pane and the modes

`/router` opens a pane with four tabs, switched with `1`–`4`:

- **Overview**: the last prompt, the skill it got, by a rule or the model, and why; the session at a glance.
- **Rules**: your rules and hints, each with ✕; a form to add one (pick the skill, type the words, Enter); the project's rules.
- **Skills**: every skill by the plugin it comes from; Enter routes it or leaves it out.
- **History**: every prompt of the session and what it got; **+ rule** turns a model's pick into a rule that costs nothing.

`a`, `s`, `o` switch the mode, `l` the language, Esc closes. `/router rules`, `/router skills`, `/router history` open the pane on that tab.

- `auto` (default): Claude is told to load the skill before it starts.
- `suggest`: Claude is told the skill may fit and decides.
- `off`: nothing is routed.

Switch with `/router auto`, `/router suggest`, `/router off`, or the buttons in the pane. The status line shows the skill picked for the last prompt, `skill: model failed: …` where the model gave no pick, and why, and `skill router: off` while the router is off.

## Commands

| Command                    | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `/changes`                 | Open the review of what the agent changed.                           |
| `/changes rules`           | How edits are checked, and the rule files that apply.               |
| `/changes lenses [base]`   | Read the branch through each lens, as under The branch through lenses. |
| `/changes guard [on\|off\|<minutes> <steps>]` | The limits on each agent's turn and what runs now; sets them, as under The guard. |
| `/setup-project`           | Prepare the project for work with the agent, as under Setting a project up. |
| `/setup-project check`     | The check of the files it writes.                                    |
| `/setup-project baseline`  | Run the fast checks and keep what is red as red before the agent on this commit. |
| `/spec`                    | Open the pane on the OpenSpec change in view.                        |
| `/spec <change>`           | Pick another active change and open the pane on it.                  |
| `/spec critic off\|button\|auto` | Whether an agent looks for holes in the change, as under Decide.  |
| `/router`                  | Open the router's pane; `rules`, `skills`, `history` open that tab.  |
| `/router auto\|suggest\|off` | How the router acts on a pick.                                      |
| `/router add`, `when`, `ignore`, `rm`, `list` | Your routing rules, as under The skill for each prompt. |
| `/changes lang ru`         | Every part in Russian, its model's answers too; `lang en` back. The same after `/spec` or `/router`. |
| `/agent-lens`              | Turn each part on or off: the review, its check of each edit, the OpenSpec change, the router, the guard, the lenses, the setup. |

## Turning parts off

`/agent-lens` opens a menu of the parts, each with its key (`1`–`7`) to turn it on or off, kept for every session. A part turned off does none of its work: no hooks, no model calls, nothing on the row; its command still answers, with where to turn it on. An agent the part started before it was turned off finishes and reports as before. The check of each edit goes with the review: with the review off it is off too. A part's own switch (`/router off`, `/changes guard off`, the settings below) still holds while the part is on.

## Settings

In `/plugin`, select agent-lens, then Configure:

| Setting                     | Default | What it does                                                                                                                                         |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                    | `en`    | Every part's language until `lang` sets one                                                                                                          |
| Rules while Claude edits    | `warn`  | `warn` checks each edit beside the turn and tells Claude; `block` checks it before it lands and refuses it (a few seconds on every edit; an edit refused twice in a turn for one rule goes through on the next try, on Findings for you to judge); `off` leaves the rules to the review |
| Model for the edit check    | `haiku` | An alias or a full model id                                                                                                                          |
| Include ~/.claude/CLAUDE.md | off     | Also check edits and reviews against your personal `CLAUDE.md`                                                                                       |
| Include ~/.claude/review-lenses.md | off | Also read the branch through your personal lenses, beside the mod's own and the project's `LENSES.md`                                    |
| Lenses                      | `offer` | `off`: only `/changes lenses`; `offer`: the row offers them once a change's tasks are ticked; `auto`: they run by themselves then, and before the agent pushes commits they have not read |
| Critic for the spec         | `off`   | `button`: an agent looks for holes in the change when you press `f` on Decide; `auto`: also after each turn that changes it, and the blockers it finds go to Claude to close, until a look finds none and three rounds at most, then it waits for `f`; `/spec critic` overrides it |
| Guard over each agent's turn | `on`   | `off`: no limit on any agent's turn, as under The guard; `/changes guard` overrides it                                                               |
| Guard: minutes per turn     | `60`    | The limit on one turn of an agent, in minutes of its own work; at half it is told to wrap up                                                         |
| Guard: tool calls per turn  | `150`   | The limit on one turn of an agent, in tool calls; at half it is told to wrap up                                                                      |
| Route with a model          | on      | Off: only your rules route, no model calls                                                                                                           |
| Model for routing           | `haiku` | An alias or a full model id                                                                                                                          |

## Coming from the four mods

agent-lens does what review-lens, rules-watchdog, openspec-lens and skill-router did. Uninstall
them, or each prompt is routed, each edit checked and each turn reviewed twice:

```
/plugin uninstall review-lens@review-lens
/plugin uninstall rules-watchdog@rules-watchdog
/plugin uninstall openspec-lens@openspec-lens
/plugin uninstall skill-router@skill-router
```

What they kept is not carried over: your routing rules (`/router add` them again; a project's
`.claude/skill-router.json` is read as before), the router's mode, the language, and the spec's
briefs, which are made again the first time you open a change.

## Install

Needs Claude Code 2.1.281 or later. At the prompt of a Claude Code session:

```
/plugin install agent-lens --marketplace Darvl-52/agent-lens
```

`y` adds the marketplace, then pick a scope. From a shell:

```sh
claude plugin install agent-lens --marketplace Darvl-52/agent-lens
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `Darvl-52/agent-lens`, then Add plugin.

Mods are early access, and Claude Code may not load an installed plugin's hooks module: with a
third-party provider (Bedrock, Vertex, a gateway) or with telemetry turned off, nothing shows and
`/changes` is an unknown command. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment
Claude Code starts in, then start a new session. `claude --debug` says why a module was not loaded:
search its log for `hooks module`.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

After an edit to `bin/cli.mjs` or what it imports (`hooks/setup/checks.ts`, `docs.ts`, `words.ts`),
`bun run build` bundles the CLI again into `bin/agent-lens.mjs`, which is committed: npx runs it.
A release bumps the version in `package.json` with `plugin.json` and `marketplace.json`.

`hooks/register.tsx` registers every hook; each part lives in its own folder under `hooks/`
(`review`, `spec`, `router`), what they share under `hooks/core`.

## License

MIT
