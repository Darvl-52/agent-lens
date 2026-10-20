import type { Busy, Lang, Progress, Tests, TestCase } from '../../types/spec'

// Russian plural: 1 задача, 2 задачи, 5 задач.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// Every word the mod shows, and what it asks the model, in English and Russian. English is the
// default; `/spec lang ru` switches both, kept for every session.
const EN = {
  description: 'Read the OpenSpec change: gist, changes since you looked, what is left to decide, questions; lang: en or ru',
  title: (change: string) => `Spec: ${change}`,
  opened: (change: string) => `Opened ${change}.`,
  noSpec: 'No OpenSpec changes here: the project has no openspec/changes folder with an active change.',
  unknownChange: (name: string, known: string[]) => `No change ${name}. Active: ${known.join(', ')}.`,
  langUsage: 'Usage: /spec lang en, /spec lang ru',
  langSet: 'Language: English.',
  // The row above the prompt.
  tasks: (p: Progress) => `tasks ${p.done}/${p.total}`,
  tests: (t: Tests) => (t.automated + t.manual === 0 ? `${t.cases} test cases` : `tests ${t.automated} auto, ${t.manual} manual`),
  unmarked: (ids: string[]) => `${ids.length > 3 ? ids.length : ids.join(', ')} unmarked`,
  toDecide: (n: number) => `${n} to decide`,
  toApply: (n: number) => `${n} not in the spec`,
  changed: 'spec changed',
  specErrors: (n: number) => `${n} spec ${n === 1 ? 'error' : 'errors'}`,
  specWarnings: (n: number) => `${n} ${n === 1 ? 'warning' : 'warnings'}`,
  overlapsWith: (changes: string[]) => `overlaps ${changes.length > 2 ? `${changes.length} changes` : changes.join(', ')}`,
  readyToArchive: 'ready to archive',
  untested: (n: number) => `${n} ${n === 1 ? 'scenario' : 'scenarios'} untested`,
  withoutTest: (n: number) => `${n} ${n === 1 ? 'case' : 'cases'} without a test`,
  mismatches: (n: number) => `${n} not matching the main spec`,
  decideUnknown: 'what to decide unknown',
  noDecideSection: 'The brief came without its "Up to you" section, so what is left to decide is not known. Make it again.',
  makingBrief: 'making the brief…',
  more: (n: number) => `+${n} more`,
  // The pane.
  tabs: { brief: 'Brief', changes: 'Changes', decide: 'Decide', tasks: 'Tasks', tests: 'Tests', spec: 'Spec', ask: 'Ask' },
  change: 'Spec',
  keysFocused: 'keys: 1–7 tabs, the letter at a button · Esc closes',
  keysUnfocused: 'ctrl+x tab: keys to the pane',
  busy: {
    brief: 'Making the brief: the model reads the whole change, about a minute…',
    explain: 'The model is reading what changed…',
    answer: 'Looking for the answer in the change…',
    options: 'Finding ways to settle each point…',
  },
  queued: (jobs: readonly Busy[]) => `next: ${jobs.map(j => ({ brief: 'the brief', explain: 'what changed', answer: 'your question', options: 'the options' })[j]).join(', ')}`,
  failed: (why: string) => `The model gave no answer: ${why}.`,
  why: {
    rate_limit: 'the rate limit is reached, try again in a minute',
    overloaded: 'the API is overloaded, try again in a minute',
    authentication_failed: 'Claude Code is not signed in, run /login',
    api: (status: number | null) => (status ? `the API answered with error ${status}` : 'no response came, check the connection'),
    empty: 'it replied with nothing',
    aborted: 'the request was cancelled',
  },
  notSent: (why: string) => `The prompt was not sent: ${why}.`,
  retry: 'try again',
  dismiss: 'dismiss',
  briefAt: (time: string) => `Brief of ${time}`,
  stale: 'The spec changed since this brief.',
  refresh: 'refresh',
  makeBrief: 'make the brief',
  noBrief: 'No brief yet.',
  firstLook: 'First time here: changes are counted from now on.',
  nothingNew: 'Nothing changed since you last read it.',
  changedFiles: (n: number) => `${n} ${n === 1 ? 'file' : 'files'} changed since you last read it`,
  linesDelta: (added: number, removed: number) => `+${added} −${removed}`,
  explain: 'explain',
  markRead: 'mark read',
  nothingToDecide: 'Nothing is left for you to decide.',
  decidedOf: (done: number, total: number) => `${done} of ${total} decided`,
  decideNote: 'From the brief: open questions, TODOs and choices made without a reason. Settle them here, and Claude writes them into the spec.',
  decide: 'decide',
  redecide: 'change',
  collapse: 'hide',
  clear: 'clear',
  ownPlaceholder: 'Or your own decision',
  finding: 'Finding options…',
  noOptions: 'No options offered: write your own.',
  sent: 'sent to Claude',
  apply: (n: number) => `write ${n} into the spec`,
  decideAll: (n: number) => `Claude decides all (${n})`,
  byClaude: 'Claude decides',
  decideAllSent: (n: number) => `${n === 1 ? 'The point went' : `${n} points went`} to Claude to decide.`,
  refreshing: 'Claude is writing the decisions in: the brief is made again once the spec changes.',
  notWritten: 'Claude ended the turn with the spec as it was: the decisions are not in it yet.',
  sendAgain: 'send again',
  reopen: 'change the answers',
  resent: (n: number) => `${n === 1 ? 'The point went' : `${n} points went`} to Claude again.`,
  noTasks: 'This change has no tasks.md, or no tasks in it.',
  allDone: 'All tasks are done.',
  tasksDone: (p: Progress) => `${p.done} of ${p.total} done`,
  doNext: (key: string) => `do the next: ${key}`,
  doTask: 'do',
  taskSent: 'sent',
  taskSentToast: (key: string) => `Task ${key} went to Claude.`,
  // The Tests tab.
  noCases: 'This change has no test-cases.md, or no cases in it.',
  casesNote: 'A case has a test where the file its Automated line names holds the case id.',
  caseState: { tested: 'has a test', untested: 'no test', manual: 'manual', unmarked: 'unmarked' } as Record<TestCase['state'], string>,
  casesSummary: (n: Record<TestCase['state'], number>) =>
    [`${n.tested} with a test`, ...(n.untested > 0 ? [`${n.untested} without`] : []), ...(n.manual > 0 ? [`${n.manual} manual`] : []), ...(n.unmarked > 0 ? [`${n.unmarked} unmarked`] : [])].join(' · '),
  sendPicked: (n: number) => `send picked (${n})`,
  closeAll: (n: number) => `close all without a test (${n})`,
  pickHint: 'Press a case to pick it.',
  casesSentToast: (n: number) => `${n} test ${n === 1 ? 'case' : 'cases'} went to Claude.`,
  // The Spec tab.
  checking: 'Checking with openspec validate…',
  checkClean: 'Nothing to fix.',
  checkMissing: 'The openspec CLI did not run here: install it (npm i -g @fission-ai/openspec) to check the spec.',
  checkHeading: 'openspec validate --strict',
  testCasesHeading: 'Test cases',
  unmarkedCase: (id: string) => `${id} says neither "Automated:" nor "Manual:": add one of them`,
  overlapsHeading: 'Other active changes in the same specs',
  shared: (names: string[]) => `both name ${names.length > 3 ? `${names.length}: ${names.slice(0, 3).join('; ')}…` : names.join('; ')}`,
  noRequirements: 'This change has no delta specs.',
  opLegend: '+ added  ~ changed  − removed  → renamed',
  scenarios: (n: number) => `${n} ${n === 1 ? 'scenario' : 'scenarios'}`,
  uncovered: (names: string[]) => `no test case: ${names.join('; ')}`,
  isNew: 'new',
  newButEdited: (n: number) =>
    `new, yet ${n} ${n === 1 ? 'requirement is' : 'requirements are'} changed here as if it existed: archiving refuses that until the spec is in openspec/specs`,
  newCapabilities: (caps: string[]) => `New: ${caps.join(', ')}. Archiving adds ${caps.length === 1 ? 'it' : 'them'} to openspec/specs.`,
  mismatch: { exists: 'already in the main spec', missing: 'not in the main spec' },
  // Archiving, at the end of the Tasks tab.
  beforeArchive: 'Before archiving:',
  blockErrors: (n: number) => `${n} spec ${n === 1 ? 'error' : 'errors'} to fix`,
  blockRefused: 'openspec archive would refuse a delta (see Spec)',
  blockDecide: (n: number) => `${n} left to decide`,
  blockApply: (n: number) => `${n} ${n === 1 ? 'decision' : 'decisions'} not yet in the spec`,
  blockUnmarked: (ids: string[]) => `test cases not marked: ${ids.join(', ')}`,
  blockChecking: 'the check is still running',
  blockUntested: (n: number) => `${n} ${n === 1 ? 'scenario has' : 'scenarios have'} no test case (see Tests)`,
  blockWithoutTest: (n: number) => `${n} test ${n === 1 ? 'case has' : 'cases have'} no test yet (see Tests)`,
  blockMismatch: (n: number) => `${n} ${n === 1 ? 'requirement does' : 'requirements do'} not match the main spec (see Spec)`,
  blockDecideUnknown: 'the brief does not say what is left to decide: make it again',
  blockBrief: 'the brief is older than the spec: what is left to decide is not known yet',
  archive: 'archive',
  archiveConfirm: 'yes, archive it',
  cancel: 'cancel',
  archiveNote: 'Claude archives it the way the project does and syncs the main specs.',
  archiveSent: 'Sent to Claude to archive.',
  applied: (n: number) => `${n === 1 ? 'The decision went' : `${n} decisions went`} to Claude to write into the spec.`,
  askPlaceholder: 'A question about this change, say: what if the guest already exists?',
  ask: 'ask',
  trySuggestions: 'Or ask:',
  suggestions: ['What could go wrong?', 'What changes for existing users?', 'How is it tested?'],
  // What the model is asked. The brief's last section must be headed `decideHeading`.
  system:
    'You help a developer who does not want to read a whole OpenSpec change. Answer in English, briefly, from the text of the change alone; never make anything up.',
  decideHeading: 'Up to you',
  none: 'Nothing',
  briefPrompt: (change: string) =>
    `Brief the change "${change}" in Markdown with exactly these sections:
## Gist
Two to four sentences: what changes and why.
## Out of scope
A list.
## Key decisions
Up to five from design.md, each with its reason.
## Risks
Up to three, or "none".
## Up to you
What needs a person's decision: open questions, TODOs, places where the author picked an option without a reason or on an assumption. One line each, the file in brackets. If there is none, the single line "Nothing".
No more than 350 words.`,
  explainPrompt: (change: string) =>
    `This is what changed in the OpenSpec change "${change}" since I last read it: lines with - were removed, with + added. Explain in plain words what changed in substance, as a list of up to seven points; skip rewordings.`,
  askPrompt: (question: string) =>
    `Question: ${question}\n\nAnswer briefly from the change alone, and end with where it says so (file and section). If the change does not say, say that.`,
  optionsPrompt: (items: string[]) =>
    `These points of the change are left for a person to decide. For each, offer two or three concrete ways to settle it, each under 12 words; first the one the change itself leans toward, if it leans. Answer with JSON alone: an array holding one array of strings per point, in their order.\n\n${items.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
  archivePrompt: (change: string, dir: string) =>
    `Archive the OpenSpec change "${change}" (${dir}). Where the project has its own skill or command for archiving OpenSpec changes (openspec-archive-change, /opsx:archive), follow it; otherwise run \`openspec archive ${change}\`. First check that every task is ticked and \`openspec validate ${change} --strict\` is clean, and stop and ask me if not. Then tell me what changed in the main specs.`,
  // Sent to the session as the person's own prompt: Claude does one task of the change.
  withSkill: (skill: string) => `Load the \`${skill}\` skill with the Skill tool first and follow it.`,
  taskPrompt: (change: string, dir: string, key: string, text: string) =>
    `Do task ${key} of the OpenSpec change "${change}" (${dir}): "${text}". First read tasks.md (its preamble too), proposal.md, design.md and the change's specs. Do this task alone, run its check if it names one, and tick it in tasks.md. Where the spec stands in the way or leaves something out, ask me before deciding yourself.`,
  uncoveredHead: (n: number) => `Scenarios with no test case (${n}):`,
  noCaseYet: 'no test case',
  coverPrompt: (change: string, file: string, scenarios: readonly { capability: string; requirement: string; scenario: string }[], isAlone: boolean) =>
    `${isAlone ? `Cover these scenarios of the OpenSpec change "${change}" (${file}), which no test case covers yet:` : 'Then cover these scenarios of its specs, which no test case covers yet:'}\n${scenarios.map(s => `- ${s.capability}: Requirement: ${s.requirement} / Scenario: ${s.scenario}`).join('\n')}\n\nFor each, add a test case to test-cases.md in the form the others there have (the next TC id, a Covers line naming its requirement and scenario, its steps, an Automated or Manual line)${isAlone ? ', then, where it is Automated, write the test its steps describe in the file it names, its id in the test\'s name and tags as the other tests there have them, run it and make it pass. Touch nothing the scenarios do not need, and end by saying which are covered and which are not.' : ', then close it as the cases above.'}`,
  closePrompt: (change: string, file: string, cases: readonly { id: string; title: string; mark: TestCase['mark']; files?: string[] }[]) =>
    `Close these test cases of the OpenSpec change "${change}" (${file}):\n${cases.map(c => `- ${c.id}: ${c.title}${c.mark === 'automated' ? ` (Automated: ${c.files?.join(', ') ?? 'the file its line names'})` : c.mark === 'manual' ? ' (Manual)' : ' (no mark yet)'}`).join('\n')}\n\nRead each case whole, its steps and what it covers, and the change's specs. For a case marked Automated, write the test its steps describe in the file its Automated line names, its id in the test's name and tags as the other tests there have them, run it and make it pass; where it fails on a bug the spec rules out, fix the code, and where the spec itself is in doubt, ask me. For a case marked Manual, automate it where that can be done, and mark it Automated; where it cannot, say why. For a case with no mark, decide which it is first and write the mark into test-cases.md. Touch nothing the cases do not need, and end by saying which cases are closed and which are not.`,
  // Sent to the session as the person's own prompt: Claude edits the change's files.
  decideAllPrompt: (change: string, dir: string, points: readonly string[]) =>
    `Decide these open points of the OpenSpec change "${change}" (${dir}) yourself:\n\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nFirst read proposal.md, design.md, tasks.md and the change's specs, and the project's code where a point turns on it. For each point take the answer the change and the code argue for best, write it where it belongs (proposal.md, design.md, the specs, tasks.md) with its reason in a sentence, and take it out of the open questions and assumptions. Where a point cannot be settled without me (a product choice, a cost, something no file says), leave it open and ask me about it at the end. Touch nothing else, and end with a line per point: what you decided, or what you need from me.`,
  applyPrompt: (change: string, dir: string, items: { point: string; answer: string }[]) =>
    `I have settled open points of the OpenSpec change "${change}" (${dir}). Write the decisions into its files — proposal.md, design.md, the specs and tasks.md, wherever each belongs — and drop what is settled from the open questions and assumptions. Change nothing else. Where a decision contradicts the spec, or it is unclear how to write it, ask me before editing.\n\n${items.map((d, i) => `${i + 1}. ${d.point}\n   Decision: ${d.answer}`).join('\n')}`,
}

const RU: typeof EN = {
  description: 'Прочитать изменение OpenSpec: суть, что изменилось, что решить, вопросы; lang: en или ru',
  title: change => `Спецификация: ${change}`,
  opened: change => `Открыто ${change}.`,
  noSpec: 'Здесь нет изменений OpenSpec: в проекте нет папки openspec/changes с активным изменением.',
  unknownChange: (name, known) => `Нет изменения ${name}. Активные: ${known.join(', ')}.`,
  langUsage: 'Как вызвать: /spec lang en, /spec lang ru',
  langSet: 'Язык: русский.',
  tasks: p => `задачи ${p.done}/${p.total}`,
  tests: t =>
    t.automated + t.manual === 0
      ? `${t.cases} ${plural(t.cases, 'тест-кейс', 'тест-кейса', 'тест-кейсов')}`
      : `тесты ${t.automated} авто, ${t.manual} вручную`,
  unmarked: ids => `${ids.length > 3 ? ids.length : ids.join(', ')} без пометки`,
  toDecide: n => `${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')} решить`,
  toApply: n => `${n} ${plural(n, 'решение', 'решения', 'решений')} не в спеке`,
  changed: 'спека изменилась',
  specErrors: n => `${n} ${plural(n, 'ошибка', 'ошибки', 'ошибок')} спеки`,
  specWarnings: n => `${n} ${plural(n, 'предупреждение', 'предупреждения', 'предупреждений')}`,
  overlapsWith: changes => `пересекается с ${changes.length > 2 ? `${changes.length} ${plural(changes.length, 'изменением', 'изменениями', 'изменениями')}` : changes.join(', ')}`,
  readyToArchive: 'готово к архиву',
  untested: n => `${n} ${plural(n, 'сценарий', 'сценария', 'сценариев')} без тест-кейса`,
  withoutTest: n => `${n} ${plural(n, 'кейс', 'кейса', 'кейсов')} без автотеста`,
  mismatches: n => `${n} не ${plural(n, 'сходится', 'сходятся', 'сходятся')} с основной спекой`,
  decideUnknown: 'неясно, что решить',
  noDecideSection: 'В выжимке нет раздела «Решить тебе», поэтому неясно, что осталось решить. Сделай её заново.',
  makingBrief: 'готовлю выжимку…',
  more: n => `ещё ${n}`,
  tabs: { brief: 'Выжимка', changes: 'Изменения', decide: 'Решить', tasks: 'Задачи', tests: 'Тесты', spec: 'Спека', ask: 'Спросить' },
  change: 'Спецификация',
  keysFocused: 'клавиши: 1–7 вкладки, буква у кнопки · Esc закрыть',
  keysUnfocused: 'ctrl+x tab: клавиши в панель',
  busy: {
    brief: 'Готовлю выжимку: модель читает изменение целиком, около минуты…',
    explain: 'Модель разбирает, что изменилось…',
    answer: 'Ищу ответ в изменении…',
    options: 'Подбираю варианты для каждого пункта…',
  },
  queued: jobs => `дальше: ${jobs.map(j => ({ brief: 'выжимка', explain: 'что изменилось', answer: 'твой вопрос', options: 'варианты' })[j]).join(', ')}`,
  failed: why => `Модель не ответила: ${why}.`,
  why: {
    rate_limit: 'исчерпан лимит запросов, попробуй через минуту',
    overloaded: 'API перегружен, попробуй через минуту',
    authentication_failed: 'Claude Code не залогинен, выполни /login',
    api: status => (status ? `API ответил ошибкой ${status}` : 'ответа нет, проверь соединение'),
    empty: 'ответ пустой',
    aborted: 'запрос отменён',
  },
  notSent: why => `Промпт не отправлен: ${why}.`,
  retry: 'повторить',
  dismiss: 'скрыть',
  briefAt: time => `Выжимка от ${time}`,
  stale: 'Спека изменилась после этой выжимки.',
  refresh: 'обновить',
  makeBrief: 'сделать выжимку',
  noBrief: 'Выжимки пока нет.',
  firstLook: 'Ты здесь впервые: изменения считаются с этого момента.',
  nothingNew: 'С прошлого прочтения ничего не изменилось.',
  changedFiles: n => `${n} ${plural(n, 'файл изменился', 'файла изменились', 'файлов изменились')} с прошлого прочтения`,
  linesDelta: (added, removed) => `+${added} −${removed}`,
  explain: 'объяснить',
  markRead: 'прочитано',
  nothingToDecide: 'Решать тебе нечего.',
  decidedOf: (done, total) => `решено ${done} из ${total}`,
  decideNote: 'Из выжимки: открытые вопросы, TODO и выборы без обоснования. Реши их здесь — в спеку их внесёт Claude.',
  decide: 'решить',
  redecide: 'изменить',
  collapse: 'свернуть',
  clear: 'сбросить',
  ownPlaceholder: 'Или своё решение',
  finding: 'Подбираю варианты…',
  noOptions: 'Вариантов нет — напиши своё.',
  sent: 'отправлено Claude',
  apply: n => `внести в спеку (${n})`,
  decideAll: n => `Claude решит все (${n})`,
  byClaude: 'решает Claude',
  decideAllSent: n => `Отправлено Claude на решение: ${n}.`,
  refreshing: 'Claude вносит решения: выжимка обновится сама, когда спека изменится.',
  notWritten: 'Claude закончил ход, а спека не изменилась: решений в ней пока нет.',
  sendAgain: 'отправить снова',
  reopen: 'изменить ответы',
  resent: n => `Снова отправлено Claude: ${n}.`,
  noTasks: 'В изменении нет tasks.md или в нём нет задач.',
  allDone: 'Все задачи сделаны.',
  tasksDone: p => `сделано ${p.done} из ${p.total}`,
  doNext: key => `сделать следующую: ${key}`,
  doTask: 'сделать',
  taskSent: 'отправлено',
  taskSentToast: key => `Задача ${key} отправлена Claude.`,
  noCases: 'В изменении нет test-cases.md или в нём нет кейсов.',
  casesNote: 'Тест есть, если в файле из строки Automated есть id кейса.',
  caseState: { tested: 'есть тест', untested: 'нет теста', manual: 'вручную', unmarked: 'без пометки' },
  casesSummary: n =>
    [`с тестом ${n.tested}`, ...(n.untested > 0 ? [`без теста ${n.untested}`] : []), ...(n.manual > 0 ? [`вручную ${n.manual}`] : []), ...(n.unmarked > 0 ? [`без пометки ${n.unmarked}`] : [])].join(' · '),
  sendPicked: n => `отправить выбранные (${n})`,
  closeAll: n => `закрыть все без теста (${n})`,
  pickHint: 'Нажми на кейс, чтобы выбрать его.',
  casesSentToast: n => `Тест-кейсы отправлены Claude: ${n}.`,
  checking: 'Проверяю через openspec validate…',
  checkClean: 'Замечаний нет.',
  checkMissing: 'CLI openspec здесь не запустился: установи его (npm i -g @fission-ai/openspec), чтобы проверять спеку.',
  checkHeading: 'openspec validate --strict',
  testCasesHeading: 'Тест-кейсы',
  unmarkedCase: id => `${id}: нет ни «Automated:», ни «Manual:» — допиши одно из них`,
  overlapsHeading: 'Другие активные изменения в тех же спеках',
  shared: names =>
    `${names.length > 3 ? `${names.length} ${plural(names.length, 'общее требование', 'общих требования', 'общих требований')}: ${names.slice(0, 3).join('; ')}…` : `общие требования: ${names.join('; ')}`}`,
  noRequirements: 'В изменении нет дельт спек.',
  opLegend: '+ добавлено  ~ изменено  − удалено  → переименовано',
  scenarios: n => `${n} ${plural(n, 'сценарий', 'сценария', 'сценариев')}`,
  uncovered: names => `без тест-кейса: ${names.join('; ')}`,
  isNew: 'новая',
  newButEdited: n =>
    `новая, но ${n} ${plural(n, 'требование меняется', 'требования меняются', 'требований меняются')} так, будто она уже есть: архив откажет, пока спеки нет в openspec/specs`,
  newCapabilities: caps => `Новые: ${caps.join(', ')}. При архиве ${caps.length === 1 ? 'она появится' : 'они появятся'} в openspec/specs.`,
  mismatch: { exists: 'уже есть в основной спеке', missing: 'нет в основной спеке' },
  beforeArchive: 'До архива:',
  blockErrors: n => `${n} ${plural(n, 'ошибка', 'ошибки', 'ошибок')} спеки`,
  blockRefused: 'openspec archive откажет в дельте (см. «Спека»)',
  blockDecide: n => `${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')} решить`,
  blockApply: n => `${n} ${plural(n, 'решение', 'решения', 'решений')} не в спеке`,
  blockUnmarked: ids => `тест-кейсы без пометки: ${ids.join(', ')}`,
  blockChecking: 'проверка ещё идёт',
  blockUntested: n => `${n} ${plural(n, 'сценарий', 'сценария', 'сценариев')} без тест-кейса (см. «Тесты»)`,
  blockWithoutTest: n => `${n} ${plural(n, 'тест-кейс', 'тест-кейса', 'тест-кейсов')} без автотеста (см. «Тесты»)`,
  blockMismatch: n => `${n} ${plural(n, 'требование не сходится', 'требования не сходятся', 'требований не сходятся')} с основной спекой (см. «Спека»)`,
  blockDecideUnknown: 'выжимка не говорит, что осталось решить: сделай её заново',
  blockBrief: 'выжимка старше спеки: что осталось решить, пока неизвестно',
  archive: 'в архив',
  archiveConfirm: 'да, в архив',
  cancel: 'отмена',
  archiveNote: 'Claude заархивирует его так, как принято в проекте, и обновит основные спеки.',
  archiveSent: 'Отправлено Claude на архивацию.',
  applied: n => `${n === 1 ? 'Решение отправлено' : `${n} ${plural(n, 'решение отправлено', 'решения отправлены', 'решений отправлены')}`} Claude — он внесёт их в спеку.`,
  askPlaceholder: 'Вопрос по изменению, например: что будет, если гость уже есть?',
  ask: 'спросить',
  trySuggestions: 'Или спроси:',
  suggestions: ['Что может пойти не так?', 'Что меняется для текущих пользователей?', 'Как это проверяется?'],
  system:
    'Ты помогаешь разработчику, которому лень читать изменение OpenSpec целиком. Отвечай по-русски, кратко, только по тексту изменения, ничего не выдумывай.',
  decideHeading: 'Решить тебе',
  none: 'Ничего',
  briefPrompt: change =>
    `Сделай выжимку изменения «${change}» в Markdown ровно с такими разделами:
## Суть
Два–четыре предложения: что меняется и зачем.
## Что не входит
Списком.
## Ключевые решения
До пяти из design.md, у каждого — почему.
## Риски
До трёх, или «нет».
## Решить тебе
Что требует решения человека: открытые вопросы, TODO, места, где автор выбрал вариант без обоснования или с допущением. По строке на пункт, файл в скобках. Если такого нет — одна строка «Ничего».
Не больше 350 слов.`,
  explainPrompt: change =>
    `Вот что изменилось в изменении OpenSpec «${change}» с тех пор, как я его читал: строки с - убраны, с + добавлены. Объясни простыми словами, что поменялось по сути, списком до семи пунктов; правки формулировок пропусти.`,
  askPrompt: question =>
    `Вопрос: ${question}\n\nОтветь кратко, только по изменению, и в конце укажи, где это сказано (файл и раздел). Если в изменении ответа нет — так и скажи.`,
  optionsPrompt: items =>
    `Эти пункты изменения оставлены на решение человеку. Для каждого предложи два-три конкретных варианта решения, каждый не длиннее 12 слов; первым — тот, к которому склоняется само изменение, если склоняется. Ответь только JSON: массив, в нём по массиву строк на пункт, в том же порядке.\n\n${items.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
  archivePrompt: (change, dir) =>
    `Заархивируй изменение OpenSpec «${change}» (${dir}). Если в проекте есть свой скилл или команда архивации изменений OpenSpec (openspec-archive-change, /opsx:archive), действуй по нему; иначе — \`openspec archive ${change}\`. Сначала проверь, что все задачи отмечены и \`openspec validate ${change} --strict\` чист, а если нет — остановись и спроси меня. Потом скажи, что изменилось в основных спеках.`,
  withSkill: skill => `Сначала загрузи навык \`${skill}\` через Skill и следуй ему.`,
  taskPrompt: (change, dir, key, text) =>
    `Сделай задачу ${key} из изменения OpenSpec «${change}» (${dir}): «${text}». Сначала прочитай tasks.md (и шапку с правилами), proposal.md, design.md и specs изменения. Сделай только эту задачу, выполни её проверку, если она указана, и отметь задачу в tasks.md как выполненную. Если спека мешает сделать задачу или в ней чего-то не хватает, спроси меня, прежде чем решать самому.`,
  uncoveredHead: n => `Сценарии без тест-кейса (${n}):`,
  noCaseYet: 'нет тест-кейса',
  coverPrompt: (change, file, scenarios, isAlone) =>
    `${isAlone ? `Покрой тест-кейсами эти сценарии изменения OpenSpec «${change}» (${file}), у которых тест-кейса ещё нет:` : 'Потом покрой эти сценарии его спек, у которых тест-кейса ещё нет:'}\n${scenarios.map(s => `- ${s.capability}: Requirement: ${s.requirement} / Scenario: ${s.scenario}`).join('\n')}\n\nДля каждого добавь в test-cases.md тест-кейс в том же виде, что у остальных там (следующий id TC, строка Covers с его требованием и сценарием, шаги, строка Automated или Manual)${isAlone ? ', затем, если он Automated, напиши тест по его шагам в файле из этой строки, с id кейса в названии и тегах, как у остальных тестов там, прогони его и добейся зелёного. Не трогай ничего, что сценариям не нужно, и в конце скажи, какие покрыты, а какие нет.' : ', а затем закрой его, как кейсы выше.'}`,
  closePrompt: (change, file, cases) =>
    `Закрой эти тест-кейсы изменения OpenSpec «${change}» (${file}):\n${cases.map(c => `- ${c.id}: ${c.title}${c.mark === 'automated' ? ` (Automated: ${c.files?.join(', ') ?? 'файл из его строки'})` : c.mark === 'manual' ? ' (Manual)' : ' (без пометки)'}`).join('\n')}\n\nПрочитай каждый кейс целиком, его шаги и что он покрывает, и specs изменения. Для кейса с Automated напиши тест по его шагам в файле из строки Automated, с id кейса в названии и тегах теста, как у остальных тестов там, прогони его и добейся зелёного; если он падает на ошибке, которую спека исключает, поправь код, а если под вопросом сама спека, спроси меня. Кейс с Manual автоматизируй, если это возможно, и поменяй пометку на Automated; если нельзя, объясни почему. Для кейса без пометки сначала реши, какой он, и впиши пометку в test-cases.md. Не трогай ничего, что кейсам не нужно, и в конце скажи, какие кейсы закрыты, а какие нет.`,
  decideAllPrompt: (change, dir, points) =>
    `Реши сам эти открытые пункты изменения OpenSpec «${change}» (${dir}):\n\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nСначала прочитай proposal.md, design.md, tasks.md и specs изменения, а где пункт упирается в код проекта, и код. Для каждого пункта выбери ответ, за который больше говорят изменение и код, впиши его туда, где ему место (proposal.md, design.md, specs, tasks.md), с причиной в одном предложении, и убери пункт из открытых вопросов и допущений. Если пункт без меня не решить (продуктовый выбор, деньги, то, чего нет ни в одном файле), оставь его открытым и спроси меня о нём в конце. Больше ничего не трогай и в конце напиши по строке на пункт: что решил или что тебе нужно от меня.`,
  applyPrompt: (change, dir, items) =>
    `Я решил открытые пункты изменения OpenSpec «${change}» (${dir}). Внеси решения в его файлы — proposal.md, design.md, specs и tasks.md, туда, где каждому место, — и убери решённое из открытых вопросов и допущений. Остального не трогай. Если решение противоречит спеке или неясно, как его записать, спроси меня, прежде чем править.\n\n${items.map((d, i) => `${i + 1}. ${d.point}\n   Решение: ${d.answer}`).join('\n')}`,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
