# /setup-project

`/setup-project` prepares any project for work with the agent, and then keeps the files it wrote
from going stale. The aim: one set of instructions that both the agent and the people read, changed
only in known ways and checked like code.

## What it needs

Any project, any stack. Nothing here reads a manifest: where a step needs to know how the project is
built, checked or run, Claude reads the project.

Recommended, never required:

- **Matt Pocock's skills** (`mattpocock-skills`): `setup-matt-pocock-skills`, `domain-modeling`,
  `writing-for-agents`, `grilling`, `tdd`, `retro`. Without them, Matt's setup step is left out and
  the workflow names none of his skills.
- **The `openspec` CLI.** Without it, its two steps are left out, and changes are planned in the
  issue.
- **A CI.** Without one, the CI step is left out.

The first line says what it found
(`✓ Matt’s skills installed · ○ OpenSpec recommended: npm install -g @fission-ai/openspec · ✓ CI: .gitlab-ci.yml`).
A step left out says why on its row. Install what it needs later, and `run again` on that row (or the
next `/setup-project` once the run is done) brings it in.

## The files and what each holds

One fact lives in one file, and each file has one job. Only `CLAUDE.md` has a size limit; the
others grow as the project needs, and the docs agent sends back a line that says nothing new or
more than it needs.

| File | Holds | Not | Size |
| --- | --- | --- | --- |
| `CLAUDE.md` | Pointers to the files below, and the few rules every turn needs | Anything another file holds | 120 lines |
| `GLOSSARY.md` | The project's own terms: a definition each, the words to avoid | Paths, code, decisions, general terms | (format) |
| `ARCHITECTURE.md` | The map: modules, their bounds, who calls whom, where the data lives | Detail the code says better | |
| `docs/adr/NNNN-*.md` | A decision that is hard to reverse, surprising, and a real trade-off; and why | Decisions that are none of the three | short |
| `CODING_STANDARDS.md` | Rules an edit can be checked against; the security rules under `## Security` | Style a linter enforces; wishes | |
| `LENSES.md` | Kinds of mistake this project's reviews catch, beyond the mod's own, with where to look | A rule of one edit (that is a standard) | |
| `docs/agents/workflow.md` | How work goes, step by step, which skill at each, where the person decides | Project facts | |
| `openspec/config.yaml` | `context`: pointers to the files above; `rules`: per artifact | Copies of their text | |
| `.claude/agent-lens.json` | The checks in two tiers (by folder in a monorepo); how the project is brought up | The commands copied into `CLAUDE.md` or CI | |
| `.claude/settings.json` | What the agent may and may not run | | |

`CLAUDE.md` is read into every agent's context, so it stays small and points elsewhere. The rest
are read when needed: agent-lens checks each edit against `CODING_STANDARDS.md` beside `CLAUDE.md`.
`GLOSSARY.md` and the ADRs follow `domain-modeling`'s formats, so Matt's skills read them as their
own.

## How the files change

Only in known ways:

1. `/setup-project` and its steps.
2. The archive of an OpenSpec change: its new terms go to `GLOSSARY.md`, its decisions to ADRs.
3. Matt's `retro`, offered after an archive.
4. Your own edit.

Any other edit the agent makes to these files is read by the docs agent. Taking out matters as much
as putting in: a rule that changes no behaviour, or a term no code uses any more, is flagged.

The mod also watches for the agent loosening the rules. If it takes a rule line out of `CLAUDE.md`,
`AGENTS.md` or `CODING_STANDARDS.md`, or a command out of the fast checks in
`.claude/agent-lens.json`, that waits for you in To decide (`/agent-lens decide`): `y` leaves it,
`f` has Claude put it back. The steps that write those files are let be.

## Running the steps

**What happens.** The steps go to Claude one at a time, each once the turn before has ended. Each
step's prompt tells Claude to:

- write what the code and the files show by itself;
- ask you (with AskUserQuestion) only what it is unsure of, all at once at the end, a few at a time
  with multiple choice;
- end with a table of what it wrote and where it took it from.

The permissions step is the exception: it always asks you what else to deny.

**The pane.** Each step's row shows where it stands: waiting, with Claude, done, skipped, or check
failed. A waiting step that costs a lot says so: the existing docs, the map, the standards and the
security rules are long turns; the lenses step, which reads some fifty merge requests, is the
dearest. Any step not sent yet has a `skip` button.

| Key | What it does |
| --- | --- |
| `n` | Send the next step. |
| `s` | Skip the current step. |
| `w` | Send the current step again. |
| `f` | Send back what failed its check. |
| `c` | Once every step is done, have Claude commit what they wrote (`s` lets that go). |

**When a step is done.** Once its files are there and pass the check. If they fail, what failed goes
back to Claude once. If it still fails, the step waits for you: `f`, `w` or `s`. If you stop a
step's turn with Esc, the step is marked failed and the row above the prompt says
`setup: step N stopped, waits for you`. `w` sends it again, `s` skips it.

**Running again.** A step skipped, left out, or failed once the run went past it has `run again` on
its row. It then waits its turn among the others. Run again, a step adds to what is there and never
writes over it. A step you skipped stays skipped when you run `/setup-project` again; only its
`run again` sends it.

**What else waits during a run.** The gate does not run, the docs agent reads everything once at the
end, and the edits a step makes to its own docs are not checked edit by edit (the step's check and
the docs agent read them). The row does not offer the OpenSpec task-rules line while a run is under
way, as a step of the run adds it.

## The steps

1. **Matt's skills.** `/mattpocock-skills:setup-matt-pocock-skills`, run as if you typed it: the
   tracker, the labels, the domain layout. Done already where `docs/agents/` holds its files.
2. **OpenSpec in the project.** `openspec init --tools claude`, run by the mod. Done already where
   `openspec/` exists.
3. **What is already written.** Claude finds the docs the project works by (`CLAUDE.md` and its
   imports, `AGENTS.md`, a glossary under its old name `CONTEXT.md`, other agents' rules, project
   skills, the parts of `README.md` for developers), cuts them into pieces and gives each a home
   among the files above. It moves a piece word for word, so each fact stays in one file. It asks
   you about a piece it would take out and one whose home is unclear. `CONTEXT.md` becomes
   `GLOSSARY.md` by `git mv`. This step writes nothing new. Done already where the project has no
   such docs.
4. **The map.** `GLOSSARY.md`, `ARCHITECTURE.md`, and an ADR in `docs/adr/` for each decision the
   code shows that qualifies, numbered on from the last. In a project with parts that have their own
   domains, a glossary per part and a `GLOSSARY-MAP.md` linking them. Claude asks where a term or
   decision is not clear from the code.
5. **The coding standards.** Rules the code keeps, each one a reviewer can check an edit against.
   A mechanical rule (a banned API, an import's shape, where a file lives) goes to the linter's
   config, as a tool checks it better than prose. A judgement goes to `CODING_STANDARDS.md`. Each
   says what, why, where it shows, and what checks it (`eslint: <rule>` or `review`). Claude writes
   the rules the code keeps throughout, and asks about those it keeps only in part. Then it runs
   the lint script and says what the new rules found.
6. **The security rules.** Claude reads what can be attacked: client or server or both, what takes
   input from outside, where that input lands, how access is checked, where secrets live. It
   decides what applies without asking, from a floor of rules (frontend and backend apart) and a
   list of the holes AI-written code fails most (why these: `docs/security-research.md`). Rules go
   under `## Security` in `CODING_STANDARDS.md`, or to a linter already installed. A line in
   `CLAUDE.md` has the agent read them before it writes code that handles input, data, secrets or
   access; where there is no `CLAUDE.md` yet, step 11 writes it with that line. A project with no
   surface gets no rules. It ends with what it took the project to be, what it wrote and left out,
   and where the code already breaks a rule. Nothing beyond these rules is refused or searched for
   holes.
7. **The lenses.** Claude gathers the review comments on the last fifty or so merged merge or pull
   requests (GitLab or GitHub), or the history of fixes where neither CLI reads them. It checks each
   comment against the code: a wrong one goes to what to push back on, the rest are sorted into
   kinds of mistake, the most frequent first. A kind the mod already has takes only what this
   project adds. Claude writes each lens backed by two comments or more, and asks about one backed
   by a single comment or a comment it doubts. The result is `LENSES.md`. None found, nothing is
   written.
8. **The checks.** Read from the project's own scripts and CI, in `.claude/agent-lens.json`: `fast`
   for the end of each turn (lint, types, the tests of the changed files) and `full` for before a
   commit, push or merge; by folder in a monorepo. Claude asks about a command it doubts is fast
   enough and one nothing in the project runs. The mod then runs the fast tier once: a command that
   does not start or takes over two minutes goes back, and what is red is kept as red before the
   agent.
9. **Bringing it up.** `run.up`, `run.smoke` and `run.down`, or `"run": null` for a library. Where
   there is no smoke test, Claude writes the smallest one. It asks only if the files show more than
   one way up. Then it runs up, smoke and down once.
10. **Permissions** in `.claude/settings.json`. Always denied: `git push --force` and `-f`,
    `git reset --hard`, `git clean -f`, `rm -rf` and `rm -fr` (by prefix, so a rail against slips,
    not a sandbox). Allowed: the commands of `.claude/agent-lens.json`, git that only reads, the
    test runners. Claude proposes what else to deny (files with real secrets, commands that deploy
    or reach production) and asks you to pick.
11. **How work goes, and `CLAUDE.md`.** `docs/agents/workflow.md`: how work goes here, which skill at
    each step, where you decide, and when a task is done. `CLAUDE.md`: the language you are spoken
    to in first, pointers to the files (`GLOSSARY.md` imported with `@GLOSSARY.md` while it is under
    80 lines), how to install, run and commit, the checks in a line pointing to
    `.claude/agent-lens.json`, and the agent as orchestrator: it plans and puts results together,
    and hands the work to subagents by default, independent parts in parallel.
12. **OpenSpec reads the files.** `openspec/config.yaml`: `context` points to the files; `rules`
    hold the artifacts to them, and each task names the rules and lenses it touches. OpenSpec gives
    the agent the artifacts' rules only while it writes them, and `tasks.md` is what it reads as it
    builds. Outside a run, a project whose config lacks this gets it offered on the row (`add`, or
    `×` for good).
13. **The checks in CI.** A job on each merge or pull request and each push to the main branch,
    running `npx -y github:Darvl-52/agent-lens check` and `… checks full`.

## A project with docs of its own

Most projects already have a `CLAUDE.md`, often long, mixing rules, architecture and terms. Step 3
sorts it before anything is added, so each fact ends in one file: a piece moves rather than being
copied, and later steps write only what is missing. A glossary under its old name, `CONTEXT.md`, is
renamed, as Matt's skills now read `GLOSSARY.md` and the check flags the old name until it is.

## The checks of the files

Like `openspec validate --strict`: a file that fails is an error, not a suggestion.

**Without a model**, at each session's start and after each edit to the files:

- a file past its size (`CLAUDE.md` with what it imports);
- a glossary under its old name, `CONTEXT.md` or `CONTEXT-MAP.md`;
- a path a file names in backticks that does not exist;
- a `GLOSSARY.md` entry out of its form (`**Term**:` and a definition of one or two sentences,
  `_Avoid_:` optional), or one that names a path or code;
- an ADR not named `NNNN-slug.md`, numbers that skip or repeat, one with no title;
- the same line (of some length) in two files.

**By the docs agent** (Explore on `sonnet`), at the end of a turn that edited the files: is it true
of the code, is it in its file, does it change what an agent does, does it repeat another file. A
line added to `CLAUDE.md` that is neither a pointer nor a rule every turn needs is a blocker. Each
finding is a blocker or minor. The agent is given the lines changed, not whole files. In a project
not set up, it reads only `CLAUDE.md`, on a turn that grows it.

What you do depends on the Autonomy setting. In `auto`, its blockers go to Claude by themselves
(`full` sends the minor ones too), and what Claude rejects waits in To decide. In `manual`, `j` on
the pane sends them.

**Drift**, at each session's start:

- a part of the map with 15 commits or more since the map was last edited;
- a glossary term `git grep` finds nowhere else in its repository.

Git matches a term only as written, so such a term goes to the docs agent first (on `haiku`), which
looks for other forms of the word, synonyms and the code's name for it. Its answer holds 30 days.
In `auto`, a term it found nowhere goes to Claude to take out of the glossary; if Claude says it is
in use, that waits in To decide, and `y` keeps the term for good. Only a term the agent could not
look at is asked of you. In `manual`, each term it did not find is asked in the pane: `u` in use
(kept for good), `x` take it out (sent to Claude), `l` later (asked again next session or after
`/clear`), `z` undoes the last answer.

The row above the prompt says `docs: N issues` while a check fails or blockers wait, and
`glossary: N questions` while a term waits for you. `/setup-project check` lists them.

## The gate

A rule in `CLAUDE.md` that says "send only on green" is a wish: late in a long context the model
forgets it. The gate makes it a check.

- **The tiers.** `.claude/agent-lens.json` holds `checks.fast` (seconds, a minute or two) and
  `checks.full` (everything), as shell lines. `{files}` in a fast command is replaced by the files
  changed since the commit the turn started on, so a turn that committed still checks its files.
  With none, that command does not run. `{files:py,pyi}` takes only those extensions. In a monorepo
  each folder runs its own.
- **At each turn's end.** A main turn that changed the project, through a tool or the shell, has the
  fast tier run before it ends. Red goes back to Claude with the end of the output, and the same
  turn goes on. After three rounds the turn is let go and the row says `checks: N red`. A turn sent
  back that changes nothing is let go too: Claude has said the red is not of its changes. Where no
  classic Stop hook runs, the red goes as the next prompt. The review's notes wait while the gate
  keeps the turn going.
- **Red before the agent.** What was red on a commit before the agent touched it is not sent back.
  The checks step keeps it when it first runs them, and `/setup-project baseline` keeps it again on
  your word (only you can run it; from the model it answers "Only you can change this"). On another
  commit, or with nothing kept, Claude is told the red may be older than its changes.
- **A broken config.** If `.claude/agent-lens.json` does not parse, the gate holds the agent to
  nothing, and the row says `checks off: .claude/agent-lens.json does not read (…)`.
- **In CI.** `npx -y github:Darvl-52/agent-lens check` runs the check of the docs, and
  `… checks full` the full tier, from the same file, for colleagues without the mod too (Node 20 or
  later). `checks fast` runs the fast tier, but on a clean tree a command that takes the changed
  files has none and does not run.

## How work goes

OpenSpec holds the changes: proposal, design, specs, tasks. It is the one place for them, so Matt's
`to-spec` and `to-tickets` are not part of this way of working. Matt's skills are the discipline at
each step:

1. An idea is grilled (`grilling`) before it is proposed.
2. `openspec propose`, in the glossary's terms; `domain-modeling` while designing, new terms to the
   glossary as they settle.
3. Tasks: `tdd` at the seams the design names; `diagnosing-bugs` for a bug.
4. Review: agent-lens on each edit and each turn; the branch through the lenses once every task is
   ticked (offered on the row, or run by itself in `Lenses: auto`, which also reads the work before
   the agent pushes it); `code-review` on the whole.
5. Archive: terms and decisions moved to `GLOSSARY.md` and the ADRs; then `retro`.

`docs/agents/workflow.md` says this for the project, and marks where you decide.

## Not built yet: lessons

Planned, not in the mod today. A mistake the agent fixes (a red check turned green, a review or
lens finding fixed) would be kept as a case in `.claude/lessons.json`. Cases of one kind seen twice
would be judged by an agent that made none of them, turned into a rule for `CODING_STANDARDS.md`,
the linter or `LENSES.md`, put to you, and then looked for in the rest of the code.
