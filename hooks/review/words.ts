import type { CaughtRule, Lang, Live, Mode, Spent } from '../../types/review'

// The OpenSpec change in view, as the review is told of it.
type SpecInView = { change: string; tasks: string[]; requirements: { name: string; op: string; scenarios: string[] }[] }

// A token count as it reads at a glance: 950, 12.4k.
const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)

// Russian plural: 1 файл, 2 файла, 5 файлов.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// Every word the mod shows, and what it asks the model, in English and Russian. English is the
// default; `/changes lang ru` switches both, kept for every session.
const EN = {
  description: 'Review what the agent changed: the diff, what each piece is for, what looks wrong, a walkthrough; rules: the CLAUDE.md in force; lang: en or ru',
  title: 'Review',
  opened: 'Opened the review.',
  nothing: 'Nothing to review yet: Claude has not edited a file in this session.',
  langUsage: 'Usage: /changes lang en, /changes lang ru',
  langSet: 'Language: English.',
  // The row above the prompt.
  files: (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`,
  findings: (n: number) => `${n} ${n === 1 ? 'finding' : 'findings'}`,
  bugs: (n: number) => `${n} likely ${n === 1 ? 'bug' : 'bugs'}`,
  unseen: (n: number) => `${n} ${n === 1 ? 'piece' : 'pieces'} not looked at`,
  reviewing: 'reviewing…',
  unreviewed: 'not reviewed',
  reviewFailed: 'review failed',
  allSeen: 'looked at',
  // The pane.
  tabs: { changes: 'Changes', findings: 'Findings', walkthrough: 'Walkthrough', ask: 'Ask' },
  modes: { turn: 'last turn', session: 'this session', uncommitted: 'uncommitted' } as Record<Mode, string>,
  mode: 'Diff',
  spent: (s: Spent) =>
    `Spent this session: ${s.calls} ${s.calls === 1 ? 'call' : 'calls'} · ${kilo(s.input)} in (${kilo(s.cached)} from cache) · ${kilo(s.output)} out`,
  request: 'Asked for:',
  emptyMode: (mode: Mode): string =>
    mode === 'uncommitted' ? 'Nothing uncommitted in the repositories this session touched.' : 'No changes here.',
  failed: (why: string) => `The model gave no answer: ${why}.`,
  newFile: 'new',
  deletedFile: 'deleted',
  seen: 'looked at',
  markSeen: 'looked at',
  markFileSeen: 'all of this file looked at',
  markAllSeen: 'all changes looked at',
  seenOf: (seen: number, all: number) => `looked at ${seen} of ${all}`,
  askAbout: 'ask',
  revert: 'take back',
  explaining: 'Saying what each piece is for…',
  moreLines: (n: number) => `… ${n} more ${n === 1 ? 'line' : 'lines'}`,
  showMore: (n: number, isAll: boolean) => (isAll ? 'show them' : `show ${n} more`),
  showLess: 'show less',
  hunkAt: (line: number) => `line ${line}`,
  noFindings: 'Nothing found to fix.',
  earlier: 'From earlier reviews, still open:',
  notReviewed: 'Not reviewed yet.',
  lostNote: 'Not reviewed: the review stopped before it finished. Press r to run it.',
  failedNote: (why: string) => `${why} Press r to review it again.`,
  small: 'not reviewed: small change',
  smallNote: 'A change of a line or two: not reviewed by itself.',
  check: 'check',
  fix: 'fix',
  fixAll: (n: number) => `fix all (${n})`,
  notABug: 'not a bug',
  toCode: 'to the code',
  putAside: 'put aside',
  sentToClaude: 'sent to Claude',
  severity: { bug: 'likely bug', rule: 'rule', note: 'note' },
  ruleFrom: (rule: string) => `rule: ${rule}`,
  findingsNote: 'Checked against what you asked for and the CLAUDE.md and AGENTS.md of each folder touched.',
  walking: 'Reading the change through…',
  remake: 'again',
  askPlaceholder: 'A question about these changes, say: why a new hook and not the old one?',
  askAboutHunk: (where: string) => `About ${where}`,
  forget: 'any piece',
  ask: 'ask',
  sent: 'Sent to Claude.',
  // The check of each edit as it is made.
  caughtToast: (n: number, file: string) => `CLAUDE.md: ${n} rule${n === 1 ? '' : 's'} broken in ${file}`,
  checkFailed: (why: string) => `The rule check of an edit gave no answer (${why}): it went unchecked. /changes rules says more.`,
  checksFailed: (n: number) => `${n} ${n === 1 ? 'check' : 'checks'} gave no answer this session: those edits went unchecked.`,
  letThrough: (file: string) => `${file}: an edit refused twice for one rule went through. It is on Findings for you to decide.`,
  caught: 'Caught while Claude edited:',
  caughtState: { found: 'not told Claude yet', told: 'told Claude', open: 'still there', fixed: 'fixed', refused: 'edit refused' } as Record<CaughtRule['state'], string>,
  found: (evidence: string) => `found: ${evidence}`,
  liveHeader: (live: Live, model: string, running: number) =>
    live === 'off'
      ? 'Rules while Claude edits: off, the review after the turn alone.'
      : `Rules while Claude edits: ${live === 'block' ? 'an edit that breaks one is refused' : 'Claude is told what an edit breaks'}, checked by ${model}${running > 0 ? `, ${running} ${running === 1 ? 'check' : 'checks'} running` : ''}.`,
  rulesHere: 'The rules here come from:',
  noRulesHere: 'No CLAUDE.md or AGENTS.md here or in a folder above.',
  // What the model is asked.
  system:
    "You review a coding agent's changes for a developer. Answer in English, briefly and plainly, from what is given alone (the requests, the diff, the files, the file lists, the commands run); never make anything up. The diff is not all the agent did: a request earlier in the session can ask for a change, and a shell command can push, install or change a file outside the diff.",
  rulesHeading: 'The project rules that apply to these files:',
  noRules: 'The project has no CLAUDE.md or AGENTS.md for these files.',
  requestHeading: (request: string) => `What the developer asked the agent for:\n${request || '(not known)'}`,
  earlierHeading: 'What the developer asked earlier in this session, oldest first; a change in this diff may answer any of these:',
  shellHeading: 'The shell commands the agent ran in this turn, each with the end of its output; what they did is not in the diff:',
  repoFilesHeading: (repo: string, more: number) =>
    `The files in ${repo || 'the project'}, tracked or new and not ignored${more > 0 ? ` (the first of them; ${more} more not listed)` : ''}:`,
  filesHeading: 'The changed files as they are now, each line after its number:',
  diffHeading: 'The diff, each hunk under its id:',
  reviewPrompt:
    'Review the diff above, reading the files around it. Look for: likely bugs (wrong logic, a missed case, a broken call, types that lie), project rules above that it breaks, debugging left in, changes no request in this session asked for, behaviour changed with no test. Skip taste and anything a formatter fixes. Report only what the text above shows: before calling a change unasked for, read every request above; before saying a file, path or claim is missing, broken, ignored or ahead of the facts, check it against the files, the file lists and the commands run; where what you would need to check is not above, leave the finding out. You may first think it through in a few short sentences; then end with the JSON: an array of at most eight objects {"file": shown path, "line": the line\'s number as the file above numbers it, or omitted, "severity": "bug" | "rule" | "note", "text": one sentence, what is wrong and why, "rule": the rule broken, quoted short, or omitted}; [] when nothing is worth saying.',
  specHeading: (s: SpecInView) =>
    `The OpenSpec change in progress in this project, "${s.change}"; the diff may work on it.\nIts tasks not done yet:\n${s.tasks.map(t => `- ${t}`).join('\n') || '(none)'}\nWhat its specs require, each requirement with its scenarios:\n${s.requirements.map(r => `- ${r.op}: ${r.name}${r.scenarios.length > 0 ? ` (scenarios: ${r.scenarios.join('; ')})` : ''}`).join('\n') || '(nothing)'}`,
  specPrompt:
    'Where the diff works on the OpenSpec change above, also report code that goes against one of its requirements or scenarios (as "bug"), and a task the request named that the diff leaves half done (as "note").',
  flaggedPrompt: (found: readonly { where: string; rule: string }[]) =>
    `These rules were already flagged while the agent worked, and the developer sees them; do not report them again:\n${found.map(f => `- ${f.where}: ${f.rule}`).join('\n')}`,
  verifyPrompt: (found: readonly { where: string; text: string }[]) =>
    `A first look at this diff found these:\n\n${found.map((f, i) => `${i + 1}. ${f.where}: ${f.text}`).join('\n')}\n\nCheck each one again, as a doubting second reviewer, against everything above: every request, the commands run, the files and the file lists. Keep one only where the text above shows it is real. Drop it where a request asked for the change, a command did what it says is not done, a file it says is missing or ignored is there, or it rests on something not shown. Think it through briefly, then end with the JSON: an array of the numbers of the ones to keep, as [1, 3]; [] to keep none.`,
  notesPrompt: (ids: readonly string[] | null) =>
    `For each hunk above${ids ? ` with the id ${ids.join(', ')}` : ''}, say in one short line (under 15 words) what it does and why, in terms of the request; not a retelling of the code. Answer with JSON alone: an object from the hunk id to that line.`,
  walkthroughPrompt:
    'Walk the developer through this change in Markdown, so they can read it in the right order: ## In short (two or three sentences), ## Where to start (the files in reading order, one line each on its part), ## How it fits (what calls what, what data goes where), ## Left out (what the change does not do that the request might expect, or "nothing"). No more than 300 words.',
  askPrompt: (question: string, hunk: string | null) =>
    `${hunk ? `The question is about this hunk:\n${hunk}\n\n` : ''}Question: ${question}\n\nAnswer briefly from the diff, the files and the rules, naming the file and line you mean.`,
  // Sent to the session as the person's own prompt.
  fixPrompt: (where: string, text: string, rule: string | undefined) =>
    `A review of your last changes found this in ${where}: ${text}${rule ? ` (rule: ${rule})` : ''}. Fix it. If it is not a problem, say why and change nothing.`,
  fixAllPrompt: (found: readonly { where: string; text: string; rule: string | undefined }[]) =>
    `A review of your last changes found these:\n\n${found.map((f, i) => `${i + 1}. ${f.where}: ${f.text}${f.rule ? ` (rule: ${f.rule})` : ''}`).join('\n')}\n\nFix each. Where one is not a problem, say why and leave it as it is.`,
  revertPrompt: (file: string, patch: string) =>
    `Take this piece of your change back out of ${file}, putting the lines as they were, and touch nothing else:\n\n\`\`\`diff\n${patch}\n\`\`\``,
}

const RU: typeof EN = {
  description: 'Посмотреть, что изменил агент: дифф, зачем каждый кусок, что выглядит неверно, разбор; rules: какие CLAUDE.md действуют; lang: en или ru',
  title: 'Ревью',
  opened: 'Открыто ревью.',
  nothing: 'Смотреть пока нечего: в этой сессии Claude ещё не правил файлы.',
  langUsage: 'Как вызвать: /changes lang en, /changes lang ru',
  langSet: 'Язык: русский.',
  files: n => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`,
  findings: n => `${n} ${plural(n, 'замечание', 'замечания', 'замечаний')}`,
  bugs: n => `${n} ${plural(n, 'вероятная ошибка', 'вероятные ошибки', 'вероятных ошибок')}`,
  unseen: n => `${n} ${plural(n, 'кусок', 'куска', 'кусков')} не просмотрено`,
  reviewing: 'проверяю…',
  unreviewed: 'не проверено',
  reviewFailed: 'проверка не удалась',
  allSeen: 'просмотрено',
  tabs: { changes: 'Изменения', findings: 'Замечания', walkthrough: 'Разбор', ask: 'Спросить' },
  modes: { turn: 'последний ход', session: 'вся сессия', uncommitted: 'незакоммиченное' },
  mode: 'Дифф',
  spent: s =>
    `Потрачено за сессию: ${s.calls} ${plural(s.calls, 'вызов', 'вызова', 'вызовов')} · вход ${kilo(s.input)} (из кэша ${kilo(s.cached)}) · выход ${kilo(s.output)}`,
  request: 'Просьба:',
  emptyMode: mode =>
    mode === 'uncommitted' ? 'В репозиториях, которые трогала сессия, всё закоммичено.' : 'Здесь изменений нет.',
  failed: why => `Модель не ответила: ${why}.`,
  newFile: 'новый',
  deletedFile: 'удалён',
  seen: 'просмотрено',
  markSeen: 'просмотрено',
  markFileSeen: 'весь файл просмотрен',
  markAllSeen: 'просмотреть все изменения',
  seenOf: (seen, all) => `просмотрено ${seen} из ${all}`,
  askAbout: 'спросить',
  revert: 'откатить',
  explaining: 'Пишу, зачем каждый кусок…',
  moreLines: n => `… ещё ${n} ${plural(n, 'строка', 'строки', 'строк')}`,
  showMore: (n, isAll) => (isAll ? 'показать' : `показать ещё ${n}`),
  showLess: 'свернуть',
  hunkAt: line => `строка ${line}`,
  noFindings: 'Исправлять нечего.',
  earlier: 'Из прошлых проверок, ещё открыты:',
  notReviewed: 'Ещё не проверено.',
  lostNote: 'Не проверено: проверка оборвалась, не закончив. Нажми r, чтобы запустить её.',
  failedNote: why => `${why} Нажми r, чтобы проверить снова.`,
  small: 'не проверено: мелкая правка',
  smallNote: 'Правка в одну-две строки: сама не проверялась.',
  check: 'проверить',
  fix: 'поправь',
  fixAll: n => `исправить все (${n})`,
  notABug: 'не ошибка',
  toCode: 'к коду',
  putAside: 'отложено',
  sentToClaude: 'отправлено Claude',
  severity: { bug: 'вероятная ошибка', rule: 'правило', note: 'заметка' },
  ruleFrom: rule => `правило: ${rule}`,
  findingsNote: 'Сверено с твоей просьбой и с CLAUDE.md и AGENTS.md каждой затронутой папки.',
  walking: 'Читаю изменение целиком…',
  remake: 'заново',
  askPlaceholder: 'Вопрос по изменениям, например: почему новый хук, а не старый?',
  askAboutHunk: where => `Про ${where}`,
  forget: 'про всё',
  ask: 'спросить',
  sent: 'Отправлено Claude.',
  checkFailed: why => `Проверка правки по правилам не ответила (${why}): правка прошла без проверки. Подробнее: /changes rules.`,
  checksFailed: n => `За сессию без ответа: ${n} ${plural(n, 'проверка', 'проверки', 'проверок')}; эти правки прошли без проверки.`,
  letThrough: file => `${file}: правку, дважды отклонённую за одно правило, пропустил. Она в «Замечаниях» — решать тебе.`,
  caughtToast: (n, file) =>
    `CLAUDE.md: в ${file} ${plural(n, 'нарушено', 'нарушены', 'нарушено')} ${n} ${plural(n, 'правило', 'правила', 'правил')}`,
  caught: 'Поймано, пока Claude правил:',
  caughtState: { found: 'Claude ещё не сказано', told: 'сказано Claude', open: 'ещё в коде', fixed: 'исправлено', refused: 'правка отклонена' },
  found: evidence => `найдено: ${evidence}`,
  liveHeader: (live, model, running) =>
    live === 'off'
      ? 'Правила во время правок: выключено, только ревью после хода.'
      : `Правила во время правок: ${live === 'block' ? 'правка, нарушающая правило, отклоняется' : 'Claude сразу узнаёт, что нарушила правка'}, проверяет ${model}${running > 0 ? `, проверок в работе: ${running}` : ''}.`,
  rulesHere: 'Правила здесь берутся из:',
  noRulesHere: 'Ни здесь, ни выше нет CLAUDE.md или AGENTS.md.',
  system:
    'Ты проверяешь правки агента для разработчика. Отвечай по-русски, кратко и просто, только по тому, что дано (просьбы, дифф, файлы, списки файлов, запущенные команды), ничего не выдумывай. Дифф — не всё, что сделал агент: о правке могли попросить раньше в этой сессии, а shell-команда могла запушить, установить или поменять файл вне диффа.',
  rulesHeading: 'Правила проекта, действующие для этих файлов:',
  noRules: 'Для этих файлов в проекте нет CLAUDE.md или AGENTS.md.',
  requestHeading: request => `О чём разработчик просил агента:\n${request || '(неизвестно)'}`,
  earlierHeading: 'О чём разработчик просил раньше в этой сессии, от старого к новому; правка в этом диффе может отвечать на любую из этих просьб:',
  shellHeading: 'Shell-команды, которые агент запускал в этом ходе, у каждой конец вывода; что они сделали, в дифф не попадает:',
  repoFilesHeading: (repo, more) =>
    `Файлы в ${repo || 'проекте'}, отслеживаемые или новые и не игнорируемые${more > 0 ? ` (первые из них; ещё ${more} не показано)` : ''}:`,
  filesHeading: 'Изменённые файлы как они есть сейчас, каждая строка после своего номера:',
  diffHeading: 'Дифф, каждый кусок под своим id:',
  reviewPrompt:
    'Проверь дифф выше, читая файлы вокруг него. Ищи: вероятные ошибки (неверная логика, пропущенный случай, сломанный вызов, типы, которые врут), нарушения правил проекта выше, оставленную отладку, правки, о которых не просила ни одна просьба этой сессии, поведение, изменённое без теста. Вкус и то, что поправит форматтер, пропускай. Сообщай только то, что видно из текста выше: прежде чем назвать правку непрошеной, прочитай все просьбы выше; прежде чем сказать, что файл, путь или утверждение пропали, сломаны, игнорируются или опережают факты, сверь это с файлами, списками файлов и запущенными командами; если того, что нужно для проверки, выше нет, не пиши это замечание. Можешь сначала коротко, в нескольких фразах, рассудить; в конце дай JSON: массив из не более чем восьми объектов {"file": путь как в диффе, "line": номер строки, как он стоит в тексте файла выше, или нет поля, "severity": "bug" | "rule" | "note", "text": одно предложение — что не так и почему, "rule": нарушенное правило, коротко цитатой, или нет поля}; [] — если сказать нечего.',
  specHeading: s =>
    `Изменение OpenSpec в работе в этом проекте, «${s.change}»; дифф может относиться к нему.\nЕго задачи, ещё не выполненные:\n${s.tasks.map(t => `- ${t}`).join('\n') || '(нет)'}\nЧто требуют его спеки, у каждого требования его сценарии:\n${s.requirements.map(r => `- ${r.op}: ${r.name}${r.scenarios.length > 0 ? ` (сценарии: ${r.scenarios.join('; ')})` : ''}`).join('\n') || '(ничего)'}`,
  specPrompt:
    'Если дифф относится к изменению OpenSpec выше, сообщи ещё о коде, который идёт против его требования или сценария (как "bug"), и о задаче, названной в просьбе, которую дифф оставил недоделанной (как "note").',
  flaggedPrompt: found =>
    `Эти правила уже отмечены, пока агент работал, и разработчик их видит; не сообщай о них снова:\n${found.map(f => `- ${f.where}: ${f.rule}`).join('\n')}`,
  verifyPrompt: found =>
    `Первый взгляд на этот дифф нашёл вот что:\n\n${found.map((f, i) => `${i + 1}. ${f.where}: ${f.text}`).join('\n')}\n\nПроверь каждое ещё раз, как сомневающийся второй ревьюер, по всему, что выше: всем просьбам, запущенным командам, файлам и спискам файлов. Оставь замечание, только если текст выше показывает, что оно настоящее. Выкинь его, если о правке просили, если команда сделала то, что оно называет несделанным, если файл, который оно называет пропавшим или игнорируемым, на месте, или если оно опирается на то, чего выше нет. Коротко рассуди, затем в конце дай JSON: массив номеров тех, что оставить, например [1, 3]; [] — не оставлять ни одного.`,
  notesPrompt: ids =>
    `Для каждого куска выше${ids ? ` с id ${ids.join(', ')}` : ''} одной короткой строкой (до 15 слов) скажи, что он делает и зачем — в терминах просьбы, а не пересказ кода. Ответь только JSON: объект из id куска в эту строку.`,
  walkthroughPrompt:
    'Проведи разработчика по этому изменению в Markdown, чтобы он прочитал его в правильном порядке: ## Коротко (два-три предложения), ## С чего начать (файлы в порядке чтения, по строке о роли каждого), ## Как это связано (что что вызывает, какие данные куда идут), ## Что не сделано (чего изменение не делает, хотя просьба могла этого ждать, или «ничего»). Не больше 300 слов.',
  askPrompt: (question, hunk) =>
    `${hunk ? `Вопрос про этот кусок:\n${hunk}\n\n` : ''}Вопрос: ${question}\n\nОтветь кратко, по диффу, файлам и правилам, называя файл и строку, о которых говоришь.`,
  fixPrompt: (where, text, rule) =>
    `Ревью твоих последних правок нашло в ${where}: ${text}${rule ? ` (правило: ${rule})` : ''}. Поправь это. Если это не проблема, объясни почему и ничего не меняй.`,
  fixAllPrompt: found =>
    `Ревью твоих последних правок нашло вот что:\n\n${found.map((f, i) => `${i + 1}. ${f.where}: ${f.text}${f.rule ? ` (правило: ${f.rule})` : ''}`).join('\n')}\n\nПоправь каждое. Если что-то из этого не проблема, объясни почему и это не трогай.`,
  revertPrompt: (file, patch) =>
    `Убери этот кусок своей правки из ${file}, вернув строки как были, и больше ничего не трогай:\n\n\`\`\`diff\n${patch}\n\`\`\``,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
