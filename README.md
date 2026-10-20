# agent-lens

A Claude Code mod for working with the agent, in three parts that know of each other:

- **What the agent changed.** Each edit is checked against the project's `CLAUDE.md` and
  `AGENTS.md` as Claude makes it, and Claude is told what it broke before it moves on. After each
  turn that edits files, the diff across every repository it touched is reviewed against what you
  asked for and the same rules. `/changes` opens the diff, what each piece is for, the findings
  and a walkthrough.
- **The OpenSpec change.** In a project with `openspec/changes`, `/spec` gives the change's gist,
  what changed since you last looked, what is left for you to decide, its tasks and its spec, and
  answers questions about it.
- **The skill for each prompt.** Each prompt you send is read, and Claude is told which of your
  skills to load for it: your rules first, a quick model call where none fits. `/router` shows
  what it picked and why.

It was four mods: review-lens, rules-watchdog, openspec-lens and skill-router.

## The row above the prompt

One row, the change in view first, then what the agent's last turn changed:

```
◆ add-dark-mode · 2 to decide · tasks 7/12  │  ✎ 3 files +120 −30 · 1 likely bug · 2 findings   /spec /changes
```

Each part opens its pane, on the tab that tells more of it. Where the row is too narrow for both,
each has a row of its own. Red is broken, yellow wants a look, green is done.

## How the parts work together

- **A task from `/spec` names OpenSpec's skill.** A task or an archiving the spec's pane sends
  tells Claude to load OpenSpec's own skill for it (`openspec-apply-change` or `opsx:apply`,
  `openspec-archive-change` or `opsx:archive`), where one is installed and not loaded yet, with no
  model asked. The router keeps it among its decisions.
- **The review reads the change in view.** Beside the diff it is told the OpenSpec change in
  progress: its tasks not done yet and what its specs require, each requirement with its
  scenarios. It reports code that goes against a requirement or a scenario, and a task the request
  named that the diff leaves half done.
- **The rules are checked once.** What the check of each edit caught joins the findings while it
  is still in the code, and the review after the turn is told not to report it again.
- **One language.** `lang ru` after any of the three commands switches all of them.

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
agent-lens: your edit to src/button.ts breaks the project's CLAUDE.md rules.
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
patterns, hardcoded values); rules about git, workflow or how to talk are not. Edits to `CLAUDE.md`
and `AGENTS.md` themselves are not checked, nor the Markdown of an OpenSpec change, which `/spec`
reads. A check that fails or answers something unreadable lets
the edit be.

`/changes rules` says how edits are checked and which rule files apply in the project folder.

### The rules it checks against

For each file changed, the `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and `AGENTS.md` of
its folder and of every folder above it, up to the project folder (for `__front/src/app.ts`:
`__front/src/`, `__front/` and the project's own), then those Claude Code read at the start from
the folders above the project, each with its `@` imports. Your own `~/.claude/CLAUDE.md` only where
the settings ask for it. Each is read up to 16k characters, all of them up to 48k.

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

The diff of a turn is taken from the edit tools (Write, Edit, NotebookEdit): a file changed by a
shell command (`sed -i`, a generator) is not in it. The uncommitted mode shows those.

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
   `f` sends it to look; `h` sends what it found to the session as your prompt, and Claude closes
   each hole in the change's files, asking you where only you can decide. In `auto` it also looks
   after each turn that changed the change's text (a task ticked is not a change), and what it finds
   goes to Claude by itself, once the turn running has ended. Each round is told what was decided and
   sent before, so it does not report it again; after three rounds in a row it stops, and what the
   last one changed is yours to look at. The next change to the text starts over. The report the
   engine hands back to the session as the agent ends is kept from Claude: the holes reach it only
   by that prompt, so none is closed twice.
4. **Tasks.** The tasks of `tasks.md` under their headings, ticked or not. `n` sends the next one to
   the session as your prompt, `do` on a task sends that one: Claude reads the change, does the
   task alone, runs its check if it names one, and ticks it. A task sent is marked so until it is
   ticked, and the next one skips it; `send again` sends it once more. Once every task is ticked
   the tab opens with what still stands between the change and its archive, or with `archive`: a
   second press sends it to the session, and Claude archives it the project's way (its archive
   skill or command, else `openspec archive`) and says what changed in the main specs. While the
   change is still there, `send again` sends the archiving once more.
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
change's text, and three rounds at most in a row, each followed by Claude's turn closing what it found.

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

- Every skill the Skill tool can run is a candidate: plugin skills (`mattpocock-skills:tdd`), your `~/.claude/skills` and `~/.claude/commands`, the project's `.claude/skills` and `.claude/commands` (OpenSpec puts its own there). Install or write a skill and it is routed from the next prompt on.
- Your rules are checked first; a word matches at the start of a word in any case, so `test` finds `tests` but not `latest`, and `тест` finds `тесты`. A rule that fires skips the model, its skill loaded already or not.
- Otherwise the model picks, for prompts that say more than a word or two. It sees your previous prompt and the end of Claude's last answer, so "now the tests" reads as part of the work under way, and the OpenSpec changes in progress with their tasks, so it can name the change. It reads at most the first 4,000 characters of a prompt and 400 of each skill's description.
- A skill already loaded in the conversation is not picked again until `/clear`, `/resume` or a compaction. After `/clear` or `/resume` the router also forgets your previous prompt and Claude's last answer, takes the last pick off the status line, and reads its mode and your rules again (off says so there).
- A prompt that names a skill (`/tdd`, `mattpocock-skills:tdd`), a slash command, and prompts from other plugins or scheduled runs are left alone.
- If the model fails or is slow (8 seconds), the prompt goes through as typed, and the status line says `skill: model failed`.

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

Switch with `/router auto`, `/router suggest`, `/router off`, or the buttons in the pane. The status line shows the skill picked for the last prompt, `skill: model failed` where the model gave no pick, and `skill router: off` while the router is off.

## Commands

| Command                    | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `/changes`                 | Open the review of what the agent changed.                           |
| `/changes rules`           | How edits are checked, and the rule files that apply.               |
| `/spec`                    | Open the pane on the OpenSpec change in view.                        |
| `/spec <change>`           | Pick another active change and open the pane on it.                  |
| `/spec critic off\|button\|auto` | Whether an agent looks for holes in the change, as under Decide.  |
| `/router`                  | Open the router's pane; `rules`, `skills`, `history` open that tab.  |
| `/router auto\|suggest\|off` | How the router acts on a pick.                                      |
| `/router add`, `when`, `ignore`, `rm`, `list` | Your routing rules, as under The skill for each prompt. |
| `/changes lang ru`         | Every part in Russian, its model's answers too; `lang en` back. The same after `/spec` or `/router`. |

## Settings

In `/plugin`, select agent-lens, then Configure:

| Setting                     | Default | What it does                                                                                                                                         |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                    | `en`    | Every part's language until `lang` sets one                                                                                                          |
| Rules while Claude edits    | `warn`  | `warn` checks each edit beside the turn and tells Claude; `block` checks it before it lands and refuses it (a few seconds on every edit; an edit refused twice in a turn for one rule goes through on the next try, on Findings for you to judge); `off` leaves the rules to the review |
| Model for the edit check    | `haiku` | An alias or a full model id                                                                                                                          |
| Include ~/.claude/CLAUDE.md | off     | Also check edits and reviews against your personal `CLAUDE.md`                                                                                       |
| Critic for the spec         | `off`   | `button`: an agent looks for holes in the change when you press `f` on Decide; `auto`: also after each turn that changes it, and what it finds goes to Claude to close, three rounds in a row at most; `/spec critic` overrides it |
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

`hooks/register.tsx` registers every hook; each part lives in its own folder under `hooks/`
(`review`, `spec`, `router`), what they share under `hooks/core`.

## License

MIT
