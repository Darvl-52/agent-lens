import type { Lang } from '../../types'
import type { DocIssue, StepId } from '../../types/setup'

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
  `Шаг ${n} из /setup-project, который готовит проект к работе с агентом: ${what}. Дополняй то, что есть; ничего не перезаписывай и спроси меня, прежде чем убрать что-то, что написал я.`

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
  steps: { matt: 'Matt’s skills: the tracker, the labels, the domain layout', openspec: 'OpenSpec in the project', map: 'The map: glossary, architecture, ADRs', standards: 'The coding standards', workflow: 'How work goes, and CLAUDE.md', config: 'OpenSpec reads the files' } as Record<StepId, string>,
  status: { waiting: 'waiting', sent: 'with Claude', done: 'done', skipped: 'skipped', failed: 'check failed' },
  fixSent: 'what failed went back to Claude',
  next: 'send the next step',
  skip: 'skip',
  again: 'send again',
  fix: 'send what failed',
  allDone: 'Every step is done. The files are checked at each session’s start and on each edit.',
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
      'glossary-long': 'a definition longer than two sentences',
      'glossary-path': 'a path in the glossary: it holds terms, not code',
      'glossary-code': 'code in the glossary',
      'adr-name': 'an ADR not named NNNN-slug.md',
      'adr-numbers': `the ADR numbers skip or repeat (at ${i.detail})`,
      'adr-title': 'an ADR with no # title',
      duplicate: `the same line as in ${i.detail}: keep it in one file`,
    }
    return `${at}: ${what[i.kind]}`
  },
  // What each step tells Claude.
  prompts: {
    map: (): string =>
      `${leadEn(3, 'the map')}

Read the code: its entry points, its modules and what each owns, its data, how they call each other. Then write:
- \`GLOSSARY.md\` at the root: the project's own domain terms and nothing else. The form: \`# {Context}\` and a sentence or two on what it is; \`## Language\`; for each term \`**Term**:\` on a line, a definition of one or two sentences on the next (what it is, not what it does), and \`_Avoid_: other words\` where the code or people use other words for it. No paths, no code, no decisions, no general programming terms.
- \`ARCHITECTURE.md\` at the root, 150 lines at most: the modules and what each owns, their bounds, who calls whom, where the data lives, where to start reading. Name each module by its path in backticks. Leave out what the code says better.
- \`docs/adr/0001-slug.md\` on, numbered in order: one for each decision the code shows that is hard to reverse, would surprise a reader, and came from a real trade-off. A \`# title\` and one to three sentences: the context, the decision, why. None where none qualifies.
Where the project has parts with domains of their own (repositories or packages), write a GLOSSARY.md in each part's folder and a GLOSSARY-MAP.md at the root that links them. Where a term or a decision is not clear from the code, ask me instead of guessing. End with what you wrote, file by file.`,
    standards: (): string =>
      `${leadEn(4, 'the coding standards')}

Read the code and find the rules it keeps: how errors are raised and returned, how files and modules are named and laid out, how the layers call each other, how input is validated, how tests are written and where they go. Take only rules a reviewer can check one edit against, each with a path where it shows. Leave out what the project's linter, formatter or type checker already enforces, and general advice.

Put the rules to me with AskUserQuestion, a few at a time with multiSelect, and write only those I pick to \`CODING_STANDARDS.md\` at the root: 300 lines at most, grouped by area, a rule in a line or two. The review reads this file, not every turn, so it can say more than CLAUDE.md.`,
    workflow: (): string =>
      `${leadEn(5, 'how work goes, and CLAUDE.md')}

Write \`docs/agents/workflow.md\`, 120 lines at most, the way work goes in this project, saying at each step where I decide:
1. An idea is grilled with the \`grilling\` skill before it is proposed.
2. \`openspec propose\` writes it as a change, in the glossary's terms; while designing, the \`domain-modeling\` skill: a new term to GLOSSARY.md as it settles, a decision that qualifies to docs/adr/.
3. The tasks are done with the \`tdd\` skill at the seams the design names; a bug with \`diagnosing-bugs\`.
4. Each turn is reviewed by agent-lens; the whole change with \`code-review\`.
5. On archive, the change's terms go to GLOSSARY.md and its decisions to docs/adr/; then \`/mattpocock-skills:retro\`.

Then \`CLAUDE.md\` (create it where there is none), 120 lines at most:
- a short section of pointers to GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md and docs/agents/workflow.md, a line each on when to read it;
- the rules every turn needs, read from the project's scripts and config: how to install, run, check (types, lint, tests) and commit.
Anything else in it that one of those files holds moves there.`,
    config: (): string =>
      `${leadEn(6, 'OpenSpec reads the files')}

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
  steps: { matt: 'Скиллы Мэтта: трекер, метки, раскладка домена', openspec: 'OpenSpec в проекте', map: 'Карта: глоссарий, архитектура, ADR', standards: 'Стандарты кода', workflow: 'Как идёт работа, и CLAUDE.md', config: 'OpenSpec читает эти файлы' },
  status: { waiting: 'ждёт', sent: 'у Claude', done: 'готово', skipped: 'пропущен', failed: 'проверка не прошла' },
  fixSent: 'что не прошло, ушло Claude',
  next: 'отправить следующий шаг',
  skip: 'пропустить',
  again: 'отправить снова',
  fix: 'отправить, что не прошло',
  allDone: 'Все шаги готовы. Файлы проверяются при каждом запуске сессии и на каждой правке.',
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
      'glossary-long': 'определение длиннее двух предложений',
      'glossary-path': 'путь в глоссарии: в нём термины, а не код',
      'glossary-code': 'код в глоссарии',
      'adr-name': 'ADR назван не как NNNN-slug.md',
      'adr-numbers': `номера ADR пропущены или повторяются (на ${i.detail})`,
      'adr-title': 'ADR без заголовка #',
      duplicate: `та же строка, что в ${i.detail}: держи её в одном файле`,
    }
    return `${at}: ${what[i.kind]}`
  },
  prompts: {
    map: () =>
      `${leadRu(3, 'карта')}

Прочитай код: точки входа, модули и чем владеет каждый, данные, кто кого вызывает. Потом напиши:
- \`GLOSSARY.md\` в корне: только термины предметной области проекта. Вид: \`# {Контекст}\` и одно-два предложения, что это; \`## Language\`; для каждого термина \`**Термин**:\` на строке, определение в одно-два предложения на следующей (что это, а не что делает) и \`_Avoid_: другие слова\`, где код или люди называют это иначе. Без путей, кода, решений и общих понятий программирования.
- \`ARCHITECTURE.md\` в корне, не больше 150 строк: модули и чем владеет каждый, их границы, кто кого вызывает, где живут данные, с чего начинать читать. Каждый модуль назови его путём в обратных кавычках. Не пиши то, что лучше скажет код.
- \`docs/adr/0001-slug.md\` и дальше по порядку: по одному на каждое решение, которое видно в коде, трудно отменить, удивит читателя и принято из реального выбора. \`# заголовок\` и одно-три предложения: контекст, решение, почему. Ни одного, если таких нет.
Если у проекта есть части со своим доменом (репозитории или пакеты), напиши GLOSSARY.md в папке каждой части и GLOSSARY-MAP.md в корне со ссылками на них. Где термин или решение по коду не ясны, спроси меня, а не угадывай. В конце скажи, что написал, по файлам.`,
    standards: () =>
      `${leadRu(4, 'стандарты кода')}

Прочитай код и найди правила, которые он соблюдает: как бросаются и возвращаются ошибки, как называются и раскладываются файлы и модули, как слои вызывают друг друга, как проверяется ввод, как пишутся тесты и где лежат. Бери только правила, по которым ревьюер может проверить одну правку, каждое с путём, где это видно. Не бери то, что уже проверяют линтер, форматтер или типы проекта, и общие советы.

Предложи правила мне через AskUserQuestion, по нескольку с multiSelect, и запиши только выбранные в \`CODING_STANDARDS.md\` в корне: не больше 300 строк, по разделам, правило в одну-две строки. Этот файл читается на ревью, а не на каждом ходе, поэтому в нём можно сказать больше, чем в CLAUDE.md.`,
    workflow: () =>
      `${leadRu(5, 'как идёт работа, и CLAUDE.md')}

Напиши \`docs/agents/workflow.md\`, не больше 120 строк, как идёт работа в этом проекте, и на каждом шаге скажи, где решаю я:
1. Идею прожимают скиллом \`grilling\` до того, как её предложить.
2. \`openspec propose\` пишет её как изменение, терминами глоссария; при проектировании — скилл \`domain-modeling\`: новый термин в GLOSSARY.md, как только он устоялся, подходящее решение в docs/adr/.
3. Задачи делаются скиллом \`tdd\` на швах, которые называет design; баг — \`diagnosing-bugs\`.
4. Каждый ход проверяет agent-lens; всё изменение — \`code-review\`.
5. При архиве термины изменения уходят в GLOSSARY.md, решения в docs/adr/; потом \`/mattpocock-skills:retro\`.

Потом \`CLAUDE.md\` (создай, если нет), не больше 120 строк:
- короткий раздел указателей на GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md и docs/agents/workflow.md, по строке на каждый, когда его читать;
- правила, нужные каждому ходу, из скриптов и конфигов проекта: как поставить, запустить, проверить (типы, линт, тесты) и закоммитить.
Всё остальное в нём, чему место в одном из этих файлов, переезжает туда.`,
    config: () =>
      `${leadRu(6, 'OpenSpec читает эти файлы')}

В \`openspec/config.yaml\` добавь в \`context\`, сохранив, что там есть, указатель на каждый из GLOSSARY.md, ARCHITECTURE.md, docs/adr/, CODING_STANDARDS.md и docs/agents/workflow.md, по строке, что в нём, без копии его текста. Добавь в \`rules\`: proposal и спеки пишутся терминами глоссария, без слов из его _Avoid_; design называет ADR, которые задевает, а новое трудно отменимое решение идёт в docs/adr/; каждая задача называет тестовый шов, на котором её строят. Потом запусти \`openspec validate --all --strict\` и скажи, что он нашёл.`,
    fix: (step, issues) =>
      `Проверка файлов шага «${step}» из /setup-project нашла это. Исправь каждое в его файле и больше ничего не меняй:\n${issues.map(i => `- ${RU.issue(i)}`).join('\n')}`,
  },
  openspecFailed: why => `openspec init не запустился: ${why}. Запусти \`openspec init --tools claude\` сам и отправь шаг снова.`,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
