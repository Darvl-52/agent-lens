# /setup-project

Prepares any project for working with the agent, and keeps what it writes from rotting. The aim
is work the agent and the person can both follow: one set of instructions both read, every change
to them made by a known way and checked like code.

## What it needs

- The skills of `mattpocock-skills`: `setup-matt-pocock-skills`, `domain-modeling`,
  `writing-for-agents`, `grilling`, `tdd`, `retro`. Missing, `/setup-project` stops and says how to
  install them.
- The `openspec` CLI. Missing, it stops the same way. A project with no `openspec/` folder is not an
  error: initialising it is one of the steps.

Found, it says so in one line (`✓ mattpocock-skills · ✓ OpenSpec 1.14.1, openspec/ here`) and goes on.

## The files and what each holds

One fact lives in one file. Each file has one job and a size it may not pass.

| File                   | Holds                                                                     | Not                                       | Size        |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| `CLAUDE.md`            | Pointers to the files below, and the few rules every turn needs           | Anything another file holds               | 120 lines   |
| `GLOSSARY.md`          | The project's own terms: a definition each, the words to avoid            | Paths, code, decisions, general terms     | (format)    |
| `ARCHITECTURE.md`      | The map: modules, their bounds, who calls whom, where the data lives      | Detail the code says better               | 150 lines   |
| `docs/adr/NNNN-*.md`   | A decision hard to reverse, surprising, the result of a trade-off; why    | Decisions that are none of the three      | short       |
| `CODING_STANDARDS.md`  | Rules for code, each one an edit can be checked against                   | Style a linter enforces; wishes           | 300 lines   |
| `docs/agents/workflow.md` | How work goes, step by step, which skill at each, where the person decides | Project facts                           | 120 lines   |
| `openspec/config.yaml` | `context`: pointers to the files above; `rules`: per artifact             | Copies of their text                      |             |

`CLAUDE.md` is read into every agent's context, so it stays small and points. The standards are
read at review: agent-lens checks each edit against `CODING_STANDARDS.md` beside `CLAUDE.md`.
`GLOSSARY.md` and the ADRs follow the formats of `domain-modeling`, so Matt's skills read them as theirs.

## How they change

Only by a known way, each saying why:

1. `/setup-project`, its steps below.
2. The archive of an OpenSpec change: its new terms go to `GLOSSARY.md`, its decisions to ADRs.
3. `retro` (Matt's), offered after an archive.
4. The person's own edit.

Any other edit the agent makes to these files is read by the docs check. Taking out is as much
the work as putting in: a rule that changes no behaviour, a term no code or spec uses any more,
is flagged to go.

## The checks

Like `openspec validate --strict`: a file that fails is an error, not a suggestion.

- **Without a model**, fast, at each session's start and after each edit to the files:
  - a file past its size (`CLAUDE.md` with what it imports, `AGENTS.md` among them);
  - a glossary by its old name, `CONTEXT.md` or `CONTEXT-MAP.md`, which Matt's skills no longer read;
  - a path a file names (in backticks) that does not exist;
  - a `GLOSSARY.md` entry not in the format (`**Term**:` with a definition of one or two sentences,
    `_Avoid_:` optional), or one that names a path or code;
  - an ADR whose name is not `NNNN-slug.md`, numbers that skip or repeat, one with no title;
  - the same line (of some length) in two files.
- **By an agent**, at the end of a turn that edited the files: is it true of the code, is it in its
  file, does it change what an agent does, does it repeat what is written; a line added to
  `CLAUDE.md` that is neither a pointer nor a rule every turn needs blocks. Blocker or minor, as the
  spec critic; shown, and sent to Claude on the person's word. In a project not set up it watches
  `CLAUDE.md` alone, on a turn that grows it. It is given the lines changed, not the files whole,
  and during `/setup-project` it reads once, at the run's end.
- **Drift**, beside each session's start: a part of the map with 15 commits or more since the map
  was last edited; a glossary term `git grep` finds nowhere else in its repository.

The row above the prompt says `docs: N` while a check fails; pressed, it opens what failed.

## How work goes

OpenSpec holds the changes: proposal, design, specs, tasks. It is the one place for them, so Matt's
`to-spec` and `to-tickets` are not part of this way of working. Matt's skills are the discipline at
each step:

1. An idea is grilled (`grilling`) before it is proposed.
2. `openspec propose`: written in the glossary's terms; `domain-modeling` while designing, new terms
   to the glossary as they settle.
3. Tasks: `tdd` at the seams the design names; `diagnosing-bugs` for a bug.
4. Review: agent-lens on each turn, `code-review` on the whole.
5. Archive: terms and decisions moved to `GLOSSARY.md` and the ADRs, checked; then `retro`.

`docs/agents/workflow.md` says this for the project, and the person decides where it says so.

## The steps of /setup-project

Sent one at a time, each once the turn before has ended; the pane shows each and where it stands,
and any can be skipped. A step is done once the checks of its files pass; where they fail, the pane
shows what failed and sends it back to Claude.

1. `/mattpocock-skills:setup-matt-pocock-skills`: the tracker, the labels, the domain layout. Done
   already where `docs/agents/` holds its files.
2. `openspec init --tools claude`, run by the mod itself. Done already where `openspec/` is there.
3. What is already written: the project's own docs cut into pieces, each put to the person with its
   home among the files above, moved word for word on a yes. Done already where the project has none:
   no `AGENTS.md`, no `CONTEXT.md`, no other agent's rules, and no `CLAUDE.md` but one the steps wrote.
4. The map: `GLOSSARY.md`, `ARCHITECTURE.md`, ADRs for the decisions the code shows, from the code.
5. `CODING_STANDARDS.md`: read from the code, each rule put to the person before it is written.
6. `docs/agents/workflow.md` and `CLAUDE.md`'s pointers and general rules: how to run, check, commit.
7. `openspec/config.yaml`: `context` pointing to the files, `rules` for the artifacts.

Run again, it adds to what is there, never writes over it.

## A project with docs of its own

Most projects come with a `CLAUDE.md` already, often long, holding rules, architecture and terms
together. Step 3 sorts it before anything is added, so each fact ends in one file instead of two:
a piece moves rather than being copied, and the steps after it write only what is still missing.
Nothing moves without the person's yes. Matt's skills read the glossary as `GLOSSARY.md`; one kept
under the name they used before, `CONTEXT.md`, is renamed, as the check flags it until it is.

## Stages

1. Done: `/setup-project`, the check of what is installed, the steps in a pane, the checks without a model.
2. Done: the docs agent on edits; `CODING_STANDARDS.md` among the review's rules; drift.
3. Done: with `/spec`, `tdd` named in the tasks it sends, the archive's move of terms and decisions,
   `retro` offered once the change is archived.
