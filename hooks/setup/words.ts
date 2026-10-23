import type { Lang } from '../../types'
import type { DocIssue, Finding, StepId } from '../../types/setup'

// The files and what each holds, as the docs agent is told them.
const ROLES = `- CLAUDE.md: pointers to the files below, and the few rules every turn needs. 120 lines at most.
- GLOSSARY.md: the project's own domain terms, a definition of a sentence or two each and the words to avoid. No paths, code or decisions.
- ARCHITECTURE.md: the map: modules, their bounds, who calls whom, where the data lives. 150 lines at most.
- docs/adr/NNNN-slug.md: one decision each that is hard to reverse, surprising, and the result of a trade-off, and why.
- CODING_STANDARDS.md: rules for code a reviewer can check an edit against. 300 lines at most.
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
  description: 'Prepare the project for work with the agent: Matt’s skills, OpenSpec, the glossary and the map, the coding standards, how work goes; check: the check of those files',
  title: 'Setup',
  // What is installed.
  ready: (openspec: string, isInitialised: boolean) =>
    `✓ Matt’s skills installed · ✓ OpenSpec ${openspec}${isInitialised ? ', openspec/ is here: its step is done' : ', the project has no openspec/ yet: a step initialises it'}`,
  noMatt: (missing: string[]) =>
    `Matt’s skills are not installed (${missing.join(', ')} missing), so /setup-project does not run. Install them with /plugin install mattpocock-skills, then run it again.`,
  noOpenspec: 'The OpenSpec CLI is not installed, so /setup-project does not run. Install it with npm install -g @fission-ai/openspec, then run it again.',
  opened: 'Opened the setup: the steps go to Claude one at a time.',
  // The pane.
  steps: { matt: 'Matt’s skills: the tracker, the labels, the domain layout', openspec: 'OpenSpec in the project', existing: 'What is already written', map: 'The map: glossary, architecture, ADRs', standards: 'The coding standards', workflow: 'How work goes, and CLAUDE.md', config: 'OpenSpec reads the files' } as Record<StepId, string>,
  status: { waiting: 'waiting', sent: 'with Claude', done: 'done', skipped: 'skipped', failed: 'check failed' },
  fixSent: 'what failed went back to Claude',
  next: 'send the next step',
  skip: 'skip',
  again: 'send again',
  fix: 'send what failed',
  allDone: 'Every step is done. The files are checked at each session’s start and at the end of each turn that edits them.',
  commit: 'commit the setup',
  commitHint: 'Commit what the steps wrote: the map is checked for staleness against its last commit.',
  commitPrompt:
    'Commit the files /setup-project wrote (CLAUDE.md, GLOSSARY.md, ARCHITECTURE.md, CODING_STANDARDS.md, docs/, openspec/, and what openspec init put in .claude/). First show me git status; commit only those, with a message in the style of the project’s commits.',
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
      'stale-term': `the term "${i.detail}" is found nowhere outside the glossaries: still in use?`,
    }
    return `${at}: ${what[i.kind]}`
  },
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
  minor: 'minor',
  // After an archive.
  retroOffer: (change: string): string => `"${change}" is archived: a retro of the work?`,
  retroArgs: (change: string): string => `the work in this session on the OpenSpec change "${change}", up to its archive`,
  // What Matt's skills, written in English, are told beside their task: none where the mod speaks it.
  speak: '',
  // What each step tells Claude.
  prompts: {
    existing: (): string =>
      `${leadEn(3, 'what is already written')}

Find every document this project's agents and people work by: CLAUDE.md and the files it imports with \`@\`, AGENTS.md, a glossary by its old name (CONTEXT.md, CONTEXT-MAP.md), notes on the architecture and on decisions wherever they lie, the rules of other agents (.cursor/rules, .cursorrules, .github/copilot-instructions.md), the project's skills (.claude/skills, .agents/skills), and the parts of README.md written for those who change the code.

Cut each into pieces (a section, a rule, a fact) and give each piece one home:
${ROLES}
- a rule a tool can check: the linter, at the step of the coding standards; until then it stays where it is.
- where it is: a project skill, the README for people, Matt's docs/agents/.
- out: untrue of the code now, a second copy, or what an agent does anyway.

Put the plan to me with AskUserQuestion, file by file, a few pieces a question with multiSelect, each with its home, and move only what I pick. A piece moves word for word and leaves its old place, so each fact stays in one file. A glossary by its old name moves with \`git mv\` (CONTEXT.md to GLOSSARY.md, CONTEXT-MAP.md to GLOSSARY-MAP.md, with the glossaries it links), and docs/agents/domain.md then names the new name. ADRs kept elsewhere move to docs/adr/, numbered on in order. The steps after this one add what is still missing, so this one writes nothing new.

Done when every piece of every file found has my answer. End with a table: the piece, where it was, where it went.`,
    map: (): string =>
      `${leadEn(4, 'the map')}

Read the code: its entry points, its modules and what each owns, its data, how they call each other. Then write, adding to each file where it is there:
- \`GLOSSARY.md\` at the root: the project's own domain terms and nothing else. The form: \`# {Context}\` and a sentence or two on what it is; \`## Language\`; for each term \`**Term**:\` on a line, a definition of one or two sentences on the next (what it is, not what it does), and \`_Avoid_: other words\` where the code or people use other words for it. No paths, no code, no decisions, no general programming terms.
- \`ARCHITECTURE.md\` at the root, 150 lines at most: the modules and what each owns, their bounds, who calls whom, where the data lives, where to start reading. Name each module by its path in backticks. Leave out what the code says better.
- \`docs/adr/NNNN-slug.md\`, numbered on from the last number in docs/adr/ (0001 where there is none): one for each decision the code shows that is hard to reverse, would surprise a reader, came from a real trade-off, and no ADR records yet. A \`# title\` and one to three sentences: the context, the decision, why. None where none qualifies.
Where the project has parts with domains of their own (repositories or packages), write a GLOSSARY.md in each part's folder and a GLOSSARY-MAP.md at the root that links them. Where a term or a decision is not clear from the code, ask me instead of guessing. End with what you wrote, file by file.`,
    standards: (): string =>
      `${leadEn(5, 'the coding standards')}

Read the code and find the rules it keeps: how errors are raised and returned, how files and modules are named and laid out, how the layers call each other, how input is validated, how tests are written and where they go. Take only rules a reviewer can check one edit against; leave out general advice. The rules CODING_STANDARDS.md and the linter's config already hold count as found: put to me only the rules they lack, and offer to move to the linter those in CODING_STANDARDS.md it could check.

Sort each rule:
- mechanical (a banned API or pattern, the shape of an import, where a file lives, a fixed syntactic form): a tool checks it, not prose. Where the project has a linter (eslint, stylelint, ruff, …), it goes to the linter's config as an existing rule, or a small custom one with a test of its own, and the lint script runs it. A rule the linter already enforces is left out.
- a judgement (consistency across files, the right layer, a name that says what it is): it goes to \`CODING_STANDARDS.md\`.
Each rule in a line or two: what, why (the mistake it prevents, in a clause), where it shows (a path), and how it is checked (\`eslint: <rule>\`, \`stylelint: <rule>\`, or \`review\`).

Put the rules to me with AskUserQuestion, a few at a time with multiSelect, saying for each whether it goes to the linter or to the file, and write only those I pick: to the linter's config, and to \`CODING_STANDARDS.md\` at the root, 300 lines at most, grouped by area. Then run the lint script and say what the new rules found.`,
    workflow: (): string =>
      `${leadEn(6, 'how work goes, and CLAUDE.md')}

Write \`docs/agents/workflow.md\` (adding to it where it is there), 120 lines at most, the way work goes in this project, saying at each step where I decide:
1. An idea is grilled with the \`grilling\` skill before it is proposed.
2. \`openspec propose\` writes it as a change, in the glossary's terms; while designing, the \`domain-modeling\` skill: a new term to GLOSSARY.md as it settles, a decision that qualifies to docs/adr/.
3. The tasks are done with the \`tdd\` skill at the seams the design names; a bug with \`diagnosing-bugs\`.
4. agent-lens checks each edit against CLAUDE.md and CODING_STANDARDS.md and reviews each turn's diff; the whole change with \`code-review\`.
5. On archive, the change's terms go to GLOSSARY.md and its decisions to docs/adr/; then \`/mattpocock-skills:retro\`.
Then, in the same file:
- When a task is done here: read from what the project has (tests, type check, lint, stories, e2e, accessibility checks), a line each.
- How the work is shared: the main agent orchestrates (takes the task apart, plans, hands the parts to subagents, keeps their order, decides the architecture, puts the results together and answers me) and does by hand only what is cheaper than explaining it; reading code, implementing, running checks, the browser and reviews go to subagents, started in parallel in one message where the parts are independent, each with its own files (a shared contract first where they depend on each other; \`isolation: "worktree"\` where their files may meet), each prompt self-contained (the goal, the files and what not to touch, these rules, when it is done, what to answer), the answers short; what they report is checked (tests, lint, build) before it is told to me.

Then \`CLAUDE.md\` (create it where there is none), 120 lines at most:
- the language I am spoken to in, as its first rule, where it is not English;
- a short section of pointers to ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md and docs/agents/workflow.md, a line each on when to read it; GLOSSARY.md imported with a line \`@GLOSSARY.md\` where it is under 80 lines, so its terms hold on every turn, else pointed to;
- the rules every turn needs, read from the project's scripts and config: how to install and run; the checks in two tiers, while working only what the change touches (the tests related to the changed files, lint of those files, the type check), and before a commit, push or merge everything (lint, types, all tests, e2e, build), sending only on green;
- how to commit.
Anything else in it that one of those files holds moves there.`,
    config: (): string =>
      `${leadEn(7, 'OpenSpec reads the files')}

In \`openspec/config.yaml\`, add to \`context\`, keeping what is there, a pointer to each of GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md and docs/agents/workflow.md, a line each on what it holds, never a copy of its text. Add to \`rules\`: the proposal and the specs use the glossary's terms and none of the words it lists under _Avoid_; the design names the ADRs it touches, and a new decision hard to reverse goes to docs/adr/; each task names the test seam it is built at. Then run \`openspec validate --all --strict\` and say what it found.`,
    fix: (step: string, issues: DocIssue[]): string =>
      `The check of the files of /setup-project's step "${step}" found these. Fix each in its file and change nothing else:\n${issues.map(i => `- ${EN.issue(i)}`).join('\n')}`,
  },
  openspecFailed: (why: string) => `openspec init did not run: ${why}. Run \`openspec init --tools claude\` yourself, then send the step again.`,
}

const RU: typeof EN = {
  description: 'Подготовить проект к работе с агентом: скиллы Мэтта, OpenSpec, глоссарий и карта, стандарты кода, как идёт работа; check: проверка этих файлов',
  title: 'Подготовка',
  ready: (openspec, isInitialised) =>
    `✓ Скиллы Мэтта установлены · ✓ OpenSpec ${openspec}${isInitialised ? ', openspec/ в проекте уже есть: этот шаг готов' : ', в проекте ещё нет openspec/: его создаст один из шагов'}`,
  noMatt: missing =>
    `Скиллы Мэтта не установлены (нет: ${missing.join(', ')}), поэтому /setup-project не запускается. Поставь их через /plugin install mattpocock-skills и запусти снова.`,
  noOpenspec: 'OpenSpec CLI не установлен, поэтому /setup-project не запускается. Поставь его: npm install -g @fission-ai/openspec, и запусти снова.',
  opened: 'Открыл подготовку: шаги уходят Claude по одному.',
  steps: { matt: 'Скиллы Мэтта: трекер, метки, раскладка домена', openspec: 'OpenSpec в проекте', existing: 'Что уже написано', map: 'Карта: глоссарий, архитектура, ADR', standards: 'Стандарты кода', workflow: 'Как идёт работа, и CLAUDE.md', config: 'OpenSpec читает эти файлы' },
  status: { waiting: 'ждёт', sent: 'у Claude', done: 'готово', skipped: 'пропущен', failed: 'проверка не прошла' },
  fixSent: 'что не прошло, ушло Claude',
  next: 'отправить следующий шаг',
  skip: 'пропустить',
  again: 'отправить снова',
  fix: 'отправить, что не прошло',
  allDone: 'Все шаги готовы. Файлы проверяются при каждом запуске сессии и в конце каждого хода, который их правит.',
  commit: 'закоммитить подготовку',
  commitHint: 'Закоммить то, что написали шаги: карта сверяется на устаревание с её последним коммитом.',
  commitPrompt:
    'Закоммить файлы, которые написал /setup-project (CLAUDE.md, GLOSSARY.md, ARCHITECTURE.md, CODING_STANDARDS.md, docs/, openspec/ и то, что openspec init положил в .claude/). Сначала покажи мне git status; закоммить только их, сообщением в стиле коммитов проекта.',
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
      'stale-term': `термин «${i.detail}» не встречается нигде, кроме глоссариев: он ещё в ходу?`,
    }
    return `${at}: ${what[i.kind]}`
  },
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
  minor: 'мелочь',
  retroOffer: change => `«${change}» в архиве: ретро по работе?`,
  retroArgs: change => `работа в этой сессии над изменением OpenSpec «${change}», до его архива. Говори со мной по-русски: вопросы, варианты и итоги`,
  speak: 'Говори со мной по-русски: вопросы, варианты ответов, черновики на подтверждение и итоги.',
  prompts: {
    existing: () =>
      `${leadRu(3, 'что уже написано')}

Найди все документы, по которым работают агенты и люди этого проекта: CLAUDE.md и файлы, которые он подключает через \`@\`, AGENTS.md, глоссарий под старым именем (CONTEXT.md, CONTEXT-MAP.md), записи об архитектуре и о решениях, где бы они ни лежали, правила других агентов (.cursor/rules, .cursorrules, .github/copilot-instructions.md), скиллы проекта (.claude/skills, .agents/skills) и части README.md для тех, кто меняет код.

Разрежь каждый на куски (раздел, правило, факт) и дай каждому куску один дом:
${ROLES}
- правило, которое может проверить инструмент: линтер, на шаге стандартов кода; до него остаётся, где есть.
- где есть: скилл проекта, README для людей, docs/agents/ Мэтта.
- вон: неверно для кода сейчас, вторая копия или то, что агент и так делает.

Предложи план мне через AskUserQuestion, по файлу, по нескольку кусков в вопросе с multiSelect, у каждого — его дом, и переноси только выбранное. Кусок переезжает слово в слово и уходит со старого места, чтобы каждый факт жил в одном файле. Глоссарий под старым именем переезжает через \`git mv\` (CONTEXT.md в GLOSSARY.md, CONTEXT-MAP.md в GLOSSARY-MAP.md, вместе с глоссариями, на которые он ссылается), и docs/agents/domain.md потом называет новое имя. ADR, что лежат в другом месте, переезжают в docs/adr/ с номерами по порядку. Чего не хватает, допишут следующие шаги, поэтому этот нового не пишет.

Готово, когда у каждого куска каждого найденного файла есть мой ответ. В конце — таблица: кусок, где был, куда ушёл.`,
    map: () =>
      `${leadRu(4, 'карта')}

Прочитай код: точки входа, модули и чем владеет каждый, данные, кто кого вызывает. Потом напиши, дополняя файл, если он уже есть:
- \`GLOSSARY.md\` в корне: только термины предметной области проекта. Вид: \`# {Контекст}\` и одно-два предложения, что это; \`## Language\`; для каждого термина \`**Термин**:\` на строке, определение в одно-два предложения на следующей (что это, а не что делает) и \`_Avoid_: другие слова\`, где код или люди называют это иначе. Без путей, кода, решений и общих понятий программирования.
- \`ARCHITECTURE.md\` в корне, не больше 150 строк: модули и чем владеет каждый, их границы, кто кого вызывает, где живут данные, с чего начинать читать. Каждый модуль назови его путём в обратных кавычках. Не пиши то, что лучше скажет код.
- \`docs/adr/NNNN-slug.md\` с номерами дальше последнего в docs/adr/ (0001, если там пусто): по одному на каждое решение, которое видно в коде, трудно отменить, удивит читателя, принято из реального выбора и ещё не записано ни в одном ADR. \`# заголовок\` и одно-три предложения: контекст, решение, почему. Ни одного, если таких нет.
Если у проекта есть части со своим доменом (репозитории или пакеты), напиши GLOSSARY.md в папке каждой части и GLOSSARY-MAP.md в корне со ссылками на них. Где термин или решение по коду не ясны, спроси меня, а не угадывай. В конце скажи, что написал, по файлам.`,
    standards: () =>
      `${leadRu(5, 'стандарты кода')}

Прочитай код и найди правила, которые он соблюдает: как бросаются и возвращаются ошибки, как называются и раскладываются файлы и модули, как слои вызывают друг друга, как проверяется ввод, как пишутся тесты и где лежат. Бери только правила, по которым ревьюер может проверить одну правку; общие советы не бери. Правила, что уже есть в CODING_STANDARDS.md и в конфиге линтера, считаются найденными: предложи мне только те, которых там нет, и перенос в линтер тех правил из CODING_STANDARDS.md, которые он может проверить.

Раздели правила:
- механическое (запрещённый API или приём, форма импорта, где лежит файл, фиксированная синтаксическая форма): его проверяет инструмент, а не текст. Если в проекте есть линтер (eslint, stylelint, ruff, …), правило идёт в его конфиг — готовым правилом или небольшим своим, со своим тестом, — и его запускает скрипт линта. Правило, которое линтер уже проверяет, не бери.
- на суждение (согласованность между файлами, верный слой, имя, которое говорит, что это): идёт в \`CODING_STANDARDS.md\`.
Каждое правило в одну-две строки: что, почему (какую ошибку предотвращает, одной фразой), где видно (путь) и чем проверяется (\`eslint: <правило>\`, \`stylelint: <правило>\` или \`ревью\`).

Предложи правила мне через AskUserQuestion, по нескольку с multiSelect, у каждого скажи, идёт оно в линтер или в файл, и запиши только выбранные: в конфиг линтера и в \`CODING_STANDARDS.md\` в корне, не больше 300 строк, по разделам. Потом запусти скрипт линта и скажи, что нашли новые правила.`,
    workflow: () =>
      `${leadRu(6, 'как идёт работа, и CLAUDE.md')}

Напиши \`docs/agents/workflow.md\` (дополни, если он уже есть), не больше 120 строк, как идёт работа в этом проекте, и на каждом шаге скажи, где решаю я:
1. Идею прожимают скиллом \`grilling\` до того, как её предложить.
2. \`openspec propose\` пишет её как изменение, терминами глоссария; при проектировании — скилл \`domain-modeling\`: новый термин в GLOSSARY.md, как только он устоялся, подходящее решение в docs/adr/.
3. Задачи делаются скиллом \`tdd\` на швах, которые называет design; баг — \`diagnosing-bugs\`.
4. agent-lens проверяет каждую правку по CLAUDE.md и CODING_STANDARDS.md и diff каждого хода; всё изменение — \`code-review\`.
5. При архиве термины изменения уходят в GLOSSARY.md, решения в docs/adr/; потом \`/mattpocock-skills:retro\`.
Потом в том же файле:
- Когда задача здесь готова: из того, что в проекте есть (тесты, типы, линт, сторис, e2e, проверки доступности), по строке.
- Как делится работа: основной агент — оркестратор (разбирает задачу, планирует, отдаёт части саб-агентам, следит за их порядком, решает архитектуру, сводит результаты и отвечает мне) и руками делает только то, что дешевле, чем объяснить; чтение кода, реализация, прогон проверок, браузер и ревью уходят саб-агентам, независимые части — параллельно одним сообщением, у каждого свои файлы (где части зависят друг от друга — сначала общий контракт; \`isolation: "worktree"\`, если их файлы могут пересечься), промпт самодостаточный (цель, файлы и чего не трогать, эти правила, когда готово, что ответить), ответы короткие; что они доложили, проверяется (тесты, линт, сборка), прежде чем сказать мне.

Потом \`CLAUDE.md\` (создай, если нет), не больше 120 строк:
- первым правилом — язык, на котором со мной говорят: «Отвечай и задавай вопросы по-русски»;
- короткий раздел указателей на ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md и docs/agents/workflow.md, по строке, когда его читать; GLOSSARY.md подключи строкой \`@GLOSSARY.md\`, если в нём меньше 80 строк, чтобы термины действовали в каждом ходе, иначе дай указатель;
- правила, нужные каждому ходу, из скриптов и конфигов проекта: как поставить и запустить; проверки в две ступени — во время работы только то, что задевает правка (тесты, связанные с изменёнными файлами, линт этих файлов, типы), а перед коммитом, пушем или мержем всё (линт, типы, все тесты, e2e, сборка), и заливать только при зелёном;
- как коммитить.
Всё остальное в нём, чему место в одном из этих файлов, переезжает туда.`,
    config: () =>
      `${leadRu(7, 'OpenSpec читает эти файлы')}

В \`openspec/config.yaml\` добавь в \`context\`, сохранив, что там есть, указатель на каждый из GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md и docs/agents/workflow.md, по строке, что в нём, без копии его текста. Добавь в \`rules\`: proposal и спеки пишутся терминами глоссария, без слов из его _Avoid_; design называет ADR, которые задевает, а новое трудно отменимое решение идёт в docs/adr/; каждая задача называет тестовый шов, на котором её строят. Потом запусти \`openspec validate --all --strict\` и скажи, что он нашёл.`,
    fix: (step, issues) =>
      `Проверка файлов шага «${step}» из /setup-project нашла это. Исправь каждое в его файле и больше ничего не меняй:\n${issues.map(i => `- ${RU.issue(i)}`).join('\n')}`,
  },
  openspecFailed: why => `openspec init не запустился: ${why}. Запусти \`openspec init --tools claude\` сам и отправь шаг снова.`,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
