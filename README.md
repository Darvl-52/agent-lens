# agent-lens

A Claude Code mod that checks the agent's work while it happens. It has seven parts, each of which
you can turn on or off:

- **Review of changes** (`/changes`): each turn's diff reviewed against your request and the rules.
- **Rules while Claude edits:** each edit checked against `CLAUDE.md` and the like as it lands.
- **Lenses** (`/changes lenses`): the whole branch read for the mistakes reviewers usually catch.
- **OpenSpec change** (`/spec`): the change's gist, what is left to decide, its tasks and tests.
- **Skill router** (`/router`): Claude told which of your skills fits each prompt.
- **Guard:** a call that keeps repeating is refused, a turn past its limits is stopped.
- **Project setup** (`/setup-project`): any project prepared step by step; its fast checks run at
  the end of each turn, and red goes back to Claude.

## Install

You need Claude Code 2.1.281 or later. At the prompt of a session (then `y` to add the marketplace,
and pick a scope):

```
/plugin install agent-lens --marketplace Darvl-52/agent-lens
```

From a shell: `claude plugin install agent-lens --marketplace Darvl-52/agent-lens`. In the desktop
app, where `/plugin` does not run: + next to the prompt box, Plugins, Add marketplace with
`Darvl-52/agent-lens`, then Add plugin.

Mods are early access. With a third-party provider (Bedrock, Vertex, a gateway) or with telemetry
off, Claude Code may not load the hooks module: nothing shows and `/changes` is an unknown command.
Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` where Claude Code starts, and start a new session.
`claude --debug` says why a module was not loaded: search its log for `hooks module`.

## How the parts work together

### The row above the prompt

One row shows the OpenSpec change in view, then what the last turn changed:

```
◆ add-dark-mode · 2 to decide · tasks 7/12  │  ✎ 3 files +120 −30 · 1 likely bug · 2 findings   /spec /changes
```

Each item opens its pane. Red is broken, yellow wants a look, green is done. Extra rows show above
it when needed: the guard's `⏱` and `■`, `N to decide`, `docs: N issues`, `checks: N red`,
`lenses: N findings`, and offers you take or dismiss with `×`.

### Each part answers its own prompts

Every prompt the mod sends is tagged with its part, and each main turn is matched to the prompt that
started it. So a setup step, the gate and the review never take another part's turn for an answer.

### Autonomy: what goes to Claude by itself

The setting **Autonomy** decides what happens with what the checks find (`a` in `/agent-lens`
switches it, kept for every session):

| Mode | What happens |
| --- | --- |
| `manual` | Findings wait for your key (`fix`, `j` and so on). The gate and the review's notes on a turn still go, as before. The critic waits for `h` unless you set it to `auto` yourself. |
| `auto` (default) | Once the session is idle, the important points go to Claude in one numbered prompt. |
| `full` | The same, and the minor points go too. |

In `auto`, these go: review findings (likely bugs, broken rules) that held the review's second
look; the lenses' findings; the docs agent's blockers; glossary terms the docs agent found nowhere.
`full` also sends review notes and the docs agent's minor findings.

Claude checks each point against the code and ends its answer with a line per point: `#3 fixed` or
`#4 rejected: why` (a table row `| #3 | fixed |` reads too). The mod reads these lines. At most two
such rounds go after each of your prompts, since every fix is a new diff the checks read again. The
ledger's prompt waits while another prompt of the mod waits for its turn, so the turns go one by
one.

### To decide

A point Claude rejects waits for you in the **To decide** pane. Open it with `/agent-lens decide`,
with `d` in `/agent-lens`, or from the `N to decide` row above the prompt. A lens finding marked only
*likely* that Claude rejects is closed by its word and kept in the log. A point Claude ended with no
line for, or whose turn you stopped, waits here too, rather than being lost. The spec's open
questions Claude left yours are counted here; `o` opens them on the Decide tab of `/spec`.

`y` leaves the first point as Claude says. `f` has it fixed anyway: Claude gets a prompt that
insists. The pane also counts the session's points sent, fixed and rejected.

The mod puts some points here itself, because Claude went past a check: an edit let through after
two refusals for one rule (in `block`), a rule line the agent took out of `CLAUDE.md`, `AGENTS.md`
or `CODING_STANDARDS.md`, and a command it took out of the fast checks in `.claude/agent-lens.json`.
`y` leaves it, `f` has Claude fix it or put it back. These stay after `/clear`, since the change is
still in the files.

### Budget

The setting **Token budget of the session** (`0` = none) counts fresh tokens (input, cache writes,
output; cache reads left out) of the mod's own model calls, its subagents, and the main turns its
prompts started. Past it, the mod is by hand: the ledger stops, the spec critic waits for `h`, and
Claude stops deciding the spec's open points. The review of each turn, the gate and the push gate
go on, as they do by hand. The row says
`agent-lens spent its N tokens: by hand till the session ends`. `/clear` or `/resume` starts a new
count. `/agent-lens` shows what each part spent.

### Other links between the parts

A task sent from `/spec` names OpenSpec's own skill where one is installed. The review is told the
OpenSpec change in progress. What the edit check caught joins the findings and is not reported
again. A change with every task ticked gets `/changes lenses` offered. `lang ru` after `/changes`,
`/spec` or `/router` switches every part; `lang en` switches back.

## What the agent changed: `/changes`

It works with one repository, a folder of clones, submodules or no git at all, on any OS.

### The review after each turn

**What.** A model (`sonnet`) reviews the diff against your requests and the project's rules: likely
bugs, broken rules, debugging left in, changes nobody asked for, behaviour changed with no test. A
second, doubting look drops findings the session shows to be no problem.

**When.** By itself after each turn that edits more than a line or two. Tiny changes and edits to an
OpenSpec change's Markdown alone are not reviewed by themselves; `r` on Findings reviews them.

**What you do.** In autonomy `auto`, nothing: findings go to Claude. In `manual`, press `fix` on a
finding or `f` for all; `not a bug` puts one aside. The row says `reviewing…`, `review failed`
(red), `N pieces not looked at`, or `looked at` (green).

### The pane

`/changes` opens four tabs (`1`–`4`). At the bottom you pick the diff: the **last turn**, the
**session**, or everything **uncommitted**.

1. **Changes.** The files and their hunks, each with a line on what it does. On a hunk: `looked
   at`, `ask` (a question about it), `take back` (Claude removes it). `v` marks the file looked at,
   `a` marks all files.
2. **Findings.** What the review found, older open findings below, and what the edit check caught.
   `fix`, `not a bug`, `f` fix all, `r` review a diff not reviewed yet.
3. **Walkthrough.** The change in reading order. `g` makes it again.
4. **Ask.** A question about the diff, or about one hunk. Esc closes the pane.

**What it costs.** The review, hunk notes, walkthrough and answers run on `sonnet` and count against
your plan or API spend. The review runs once per turn with edits; the rest only when you open its
tab. Rules and files are cached, so calls on one diff within five minutes read them from the cache.
A diff keeps 2,000 lines per file and 20,000 in all; a file over 4 MiB is left out.

### Rules while Claude edits

**What.** A small model (`haiku`) checks each Edit, Write and NotebookEdit against the rules for that
file, and each file a shell command wrote (`sed -i`, `cat >`, `tee`) by what changed since its
commit. It judges rules about what files contain (style, naming, comments, structure, banned
patterns), not rules about git or workflow.

**When.** The setting **Rules while Claude edits** decides:

- `warn` (default): the check runs beside the turn. If the edit breaks a rule, a toast says so and
  Claude gets a note with its next tool result:

  ```
  agent-lens: your edit to src/button.ts breaks the project's rules (CLAUDE.md, CODING_STANDARDS.md).
  - Never write comments in code.
    found: // primary button styles
    fix: Remove the comment line above the buttonStyle export.
  Fix this before moving on.
  ```

  If Claude ends its turn first, the mod sends it back once to fix what the checks caught.
- `block`: the check runs before the edit lands and refuses it. An edit refused twice for the same
  rule goes through on the third try and waits for you in To decide.
- `off`: only the review after the turn reads the rules.

**What you do.** Nothing. `/changes rules` shows which rule files apply, which one is longer than
the check reads, and how many checks failed. A check with no answer, or an answer with no list,
counts as failed (a toast says so), not as a clean edit.

Not checked edit by edit: the rule files themselves (the docs agent reads them), an OpenSpec
change's Markdown (`/spec` reads it), and the docs a `/setup-project` step writes in its own turn.

**Which rules.** `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md` and
`CODING_STANDARDS.md` from the file's folder up to the project, then those Claude Code read above
it, with their `@` imports (a file pulled in by `@` is read once). `~/.claude/CLAUDE.md` only if
the settings say so. Each file is read up to 16,000 characters, its `## Security` section always
whole; 48,000 in all.

### The branch through lenses

**What.** A lens is a kind of mistake and where to look for it: code in another layer's place, a fix
in create but not in edit, a test that passes without the change. The mod has 13 that fit any stack.
A project adds its own in `LENSES.md`; your `~/.claude/review-lenses.md` joins if the settings say
so. `/changes lenses` reads the branch from where it forks from the default branch, plus what is
uncommitted (`/changes lenses <base>` for another base), in every repository of the project.

A general-purpose agent on `sonnet` reads the code. It is told the session's requests, the OpenSpec
change in view, the commit messages since the base, and points settled before. It reports one
finding per kind of mistake with its places, evidence and confidence (`confirmed` or `likely`). It
pushes back instead on taste, unreachable edge cases, "could be general", tests for logic-less code,
renames the convention does not ask for, and what you asked for. A finding not shown from the code
gets a second look by `haiku` on the lines it names; one that does not hold is not sent, and the
pane shows only how many there were. Bugs in code the branch does not touch are shown apart and not sent.

**When.** The setting **Lenses**: `off`, only when you run `/changes lenses`; `offer` (default), the
row offers it once an OpenSpec change has every task ticked; `auto`, it runs by itself then, and
before the agent pushes commits the lenses have not read.

**What you do.** In autonomy `auto`, nothing: findings go to Claude through the ledger. Otherwise
`j` sends them. `r` reads again. The pane shows how many of the findings Claude answered held.

**The push gate** (`Lenses: auto`). A push of commits the lenses have not read is refused once, the
review starts, and its findings come to Claude as the next prompt, then the push. A subagent's push
is held too: it is told to finish and say the push waits. The gate finds `git push` (not dry runs),
`gh pr create` and `glab mr create` by their words, also inside `sh -c`, `bash -lc`, `eval`,
`timeout` and git aliases (`!` aliases too), and MCP tools by name (`push_files`,
`create_or_update_file`, `create_pull_request`, `create_merge_request`, `push`). A push of another
branch goes if its commit is among those the lenses read; otherwise it is told to check it out
first. The fixes committed in the findings'
turn go with the held push; after that turn, new commits are read first. If no review can run, the
push goes.

## Setting a project up: `/setup-project`

**What.** Thirteen steps go to Claude one at a time: Matt Pocock's setup, OpenSpec init, sorting
the docs the project already has, the map (glossary, architecture, ADRs), coding standards,
security rules, lenses, the checks, bringing the project up, permissions, the workflow and
`CLAUDE.md`, OpenSpec's config, and a CI job. Matt's skills, the OpenSpec CLI and a CI are
recommended, not required. Steps that need what is missing are left out.

Each step writes what the code shows by itself. It asks you (with AskUserQuestion) only what it is
unsure of, all at once at the end, and ends with a table of what it wrote and where it took it from.
The permissions step always asks you what else to deny (secrets, deploys).

**What you do.** Run `/setup-project` and watch the pane. `n` sends the next step, `s` skips the
current one, `w` sends it again (also after you stopped its turn with Esc), `f` sends back what
failed its check. A step not sent yet has a `skip` button; the long ones say so. When all are done,
`c` has Claude commit what they wrote. From then on the files are checked at each session's start,
on each edit and at each turn's end, and a docs agent reads edits to them against the code.
`/setup-project check` lists what fails. Details: [docs/setup-project.md](docs/setup-project.md).

### The gate

**What.** At the end of a main turn that changed the project, the fast checks of
`.claude/agent-lens.json` run. What is red goes back to Claude with the end of its output, and the
same turn goes on to fix it. After three rounds the turn ends and the row says `checks: N red`. A
turn sent back that changes nothing is let go: Claude has said the red is not its own.

**When.** In any project with fast checks in `.claude/agent-lens.json`, set up or not, except while
`/setup-project` steps run. If the file does not parse, the row says
`checks off: .claude/agent-lens.json does not read (…)`.

**What you do.** Usually nothing. If the checks were red before the agent, run
`/setup-project baseline` on that commit, and that red is not sent back. The same file runs in CI,
for colleagues without the mod (Node 20 or later; each exits 1 on a failure):

```sh
npx -y github:Darvl-52/agent-lens check          # the check of the docs
npx -y github:Darvl-52/agent-lens checks full    # the full tier
```

## The guard

**What.** It holds each turn of every agent, Claude's and each subagent's, to limits:

- **A loop is refused:** the same call and result a fourth time in a row, the same call a third
  time after two failures, or two calls alternating a sixth time.
- **Past half the limit** (30 minutes or 75 tool calls by default) the agent is told to wrap up.
  The row shows `⏱ Claude · 34 min · 80 steps`.
- **Past the limit** (60 minutes or 150 calls) every tool is refused, so the agent reports what it
  did. The row shows `■ Claude stopped`. Your next prompt starts a new count.

Only the agent's own work counts: time waiting on you or on a subagent is left out, and subagents
side by side count once. A retry under another description, timeout or `run_in_background` is the
same call. Polling (`gh run view`, `gh pr checks`, `glab ci status`, `kubectl get/wait`,
`docker ps`, `curl …/health`, with `sleep N` between) is no loop, as long as every piece of the
command waits or asks; `sleep 5 && npm test` is the test run again. A subagent continued by SendMessage keeps its count.

**What you do.** Nothing. `/changes guard` shows the limits and what runs, `/changes guard 90 200`
sets minutes and calls, `/changes guard off` turns it off.

## The OpenSpec change: `/spec`

**What.** The row shows the change in view (picked, else the latest edited): what wants a look, then
progress.

```
◆ add-dark-mode · 2 to decide · spec changed · tasks 7/12 · tests 9 auto, 2 manual   /spec
```

It also shows test cases with no test or no mark, `openspec validate --strict` errors, scenarios no
case covers, overlaps with other changes, and `ready to archive` (green) once all is clear.

**What you do.** Open the pane when the row asks for a look: `/spec`, or `/spec <change>` for
another change. Seven tabs:

1. **Brief.** The gist, scope, key decisions, risks; made by `sonnet` and kept. `g` remakes it.
2. **Changes.** Files edited since you last read it. `e` explains them, `v` marks them read.
3. **Decide.** Open questions, TODOs, choices with no reason, each with two or three answers (the
   recommended one marked `★`). `a` sends your decisions, `d` has Claude decide all, `w` resends.
4. **Tasks.** `n` sends the next task; Claude does it, runs its check and ticks it. Then `archive`.
5. **Tests.** `p` sends the picked cases, `c` every case with no test; Claude writes and runs them.
6. **Spec.** The validator's output and every requirement the change touches. No model.
7. **Ask.** A question, answered from the change alone. If a model call fails, `r` runs it again.

**Deciding by itself.** In autonomy `auto`, once a brief is made, its open points go to Claude by
themselves. Claude settles what the change and the code argue for, writes it in with its reason,
leaves product choices open, and asks you about them at the end. A point it left open is not sent
again. At most two such rounds per change.

**The critic.** An agent (Explore on `sonnet`) reads the change against the code and lists up to
five holes, each a **blocker** or **minor**. The setting **Critic for the spec** (or
`/spec critic`): `off`; `button`, it runs on `h` in Decide and `f` sends its holes to Claude to fix;
`auto` (default; in autonomy `manual` it acts as `button` unless you set it yourself), it also runs after each turn that changed the change's text, and its blockers go to
Claude once that turn ends with an answer. Auto stops at a look with no blocker or after three
rounds; then only `h` starts it again.

**What it costs.** A brief: about 10k tokens for a small change, 40k for a large one, sent only when
you open the pane or ask. The critic: about 100k to 300k tokens, mostly from the cache.

## The skill for each prompt: `/router`

**What.** Claude often skips its skills and goes straight to the code. The router picks one before
the turn starts and tells Claude to load it. **What you do:** nothing, or add rules.

```
> In the cart the total is sometimes wrong, sometimes right. Find out why.
  skill: diagnosing-bugs
● Skill(mattpocock-skills:diagnosing-bugs)
```

**How it picks.** Your rules come first and cost nothing (a word matches at the start of a word, in
any case). Otherwise a small model (`haiku`) reads the prompt, the exchange before it, the OpenSpec
changes in progress and the skills, project skills first. It says in a sentence what the request
asks for before it picks. Only a prompt that asks for work gets a skill, not a question, a nod or
small talk. Each pick is `sure` or `maybe`: in `auto` Claude is told to load a sure one, and a maybe
one is only offered. A skill already loaded is not picked again until `/clear`, `/resume` or a
compaction. Prompts naming a skill or a slash command, and prompts from other plugins, are left
alone. If the model fails or takes over 6 seconds, the prompt goes as typed and the status line says
why; after two failures in a row it rests for five minutes.

**Where the work starts.** For work, the model also says whether it is settled:

| Stage | When | What Claude is told |
| --- | --- | --- |
| grill first | the request reads two or more ways, or hangs on a decision of yours (`Сделай авторизацию`) | load `grilling` and question you before any plan or code; with `domain-modeling` too where the project keeps `CONTEXT.md`, a glossary or `docs/adr` (Matt's grill-with-docs) |
| spec first | settled and big, in a project with OpenSpec | load `openspec-propose` (or `opsx:propose`) and write the change first |
| go | settled, Claude can start | the work's own skills, as above |

While Claude grills you, your answers go to the model, short ones too, and your rules wait: a word a
rule listens for is part of an answer there. Your go-ahead (`ок, давай`) ends the grilling: the
spec is written from what it settled, or, without OpenSpec, the work starts. Say `без вопросов`,
`сразу делай` or `no questions` to skip the grilling for one prompt; `/router ignore grilling` skips
it for good.

**It learns from Claude.** When the turn ends, each pick is marked loaded (✓) or not (✗) in the
pane. A sure pick Claude went on without is kept, with its prompt, across sessions and projects:
the model reads the last of these as misses, and a skill Claude often leaves is picked only for its
own kind of work.

```
/router add tdd test, тест, /red.?green/      run tdd when a prompt says one of these
/router when tdd for any new feature           tell the model when tdd fits
/router ignore docs                            never route to docs
/router rm 1                                   drop your rule 1
/router list                                   every skill it routes among
```

Short names work where one skill ends in them. `/router add <Tab>` completes them. For a team, put
rules in the project's `.claude/skill-router.json` and commit it. They come before your own:

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

**The pane.** `/router` opens four tabs (`1`–`4`): Overview, Rules, Skills, History (`+ rule` turns
a model's pick into a rule; `◆` marks a stage, `?` a maybe pick). `l` switches the language, and `a`, `s`, `o` the mode: `auto` (default)
tells Claude to load the skill, `suggest` says it may fit, `off` routes nothing.

## `/agent-lens`

The pane where you control the mod. `1`–`7` turn a part on or off for every session; a part off
does none of its work, and its command says where to turn it on (with the review off, the edit
check is off too). `a` switches the autonomy, `d` opens To decide, `l` the lenses pane, `g` shows
the guard's limits. Below, "Spent this session" lists tokens per part, and the budget if one is set.

## Commands

| Command | What it does |
| --- | --- |
| `/changes` | Open the review of what the agent changed. |
| `/changes rules` | How edits are checked, which rule files apply and how much of each is read. |
| `/changes lenses [base]` | Read the branch through the lenses. |
| `/changes guard [on\|off\|<minutes> <calls>]` | Show the guard's limits and what runs; set them. |
| `/changes lang ru\|en` | Every part's language (also after `/spec` or `/router`). |
| `/spec [change]` | Open the OpenSpec pane on the change in view, or on another. |
| `/spec critic off\|button\|auto` | Set when the critic runs. |
| `/setup-project` | Prepare the project, step by step. |
| `/setup-project check` | List what fails the check of the setup's files. |
| `/setup-project baseline` | Keep what is red now as red before the agent, on this commit. |
| `/router` | Open the router pane; `rules`, `skills`, `history` open that tab. |
| `/router auto\|suggest\|off` | How the router acts on a pick. |
| `/router add`, `when`, `ignore`, `unignore`, `rm`, `list` | Your routing rules. |
| `/agent-lens` | Parts on or off, autonomy, spend. |
| `/agent-lens decide` | Open To decide. |

**Only you can loosen a check.** These run only when you type them (or send them by Remote Control
or the SDK): `/changes guard <args>`, `/spec critic <mode>`, `/setup-project baseline`, and
`/router rm|add|when|ignore|unignore|off`. From the model or another plugin they answer "Only you can
change this".

## Keys

The same key means the same thing in every pane: `s` skip, `r` again or retry, `n` next, `w` send
again, `f` fix, `j` send to Claude, `v` mark looked at (`/changes`, `/spec`), `x` take a term out of
the glossary, `y` leave it as Claude says (To decide), `h` look for holes (`/spec` Decide), `o` open
the spec's questions (To decide). Digits switch tabs, Esc closes. Some keys belong to one pane only:
`a` is the autonomy in `/agent-lens`, all looked at in `/changes`, and apply in `/spec`.

## Settings

In `/plugin`, select agent-lens, then Configure.

| Setting | Default | What it does |
| --- | --- | --- |
| Language | `en` | Language of every part and its model's answers: `en` or `ru`. `lang` overrides it. |
| Token budget of the session | `0` | Fresh tokens the mod may spend in a session. `0`: no budget. |
| Autonomy | `auto` | `manual`, `auto` or `full`, as under Autonomy. `a` in `/agent-lens` switches it. |
| Rules while Claude edits | `warn` | `warn`, `block` or `off`. |
| Model for the edit check | `haiku` | An alias or a full model id. |
| Include ~/.claude/CLAUDE.md | off | Also check edits and reviews against your personal `CLAUDE.md`. |
| Include ~/.claude/review-lenses.md | off | Also read the branch through your personal lenses. |
| Lenses | `offer` | `off`, `offer` or `auto`, as under The branch through lenses. |
| Critic for the spec | `auto` | `off`, `button` or `auto`. `/spec critic` overrides it. |
| Guard over each agent's turn | `on` | `off`: no limits. `/changes guard` overrides it. |
| Guard: minutes per turn | `60` | Hard limit in minutes of the agent's own work; the soft one is half. |
| Guard: tool calls per turn | `150` | Hard limit in tool calls; the soft one is half. |
| Route with a model | on | Off: only your rules route, no model calls. |
| Model for routing | `haiku` | An alias or a full model id. |

## Limitations

- A rule is checked against the piece an edit changed, not the whole file.
- The baseline hides a new failure inside a command that was already red on that commit.
- A file a shell command modifies that was already uncommitted before the command is not checked
  edit by edit. The turn's review reads it.
- MCP pushes are recognised by tool name only.
- The budget counts fresh tokens, not money.
- Claude Code may turn a step's questions into AskUserQuestion prompts for you. The steps ask only
  what they are unsure of.
- The gate's red and the review's notes go as prompts of their own, not in the ledger's one
  prompt; the ledger waits for them, so the turns go one by one.
- The same defect found by two parts (the review and the lenses) is two points, not one.
- A prompt of the mod's that waited through five turns of others is taken as lost.

## Coming from the four mods

agent-lens was four mods. Uninstall review-lens, rules-watchdog, openspec-lens and skill-router, or everything runs twice:

```
/plugin uninstall review-lens@review-lens
/plugin uninstall rules-watchdog@rules-watchdog
/plugin uninstall openspec-lens@openspec-lens
/plugin uninstall skill-router@skill-router
```

Your routing rules, the router's mode, the language and the spec's briefs are not carried over. A
project's `.claude/skill-router.json` is read as before.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

After an edit to `bin/cli.mjs` or what it imports (`hooks/setup/checks.ts`, `docs.ts`, `words.ts`),
run `bun run build` to bundle the CLI again into `bin/agent-lens.mjs`. That file is committed,
because npx runs it. A release bumps the version in `package.json`, `plugin.json` and
`marketplace.json`.

`hooks/register.tsx` registers every hook. Each part lives in its own folder under `hooks/`
(`review`, `lenses`, `spec`, `router`, `guard`, `setup`, `ledger`, `parts`). What they share is in
`hooks/core`.

## License

MIT
